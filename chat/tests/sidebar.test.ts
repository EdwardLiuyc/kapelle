/**
 * The sidebar's marks (M7-3), and the changed-files block. The first test
 * is story M6-7a (#151): a paused room and its paused and killed
 * participants stay apart. `exited` keeps its own mark too (R46).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Diff, RoomDto, RoomEventLine } from "../../client/contract.ts";
import type { FileChange } from "../../client/diff.ts";
import {
  applyLine,
  applyStatus,
  newRoomState,
  type RoomState,
  seen,
} from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { roomMark, sidebarParts } from "../tui/sidebar.ts";
import { PALETTE } from "../view.ts";

/** A room `r1` builder: `add` a participant, then send lines as them. */
const mk = () => {
  const state = newRoomState();
  let seq = 0;
  const line = (
    participantId: string,
    update: RoomEventLine["update"],
    at = "2026-10-11T09:00:00Z",
  ) =>
    applyLine(state, {
      seq: ++seq,
      at,
      roomId: "r1",
      participantId,
      update,
    } satisfies RoomEventLine);
  const add = (id: string, name: string, harness = "mock", role?: string) =>
    line(id, {
      sessionUpdate: "_client_participant_added",
      name,
      harness,
      mode: "ask",
      ...(role && { role }),
    } as RoomEventLine["update"]);
  return { state, line, add };
};

const roomsOf = (state: RoomState, status = "active") =>
  new Map([
    [
      "r1",
      {
        entry: { id: "r1", cwd: "/src/app", title: "kapelle", status },
        state,
      } as unknown as Followed,
    ],
  ]);

/** The sidebar's rows without their SGR codes. */
const rowsOf = (
  rooms: ReadonlyMap<string, Followed>,
  view = { roomId: "r1" },
) => {
  const { sidebar } = sidebarParts({
    rooms,
    view: () => view,
    toggle() {},
    open() {},
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  return sidebar.render(26).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
};

test("a paused room and its paused and killed participants are marked", () => {
  const { state, add } = mk();
  add("p-ana", "ana");
  add("p-bob", "bob");
  applyStatus(state, {
    participants: [
      { id: "p-ana", status: "paused" },
      { id: "p-bob", status: "killed" },
    ],
  } as unknown as RoomDto);
  const text = rowsOf(roomsOf(state, "paused")).join("\n");
  assert.match(text, /✕ kapelle app paused/);
  assert.match(text, /⏸ ana mock/);
  assert.match(text, /✕ bob mock/);
});

test("an agent's row at 26 columns: mark, harness, timer and unread count", () => {
  const { state, line, add } = mk();
  add("p-ann", "ann", "claude", "orchestrator");
  line("p-ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  line("p-ann", {
    sessionUpdate: "_client_permission_queued",
    id: "q1",
    kind: "edit",
    title: "Write x",
  });
  add("p-bob", "bob", "pi");
  line("p-bob", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  });
  add("p-cy", "cy", "pi");
  line("p-cy", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  line("p-cy", { sessionUpdate: "_client_harness_exited", pid: 1 });
  seen(state, "p-cy");
  add("p-dee", "dee", "pi");
  line("p-dee", { sessionUpdate: "_client_harness_exited", pid: 1 });
  seen(state, "p-dee");
  // A long name must give way, not push the row past 26 columns.
  add("p-eve", "eve-the-very-long-name", "opencode");
  const rows = (() => {
    const { sidebar } = sidebarParts({
      rooms: roomsOf(state),
      view: () => ({ roomId: "r1", participantId: "p-ann" }),
      toggle() {},
      open() {},
      now: () => Date.parse("2026-10-11T09:03:07Z"),
    });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    return sidebar.render(26).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  })();
  const row = (re: RegExp) => rows.find((l) => re.test(l)) ?? "";
  assert.match(row(/ann/), /^▸ {3}\? ann ★ clau… 3m 07s │$/);
  assert.match(row(/bob/), /^ {4}● bob pi +1 │$/);
  assert.match(row(/cy/), /^ {4}✕ cy pi +│$/);
  assert.match(row(/dee/), /^ {4}◌ dee pi +│$/);
  assert.ok(
    rows.every((l) => visibleWidth(l) === 26),
    "every row fits the 26 columns",
  );
});

test("an agent's row paints its mark and name in its palette colour", () => {
  const { state, line, add } = mk();
  add("p-ann", "ann");
  line("p-ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  const { sidebar } = sidebarParts({
    rooms: roomsOf(state),
    view: () => ({ roomId: "r1", participantId: "p-ann" }),
    toggle() {},
    open() {},
    now: () => Date.parse("2026-10-11T09:00:05Z"),
  });
  const raw = sidebar.render(26).join("\n");
  assert.ok(
    raw.includes(`\x1b[38;5;${PALETTE[0]}m◐ ann\x1b[39m`),
    "the mark and name carry the first palette colour",
  );
});

