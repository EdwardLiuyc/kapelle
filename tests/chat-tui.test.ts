/**
 * The full-screen chat (`chat/tui.ts`) on a real terminal through `script(1)`:
 * start and leave, ^C, `/term`, how the transcript draws, and the screen when
 * the daemon goes away or restarts. Navigation, questions and pop-ups have
 * their own `chat-tui-*` files.
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` **and `XDG_STATE_HOME`**, so no
 * test ever meets another test's `daemon.json` or `repos.json` — or the
 * developer's real ones — even while the other files run at the same time.
 * The helpers more than one of these files needs live in
 * `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  addRepo as added,
  alive,
  api,
  bootDaemon as boot,
  chatOnPty,
  gitRepo,
  LEAVE,
  MOCK_AGENT,
  noPty,
  only,
  plainText,
  ptyScreen,
  REMEMBER,
  type RoomReply,
  roomIdle,
  roomToRestart,
  rowOf,
  savedSetup,
  screenRows,
  scrollback,
  tempDir,
  withAgent,
} from "../integration/helpers.ts";

// --- chat rooms (chat MVP) ------------------------------------------------------

test("kapelle alone starts a daemon, opens the chat, and /leave leaves it running", {
  skip: noPty,
}, async (t) => {
  // M9-2: a terminal with no daemon gets one in the background, then the
  // screen. The daemon is in its own session, so the chat's exit is not its.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  // A standalone `kapelle` must not fall through to the single-prompt path,
  // which would start the default harness (pi) beside the chat.
  const bin = await tempDir(t);
  const marker = join(state, "pi-started");
  const fake = join(bin, "pi-acp");
  await writeFile(fake, '#!/bin/sh\nprintf spawned > "$PI_MARKER"\nexit 1\n', {
    mode: 0o755,
  });
  await chmod(fake, 0o755);
  // As every test daemon: a saved find, so the setup list does not open
  // over the screen and take the `/leave` this test types (M9-3).
  savedSetup(state);
  const screen = await ptyScreen(t, "node cli.ts", {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(state, "config-home"),
    KAPELLE_PORT: "0",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    PI_MARKER: marker,
  });
  await new Promise((ok) => setTimeout(ok, 300));
  await assert.rejects(readFile(marker), "bare kapelle started a harness");
  const file = join(runtime, "kapelle", "daemon.json");
  const { pid, port, token } = JSON.parse(await readFile(file, "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  });
  assert.equal(alive(pid), true);
  assert.match(
    await readFile(join(state, "kapelle", "daemon.log"), "utf8"),
    /listening on /,
  );
  // `detached` made the daemon a session leader: the terminal's session is
  // not its own, so closing the terminal cannot hang it up.
  const sid = execFileSync("ps", ["-o", "sid=", "-p", String(pid)])
    .toString()
    .trim();
  assert.equal(sid, String(pid));

  screen.child.stdin.write("/leave\r");
  await screen.seen("left the chat");
  assert.equal(await screen.exited, 0, screen.out());

  // Only the chat ended.
  assert.equal(alive(pid), true);
  const answer = await fetch(`http://127.0.0.1:${port}/version`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(answer.status, 200);
});

test("two kapelle at once leave one daemon, and either key ends only the chat", {
  skip: noPty,
}, async (t) => {
  // The daemon's own lock picks the winner. Both CLIs wait for its record
  // instead of surfacing `another daemon is starting`, and both get a screen.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const env = {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(state, "config-home"),
    KAPELLE_PORT: "0",
  };
  await mkdir(join(state, "kapelle"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(state, "kapelle", "daemon.log"),
    "the previous start\n",
    {
      mode: 0o600,
    },
  );
  savedSetup(state);
  const [a, b] = await Promise.all([
    ptyScreen(t, "node cli.ts", env),
    ptyScreen(t, "node cli.ts", env),
  ]);
  const file = join(runtime, "kapelle", "daemon.json");
  const { pid, port, token } = JSON.parse(await readFile(file, "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  });
  assert.equal(alive(pid), true);
  // Only one daemon ever listened. The loser's refusal is in the same log,
  // or in the one rotation moved aside, and never reached a CLI.
  const logs = await Promise.all(
    [
      join(state, "kapelle", "daemon.log"),
      join(state, "kapelle", "daemon.log.1"),
    ].map((path) => readFile(path, "utf8").catch(() => "")),
  );
  assert.equal(logs.join("").match(/listening on /g)?.length, 1);
  assert.equal(
    await readFile(join(state, "kapelle", "daemon.log.1"), "utf8"),
    "the previous start\n",
    "two starters rotated the log once",
  );

  a.child.stdin.write("/leave\r");
  await a.seen("left the chat");
  assert.equal(await a.exited, 0, a.out());
  // Raw mode turns ^C into a key: only the screen's listener sees it.
  b.child.stdin.write(LEAVE);
  await b.seen("left the chat");
  assert.equal(await b.exited, 0, b.out());

  // One daemon served both chats, and it is still there.
  assert.equal(alive(pid), true);
  const answer = await fetch(`http://127.0.0.1:${port}/version`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(answer.status, 200);
});

test("chat.ts on a real terminal is the full-screen chat, and leaves the conversation in scrollback", {
  skip: noPty,
}, async (t) => {
  const { child, seen, exited, out: screen } = await chatOnPty(t);
  child.stdin.write("alpha\r");
  await seen("previous: (none)");
  child.stdin.write("/leave\r");
  await seen("rejoin with");
  const code = await exited;
  const out = screen();
  assert.equal(code, 0, out);

  const raw = scrollback(out);
  const text = raw.replace(/[ \t]+$/gm, "");
  assert.match(
    text,
    /▎ you → mock-agent\n▎ alpha\n[\s\S]*▎ mock-agent · mock-agent · developer · \d\d:\d\d\n▎ previous: \(none\)\n[\s\S]*left room \S+; rejoin with/,
    "the typed message, the answer, then the exit line",
  );
  // A line as wide as the terminal gets an empty line after it where the
  // terminal wraps at the last column at once: Windows ConPTY, and some
  // multiplexers. The pty is 100 columns wide.
  for (const line of raw.split("\n")) {
    assert.ok(line.length < 100, `a full-width line: ${JSON.stringify(line)}`);
  }
  assert.doesNotMatch(text, /enter to send/, "the status line is not chat");
});

for (const [how, keys] of [
  ["^C twice", LEAVE],
  ["/leave", "/leave\r"],
] as const) {
  test(`chat.ts on a real terminal: ${how} leaves the chat with exit 0`, {
    skip: noPty,
  }, async (t) => {
    // Raw mode turns ^C into a key, not a SIGINT: only the screen's own
    // listener gets the operator out.
    const { child, seen, exited, out } = await chatOnPty(t);
    child.stdin.write(keys);
    await seen("rejoin with");
    assert.equal(await exited, 0, out());
    assert.match(out(), /left room \S+; rejoin with/);
  });
}

test("chat.ts on a real terminal: one ^C only says to press it again, and the tip goes", {
  skip: noPty,
}, async (t) => {
  const { child, seen, exited, out } = await chatOnPty(t);
  const at = out().length;
  child.stdin.write("\x03");
  await seen("press ctrl+c again to leave");
  // The tip runs out after 1.5 s: a ^C after it is a first one again.
  await new Promise((ok) => setTimeout(ok, 2000));
  child.stdin.write("\x03");
  await new Promise((ok) => setTimeout(ok, 300));
  assert.doesNotMatch(out().slice(at), /rejoin with/);
  child.stdin.write("\x03");
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal: a view change takes the ^C tip away, and the next ^C does not leave", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  // The agent's row first: alt+↓ before it is drawn moves nowhere.
  await seen("○ mock-agent");
  await press("\x03", "press ctrl+c again to leave");
  // alt+↓ opens the agent's thread, and a view change clears the status
  // line's message: the tip is gone, so a ^C now is a first one again.
  await press("\x1b[1;3B", "@mock-agent");
  const at = out().length;
  child.stdin.write("\x03");
  await new Promise((ok) => setTimeout(ok, 300));
  assert.doesNotMatch(out().slice(at), /rejoin with/);
  child.stdin.write("\x03");
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal: /term runs a shell in the room's folder that resizes, takes vim, Esc and ^C, and ends with the chat", {
  skip: noPty,
}, async (t) => {
  // M4-13. The pty is 100 columns: the pane takes the timeline's place,
  // beside the 32-column sidebar. sh, so no rc file draws the prompt.
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // The chat's own pty path, so the test can resize its screen.
  const outer = join(runtime, "chat.tty");
  const cmd = `tty > '${outer}'; stty cols 100 rows 30; node chat.ts new --cmd '${REMEMBER}' --cwd '${cwd}'`;
  const { child, press, seen, exited, out } = await ptyScreen(t, cmd, {
    XDG_RUNTIME_DIR: runtime,
    SHELL: "/bin/sh",
  });
  /** The first match of `re` in what is drawn after `from`. */
  const drawn = async (from: number, re: RegExp) => {
    for (const until = Date.now() + 20_000; ; ) {
      const m = plainText(out().slice(from)).match(re);
      if (m) return m;
      assert.ok(Date.now() < until, `never saw ${re}: ${out()}`);
      await new Promise((ok) => setTimeout(ok, 50));
    }
  };
  /** Types `line` into the shell, and reads `re` from what it draws. */
  const run = (line: string, re: RegExp) => {
    const from = out().length;
    child.stdin.write(`${line}\r`);
    return drawn(from, re);
  };
  const size = async () => {
    const m = await run('echo "size=$(stty size)"', /size=(\d+) (\d+)/);
    return { rows: Number(m[1]), cols: Number(m[2]) };
  };

  await press("/term\r", "ctrl+] keys back");
  await run(`[ "$(pwd)" = '${cwd}' ] && echo "here=$((1))"`, /here=1/);
  await run('echo $$ > shell.pid; echo "saved=$((1))"', /saved=1/);
  const before = await size();
  // ctrl+] gives the keys back; ctrl+t hides the sidebar, so the pane widens.
  await press("\x1d", "ctrl+] keys here");
  child.stdin.write("\x14");
  await press("\x1d", "ctrl+] keys back");
  const after = await size();
  assert.equal(after.rows, before.rows);
  assert.equal(
    after.cols,
    before.cols + 30,
    "the sidebar's 32 less the strip's 2",
  );
  // A shorter screen gives the shell fewer rows. The resize reaches the
  // shell after a redraw, so ask until it shows.
  const tty = (await readFile(outer, "utf8")).trim();
  spawnSync("stty", ["-F", tty, "rows", "24", "cols", "100"]);
  for (const until = Date.now() + 20_000; ; ) {
    const s = await size();
    if (s.rows < after.rows) break;
    assert.ok(Date.now() < until, `the shell kept ${s.rows} rows`);
  }

  // ctrl+o, ctrl+r and ctrl+x are the shell's too: read raw, they arrive.
  {
    const from = out().length;
    await run(
      'stty raw -echo; echo "raw=$((1))"; k=$(dd bs=1 count=3 2>/dev/null | od -An -tx1); stty sane; echo "k=$k."',
      /raw=1/,
    );
    child.stdin.write("\x0f\x12\x18");
    await drawn(from, /k= 0f 12 18\./);
  }

  // ^C stops the command, not the chat.
  child.stdin.write("sleep 30\r");
  await new Promise((ok) => setTimeout(ok, 300));
  child.stdin.write("\x03");
  await run('echo "after=$((1+1))"', /after=2/);

  // Esc reaches vim: insert mode ends, and :wq writes the file.
  if (spawnSync("vim", ["--version"]).status === 0) {
    await run("vim -u NONE -N note.txt", /note\.txt/);
    child.stdin.write("ihello from vim");
    await new Promise((ok) => setTimeout(ok, 200));
    child.stdin.write("\x1b");
    await new Promise((ok) => setTimeout(ok, 200));
    // The main screen comes back with the line that started vim: keys
    // typed before that would go to vim.
    await run(":wq", /\$ vim -u NONE -N note\.txt/);
    await run("tr a-z A-Z < note.txt", /HELLO FROM VIM/);
  }

  // Hidden and shown again, it is the same shell, with its screen.
  await run('echo "kept=$((5))"', /kept=5/);
  await press("\x1d", "ctrl+] keys here");
  await press("\x18", "ctrl+x view");
  {
    const from = out().length;
    await press("/term\r", "ctrl+] keys back");
    await drawn(from, /kept=5/);
  }
  await run('[ $$ = "$(cat shell.pid)" ] && echo "same=$((1))"', /same=1/);

  // A failed exit leaves the view, to read why; the next /term starts a
  // new shell.
  await press("exit 3\r", "exited (code 3) · /term starts a new one");
  // An exited shell takes no keys: ctrl+] gives the view its own, and Esc
  // gives them back (PR #286).
  await press("\x1d", "esc keys back");
  await press("\x1b", "ctrl+] view");
  // /term is in the composer's history: ↑ brings it back (PR #286).
  {
    const from = out().length;
    child.stdin.write("\x1b[A");
    await drawn(from, /^ \/term\s*$/m);
  }
  await press("\r", "ctrl+] keys back");
  await run('echo "again=$((2+2))"', /again=4/);
  const pid = Number((await readFile(join(cwd, "shell.pid"), "utf8")).trim());
  await run('echo $$ > shell.pid; echo "saved=$((2))"', /saved=2/);
  const second = Number(
    (await readFile(join(cwd, "shell.pid"), "utf8")).trim(),
  );
  assert.notEqual(second, pid);
  assert.throws(() => process.kill(pid, 0), "the first shell is gone");

  // A clean exit hides the view, as a terminal closes, and the composer
  // has the keys.
  await press("exit\r", "ctrl+x view");
  child.stdin.write("/leave\r");
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
  // The shell ends with the chat.
  for (const until = Date.now() + 5_000; ; ) {
    try {
      process.kill(second, 0);
    } catch {
      break;
    }
    assert.ok(Date.now() < until, "the shell outlived the chat");
    await new Promise((ok) => setTimeout(ok, 50));
  }
});

