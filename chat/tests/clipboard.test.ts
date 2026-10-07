/**
 * The clipboard tools — `chat/tui/clipboard.ts`: which tool each system
 * tries first, and none at all over ssh; the bytes each tool gets, and the
 * OSC 52 fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { clipboardTools, copySelection } from "../tui/clipboard.ts";

const cmds = (...a: Parameters<typeof clipboardTools>) =>
  clipboardTools(...a).map((t) => t.cmd);

test("WSL tries clip.exe first, with UTF-16", () => {
  const tools = clipboardTools(
    "linux",
    { DISPLAY: ":0" },
    "6.6.0-microsoft-standard-WSL2",
  );
  assert.deepEqual(
    tools.map((t) => t.cmd),
    ["clip.exe", "xclip"],
  );
  assert.equal(tools[0]?.utf16, true);
  assert.deepEqual(cmds("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "6.6.0"), [
    "clip.exe",
  ]);
});

test("each system picks its own tool", () => {
  assert.deepEqual(cmds("darwin", {}, ""), ["pbcopy"]);
  assert.deepEqual(cmds("win32", {}, ""), ["clip"]);
  assert.deepEqual(cmds("linux", { WAYLAND_DISPLAY: "wayland-0" }, "6.6.0"), [
    "wl-copy",
  ]);
});

test("no display and no WSL: no tool, so OSC 52 only", () => {
  assert.deepEqual(cmds("linux", {}, "6.6.0"), []);
});

/** A tool that exits 0 only when its stdin is `bytes`. */
const expects = (bytes: Buffer, utf16?: boolean) => ({
  cmd: process.execPath,
  args: [
    "-e",
    'const b=[];process.stdin.on("data",(d)=>b.push(d)).on("end",()=>process.exit(Buffer.concat(b).toString("hex")===process.argv[1]?0:1))',
    bytes.toString("hex"),
  ],
  utf16,
});

const text = "ü 漢字\nline two";
const osc52 = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;

test("a UTF-16 tool gets UTF-16 with no byte order mark, the others UTF-8", async () => {
  const written: string[] = [];
  const write = (d: string) => written.push(d);
  const utf16 = Buffer.from(text, "utf16le");
  const utf8 = Buffer.from(text);
  assert.equal(await copySelection(write, [expects(utf16, true)])(text), true);
  assert.equal(await copySelection(write, [expects(utf8)])(text), true);
  assert.deepEqual(written, [], "a tool that copied needs no OSC 52");
  // The wrong bytes make the tool fail, so the fallback runs.
  await copySelection(write, [expects(utf8, true)])(text);
  assert.deepEqual(written, [osc52]);
});

test("no tool, or a missing one, falls back to the OSC 52 write", async () => {
  const written: string[] = [];
  const write = (d: string) => written.push(d);
  assert.equal(await copySelection(write, [])(text), true);
  const missing = { cmd: "kapelle-no-such-tool", args: [] };
  assert.equal(await copySelection(write, [missing])(text), true);
  assert.deepEqual(written, [osc52, osc52]);
});
