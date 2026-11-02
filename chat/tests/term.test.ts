/**
 * The person's shell — `chat/tui/term.ts`, story M4-13 (#249): a key from
 * pi-tui as a shell's bytes, and a row of cells as text. The shell itself is
 * driven on a pty in `tests/chat-tui.test.ts`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import xterm from "@xterm/headless";
import { keyBytes, rowOf, type Shell, startShell } from "../tui/term.ts";

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

test("an encoded key with no legacy form is dropped, not sent raw (PR #286)", () => {
  // Raw, `\x1b[46;5u` is Esc then text: in vim, leave insert mode and run it.
  assert.equal(keyBytes("\x1b[46;5u", false), "", "ctrl+.");
  assert.equal(keyBytes("\x1b[57428u", false), "", "the menu key");
  // An F-key with an event type has a legacy form, so it is not dropped,
  // though pi-tui names none of these three.
  assert.equal(keyBytes("\x1b[1;1:2P", false), "\x1bOP", "a repeated F1");
  assert.equal(keyBytes("\x1b[15;1:2~", false), "\x1b[15~", "a repeated F5");
  assert.equal(keyBytes("\x1b[15;5:2~", false), "\x1b[15;5~", "ctrl+F5");
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

const noScript =
  process.platform !== "linux" || spawnSync("script", ["--version"]).status
    ? "needs util-linux script(1)"
    : false;

/** A shell in a temp folder, and the reason it ended once it did. */
async function shellIn(
  t: test.TestContext,
  size = { cols: 40, rows: 5 },
  env: Record<string, string> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "term-"));
  const saved = { ...process.env };
  Object.assign(process.env, { SHELL: "/bin/sh", ...env });
  let how: string | undefined;
  const shell: Shell = startShell(
    dir,
    size,
    () => {},
    (h) => {
      how = h;
    },
  );
  process.env = saved;
  t.after(async () => {
    shell.kill();
    await rm(dir, { recursive: true, force: true });
  });
  const ended = async () => {
    for (const until = Date.now() + 5000; how === undefined; ) {
      assert.ok(Date.now() < until, "the shell never ended");
      await new Promise((ok) => setTimeout(ok, 20));
    }
    return how;
  };
  return { dir, shell, ended };
}

