/**
 * The full-screen chat's pop-ups on a real terminal through `script(1)`: the
 * menu, the forms, the typed room commands (M4-5), a fast-forward's preview,
 * and the setup list (M9-3).
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` **and `XDG_STATE_HOME`**, so no
 * test ever meets another test's `daemon.json` or `repos.json` — or the
 * developer's real ones — even while the other files run at the same time.
 * The helpers more than one of these files needs live in
 * `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import { access, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  API_VERSION,
  type HarnessesReply,
  type ParticipantDto,
  type RoomListEntry,
} from "../client/contract.ts";
import {
  addRepo as added,
  api,
  bootDaemon as boot,
  bootFinding,
  chatOnPty,
  commitAt,
  fakePath,
  gitRepo,
  headAt,
  LEAVE,
  MOCK_AGENT,
  noPty,
  only,
  plainText,
  ptyScreen,
  REMEMBER,
  REPO,
  type RoomReply,
  screenRows,
  scrollback,
  tempDir,
  withAgent,
} from "../integration/helpers.ts";
import { AGENTS } from "../protocol/registry.ts";

// --- chat rooms (chat MVP) ------------------------------------------------------

/** The pop-up's pick list as it is drawn now, one entry a row. `→` marks
 *  the cursor. */
const pickList = (out: string) =>
  [...screenRows(out).values()].flatMap(
    (row) => row.match(/┃ [→ ] (\S+)\s*┃/)?.[1] ?? [],
  );

/** Two rooms on one screen: `doomed` starts the attached room, `kept` is the
 *  other row. `longStop` keeps a delete from finishing before a test moves
 *  the view. */
async function twoRoomPty(t: TestContext, firstAgent: string) {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const doomed = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    title: "doomed",
    agents: [{ cmd: firstAgent, name: "slow" }],
  });
  assert.equal(doomed.status, 201, doomed.body.error?.message);
  const kept = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    title: "kept",
    agents: [{ cmd: REMEMBER, name: "bob" }],
  });
  assert.equal(kept.status, 201, kept.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${doomed.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.seen("○ bob");
  return { screen, d, doomed: doomed.body, kept: kept.body };
}

test("chat.ts on a real terminal previews a fast-forward and moves on Enter", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out, d } = await chatOnPty(t);
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.ok(room);
  const full = await api<RoomReply>(d, "GET", `/rooms/${room.id}`);
  assert.equal(full.status, 200, JSON.stringify(full.body));
  const dev = only(full.body);
  await commitAt(dev.worktree, "dev.txt");

  const addedRev = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room.id}/agents`,
    { cmd: REMEMBER, name: "reviewer", base: dev.branch },
  );
  assert.equal(addedRev.status, 201, JSON.stringify(addedRev.body));
  const reviewer = addedRev.body;
  await commitAt(reviewer.worktree, "review.txt");
  const revHead = headAt(reviewer.worktree);

  await seen("○ reviewer");
  child.stdin.write("@mock-agent /ff --from @reviewer\r");
  await seen("mock-agent ← reviewer · fast-forward");
  await seen("review.txt");
  await press("\r", "moved mock-agent up to reviewer's commit");
  assert.equal(headAt(dev.worktree), revHead);
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
});

test("the ctrl+o menu previews /delete and Enter confirms it", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out, d } = await chatOnPty(t);
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.ok(room);
  const full = await api<RoomReply>(d, "GET", `/rooms/${room.id}`);
  const dev = only(full.body);
  await commitAt(dev.worktree, "dev.txt");

  await seen("○ mock-agent");
  await press("\x0f", "delete room …");
  await press(`${DOWN.repeat(5)}\r`, "delete · 1 branch");
  await seen("dev.txt");
  await press("\r", "deleted room-");
  await seen("ctrl+o → new room");
  assert.equal((await api(d, "GET", `/rooms/${room.id}`)).status, 404);
  child.stdin.write(LEAVE);
  assert.equal(await exited, 0, out());
});

test("an attached dismissed room stays open for /delete", {
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
  const dev = only(open.body);
  await commitAt(dev.worktree, "dev.txt");
  assert.equal(
    (await api(d, "POST", `/rooms/${open.body.id}/dismiss`)).status,
    200,
  );
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.seen(open.body.id);
  screen.child.stdin.write("/delete\r");
  await screen.seen("delete · 1 branch");
  await screen.seen("1 unmerged commit");
  await screen.seen("dev.txt");
  await screen.press("\r", "deleted room-");
  screen.child.stdin.write(LEAVE);
  await screen.seen("left the chat");
  assert.equal(await screen.exited, 0, screen.out());
});

test("a refused TUI delete shows the dirty file and allows a retry", {
  skip: noPty,
}, async (t) => {
  const { child, press, exited, out, d } = await chatOnPty(t);
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.ok(room);
  const full = await api<RoomReply>(d, "GET", `/rooms/${room.id}`);
  const dev = only(full.body);
  const draft = join(dev.worktree, "draft.txt");
  await writeFile(draft, "uncommitted\n");

  await press("/delete\r", "delete · 1 branch");
  assert.equal(
    (await api<RoomReply>(d, "GET", `/rooms/${room.id}`)).body.status,
    "active",
  );
  await press("\r", "work nobody committed");
  assert.match(plainText(out()).replaceAll(" ", ""), /draft\.txt/);
  assert.match(plainText(out()), /commit or remove them/);
  assert.equal(
    (await api<RoomReply>(d, "GET", `/rooms/${room.id}`)).body.status,
    "dismissed",
  );
  await access(draft);
  await rm(draft);
  await press("/delete\r", "delete · 1 branch");
  await press("\r", "deleted room-");
  child.stdin.write(LEAVE);
  assert.equal(await exited, 0, out());
});

test("a delete drops the room it started on after the view moves", {
  skip: noPty,
}, async (t) => {
  const wrapper = join(await tempDir(t), "slow-agent.sh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nnode ${MOCK_AGENT} --scenario remember\nsleep 2\n`,
    { mode: 0o755 },
  );
  const { screen, d, doomed, kept } = await twoRoomPty(t, wrapper);
  screen.child.stdin.write("/delete\r");
  await screen.seen("delete · 1 branch");
  screen.child.stdin.write("\r");
  // The delete is still waiting for the slow harness to stop. Move past
  // doomed's participant row to the kept room's timeline.
  await new Promise((ok) => setTimeout(ok, 100));
  await screen.press("\x1d", "ctrl+] view");
  await screen.press("\x1b[1;3B\x1b[1;3B", "→ bob");
  await screen.seen("deleted room-");
  await new Promise((ok) => setTimeout(ok, 200));

  const rows = [...screenRows(screen.out()).values()].join("\n");
  assert.match(rows, /○ bob/);
  assert.doesNotMatch(rows, /doomed/);
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
  assert.equal((await api(d, "GET", `/rooms/${doomed.id}`)).status, 404);
  assert.equal((await api(d, "GET", `/rooms/${kept.id}`)).status, 200);
});

