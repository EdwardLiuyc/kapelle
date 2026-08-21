#!/usr/bin/env node
// M0-4 cancellation probe — ephemeral spike tooling, not part of the client.
//
// Sends session/cancel (or a second session/prompt) at a deterministic mid-turn
// point and WAITS, instead of run.mjs's SIGINT path which hard-kills at 2s and
// loses the stopReason.
//
//   node cancel-probe.mjs --agent opencode --workspace /tmp/probe-ws
//
// Flags:
//   --agent <id> | --cmd "<cmd>"   harness, from the repo registry
//   --mode cancel | double | observe   cancel mid-turn, send a 2nd prompt mid-turn, or
//                                  just watch a turn run to its natural end (baseline)
//   --trigger tool_call | any      which event fires the action (default tool_call)
//   --fallback-ms <n>              act anyway if the trigger never arrives (default 15000)
//   --wait <s>                     how long to wait for session/prompt to answer (default 60)
//   --quiet-window <s>             keep logging updates this long after it answers (default 5)
//   --reuse                        after the turn ends, send a tiny prompt to see if the
//                                  session is still alive and usable
//   --workspace <dir>              throwaway cwd (required; must exist)
//   --prompt "<text>"              override the long-turn prompt
//   --json <file>                  also write the raw record here
//   --verbose                      stream harness stderr

import { AcpAgent, autoPolicy } from "/home/edward/src/agent-team/acp.mjs";
import { resolveAgent, resolveEnv } from "/home/edward/src/agent-team/agents.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const mode = flag("mode", "cancel");
const trigger = flag("trigger", "tool_call");
const fallbackMs = Number(flag("fallback-ms", 15000));
const waitMs = Number(flag("wait", 60)) * 1000;
const quietMs = Number(flag("quiet-window", 5)) * 1000;
const workspace = flag("workspace");
if (!workspace) { console.error("--workspace <dir> is required (use a throwaway dir)"); process.exit(2); }

const DEFAULT_PROMPT =
  "Read every file in this directory one at a time, and for each one write a two-sentence " +
  "summary of what it does. Work through them slowly and thoroughly, one file per step.";
const promptText = flag("prompt", DEFAULT_PROMPT);

const spec = resolveAgent(flag("agent", "opencode"), flag("cmd"));
const t0 = Date.now();
const ms = () => Date.now() - t0;
const events = [];
let acted = null;          // { at, kind }
let firstEventAt = null;
let secondPrompt = null;   // { at, outcome, detail, settledAt }
let secondPromptTurn = null; // the in-flight promise, awaited before we exit
let markerSeenAt = null;
const MARKER = "BANANA";

const agent = new AcpAgent({
  name: spec.name,
  command: spec.command,
  args: spec.args,
  env: resolveEnv(spec.env),
  cwd: workspace,
  policy: autoPolicy,
  verbose: has("verbose"),
  onEvent: ({ update = {} }) => {
    // acp.mjs:230 forwards { agent, update } — the sessionUpdate lives on `update`.
    const kind = update.sessionUpdate ?? "(none)";
    const text = update.content?.text;
    events.push({
      ms: ms(), kind, toolCallId: update.toolCallId, title: update.title,
      text: text ? text.slice(0, 120) : undefined,
    });
    if (text && text.includes(MARKER)) markerSeenAt ??= ms();
    firstEventAt ??= ms();
    if (!acted && (trigger === "any" || kind === trigger)) act(`trigger:${kind}`);
  },
});

function act(why) {
  if (acted) return;
  acted = { at: ms(), why };
  if (mode === "observe") {
    console.error(`[${acted.at}ms] ${why} -> observe only, letting the turn run`);
    return;
  }
  if (mode === "cancel") {
    console.error(`[${acted.at}ms] ${why} -> session/cancel`);
    agent.cancel();
  } else {
    console.error(`[${acted.at}ms] ${why} -> second session/prompt while turn in flight`);
    const at = ms();
    secondPromptTurn = agent
      .request("session/prompt", {
        sessionId: agent.sessionId,
        prompt: [{ type: "text", text: `Reply with the single word ${MARKER} and nothing else.` }],
      })
      .then((r) => (secondPrompt = { at, outcome: "accepted", detail: r?.stopReason ?? null, settledAt: ms() }))
      .catch((e) => (secondPrompt = { at, outcome: "rejected", detail: e.message, settledAt: ms() }));
  }
}

