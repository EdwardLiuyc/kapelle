/**
 * The pop-up's top border — `chat/tui/panel.ts`, story M7-4 (#247) — and
 * the setup race guards (M9-3, #298), and the ctrl+o menu's filter, slash
 * commands and `open` rows (M7-5, #248), and the forms' harness row:
 * ready agents only, and refreshed by each find and install (#367).
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { parseCommand, type RouteCommand } from "../../client/command.ts";
import type {
  HarnessesReply,
  ParticipantDto,
  RoomDto,
} from "../../client/contract.ts";
import type { DaemonAddress } from "../../client/daemon.ts";
import { loopFolders } from "../../client/loop.ts";
import { newRoomState, type RoomState } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { tempDir, until } from "../../integration/helpers.ts";
import { yellow } from "../common.ts";
import { border, panelParts } from "../tui/panel.ts";

test("the top border keeps its corner and the title's start at any width, and the count gives way first (M7-4)", () => {
  const title = "asker wants to edit";
  const plain = (t: string, right: string | undefined, width: number) =>
    stripTerminalSequences(border(t, right, width, yellow));
  assert.equal(
    plain(title, "1 of 2", 40),
    `┏ ${title} ${"━".repeat(8)} 1 of 2 ━┓`,
  );
  assert.equal(plain(title, undefined, 30), `┏ ${title} ${"━".repeat(7)}┓`);
  // Too narrow for both: the count goes, and a cut title says so.
  assert.equal(plain(title, "1 of 2", 15), "┏ asker wan… ━┓");
  assert.equal(plain(title, "1 of 2", 10), "┏ aske… ━┓");
  for (let width = 10; width <= 80; width += 1) {
    for (const right of [undefined, "1 of 2", "10 of 12"]) {
      const line = border(title, right, width, yellow);
      assert.equal(visibleWidth(line), width, `${width} ${right}: ${line}`);
      assert.ok(plain(title, right, width).startsWith("┏ a"), line);
    }
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

const reply = (done = false): HarnessesReply => ({
  checkedAt: "now",
  done,
  harnesses: [
    {
      id: "pi",
      measured: true,
      state: "ready",
      program: "pi",
      version: "1.3.0",
      acpProgram: "pi-acp",
      acpVersion: "0.0.34",
    },
    {
      id: "claude",
      measured: true,
      state: "main_only",
      program: "claude",
      version: "2.1.307",
      acpProgram: "claude-agent-acp",
      install: "npm i -g @agentclientprotocol/claude-agent-acp@0.89.1",
    },
  ],
});

/** The same find after the fake install put claude-agent-acp in place. */
const installedReply = (): HarnessesReply => ({
  checkedAt: "now",
  done: false,
  harnesses: [
    {
      id: "claude",
      measured: true,
      state: "ready",
      program: "claude",
      version: "2.1.307",
      acpProgram: "claude-agent-acp",
      acpVersion: "0.89.1",
    },
  ],
});

async function fakeDaemon(
  t: TestContext,
  {
    holdGet = false,
    holdDone = false,
    holdPost = false,
    holdInstall = false,
    got = reply(),
    found = reply(),
    installed = installedReply(),
    room,
  }: {
    holdGet?: boolean;
    holdDone?: boolean;
    holdPost?: boolean;
    holdInstall?: boolean;
    /** What `GET /harnesses` and `POST /harnesses` (a new find) answer. */
    got?: HarnessesReply;
    found?: HarnessesReply;
    /** The find at the end of `POST /harnesses/install`. */
    installed?: HarnessesReply;
    /** Whose `GET /rooms/r/agents/:id` answers, for `@name /model`
     *  (M9-6). */
    room?: RoomDto;
  } = {},
) {
  const getSeen = deferred();
  const getRelease = deferred();
  const doneSeen = deferred();
  const doneRelease = deferred();
  const postRelease = deferred();
  const installSeen = deferred();
  const installRelease = deferred();
  let installBody: unknown;
  let posts = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const agent = room?.participants.find(
        (p) => req.url === `/rooms/r/agents/${p.id}`,
      );
      if (agent && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(agent));
        return;
      }
      if (req.method === "GET" && req.url === "/harnesses") {
        getSeen.resolve();
        if (holdGet) await getRelease.promise;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(got));
        return;
      }
      if (req.method === "POST" && req.url === "/harnesses") {
        posts++;
        if (holdPost) await postRelease.promise;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(found));
        return;
      }
      if (req.method === "POST" && req.url === "/harnesses/done") {
        doneSeen.resolve();
        if (holdDone) await doneRelease.promise;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply(true)));
        return;
      }
      if (req.method === "POST" && req.url === "/harnesses/install") {
        let text = "";
        for await (const chunk of req) text += chunk;
        installBody = JSON.parse(text);
        installSeen.resolve();
        if (holdInstall) await installRelease.promise;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(
          `${JSON.stringify({ id: "claude", command: "npm i -g x@1" })}\n`,
        );
        res.end(`${JSON.stringify({ failed: [], setup: installed })}\n`);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "no_route", message: "no" } }));
    })();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(
    () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  );
  const d: DaemonAddress = {
    port: (server.address() as AddressInfo).port,
    token: "test",
  };
  return {
    d,
    getSeen,
    getRelease,
    doneSeen,
    doneRelease,
    postRelease,
    installSeen,
    installRelease,
    installBody: () => installBody,
    posts: () => posts,
  };
}

