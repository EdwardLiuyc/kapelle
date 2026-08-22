#!/usr/bin/env node
// M0-5 usage-reporting probe — ephemeral spike tooling, not part of the client.
//
// run.mjs cannot answer this story: render.mjs prints only `used`/`size`
// (render.mjs:57-58) and its switch silently drops everything it does not know,
// `config_option_update` among them (render.mjs:20). This probe logs every
// session/update verbatim — unknown top-level fields and `_meta` included,
// since opencode's `cost` arrived as a top-level extension and a second one
// would be invisible to a switch — and tees the whole JSON-RPC wire through
// wire-tap.mjs so responses and non-session/update notifications are captured
// too.
//
//   node usage-probe.mjs --agent opencode --workspace /tmp/ws --json out.json
//
// Flags:
//   --agent <id> | --cmd "<cmd>"  harness, from the repo registry
//   --workspace <dir>             throwaway cwd (required; must exist)
//   --turns <n>                   how many prompts to send in ONE session (default 3)
//   --config <id>=<value>         session/set_config_option before prompting (repeatable),
//                                 e.g. --config model=deepseek/deepseek-chat — the only way
//                                 to tell "cost is always 0" from "this provider is not billed"
//   --prompt "<text>"             one turn's prompt; repeatable, one per turn
//   --wait <s>                    per-turn timeout (default 300)
//   --json <file>                 write the full record here
//   --wire <file>                 write the raw wire log here (default <json>.wire.jsonl)
//   --no-tap                      skip wire-tap.mjs (spawn the harness directly)
//   --verbose                     stream harness stderr

