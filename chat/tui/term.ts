/**
 * `chat/tui/term.ts` — the person's shell in the side view (M4-13).
 *
 * **One shell per chat, for the person, not for an agent** (decided
 * 2026-10-13, #249). `/term` starts it in the open room's `cwd`, and it
 * lives until it exits or the chat ends. A `/term` in another room shows
 * the same shell, in the folder it started in; `exit`, then `/term`, starts
 * one in the open room's. It is not ACP `terminal/*` (§M0-3).
 *
 * **The pty is `script(1)`, not `node-pty`.** `node-pty` 1.1.0 has no Linux
 * prebuild, and any native pty loads code into the chat that a crash takes
 * down with it. `script` makes the pty in a process of its own, so its worst
 * failure is a shell that ends. We talk to it over pipes. The inner command
 * writes the pty's path to fd 3 first, and a resize is `stty rows r cols c`
 * on that path from outside: the kernel then sends the shell SIGWINCH
 * (measured 2026-10-13). A failed or hung resize is retried at the same
 * size; after three tries that geometry is left until the pane changes.
 * macOS takes other flags (`script -q /dev/null cmd`, `stty -f`), and they
 * are not measured yet.
 *
 * **The screen is `@xterm/headless`**, pinned, under M1c-7's rule as amended
 * here: it is pure JS with no dependency, it only turns the shell's bytes
 * into cells, and its replies (a cursor report, say) go to this shell and
 * nowhere else. `rowOf` draws a row of cells as text with SGR colours.
 * A throw while drawing ends the shell, not the chat: the pane says
 * `screen failed`. A throw while xterm parses comes from its own timer,
 * where no `try` of ours can reach it, so it ends the screen through
 * `chat/tui.ts`'s crash handler; the room lives on in the daemon (PR #286).
 *
 * **Keys.** pi-tui asks the outer terminal for the kitty keyboard protocol or
 * modifyOtherKeys, so ctrl+c can come as `\x1b[99;5u`. A shell knows only
 * the legacy bytes, so `keyBytes` turns such a key back.
 */