const sleep = (n) => new Promise((r) => setTimeout(r, n));
const record = { harness: spec.name, command: `${spec.command} ${spec.args.join(" ")}`.trim(), mode, workspace };

try {
  const init = await agent.start();
  record.initMs = ms();
  record.agentInfo = init.agentInfo ?? null;
  await agent.newSession();
  record.sessionMs = ms();
  console.error(`[${ms()}ms] session ${agent.sessionId} — prompting`);

  const promptStarted = ms();
  const turn = agent
    .request("session/prompt", { sessionId: agent.sessionId, prompt: [{ type: "text", text: promptText }] })
    .then((r) => ({ outcome: "answered", stopReason: r?.stopReason ?? null, at: ms() }))
    .catch((e) => ({ outcome: "error", stopReason: null, detail: e.message, at: ms() }));

  const fallback = setTimeout(() => act("fallback-ms"), fallbackMs);
  const settled = await Promise.race([turn, sleep(waitMs).then(() => ({ outcome: "no-answer", at: ms() }))]);
  clearTimeout(fallback);

  record.promptStartedMs = promptStarted;
  record.actedAtMs = acted?.at ?? null;
  record.actedBecause = acted?.why ?? null;
  record.turn = settled;
  record.cancelLatencyMs = acted && settled.at != null && settled.outcome !== "no-answer" ? settled.at - acted.at : null;
  record.eventsBeforeAction = events.filter((e) => acted && e.ms <= acted.at).length;

  // Does the harness keep talking after the turn ends?
  const beforeQuiet = events.length;
  await sleep(quietMs);
  record.eventsAfterSettle = events.length - beforeQuiet;
  record.lastEventMs = events.at(-1)?.ms ?? null;

  // The second prompt may only be served after the in-flight turn ends (claude queues it),
  // so wait for it rather than reporting `null` because we stopped watching too early.
  if (secondPromptTurn) {
    await Promise.race([secondPromptTurn.catch(() => {}), sleep(waitMs)]);
    record.secondPromptTimedOut = secondPrompt === null;
  }

  if (has("reuse")) {
    try {
      const r = await agent.request("session/prompt", {
        sessionId: agent.sessionId,
        prompt: [{ type: "text", text: "Reply with the single word OK." }],
      });
      record.reuse = { outcome: "accepted", stopReason: r?.stopReason ?? null, at: ms() };
    } catch (e) {
      record.reuse = { outcome: "rejected", detail: e.message, at: ms() };
    }
  }
  record.secondPrompt = secondPrompt;
  record.markerSeenAt = markerSeenAt;
  record.events = events;
} catch (err) {
  record.fatal = err.message;
} finally {
  agent.stop();
}

const out = flag("json");
if (out) await (await import("node:fs/promises")).writeFile(out, JSON.stringify(record, null, 2));

console.log("\n─── M0-4 probe ───────────────────────────────");
console.log(`harness            ${record.harness}   (${record.command})`);
console.log(`mode               ${mode}`);
console.log(`acted at           ${record.actedAtMs ?? "never"} ms   (${record.actedBecause ?? "—"})`);
console.log(`turn outcome       ${record.turn?.outcome ?? record.fatal}`);
console.log(`stopReason         ${JSON.stringify(record.turn?.stopReason ?? null)}`);
if (record.turn?.detail) console.log(`error              ${record.turn.detail}`);
console.log(`cancel latency     ${record.cancelLatencyMs ?? "n/a"} ms`);
console.log(`events (total)     ${events.length}   before action: ${record.eventsBeforeAction ?? "—"}   after settle: ${record.eventsAfterSettle}`);
if (mode === "double")
  console.log(
    secondPrompt
      ? `2nd prompt         ${secondPrompt.outcome}: ${secondPrompt.detail ?? ""} (+${secondPrompt.settledAt - secondPrompt.at} ms)   marker echoed: ${markerSeenAt ? markerSeenAt + "ms" : "never"}`
      : `2nd prompt         no answer within --wait   marker echoed: ${markerSeenAt ? markerSeenAt + "ms" : "never"}`
  );
if (record.reuse) console.log(`session reuse      ${record.reuse.outcome}: ${record.reuse.detail ?? record.reuse.stopReason}`);
console.log("──────────────────────────────────────────────");