function makeBox(
  d: DaemonAddress,
  {
    onSay,
    onStatus,
    rooms = new Map(),
    view = { roomId: "r" },
    open = () => {},
    run = async () => true,
  }: {
    onSay?: (text: string) => void;
    onStatus?: () => void;
    rooms?: ReadonlyMap<string, Followed>;
    view?: { roomId: string; participantId?: string };
    open?: (next: { roomId: string; participantId?: string }) => void;
    run?: (c: RouteCommand) => Promise<boolean>;
  } = {},
) {
  return panelParts({
    d,
    fresh: async () => {},
    tui: {
      showOverlay: () => ({ hide() {} }),
      setFocus() {},
      requestRender() {},
    },
    editor: {},
    queue: {
      asking: false,
      show() {},
      away: () => false,
      open: () => [],
    },
    rooms,
    view: () => view,
    shown: () => true,
    say: onSay ?? (() => {}),
    setStatus: onStatus ?? (() => {}),
    offer() {},
    question() {},
    changes() {},
    forward() {},
    open,
    run,
    end() {},
    left: () => "",
  } as unknown as Parameters<typeof panelParts>[0]);
}

test("startup still opens setup when the person has not touched it", async (t) => {
  const fake = await fakeDaemon(t);
  const box = makeBox(fake.d);
  await box.atStart();
  assert.equal(box.panel?.title, "agents");
  assert.equal(fake.posts(), 1);
});

test("a late startup reply does not reopen setup after a manual close", async (t) => {
  const fake = await fakeDaemon(t, { holdGet: true });
  const box = makeBox(fake.d);
  const starting = box.atStart();
  await fake.getSeen.promise;

  // The person opens /setup while the startup GET is pending, then closes it.
  await box.showSetup();
  assert.equal(box.panel?.title, "agents");
  box.hidePanel();
  assert.equal(box.panel, undefined);

  fake.getRelease.resolve();
  await starting;
  assert.equal(
    box.panel,
    undefined,
    "the late startup GET must not reopen setup after the person closed it",
  );
  assert.equal(fake.posts(), 1);
});

test("a stale done reply does not close a newer setup panel", async (t) => {
  const fake = await fakeDaemon(t, { holdDone: true });
  const box = makeBox(fake.d);
  await box.showSetup();
  assert.equal(box.panel?.title, "agents");

  const finishing = box.setupDone();
  await fake.doneSeen.promise;
  box.hidePanel();

  await box.showSetup();
  const newer = box.panel?.body;
  assert.ok(newer, "a newer setup panel is open");

  fake.doneRelease.resolve();
  await finishing;
  assert.equal(
    box.panel?.body,
    newer,
    "the earlier markDone answer must not close the newer setup panel",
  );

  // A direct /setup done still closes the current setup panel.
  await box.setupDone();
  assert.equal(box.panel, undefined);

  // A different panel with the same title is not a setup panel.
  const unrelated = { render: () => [], invalidate() {} };
  box.showPanel("agents", unrelated);
  const shown = box.panel;
  assert.ok(shown, "an unrelated panel titled agents is open");
  await box.setupDone();
  assert.equal(
    box.panel,
    shown,
    "an unrelated panel titled agents must not be closed",
  );
});

test("the start draws the reply it holds while the daemon finds again", async (t) => {
  const fake = await fakeDaemon(t, { holdPost: true });
  const box = makeBox(fake.d);
  const starting = box.atStart();
  // The GET's list shows at once, not "looking for agents…".
  for (let i = 0; i < 100 && fake.posts() === 0; i++) {
    await new Promise((ok) => setTimeout(ok, 10));
  }
  assert.equal(fake.posts(), 1);
  const lines = box.panel?.body.render(80).join("\n") ?? "";
  assert.match(lines, /pi +ready \(pi 1\.3\.0, pi-acp 0\.0\.34\)/);
  assert.doesNotMatch(lines, /looking for agents/);
  fake.postRelease.resolve();
  await starting;
  assert.equal(box.panel?.title, "agents");
});

