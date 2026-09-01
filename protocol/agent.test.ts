/**
 * M1a-3 acceptance tests — issue #11.
 *
 * Everything here is driven by a real subprocess over real stdio rather than
 * by poking at internals, because every decision under test is about what does
 * or does not reach the wire.
 *
 * Covered so far: the per-request timeout (#62 B1), the in-flight prompt guard
 * (#62 R5), the whole `PromptResponse` (#62 B3) and the cancel-intent event
 * (#62 R4).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AcpAgent } from "./agent.ts";

/**
 * The structural shape a test needs from an emitted event. Declared here
 * rather than imported, so the client is not forced to export a name whose
 * only consumer is this file.
 */
type CapturedEvent = {
  agent: string;
  update: { sessionUpdate: string; sessionId?: string };
};

/** Accepts the pipe, reads stdin, and answers nothing, ever. */
const HANGS_FOREVER = "process.stdin.resume();";

/**
 * A minimal scripted harness: answers the handshake immediately, delays the
 * turn by `promptDelayMs`, and counts every `session/prompt` it actually
 * received so a test can prove a refused prompt never reached the wire.
 *
 * Written without imports so it behaves the same whether node treats `--eval`
 * input as CommonJS or ESM.
 */
function scriptedAgent(promptDelayMs: number): string {
  return [
    'let buf = "";',
    "let promptCount = 0;",
    "let cancelCount = 0;",
    "const send = (id, result) =>",
    "  process.stdout.write(",
    '    JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n",',
    "  );",
    'process.stdin.on("data", (chunk) => {',
    "  buf += chunk;",
    "  let nl;",
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    "    const line = buf.slice(0, nl);",
    "    buf = buf.slice(nl + 1);",
    "    if (!line.trim()) continue;",
    "    const msg = JSON.parse(line);",
    '    if (msg.method === "initialize") send(msg.id, { protocolVersion: 1 });',
    '    else if (msg.method === "session/new") send(msg.id, { sessionId: "s1" });',
    '    else if (msg.method === "debug/prompt_count")',
    "      send(msg.id, { count: promptCount });",
    '    else if (msg.method === "session/cancel") cancelCount += 1;',
    '    else if (msg.method === "debug/cancel_count")',
    "      send(msg.id, { count: cancelCount });",
    '    else if (msg.method === "session/prompt") {',
    "      promptCount += 1;",
    "      const reply = {",
    '        stopReason: "end_turn",',
    "        usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },",
    '        _meta: { "_claude/rateLimit": "ok" },',
    "      };",
    `      setTimeout(() => send(msg.id, reply), ${promptDelayMs});`,
    "    }",
    "  }",
    "});",
  ].join("\n");
}

// --- #62 B1 · per-request timeout --------------------------------------------

test("the default deadline is the story's 30s", () => {
  const agent = new AcpAgent({ command: "true" });
  assert.equal(agent.requestTimeoutMs, 30_000);
});

test("a harness that never answers initialize fails on the deadline", async (t) => {
  const agent = new AcpAgent({
    name: "hangs",
    command: process.execPath,
    args: ["-e", HANGS_FOREVER],
    requestTimeoutMs: 150,
  });
  // Registered before the first await: a failing assertion must still reap the
  // subprocess, or a red test leaves an orphan behind.
  t.after(() => agent.stop());

  const startedAt = Date.now();
  await assert.rejects(
    () => agent.start(),
    /did not answer "initialize" within 150ms/,
  );
  // The point of the story: it fails on a deadline rather than hanging.
  assert.ok(
    Date.now() - startedAt < 5_000,
    "start() must reject on the deadline, not hang",
  );
});

test("session/prompt is never bounded by the request deadline", async (t) => {
  const agent = new AcpAgent({
    name: "slow-turn",
    command: process.execPath,
    args: ["-e", scriptedAgent(700)],
    requestTimeoutMs: 400,
  });
  t.after(() => agent.stop());

  // Both of these are timed methods and must answer inside the budget.
  await agent.start();
  await agent.newSession();

  // This turn takes 700ms against a 400ms budget. If the deadline applied to
  // session/prompt, this would reject instead of resolving.
  const res = await agent.prompt("take your time");
  assert.equal(res.stopReason, "end_turn");
});