test("the room mark takes its most urgent agent's mark", () => {
  const { state, line, add } = mk();
  assert.equal(roomMark(state).glyph, "○", "no agents");
  add("p-ann", "ann");
  line("p-ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  assert.equal(roomMark(state).glyph, "◐", "busy");
  add("p-carol", "carol");
  line("p-carol", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  });
  assert.equal(roomMark(state).glyph, "●", "unread before busy");
  add("p-bob", "bob");
  line("p-bob", { sessionUpdate: "_client_harness_exited", pid: 1 });
  seen(state, "p-bob");
  assert.equal(roomMark(state).glyph, "◌", "exited before unread");
  add("p-pat", "pat");
  applyStatus(state, {
    participants: [{ id: "p-pat", status: "paused" }],
  } as unknown as RoomDto);
  assert.equal(roomMark(state).glyph, "⏸", "paused before exited");
  add("p-dan", "dan");
  line("p-dan", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  line("p-dan", { sessionUpdate: "_client_harness_exited", pid: 1 });
  seen(state, "p-dan");
  assert.equal(roomMark(state).glyph, "✕", "killed before exited");
  line("p-ann", {
    sessionUpdate: "_client_stall_warning",
    kind: "idle",
    text: "no activity",
  });
  assert.equal(roomMark(state).glyph, "!", "stall before killed");
  line("p-ann", {
    sessionUpdate: "_client_permission_queued",
    id: "q1",
    kind: "edit",
    title: "Write x",
  });
  assert.equal(roomMark(state).glyph, "?", "question before stall");
  assert.equal(roomMark(state).waits, true, "a question waits");
});

test("the strip shows the open room's mark", () => {
  const { state, line, add } = mk();
  add("p-ann", "ann");
  line("p-ann", {
    sessionUpdate: "_client_permission_queued",
    id: "q1",
    kind: "edit",
    title: "Write x",
  });
  const stripAt = (roomId: string) => {
    const lines = sidebarParts({
      rooms: roomsOf(state),
      view: () => ({ roomId }),
      toggle() {},
      open() {},
    }).strip.render(2);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))[0];
  };
  assert.equal(stripAt("r1"), "»?");
  assert.equal(stripAt("gone"), "»");
});

const CUT_LINES = [
  "diff --git a/cli.ts b/cli.ts",
  "@@ -1 +1,2 @@",
  "-old",
  "+new",
  "+more",
  "diff --git a/new.ts b/new.ts",
  "new file mode 100644",
  "@@ -0,0 +1 @@",
  "+x",
  "diff --git a/old.ts b/old.ts",
  "deleted file mode 100644",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/cut.ts b/cut.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "… 9 more lines",
];
const CUT_TEXT = CUT_LINES.join("\n");