test("an install that ends after Esc says so on the status line", async (t) => {
  const fake = await fakeDaemon(t, { holdInstall: true });
  const said: string[] = [];
  let statusCalls = 0;
  const box = makeBox(fake.d, {
    onSay: (text) => said.push(text),
    onStatus: () => {
      statusCalls++;
    },
  });
  await box.showSetup();
  const list = box.panel?.body;
  assert.ok(list, "the setup list is open");
  assert.match(list.render(80).join("\n"), /\[ \] claude/);
  list.handleInput?.(" ");
  assert.match(box.panel?.body.render(80).join("\n") ?? "", /\[x\] claude/);
  list.handleInput?.("\r");
  await fake.installSeen.promise;
  assert.deepEqual(fake.installBody(), { ids: ["claude"] });

  // The person hides the output; npm goes on, and the result must reach the
  // status line, not only a `say` the next status refresh may drop.
  box.hidePanel();
  const atHide = statusCalls;
  fake.installRelease.resolve();
  await until("the install's result", () =>
    said.some((s) => s.includes("setup: installed claude")),
  );
  assert.ok(
    statusCalls > atHide,
    "the status line is told the install ended after the panel is gone",
  );
});

test("the start does not open setup over a busy side view", async (t) => {
  const fake = await fakeDaemon(t);
  const box = makeBox(fake.d);
  await box.atStart(() => true);
  assert.equal(box.panel, undefined);
  assert.equal(fake.posts(), 0);
});

/** A followed room `id`, titled `title`, whose roster is these names, each
 *  id `p-<name>`. */
const followed = (id: string, title: string, names: string[]): Followed => {
  const state: RoomState = newRoomState();
  for (const name of names) {
    state.participants.set(`p-${name}`, {
      id: `p-${name}`,
      name,
      harness: "mock",
      mode: "safe",
      status: "idle",
      removed: false,
      turns: [],
      queue: [],
      unread: 0,
    });
  }
  return { entry: { id, title }, state } as unknown as Followed;
};
const NO_DAEMON_YET: DaemonAddress = { port: 0, token: "test" };
const twoRooms = () =>
  new Map([
    ["r1", followed("r1", "app", ["ann", "bob"])],
    ["r2", followed("r2", "docs", ["cid"])],
  ]);
/** The open pop-up's lines, without their SGR codes. */
const shownOf = (box: ReturnType<typeof makeBox>) =>
  stripTerminalSequences(box.panel?.body.render(70).join("\n") ?? "");
const type = (box: ReturnType<typeof makeBox>, keys: string) => {
  for (const k of keys) box.panel?.body.handleInput?.(k);
};
const pressKey = (box: ReturnType<typeof makeBox>, key: string) =>
  box.panel?.body.handleInput?.(key);
const down = (box: ReturnType<typeof makeBox>, count: number) => {
  for (let i = 0; i < count; i++) pressKey(box, "\x1b[B");
};
/** Assert that `command` is on `label`'s row, after a gap of spaces. */
const assertCommandRight = (rows: string, label: string, command: string) => {
  const labelAt = rows.indexOf(label);
  assert.notEqual(labelAt, -1, `${label} is shown`);
  const commandAt = rows.indexOf(command, labelAt + label.length);
  assert.notEqual(commandAt, -1, `${label} shows ${command}`);
  assert.match(rows.slice(labelAt + label.length, commandAt), /^ +$/, label);
};

test("each menu row shows its slash command on the right (M7-5)", () => {
  const room = makeBox(NO_DAEMON_YET, {
    rooms: twoRooms(),
    view: { roomId: "r1" },
  });
  room.menu();
  const roomRows = shownOf(room);
  for (const [label, command] of [
    ["add agent …", "/add"],
    ["rename room …", "/title"],
    ["new room …", "/new"],
    ["loop …", "/loop"],
    ["dismiss room", "/dismiss"],
    ["delete room …", "/delete"],
    ["help", "/help"],
  ]) {
    assertCommandRight(roomRows, label, command);
  }

  // The loop row makes the room menu one row taller than its viewport.
  type(room, "leave");
  assert.match(shownOf(room), /→ leave +\/leave/);
  type(room, "\x15loop\r");
  assert.equal(room.panel?.title, "loop", "the menu opens the loop form");

  const thread = makeBox(NO_DAEMON_YET, {
    rooms: twoRooms(),
    view: { roomId: "r1", participantId: "p-ann" },
  });
  thread.menu();
  const agentRows = shownOf(thread);
  for (const [label, command] of [
    ["cancel turn", "/cancel"],
    ["mode · safe", "/mode"],
    ["model …", "/model"],
    ["role · none", "/role"],
    ["rename …", "/rename"],
    ["view changes", "/diff"],
    ["fast-forward from …", "/ff"],
    ["remove ann", "/remove"],
  ]) {
    assertCommandRight(agentRows, label, command);
  }
});