import { execFile, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { decodeKittyPrintable, parseKey } from "@earendil-works/pi-tui";
import type { IBufferCell, IBufferLine } from "@xterm/headless";
import xterm from "@xterm/headless";
import { printable } from "../../client/room.ts";

const MAC = process.platform === "darwin";
/** A failed or timed-out `stty` gets three tries, this far apart, before
 *  that geometry waits for the pane to change. */
const RESIZE_TRIES = 3;
const RESIZE_RETRY_MS = 50;
const RESIZE_TIMEOUT_MS = 1000;

/** The legacy bytes of a key with no modifier. */
const SPECIAL: Record<string, string> = {
  escape: "\x1b",
  enter: "\r",
  tab: "\t",
  space: " ",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  insert: "\x1b[2~",
  delete: "\x1b[3~",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
};

/** A legacy key with kitty's event type (`:2`, a repeat) as xterm sends it
 *  without one: `\x1b[15;1:2~` is F5. pi-tui names no F-key in this form.
 *  `undefined` when `csi` is not that shape. */
function withoutEvent(csi: string): string | undefined {
  const m = /^(\d+);(\d+):\d+([~A-Z])$/.exec(csi);
  if (!m) return undefined;
  const [, n, mods, final] = m;
  if (final === "~") return mods === "1" ? `\x1b[${n}~` : `\x1b[${n};${mods}~`;
  if (mods !== "1") return `\x1b[1;${mods}${final}`;
  return "PQRS".includes(final as string) ? `\x1bO${final}` : `\x1b[${final}`;
}

/** A ctrl+symbol in the legacy encoding. */
const CTRL_SYMBOL: Record<string, string> = {
  "[": "\x1b",
  "\\": "\x1c",
  "]": "\x1d",
  "^": "\x1e",
  "6": "\x1e",
  "-": "\x1f",
  _: "\x1f",
  "/": "\x1f",
  "@": "\x00",
  "2": "\x00",
  space: "\x00",
};

/** A key pi-tui parsed, as xterm sends it. `undefined` when we do not know. */
function legacy(id: string): string | undefined {
  const mods = id.split("+");
  const base = mods.pop() ?? "";
  const shift = mods.includes("shift");
  const alt = mods.includes("alt");
  const ctrl = mods.includes("ctrl");
  let s: string | undefined;
  if (base === "tab" && shift) s = "\x1b[Z";
  else if (ctrl && CTRL_SYMBOL[base]) s = CTRL_SYMBOL[base];
  else if (SPECIAL[base]) {
    s = SPECIAL[base];
    // xterm puts a modified cursor or edit key's modifiers in the sequence.
    const m = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    if (m > 1 && s.length > 2) {
      return s.endsWith("~")
        ? s.replace("~", `;${m}~`)
        : `\x1b[1;${m}${s.slice(2)}`;
    }
  } else if (base.length === 1) {
    s = shift ? base.toUpperCase() : base;
    const code = base.charCodeAt(0);
    if (ctrl && code >= 97 && code <= 122) s = String.fromCharCode(code - 96);
    else if (ctrl) return undefined;
  }
  if (s === undefined) return undefined;
  return alt ? `\x1b${s}` : s;
}

/**
 * The bytes a shell gets for a key from pi-tui. A kitty key (`\x1b[…u`), a
 * modifyOtherKeys key (`\x1b[27;…~`) or a key with an event type (`:2`) is
 * turned into xterm's legacy bytes, or dropped when it has none: its raw
 * bytes would read as Esc and text (in vim, leave insert mode and run
 * them). Anything else passes as it came. With
 * `appCursor` set (DECCKM, as vim sets it), an arrow is `\x1bOA`.
 */
export function keyBytes(data: string, appCursor: boolean): string {
  let out = data;
  const csi = data.startsWith("\x1b[") ? data.slice(2) : "";
  const encoded =
    /^[\d;:]+[u~A-Z]$/.test(csi) &&
    (csi.endsWith("u") || csi.startsWith("27;") || csi.includes(":"));
  if (encoded) {
    const id = parseKey(data);
    // Kitty names a key with no character, such as the menu key, by a
    // private-use code point; pi-tui reads it as printable.
    const text = decodeKittyPrintable(data);
    const printable = text && !/[\uE000-\uF8FF]/u.test(text) ? text : undefined;
    out = printable ?? (id && legacy(id)) ?? withoutEvent(csi) ?? "";
  }
  const arrow = out.length === 3 && out.startsWith("\x1b[") ? out[2] : "";
  return appCursor && arrow && "ABCDHF".includes(arrow) ? `\x1bO${arrow}` : out;
}

type Cell = IBufferCell;

/** A colour's SGR, from 30 (foreground) or 40 (background). */
function colour(base: number, palette: boolean, rgb: boolean, v: number) {
  if (rgb)
    return `;${base + 8};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;
  if (!palette) return "";
  if (v < 8) return `;${base + v}`;
  if (v < 16) return `;${base + 60 + v - 8}`;
  return `;${base + 8};5;${v}`;
}

/** A cell's SGR parameters after `0`, with the cursor drawn inverse. */
function sgrOf(c: Cell, cursor: boolean) {
  let s = "";
  if (c.isBold()) s += ";1";
  if (c.isDim()) s += ";2";
  if (c.isItalic()) s += ";3";
  if (c.isUnderline()) s += ";4";
  if (Boolean(c.isInverse()) !== cursor) s += ";7";
  if (c.isInvisible()) s += ";8";
  if (c.isStrikethrough()) s += ";9";
  s += colour(30, c.isFgPalette(), c.isFgRGB(), c.getFgColor());
  s += colour(40, c.isBgPalette(), c.isBgRGB(), c.getBgColor());
  return s;
}

/**
 * One row of the screen as text: `cols` cells wide, with SGR runs, and the
 * cell at `cursor` drawn inverse. A cell holds no control character, so the
 * text is safe to draw (#229).
 */
export function rowOf(
  line: IBufferLine | undefined,
  cols: number,
  cell: Cell,
  cursor = -1,
): string {
  let out = "";
  let sgr = "";
  for (let x = 0; x < cols; x++) {
    const c = line?.getCell(x, cell);
    // The second half of a wide character takes no room of its own.
    if (c && c.getWidth() === 0) continue;
    const next = c ? sgrOf(c, x === cursor) : x === cursor ? ";7" : "";
    if (next !== sgr) {
      out += `\x1b[0${next}m`;
      sgr = next;
    }
    out += c?.getChars() || " ";
  }
  return sgr ? `${out}\x1b[0m` : out;
}

/** A shell on a pty, and the screen it draws. */
export interface Shell {
  readonly cwd: string;
  /** How it ended: its exit code, or why it could not start. */
  readonly ended: string | undefined;
  /** The screen, `rows` rows of `cols` cells; it resizes the shell to that.
   *  `cursor` draws the cursor. */
  rows(cols: number, rows: number, cursor: boolean): string[];
  /** A key from pi-tui, as `keyBytes` turns it. */
  key(data: string): void;
  /** Scrolls the screen into its history; a key comes back to the end. */
  scroll(lines: number): void;
  kill(): void;
}

/** sh's own quotes around `s`. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Starts the person's shell in `cwd`. `changed` runs when the screen has new
 * cells; `ended` once, when the shell is gone. The shell is killed when the
 * chat process exits, however it exits.
 */
export function startShell(
  cwd: string,
  size: { cols: number; rows: number },
  changed: () => void,
  ended: (how: string) => void,
): Shell {
  const shell = process.env.SHELL || "/bin/sh";
  // A tiny screen can ask for less than one; `stty` refuses that.
  let cols = Math.max(1, size.cols);
  let rows = Math.max(1, size.rows);
  // util-linux `script -c` runs the command with `$SHELL -c`, so SHELL is sh
  // for `script` and the user's own again for the shell. `script` outlives
  // a chat killed by a signal, so a watcher holds fd 3: when the chat's end
  // closes, however the chat died, it hangs up the shell. The watcher reads
  // fd 3, which the shell wrote its path to: that works because libuv makes
  // an extra stdio pipe a socketpair, which goes both ways. Were it a
  // one-way pipe, `cat` would fail at once and hang up a fresh shell. It
  // fires on every end, as the exit closes fd 3 too: then the HUP finds the
  // shell's pid already gone, a moment after it died.
  const inner = [
    "tty >&3",
    `stty rows ${rows} cols ${cols}`,
    "{ cat >/dev/null; kill -HUP $$; } <&3 >/dev/null 2>&1 &",
    "exec 3>&-",
    `SHELL=${quote(shell)}`,
    "export SHELL",
    `exec ${quote(shell)}`,
  ].join("\n");
  const args = MAC
    ? ["-qF", "/dev/null", "/bin/sh", "-c", inner]
    : ["-qfec", inner, "/dev/null"];
  // `buffer` is a proposed API in the headless build. Made before the
  // shell, so a throw here leaves no process behind.
  const term = new xterm.Terminal({
    cols,
    rows,
    scrollback: 1000,
    allowProposedApi: true,
  });
  const cell = term.buffer.active.getNullCell();
  const child = spawn("script", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, SHELL: "/bin/sh", TERM: "xterm-256color" },
  });
  // SAFETY: stdio asks for four pipes; Node types them as maybe null.
  const [stdin, stdout, stderr, told] = child.stdio as unknown as [
    Writable,
    Readable,
    Readable,
    Readable,
  ];
  let how: string | undefined;
  /** Why the screen failed to draw, once it did. */
  let broken: string | undefined;
  /** `script`'s own complaint, such as flags it does not take: the shell's
   *  errors go to the pty, so this is `script`'s alone. */
  let complaint = "";
  stderr.on("data", (b: Buffer) => {
    if (complaint.length < 200) complaint += b.toString();
  });
  const end = (why: string) => {
    if (how !== undefined) return;
    how = why;
    process.off("exit", kill);
    ended(why);
  };
  const kill = () => {
    child.kill();
  };
  process.on("exit", kill);

  // A write after the shell is gone is EPIPE: the exit says what happened.
  stdin.on("error", () => {});
  child.on("error", (err) => end(`could not start: ${err.message}`));
  child.on("exit", (code, signal) => {
    // The watcher's turn to end, before its shell's pid can be reused.
    told.destroy();
    // A system binary's bytes, drawn in the pane's title: drawable first
    // (#229).
    const first = printable(complaint.trim().split("\n")[0] ?? "").trim();
    end(
      broken ??
        (signal
          ? `killed by ${signal}`
          : `exited (code ${code})${code && first ? `: ${first}` : ""}`),
    );
  });
  stdout.on("data", (b: Buffer) => term.write(b, changed));
  // The answers the screen sends, such as where the cursor is.
  term.onData((d) => stdin.write(d));

  /** The pty's path, once the shell told it on fd 3, and the size it was
   *  last given. */
  let pts = "";
  let applied = `${rows} ${cols}`;
  /** One `stty` at a time: two run as two processes, and the older could
   *  land last and leave the pty at its size. The size is read again when
   *  one ends. A failure is retried at the same size; a hung one is timed
   *  out first. After three tries, that geometry waits for the pane. */
  let resizing = false;
  let tries = 0;
  let failed = "";
  const sync = () => {
    const r = rows;
    const c = cols;
    const want = `${r} ${c}`;
    if (how !== undefined || !pts || resizing || want === applied) return;
    if (want === failed) return;
    resizing = true;
    const flag = MAC ? "-f" : "-F";
    execFile(
      "stty",
      [flag, pts, "rows", `${r}`, "cols", `${c}`],
      { timeout: RESIZE_TIMEOUT_MS },
      (err) => {
        resizing = false;
        if (!err) {
          applied = want;
          tries = 0;
          failed = "";
          sync();
          return;
        }
        if (how !== undefined) return;
        // A frame may have asked for another size while stty ran.
        if (`${rows} ${cols}` !== want) {
          tries = 0;
          sync();
          return;
        }
        tries += 1;
        if (tries >= RESIZE_TRIES) {
          tries = 0;
          failed = want;
          return;
        }
        setTimeout(sync, RESIZE_RETRY_MS).unref();
      },
    );
  };
  // Ubuntu 26.04's uutils `tty` writes the short path without a newline.
  told.once("data", (b: Buffer) => {
    pts = b.toString().trim();
    sync();
  });

  return {
    cwd,
    get ended() {
      return how;
    },
    rows(c, r, cursor) {
      // Cut to the view: a line wider than it is no line to draw.
      if (broken) return [broken.slice(0, Math.max(1, c))];
      try {
        c = Math.max(1, c);
        r = Math.max(1, r);
        if (c !== cols || r !== rows) {
          cols = c;
          rows = r;
          tries = 0;
          failed = "";
          term.resize(cols, rows);
          sync();
        }
        const b = term.buffer.active;
        const at = cursor && b.viewportY === b.baseY ? b.cursorY : -1;
        const out: string[] = [];
        for (let y = 0; y < rows; y++) {
          const line = b.getLine(b.viewportY + y);
          out.push(rowOf(line, cols, cell, y === at ? b.cursorX : -1));
        }
        return out;
      } catch (err) {
        // M1c-7: a bad release of the screen costs this pane, not the chat.
        // The exit says why; until then the pane does.
        broken = `screen failed: ${(err as Error).message}`;
        child.kill();
        return [broken.slice(0, Math.max(1, c))];
      }
    },
    key(data) {
      if (how !== undefined) return;
      term.scrollToBottom();
      let bytes = keyBytes(data, term.modes.applicationCursorKeysMode);
      // pi-tui marks a paste; a shell that did not ask for that gets the text.
      if (!term.modes.bracketedPasteMode) {
        bytes = bytes.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
      }
      stdin.write(bytes);
    },
    scroll(lines) {
      term.scrollLines(lines);
      changed();
    },
    kill,
  };
}
