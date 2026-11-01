/**
 * What an agent asks and changes, on the full-screen chat on a real terminal
 * through `script(1)`: the question box and its answer (M4-9), a question's
 * diff (M4-6), stalls, and the changed-files block (M7-3). Some tests stand up
 * a fake daemon to control exactly when a diff arrives.
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` **and `XDG_STATE_HOME`**, so no
 * test ever meets another test's `daemon.json` or `repos.json` — or the
 * developer's real ones — even while the other files run at the same time.
 * The helpers more than one of these files needs live in
 * `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { API_VERSION, type PermissionDecision } from "../client/contract.ts";
import {
  addRepo as added,
  api,
  bootDaemon as boot,
  gitRepo,
  LEAVE,
  MOCK_AGENT,
  noPty,
  only,
  pendingOne,
  plainText,
  ptyScreen,
  REMEMBER,
  type RoomReply,
  rowOf,
  screenRows,
  spawnCli,
  tempDir,
  withAgent,
} from "../integration/helpers.ts";

// --- chat rooms (chat MVP) ------------------------------------------------------

test("chat.ts on a real terminal: a question that came while the shell had the keys opens when they come back", {
  skip: noPty,
}, async (t) => {
  // PR #286. A question box never opens over a view that has the keys, so
  // giving the keys back must offer it.
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const asking = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  assert.equal(asking.status, 201, asking.body.error?.message);
  // A room with no orchestrator names none on the status line, so the
  // screen is up once the agent's row is.
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime, SHELL: "/bin/sh" },
    "asker",
  );
  await screen.press("/term\r", "ctrl+] keys back");
  const sent = await api(
    d,
    "POST",
    `/rooms/${asking.body.id}/agents/${only(asking.body).id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  // The shell has the keys: the question waits in the sidebar.
  await screen.seen("? asker");
  assert.doesNotMatch(screen.out(), / 1 of 1 ━┓/);
  await screen.press("\x1d", " 1 of 1 ━┓");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});
test("chat.ts on a real terminal colours an off-screen stall and question", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime, [], undefined, {
    KAPELLE_STALL_IDLE_MS: "100",
  });
  const cwd = await added(d, await gitRepo(t));
  const first = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  const stalled = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT} --scenario stall`, name: "stuck" }],
  });
  const asking = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  for (const room of [first, stalled, asking]) {
    assert.equal(room.status, 201, room.body.error?.message);
  }
  // The first room is the landing view; the other two stay off screen.
  const screen = await ptyScreen(t, "stty cols 100 rows 30; node cli.ts chat", {
    XDG_RUNTIME_DIR: runtime,
  });
  for (const room of [stalled, asking]) {
    const sent = await api(
      d,
      "POST",
      `/rooms/${room.body.id}/agents/${only(room.body).id}/messages`,
      { text: "go" },
    );
    assert.equal(sent.status, 202, sent.body.error?.message);
  }
  // The question opens its box, and the screen behind it loses its
  // colours: the sidebar row is dim, with no other code up to its border.
  // The row is drawn before the box's title, in the same frame. Esc puts
  // the question aside.
  await screen.seen(" 1 of 1 ━┓");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  assert.match(screen.out(), /\x1b\[2m {4}\? asker [^\x1b]*│/);
  await screen.press("\x1b", "? 1 question · ctrl+o");
  // Yellow is a stall, magenta a question: the mark and the name are one
  // painted piece (M7-3), and a busy row shows its timer at the right.
  await screen.seen("\x1b[33m! stuck");
  await screen.seen("\x1b[35m? asker");
  assert.match(plainText(screen.out()), /! stuck +\d+[sm]/);
  assert.match(plainText(screen.out()), /\? asker +\d+[sm]/);
  // The harness is on the agent's second row, dim, under the name (#332).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  assert.match(screen.out(), / {6}\x1b\[2mmock-agent\x1b\[22m/);
  // Hidden, the sidebar leaves a count of the rooms that need the person.
  await screen.press("\x14", "● 2 rooms");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal draws a stall warning", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  // The room's watchdog reads the same defaults as a run; 100 ms makes the
  // warning arrive on its 1 s sweep without waiting the usual five minutes.
  const d = await boot(t, runtime, [], undefined, {
    KAPELLE_STALL_IDLE_MS: "100",
  });
  const cwd = await added(d, await gitRepo(t));
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts new --cmd 'node ${MOCK_AGENT} --scenario stall' --name stuck --cwd '${cwd}'`,
    { XDG_RUNTIME_DIR: runtime },
  );
  screen.child.stdin.write("go\r");
  await screen.seen("! stuck: no activity for");
  // The stalled harness never ends its turn, so ^C is the way out.
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal rings the bell when the orchestrator reaches its turn cap", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime, [], undefined, {
    KAPELLE_ORCHESTRATOR_TURN_CAP: "1",
  });
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "po", role: "orchestrator" },
      { cmd: REMEMBER, name: "dev" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const [po, dev] = open.body.participants;
  assert.ok(po && dev);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${id}`,
    { XDG_RUNTIME_DIR: runtime },
    "dev",
  );
  const bells = () => plainText(screen.out()).split("\x07").length - 1;
  const before = bells();
  const say = (text: string) =>
    api(d, "POST", `/rooms/${id}/agents/${dev.id}/messages`, {
      text,
      from: po.id,
    });
  assert.equal((await say("one")).status, 202);
  const capped = await say("two");
  assert.equal(capped.status, 429);
  assert.equal(capped.body.error.code, "turn_cap");
  for (const until = Date.now() + 10_000; bells() === before; ) {
    assert.ok(Date.now() < until, `no cap bell: ${screen.out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.equal(bells(), before + 1);
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal shows a question off screen in the banner, rings the bell once, and a click on the row opens it", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const first = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  const asking = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  for (const room of [first, asking]) {
    assert.equal(room.status, 201, room.body.error?.message);
  }
  // The first room is the landing view; the asker's room is off screen.
  const screen = await ptyScreen(t, "stty cols 100 rows 30; node cli.ts chat", {
    XDG_RUNTIME_DIR: runtime,
  });
  // Typed text keeps the question box shut, so the banner is the signal.
  await screen.press("zzq", "zzq");
  const sent = await api(
    d,
    "POST",
    `/rooms/${asking.body.id}/agents/${only(asking.body).id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("\x1b[35m▌? asker (");
  assert.match(
    plainText(screen.out()),
    /▌\? asker \(\S+\) asks: Write ACP_TEST\.md/,
  );
  // pi-tui ends its links with a BEL too; `plainText` takes those away.
  const bells = () => plainText(screen.out()).split("\x07").length - 1;
  for (const until = Date.now() + 10_000; bells() === 0; ) {
    assert.ok(Date.now() < until, `no bell: ${screen.out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // The banner sits under the timeline row, full width (#242).
  const bannerRow = () => rowOf(screen.out(), /▌\? asker/);
  assert.ok(bannerRow() > 1, `under the timeline: ${screen.out()}`);
  // Below 120 columns the side view takes the timeline's place; the banner
  // still shows under it.
  await screen.press("\x18", "side view");
  assert.ok(bannerRow() > 1, `under the side view: ${screen.out()}`);
  // At 100 columns the question count leaves room for three hints only:
  // `ctrl+t rooms` and `ctrl+x view` drop (M7-1). `ctrl+o menu` shows only
  // with the side view hidden.
  await screen.press("\x18", "enter to send · ctrl+o menu");
  const row = bannerRow();
  await screen.press(`\x1b[<0;40;${row}M\x1b[<0;40;${row}m`, " 1 of 1 ━┓");
  await screen.seen("→ asker");
  assert.equal(bells(), 1, "one bell for one participant that waits");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal answers a question in its pop-up, and a piped observer sees the same decision", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT}`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  // The CLI observer (M4-3): a piped attach on the same room.
  const observer = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  let watched = "";
  observer.child.stdout.on("data", (c: string) => {
    watched += c;
  });
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);

  // The box opens by itself, with who wants what in its title (M7-4) and
  // the tool's input, and deny comes first.
  await screen.seen("\x1b[7m\x1b[33m asker wants to edit ");
  await screen.seen("edit · Write ACP_TEST.md");
  await screen.seen("path: ACP_TEST.md");
  const write = await pendingOne(d);
  // `y` only moves the cursor to allow (M7-4): nothing is sent yet.
  await screen.press("y", "2 allow");
  const decided = async (id: string) =>
    (await api<PermissionDecision>(d, "GET", `/permissions/${id}`)).body;
  assert.equal((await decided(write.id)).allow, undefined);
  // Enter answers. The next question opens in its place.
  await screen.press("\r", "Delete something");
  const del = await pendingOne(d);
  assert.notEqual(del.id, write.id);
  // A sentence typed into the box ends on deny (decided 2026-10-13), even
  // from allow, and a stray Enter says no.
  await screen.press("2", "→ 2 allow");
  await screen.press("try it", "→ 1 deny");
  // Shift+1 as xterm and tmux send it under modifyOtherKeys is typed text
  // too, so `okay!⏎` ends on deny.
  await screen.press("2", "→ 2 allow");
  await screen.press("\x1b[27;2;33~", "→ 1 deny");
  screen.child.stdin.write("\r");
  for (const until = Date.now() + 20_000; ; ) {
    if (watched.includes("asker: denied (client)")) break;
    assert.ok(Date.now() < until, watched);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.deepEqual(
    [(await decided(write.id)).allow, (await decided(write.id)).reason],
    [true, "client"],
  );
  assert.deepEqual(
    [(await decided(del.id)).allow, (await decided(del.id)).reason],
    [false, "client"],
  );
  assert.match(
    watched,
    /\? asker asks: Write ACP_TEST\.md\n {2}asker: allowed \(client\)\n/,
  );
  assert.match(
    watched,
    /\? asker asks: Delete something[^\n]*\n {2}asker: denied \(client\)\n/,
  );
  observer.child.stdin.end("/leave\n");
  assert.equal((await observer.done).code, 0);
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal keeps a question waiting while the person types, and closes its box when another client answers", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
    // The only agent is the target (#333).
    "→ asker",
  );
  // Text in the composer: the box must not take the next keys.
  await screen.press("@asker hel", "@asker hel");
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("? 1 question · ctrl+o");
  assert.doesNotMatch(plainText(screen.out()), / 1 of 1 ━┓/);
  // The menu lists it first; Enter opens its box.
  await screen.press("\x0f", "? asker asks: Write ACP_TEST.md");
  await screen.press("\r", " 1 of 1 ━┓");
  const write = await pendingOne(d);
  const other = await api(d, "POST", `/permissions/${write.id}`, {
    allow: true,
  });
  assert.equal(other.status, 200, other.body.error?.message);
  await screen.seen("asker's question closed: allowed (client)");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal opens over a thread's @name pre-fill, and Esc puts the question aside", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT}`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.seen("○ asker");
  // alt+down opens the thread, so the composer holds exactly `@asker `.
  // That pre-fill is not typed text: the question must open by itself.
  await screen.press("\x1b[1;3B", "@asker");
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("edit · Write ACP_TEST.md");
  // Esc puts it aside: the box goes and the status line counts it. `press`
  // reads only what is drawn after the key, and waits out pi-tui's alt-key
  // window for a bare Esc.
  await screen.press("\x1b", "? 1 question · ctrl+o");
  // A decision from elsewhere closes it, and Esc already stopped it from
  // reopening.
  const q = await pendingOne(d);
  const other = await api(d, "POST", `/permissions/${q.id}`, { allow: true });
  assert.equal(other.status, 200, other.body.error?.message);
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal says why a lost answer lost, keeps the box's count true, and refuses a closed question from the menu", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const roomId = "room-fake";
  const room = {
    id: roomId,
    cwd: process.cwd(),
    status: "active",
    title: "fake room",
    updatedAt: new Date().toISOString(),
    participants: [
      {
        id: "p1",
        name: "asker",
        harness: "mock-agent",
        role: "orchestrator",
        mode: "ask",
        status: "busy",
        notices: [],
      },
    ],
  };
  // A second room, not the one on screen, to be dismissed with its
  // question's box open.
  const other = {
    ...room,
    id: "room-other",
    title: "other room",
    participants: [{ ...room.participants[0], id: "p2", name: "shipper" }],
  };
  let answered = false;
  const posted: string[] = [];
  // Each room's event stream, so the test can send more lines.
  let stream: ServerResponse | undefined;
  let otherStream: ServerResponse | undefined;
  const event = (
    seq: number,
    update: object,
    where = { roomId, participantId: "p1" },
  ) => `id: ${seq}\ndata: ${JSON.stringify({ seq, ...where, update })}\n\n`;
  const fake = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ apiVersion: API_VERSION }));
      return;
    }
    if (path === "/harnesses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (path === "/rooms") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([room, other]));
      return;
    }
    if (path === `/rooms/${roomId}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(room));
      return;
    }
    if (path === `/rooms/${other.id}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(other));
      return;
    }
    if (path === `/rooms/${other.id}/events`) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      otherStream = res;
      const where = { roomId: other.id, participantId: "p2" };
      res.write(
        event(
          1,
          {
            sessionUpdate: "_client_participant_added",
            name: "shipper",
            harness: "mock-agent",
            mode: "ask",
          },
          where,
        ),
      );
      return;
    }
    if (path === `/rooms/${roomId}/events`) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      stream = res;
      res.write(
        event(1, {
          sessionUpdate: "_client_participant_added",
          name: "asker",
          harness: "mock-agent",
          role: "orchestrator",
          mode: "ask",
        }),
      );
      res.write(
        event(2, {
          sessionUpdate: "_client_permission_queued",
          id: "q1",
          kind: "edit",
          title: "Write ACP_TEST.md",
          input: { path: "ACP_TEST.md" },
        }),
      );
      return;
    }
    if (req.method === "POST") posted.push(path);
    if (req.method === "POST" && path === "/permissions/q1") {
      answered = true;
      res.writeHead(409, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "already_decided",
            message: "permission q1 was already decided",
          },
        }),
      );
      return;
    }
    if (req.method === "GET" && path === "/permissions/q1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "q1",
          roomId,
          participantId: "p1",
          turn: 1,
          kind: "edit",
          title: "Write ACP_TEST.md",
          input: { path: "ACP_TEST.md" },
          allow: false,
          reason: "timeout",
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: { code: "no_route", message: `no ${path}` } }),
    );
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  t.after(() => fake.close());
  const { port } = fake.address() as AddressInfo;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: process.pid, port, token: "t" }),
    { mode: 0o600 },
  );
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${roomId}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.seen("edit · Write ACP_TEST.md");
  // A second question while the box is open: its count follows.
  stream?.write(
    event(3, {
      sessionUpdate: "_client_permission_queued",
      id: "q2",
      kind: "delete",
      title: "Delete something",
      // Longer than the box: its end must wrap into view, not be cut.
      // A path has no space: only a wrap that breaks inside a word shows
      // its last 80 characters, the Z's, at all.
      input: {
        command: `rm -rf build/${"x".repeat(100)} END-OF-COMMAND`,
        path: `/${"y".repeat(220)}${"Z".repeat(80)}`,
      },
    }),
  );
  await screen.seen(" 1 of 2 ━┓");
  // Esc means away: the next question waits too, and both are counted.
  await screen.press("\x1b", "? 2 questions · ctrl+o");
  await screen.press("\x0f", "? asker asks: Delete something");
  await screen.press("\r", " 1 of 2 ━┓");
  await screen.press("\r", "already closed: timeout");
  assert.ok(answered, "the TUI posted the answer");
  // q1 never closed on this stream, so q2 opens as the second of two. Its
  // close comes now: q2 is the only one left.
  await screen.seen(" 2 of 2 ━┓");
  await screen.seen("END-OF-COMMAND");
  await screen.seen("Z".repeat(20));
  stream?.write(
    event(4, {
      sessionUpdate: "_client_permission_answered",
      id: "q1",
      allow: false,
      reason: "timeout",
    }),
  );
  await screen.press("", " 1 of 1 ━┓");
  // Put q2 aside, list it, then it closes while the menu is open: picking
  // it says so and closes the menu.
  await screen.press("\x1b", "? 1 question · ctrl+o");
  await screen.press("\x0f", "? asker asks: Delete something");
  stream?.write(
    event(5, {
      sessionUpdate: "_client_permission_answered",
      id: "q2",
      allow: false,
      reason: "cancel",
    }),
  );
  await screen.seen("denied (cancel)");
  await screen.press("\r", "that question already closed");
  // A question in the other room opens its box. Its title is far taller
  // than the box: the answer rows and their hint must still be drawn. That
  // room is then dismissed with no close line: the box must go with it.
  const before = screen.out().length;
  otherStream?.write(
    event(
      2,
      {
        sessionUpdate: "_client_permission_queued",
        id: "q3",
        kind: "execute",
        title: `Ship it ${"now ".repeat(1000)}`,
      },
      { roomId: other.id, participantId: "p2" },
    ),
  );
  await screen.seen("execute · Ship it");
  for (const until = Date.now() + 20_000; ; ) {
    if (screen.out().slice(before).includes("enter answer")) break;
    assert.ok(Date.now() < until, "the answer rows were pushed out of the box");
    await new Promise((ok) => setTimeout(ok, 50));
  }
  other.status = "dismissed";
  otherStream?.end();
  await screen.seen("other room was dismissed");
  screen.child.stdin.write("\r");
  await new Promise((ok) => setTimeout(ok, 500));
  assert.ok(!posted.includes("/permissions/q3"), posted.join(" "));
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

/** One changed file, for the M7-3 fake-daemon tests. */
const CHANGES_TEXT = [
  "diff --git a/cli.ts b/cli.ts",
  "@@ -1 +1,2 @@",
  "-old",
  "+new",
  "+more",
].join("\n");

