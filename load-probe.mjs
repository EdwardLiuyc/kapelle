// M0-9 probe, v2 (#176): session/load into a new harness process, on work
// that is not safe to repeat.
//
// node load-probe.mjs <agent> <clean|eof|sigkill> [tag]
//
// Turn 1 writes notes.txt (a codeword) and counter.txt (0), and ends.
// Turn 2 runs 4 rounds: read counter.txt, add 1, write it back, append
// "round N" to log.txt, sleep 5. The moment log.txt holds "round 2", stop:
//   clean   = session/cancel, wait for the turn to end, then stop() (stdin EOF)
//   eof     = stdin EOF during the turn, no SIGKILL behind it
//   sigkill = SIGKILL the harness pid during the turn
// Then spawn a new process in the same cwd, session/load, ask from memory
// (no tools), then tell it to finish. Correct end state: counter 4 and
// rounds 1-4 in log.txt once each. A repeated round shows on disk.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyFor } from "./core/policy.ts";
import { AcpAgent } from "./protocol/agent.ts";
import { resolveAgent, resolveEnv } from "./protocol/registry.ts";

const [id, stopKind] = process.argv.slice(2);
if (!id || !["clean", "eof", "sigkill"].includes(stopKind)) {
  console.error("usage: node load-probe.mjs <agent> <clean|eof|sigkill> [tag]");
  process.exit(2);
}

const spec = resolveAgent(id);
const cwd = await mkdtemp(join(tmpdir(), `m0-9b-${id}-${stopKind}-`));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const t0 = Date.now();
const log = (msg) =>
  console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const read = (f) =>
  existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf8").trim() : null;
const snapshot = () => ({ counter: read("counter.txt"), log: read("log.txt") });

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
  "Create two files in the current directory: notes.txt containing exactly " +
  "'codeword ZEBRA-4417', and counter.txt containing exactly '0'. Then reply with only OK.";
const TURN2 =
  "Do exactly 4 rounds, strictly one after another, one tool call per action. " +
  "Each round N (N = 1..4): read counter.txt, add 1, and write the new number back " +
  "to counter.txt; then append the line 'round N' to log.txt (create it if missing); " +
  "then run the shell command `sleep 5`. Never do a round twice. Reply DONE at the end.";
const ASK =
  "Do not use any tools. From your memory of this conversation only: " +
  "(a) what codeword is in notes.txt? (b) which rounds did you finish, and what " +
  "number should counter.txt hold now? (c) was your last task finished or interrupted? " +
  "Answer in one short line.";
const CONTINUE =
  "Finish the 4-round task from where it stopped, with the same rules. " +
  "Do not redo a round that is already done. Reply DONE at the end.";

const record = { agent: id, stop: stopKind, cwd };

// ---- process 1 ----
const a = makeAgent("p1", () => {});
const init1 = await a.agent.start();
record.version = init1.agentInfo?.version ?? null;
record.loadSession = init1.agentCapabilities?.loadSession ?? null;
const sessionId = await a.agent.newSession();
record.sessionId = sessionId;
log(`p1 pid ${a.pid()} session ${sessionId}`);

record.turn1 = (await a.agent.prompt(TURN1)).stopReason;
log(`turn 1: ${record.turn1}`);

const turn2 = a.agent.prompt(TURN2).then(
  (r) => r.stopReason,
  (err) => `rejected: ${err.message.split("\n")[0]}`,
);
let turn2Done = false;
turn2.then(() => {
  turn2Done = true;
});
const deadline = Date.now() + 240_000;
// Poll fast: the point is to stop inside the harness's work, not after it.
while (
  !(read("log.txt") ?? "").includes("round 2") &&
  !turn2Done &&
  Date.now() < deadline
)
  await sleep(20);
if (!(read("log.txt") ?? "").includes("round 2")) {
  record.error = `round 2 never appeared (turn 2: ${turn2Done ? await turn2 : "timeout"})`;
  record.atStop = snapshot();
  await a.agent.stop();
  console.log(JSON.stringify(record, null, 2));
  process.exit(1);
}
record.atTrigger = snapshot();
log(`round 2 in log.txt; stopping (${JSON.stringify(record.atTrigger)})`);

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
// Anything still running from p1 must not write later.
await sleep(1_000);
record.atStop = snapshot();
log(`p1 stopped, turn 2: ${record.turn2}; ${JSON.stringify(record.atStop)}`);

// ---- process 2 ----
let phase = "load";
const replayCounts = {};
const replayTools = new Map();
let text = "";
const b = makeAgent("p2", (u) => {
  if (phase === "load") {
    replayCounts[u.sessionUpdate] = (replayCounts[u.sessionUpdate] ?? 0) + 1;
    if (
      u.sessionUpdate === "tool_call" ||
      u.sessionUpdate === "tool_call_update"
    ) {
      const prev = replayTools.get(u.toolCallId) ?? {};
      replayTools.set(u.toolCallId, {
        title: u.title ?? prev.title,
        status: u.status ?? prev.status ?? null,
      });
    }
  } else if (
    u.sessionUpdate === "agent_message_chunk" &&
    u.content?.type === "text"
  )
    text += u.content.text;
});
await b.agent.start();
try {
  await b.agent.request("session/load", { sessionId, cwd, mcpServers: [] });
  record.load = "ok";
} catch (err) {
  record.load = `error: ${err.message.split("\n")[0]}`;
}
await sleep(1_000);
record.replay = replayCounts;
record.replayTools = [...replayTools.values()];
log(`load: ${record.load}`);

if (record.load === "ok") {
  b.agent.sessionId = sessionId;
  phase = "ask";
  record.askStop = (await b.agent.prompt(ASK)).stopReason;
  record.answer = text.trim();
  record.afterAsk = snapshot();
  text = "";
  record.continueStop = (await b.agent.prompt(CONTINUE)).stopReason;
  record.continueReply = text.trim().slice(-300);
}
await b.agent.stop();
record.final = snapshot();
record.notes = read("notes.txt");
record.files = readdirSync(cwd).sort();
const lines = (record.final.log ?? "").split("\n").filter(Boolean);
record.verdict =
  record.final.counter === "4" &&
  lines.join("|") === "round 1|round 2|round 3|round 4"
    ? "finished exactly"
    : "WRONG END STATE";
log(`verdict: ${record.verdict}`);
console.log(JSON.stringify(record, null, 2));
process.exit(0);