test("typed letters narrow the menu, Backspace widens it, and Enter runs the top row (M7-5)", () => {
  const box = makeBox(NO_DAEMON_YET, {
    rooms: twoRooms(),
    view: { roomId: "r1", participantId: "p-ann" },
  });
  box.menu();
  const all = shownOf(box);
  assert.match(all, /cancel turn/);
  type(box, "ff");
  const narrowed = shownOf(box);
  assert.match(narrowed, /> ff/);
  assert.match(narrowed, /fast-forward from …/);
  assert.doesNotMatch(narrowed, /cancel turn|remove ann|leave/);
  type(box, "\x7f\x7f");
  assert.equal(shownOf(box), all);
  type(box, "/ff");
  const byCommand = shownOf(box);
  assert.match(byCommand, /fast-forward from …/);
  assert.doesNotMatch(byCommand, /cancel turn|remove ann|leave/);
  type(box, "\r");
  assert.equal(box.panel?.title, "fast-forward ann from");
});

test("a slash-only query searches commands, and Enter runs the best row (M7-5)", () => {
  const ran: RouteCommand[] = [];
  const box = makeBox(NO_DAEMON_YET, {
    rooms: twoRooms(),
    view: { roomId: "r1", participantId: "p-ann" },
    run: async (c) => {
      ran.push(c);
      return true;
    },
  });
  box.menu();
  // Move off the top, so Enter can only pass when the filter selects its
  // best row afresh.
  for (let i = 0; i < 5; i++) box.panel?.body.handleInput?.("\x1b[B");
  type(box, "/di");
  const narrowed = shownOf(box);
  // `view changes` holds `diff` only in its right-hand slash command.
  assert.match(narrowed, /view changes +\/diff/);
  assert.match(narrowed, /→ dismiss room +\/dismiss/);
  type(box, "\r");
  assert.deepEqual(ran, [{ verb: "dismiss" }]);
});

test("Esc first clears the filter, then goes back (M7-5)", () => {
  const box = makeBox(NO_DAEMON_YET, {
    rooms: twoRooms(),
    view: { roomId: "r1" },
  });
  box.menu();
  const all = shownOf(box);
  type(box, "zzz");
  assert.notEqual(shownOf(box), all);
  type(box, "\x1b");
  assert.equal(box.panel?.title, "app", "the menu stays open");
  assert.equal(shownOf(box), all);
  type(box, "\x1b");
  assert.equal(box.panel, undefined);
});

test("the menu has an open row for each room and agent but the open view, and it opens that view (M7-5)", () => {
  const opened: unknown[] = [];
  const box = makeBox(NO_DAEMON_YET, {
    rooms: twoRooms(),
    view: { roomId: "r1", participantId: "p-ann" },
    open: (next) => opened.push(next),
  });
  box.menu();
  // The menu is longer than the box: the filter brings the rows in view.
  type(box, "open");
  const shown = shownOf(box);
  assert.match(shown, /open app\b/);
  assert.match(shown, /open @bob +app/);
  assert.match(shown, /open docs\b/);
  assert.match(shown, /open @cid +docs/);
  assert.doesNotMatch(shown, /open @ann/, "the open view is left out");
  type(box, " cid\r");
  assert.deepEqual(opened, [{ roomId: "r2", participantId: "p-cid" }]);
});

test("every pick list in a form filters: the role list narrows (M7-5)", () => {
  const box = makeBox(NO_DAEMON_YET, {
    rooms: twoRooms(),
    view: { roomId: "r1" },
  });
  box.addForm();
  const form = box.panel?.body;
  assert.ok(form, "the add form is open");
  for (let i = 0; i < 3; i++) form.handleInput?.("\x1b[B");
  form.handleInput?.("\r");
  assert.match(shownOf(box), /none/);
  assert.match(shownOf(box), /reviewer/);
  type(box, "dev");
  const narrowed = shownOf(box);
  assert.match(narrowed, /developer/);
  assert.doesNotMatch(narrowed, /orchestrator|tester|architect|reviewer/);
  type(box, "\r");
  assert.match(shownOf(box), /role\s+developer/);
});

