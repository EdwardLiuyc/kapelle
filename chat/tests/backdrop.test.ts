/**
 * The screen behind a pop-up — `chat/tui/backdrop.ts` (#407): every
 * background turns one gray, the rest loses its colour, the text and its
 * width stay, and no background runs past its span or its line.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bg, bgRgb, fg } from "../common.ts";
import { backdropLines } from "../tui/backdrop.ts";

const GRAY = "\x1b[48;5;235m";
const one = (line: string) => backdropLines([line])[0];
/** Dim, as the backdrop closes each line. */
const dimmed = (s: string) => `\x1b[2m${s}\x1b[22m`;

/** Sets the environment for one test, and puts it back after. */
const env = (t: TestContext, vars: Record<string, string | undefined>) => {
  const was = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  const set = (v: Record<string, string | undefined>) => {
    for (const [k, value] of Object.entries(v)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  };
  t.after(() => set(was));
  set(vars);
};

test("a tool call's background turns gray, whatever its status (#407)", (t) => {
  env(t, { NO_COLOR: undefined, COLORTERM: undefined });
  const row = " $ npm test  ✓      ";
  for (const [status, colorterm, paint] of [
    ["active", "", bg(236)],
    ["success, 256 colours", "", bgRgb(37, 65, 49, 23)],
    ["success, truecolor", "truecolor", bgRgb(37, 65, 49, 23)],
    ["failure", "", bg(52)],
  ] as const) {
    process.env.COLORTERM = colorterm;
    const line = `${fg(244)("▎")}${paint(row)}`;
    assert.equal(one(line), dimmed(`▎${GRAY}${row}\x1b[49m`), status);
  }
});

test("a padding row keeps its gray, so the block keeps its shape", (t) => {
  env(t, { NO_COLOR: undefined });
  const pad = " ".repeat(20);
  assert.equal(one(bg(52)(pad)), dimmed(`${GRAY}${pad}\x1b[49m`));
});

test("a plain line loses its colours and is dim", (t) => {
  env(t, { NO_COLOR: undefined });
  assert.equal(
    one(`\x1b[1m\x1b[36mhello\x1b[39m\x1b[22m world`),
    dimmed("hello world"),
  );
  assert.equal(one(""), dimmed(""));
});

test("only the span that had a background turns gray", (t) => {
  env(t, { NO_COLOR: undefined });
  assert.equal(one(`a${bg(52)("b")}c`), dimmed(`a${GRAY}b\x1b[49mc`));
  // A reset ends it too, and so does the colon form's own close.
  assert.equal(one("\x1b[41mx\x1b[0my"), dimmed(`${GRAY}x\x1b[49my`));
  assert.equal(one("\x1b[48:5:52mx\x1b[49my"), dimmed(`${GRAY}x\x1b[49my`));
});

test("a colour's numbers are not read as codes of their own", (t) => {
  env(t, { NO_COLOR: undefined });
  // 48 as a 256-colour index, and as a red value: neither is a background.
  assert.equal(one("\x1b[38;5;48mx"), dimmed("x"));
  assert.equal(one("\x1b[38;2;48;0;0mx"), dimmed("x"));
  // 2 and 5 inside a background are not dim and blink.
  assert.equal(one("\x1b[48;5;2mx"), dimmed(`${GRAY}x\x1b[49m`));
});

test("a background left open does not run past its line", (t) => {
  env(t, { NO_COLOR: undefined });
  const [open, next] = backdropLines(["\x1b[48;5;52mopen", "next"]);
  assert.equal(open, dimmed(`${GRAY}open\x1b[49m`));
  assert.equal(next, dimmed("next"));
});

test("other sequences in the text go", (t) => {
  env(t, { NO_COLOR: undefined });
  const link = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
  assert.equal(one(`\x1b[41m${link}\x1b[49m`), dimmed(`${GRAY}link\x1b[49m`));
});

test("NO_COLOR: no background is left (#407)", (t) => {
  env(t, { NO_COLOR: "1" });
  assert.equal(
    one("▎\x1b[48;5;52m $ ls \x1b[49m\x1b[38;5;244mx\x1b[39m"),
    dimmed("▎ $ ls x"),
  );
});

test("the visible text and its width do not change", (t) => {
  env(t, { NO_COLOR: undefined, COLORTERM: "truecolor" });
  for (const line of [
    `${fg(244)("▎")}${bgRgb(37, 65, 49, 23)(" $ ✓ 中文 ".padEnd(30))}`,
    `plain ${bg(236)("you")} after`,
    "",
  ]) {
    assert.equal(visibleWidth(one(line)), visibleWidth(line), line);
  }
});