/** The shell's screen as plain text, once it shows `text`. */
async function shows(shell: Shell, text: string) {
  for (const until = Date.now() + 5000; ; ) {
    const plain = shell
      .rows(40, 5, false)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR is the subject.
      .map((l) => l.replace(/\x1b\[[\d;]*m/g, "").trimEnd())
      .join("\n");
    if (plain.includes(text)) return plain;
    assert.ok(Date.now() < until, `never showed ${text}: ${plain}`);
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

/** Whether `path` exists. */
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Waits for `ready`, failing with `why` at the deadline. */
async function waitFor(
  ready: () => boolean | Promise<boolean>,
  why: string,
  ms = 5000,
) {
  for (const until = Date.now() + ms; ; ) {
    if (await ready()) return;
    assert.ok(Date.now() < until, why);
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

/** Non-empty lines in `path`; zero until the file exists. */
async function countLines(path: string) {
  try {
    const text = await readFile(path, "utf8");
    return text ? text.trimEnd().split("\n").length : 0;
  } catch {
    return 0;
  }
}

/** The pty's reported size, once `shell` shows it. */
async function showsPtySize(shell: Shell, cols: number, size: string) {
  shell.key('echo "size=$(stty size)"\r');
  await waitFor(
    () => shell.rows(cols, 5, false).join("\n").includes(`size=${size}`),
    `the pty never reported ${size}`,
  );
}

/**
 * A `stty` on `PATH`: external `-F` calls run `external`, while the shell's
 * own calls reach the real one. PATH must stay changed until after
 * `startShell`, so this cannot use `shellIn`'s temporary `env`.
 */
async function fakeStty(
  t: test.TestContext,
  external: (p: { bin: string; real: string }) => string,
) {
  const bin = await mkdtemp(join(tmpdir(), "bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const real = spawnSync("sh", ["-c", "command -v stty"], {
    encoding: "utf8",
  }).stdout.trim();
  assert.ok(real, "stty is installed");
  await writeFile(
    join(bin, "stty"),
    `#!/bin/sh
case " $* " in
  *" -F "*) ${external({ bin, real })}
    ;;
esac
exec '${real}' "$@"
`,
  );
  await chmod(join(bin, "stty"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return bin;
}

test("a start size under one is one, so stty takes it (PR #286)", {
  skip: noScript,
}, async (t) => {
  const { shell } = await shellIn(t, { cols: -1, rows: -1 });
  shell.key("echo ok=$((1))\r");
  const screen = await shows(shell, "ok=1");
  assert.doesNotMatch(screen, /invalid/);
});

test("a throw while drawing ends the shell, not the chat (PR #286)", {
  skip: noScript,
}, async (t) => {
  const { shell, ended } = await shellIn(t);
  await shows(shell, "$");
  const resize = xterm.Terminal.prototype.resize;
  xterm.Terminal.prototype.resize = () => {
    throw new Error("a bad release");
  };
  t.after(() => {
    xterm.Terminal.prototype.resize = resize;
  });
  assert.deepEqual(shell.rows(60, 5, false), ["screen failed: a bad release"]);
  assert.equal(await ended(), "screen failed: a bad release");
});

test("a script that refuses to start says why (PR #286)", async (t) => {
  // A script(1) that takes none of our flags, as busybox's might not.
  const bin = await mkdtemp(join(tmpdir(), "bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(
    join(bin, "script"),
    // An escape on its stderr is drawn in the pane's title: made printable.
    "#!/bin/sh\nprintf 'script: \\033[2Jinvalid option -- q\\n' >&2\nexit 1\n",
  );
  await chmod(join(bin, "script"), 0o755);
  const { ended } = await shellIn(t, undefined, {
    PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(
    await ended(),
    "exited (code 1): script:  [2Jinvalid option -- q",
  );
});

test("a failed stty resize is retried at the same size (#423)", {
  skip: noScript,
}, async (t) => {
  const bin = await fakeStty(
    t,
    ({ bin: dir, real }) => `
if [ ! -e '${dir}/failed' ]; then
  : > '${dir}/failed'
  exit 1
fi
'${real}' "$@" || exit $?
: > '${dir}/resized'
exit 0
`,
  );
  const { shell } = await shellIn(t);
  await shows(shell, "$");
  shell.rows(35, 5, false);
  await waitFor(() => exists(join(bin, "resized")), "stty was not retried");
  await showsPtySize(shell, 35, "5 35");
});

test("a hung stty resize is timed out and retried (#423 review)", {
  skip: noScript,
}, async (t) => {
  const bin = await fakeStty(
    t,
    ({ bin: dir, real }) => `
if [ ! -e '${dir}/hung' ]; then
  : > '${dir}/hung'
  exec sleep 7
fi
'${real}' "$@" || exit $?
: > '${dir}/resized'
exit 0
`,
  );
  const { shell } = await shellIn(t);
  await shows(shell, "$");
  shell.rows(35, 5, false);
  await waitFor(
    () => exists(join(bin, "resized")),
    "stty was not retried after hanging",
  );
  await showsPtySize(shell, 35, "5 35");
});

test("a failed resize stops after three stty tries (#423 review)", {
  skip: noScript,
}, async (t) => {
  const bin = await fakeStty(
    t,
    ({ bin: dir }) => `
printf 'x\\n' >> '${dir}/calls'
exit 1
`,
  );
  const calls = join(bin, "calls");
  const { shell } = await shellIn(t);
  await shows(shell, "$");
  shell.rows(35, 5, false);
  await waitFor(
    async () => (await countLines(calls)) >= 3,
    "stty was not tried three times",
  );
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(await countLines(calls), 3);
  await showsPtySize(shell, 40, "5 40");
});

test("a failed older size keeps the newer size's retries (#423 review)", {
  skip: noScript,
}, async (t) => {
  const bin = await fakeStty(
    t,
    ({ bin: dir, real }) => `
printf 'x\\n' >> '${dir}/calls'
calls=$(wc -l < '${dir}/calls')
if [ "$calls" -le 4 ]; then
  sleep 0.1
  exit 1
fi
'${real}' "$@" || exit $?
: > '${dir}/resized'
exit 0
`,
  );
  const calls = join(bin, "calls");
  const { shell } = await shellIn(t);
  await shows(shell, "$");
  shell.rows(30, 5, false);
  await waitFor(
    async () => (await countLines(calls)) >= 2,
    "the first size did not reach its retry",
  );
  shell.rows(35, 5, false);
  await waitFor(
    () => exists(join(bin, "resized")),
    "the newer size lost its retries",
  );
  await showsPtySize(shell, 35, "5 35");
});

test("after a burst of resizes the pty has the last size (PR #286)", {
  skip: noScript,
}, async (t) => {
  const { shell } = await shellIn(t);
  await shows(shell, "$");
  // One stty runs at a time; the sizes asked meanwhile end in the last one.
  for (const cols of [30, 31, 32, 33, 34, 35]) shell.rows(cols, 5, false);
  // Ask again until the shell reports the last size: one stty may still be
  // running, and a single early answer would stay wrong on screen.
  for (const until = Date.now() + 5000; ; ) {
    shell.key('echo "size=$(stty size)"\r');
    for (const next = Date.now() + 100; Date.now() < next; ) {
      const screen = shell.rows(35, 5, false).join("\n");
      if (screen.includes("size=5 35")) return;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    assert.ok(Date.now() < until, "the pty never reported 5 35");
  }
});
