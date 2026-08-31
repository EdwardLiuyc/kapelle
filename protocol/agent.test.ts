/**
 * M1a-3 acceptance tests — issue #11, the per-request timeout (#62 B1).
 *
 * Both halves of the decision are behavioural, so both are driven by a real
 * subprocess over real stdio rather than by poking at internals: a harness
 * that accepts the pipe and never answers `initialize` must fail on a
 * deadline instead of hanging, and `session/prompt` must never be bounded by
 * that deadline because a turn is legitimately long.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AcpAgent } from "./agent.ts";

/** Accepts the pipe, reads stdin, and answers nothing, ever. */
const HANGS_FOREVER = "process.stdin.resume();";

/**
 * Answers the handshake immediately but `session/prompt` only after a delay
 * longer than the deadline, so a timeout wrongly applied to a turn fires
 * before the reply can arrive. Written without imports so it runs the same
 * whether node treats `--eval` input as CommonJS or ESM.
 */
const SLOW_TURN = [
  'let buf = "";',
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
  '    else if (msg.method === "session/prompt")',
  '      setTimeout(() => send(msg.id, { stopReason: "end_turn" }), 700);',
  "  }",
  "});",
].join("\n");

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
    args: ["-e", SLOW_TURN],
    requestTimeoutMs: 400,
  });
  t.after(() => agent.stop());

  // Both of these are timed methods and must answer inside the budget.
  await agent.start();
  await agent.newSession();

  // This turn takes 700ms against a 400ms budget. If the deadline applied to
  // session/prompt, this would reject instead of resolving.
  const stopReason = await agent.prompt("take your time");
  assert.equal(stopReason, "end_turn");
});
