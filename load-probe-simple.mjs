// M0-9 probe (#176): session/load into a new harness process.
//
// node load-probe-simple.mjs <agent> <clean|eof|sigkill>
//
// Turn 1 writes notes.txt and ends. Turn 2 writes step1..step4.txt with a
// sleep between each. Once step1.txt exists, stop the harness:
//   clean   = session/cancel, wait for the turn to end, then stop() (stdin EOF)
//   eof     = stdin EOF during the turn, no SIGKILL behind it
//   sigkill = SIGKILL the harness pid during the turn
// Then spawn a new process in the same cwd, session/load, and ask what it did.
// Prints one JSON record. The answer is prose: a human grades it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyFor } from "./core/policy.ts";
import { AcpAgent } from "./protocol/agent.ts";
import { resolveAgent, resolveEnv } from "./protocol/registry.ts";

const [id, stopKind] = process.argv.slice(2);
if (!id || !["clean", "eof", "sigkill"].includes(stopKind)) {
  console.error(
    "usage: node load-probe-simple.mjs <agent> <clean|eof|sigkill>",
  );
  process.exit(2);
}

const spec = resolveAgent(id);
const cwd = await mkdtemp(join(tmpdir(), `m0-9-${id}-${stopKind}-`));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const t0 = Date.now();
const log = (msg) =>
  console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

function makeAgent(tag, sink) {
  let pid = null;
  const agent = new AcpAgent({
    name: `${id}-${tag}`,
    command: spec.launch.command,
    args: spec.launch.args,
    env: resolveEnv(spec.launch.env),
    cwd,
    policy: policyFor("auto"),
    // A huge grace, so `eof` stays a pure end of file, never a SIGKILL.
    stopGraceMs: 60_000,
    onEvent: (e) => {
      if (e.update.sessionUpdate === "_client_harness_spawned")
        pid = e.update.pid;
      sink(e.update);
    },
  });
  return { agent, pid: () => pid };
}

const TURN1 =
  "Create a file named notes.txt in the current directory containing exactly the line: codeword ZEBRA-4417. Then reply with only the word OK.";
const TURN2 =
  "Do these steps strictly in order, one tool call per step, and do not batch them: " +
  "1) create step1.txt containing 'one'; 2) run the shell command `sleep 8`; " +
  "3) create step2.txt containing 'two'; 4) run `sleep 8`; " +
  "5) create step3.txt containing 'three'; 6) run `sleep 8`; " +
  "7) create step4.txt containing 'four'. Then reply DONE.";
const ASK =
  "Do not use any tools. From your memory of this conversation only: " +
  "(a) what codeword did you write into notes.txt? " +
  "(b) which stepN.txt files did you create, and was your last task finished or interrupted? " +
  "Answer in one short line.";

const record = { agent: id, stop: stopKind, cwd };

// ---- process 1 ----
const a = makeAgent("p1", () => {});
const init1 = await a.agent.start();
record.version = init1.agentInfo?.version ?? null;
record.loadSession = init1.agentCapabilities?.loadSession ?? null;
record.sessionCapabilities =
  init1.agentCapabilities?.sessionCapabilities ?? null;
const sessionId = await a.agent.newSession();
record.sessionId = sessionId;
log(`p1 pid ${a.pid()} session ${sessionId}`);

record.turn1 = (await a.agent.prompt(TURN1)).stopReason;
log(`turn 1: ${record.turn1}`);

const turn2 = a.agent.prompt(TURN2).then(
  (r) => r.stopReason,
  (err) => `rejected: ${err.message}`,
);
const deadline = Date.now() + 180_000;
while (!existsSync(join(cwd, "step1.txt")) && Date.now() < deadline)
  await sleep(200);
if (!existsSync(join(cwd, "step1.txt"))) {
  record.error = "step1.txt never appeared";
  await a.agent.stop();
  console.log(JSON.stringify(record));
  process.exit(1);
}
log("step1.txt exists; stopping");

if (stopKind === "clean") {
  a.agent.cancel();
  record.turn2 = await Promise.race([
    turn2,
    sleep(15_000).then(() => "no answer in 15s"),
  ]);
  await a.agent.stop();
} else if (stopKind === "eof") {
  await a.agent.stop();
  record.turn2 = await turn2;
} else {
  process.kill(a.pid(), "SIGKILL");
  record.turn2 = await turn2;
  await a.agent.stop();
}
log(`p1 stopped, turn 2: ${record.turn2}`);
// Anything still running from p1 (a detached sleep) must not write later.
await sleep(1_000);
record.filesAtStop = readdirSync(cwd)
  .filter((f) => f.endsWith(".txt"))
  .sort();

// ---- process 2 ----
let phase = "load";
const replay = {};
let answer = "";
const b = makeAgent("p2", (u) => {
  if (phase === "load")
    replay[u.sessionUpdate] = (replay[u.sessionUpdate] ?? 0) + 1;
  else if (
    u.sessionUpdate === "agent_message_chunk" &&
    u.content?.type === "text"
  )
    answer += u.content.text;
});
await b.agent.start();
try {
  const res = await b.agent.request("session/load", {
    sessionId,
    cwd,
    mcpServers: [],
  });
  record.load = "ok";
  record.loadResponseKeys = Object.keys(res ?? {});
} catch (err) {
  record.load = `error: ${err.message}`;
}
// Let any trailing replay notifications land before we count them.
await sleep(1_000);
record.replay = replay;
log(`load: ${record.load}`);

if (record.load === "ok") {
  b.agent.sessionId = sessionId;
  phase = "ask";
  try {
    record.askStop = (await b.agent.prompt(ASK)).stopReason;
  } catch (err) {
    record.askStop = `rejected: ${err.message}`;
  }
  record.answer = answer.trim();
}
await b.agent.stop();
record.filesAtEnd = readdirSync(cwd)
  .filter((f) => f.endsWith(".txt"))
  .sort();
record.notes = existsSync(join(cwd, "notes.txt"))
  ? readFileSync(join(cwd, "notes.txt"), "utf8").trim()
  : null;
console.log(JSON.stringify(record, null, 2));
process.exit(0);