/** Two changed files, so a click on the second proves the jump (M7-3). */
const TWO_CHANGES_TEXT = [
  ...CHANGES_TEXT.split("\n"),
  "diff --git a/other.ts b/other.ts",
  "new file mode 100644",
  "@@ -0,0 +1 @@",
  "+x",
].join("\n");

/**
 * A fake daemon with one room `room-changes` and one participant `p1`
 * (M7-3): the diff route counts its calls, and the test can write more
 * event lines into the one stream. `files` is the route's count, `failAt`
 * refuses that call, `holdAt` holds that call's reply until `release()`,
 * and `later` is what calls after the first answer with.
 */
async function fakeChangesRoom(
  t: TestContext,
  text: string,
  {
    files = 1,
    failAt,
    holdAt,
    later,
  }: {
    files?: number;
    failAt?: number;
    holdAt?: number;
    later?: { text: string; files: number };
  } = {},
) {
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const roomId = "room-changes";
  const room = {
    id: roomId,
    cwd: process.cwd(),
    status: "active",
    title: "change room",
    updatedAt: new Date().toISOString(),
    participants: [
      {
        id: "p1",
        name: "ann",
        harness: "mock-agent",
        role: "orchestrator",
        mode: "ask",
        status: "busy",
        notices: [],
      },
    ],
  };
  let stream: ServerResponse | undefined;
  const diffs: string[] = [];
  const held: (() => void)[] = [];
  const event = (seq: number, update: object, participantId = "p1") =>
    `id: ${seq}\ndata: ${JSON.stringify({ seq, roomId, participantId, update })}\n\n`;
  const fake = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ apiVersion: API_VERSION }));
      return;
    }
    if (path === "/harnesses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (path === "/rooms") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([room]));
      return;
    }
    if (path === `/rooms/${roomId}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(room));
      return;
    }
    if (path === `/rooms/${roomId}/events`) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      stream = res;
      res.write(
        event(1, {
          sessionUpdate: "_client_participant_added",
          name: "ann",
          harness: "mock-agent",
          role: "orchestrator",
          mode: "ask",
        }),
      );
      return;
    }
    if (path.startsWith(`/rooms/${roomId}/agents/p1/diff`)) {
      diffs.push(path);
      const call = diffs.length;
      if (call === failAt) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "no_diff", message: "no branch to compare with" },
          }),
        );
        return;
      }
      const body =
        call > 1 && call !== holdAt && later ? later : { text, files };
      const answer = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...body, added: 2, removed: 1 }));
      };
      if (call === holdAt) {
        held.push(answer);
        return;
      }
      answer();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: { code: "no_route", message: `no ${path}` } }),
    );
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  t.after(() => fake.close());
  const { port } = fake.address() as AddressInfo;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: process.pid, port, token: "t" }),
    { mode: 0o600 },
  );
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${roomId}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  return {
    screen,
    diffs,
    event,
    write: (line: string) => stream?.write(line),
    release: () => {
      for (const answer of held.splice(0)) answer();
    },
  };
}

test("chat.ts on a real terminal loads the changed files once per turn end or exit, never per chunk", {
  skip: noPty,
}, async (t) => {
  const { screen, diffs, event, write } = await fakeChangesRoom(
    t,
    CHANGES_TEXT,
  );
  // The room's timeline opens first; alt+down opens ann's thread, which
  // loads the files once.
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  await screen.seen("changed files");
  assert.equal(diffs.length, 1, diffs.join("\n"));
  assert.match(diffs[0] ?? "", /against=base/);
  // A chunk is not a turn end: two of them load nothing.
  write(
    event(2, { sessionUpdate: "_client_user_message", text: "go", turn: 1 }),
  );
  write(
    event(3, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "one" },
    }),
  );
  write(
    event(4, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " two" },
    }),
  );
  await screen.seen("one two");
  assert.equal(diffs.length, 1, "a chunk loaded the files");
  write(
    event(5, { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" }),
  );
  for (const until = Date.now() + 20_000; diffs.length < 2; ) {
    assert.ok(
      Date.now() < until,
      `no diff call on the turn end: ${diffs.join("\n")}`,
    );
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.match(diffs[1] ?? "", /against=base/);
  // An exit ends the work too: one more call, not a second per turn end.
  write(event(6, { sessionUpdate: "_client_harness_exited", pid: 1 }));
  for (const until = Date.now() + 20_000; diffs.length < 3; ) {
    assert.ok(
      Date.now() < until,
      `no diff call on the exit: ${diffs.join("\n")}`,
    );
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.match(diffs[2] ?? "", /against=base/);
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal refreshes changed files during a turn and coalesces bursts", {
  skip: noPty,
  // The test drives a whole pty session: its call count is the test.
  // pi-lens-ignore: high-fan-out
}, async (t) => {
  const { screen, diffs, event, write, release } = await fakeChangesRoom(
    t,
    "",
    {
      files: 0,
      holdAt: 2,
      later: { text: TWO_CHANGES_TEXT, files: 2 },
    },
  );
  const until = async (done: () => boolean, why: string) => {
    for (const end = Date.now() + 20_000; !done(); ) {
      assert.ok(Date.now() < end, why);
      await new Promise((ok) => setTimeout(ok, 50));
    }
  };
  const shown = () => [...screenRows(screen.out()).values()].join("\n");
  await screen.seen("○ ann");
  // The room timeline ignores the signal.
  write(
    event(2, {
      sessionUpdate: "_client_wrote_file",
      path: "/tmp/ignored",
    }),
  );
  await new Promise((ok) => setTimeout(ok, 500));
  assert.equal(diffs.length, 0, diffs.join("\n"));
  // Opening the thread loads an empty block. The write event starts the
  // debounced request, which the fake daemon holds. This proves D fires.
  await screen.press("\x1b[1;3B", "@ann");
  await until(
    () => diffs.length === 1,
    `no open diff call: ${diffs.join("\n")}`,
  );
  assert.doesNotMatch(shown(), /changed files/);
  write(
    event(3, {
      sessionUpdate: "_client_wrote_file",
      path: "/tmp/again",
    }),
  );
  await until(
    () => diffs.length === 2,
    `no write diff call: ${diffs.join("\n")}`,
  );
  // A tool completion during that request is queued once, not sent beside it.
  write(
    event(4, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit",
      kind: "edit",
      status: "completed",
    }),
  );
  write(
    event(5, {
      sessionUpdate: "tool_call",
      toolCallId: "delete-1",
      title: "Delete",
      kind: "delete",
      status: "completed",
    }),
  );
  await new Promise((ok) => setTimeout(ok, 400));
  assert.equal(diffs.length, 2, "a second request ran beside the held one");
  release();
  await until(
    () => diffs.length === 3,
    `no trailing diff call: ${diffs.join("\n")}`,
  );
  await until(
    () => shown().includes("A other.ts"),
    "the new block never appeared",
  );
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(diffs.length, 3, "the queued reload ran more than once");
  // A file tool completion alone also refreshes the block. The completion
  // update carries only its status, so the call's earlier kind is enough.
  write(
    event(6, {
      sessionUpdate: "tool_call",
      toolCallId: "move-1",
      title: "Move",
      kind: "move",
      status: "in_progress",
    }),
  );
  write(
    event(7, {
      sessionUpdate: "tool_call_update",
      toolCallId: "move-1",
      status: "completed",
    }),
  );
  await until(
    () => diffs.length === 4,
    `no tool diff call: ${diffs.join("\n")}`,
  );
  // Two signals in one burst share one request.
  write(
    event(8, {
      sessionUpdate: "_client_wrote_file",
      path: "/tmp/burst",
    }),
  );
  write(
    event(9, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-2",
      title: "Edit again",
      kind: "edit",
      status: "completed",
    }),
  );
  await until(
    () => diffs.length === 5,
    `no burst diff call: ${diffs.join("\n")}`,
  );
  await new Promise((ok) => setTimeout(ok, 400));
  assert.equal(diffs.length, 5, "the burst made more than one request");
  // No turn end or second click was needed.
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts refreshes during a continuous file-signal burst instead of waiting for quiet", {
  skip: noPty,
}, async (t) => {
  const { screen, diffs, event, write } = await fakeChangesRoom(t, "", {
    files: 0,
    later: { text: TWO_CHANGES_TEXT, files: 2 },
  });
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  for (const end = Date.now() + 20_000; diffs.length < 1; ) {
    assert.ok(Date.now() < end, "no open diff call");
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // Keep the gaps below the 250 ms debounce for longer than its max wait.
  let refreshed = false;
  for (let i = 0; i < 14; i++) {
    write(
      event(2 + i, {
        sessionUpdate: "_client_wrote_file",
        path: `/tmp/continuous-${i}`,
      }),
    );
    await new Promise((ok) => setTimeout(ok, 100));
    if (diffs.length > 1) {
      refreshed = true;
      break;
    }
  }
  assert.ok(refreshed, "the refresh waited for the burst to stop");
  await screen.seen("A other.ts");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts loads changed files only on a completed file-related tool or a write", {
  skip: noPty,
}, async (t) => {
  const { screen, diffs, event, write } = await fakeChangesRoom(t, "", {
    files: 0,
    later: { text: TWO_CHANGES_TEXT, files: 2 },
  });
  const until = async (done: () => boolean, why: string) => {
    for (const end = Date.now() + 20_000; !done(); ) {
      assert.ok(Date.now() < end, why);
      await new Promise((ok) => setTimeout(ok, 50));
    }
  };
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  await until(() => diffs.length === 1, "no open diff call");
  // None of these load: a completed non-file tool, a file tool that has
  // only started, or another participant's write.
  write(
    event(2, {
      sessionUpdate: "tool_call",
      toolCallId: "run-1",
      title: "Run",
      kind: "execute",
      status: "completed",
    }),
  );
  write(
    event(3, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
    }),
  );
  write(
    event(
      4,
      {
        sessionUpdate: "_client_participant_added",
        name: "bob",
        harness: "mock-agent",
        mode: "ask",
      },
      "p2",
    ),
  );
  await screen.seen("○ bob");
  write(
    event(5, { sessionUpdate: "_client_wrote_file", path: "/tmp/bob" }, "p2"),
  );
  await new Promise((ok) => setTimeout(ok, 500));
  assert.equal(diffs.length, 1, "a non-trigger loaded the files");
  // The file tool's completion does, even when the update carries only its
  // status.
  write(
    event(6, {
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      status: "completed",
    }),
  );
  await until(
    () => diffs.length === 2,
    "the completed file tool loaded nothing",
  );
  await screen.seen("A other.ts");
  // ann's own write still refreshes the block, proving the fixture is live.
  write(event(7, { sessionUpdate: "_client_wrote_file", path: "/tmp/ann" }));
  await until(() => diffs.length === 3, "ann's write loaded nothing");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal refreshes changed files when a file call that started before the thread opened completes", {
  skip: noPty,
}, async (t) => {
  const { screen, diffs, event, write } = await fakeChangesRoom(t, "", {
    files: 0,
    later: { text: TWO_CHANGES_TEXT, files: 2 },
  });
  await screen.seen("○ ann");
  // The edit starts while the room timeline is shown.
  write(
    event(2, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-early",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
    }),
  );
  await screen.seen("Edit");
  await screen.press("\x1b[1;3B", "@ann");
  for (const end = Date.now() + 20_000; diffs.length < 1; ) {
    assert.ok(Date.now() < end, "no open diff call");
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // Its completion carries only its status.
  write(
    event(3, {
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-early",
      status: "completed",
    }),
  );
  await screen.seen("A other.ts");
  assert.equal(diffs.length, 2, diffs.join("\n"));
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts keeps the newest changed files when a crash's two loads land out of order", {
  skip: noPty,
}, async (t) => {
  const { screen, diffs, event, write, release } = await fakeChangesRoom(
    t,
    CHANGES_TEXT,
    { holdAt: 2, later: { text: TWO_CHANGES_TEXT, files: 2 } },
  );
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  await screen.seen("changed files");
  assert.equal(diffs.length, 1, diffs.join("\n"));
  // A crash reports its exit before the turn it broke ends. Send the exit,
  // wait for its held request, then send the turn end: the older request
  // arrives before the newer one, so the guard sees a known order.
  write(event(2, { sessionUpdate: "_client_harness_exited", pid: 1 }));
  for (const until = Date.now() + 20_000; diffs.length < 2; ) {
    assert.ok(Date.now() < until, `no held diff call: ${diffs.join("\n")}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  write(event(3, { sessionUpdate: "_client_turn_ended", stopReason: "error" }));
  for (const until = Date.now() + 20_000; diffs.length < 3; ) {
    assert.ok(Date.now() < until, `no third diff call: ${diffs.join("\n")}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  await screen.seen("A other.ts");
  // The held, older reply lands last and must not replace the newer block.
  release();
  await new Promise((ok) => setTimeout(ok, 500));
  const shown = () => [...screenRows(screen.out()).values()].join("\n");
  assert.match(
    shown(),
    /A other\.ts/,
    "the older reply replaced the newer one",
  );
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal opens a clicked changed file in the side view", {
  skip: noPty,
}, async (t) => {
  const { screen } = await fakeChangesRoom(t, TWO_CHANGES_TEXT, { files: 2 });
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  await screen.seen("changed files");
  const row = rowOf(screen.out(), /A other\.ts/);
  assert.ok(row > 0, screen.out());
  // A click on the second file's row opens the side pane there, not the top.
  await screen.press(
    `\x1b[<0;6;${row}M\x1b[<0;6;${row}m`,
    "whole branch · other.ts (new) (2 of 2)",
  );
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal drops the changed-files block when the diff route refuses", {
  skip: noPty,
}, async (t) => {
  const { screen, diffs, event, write } = await fakeChangesRoom(
    t,
    CHANGES_TEXT,
    { failAt: 2 },
  );
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  await screen.seen("changed files");
  assert.equal(diffs.length, 1, diffs.join("\n"));
  // The reload after the turn ends gets a 409 no_diff: no block, no stale one.
  write(
    event(2, { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" }),
  );
  for (const until = Date.now() + 20_000; diffs.length < 2; ) {
    assert.ok(Date.now() < until, `no diff call: ${diffs.join("\n")}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // The current screen, not the frames the block was drawn in.
  const shown = () => [...screenRows(screen.out()).values()].join("\n");
  for (const until = Date.now() + 20_000; shown().includes("M cli.ts"); ) {
    assert.ok(Date.now() < until, `the block survived a refusal: ${shown()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.doesNotMatch(shown(), /changed files/);
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a short terminal keeps the question's action in its box", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  // 12 rows leave the box room for one line of what is asked: it must be
  // the action, not a `…` in its place.
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 12; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
    // The only agent is the target (#333).
    "→ asker",
  );
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("edit · Write ACP_TEST.md");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal opens a question that came behind the menu once the menu closes", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
    // The only agent is the target (#333).
    "→ asker",
  );
  // The menu.
  await screen.press("\x0f", "new room …");
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  // It never opens over another pop-up: it waits on the status line, which
  // wraps here, so the "? " can sit on the row above.
  await screen.seen("1 question · ctrl+o");
  assert.doesNotMatch(plainText(screen.out()), / 1 of 1 ━┓/);
  await screen.press("\x1b", " 1 of 1 ━┓");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

// --- room commands (M4-5) -----------------------------------------------------

test("chat.ts on a real terminal shows a question's diff beside the timeline, goes back to the box, and answers from the pane", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`,
    {
      text: "go",
    },
  );

  // One line and one row in the box; deny is still first.
  await screen.seen("± ACP_TEST.md (new) +1 −0");
  await screen.seen("view diff");
  const write = await pendingOne(d);
  await screen.press("\x1b[B\x1b[B\r", "question 1 of 1 · ACP_TEST.md (new)");
  await screen.seen("+written by the mock agent through the client");
  await screen.seen("y allow · n deny · ctrl+] type");
  // Esc brings the box back; the pane opens again from it.
  await screen.press("\x1b", "↑↓ pick · enter answer · esc later");
  await screen.press("\x1b[B\x1b[B\r", "y allow · n deny");
  await screen.press("y", "question 1 of 1 · allowed (client)");
  // The next question opens over the pane; Esc puts it aside and shows the
  // pane content that stayed. The transcript's own "allowed (client)" line
  // would not prove this.
  await screen.seen("delete · Delete something");
  await screen.press("\x1b", "? 1 question");
  await screen.press("\x1d", "ctrl+] type");
  await screen.press("\x18", "ctrl+x view");
  const shownAgain = screen.out().length;
  await screen.press("\x18", "question 1 of 1 · allowed (client)");
  const answerFrame = screen.out().slice(shownAgain);
  assert.match(answerFrame, /question 1 of 1 · allowed \(client\)/);
  assert.match(answerFrame, /\+written by the mock agent through the client/);
  const decided = await api<PermissionDecision>(
    d,
    "GET",
    `/permissions/${write.id}`,
  );
  assert.deepEqual([decided.body.allow, decided.body.reason], [true, "client"]);
  screen.child.stdin.write(LEAVE);
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal answers a question from the pane with n", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`,
    { text: "go" },
  );
  await screen.seen("view diff");
  const write = await pendingOne(d);
  await screen.press("\x1b[B\x1b[B\r", "y allow · n deny · ctrl+] type");
  await screen.press("n", "question 1 of 1 · denied (client)");
  const decided = await api<PermissionDecision>(
    d,
    "GET",
    `/permissions/${write.id}`,
  );
  assert.deepEqual(
    [decided.body.allow, decided.body.reason],
    [false, "client"],
  );
  screen.child.stdin.write(LEAVE);
  assert.equal(await screen.exited, 0, screen.out());
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("chat.ts on a real terminal keeps a waiting question's keys when view changes opens it", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "alice",
        role: "orchestrator",
        mode: "ask",
      },
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "bob",
        role: "developer",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const alice = open.body.participants.find((p) => p.name === "alice");
  const bob = open.body.participants.find((p) => p.name === "bob");
  assert.ok(alice && bob);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );

  // Alice asks; her box opens. Bob asks while it is open, so his question
  // waits behind hers.
  await api(d, "POST", `/rooms/${open.body.id}/agents/${alice.id}/messages`, {
    text: "go",
  });
  await screen.seen("deny");
  await api(d, "POST", `/rooms/${open.body.id}/agents/${bob.id}/messages`, {
    text: "go",
  });
  await screen.seen(" 1 of 2 ━┓");
  await new Promise((ok) => setTimeout(ok, 1_000));

  // ctrl+o closes Alice's box (puts her question aside); ctrl+o opens the
  // menu; choose agent … -> bob -> view changes. Bob's box opens as the menu
  // closes, and the pane must not take its keys.
  await screen.press("\x0f", "? 2 questions");
  await screen.press("\x0f", "agent …");
  await screen.press("\x1b[B\x1b[B\r", "pick an agent");
  await screen.press("\x1b[B\r", "view changes");
  // Two question rows, then cancel, mode, model, role and rename.
  await screen.press(`${"\x1b[B".repeat(7)}\r`, "↑↓ pick");
  await screen.seen("bob · uncommitted");

  const before = screen.out().length;
  screen.child.stdin.write("b");
  await new Promise((ok) => setTimeout(ok, 300));
  assert.doesNotMatch(screen.out().slice(before), /bob · whole branch/);
  // Closing the box hands the keys to the composer, not to the view that
  // gave them up (#225 review): typed text reaches the composer.
  await screen.press("\x1b", "ctrl+] view");
  await screen.press("hello", "hello");
  screen.child.stdin.write(LEAVE);
  assert.equal(await screen.exited, 0, screen.out());
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("chat.ts on a real terminal under 120 columns puts the question's diff where the timeline was", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`,
    {
      text: "go",
    },
  );
  await screen.seen("view diff");
  const beforeOpen = screen.out().length;
  // The counts survive only in a pane that took the timeline's place: beside
  // it the pane is half the width, and the head is cut before them. The
  // timeline's own text must also be gone, not merely cut from this row.
  await screen.press("\x1b[B\x1b[B\r", "ACP_TEST.md (new) · +1 −0");
  assert.doesNotMatch(screen.out().slice(beforeOpen), /you → asker/);
  screen.child.stdin.write(LEAVE);
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal shows what an auto agent changed, from /diff and from its menu, file by file and against its base", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "bob", role: "orchestrator" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  await writeFile(join(p.worktree, "README.md"), "changed\n");
  await writeFile(join(p.worktree, "new.txt"), "fresh\n");
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );

  // ctrl+x wakes the side view; before anything is in it, it says how to
  // fill it. ctrl+x again hides it.
  await screen.press("\x18", "nothing here yet");
  await screen.press("\x18", "ctrl+x view");
  await screen.press("@bob /diff\r", "bob · uncommitted · README.md (1 of 2)");
  await screen.press("]", "new.txt (new) (2 of 2)");
  await screen.press("[", "README.md (1 of 2)");
  // ctrl+] gives the keys to the composer: a message goes out while the
  // view stays, and its letters reach no view key. ctrl+] takes the keys
  // back.
  await screen.press("\x1d", "ctrl+] view");
  await screen.press("bravo\r", "previous: (none)");
  await screen.press("\x1d", "ctrl+] type");
  await screen.press("b", "bob · whole branch");
  // The pane is a snapshot: `r` asks again and finds the third file.
  await writeFile(join(p.worktree, "more.txt"), "more\n");
  await screen.press("r", "README.md (1 of 3)");
  // Esc gives the keys back; the view stays.
  await screen.press("\x1b", "ctrl+] view");
  // The menu: ctrl+o, `agent …`, bob, then `view changes`.
  await screen.press("\x0f", "agent …");
  await screen.press("\r", "pick an agent");
  await screen.press("\r", "view changes");
  // Below cancel, mode, model, role and rename; above remove.
  await screen.press(`${"\x1b[B".repeat(5)}\r`, "bob · uncommitted");
  // ctrl+x hides the view and keeps what it shows.
  await screen.press("\x18", "ctrl+x view");
  await screen.press("\x18", "bob · uncommitted · README.md (1 of 3)");
  screen.child.stdin.write(LEAVE);
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal gives a refused /diff its line back", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  // Not a git repository: the agent's changes cannot be shown.
  const cwd = await added(d, await tempDir(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "bob", role: "orchestrator" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.press("@bob /diff\r", "no diff for bob");
  // As every refused command does (#225 review): the text comes back to fix.
  await screen.press("x", "@bob /diff x");
  screen.child.stdin.write(LEAVE);
  assert.equal(await screen.exited, 0, screen.out());
});

// --- a room across a restart (M6-7a, #151) ----------------------------------

test("an answer while the daemon is away says so, and the screen stays", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`,
    { text: "go" },
  );
  await screen.seen("view diff");
  await pendingOne(d);
  process.kill(d.pid, "SIGKILL");
  // Enter answers deny, the first row (M6-7d: the screen waits).
  await screen.press("\r", "the daemon did not answer");
  const r = await Promise.race([
    screen.exited,
    new Promise((ok) => setTimeout(() => ok("open"), 500)),
  ]);
  assert.equal(r, "open", plainText(screen.out()));
});