import { AcpAgent, autoPolicy } from "/home/edward/src/agent-team/acp.mjs";
import { resolveAgent, resolveEnv } from "/home/edward/src/agent-team/agents.mjs";
import { writeFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const workspace = flag("workspace");
if (!workspace) { console.error("--workspace <dir> is required (use a throwaway dir)"); process.exit(2); }
const turns = Number(flag("turns", 3));
const configSets = argv.reduce((acc, a, i) => {
  if (a === "--config" && argv[i + 1]) {
    const eq = argv[i + 1].indexOf("=");
    acc.push({ configId: argv[i + 1].slice(0, eq), value: argv[i + 1].slice(eq + 1) });
  }
  return acc;
}, []);
const waitMs = Number(flag("wait", 300)) * 1000;
const jsonOut = flag("json");
const wireOut = flag("wire", jsonOut ? `${jsonOut}.wire.jsonl` : null);

// Turn 1 is deliberately multi-tool and long: M0-1's sample was "trivially
// short" (docs/M0-FINDINGS.md:212), which is exactly the turn that cannot
// distinguish "cost is always 0" from "this turn cost nothing worth rounding up".
const HEAVY =
  "Read every file in this workspace one at a time. Then write NOTES.md containing a " +
  "two-sentence summary of each file. Then read NOTES.md back and append a final line " +
  "counting how many files you summarised. Work through it step by step.";
// Turns 2+ are trivial: if `used` is context occupancy it keeps climbing with the
// transcript; if it were a per-turn count it would drop back to near nothing.
const CHEAP = "Reply with the single word OK and nothing else.";

// --prompt is repeatable: each occurrence is one turn, in order. With none, turn 1
// is HEAVY and the rest are CHEAP. Slash commands (`/context`, `/usage`) are sent
// as ordinary prompt text — that is the only channel ACP gives a client for them.
const explicitPrompts = argv.reduce((acc, a, i) => {
  if (a === "--prompt" && argv[i + 1]) acc.push(argv[i + 1]);
  return acc;
}, []);
const prompts = explicitPrompts.length
  ? explicitPrompts
  : [HEAVY, ...Array.from({ length: Math.max(0, turns - 1) }, () => CHEAP)];

const spec = resolveAgent(flag("agent", "opencode"), flag("cmd"));
let command = spec.command, args = spec.args;
if (wireOut && !has("no-tap")) {
  args = [new URL("./wire-tap.mjs", import.meta.url).pathname, wireOut, spec.command, ...spec.args];
  command = process.execPath;
}

const t0 = Date.now();
const ms = () => Date.now() - t0;
const events = [];          // every session/update, verbatim
let turnIndex = 0;

const agent = new AcpAgent({
  name: spec.name,
  command,
  args,
  env: resolveEnv(spec.env),
  cwd: workspace,
  policy: autoPolicy,
  verbose: has("verbose"),
  onEvent: ({ update = {} }) => {
    events.push({ ms: ms(), turn: turnIndex, update: structuredClone(update) });
    if (update.sessionUpdate === "usage_update") {
      const { sessionUpdate, ...rest } = update;
      console.error(`[${ms()}ms t${turnIndex}] usage_update ${JSON.stringify(rest)}`);
    }
    if (update.sessionUpdate === "config_option_update") {
      console.error(`[${ms()}ms t${turnIndex}] config_option_update ${JSON.stringify(update).slice(0, 400)}`);
    }
  },
});

const sleep = (n) => new Promise((r) => setTimeout(r, n));
const record = {
  harness: spec.name,
  command: `${spec.command} ${spec.args.join(" ")}`.trim(),
  workspace,
  startedAt: new Date().toISOString(),
  turns: [],
};

try {
  record.initialize = await agent.start();
  record.initMs = ms();
  const sessionRes = await agent.request("session/new", { cwd: workspace, mcpServers: [] });
  agent.sessionId = sessionRes.sessionId;
  record.sessionNew = sessionRes;
  console.error(`[${ms()}ms] session ${agent.sessionId}`);

  // session/set_config_option is how the spec says a client picks a model
  // (SessionConfigOption, category "model"). Both opencode and claude-agent-acp
  // report the current one in the session/new result above.
  record.configSets = [];
  for (const { configId, value } of configSets) {
    try {
      const res = await agent.request("session/set_config_option", {
        sessionId: agent.sessionId,
        configId,
        value,
      });
      record.configSets.push({ configId, value, outcome: "ok", result: res });
      console.error(`[${ms()}ms] set ${configId}=${value}`);
    } catch (e) {
      record.configSets.push({ configId, value, outcome: "error", detail: e.message });
      console.error(`[${ms()}ms] set ${configId}=${value} FAILED: ${e.message}`);
    }
  }

  for (const [i, text] of prompts.entries()) {
    turnIndex = i + 1;
    const before = events.length;
    const startedMs = ms();
    console.error(`\n[${startedMs}ms] --- turn ${turnIndex}: ${text.slice(0, 60)}...`);
    const res = await Promise.race([
      agent
        .request("session/prompt", { sessionId: agent.sessionId, prompt: [{ type: "text", text }] })
        .then((r) => ({ outcome: "answered", result: r }))
        .catch((e) => ({ outcome: "error", detail: e.message })),
      sleep(waitMs).then(() => ({ outcome: "no-answer" })),
    ]);
    const usage = events.slice(before).filter((e) => e.update.sessionUpdate === "usage_update");
    record.turns.push({
      turn: turnIndex,
      prompt: text,
      startedMs,
      endedMs: ms(),
      outcome: res.outcome,
      // The whole result object, not just stopReason: a per-turn token count
      // could just as well ride on the response as on a notification.
      result: res.result ?? null,
      detail: res.detail ?? null,
      updates: events.length - before,
      usageSamples: usage.map((e) => ({ ms: e.ms, ...e.update })),
    });
    if (res.outcome !== "answered") break;
  }

  // Anything arriving after the last turn settles (a final usage flush?).
  const before = events.length;
  await sleep(3000);
  record.eventsAfterLastTurn = events.length - before;
} catch (err) {
  record.fatal = err.message;
  console.error("FATAL", err.message);
} finally {
  agent.stop();
}

record.events = events;
record.updateKinds = events.reduce((acc, e) => {
  const k = e.update.sessionUpdate ?? "(none)";
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});

if (jsonOut) await writeFile(jsonOut, JSON.stringify(record, null, 2));

console.log("\n─── M0-5 usage probe ─────────────────────────");
console.log(`harness            ${record.harness}   (${record.command})`);
console.log(`agentInfo          ${JSON.stringify(record.initialize?.agentInfo ?? null)}`);
console.log(`update kinds       ${JSON.stringify(record.updateKinds)}`);
for (const t of record.turns) {
  console.log(`turn ${t.turn}  ${t.outcome}  ${((t.endedMs - t.startedMs) / 1000).toFixed(1)}s  updates=${t.updates}  result=${JSON.stringify(t.result)}`);
  for (const u of t.usageSamples) {
    const { sessionUpdate, ms: at, ...rest } = u;
    console.log(`   +${at}ms  ${JSON.stringify(rest)}`);
  }
  if (t.usageSamples.length === 0) console.log("   (no usage_update this turn)");
}
console.log(`after last turn    ${record.eventsAfterLastTurn ?? "—"} further updates`);
console.log("──────────────────────────────────────────────");