const blockRows = (diff: Diff, height = 24) => {
  const { state, add } = mk();
  add("p-ann", "ann");
  const { sidebar } = sidebarParts({
    rooms: roomsOf(state),
    view: () => ({ roomId: "r1", participantId: "p-ann" }),
    toggle() {},
    open() {},
    changes: () => diff,
    height: () => height,
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  return sidebar.render(26).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
};

test("the changed-files block letters each file, and the cut file has no counts", () => {
  const rows = blockRows({ text: CUT_TEXT, files: 7, added: 12, removed: 9 });
  const text = rows.join("\n");
  assert.match(text, /changed files/);
  assert.match(text, / {2}M cli\.ts +\+2 −1 │/);
  assert.match(text, / {2}A new\.ts +\+1 −0 │/);
  assert.match(text, / {2}D old\.ts +\+0 −1 │/);
  assert.match(text, / {2}M cut\.ts +│/);
  assert.doesNotMatch(text, /cut\.ts \+/);
  assert.match(text, /\+3 more/, "7 route files against 4 in the text");
});

test("the block shows +n more from the route's files when the rows run out", () => {
  const text = blockRows(
    { text: CUT_TEXT, files: 5, added: 12, removed: 9 },
    8,
  ).join("\n");
  assert.match(text, / {2}M cli\.ts +\+2 −1 │/);
  assert.match(text, / {2}A new\.ts +\+1 −0 │/);
  assert.match(text, / {2}D old\.ts +\+0 −1 │/);
  assert.match(text, /\+2 more/, "5 route files against 3 rows");
  assert.doesNotMatch(text, /cut\.ts/, "the cut file did not fit");
});

test("the heading and the +n more row count against the sidebar's height", () => {
  const { state, add, line } = mk();
  add("p-ann", "ann");
  for (const name of ["bob", "cy"]) add(`p-${name}`, name);
  line("p-ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  const diff: Diff = { text: CUT_TEXT, files: 4, added: 12, removed: 9 };
  const { sidebar } = sidebarParts({
    rooms: roomsOf(state),
    view: () => ({ roomId: "r1", participantId: "p-ann" }),
    toggle() {},
    open() {},
    changes: () => diff,
    height: () => 9,
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const rows = sidebar.render(26).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  // Header, room, 3 agents, heading, 2 files, +2 more = 9 rows exactly.
  assert.match(rows[8] ?? "", /\+2 more/);
  assert.doesNotMatch(rows[9] ?? "", /M |A |D |changed files/);
});

test("a long changed path keeps its basename, and a no-hunk file has no counts", () => {
  const lines = [
    "diff --git a/core/very/long/path/notes.md b/core/very/long/path/notes.md",
    "--- a/core/very/long/path/notes.md",
    "+++ b/core/very/long/path/notes.md",
    "diff --git a/core/very/long/path/new.ts b/core/very/long/path/new.ts",
    "new file mode 100644",
    "@@ -0,0 +1 @@",
    "+x",
  ].join("\n");
  const text = blockRows({ text: lines, files: 2, added: 1, removed: 0 }).join(
    "\n",
  );
  assert.match(text, /M …[^\s]*notes\.md +│/);
  assert.doesNotMatch(text, /notes\.md \+0 −0/);
  assert.match(text, /A …[^\s]*new\.ts +\+1 −0 │/);
});

test("a click on a changed-file row opens that file", () => {
  const { state, add } = mk();
  add("p-ann", "ann");
  const opened: FileChange[] = [];
  const { sidebar } = sidebarParts({
    rooms: roomsOf(state),
    view: () => ({ roomId: "r1", participantId: "p-ann" }),
    toggle() {},
    open() {},
    changes: () => ({ text: CUT_TEXT, files: 4, added: 12, removed: 9 }),
    openFile: (f) => opened.push(f),
  });
  const cut = CUT_LINES.findIndex((l) => l.startsWith("diff --git a/cut.ts"));
  // Row 0 is the header, 1 the room, 2 the agent, 3 `changed files`, 4-7 the files.
  sidebar.handleMouse?.({
    type: "click",
    button: "left",
    x: 4,
    y: 7,
  } as never);
  assert.equal(opened[0]?.path, "cut.ts");
  assert.equal(opened[0]?.line, cut);
});
