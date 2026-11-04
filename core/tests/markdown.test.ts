/**
 * `core/markdown.ts` — story M1c-7, issue #78.
 *
 * `blockEnd` is a truth table, per M1a-1's rule that the pure half is tested
 * as a pure function and the drawing is not. The renderer's own tests assert
 * the three constructs the story names — nested list, table, fence with a
 * blank line in it — plus the fallback that makes the dependency affordable.
 * #431 adds the blockquote, rule, HTML/fallback and inline renderers the
 * scope names, with their exact colour codes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import { blockEnd, displayWidth, toAnsi } from "../markdown.ts";

/** For the tests whose subject is not colour. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR codes.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

test("blockEnd: where one block ends and the next begins", () => {
  const cases: [string, number, string][] = [
    ["", -1, "nothing yet"],
    ["para", -1, "a line still arriving never closes a block"],
    ["para\n", -1, "a complete line is not a boundary; a blank one is"],
    ["para\n\n", 6, "paragraph closes at the blank line, without waiting"],
    ["\n\npara\n\n", 8, "leading blank lines belong to no block"],
    ["# h\n\nnext", 5, "a heading is a block like any other"],
    ["| a |\n| - |\n\n", 13, "a table closes on its blank line"],
    [
      "```\na\n\nb\n```\n\n",
      14,
      "a blank line inside a fence does not split it",
    ],
    ["```\na\n\n", -1, "an open fence swallows the blank line"],
    ["~~~\na\n~~~\n\n", 11, "tildes fence too"],
    [
      "````\na\n```\n\n",
      -1,
      "a closing run shorter than the opening one is not one",
    ],
    ["```\na\n````\n\n", 12, "a longer closing run is"],
    ["- a\n\n", -1, "a list waits one line: the blank may be internal"],
    ["- a\n\n- b\n\nx\n", 10, "a loose list is one block, not two"],
    ["- a\n\n  more\n\nx\n", 13, "an indented line continues the item"],
    ["- a\n\nx\n", 5, "a paragraph after a list does close it"],
    ["1. a\n\n2. b\n\nx\n", 12, "ordered lists keep their numbering intact"],
  ];

  for (const [text, expected, why] of cases) {
    assert.equal(blockEnd(text), expected, `${JSON.stringify(text)} — ${why}`);
  }
});

test("a nested list indents instead of gluing the child to its parent", () => {
  // The measurement that dropped md4x: it renders this as `* one  * alpha`.
  assert.equal(
    plain(toAnsi("- one\n  - alpha\n  - beta\n- two\n")),
    ["- one", "  - alpha", "  - beta", "- two", ""].join("\n"),
  );
});

test("an ordered list numbers each level from its own start", () => {
  assert.equal(plain(toAnsi("3. c\n4. d\n")), "3. c\n4. d\n");
});

test("a table is drawn as a box, aligned on its widest cell", () => {
  const out = plain(
    toAnsi("| a | bb |\n| --- | --- |\n| cccc | d |\n", { width: 40 }),
  );
  assert.equal(
    out,
    [
      "┌──────┬────┐",
      "│ a    │ bb │",
      "├──────┼────┤",
      "│ cccc │ d  │",
      "└──────┴────┘",
      "",
    ].join("\n"),
  );
});

test("a table too narrow to read falls back to its own source", () => {
  const md = "| a | bb |\n| --- | --- |\n| cccc | d |\n";
  assert.equal(plain(toAnsi(md, { width: 8 })), md);
});

test("a fenced block containing a blank line is not split in two", () => {
  const out = plain(toAnsi("```js\nconst x = 1;\n\nconst y = 2;\n```\n"));
  assert.equal(out, "  const x = 1;\n\n  const y = 2;\n");
});

test("a renderer failure costs the screen, not the run", () => {
  const real = marked.lexer;
  marked.lexer = () => {
    throw new Error("bad release");
  };
  try {
    assert.equal(toAnsi("## header"), "## header");
  } finally {
    marked.lexer = real;
  }
});

test("a blockquote, a rule and an HTML block keep their text", () => {
  // Every line of a quote gets the mark, the blank one between blocks too.
  assert.equal(
    toAnsi("> a\n>\n> b\n"),
    `${dim("│ ")}a\n${dim("│ ")}\n${dim("│ ")}b\n`,
  );
  // A quote takes two columns from what it holds.
  assert.equal(
    toAnsi("> ---\n", { width: 10 }),
    `${dim("│ ")}${dim("─".repeat(8))}\n`,
  );
  // Narrower than its mark, a rule still draws one column: `repeat` would
  // throw on a negative count, and the fallback would hide it as raw text.
  assert.equal(toAnsi("> ---\n", { width: 1 }), `${dim("│ ")}${dim("─")}\n`);
  assert.equal(toAnsi("---\n", { width: 10 }), `${dim("─".repeat(10))}\n`);
  assert.equal(
    toAnsi("---\n", { width: 200 }),
    `${dim("─".repeat(80))}\n`,
    "a rule stops at 80 columns",
  );
  assert.equal(toAnsi("<div>\nhi\n</div>\n"), "<div>\nhi\n</div>\n");
});

test("a block token the renderer does not know prints its source", () => {
  // The stock lexer never makes one; an extension could.
  const real = marked.lexer;
  marked.lexer = () =>
    [{ type: "custom", raw: "raw text\n" }] as ReturnType<typeof real>;
  try {
    assert.equal(toAnsi("ignored"), "raw text\n");
  } finally {
    marked.lexer = real;
  }
});

test("inline emphasis, deletion, code, links, images and breaks", () => {
  assert.equal(
    toAnsi("*a* ~~b~~ `c`\n"),
    "\x1b[3ma\x1b[23m \x1b[9mb\x1b[29m \x1b[36mc\x1b[39m\n",
  );
  assert.equal(
    toAnsi("[t](http://u) <http://u>\n"),
    `\x1b[4mt\x1b[24m${dim(" (http://u)")} \x1b[4mhttp://u\x1b[24m\n`,
    "a link shows its href only when the text differs",
  );
  assert.equal(toAnsi("![alt](p.png)\n"), `${dim("[image: alt]")}\n`);
  assert.equal(toAnsi("a  \nb\n"), "a\nb\n", "a hard break is a new line");
  // An escape and inline HTML have no case of their own: their text prints.
  assert.equal(toAnsi("x \\* <b>y</b>\n"), "x * <b>y</b>\n");
});

test("displayWidth counts terminal columns, not code points", () => {
  // The erase in `render.ts` is measured with this, so an over-count moves the
  // cursor up past its own output and eats the lines above it.
  assert.equal(displayWidth("abc"), 3);
  assert.equal(
    displayWidth("\u001b[1mabc\u001b[22m"),
    3,
    "colour is not width",
  );
  assert.equal(
    displayWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"),
    2,
    "one grapheme, two columns, five code points",
  );
  assert.equal(displayWidth("\u4E2D\u6587"), 4, "CJK is double width");
  assert.equal(displayWidth("e\u0301"), 1, "a combining accent adds no column");
});

test("a truncated wide-glyph cell still fits its column", () => {
  // #94 review: `clip` sliced code points. Eight CJK characters are eight code
  // points and sixteen columns, so the row came out eight columns wider than
  // its own border, and a ZWJ emoji sequence could be cut in half.
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  for (const cell of [
    "\u4E2D\u6587".repeat(10),
    family.repeat(8),
    "ascii".repeat(9),
  ]) {
    const md = `| name | note |\n| --- | --- |\n| ${cell} | ok |\n`;
    const rows = plain(toAnsi(md, { width: 20 }))
      .split("\n")
      .filter(Boolean);
    const widths = new Set(rows.map(displayWidth));
    assert.equal(
      widths.size,
      1,
      `every row must be one width, got ${[...widths].join(",")} for ${JSON.stringify(cell.slice(0, 12))}`,
    );
  }
});

test("a truncated cell never splits a grapheme cluster", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const md = `| name |\n| --- |\n| ${family.repeat(6)} |\n`;
  const out = plain(toAnsi(md, { width: 12 }));
  assert.equal(
    out.includes("\u200D\u2026"),
    false,
    "no ellipsis after a joiner",
  );
  assert.match(out, /\u2026/, "it did truncate");
});
