/**
 * The clipboard tools — `chat/tui/clipboard.ts`: which tool each system
 * tries first, and none at all over ssh.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { clipboardTools } from "../tui/clipboard.ts";

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
