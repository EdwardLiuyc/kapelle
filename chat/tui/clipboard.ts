/**
 * `chat/tui/clipboard.ts` — copy a mouse selection to the system clipboard.
 *
 * pi-tui copies a selection with an OSC 52 write and then shows "Copied!",
 * even when the terminal ignores the write. Under WSL that left the
 * clipboard empty. So we try the platform's own tool first: `clip.exe`
 * under WSL and Windows, `pbcopy` on macOS, `wl-copy` or `xclip` on Linux.
 * "Copied!" then means the tool said yes.
 *
 * When no tool is there, or every tool fails (over ssh, say), we fall back
 * to the OSC 52 write. A terminal that knows OSC 52 still copies.
 */

import { spawn } from "node:child_process";
import { release } from "node:os";

type Tool = { cmd: string; args: string[]; utf16?: boolean };

/** The tools to try, in order. `clip.exe` reads UTF-8 as the console's
 *  code page, so it gets UTF-16. No byte order mark: it would be pasted. */
const clipboardTools = (
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  osRelease: string = release(),
): Tool[] => {
  if (platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
  if (platform === "win32") return [{ cmd: "clip", args: [], utf16: true }];
  const tools: Tool[] = [];
  if (env.WSL_DISTRO_NAME || /microsoft/i.test(osRelease)) {
    tools.push({ cmd: "clip.exe", args: [], utf16: true });
  }
  if (env.WAYLAND_DISPLAY) tools.push({ cmd: "wl-copy", args: [] });
  if (env.DISPLAY) {
    tools.push({ cmd: "xclip", args: ["-selection", "clipboard"] });
  }
  return tools;
};

/** True when the tool ran and exited 0. A missing tool is false. */
const runTool = (tool: Tool, text: string): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn(tool.cmd, tool.args, {
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 2000,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(tool.utf16 ? Buffer.from(text, "utf16le") : text);
  });

/** pi-tui's `copySelection`. `write` is the terminal's, for the OSC 52
 *  fallback. Tests pass their own `tools`. */
const copySelection =
  (write: (data: string) => void, tools: Tool[] = clipboardTools()) =>
  async (text: string): Promise<boolean> => {
    for (const tool of tools) {
      if (await runTool(tool, text)) return true;
    }
    // ponytail: the OSC 52 fallback cannot know if the terminal copied, so
    // it says yes, as pi-tui did before.
    write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    return true;
  };

export { clipboardTools, copySelection };
