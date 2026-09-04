/**
 * The renderer's stream state machine — the follow-up to M1a-7.
 *
 * Everything else about `render.ts` is eyeballed through `npm run selftest`,
 * and that is why this bug shipped: `mock-agent.mjs` sends a thought as one
 * chunk, so the one-prefix-per-chunk shape looked fine offline and only fell
 * apart against a harness that streams thinking a few tokens at a time.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUpdate } from "./protocol/types.ts";
import { render } from "./render.ts";

/**
 * Closes whatever line the previous test left open. The renderer's stream state
 * is module-level on purpose — one process draws one run — so a test that began
 * mid-stream would inherit the last one's half-written line.
 */
const RESET: SessionUpdate = {
  sessionUpdate: "tool_call",
  toolCallId: "reset",
  title: "reset",
  kind: "other",
};

/** Runs `render` over a script of updates and returns what reached stdout. */
function draw(updates: SessionUpdate[]): string {
  let written: string[] = [];
  const real = process.stdout.write;
  // biome-ignore lint/suspicious/noExplicitAny: stdout.write has three overloads.
  process.stdout.write = ((s: any) => {
    written.push(String(s));
    return true;
  }) as typeof real;
  try {
    render({ agent: "h", update: RESET });
    written = [];
    for (const update of updates) render({ agent: "h", update });
  } finally {
    process.stdout.write = real;
  }
  // Strip colour so the assertions are about text, not escapes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR codes.
  return written.join("").replace(/\x1b\[\d+m/g, "");
}

const thought = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});

const says = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

test("a thought split across chunks keeps one prefix and reads as one sentence", () => {
  const out = draw([
    thought("I need to"),
    thought(" read the"),
    thought(" file."),
  ]);

  assert.equal(out, "[h] thinking: I need to read the file.");
  assert.equal(
    out.match(/thinking:/g)?.length,
    1,
    "one prefix, not one per chunk",
  );
});

test("the run's first chunk loses its leading space, since the prefix supplies one", () => {
  assert.equal(draw([thought("  padded")]), "[h] thinking: padded");
});

test("switching between thinking and speaking closes the open line", () => {
  const out = draw([
    thought("hmm"),
    says("Hello"),
    says(" there"),
    thought("again"),
  ]);

  assert.equal(out, "[h] thinking: hmm\nHello there\n[h] thinking: again");
});

test("a line event closes an open stream instead of landing on it", () => {
  const out = draw([
    says("mid-sentence"),
    {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read",
      kind: "read",
    },
  ]);

  assert.equal(out, "mid-sentence\n[h] → Read [read]\n");
});