test("a delete confirms the room its preview showed, not the current view", {
  skip: noPty,
}, async (t) => {
  const { screen, d, doomed, kept } = await twoRoomPty(t, REMEMBER);
  screen.child.stdin.write("/delete\r");
  await screen.seen("delete · 1 branch");
  // Move past doomed's participant row to kept, then return the keys to the
  // stale preview and confirm.
  await screen.press("\x1d", "ctrl+] view");
  await screen.press("\x1b[1;3B\x1b[1;3B", "→ bob");
  await screen.press("\x1d", "ctrl+] type");
  await screen.press("\r", "deleted room-");

  assert.equal((await api(d, "GET", `/rooms/${doomed.id}`)).status, 404);
  assert.equal((await api(d, "GET", `/rooms/${kept.id}`)).status, 200);
  screen.child.stdin.write(LEAVE);
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("the target's ctrl+o menu previews a fast-forward from another participant", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out, d } = await chatOnPty(t);
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.ok(room);
  const full = await api<RoomReply>(d, "GET", `/rooms/${room.id}`);
  assert.equal(full.status, 200, JSON.stringify(full.body));
  const dev = only(full.body);
  await commitAt(dev.worktree, "dev.txt");

  const addedRev = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room.id}/agents`,
    { cmd: REMEMBER, name: "reviewer", base: dev.branch },
  );
  assert.equal(addedRev.status, 201, JSON.stringify(addedRev.body));
  await commitAt(addedRev.body.worktree, "review.txt");
  const revHead = headAt(addedRev.body.worktree);
  await seen("○ reviewer");

  // Room menu → mock-agent → its menu → fast-forward from … → reviewer.
  await press("\x0f", "agent …");
  await press("\r", "pick an agent");
  await press("\r", "mock-agent · mock-agent");
  await press(`${DOWN.repeat(5)}\r`, "fast-forward mock-agent from");
  await press("\r", "mock-agent ← reviewer · fast-forward");
  await press("\r", "moved mock-agent up to reviewer's commit");
  assert.equal(headAt(dev.worktree), revHead);
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
});

test("kapelle chat with no rooms opens the screen, and says how to open one", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  screen.child.stdin.write(LEAVE);
  await screen.seen("left the chat");
  assert.equal(await screen.exited, 0, screen.out());
});

test("kapelle chat with no rooms refuses /add on the status line, and leave in the menu ends the chat", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await screen.press("/add\r", "no room: open one first");
  // The menu's last row is leave; up from the first one wraps to it. The
  // keys reach the screen in order, so Enter picks the row up moved to.
  await screen.press("\x0f", "leave");
  await screen.press("\x1b[A", "leave");
  screen.child.stdin.write("\r");
  await screen.seen("left the chat");
  assert.equal(await screen.exited, 0, screen.out());
});

// --- room commands (M4-5) -----------------------------------------------------

const DOWN = "\x1b[B";

test("ctrl+o in a thread opens that agent's menu over the timeline, and a mode pick reaches its route", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("\x1b[1;3B", "@mock-agent");
  await press("\x0f", "cancel turn");
  // cancel turn, mode: Enter opens the pick list, on the current mode.
  await press(`${DOWN}\r`, "mock-agent · mode");
  await press(`${DOWN}\r`, "mock-agent is now in ask mode");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const full = await api<RoomReply>(d, "GET", `/rooms/${room?.id}`);
  assert.equal(only(full.body).mode, "ask");
  // The menu names the new mode, and Esc closes it.
  // Esc alone, or it and the next key read as alt+key.
  await press("\x0f", "mode · ask");
  child.stdin.write("\x1b");
  await new Promise((ok) => setTimeout(ok, 300));
  await press("x", "@mock-agent x");
  await press(LEAVE, "rejoin with");
  assert.equal(await exited, 0, out());
  // The status line said it; the transcript never did.
  assert.doesNotMatch(scrollback(out()), /is now in ask mode/);
});

test("Esc in a second-level pop-up goes back to the menu", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  await seen("○ mock-agent");
  // Room menu → agent list → agent menu.
  await press("\x0f", "agent …");
  await press("\r", "pick an agent");
  await press("\r", "mock-agent · mock-agent");
  // Each second-level list returns to the agent's menu on Esc.
  await press(`${DOWN}\r`, "mock-agent · mode");
  await press("\x1b", "role · developer");
  await press(`${DOWN.repeat(2)}\r`, "mock-agent · role");
  await press("\x1b", "rename …");
  await press(`${DOWN.repeat(3)}\r`, "rename mock-agent");
  await press("\x1b", "mode · auto");
  // The agent's menu came from `pick an agent`, so Esc returns to the room menu.
  await press("\x1b", "add agent …");
  // Enter proves it is the room menu: its first row opens `pick an agent`.
  await press("\r", "pick an agent");
  // That list's Esc comes back to the room menu.
  await press("\x1b", "add agent …");
  // The room's menu is first-level: Esc closes the pop-up.
  await press("\x1b", "enter to send");
  // The add-agent form returns to the room's menu too.
  await press("\x0f", "agent …");
  await press(`${DOWN}\r`, "harness");
  await press("\x1b", "agent …");
  await press("\x1b", "enter to send");
  child.stdin.write(LEAVE);
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
});

test("/add alone opens its form; a refusal stays in the form, and a fix adds the agent", {
  skip: noPty,
}, async (t) => {
  const { press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("/add\r", "add agent");
  // command, then name: each Enter opens a text box, and Enter keeps it.
  await press(`${DOWN}\r`, "> ");
  await press(`${REMEMBER}\r`, "Enter/Space");
  await press(`${DOWN}\rmock-agent\r`, "mock-agent");
  // Down to the last row, `add`: the name is taken.
  await press(`${DOWN.repeat(4)}\r`, "is taken");
  // Up to the name, clear it, and send again.
  await press(`${"\x1b[A".repeat(4)}\r\x15bob\r`, "bob");
  await press(`${DOWN.repeat(4)}\r`, "added bob (mock-agent, auto)");
  await seen("○ bob");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.deepEqual(
    room?.participants.map((p) => p.name),
    ["mock-agent", "bob"],
  );
  await press(LEAVE, "rejoin with");
  assert.equal(await exited, 0, out());
});

test("a double Enter on the new-room form opens one room", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const { press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  await press(`\r\x15${cwd}\r`, cwd);
  // Down to `open`, and Enter twice before the first answer.
  await press(`${DOWN.repeat(5)}\r\r`, "opened room");
  // No event says a second request was not sent: give it time to land.
  await new Promise((ok) => setTimeout(ok, 1500));
  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  assert.equal(rooms.body.length, 1, JSON.stringify(rooms.body));
  await press(LEAVE, "rejoin with");
  assert.equal(await exited, 0, out());
});

test("kapelle chat with no rooms opens one with /new, and shows its timeline", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await screen.press(
    `/new --cmd "${REMEMBER}" --title fix --cwd ${cwd}\r`,
    "opened room fix",
  );
  await screen.press("hello\r", "previous: (none)");
  await screen.press(LEAVE, "rejoin with");
  assert.equal(await screen.exited, 0, screen.out());
});

test("the menu opens over the timeline with the sidebar hidden; a typed agent command with no @name is refused on the status line", {
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
  await screen.seen(`room ${open.body.id}`);
  assert.ok(!screen.out().includes("«"), "the sidebar starts hidden");
  // The timeline's menu: the agent list first, then the room's commands.
  // It opens over the timeline, so the sidebar stays hidden.
  await screen.press("\x0f", "agent …");
  assert.ok(!screen.out().includes("«"), "the sidebar stays hidden");
  // ctrl+o again closes it, and the composer has the keys again.
  screen.child.stdin.write("\x0f");
  await new Promise((ok) => setTimeout(ok, 300));
  await screen.press("/remove\r", "! name the agent: @name /remove");
  // Refused before any request: the agent is still there.
  const room = await api<RoomReply>(d, "GET", `/rooms/${open.body.id}`);
  assert.equal(room.body.participants.length, 1);
  await screen.press(LEAVE, "rejoin with");
  assert.equal(await screen.exited, 0, screen.out());
});

test("after the last agent is removed, the status line names no one and a message is refused before any request", {
  skip: noPty,
}, async (t) => {
  const { press, seen, exited, out, d } = await chatOnPty(t);
  // The roster the daemon sent at the start named mock-agent; it must not
  // stand in for the empty one now. The reply's status line and the
  // stream's roster line race, so wait for each, in either order.
  await press("@mock-agent /remove\r", "removed mock-agent");
  await seen("! no agents: ctrl+o → add agent");
  const from = out().length;
  await press("hi\r", "! no agents: ctrl+o → add agent");
  assert.doesNotMatch(out().slice(from), /→ mock-agent|you → /);
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.deepEqual(room?.participants, []);
  await press(LEAVE, "rejoin with");
  assert.equal(await exited, 0, out());
});

test("the chat opens the setup list at start until done, and /setup opens it again (M9-3)", {
  skip: noPty,
}, async (t) => {
  const { d, runtime } = await bootFinding(t, await fakePath(t));
  const { child, press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    // The last row of the list: a frame comes in pieces, top to bottom.
    "Enter done · Esc later",
  );
  assert.match(out(), /needs claude-agent-acp/);
  // Enter is "done": the list closes, and the daemon keeps it.
  await press("\r", "setup done");
  const r = await api<HarnessesReply>(d, "GET", "/harnesses");
  assert.equal(r.body.done, true);
  // `/setup` opens it again, with a new find. Esc closes it.
  await press("/setup\r", "needs claude-agent-acp");
  child.stdin.write("\x1b");
  await new Promise((ok) => setTimeout(ok, 300));
  await press(LEAVE, "left the chat");
  assert.equal(await exited, 0, out());

  // The next start: done, and an agent is ready, so no list.
  const next = await ptyScreen(t, "stty cols 120 rows 40; node cli.ts chat", {
    XDG_RUNTIME_DIR: runtime,
  });
  await new Promise((ok) => setTimeout(ok, 1000));
  assert.doesNotMatch(next.out(), /Enter done · Esc later/);
  await next.press(LEAVE, "left the chat");
  assert.equal(await next.exited, 0, next.out());
});

test("the chat opens the setup list at every start while no agent is ready, done or not (M9-3)", {
  skip: noPty,
}, async (t) => {
  const { d, runtime } = await bootFinding(t, await tempDir(t));
  assert.equal(
    (await api<HarnessesReply>(d, "POST", "/harnesses/done")).body.done,
    true,
  );
  const { child, press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "No agent is ready",
  );
  child.stdin.write("\x1b");
  await new Promise((ok) => setTimeout(ok, 300));
  await press(LEAVE, "left the chat");
  assert.equal(await exited, 0, out());
});

test("the new-room form completes a folder with Tab, lists the measured harnesses, and adds an unadded folder on yes", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const repo = await gitRepo(t); // never added
  const tmp = await tempDir(t);
  await mkdir(join(tmp, "alpha-1"));
  await mkdir(join(tmp, "alpha-2"));
  const { child, press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  // folder: Tab lists the two folders that match.
  await press(`\r\x15${tmp}/al\t`, "alpha-1/  alpha-2/");
  await press(`\x15${repo}\r`, "Enter/Space");
  // harness: a pick list of the measured ones. Esc keeps the row as it was.
  await press(`${DOWN}${DOWN}\r`, "claude");
  // Every registry entry is measured (M9 D2), so each one is offered.
  assert.deepEqual(pickList(out()), [
    "–",
    ...Object.keys(AGENTS).sort((a, b) => a.localeCompare(b)),
    "other…",
  ]);
  child.stdin.write("\x1b");
  await new Promise((ok) => setTimeout(ok, 300));
  // command, then open: the folder is not added, so the form asks.
  // Only the rows that change are drawn again, so wait for the value. The
  // row cuts a long one, so wait for its start: a checkout with a long path
  // never shows `mock-agent.mjs`.
  await press(`${DOWN}\r${REMEMBER}\r`, REMEMBER.slice(0, 40));
  await press(
    `${DOWN}${DOWN}\r`,
    "is not added to the daemon. Add its repository?",
  );
  await press("\r", "opened room");
  const [room] = (await api<RoomListEntry[]>(d, "GET", "/rooms")).body;
  assert.deepEqual(
    room?.participants.map((p) => [p.name, p.role]),
    [["mock-agent", "developer"]],
  );
  const repos = await api<string[]>(d, "GET", "/repos");
  assert.deepEqual(repos.body, [await realpath(repo)]);
  await press(LEAVE, "rejoin with");
  assert.equal(await exited, 0, out());
});

test("the new-room form leaves out a harness the daemon says is not measured", {
  skip: noPty,
}, async (t) => {
  // The registry has no unmeasured entry today (M9 D2), so a fake daemon
  // sends one: the filter is the only thing that keeps it out.
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const fake = createServer((req, res) => {
    const body =
      req.url === "/version"
        ? { apiVersion: API_VERSION }
        : req.url === "/harnesses"
          ? [
              { id: "lab-ok", measured: true },
              { id: "lab-none", measured: false },
            ]
          : req.url === "/rooms"
            ? []
            : undefined;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: { code: "no_route" } }));
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  t.after(() => fake.close());
  const { port } = fake.address() as AddressInfo;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: process.pid, port, token: "t" }),
    { mode: 0o600 },
  );
  const { press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node chat.ts",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  // folder, title, harness: the harness row's pick list.
  await press(`${DOWN}${DOWN}\r`, "other…");
  assert.deepEqual(pickList(out()), ["–", "lab-ok", "other…"]);
  await press(`\x1b\x1b${LEAVE}`, "left the chat");
  assert.equal(await exited, 0, out());
});

test("chat in a removed folder: bare stops, attach opens and its /new form survives", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const room = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(room.status, 201, room.body.error?.message);
  const inGone = async (verb: string, until?: string) => {
    const gone = await tempDir(t);
    const cmd =
      `stty cols 120 rows 40; cd '${gone}' && rmdir '${gone}' && ` +
      `exec node '${join(REPO, "chat.ts")}'${verb}`;
    return ptyScreen(t, cmd, { XDG_RUNTIME_DIR: runtime }, until);
  };

  // Bare `kapelle chat` stops before the screen opens.
  const bare = await inGone("", "the current folder was removed");
  assert.equal(await bare.exited, 1, bare.out());

  // `attach` needs no folder, so the screen opens.
  const { child, seen, exited, out } = await inGone(
    ` attach '${room.body.id}'`,
  );
  child.stdin.write("/new\r");
  await seen("new room");
  // A relative folder in a removed cwd is refused in the form, not a crash.
  child.stdin.write(`\rsub\r${DOWN.repeat(5)}\r`);
  await seen("the current folder was removed");
  // Esc closes the form, so /leave still reaches the composer.
  child.stdin.write("\x1b");
  await new Promise((ok) => setTimeout(ok, 300));
  child.stdin.write("/leave\r");
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
});

test("the room view's menu picks an agent, and a rename reaches its route", {
  skip: noPty,
}, async (t) => {
  const { press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  // The room's menu lists the agents first; the agent's menu then holds its
  // own commands. Rename is the fourth: cancel, mode, role, rename.
  await press("\x0f", "agent …");
  await press("\r", "pick an agent");
  await press("\r", "mock-agent · mock-agent");
  await press(`${DOWN.repeat(3)}\r`, "rename mock-agent");
  await press("\x15bob\r", "renamed mock-agent to bob");
  await seen("○ bob");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.deepEqual(
    room?.participants.map((p) => p.name),
    ["bob"],
  );
  await press(LEAVE, "rejoin with");
  assert.equal(await exited, 0, out());
});

test("the row keys do nothing while a pop-up is open, so a form keeps what was typed", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("/add\r", "add agent");
  // The command row's text box: type, press both row-key sets, type on.
  await press(`${DOWN}\r`, "> ");
  await press("abc", "abc");
  // Nothing changes, so nothing is drawn: wait, then prove the box is there.
  child.stdin.write("\x0e\x10\x1b[1;3B\x1b[1;3A");
  await new Promise((ok) => setTimeout(ok, 300));
  await press("d\r", "abcd");
  await press(LEAVE, "rejoin with");
  assert.equal(await exited, 0, out());
});

test("the status line swaps its key hint while a pop-up is open", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  // The box's own footer is `↑↓ Enter · Esc back`; the status line must not
  // still promise the row keys the pop-up took.
  await press("\x0f", "esc back · ctrl+o close");
  // Closing it puts the composer's hint back.
  await press(
    "\x0f",
    "enter to send · ctrl+o menu · alt+↑↓ rows · ctrl+t rooms",
  );
  child.stdin.write(LEAVE);
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
});

test("the menu's help row shows the commands", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const { press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  // With no room, the menu is: new room …, help, leave.
  await press("\x0f", "new room …");
  await press(`${DOWN}\r`, "@name /mode <ask|safe|auto>");
  // Help is a second-level pop-up: Esc returns to the menu.
  await press("\x1b", "new room …");
  await press("\x1b", "enter to send");
  await press(LEAVE, "left the chat");
  assert.equal(await exited, 0, out());
});

test("Esc in a form opened from the menu goes back to the menu", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const { press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  // Esc returns to the menu; a second Esc still closes it.
  await press("\x1b", "new room …");
  await press("\x1b", "enter to send");
  await press(LEAVE, "left the chat");
  assert.equal(await exited, 0, out());
});

test("Esc in the folder-not-added prompt goes back to the new-room form", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const repo = await gitRepo(t); // never added
  const { child, press, seen, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  await press(`\r\x15${repo}`, repo);
  await press("\r", "Enter/Space");
  // Open on an unadded folder: the daemon asks to add the repo.
  await press(
    `${DOWN.repeat(5)}\r`,
    "is not added to the daemon. Add its repository?",
  );
  // Esc returns to the form, with the folder still there.
  const from = out().length;
  await press("\x1b", "Enter/Space to change");
  assert.ok(
    plainText(out().slice(from)).includes(repo),
    plainText(out().slice(from)),
  );
  child.stdin.write(LEAVE);
  await seen("left the chat");
  assert.equal(await exited, 0, out());
});

// --- a room across a restart (M6-7a, #151) ----------------------------------

test("adding a folder's repository while the daemon is away says so, and the screen stays", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const repo = await gitRepo(t); // never added
  const screen = await ptyScreen(
    t,
    "stty cols 130 rows 30; node chat.ts",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  // The add fails before any harness starts, so the command is never run.
  await screen.press(
    `/new --cmd mock --cwd ${repo}\r`,
    "is not added to the daemon",
  );
  process.kill(d.pid, "SIGKILL");
  await d.done;
  // Enter picks "add and open", the first row (M6-7d: the screen waits).
  await screen.press("\r", "the daemon did not answer");
  const r = await Promise.race([
    screen.exited,
    new Promise((ok) => setTimeout(() => ok("open"), 500)),
  ]);
  assert.equal(r, "open", plainText(screen.out()));
});