test("command rows keep their slash command at the default 80-column panel width (M7-5)", () => {
  const rooms = new Map([
    ["r1", followed("r1", "app", ["ann"])],
    ["r2", followed("r2", "a room title long enough to fill the label", [])],
  ]);
  const box = makeBox(NO_DAEMON_YET, {
    rooms,
    view: { roomId: "r1" },
  });
  box.menu();
  // At 80 columns with the sidebar shown, the pop-up is 44 wide and its
  // body gets 40; the menu is what the person sees at the default size.
  const shown = stripTerminalSequences(
    box.panel?.body.render(40).join("\n") ?? "",
  );
  // Anchored: the whole row is the label, the command and padding, so a
  // crop that cut the command or added a stray `…` fails here.
  assert.match(shown, /^ {2}new room … +\/new *$/m);
  assert.match(shown, /^ {2}help +\/help *$/m);

  // A label cut to fit says so: a long name must not read as another name.
  const thread = makeBox(NO_DAEMON_YET, {
    rooms: new Map([["r1", followed("r1", "app", ["reviewer-backend"])]]),
    view: { roomId: "r1", participantId: "p-reviewer-backend" },
  });
  thread.menu();
  const cut = stripTerminalSequences(
    thread.panel?.body.render(40).join("\n") ?? "",
  );
  assert.match(cut, /remove reviewer-bac… +\/remove/);
  assert.match(cut, /cancel turn +\/cancel/);
});

test("clearing the filter puts the cursor back on the current value (M7-5)", () => {
  const box = makeBox(NO_DAEMON_YET, {
    rooms: twoRooms(),
    view: { roomId: "r1", participantId: "p-ann" },
  });
  box.menu();
  type(box, "/mode\r");
  assert.equal(box.panel?.title, "ann · mode");
  assert.match(shownOf(box), /→ safe/);
  type(box, "a\x7f");
  assert.match(shownOf(box), /→ safe/, "Backspace to empty");
  type(box, "a\x1b");
  assert.equal(box.panel?.title, "ann · mode", "Esc clears, the list stays");
  assert.match(shownOf(box), /→ safe/, "Esc to empty");
});

test("Enter on a filter that matches nothing runs nothing and keeps the box (M7-5)", () => {
  const ran: RouteCommand[] = [];
  const opened: unknown[] = [];
  const box = makeBox(NO_DAEMON_YET, {
    rooms: twoRooms(),
    view: { roomId: "r1" },
    open: (next) => opened.push(next),
    run: async (c) => {
      ran.push(c);
      return true;
    },
  });
  box.menu();
  type(box, "zzz");
  assert.match(shownOf(box), /No matching/);
  type(box, "\r");
  assert.equal(box.panel?.title, "app");
  assert.deepEqual(ran, []);
  assert.deepEqual(opened, []);
});

/** Room `r` with ann on `model`, her live list `models`. */
const annRoom = (
  models: ParticipantDto["models"],
  model?: string,
): RoomDto => ({
  id: "r",
  cwd: "/w",
  createdAt: "now",
  updatedAt: "now",
  status: "active",
  seq: 0,
  participants: [
    {
      id: "p-ann",
      name: "ann",
      harness: "mock-agent",
      mode: "auto",
      settings: { allowReadOutsideRoot: false },
      worktree: "/w",
      sessionId: "s",
      status: "idle",
      notices: [],
      ...(model && { model }),
      ...(models && { models }),
    },
  ],
});

test("@name /model lists the live models on the one in use, and a pick sends it (M9-6)", async (t) => {
  const fake = await fakeDaemon(t, {
    room: annRoom(
      [
        { id: "mock/fast", name: "Fast" },
        { id: "mock/smart", name: "Smart" },
      ],
      "mock/fast",
    ),
  });
  const ran: RouteCommand[] = [];
  const box = makeBox(fake.d, {
    run: async (c) => {
      ran.push(c);
      return true;
    },
  });
  await box.pickModel({ id: "p-ann", name: "ann" });
  assert.equal(box.panel?.title, "ann · model");
  const shown = shownOf(box);
  assert.match(shown, /→ mock\/fast/, "the cursor on the model in use");
  assert.match(shown, /mock\/smart/);
  assert.match(shown, /other model…/);
  type(box, "smart\r");
  assert.deepEqual(ran, [
    {
      verb: "patch",
      id: "p-ann",
      name: "ann",
      change: { model: "mock/smart" },
    },
  ]);
});

test("@name /model types an id when the list has none, or after other model… (M9-6)", async (t) => {
  for (const models of [undefined, [{ id: "a/b", name: "B" }]]) {
    const fake = await fakeDaemon(t, { room: annRoom(models) });
    const ran: RouteCommand[] = [];
    const box = makeBox(fake.d, {
      run: async (c) => {
        ran.push(c);
        return true;
      },
    });
    await box.pickModel({ id: "p-ann", name: "ann" });
    if (models) type(box, "other\r");
    assert.equal(box.panel?.title, "ann · model");
    type(box, " x/y \r");
    assert.deepEqual(
      ran.map((c) => c.verb === "patch" && c.change),
      [{ model: "x/y" }],
    );
  }
});

