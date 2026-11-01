/**
 * Moving around the full-screen chat on a real terminal through `script(1)`:
 * rooms and threads, `@name` pre-fills, the sidebar, the history list, the
 * mouse and the page keys.
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` **and `XDG_STATE_HOME`**, so no
 * test ever meets another test's `daemon.json` or `repos.json` — or the
 * developer's real ones — even while the other files run at the same time.
 * The helpers more than one of these files needs live in
 * `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ParticipantDto } from "../client/contract.ts";
import {
  addRepo as added,
  api,
  bootDaemon as boot,
  chatOnPty,
  gitRepo,
  LEAVE,
  noPty,
  only,
  plainText,
  ptyScreen,
  REMEMBER,
  type RoomReply,
  roomLog,
  screenRows,
  scrollback,
  tempDir,
  until,
  withAgent,
} from "../integration/helpers.ts";

// --- chat rooms (chat MVP) ------------------------------------------------------

test("chat.ts on a real terminal follows a second room off screen, switches to its thread, and @name pre-filled reaches it", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out, d, cwd } = await chatOnPty(t);
  const b = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "bob" }],
  });
  assert.equal(b.status, 201, b.body.error?.message);
  // The sidebar polls `GET /rooms` every 5 s.
  await seen("○ bob");
  const bob = b.body.participants[0]?.id as string;
  const sent = await api(
    d,
    "POST",
    `/rooms/${b.body.id}/agents/${bob}/messages`,
    {
      text: "hello-b",
    },
  );
  assert.equal(sent.status, 202);
  // Answered while the first room is on screen: its row marks it, and the
  // count is the answer and the turn end nobody has seen.
  for (const until = Date.now() + 20_000; ; ) {
    const row = plainText(out())
      .split("\n")
      .find((l) => /● bob .*\s2 │/.test(l));
    if (row) break;
    assert.ok(Date.now() < until, `bob's unread row never came: ${out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // Rows: room A, its agent, room B, bob. `alt+down` and two `ctrl+n`s open
  // bob's thread.
  await press("\x1b[1;3B\x0e\x0e", "→ bob");
  await seen("previous: (none)");
  // The where bar follows the view: bob's thread names its branch too. The
  // 100-column pty cuts it after the branch's first letter.
  await seen(" · k");
  // The composer holds "@bob "; no orchestrator is needed for it.
  child.stdin.write("again\r");
  await seen("previous: hello-b");
  // After a send, the thread's @name is back: "more" reaches bob too, though
  // room B has no orchestrator to take a message with no mention.
  child.stdin.write("more\r");
  await seen("previous: again");
  // Deleted by hand, it comes back as well: the restore is synchronous, so
  // `last` can follow the deletes without waiting for a frame.
  child.stdin.write(`${"\x7f".repeat(5)}last\r`);
  await seen("previous: more");
  // An untouched pre-fill follows the view. `alt+up` and `ctrl+p` go back to
  // room A's agent, so the target is it, not bob.
  await press("\x1b[1;3A\x10", "→ mock-agent");
  // A left click on the first row (SGR mouse, 1-based) opens room A's
  // timeline, whose header names the room.
  await press("\x1b[<0;4;2M\x1b[<0;4;2m", "room room-");
  // ctrl+t hides the sidebar; the strip that stands in for it is drawn.
  await press("\x14", "»");
  child.stdin.write("/leave\r");
  await seen("left room");
  assert.equal(await exited, 0, out());
});

test("chat.ts keeps the old room's draft out of the new room's undo history (#355)", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out, d, cwd } = await chatOnPty(t);
  const b = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "bob" }],
  });
  assert.equal(b.status, 201, b.body.error?.message);
  await seen("○ bob");
  await press("alpha-away", "alpha-away");
  // Room A timeline -> its agent -> room B timeline.
  await press("\x1b[1;3B\x1b[1;3B", "→ bob");
  // Ctrl+- then ctrl+o makes a frame even if undo changes nothing.
  await press("\x1f\x0f", "new room …");
  assert.equal(
    [...screenRows(out()).values()].some((row) => row.includes("alpha-away")),
    false,
    "the new room's screen still shows the old room's draft",
  );
  child.stdin.write(LEAVE);
  assert.equal(await exited, 0, out());
});

test("chat.ts brings a pasted draft back with its text, not its marker (#355)", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out, d, cwd } = await chatOnPty(t);
  const [a] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const b = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "bob" }],
  });
  assert.equal(b.status, 201, b.body.error?.message);
  assert.ok(a);
  await seen("○ bob");

  const pasted = Array.from({ length: 12 }, (_, i) => `paste line ${i}`).join(
    "\n",
  );
  child.stdin.write(`\x1b[200~${pasted}\x1b[201~`);
  await seen("[paste #1 +12 lines]");

  // A timeline -> A agent -> B timeline -> B agent.
  await press("\x1b[1;3B\x1b[1;3B", "→ bob");
  // Back to A's timeline.
  await press("\x1b[1;3A\x1b[1;3A", "→ mock-agent");
  child.stdin.write("\r");
  await seen("previous: (none)");
  await until(
    "the full pasted text is the room's user message",
    async () =>
      (await roomLog(cwd, a.id)).some(
        (line) =>
          line.update.sessionUpdate === "_client_user_message" &&
          line.update.text === pasted,
      ),
    5_000,
  );
  child.stdin.write(LEAVE);
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal lists the messages on ctrl+r, lights the row under the mouse, and a pick jumps", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // 130 columns: the side view sits beside the timeline, from column 79.
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts new --cmd '${REMEMBER}' --cwd '${cwd}'`,
    { XDG_RUNTIME_DIR: runtime },
  );
  screen.child.stdin.write("alpha\r");
  await screen.seen("previous: (none)");
  screen.child.stdin.write("beta\r");
  await screen.seen("previous: alpha");
  await screen.press("\x12", "history · 1 of 2");
  // A row names both ends, so the person's own reads `you → ` (#362).
  await screen.seen("you → mock-agent: alpha");
  await screen.press("\x1b[B", "history · 2 of 2");
  // A move with no button over the first row lights it.
  await screen.press("\x1b[<35;90;2M", "history · 1 of 2");
  await screen.press("\x1b[<0;90;3M\x1b[<0;90;3m", "history · 2 of 2");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal lists an orchestrator's order on ctrl+r, and not the reply it got back", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "po", role: "orchestrator" },
      { cmd: REMEMBER, name: "ana" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const po = open.body.participants[0]?.id as string;
  const ana = open.body.participants[1]?.id as string;
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  // The person's own message, with no mention, goes to the orchestrator.
  screen.child.stdin.write("ask ana to fix the login bug\r");
  await screen.seen("previous: (none)");
  // po's order to ana. The daemon replies to po when ana's turn ends, so
  // the room holds one order and one reply.
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${ana}/messages`,
    {
      text: "fix the login bug",
      from: po,
    },
  );
  assert.equal(sent.status, 202, screen.out());
  await screen.seen("[reply from ana]");
  // Two rows, not three: the reply the daemon wrote is left out.
  await screen.press("\x12", "history · 1 of 2");
  await screen.seen("you → po: ask ana to fix the login bug");
  await screen.seen("po → ana: fix the login bug");
  assert.ok(
    !plainText(screen.out()).includes("ana → po: [reply"),
    `the reply is not a history row: ${screen.out()}`,
  );
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal draws an orchestrator's order into its open thread and history", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "po", role: "orchestrator" },
      { cmd: REMEMBER, name: "ana" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const po = open.body.participants[0]?.id as string;
  const ana = open.body.participants[1]?.id as string;
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  // Rows: the room, po, ana. Wait for the roster, then open po's thread.
  await screen.seen("○ po");
  await screen.seen("○ ana");
  await screen.press("\x1b[1;3B", "po (mock-agent)");
  const from = screen.out().length;
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${ana}/messages`,
    { text: "fix the login bug", from: po },
  );
  assert.equal(sent.status, 202, screen.out());
  // The reply is an incoming line in po's thread. Its arrival proves the
  // outgoing order's line was handled while the thread stayed open.
  await screen.seen("[reply from ana]");
  const threadText = plainText(screen.out().slice(from));
  assert.match(
    threadText,
    /po → ana/,
    `the order was not drawn: ${threadText}`,
  );
  assert.match(
    threadText,
    /fix the login bug/,
    `the order had no text: ${threadText}`,
  );
  // The history reads the same entry, so it can jump to the drawn line.
  await screen.press("\x12", "history · 1 of 1");
  await screen.seen("po → ana: fix the login bug");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

/**
 * A room with 15 messages sent, attached on a pseudo-terminal 16 rows high,
 * so the history list shows fewer rows than it has. At 120 columns and more
 * the side view sits beside the timeline; below, it takes its place.
 */
