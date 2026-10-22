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
  return sidebar.render(32).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
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
  assert.match(text, /⏸ ana +│\n {6}mock +│/);
  assert.match(text, /✕ bob +│\n {6}mock +│/);
});

test("an agent's two rows at 32 columns: mark, timer, unread count, then harness · role", () => {
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
  // A long name must give way, not push the row past 32 columns.
  add("p-eve", "eve-the-very-very-long-name-x", "opencode");
  const rows = (() => {
    const { sidebar } = sidebarParts({
      rooms: roomsOf(state),
      view: () => ({ roomId: "r1", participantId: "p-ann" }),
      toggle() {},
      open() {},
      now: () => Date.parse("2026-10-11T09:03:07Z"),
    });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    return sidebar.render(32).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  })();
  const at = (re: RegExp) => rows.findIndex((l) => re.test(l));
  const pair = (re: RegExp) => rows.slice(at(re), at(re) + 2).join("\n");
  assert.match(
    pair(/ann/),
    /^▸ {3}\? ann ★ +3m 07s │\n {6}claude · orchestrator +│$/,
  );
  assert.match(pair(/bob/), /^ {4}● bob +1 │\n {6}pi +│$/);
  assert.match(pair(/cy/), /^ {4}✕ cy +│\n {6}pi +│$/);
  assert.match(pair(/dee/), /^ {4}◌ dee +│\n {6}pi +│$/);
  assert.match(
    pair(/eve/),
    /^ {4}○ eve-the-very-very-long-… │\n {6}opencode +│$/,
  );
  assert.ok(
    rows.every((l) => visibleWidth(l) === 32),
    "every row fits the 32 columns",
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
  const raw = sidebar.render(32).join("\n");
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
  return sidebar.render(32).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
};

test("the changed-files block letters each file, and the cut file has no counts", () => {
  const rows = blockRows({ text: CUT_TEXT, files: 7, added: 12, removed: 9 });
  const text = rows.join("\n");
  // Both titles sit in a line, and an empty row comes before the files'.
  assert.match(rows[0] ?? "", /^── rooms ─{19} « │$/);
  assert.match(text, /\n {30} │\n── changed files ─{13} │\n {2}M cli/);
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
    10,
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
    height: () => 10,
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const rows = sidebar.render(32).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  // Two rows per agent would fill 8 of 10, so each agent takes one. Header,
  // room, 3 agents, empty row, heading, 2 files, +2 more = 10 rows exactly.
  assert.match(rows[9] ?? "", /\+2 more/);
  assert.doesNotMatch(rows[10] ?? "", /M |A |D |changed files/);
});

test("an agent takes two rows only while they stay under 2/3 of the height", () => {
  const { state, add } = mk();
  add("p-ann", "ann", "claude", "orchestrator");
  for (const name of ["bob", "cy"]) add(`p-${name}`, name, "pi");
  const rowsAt = (height: number) => {
    const { sidebar } = sidebarParts({
      rooms: roomsOf(state),
      view: () => ({ roomId: "r1" }),
      toggle() {},
      open() {},
      height: () => height,
    });
    return (
      sidebar
        .render(32)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
        .slice(0, height)
        .join("\n")
    );
  };
  // Header, room and 3 agents of 2 rows: 8 rows, under 2/3 of 13.
  assert.match(rowsAt(13), /^ {4}○ ann ★ +│\n {6}claude · orchestrator +│$/m);
  // 8 is 2/3 of 12, so each agent takes one row, the harness after the name.
  const one = rowsAt(12);
  assert.match(one, /^ {4}○ ann ★ claude +│$/m);
  assert.match(one, /^ {4}○ bob pi +│\n {4}○ cy pi +│$/m);
  assert.doesNotMatch(one, /orchestrator/);
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
  // Row 0 is the header, 1 the room, 2-3 the agent, 4 empty, 5 `changed
  // files`, 6-9 the files.
  sidebar.handleMouse?.({
    type: "click",
    button: "left",
    x: 4,
    y: 9,
  } as never);
  assert.equal(opened[0]?.path, "cut.ts");
  assert.equal(opened[0]?.line, cut);
});

test("a click on either of an agent's rows opens its thread", () => {
  const { state, add } = mk();
  add("p-ann", "ann");
  add("p-bob", "bob");
  const opened: unknown[] = [];
  const { sidebar } = sidebarParts({
    rooms: roomsOf(state),
    view: () => ({ roomId: "r1" }),
    toggle() {},
    open: (v) => opened.push(v),
  });
  const click = (y: number) =>
    sidebar.handleMouse?.({ type: "click", button: "left", x: 4, y } as never);
  // Row 1 is the room, 2-3 ann, 4-5 bob.
  for (const y of [1, 2, 3, 4, 5]) click(y);
  assert.deepEqual(
    opened.map((v) => (v as { participantId?: string }).participantId),
    [undefined, "p-ann", "p-ann", "p-bob", "p-bob"],
  );
});