test("Enter on an empty model id goes back like Esc, and posts nothing (M9-6, #398 review)", async (t) => {
  const fake = await fakeDaemon(t, {
    room: annRoom([{ id: "a/b", name: "B" }], "a/b"),
  });
  const ran: RouteCommand[] = [];
  const box = makeBox(fake.d, {
    run: async (c) => {
      ran.push(c);
      return true;
    },
  });
  await box.pickModel({ id: "p-ann", name: "ann" });
  type(box, "other\r");
  assert.equal(box.panel?.title, "ann · model");
  type(box, "  \r");
  assert.deepEqual(ran, []);
  assert.equal(box.panel, undefined, "closed, as Esc closes it");
});

/** The harness row's pick list in `form` (the add or new form), one name
 *  per row, after `down` presses to reach it. Closes the form. */
const harnessPicks = (
  box: ReturnType<typeof makeBox>,
  form: () => void,
  down: number,
) => {
  form();
  for (let i = 0; i < down; i++) box.panel?.body.handleInput?.("\x1b[B");
  box.panel?.body.handleInput?.("\r");
  const rows = shownOf(box);
  box.hidePanel();
  return rows;
};

test("both forms offer only the measured agents found ready, then other… (#367)", async (t) => {
  const fake = await fakeDaemon(t, {
    got: {
      checkedAt: "now",
      done: true,
      harnesses: [
        { id: "pi", measured: true, state: "ready" },
        { id: "claude", measured: true, state: "main_only" },
        { id: "codex", measured: true, state: "not_installed" },
        { id: "kimi", measured: true },
        { id: "lab", measured: false, state: "ready" },
      ],
    },
  });
  const box = makeBox(fake.d, { rooms: twoRooms(), view: { roomId: "r1" } });
  await box.atStart();
  for (const rows of [
    harnessPicks(box, () => box.addForm(), 0),
    harnessPicks(box, () => box.newForm(), 2),
  ]) {
    assert.match(rows, /–[\s\S]*pi[\s\S]*other…/);
    assert.doesNotMatch(rows, /claude|codex|kimi|lab/);
  }
});

test("both forms still offer other… when no harness is ready (#367)", async (t) => {
  const noneReady: HarnessesReply = {
    checkedAt: "now",
    done: true,
    harnesses: [
      { id: "claude", measured: true, state: "main_only" },
      { id: "codex", measured: true, state: "not_installed" },
      { id: "old", measured: true },
    ],
  };
  const fake = await fakeDaemon(t, { got: noneReady, found: noneReady });
  const box = makeBox(fake.d, { rooms: twoRooms(), view: { roomId: "r1" } });
  await box.atStart();
  for (const rows of [
    harnessPicks(box, () => box.addForm(), 0),
    harnessPicks(box, () => box.newForm(), 2),
  ]) {
    assert.match(rows, /–[\s\S]*other…/);
    assert.doesNotMatch(rows, /claude|codex|old/);
  }
});

test("a new find and an install refresh the harness row, with no restart (#367)", async (t) => {
  const piReady = reply();
  const fake = await fakeDaemon(t, {
    got: { ...piReady, done: true },
    found: {
      ...piReady,
      harnesses: [
        ...piReady.harnesses,
        { id: "kimi", measured: true, state: "ready" },
      ],
    },
  });
  const box = makeBox(fake.d, { rooms: twoRooms(), view: { roomId: "r1" } });
  const picks = () => harnessPicks(box, () => box.addForm(), 0);
  await box.atStart();
  assert.doesNotMatch(picks(), /kimi|claude/);

  // /setup finds again: kimi is ready now.
  await box.showSetup();
  assert.match(picks(), /kimi/);

  // The setup button installs claude; the install's find has it ready.
  await box.showSetup();
  box.panel?.body.handleInput?.(" ");
  box.panel?.body.handleInput?.("\r");
  await until("the install's find", () => /claude +ready/.test(shownOf(box)));
  // The fake's install find lists claude alone, so pi and kimi go: each
  // reply replaces the row, and is never merged with the one before.
  const rows = picks();
  assert.match(rows, /claude/);
  assert.doesNotMatch(rows, /kimi|pi\b/);
});