async function fifteenSent(t: TestContext, cols: number) {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols ${cols} rows 16; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  const path = `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`;
  const send = async (text: string) => {
    const sent = await api(d, "POST", path, { text });
    assert.equal(sent.status, 202, sent.body.error?.message);
  };
  for (let i = 1; i <= 15; i++) await send(`m${i}`);
  await screen.seen("previous: m14");
  return { ...screen, send };
}

test("chat.ts on a real terminal clicks a history-rail mark and moves the active mark", {
  skip: noPty,
}, async (t) => {
  const screen = await fifteenSent(t, 130);
  await screen.seen("▲");
  await screen.seen("▼");
  // The rail is pinned to the tail. Count its pips to know which message is
  // the first mark, one row below the up chevron.
  const marks = [...screenRows(screen.out()).values()].filter((row) =>
    row.trimEnd().endsWith("●"),
  ).length;
  assert.ok(marks > 0 && marks < 15, `the rail has a window: ${marks}`);
  const first = 15 - marks + 1;
  const from = screen.out().length;
  // At 130 columns the sidebar is shown, and the rail is the last two cells
  // of the row. Row 2 is its first mark.
  await screen.press("\x1b[<0;130;2M\x1b[<0;130;2m", `m${first}`);
  const drawn = screen.out().slice(from);
  const rows = screenRows(screen.out());
  const row = [...rows].find(([, text]) => text.includes(`▎ m${first}`))?.[0];
  assert.ok(
    row !== undefined && row <= 2,
    `the message reached the top: ${row}`,
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  assert.match(drawn, /\x1b\[7m●/, "the active mark was redrawn");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

/**
 * Writes `keys`, and waits for the history title to name a row other than
 * `was` in what is drawn after them. Checks that the lit row is the one the
 * title names, and returns it.
 */
async function lightMoves(
  screen: Awaited<ReturnType<typeof ptyScreen>>,
  keys: string,
  of: number,
  was: number,
): Promise<number> {
  const from = screen.out().length;
  screen.child.stdin.write(keys);
  // Every title drawn, not the first: a repaint at a turn's end can draw
  // the title with `was` before the keys act.
  const title = new RegExp(`history · (\\d+) of ${of}`, "g");
  for (const until = Date.now() + 10_000; ; ) {
    const drawn = screen.out().slice(from);
    const at = [...plainText(drawn).matchAll(title)]
      .map((m) => Number(m[1]))
      .find((n) => n !== was);
    if (at !== undefined) {
      assert.match(drawn, new RegExp(`\\x1b\\[7myou → mock-agent: m${at} `));
      return at;
    }
    assert.ok(Date.now() < until, drawn);
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

test("chat.ts on a real terminal maps the mouse to the right row of a history list that scrolled", {
  skip: noPty,
}, async (t) => {
  const screen = await fifteenSent(t, 130);
  await screen.press("\x12", "history · 1 of 15");
  // A key's release is not a second press. A terminal with the kitty
  // keyboard protocol sends both.
  await screen.press("\x1b[6;1:3~\x1b[B", "history · 2 of 15");
  // To the end: the list scrolls. Page Down reaches the list, not only
  // the timeline (#228).
  await screen.press("\x1b[6~".repeat(14), "history · 15 of 15");
  // The mouse on the list's top row, row 2 of the screen, is not message 1.
  const n = await lightMoves(screen, "\x1b[<35;90;2M", 15, 15);
  assert.ok(n > 1, `the top row is message ${n}`);
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal keeps the wheel over the side view out of the timeline, and the page keys with the composer", {
  skip: noPty,
}, async (t) => {
  const { send, ...screen } = await fifteenSent(t, 130);
  // Ten wheel turns up over the side view, at column 90.
  const wheelUp = "\x1b[<64;90;5M".repeat(10);
  // An empty view, then a list at its top: the wheel stops there. A
  // timeline it moved would stop following, and draw no new answer.
  await screen.press("\x18", "nothing here yet");
  screen.child.stdin.write(wheelUp);
  await send("m16");
  await screen.seen("previous: m15");
  await screen.press("\x12", "history · 1 of 16");
  screen.child.stdin.write(wheelUp);
  await send("m17");
  await screen.seen("previous: m16");
  // The wheel down scrolls the list, and the light stays on a row in view.
  await lightMoves(screen, "\x1b[<65;90;5M".repeat(10), 17, 1);
  // With the keys at the composer, the page keys scroll the timeline: up
  // to the notice on its first lines, and down to its end, where it
  // follows again.
  await screen.press("\x1d", "ctrl+] keys here");
  await screen.press("\x1b[5~".repeat(50), "no measured labels");
  await screen.press("\x1b[6~".repeat(50), "previous: m16");
  await send("m18");
  await screen.seen("previous: m17");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a narrow real terminal sends the page keys with the composer to the side view in the timeline's place", {
  skip: noPty,
}, async (t) => {
  const screen = await fifteenSent(t, 100);
  await screen.press("\x12", "history · 1 of 15");
  await screen.press("\x1d", "ctrl+] keys here");
  // A page is the view's height less one row. That height moves with the
  // rows under the composer, so the test asks only that the light left row 1.
  await lightMoves(screen, "\x1b[6~", 15, 1);
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal completes a leading @ to a participant's name", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out } = await chatOnPty(t);
  await press("@", "@mock-agent");
  // Tab takes the name; the message then reaches that participant.
  await press("\t", "→ mock-agent");
  child.stdin.write("hi\r");
  await seen("previous: (none)");
  child.stdin.write("/leave\r");
  await seen("left room");
  assert.equal(await exited, 0, out());
});

test("chat.ts attach on a real terminal opens the room it names, not the first", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const ids: string[] = [];
  for (const _ of [1, 2]) {
    const r = await api<RoomReply>(
      d,
      "POST",
      "/rooms",
      withAgent(cwd, REMEMBER),
    );
    assert.equal(r.status, 201, r.body.error?.message);
    ids.push(r.body.id);
  }
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${ids[1]}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.seen(`room ${ids[1]} ·`);
  screen.child.stdin.write("/leave\r");
  await screen.seen(`left room ${ids[1]}`);
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal moves an untouched thread @name to a new name", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("\x1b[1;3B", "@mock-agent");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const agent = room?.participants[0]?.id as string;
  const renamed = await api(d, "PATCH", `/rooms/${room?.id}/agents/${agent}`, {
    name: "bob",
  });
  assert.equal(renamed.status, 200, renamed.body.error?.message);
  await seen("→ bob");
  child.stdin.write("hi\r");
  await seen("previous: (none)");
  child.stdin.write(LEAVE);
  assert.equal(await exited, 0, out());
});

test("kapelle chat opens the first room, and below 76 columns the sidebar starts hidden", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);

  const screen = await ptyScreen(t, "stty cols 60 rows 30; node cli.ts chat", {
    XDG_RUNTIME_DIR: runtime,
  });
  // Without a verb, the first active room's timeline is the landing view.
  await screen.seen(`room ${open.body.id}`);
  // Below 76 columns there is no sidebar, only the strip that opens it.
  assert.ok(screen.out().includes("»"), "the strip is hidden");
  assert.ok(!screen.out().includes("«"), "the sidebar header is hidden");
  // ctrl+t shows it, with the roster; ctrl+t hides it again.
  await screen.press("\x14", "«");
  await screen.seen("○ mock-agent");
  await screen.press("\x14", "»");
  // The timeline's composer is empty, so /leave is a command.
  screen.child.stdin.write("/leave\r");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal hides the sidebar with a click on «, and shows it with a click on »", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  // SGR mouse, 1-based: the « sits at the end of the sidebar's first row.
  await press("\x1b[<0;30;1M\x1b[<0;30;1m", "»");
  await press("\x1b[<0;1;1M\x1b[<0;1;1m", "rooms");
  child.stdin.write(LEAVE);
  await seen("left room");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal keeps a thread's @name whole after Enter on it alone", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("\x1b[1;3B", "@mock-agent");
  await press("\r", "nothing to send");
  // The editor trims what it submits. Giving back "@mock-agent" with no
  // space would make this "@mock-agentx", a name nobody has.
  await press("x\r", "previous: (none)");
  child.stdin.write(LEAVE);
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal gives a bare @name back with its space on the timeline too", {
  skip: noPty,
}, async (t) => {
  const { child, press, exited, out } = await chatOnPty(t);
  // The timeline pre-fills nothing: the person typed this mention.
  await press("@mock-agent \r", "nothing to send");
  // The editor trims what it submits; without the space back, this would
  // be "@mock-agentx".
  await press("x\r", "previous: (none)");
  child.stdin.write(LEAVE);
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal takes /dismiss after a thread's @name", {
  skip: noPty,
}, async (t) => {
  // In a thread the composer always holds `@name `, so a command typed there
  // is `@name /dismiss`. It must act, not reach the agent as a prompt.
  const { press, seen, exited, out } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("\x1b[1;3B", "@mock-agent");
  // The last room gone, the screen stays, empty, until ^C (M4-5).
  await press("/dismiss\r", "ctrl+o → new room");
  await press(LEAVE, "left the chat");
  assert.equal(await exited, 0, out());
  assert.doesNotMatch(plainText(out()), /you → mock-agent/);
});

test("chat.ts on a real terminal falls back to the timeline when the open thread's participant is removed", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const bob = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room?.id}/agents`,
    {
      cmd: REMEMBER,
      name: "bob",
    },
  );
  assert.equal(bob.status, 201);
  await seen("○ bob");
  // Rows: the room, mock-agent, bob. Two steps down open bob's thread.
  await press("\x1b[1;3B\x1b[1;3B", "@bob");
  // Looked for from before the DELETE: the screen may switch before the
  // daemon's reply arrives.
  const from = out().length;
  const gone = await api(
    d,
    "DELETE",
    `/rooms/${room?.id}/agents/${bob.body.id}`,
  );
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  // The timeline's header names the room, and its target is the orchestrator.
  for (const until = Date.now() + 20_000; ; ) {
    if (out().slice(from).includes("room room-")) break;
    assert.ok(Date.now() < until, `still in bob's thread: ${out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  await press("hi\r", "previous: (none)");
  child.stdin.write(LEAVE);
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal shows the checkout of a participant added after it started", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const carol = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room?.id}/agents`,
    { cmd: REMEMBER, name: "carol" },
  );
  assert.equal(carol.status, 201);
  await seen("○ carol");
  // The thread header names the checkout, from `GET /rooms/:id`; the path
  // itself wraps, so the " · " before it is what shows it was read.
  await press("\x1b[1;3B\x1b[1;3B", "carol (mock-agent) · ");
  child.stdin.write(LEAVE);
  assert.equal(await exited, 0, out());
});

test("chat.ts on a terminal under 8 columns shows the sidebar without failing", {
  skip: noPty,
}, async (t) => {
  // pi-tui measures each part at the full width first, so the sidebar is
  // drawn at 7 columns once, though its own width is 32.
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const screen = await ptyScreen(
    t,
    `stty cols 7 rows 30; node chat.ts new --cmd '${REMEMBER}' --cwd '${cwd}'`,
    { XDG_RUNTIME_DIR: runtime },
    "»",
  );
  // Only the sidebar's first 7 columns fit: `── room` of its header, the
  // title cyan.
  await screen.press("\x14", "\x1b[36mroom");
  screen.child.stdin.write(LEAVE);
  assert.equal(await screen.exited, 0, screen.out());
  assert.doesNotMatch(screen.out(), /screen failed/);
});

test("chat.ts on a real terminal drops a removed participant's notices from the timeline", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const bob = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room?.id}/agents`,
    {
      cmd: REMEMBER,
      name: "bob",
    },
  );
  assert.equal(bob.status, 201);
  await seen("○ bob");
  const gone = await api(
    d,
    "DELETE",
    `/rooms/${room?.id}/agents/${bob.body.id}`,
  );
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  // Away and back redraws the timeline, header and notices included.
  await press("\x1b[1;3B", "@mock-agent");
  await press("\x1b[1;3A", "room room-");
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
  // Each mock participant has one "no measured labels" notice; the
  // transcript left in scrollback is the timeline's.
  const notices = scrollback(out()).match(/no measured labels/g) ?? [];
  assert.equal(notices.length, 1, scrollback(out()));
});
