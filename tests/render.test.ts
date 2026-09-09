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
import type { SessionUpdate } from "../protocol/types.ts";
import { render } from "../render.ts";

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

/**
 * The markdown repaint — M1c-7. `draw` above leaves `process.stdout.isTTY`
 * as the test runner set it (a pipe), which is the path this story must not
 * change; this one claims a terminal so the repaint runs.
 */
function drawOnTty(updates: SessionUpdate[]): string {
  const stdout = process.stdout;
  const was = {
    isTTY: stdout.isTTY,
    columns: stdout.columns,
    rows: stdout.rows,
    noColor: process.env.NO_COLOR,
  };
  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.rows = 24;
  process.env.NO_COLOR = undefined as unknown as string;
  delete process.env.NO_COLOR;
  try {
    return draw(updates);
  } finally {
    stdout.isTTY = was.isTTY;
    stdout.columns = was.columns;
    stdout.rows = was.rows;
    if (was.noColor !== undefined) process.env.NO_COLOR = was.noColor;
  }
}

/** What survives on screen: everything after the last erase. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: splitting on the erase.
const tail = (out: string) => out.split(/\x1b\[J/).pop() ?? out;

/** What the erase looks like on the wire, so a test can spot one. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the subject.
const ERASE = /\x1b\[(?:\d+A)?\x1b\[J|\r\x1b\[J/;

test("piped output stays the plain markdown source, with no repaint escapes", () => {
  const out = draw([says("## Header\n"), says("\n| a |\n| - |\n\n")]);

  assert.equal(out, "## Header\n\n| a |\n| - |\n\n");
  assert.equal(ERASE.test(out), false, "nothing to erase when nobody can see");
});

test("a closed block is erased and redrawn formatted", () => {
  const out = drawOnTty([says("## Head"), says("er\n"), says("\nrest")]);

  // The raw text is drawn first, exactly as before, then taken back.
  assert.match(out, /^## Header\n/);
  assert.match(out, ERASE);
  assert.match(out, /Header\n\nrest$/, "the rendered heading replaces it");
  assert.equal(out.includes("## Header\n\nrest"), false, "the `##` is gone");
});

test("a fenced block containing a blank line survives as one block", () => {
  const out = drawOnTty([
    says("```js\nconst x = 1;\n"),
    says("\nconst y = 2;\n```\n\n"),
  ]);

  assert.match(out, / {2}const x = 1;\n\n {2}const y = 2;\n/);
  // The raw draw legitimately carries the fence; what matters is what stands
  // after the last erase.
  assert.equal(
    tail(out).includes("```"),
    false,
    "the fence markers are not left on screen",
  );
});

test("a tool call flushes the open block instead of landing inside it", () => {
  const out = drawOnTty([
    says("Reading the **file**"),
    {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Read",
      kind: "read",
    },
  ]);

  assert.match(out, /Reading the file\n\[h\] → Read \[read\]\n$/);
});

test("a block taller than the screen is left raw rather than mis-erased", () => {
  const tall = `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}\n\n`;
  const out = drawOnTty([says(tall.slice(0, -1)), says("\n")]);

  assert.equal(out, tall, "drawn once, raw, and never taken back");
  assert.equal(ERASE.test(out), false);
});