test("a new find and an install refresh the model row too (#367)", async (t) => {
  const withModels = (id: string): HarnessesReply["harnesses"][number] => ({
    id: "pi",
    measured: true,
    state: "ready",
    models: [{ id, name: id }],
  });
  const claudeMain = reply().harnesses[1];
  assert.ok(claudeMain);
  const fake = await fakeDaemon(t, {
    got: { ...reply(true), harnesses: [withModels("m-start"), claudeMain] },
    found: { ...reply(true), harnesses: [withModels("m-found"), claudeMain] },
    installed: {
      ...installedReply(),
      harnesses: installedReply().harnesses.map((h) => ({
        ...h,
        models: [{ id: "m-installed", name: "Installed" }],
      })),
    },
  });
  const box = makeBox(fake.d, { rooms: twoRooms(), view: { roomId: "r1" } });
  /** The add form's model row once `agent` is the harness. Closes it. */
  const modelPicks = (agent: string) => {
    box.addForm();
    box.panel?.body.handleInput?.("\r");
    type(box, `${agent}\r`);
    for (let i = 0; i < 5; i++) box.panel?.body.handleInput?.("\x1b[B");
    box.panel?.body.handleInput?.("\r");
    const rows = shownOf(box);
    box.hidePanel();
    return rows;
  };
  await box.atStart();
  assert.match(modelPicks("pi"), /m-start/);

  await box.showSetup();
  const found = modelPicks("pi");
  assert.match(found, /m-found/);
  assert.doesNotMatch(found, /m-start/);

  // The daemon checks a new agent before its install reply, so claude's
  // models come with it.
  await box.showSetup();
  box.panel?.body.handleInput?.(" ");
  box.panel?.body.handleInput?.("\r");
  await until("the install's find", () => /claude +ready/.test(shownOf(box)));
  assert.match(modelPicks("claude"), /m-installed/);
});

test("a late startup reply does not undo a newer find's harnesses (#367)", async (t) => {
  const before = reply();
  const after = {
    ...before,
    harnesses: [
      ...before.harnesses,
      { id: "kimi", measured: true, state: "ready" as const },
    ],
  };
  const fake = await fakeDaemon(t, {
    holdGet: true,
    got: { ...before, done: true },
    found: { ...after, done: true },
  });
  const box = makeBox(fake.d, { rooms: twoRooms(), view: { roomId: "r1" } });
  const starting = box.atStart();
  await fake.getSeen.promise;

  // The person finds again while the startup GET is still held.
  await box.showSetup();
  box.hidePanel();
  assert.match(
    harnessPicks(box, () => box.addForm(), 0),
    /kimi/,
  );

  // Its older reply must not put the harness row back.
  fake.getRelease.resolve();
  await starting;
  assert.match(
    harnessPicks(box, () => box.addForm(), 0),
    /kimi/,
    "a late startup GET must not undo a newer find",
  );
});

test("a form opened before the harness reply shows its pick list when it lands (#367)", async (t) => {
  const fake = await fakeDaemon(t, { holdGet: true });
  const box = makeBox(fake.d, { rooms: twoRooms(), view: { roomId: "r1" } });
  const starting = box.atStart();
  await fake.getSeen.promise;

  box.addForm();
  box.panel?.body.handleInput?.("\r");
  assert.doesNotMatch(
    shownOf(box),
    /other…/,
    "a text box while the reply is pending",
  );
  fake.getRelease.resolve();
  await starting;

  // Back from the text box to the form, then open the harness row again.
  box.panel?.body.handleInput?.("\x1b");
  box.panel?.body.handleInput?.("\r");
  assert.match(shownOf(box), /pi[\s\S]*other…/);
  box.hidePanel();
});

/** Keep a developer's own recipes out of a panel test. Top-level tests in
 *  one node:test file run sequentially, so the environment is restored before
 *  another test or fixture reads it. */
const isolatedRecipeConfig = async (t: TestContext) => {
  const config = join(await tempDir(t), "config");
  await mkdir(config);
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  t.after(() => {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  });
  return config;
};

const recipeRepo = async (t: TestContext, name: string, recipes: string[]) => {
  const repo = join(await tempDir(t), name);
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, ".kapelle", "loops"), { recursive: true });
  for (const recipe of recipes) {
    await writeFile(join(repo, ".kapelle", "loops", `${recipe}.md`), recipe);
  }
  return repo;
};

test("the loop form has the decided rows, refuses a blank task, and matches typed /loop (M9-5d, #458)", async (t) => {
  await isolatedRecipeConfig(t);
  const cwd = await recipeRepo(t, "command", ["fix"]);
  const ran: RouteCommand[] = [];
  const box = makeBox(NO_DAEMON_YET, {
    run: async (c) => {
      ran.push(c);
      return true;
    },
  });
  box.loopForm();
  assert.match(
    shownOf(box),
    /folder[\s\S]*recipe[\s\S]*task[\s\S]*note[\s\S]*harness[\s\S]*command[\s\S]*model[\s\S]*start/,
  );

  // Up from folder wraps to start. The blank task is refused before `run`.
  pressKey(box, "\x1b[A");
  pressKey(box, "\r");
  assert.equal(box.panel?.error, "a task is required");
  assert.deepEqual(ran, []);
  pressKey(box, "\x1b[B");

  pressKey(box, "\r");
  type(box, `\x15${cwd}\r`);
  down(box, 1);
  pressKey(box, "\r");
  await until("the loop's recipes", () => /fix/.test(shownOf(box)));
  pressKey(box, "\r");
  down(box, 1);
  pressKey(box, "\r");
  type(box, "  build issue 458  \r");
  down(box, 1);
  pressKey(box, "\r");
  type(box, "  a note  \r");
  down(box, 1);
  pressKey(box, "\r");
  type(box, "pi\r");
  // Leave command blank; model is a text box until a harness list arrives.
  down(box, 2);
  pressKey(box, "\r");
  type(box, "mock/smart\r");
  down(box, 1);
  pressKey(box, "\r");

  const typed = parseCommand(
    `/loop fix "build issue 458" "a note" --agent pi --model mock/smart --cwd ${cwd}`,
    [],
  );
  assert.ok(typed && "verb" in typed);
  assert.deepEqual(ran, [typed]);
});

