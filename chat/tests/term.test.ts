/**
 * The person's shell — `chat/tui/term.ts`, story M4-13 (#249): a key from
 * pi-tui as a shell's bytes, and a row of cells as text. The shell itself is
 * driven on a pty in `tests/daemon.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { keyBytes, rowOf } from "../tui/term.ts";

test("a kitty or modifyOtherKeys key reaches the shell as its legacy bytes", () => {
  const cases: [string, string, string][] = [
    ["\x1b[99;5u", "\x03", "ctrl+c"],
    ["\x1b[27u", "\x1b", "Esc"],
    ["\x1b[97u", "a", "a printable key"],
    ["\x1b[97:65;2u", "A", "shift+a, with its shifted key"],
    ["\x1b[120;3u", "\x1bx", "alt+x"],
    ["\x1b[13;2u", "\r", "shift+enter"],
    ["\x1b[9;2u", "\x1b[Z", "shift+tab"],
    ["\x1b[27;5;99~", "\x03", "modifyOtherKeys ctrl+c"],
    ["\x1b[1;1:2A", "\x1b[A", "a repeated up arrow"],
  ];
  for (const [key, bytes, what] of cases) {
    assert.equal(keyBytes(key, false), bytes, what);
  }
});

test("a legacy key passes as it came, and an arrow follows DECCKM", () => {
  for (const key of ["a", "\x03", "\x1b[1;5A", "\x1b[3~", "\x1bOP", "é"]) {
    assert.equal(keyBytes(key, false), key);
  }
  assert.equal(keyBytes("\x1b[A", true), "\x1bOA", "vim's cursor keys");
  assert.equal(keyBytes("\x1b[1;5A", true), "\x1b[1;5A", "a modified arrow");
});

/** A screen with `text` written to it, and its first row drawn. */
const drawn = async (text: string, cursor = -1) => {
  const term = new xterm.Terminal({ cols: 8, rows: 2, allowProposedApi: true });
  await new Promise<void>((ok) => term.write(text, ok));
  const b = term.buffer.active;
  return rowOf(b.getLine(0), 8, b.getNullCell(), cursor);
};

test("a row keeps its colours and is exactly as wide as the view", async () => {
  assert.equal(await drawn("plain"), "plain   ");
  assert.equal(
    await drawn("\x1b[1;31mab\x1b[0mc"),
    "\x1b[0;1;31mab\x1b[0mc     ",
    "bold red, then the default",
  );
  assert.equal(
    await drawn("\x1b[38;5;200mx\x1b[48;2;1;2;3my"),
    "\x1b[0;38;5;200mx\x1b[0;38;5;200;48;2;1;2;3my\x1b[0m      ",
    "256 colours and RGB",
  );
  // A wide character takes two columns and is written once.
  assert.equal(await drawn("界a"), "界a     ");
  assert.equal(await drawn("ab", 1), "a\x1b[0;7mb\x1b[0m      ", "the cursor");
});