// --- #62 R5 · in-flight prompt guard -----------------------------------------

test("a second prompt during a live turn throws without reaching the wire", async (t) => {
  const agent = new AcpAgent({
    name: "guarded",
    command: process.execPath,
    args: ["-e", scriptedAgent(300)],
    requestTimeoutMs: 2_000,
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();

  const firstTurn = agent.prompt("first");
  await assert.rejects(
    () => agent.prompt("second"),
    /already running a turn/,
    "a second prompt must be refused, not sent",
  );
  assert.equal((await firstTurn).stopReason, "end_turn");

  // The harness counts every session/prompt it actually received. A guard that
  // sent first and failed afterwards would leave this at 2.
  const seen = await agent.request<{ count: number }>("debug/prompt_count");
  assert.equal(seen.count, 1, "the refused prompt must not reach the wire");
});

// --- #62 B3 · the whole PromptResponse ---------------------------------------

test("prompt() returns the whole response, usage and _meta intact", async (t) => {
  const agent = new AcpAgent({
    name: "counts-tokens",
    command: process.execPath,
    args: ["-e", scriptedAgent(10)],
    requestTimeoutMs: 2_000,
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();
  const res = await agent.prompt("how many tokens was that");

  assert.equal(res.stopReason, "end_turn");
  // M0-5: usage is the only per-task token count present on all three
  // harnesses. Dropping it must fail here rather than pass silently.
  assert.deepEqual(res.usage, {
    inputTokens: 11,
    outputTokens: 22,
    totalTokens: 33,
  });
  // The fleet's only exhaustion warning rides on _meta (M0-5), and M1a-2 put
  // _meta on the base of every message type precisely so it survives.
  assert.deepEqual(res._meta, { "_claude/rateLimit": "ok" });
});

// --- #62 R4 · cancel-intent event --------------------------------------------

test("cancel() emits _client_cancel_requested and still sends the notify", async (t) => {
  const events: CapturedEvent[] = [];
  const agent = new AcpAgent({
    name: "cancels",
    command: process.execPath,
    args: ["-e", scriptedAgent(10)],
    requestTimeoutMs: 2_000,
    onEvent: (event) => {
      events.push(event);
    },
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();
  agent.cancel();

  const emitted = events.filter(
    (e) => e.update.sessionUpdate === "_client_cancel_requested",
  );
  assert.equal(emitted.length, 1, "exactly one cancel-intent event");
  assert.equal(emitted[0].agent, "cancels");
  assert.equal(emitted[0].update.sessionId, "s1");

  // The event must accompany the notification, not replace it: M1b-2 reads our
  // record of having asked, but the agent still has to be told.
  const seen = await agent.request<{ count: number }>("debug/cancel_count");
  assert.equal(seen.count, 1, "session/cancel must still reach the harness");
});

test("cancel() before a session exists sends nothing and emits nothing", async (t) => {
  const events: CapturedEvent[] = [];
  const agent = new AcpAgent({
    name: "idle",
    command: process.execPath,
    args: ["-e", scriptedAgent(10)],
    requestTimeoutMs: 2_000,
    onEvent: (event) => {
      events.push(event);
    },
  });
  t.after(() => agent.stop());

  await agent.start();
  agent.cancel(); // no session yet

  assert.equal(events.length, 0, "no event without a session");
  const seen = await agent.request<{ count: number }>("debug/cancel_count");
  assert.equal(seen.count, 0, "no session/cancel on the wire either");
});

test("the guard clears once a turn ends, so later prompts still work", async (t) => {
  const agent = new AcpAgent({
    name: "sequential",
    command: process.execPath,
    args: ["-e", scriptedAgent(50)],
    requestTimeoutMs: 2_000,
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();

  assert.equal((await agent.prompt("first")).stopReason, "end_turn");
  assert.equal((await agent.prompt("second")).stopReason, "end_turn");

  const seen = await agent.request<{ count: number }>("debug/prompt_count");
  assert.equal(seen.count, 2, "sequential turns must both reach the harness");
});