test("the loop recipe row follows its folder, and no recipes refuses start with plain folder names (M9-5d, #458)", async (t) => {
  await isolatedRecipeConfig(t);
  const first = await recipeRepo(t, "first", ["one"]);
  const second = await recipeRepo(t, "second", ["two"]);
  const empty = await recipeRepo(t, "empty", []);
  const ran: RouteCommand[] = [];
  const box = makeBox(NO_DAEMON_YET, {
    run: async (c) => {
      ran.push(c);
      return true;
    },
  });
  box.loopForm();

  pressKey(box, "\r");
  type(box, `\x15${first}\r`);
  down(box, 1);
  pressKey(box, "\r");
  await until("the first folder's recipe", () => /one/.test(shownOf(box)));
  assert.doesNotMatch(shownOf(box), /two/);
  pressKey(box, "\x1b");

  pressKey(box, "\x1b[A");
  pressKey(box, "\r");
  type(box, `\x15${second}\r`);
  down(box, 1);
  pressKey(box, "\r");
  await until("the changed folder's recipe", () => /two/.test(shownOf(box)));
  assert.doesNotMatch(shownOf(box), /one/);
  pressKey(box, "\x1b");

  pressKey(box, "\x1b[A");
  pressKey(box, "\r");
  type(box, `\x15${empty}\r`);
  down(box, 1);
  pressKey(box, "\r");
  await until("the empty recipe state", () => /no recipes/.test(shownOf(box)));
  pressKey(box, "\r");
  down(box, 1);
  pressKey(box, "\r");
  type(box, "a task\r");
  down(box, 5);
  pressKey(box, "\r");

  assert.deepEqual(ran, [], "no room request is sent");
  assert.equal(box.panel?.title, "loop", "the refusal keeps the form open");
  assert.match(box.panel?.error ?? "", /^no recipes: looked in /);
  for (const folder of loopFolders(empty)) {
    assert.ok(box.panel?.error?.includes(folder), folder);
  }
  assert.match(shownOf(box), /task\s+a task/, "the entered values stay");
});

test("the loop form's folder row completes with Tab (M9-5d, #458)", async (t) => {
  const parent = await tempDir(t);
  await mkdir(join(parent, "alpha-1"));
  await mkdir(join(parent, "alpha-2"));
  const box = makeBox(NO_DAEMON_YET);
  box.loopForm();

  pressKey(box, "\r");
  type(box, `\x15${parent}/al\t`);
  assert.match(shownOf(box), /alpha-1\/ {2}alpha-2\//);
});

test("the loop form keeps recipe, task, note and command values that look like form sentinels (#458)", async (t) => {
  await isolatedRecipeConfig(t);
  for (const recipe of ["–", "other…"]) {
    const cwd = await recipeRepo(t, recipe === "–" ? "dash" : "other", [
      recipe,
    ]);
    const ran: RouteCommand[] = [];
    const box = makeBox(NO_DAEMON_YET, {
      run: async (c) => {
        ran.push(c);
        return true;
      },
    });
    box.loopForm();

    pressKey(box, "\r");
    type(box, `\x15${cwd}\r`);
    down(box, 1);
    pressKey(box, "\r");
    await until("the literal recipe", () => shownOf(box).includes(recipe));
    pressKey(box, "\r");
    assert.ok(shownOf(box).includes(recipe), `${recipe} stays selected`);

    down(box, 1);
    pressKey(box, "\r");
    type(box, "\x15–\r");
    down(box, 1);
    pressKey(box, "\r");
    type(box, "\x15–\r");
    down(box, 2);
    pressKey(box, "\r");
    type(box, "\x15–\r");
    down(box, 2);
    pressKey(box, "\r");

    const typed = parseCommand(
      `/loop "${recipe}" "–" "–" --cmd "–" --cwd ${cwd}`,
      [],
    );
    assert.ok(typed && "verb" in typed);
    assert.deepEqual(ran, [typed]);
  }
});