test("chat.ts on a real terminal keeps the typing box's bottom border, then the where bar on the last row", {
  skip: noPty,
}, async (t) => {
  // The editor used to be allowed to shrink, and pi-tui's shrink takes at
  // least one row from every entry that may: with the sidebar drawn full
  // height, or a long conversation, the box lost its bottom border.
  const { child, exited, out, seen } = await chatOnPty(t);
  // The pty is 30 rows; pi-tui writes a row as CSI row;1H, CSI 2K, text.
  // The pty is 30 rows. pi-tui writes a row as CSI row;1H, CSI 2K, then
  // its text, and ends a frame with CSI ?2026l.
  const rowAt = (n: number) => {
    const last = out().split(`\x1b[${n};1H\x1b[2K`).slice(1).at(-1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
    const end = last?.search(/\x1b\[(\d+;\d+H|\?2026l)/) ?? -1;
    return last && end !== -1 ? last.slice(0, end) : undefined;
  };
  for (const until = Date.now() + 10_000; rowAt(30) === undefined; ) {
    assert.ok(Date.now() < until, `row 30 never drawn: ${out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // Row 30 is the where bar; the timeline view shows the room's cwd.
  assert.match(
    plainText(rowAt(30) ?? ""),
    /\/tmp\//,
    `row 30: ${JSON.stringify(rowAt(30))}`,
  );
  assert.match(rowAt(29) ?? "", /─/, `row 29: ${JSON.stringify(rowAt(29))}`);
  // The box is rows 27-29 and the status line row 26; the row above it
  // stays empty, a gap between the conversation and the hint.
  assert.match(plainText(rowAt(26) ?? ""), /enter to send/);
  const gap = plainText(rowAt(25) ?? "?");
  assert.equal(gap.trim(), "", `row 25: ${JSON.stringify(rowAt(25))}`);
  // The status line names the target once the roster arrives, not its id.
  await seen("→ mock-agent");
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal draws an agent's tool calls under its name, and names it once per answer", {
  skip: noPty,
}, async (t) => {
  // The default mock turn: text, a tool call, text, a tool call, text.
  const { child, exited, out } = await chatOnPty(t, `node ${MOCK_AGENT}`);
  child.stdin.write("go\r");
  // The turn's last text; colour codes can split it in the raw output.
  for (const until = Date.now() + 20_000; ; ) {
    if (plainText(out()).includes("</task-result>")) break;
    assert.ok(Date.now() < until, `the turn never finished: ${out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
  const lines = scrollback(out())
    .split("\n")
    .map((l) => l.trim());
  // Each of an agent's lines has its bar, and its heading its harness,
  // role and time (M7-1).
  const isHeading = (l: string) => l.startsWith("▎ mock-agent · ");
  const you = lines.indexOf("▎ you → mock-agent");
  const heading = lines.findIndex(isHeading);
  // The next text folds the call into its run's line (M7-2).
  const tool = lines.indexOf("▎ ▸ 1 tool call · 1 read");
  assert.ok(you !== -1 && you < heading && heading < tool, lines.join("\n"));
  assert.equal(lines.filter(isHeading).length, 1, lines.join("\n"));
});

// --- room commands (M4-5) -----------------------------------------------------

test("with no room open, the screen exits when the daemon is gone, and says how to start again", {
  skip: noPty,
  // The screen waits 30 s for the daemon to come back (M6-7d).
  timeout: 60_000,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  process.kill(d.pid, "SIGKILL");
  // The room list is read every 5 s; one that fails 30 s after the first
  // failure ends it (M6-7d). `seen` gives up after 20 s, so wait for the exit.
  assert.equal(await screen.exited, 1, screen.out());
  assert.match(plainText(screen.out()), /the daemon stopped/);
  assert.match(plainText(screen.out()), /kapelle daemon start/);
});

// --- a room across a restart (M6-7a, #151) ----------------------------------

test("the TUI rides out a restart: it says so, marks the participant paused, and a message is answered", {
  skip: noPty,
  // The screen waits 30 s for the daemon to come back (M6-7d).
  timeout: 60_000,
}, async (t) => {
  const { first, id, again, runtime, alice } = await roomToRestart(t, REMEMBER);
  // The sidebar is narrow: a short name leaves room for its `paused`.
  const renamed = await api(first, "PATCH", `/rooms/${id}/agents/${alice.id}`, {
    name: "al",
  });
  assert.equal(renamed.status, 200);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${id}`,
    { XDG_RUNTIME_DIR: runtime },
    "○ al",
  );
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = await again();
  // Wait beyond the helper's 20 s default; the daemon gets 30 s (M6-7d).
  await screen.seen("the daemon restarted", 30_000);
  await screen.seen("‖ al");
  await screen.press("hi\r", "previous: (none)");
  await roomIdle(second, id);
  await screen.press(LEAVE, "rejoin with");
  assert.equal(await screen.exited, 0, plainText(screen.out()));
});

// The test drives a whole pty session: its call count is the test.
// pi-lens-ignore: high-fan-out
test("chat.ts on a real terminal folds a tool run at the next note without moving the rows in view, and a click opens and folds it (M7-2)", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario runs`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const ann = only(open.body);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  // The note, then the live run: open, and waiting for runs.go.
  await screen.press("go\r", "Edit f5.ts");
  // A long message waits behind the turn: rows below the run.
  const lines = Array.from({ length: 40 }, (_, i) => `q${i + 10}`);
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${ann.id}/messages`,
    { text: lines.join("\n") },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("q49");
  // The person scrolls up a little, to read the message. The run is above.
  await screen.press("\x1b[<64;50;10M", "q3");
  await wait(300);
  // The row can end with the scrollbar for a second after a scroll (M7-6).
  const q30 = /│ q30\s*[│┃]?$/;
  const before = rowOf(screen.out(), q30);
  assert.ok(before > 0, `q30 in view: ${screen.out()}`);
  assert.equal(rowOf(screen.out(), /Read f0\.ts/), 0, "the run is above");
  // The next note folds the run, above the view.
  await writeFile(join(ann.worktree, "runs.go"), "");
  await roomIdle(d, open.body.id);
  await wait(300);
  assert.equal(rowOf(screen.out(), q30), before, "the row in view moved");
  // Up to the top: the run is one line. A click opens it, a second folds it.
  for (let i = 0; i < 20; i++) screen.child.stdin.write("\x1b[<64;50;10M");
  for (const until = Date.now() + 10_000; ; ) {
    if (rowOf(screen.out(), /▸ 6 tool calls · 5 read · 1 edit/)) break;
    assert.ok(Date.now() < until, `no folded run: ${screen.out()}`);
    await wait(50);
  }
  const row = rowOf(screen.out(), /▸ 6 tool calls/);
  await screen.press(`\x1b[<0;50;${row}M\x1b[<0;50;${row}m`, "Read f0.ts");
  assert.equal(rowOf(screen.out(), /▾ 6 tool calls/), row);
  // Past pi-tui's 500 ms: a second click sooner is a double click, which
  // selects a word.
  await wait(600);
  await screen.press(`\x1b[<0;50;${row}M\x1b[<0;50;${row}m`, "▸ 6 tool calls");
  assert.equal(rowOf(screen.out(), /Read f0\.ts/), 0, "folded again");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal paints the transcript's scrollbar over its last column on a page key (M7-6)", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario long`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const sent = await api(d, "POST", `/rooms/${open.body.id}/messages`, {
    text: "go",
  });
  assert.equal(sent.status, 202);
  await roomIdle(d, open.body.id);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
    "xxxxxxxxxx",
  );
  const rows = () => [...screenRows(screen.out()).values()];
  /** A thumb in the last column; the pop-up's border is `┃` too. */
  const thumb = () => rows().some((r) => r.endsWith("┃"));
  /** Where a row of the answer ends, or -1. */
  const answerEnd = (r: string) => {
    const m = /x{10,}/.exec(r);
    return m ? m.index + m[0].length - 1 : -1;
  };

  // The bar hides once nothing scrolls; an `always` bar never would. A bar
  // that shows at the start and then hides passes: that is `auto`.
  for (const until = Date.now() + 10_000; thumb(); ) {
    assert.ok(Date.now() < until, `a bar with no scroll: ${screen.out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  const last = Math.max(...rows().map(answerEnd));
  const pageFrom = screen.out().length;
  await screen.press("\x1b[5~", "┃");
  assert.ok(
    screen.out().slice(pageFrom).includes("\x1b[7m┃"),
    "the resting thumb is inverse",
  );
  // With no side view open, the timeline's last column is the screen's. A
  // row's index is its column only because the answer is plain ASCII.
  // The bar hides 1 s after the scroll: a slow read finds none, and an empty
  // loop would check nothing.
  const bar = rows().filter((r) => r.includes("┃"));
  assert.ok(bar.length > 0, `the bar went away: ${screen.out()}`);
  for (const r of bar) {
    assert.equal(r.indexOf("┃"), 99, `not the last column:\n${r}`);
    assert.equal(answerEnd(r), last, `the answer rewrapped:\n${r}`);
  }
  // A hover draws the thumb as a full block. It must stay visible: an
  // inverse block is the background colour.
  const row = rowOf(screen.out(), /┃$/);
  const from = screen.out().length;
  await screen.press(`\x1b[<35;100;${row}M`, "█");
  assert.ok(!screen.out().slice(from).includes("\x1b[7m█"), "an inverse block");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});
