/**
 * What the full-screen chat shows — `chat/view.ts`, story M4-10 (#210).
 * One test per rule the story names.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  ParticipantDto,
  RoomDto,
  RoomEventLine,
} from "../../client/contract.ts";
import {
  applyLine,
  type Entry,
  newRoomState,
  type RoomState,
  seen,
} from "../../client/room.ts";
import {
  activeMark,
  activity,
  anyBusy,
  banner,
  bell,
  busyIn,
  clock,
  colourOf,
  dismissed,
  edited,
  footer,
  historyPreview,
  historyRow,
  messages,
  moved,
  opened,
  PALETTE,
  participantLeft,
  pickRow,
  quiet,
  railHit,
  railNeighbour,
  railWindow,
  renamed,
  rows,
  runs,
  runText,
  seenIn,
  shows,
  step,
  ticks,
  touched,
  usageText,
  type View,
  waiting,
  where,
} from "../view.ts";

/** A room whose roster is these names, each id `p-<name>`. `gone` names
 *  one off the roster. */
const room = (names: string[], gone?: string): RoomState => {
  const state = newRoomState();
  for (const name of [...names, ...(gone ? [gone] : [])]) {
    const id = `p-${name}`;
    state.participants.set(id, {
      id,
      name,
      harness: "mock",
      mode: "safe",
      status: "idle",
      removed: name === gone,
      turns: [],
      queue: [],
      unread: 1,
    });
  }
  return state;
};
const rooms = (...states: [string, RoomState][]) =>
  new Map(states.map(([id, state]) => [id, { state }]));

test("the rows: each room, then its roster, in order", () => {
  const all = rooms(["r1", room(["ann", "bob"], "cid")], ["r2", room([])]);
  assert.deepEqual(rows(all), [
    { roomId: "r1" },
    { roomId: "r1", participantId: "p-ann" },
    { roomId: "r1", participantId: "p-bob" },
    { roomId: "r2" },
  ]);
});

test("the row keys step one row, and stop at either end", () => {
  const all = rooms(["r1", room(["ann"])], ["r2", room([])]);
  const r1 = { roomId: "r1" };
  const ann = { roomId: "r1", participantId: "p-ann" };
  assert.deepEqual(step(all, r1, true), ann);
  assert.deepEqual(step(all, ann, true), { roomId: "r2" });
  assert.deepEqual(step(all, ann, false), r1);
  assert.equal(step(all, r1, false), undefined);
  assert.equal(step(all, { roomId: "r2" }, true), undefined);
});

test("from a view that is not a row, down goes to the first row", () => {
  const all = rooms(["r1", room([])]);
  assert.deepEqual(step(all, { roomId: "" }, true), { roomId: "r1" });
  assert.equal(step(all, { roomId: "" }, false), undefined);
});

test("an untouched pre-fill follows the view", () => {
  const s = room(["ann", "bob"]);
  const ann = { roomId: "r1", participantId: "p-ann" };
  const bob = { roomId: "r1", participantId: "p-bob" };
  assert.deepEqual(opened(s, ann, "", ""), { prefill: "@ann ", text: "@ann " });
  assert.deepEqual(opened(s, bob, "@ann ", "@ann "), {
    prefill: "@bob ",
    text: "@bob ",
  });
  assert.deepEqual(opened(s, { roomId: "r1" }, "@bob ", "@bob "), {
    prefill: "",
    text: "",
  });
});

test("typed text stays when the view changes", () => {
  const s = room(["ann", "bob"]);
  const bob = { roomId: "r1", participantId: "p-bob" };
  assert.deepEqual(opened(s, bob, "@ann hi", "@ann "), { prefill: "@ann " });
  assert.deepEqual(opened(s, bob, "hi", ""), { prefill: "" });
});

test("a `@dev` draft stays in its room, not the other room's dev (#355)", () => {
  const a = { roomId: "rA" };
  const b = { roomId: "rB" };
  const typed = { text: "@dev fix the test", prefill: "" };
  // To room B, which also has a dev: its timeline opens empty.
  assert.deepEqual(moved(room(["dev"]), b, typed), {
    prefill: "",
    text: "",
    left: "@dev fix the test",
  });
  // Back to room A: the draft returns as typed.
  assert.deepEqual(
    moved(room(["dev"]), a, { text: "", prefill: "" }, typed.text),
    {
      prefill: "",
      text: "@dev fix the test",
      left: "",
    },
  );
});

test("an unnamed draft stays in its room, not the other one-agent room (#355)", () => {
  const ann = { roomId: "rB", participantId: "p-ann" };
  // To ann's thread in room B: it opens with its own pre-fill.
  assert.deepEqual(moved(room(["ann"]), ann, { text: "hi", prefill: "" }), {
    prefill: "@ann ",
    text: "@ann ",
    left: "hi",
  });
  // Back to room A: the draft returns with no `@name` added.
  const a = { roomId: "rA" };
  assert.deepEqual(
    moved(room(["bob"]), a, { text: "@ann ", prefill: "@ann " }, "hi"),
    {
      prefill: "",
      text: "hi",
      left: "",
    },
  );
});

test("a room's own draft wins over the destination view's pre-fill", () => {
  const ann = { roomId: "rB", participantId: "p-ann" };
  assert.deepEqual(
    moved(room(["ann"]), ann, { text: "from A", prefill: "" }, "from B"),
    {
      prefill: "",
      text: "from B",
      left: "from A",
    },
  );
});

test("a pre-fill alone is not a draft; with no room the composer clears", () => {
  const now = { text: "@bob ", prefill: "@bob " };
  assert.deepEqual(moved(undefined, { roomId: "" }, now), {
    prefill: "",
    text: "",
    left: "",
  });
});

test("with no room, an untouched pre-fill clears and typed text stays", () => {
  const none = { roomId: "" };
  assert.deepEqual(opened(undefined, none, "@bob ", "@bob "), {
    prefill: "",
    text: "",
  });
  assert.deepEqual(opened(undefined, none, "@bob hi", "@bob "), {
    prefill: "@bob ",
  });
});

test("typing drops the pre-fill; an empty thread composer holds @name again", () => {
  const s = room(["ann"]);
  const ann = { roomId: "r1", participantId: "p-ann" };
  assert.deepEqual(edited(s, ann, "@ann hi", "@ann "), { prefill: "" });
  assert.deepEqual(edited(s, ann, "@ann ", "@ann "), { prefill: "@ann " });
  assert.deepEqual(edited(s, ann, "", ""), { prefill: "@ann ", text: "@ann " });
  assert.deepEqual(edited(s, { roomId: "r1" }, "", ""), { prefill: "" });
  // No room: nothing to name, so an empty composer stays empty.
  assert.deepEqual(edited(undefined, ann, "", ""), { prefill: "" });
});

test("only text other than the pre-fill counts as typed", () => {
  assert.ok(!touched("", ""));
  assert.ok(!touched("@ann ", "@ann "));
  assert.ok(touched("@ann hi", "@ann "));
  assert.ok(touched("hi", ""));
});

test("a rename moves an untouched pre-fill, and leaves typed text", () => {
  const s = room(["ann"]);
  const ann = { roomId: "r1", participantId: "p-ann" };
  const p = s.participants.get("p-ann");
  assert.ok(p);
  p.name = "anna";
  assert.deepEqual(renamed(s, "r1", ann, "@ann ", "@ann "), {
    prefill: "@anna ",
    text: "@anna ",
  });
  assert.equal(renamed(s, "r1", ann, "@ann hi", "@ann "), undefined);
  assert.equal(renamed(s, "r2", ann, "@ann ", "@ann "), undefined);
  assert.equal(renamed(s, "r1", ann, "@anna ", "@anna "), undefined);
});

test("a thread whose participant left goes back to the timeline", () => {
  const ann = { roomId: "r1", participantId: "p-ann" };
  assert.deepEqual(participantLeft(ann, "r1", "p-ann"), { roomId: "r1" });
  assert.equal(participantLeft(ann, "r1", "p-bob"), undefined);
  assert.equal(participantLeft(ann, "r2", "p-ann"), undefined);
  assert.equal(participantLeft({ roomId: "r1" }, "r1", "p-ann"), undefined);
});

test("a dismissed room goes to the first row", () => {
  const rest = rooms(["r2", room(["ann"])]);
  const view = { roomId: "r1", participantId: "p-bob" };
  assert.deepEqual(dismissed(rest, view, "r1"), { roomId: "r2" });
  assert.deepEqual(dismissed(rooms(), view, "r1"), { roomId: "" });
  assert.equal(dismissed(rest, { roomId: "r2" }, "r1"), undefined);
});

test("the timeline marks its whole room seen, and a thread its participant", () => {
  const s = room(["ann", "bob"], "cid");
  assert.deepEqual(seenIn(s, { roomId: "r1" }), ["p-ann", "p-bob", "p-cid"]);
  assert.deepEqual(seenIn(s, { roomId: "r1", participantId: "p-bob" }), [
    "p-bob",
  ]);
  assert.ok(shows({ roomId: "r1" }, "r1", "p-ann"));
  assert.ok(shows({ roomId: "r1", participantId: "p-ann" }, "r1", "p-ann"));
  assert.ok(!shows({ roomId: "r1", participantId: "p-ann" }, "r1", "p-bob"));
  assert.ok(!shows({ roomId: "r1" }, "r2", "p-ann"));
});

/** Ann asks a question; bob stalls in his open turn, and the person has
 *  not seen it. */
const waits = () => {
  const s = room(["ann", "bob", "cid"]);
  s.questions.set("q1", {
    seq: 1,
    participantId: "p-ann",
    at: "2026-10-10T00:00:00Z",
    type: "permission",
    id: "q1",
    title: "Write x.ts",
    kind: "edit",
  });
  const bob = s.participants.get("p-bob");
  assert.ok(bob);
  bob.turns.push({ text: "go", state: "open" });
  bob.stall = { kind: "idle", text: "no activity for 5s", seq: 3, seen: false };
  return s;
};

test("who waits: a question, or a stall in the live turn, seen or not", () => {
  const s = waits();
  const all = rooms(["r1", s]);
  assert.deepEqual(waiting(all), [
    {
      roomId: "r1",
      participantId: "p-ann",
      why: "question",
      text: "Write x.ts",
      question: "q1",
    },
    {
      roomId: "r1",
      participantId: "p-bob",
      why: "stall",
      text: "no activity for 5s",
      seq: 3,
    },
  ]);
  // Seen, bob still waits: the bell is for a person looking elsewhere.
  const bob = s.participants.get("p-bob");
  assert.ok(bob?.stall);
  bob.stall.seen = true;
  assert.equal(waiting(all).length, 2);
  // A resolved warning does not wait.
  const stall = bob.stall;
  bob.stall = undefined;
  assert.equal(waiting(all).length, 1);
  bob.stall = stall;
  // An ended turn does not wait.
  const turn = bob.turns[0];
  assert.ok(turn);
  turn.state = "ended";
  assert.deepEqual(
    waiting(all).map((w) => w.participantId),
    ["p-ann"],
  );
});

test("the banner shows the waits off screen, and a stall only until it is seen", () => {
  const s = waits();
  const all = rooms(["r1", s], ["r2", room([])]);
  const ids = (view: View) => banner(all, view).map((w) => w.participantId);
  assert.deepEqual(ids({ roomId: "r2" }), ["p-ann", "p-bob"]);
  // On screen: the timeline shows its whole room, a thread its participant.
  assert.deepEqual(ids({ roomId: "r1" }), []);
  assert.deepEqual(ids({ roomId: "r1", participantId: "p-ann" }), ["p-bob"]);
  const bob = s.participants.get("p-bob");
  assert.ok(bob?.stall);
  bob.stall.seen = true;
  assert.deepEqual(ids({ roomId: "r2" }), ["p-ann"], "a seen stall goes");
});

test("the bell rings once when a participant starts to wait", () => {
  const s = waits();
  const all = rooms(["r1", s]);
  const first = bell(new Set(), waiting(all));
  assert.equal(first.ring, true);
  assert.equal(bell(first.keys, waiting(all)).ring, false, "still waiting");
  // A second question from ann rings nothing: she waited already.
  const q1 = s.questions.get("q1");
  assert.ok(q1);
  s.questions.set("q2", { ...q1, id: "q2" });
  assert.equal(bell(first.keys, waiting(all)).ring, false);
  // Once nobody waits, a new wait rings again.
  s.questions.clear();
  const turn = s.participants.get("p-bob")?.turns[0];
  assert.ok(turn);
  turn.state = "ended";
  const none = bell(first.keys, waiting(all));
  assert.equal(none.ring, false);
  assert.equal(none.keys.size, 0);
  s.questions.set("q3", { ...q1, id: "q3" });
  assert.equal(bell(none.keys, waiting(all)).ring, true);
});

test("a question after a stall the person saw rings; the stall left when it closes does not", () => {
  const s = room(["bob"]);
  const bob = s.participants.get("p-bob");
  assert.ok(bob);
  bob.turns.push({ text: "go", state: "open" });
  bob.stall = { kind: "idle", text: "no activity for 5s", seq: 1, seen: false };
  const all = rooms(["r1", s]);
  const stalled = bell(new Set(), waiting(all));
  assert.equal(stalled.ring, true);
  // Seen: the banner drops the stall, and the bell still counts it.
  bob.stall.seen = true;
  assert.deepEqual(banner(all, { roomId: "r2" }), []);
  s.questions.set("q1", {
    seq: 2,
    participantId: "p-bob",
    at: "2026-10-10T00:00:00Z",
    type: "permission",
    id: "q1",
    title: "Write x.ts",
    kind: "edit",
  });
  const asked = bell(stalled.keys, waiting(all));
  assert.equal(asked.ring, true, "the question is new");
  // One banner row for bob, the question's.
  assert.deepEqual(
    banner(all, { roomId: "r2" }).map((w) => w.why),
    ["question"],
  );
  s.questions.clear();
  assert.equal(bell(asked.keys, waiting(all)).ring, false, "the stall is old");
});

test("a resolved stall leaves the waits and the banner; a later one rings again (#348)", () => {
  const state = newRoomState();
  let seq = 0;
  const line = (participantId: string, update: RoomEventLine["update"]) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-25T00:00:00Z",
      roomId: "r1",
      participantId,
      update,
    });
  for (const name of ["ann", "bob"]) {
    line(`p-${name}`, {
      sessionUpdate: "_client_participant_added",
      name,
      harness: "mock",
      mode: "auto",
    });
    line(`p-${name}`, {
      sessionUpdate: "_client_user_message",
      text: "go",
      turn: 1,
    });
  }
  const warn = () =>
    line("p-ann", {
      sessionUpdate: "_client_stall_warning",
      kind: "idle",
      text: "no activity for 5s",
    });
  const all = rooms(["r1", state]);
  const off = { roomId: "r2" };
  warn();
  const first = bell(new Set(), waiting(all));
  assert.equal(first.ring, true);
  assert.deepEqual(
    banner(all, off).map((w) => w.why),
    ["stall"],
  );
  // bob's line is not ann's activity.
  line("p-bob", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  });
  assert.equal(banner(all, off).length, 1);
  line("p-ann", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "back" },
  });
  assert.deepEqual(waiting(all), []);
  assert.deepEqual(banner(all, off), []);
  const resolved = bell(first.keys, waiting(all));
  assert.equal(resolved.ring, false);
  // A later idle spell in the same turn rings again.
  warn();
  assert.equal(bell(resolved.keys, waiting(all)).ring, true);
  // A seen one still waits for the bell; the next warning is a new wait.
  seen(state, "p-ann");
  const kept = bell(new Set(), waiting(all)).keys;
  warn();
  assert.equal(bell(kept, waiting(all)).ring, true, "a new seq is a new wait");
});

test("a thought chunk that resolves an idle warning asks for a frame (#348)", () => {
  const state = newRoomState();
  let seq = 0;
  const line = (update: RoomEventLine["update"]) => {
    const at = {
      seq: ++seq,
      at: "2026-10-25T00:00:00Z",
      roomId: "r1",
      participantId: "p-ann",
    };
    applyLine(state, { ...at, update });
    return { ...at, update } satisfies RoomEventLine;
  };
  line({
    sessionUpdate: "_client_participant_added",
    name: "ann",
    harness: "mock",
    mode: "auto",
  });
  line({ sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  line({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "one" },
  });
  line({
    sessionUpdate: "_client_stall_warning",
    kind: "idle",
    text: "no activity for 5s",
  });
  const all = rooms(["r1", state]);
  assert.deepEqual(
    banner(all, { roomId: "r2" }).map((w) => w.why),
    ["stall"],
  );
  const next = line({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "two" },
  });
  assert.deepEqual(banner(all, { roomId: "r2" }), []);
  assert.equal(quiet(state, next), false, "the resolved warning needs a frame");
});

test("the where bar names the open view's checkout and branch (4a)", () => {
  const participant = (
    id: string,
    worktree: string,
    branch?: string,
  ): ParticipantDto => ({
    id,
    name: id,
    harness: "mock",
    mode: "auto",
    settings: { allowReadOutsideRoot: false },
    worktree,
    ...(branch && { branch }),
    sessionId: "s",
    status: "idle",
    notices: [],
  });
  const dto = {
    id: "r1",
    cwd: "/repo",
    createdAt: "now",
    updatedAt: "now",
    status: "active",
    seq: 0,
    participants: [
      participant("p-ann", "/repo/wt/ann", "kapelle/r1/p-ann"),
      participant("p-bob", "/repo/shared"),
    ],
  } satisfies RoomDto;
  const room = { cwd: dto.cwd, dto };

  assert.equal(where({ roomId: "r1" }, room), "/repo");
  assert.equal(
    where({ roomId: "r1", participantId: "p-ann" }, room),
    "/repo/wt/ann · kapelle/r1/p-ann",
  );
  assert.equal(
    where({ roomId: "r1", participantId: "p-bob" }, room),
    "/repo/shared · (no branch)",
  );
  // Until `GET /rooms/:id` lands, the room's folder is all there is.
  assert.equal(
    where({ roomId: "r1", participantId: "p-ann" }, { cwd: "/repo" }),
    "/repo",
  );
});

test("six distinct colours, none a basic red, green, yellow or magenta (M7-1)", () => {
  assert.equal(new Set(PALETTE).size, 6);
  for (const n of PALETTE)
    assert.ok(![1, 2, 3, 5, 9, 10, 11, 13].includes(n), `${n}`);
});

test("a colour by join order: a seventh reuses the first, and a remove changes none", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  const s = room(names);
  assert.deepEqual(
    names.map((n) => colourOf(s, `p-${n}`)),
    [...PALETTE, PALETTE[0]],
  );
  const before = colourOf(s, "p-c");
  const b = s.participants.get("p-b");
  assert.ok(b);
  b.removed = true;
  assert.equal(colourOf(s, "p-c"), before, "c keeps its colour after b left");
  assert.equal(colourOf(s, "p-zed"), undefined, "never added: no colour");
});

/** Makes these participants busy, from a turn that started at 09:00. */
const busy = (s: RoomState, ...names: string[]) => {
  for (const n of names) {
    const p = s.participants.get(`p-${n}`);
    assert.ok(p);
    p.status = "busy";
    p.turns.push({ text: "go", state: "open", start: "2026-10-10T09:00:00Z" });
  }
};

test("activity: a busy row for the open room only, a wait from any room, one row per agent", () => {
  const r1 = room(["ann", "bob"]);
  const r2 = room(["cy", "dee"]);
  busy(r1, "ann", "bob");
  busy(r2, "cy", "dee");
  r1.questions.set("q1", {
    seq: 1,
    at: "2026-10-10T09:00:00Z",
    participantId: "p-bob",
    type: "permission",
    id: "q1",
    title: "write",
    kind: "edit",
  });
  r2.questions.set("q2", {
    seq: 1,
    at: "2026-10-10T09:00:00Z",
    participantId: "p-dee",
    type: "permission",
    id: "q2",
    title: "write",
    kind: "edit",
  });
  const all = rooms(["r1", r1], ["r2", r2]);
  const ids = (v: View) =>
    activity(all, v).rows.map((a) => `${a.participantId} ${a.why}`);
  // In r1's timeline, bob's question is on screen: his busy row shows.
  assert.deepEqual(ids({ roomId: "r1" }), [
    "p-dee question",
    "p-ann busy",
    "p-bob busy",
  ]);
  // In ann's thread, bob's question is off screen: one row, the wait.
  assert.deepEqual(ids({ roomId: "r1", participantId: "p-ann" }), [
    "p-bob question",
    "p-dee question",
    "p-ann busy",
  ]);
});

test("activity: four rows, then three and +n more; ticks follows a busy row", () => {
  const r1 = room(["a", "b", "c", "d", "e"]);
  const all = rooms(["r1", r1]);
  assert.deepEqual(activity(all, { roomId: "r1" }), { rows: [], more: 0 });
  assert.equal(
    ticks(activity(all, { roomId: "r1" }).rows),
    false,
    "no busy agent, no tick",
  );
  busy(r1, "a", "b", "c", "d");
  assert.equal(activity(all, { roomId: "r1" }).rows.length, 4);
  assert.equal(ticks(activity(all, { roomId: "r1" }).rows), true);
  busy(r1, "e");
  const five = activity(all, { roomId: "r1" });
  assert.equal(five.rows.length, 3);
  assert.equal(five.more, 2);
  assert.equal(
    ticks(activity(all, { roomId: "r2" }).rows),
    false,
    "no busy activity row there",
  );
});

test("anyBusy sees a busy agent in any room, for the sidebar timers", () => {
  const r1 = room(["a"]);
  const r2 = room(["b"]);
  const all = rooms(["r1", r1], ["r2", r2]);
  assert.equal(anyBusy(all), false, "no busy agent");
  busy(r2, "b");
  assert.equal(
    anyBusy(all),
    true,
    "another room's sidebar timer needs the tick",
  );
});

test("busyIn names a busy room, for the open room's transcript spinner", () => {
  const r1 = room(["a"]);
  const r2 = room(["b"]);
  const all = rooms(["r1", r1], ["r2", r2]);
  assert.equal(busyIn(all, "r1"), false, "quiet room");
  assert.equal(busyIn(all, "gone"), false, "unknown room");
  busy(r2, "b");
  assert.equal(busyIn(all, "r2"), true, "the busy room");
  assert.equal(busyIn(all, "r1"), false, "the other room");
});

test("a timer's text", () => {
  assert.equal(clock(42_000), "42s");
  assert.equal(clock(187_000), "3m 07s");
  assert.equal(clock(3_720_000), "1h 02m");
  assert.equal(clock(-5), "0s");
});

test("the footer's numbers: no ctx for used 0, no cost for 0, and ~ on both", () => {
  assert.deepEqual(usageText(undefined), []);
  assert.deepEqual(
    usageText({ used: 300_000, size: 200_000 }),
    [],
    "claude's first-turn size, under a larger window: no ctx ~150%",
  );
  assert.deepEqual(
    usageText({ used: 0, size: 200_000 }),
    [],
    "claude's unknown",
  );
  assert.deepEqual(
    usageText({
      used: 50_000,
      size: 200_000,
      cost: { amount: 0, currency: "USD" },
    }),
    ["ctx ~25%"],
    "opencode's not billed",
  );
  assert.deepEqual(
    usageText({ used: 1, size: 0, cost: { amount: 1.234, currency: "USD" } }),
    ["~$1.23"],
  );
  assert.deepEqual(
    usageText({ used: 10, size: 100, cost: { amount: 2, currency: "EUR" } }),
    ["ctx ~10%", "~2.00 EUR"],
  );
});

test("the footer at 160, 100 and 60 columns: the hints drop from the right, the sides stay", () => {
  const hints = [
    "enter to send",
    "ctrl+o menu",
    "alt+↑↓ rows",
    "ctrl+t rooms",
    "ctrl+x view",
  ];
  const at = (w: number) =>
    footer(w, "→ ann ask", hints, "ctx ~25% · ~$1.20", (x) => x.length);
  const wide = at(160);
  assert.equal(wide.length, 160);
  assert.ok(wide.startsWith(`→ ann ask · ${hints.join(" · ")}`));
  assert.ok(wide.endsWith("ctx ~25% · ~$1.20"));
  const mid = at(100);
  assert.ok(mid.length <= 100);
  assert.ok(mid.endsWith("ctx ~25% · ~$1.20"));
  const narrow = at(60);
  assert.ok(narrow.length <= 60);
  assert.ok(narrow.startsWith("→ ann ask · enter to send"));
  assert.ok(!narrow.includes("ctrl+x view"), "the last hint went first");
  assert.ok(narrow.endsWith("ctx ~25% · ~$1.20"));
  // Too narrow for both sides: joined, for the line to wrap.
  assert.equal(at(20), "→ ann ask · ctx ~25% · ~$1.20");
  assert.equal(
    footer(40, "→ ann", hints, "", (x) => x.length),
    "→ ann · enter to send · ctrl+o menu",
  );
  assert.equal(
    footer(40, "", hints, "", (x) => x.length),
    "enter to send · ctrl+o menu",
    "no room: no leading ·",
  );
});

test("a thought chunk asks for a frame only when it set the flag", () => {
  const s = room(["ann"]);
  const line = (seq: number) => ({
    seq,
    at: "2026-10-10T09:00:00Z",
    roomId: "r1",
    participantId: "p-ann",
    update: {
      sessionUpdate: "agent_thought_chunk" as const,
      content: { type: "text" as const, text: "x" },
    },
  });
  const ann = s.participants.get("p-ann");
  assert.ok(ann);
  ann.thinking = 3;
  assert.equal(quiet(s, line(3)), false, "the chunk that set it");
  assert.equal(quiet(s, line(4)), true, "a later one");
});

/** Entries in order, each `seq` one above the last. */
function entries() {
  let seq = 0;
  const at = (participantId: string) => ({
    seq: ++seq,
    participantId,
    at: "2026-10-11T00:00:00Z",
  });
  return {
    tool: (who: string, kind?: string, status?: string): Entry =>
      ({
        ...at(who),
        type: "tool",
        title: "t",
        ...(kind && { kind }),
        ...(status && { status }),
      }) as Entry,
    note: (who: string): Entry => ({ ...at(who), type: "answer", text: "n" }),
    ask: (who: string): Entry =>
      ({
        ...at(who),
        type: "permission",
        id: "q",
        title: "w",
        kind: "edit",
      }) as Entry,
    end: (who: string): Entry => ({ ...at(who), type: "turn_ended" }),
    user: (who: string): Entry => ({ ...at(who), type: "user", text: "go" }),
  };
}

test("a run folds when the agent's next note comes; the live run stays open (M7-2)", () => {
  const e = entries();
  const see = runs();
  assert.deepEqual(see(e.note("ann")).fold, [], "nothing to fold yet");
  const a = see(e.tool("ann", "read")).run;
  assert.equal(see(e.tool("ann", "edit")).run, a, "the same run");
  const fold = see(e.note("ann")).fold;
  assert.equal(fold.length, 1);
  assert.equal(fold[0], a);
  assert.equal(a?.tools.length, 2);
  assert.equal(a?.over, false, "the turn goes on");
  // The next run is live: nothing folds it until a note or the end.
  const b = see(e.tool("ann")).run;
  assert.notEqual(b, a, "a new run after a note");
  see(e.tool("ann"));
  assert.equal(b?.tools.length, 2);
  assert.equal(b?.folded, false, "the live run stays open");
});

test("the turn's end folds the open run and ends every run of it; a cut turn's ends at the next message (M7-2)", () => {
  const e = entries();
  const see = runs();
  const a = see(e.tool("ann")).run;
  see(e.note("ann"));
  const b = see(e.tool("ann")).run;
  const fold = see(e.end("ann")).fold;
  assert.deepEqual(fold, [b], "only the run not folded yet");
  assert.equal(a?.over, true, "the note's run is over too");
  assert.equal(b?.over, true);
  // A cut turn: no end, and the next message starts a turn.
  const c = see(e.tool("ann")).run;
  assert.deepEqual(see(e.user("ann")).fold, [c]);
  assert.equal(c?.over, true);
});

test("another agent's rows do not end a run (M7-2)", () => {
  const e = entries();
  const see = runs();
  const a = see(e.tool("ann")).run;
  see(e.note("bob"));
  const b = see(e.tool("bob")).run;
  see(e.ask("bob"));
  see(e.end("bob"));
  assert.notEqual(b, a, "each agent has its own run");
  assert.equal(
    see(e.tool("ann")).run,
    a,
    "bob's note, question and end leave ann's run open",
  );
  assert.deepEqual(see(e.note("ann")).fold, [a]);
});

test("a question ends the run before it, never folds, and the run folds at the next note (M7-2)", () => {
  const e = entries();
  const see = runs();
  const a = see(e.tool("ann", "edit")).run;
  assert.deepEqual(see(e.ask("ann")), { fold: [] }, "a question is no run's");
  const b = see(e.tool("ann")).run;
  assert.notEqual(b, a, "a new run after the question");
  assert.deepEqual(see(e.note("ann")).fold, [a, b], "both fold at the note");
  assert.equal(
    [a, b].flatMap((r) => r?.tools ?? []).some((t) => t.type !== "tool"),
    false,
    "no question in a run",
  );
});

test("a run's line counts the calls by kind, most first, with no kind as other, and the failed ones (M7-2)", () => {
  const e = entries();
  const tools = [
    e.tool("ann", "edit"),
    e.tool("ann", "read"),
    e.tool("ann", "read", "failed"),
    e.tool("ann"),
    e.tool("ann", "read", "completed"),
    e.tool("ann", "edit", "failed"),
  ] as Extract<Entry, { type: "tool" }>[];
  assert.deepEqual(runText(tools), {
    text: "6 tool calls · 3 read · 2 edit · 1 other",
    failed: 2,
  });
  assert.deepEqual(runText(tools.slice(3, 4)), {
    text: "1 tool call · 1 other",
    failed: 0,
  });
});

test("a key in the question box only moves its cursor, and any other typed character moves it back to deny (M7-4)", () => {
  // Rows: 0 deny, 1 allow, 2 view diff.
  assert.equal(pickRow("1", 3), 0);
  assert.equal(pickRow("n", 3), 0);
  assert.equal(pickRow("2", 3), 1);
  assert.equal(pickRow("y", 3), 1);
  assert.equal(pickRow("Y", 3), 1);
  assert.equal(pickRow("3", 3), 2);
  // No `view diff` row: `3` is any other key.
  assert.equal(pickRow("3", 2), 0);
  // A sentence typed into a box that just opened ends on deny...
  let row = 0;
  for (const ch of "try it") row = pickRow(ch, 3) ?? row;
  assert.equal(row, 0);
  // ...and a chunk counts its last character, as one key at a time would.
  assert.equal(pickRow("try it", 3), 0);
  assert.equal(pickRow("ok y", 3), 1);
  // Keys that type nothing stay with the list: arrows, Enter, Esc.
  // A chunk with a control character too: `2\r` answers nothing.
  for (const key of ["\x1b[A", "\x1b[B", "\r", "\x1b", "2\r"]) {
    assert.equal(pickRow(key, 3), undefined);
  }
});

/**
 * The history list (#362). `messages` picks what someone meant to send, and
 * `historyRow` names both ends. A `reply` or a `copy` the daemon wrote has a
 * `kind`, so neither is listed; a queued order is listed by its turn-start
 * entry only, so it adds no second row.
 */
test("the history lists the messages someone meant to send, both ends named (#362)", () => {
  const state = room(["po", "ana"]);
  const base = { at: "2026-10-26T09:00:00Z" } as const;
  const all: Entry[] = [
    {
      ...base,
      seq: 1,
      participantId: "p-po",
      type: "user",
      text: "ask ana to fix\nthe login bug",
    },
    {
      ...base,
      seq: 2,
      participantId: "p-ana",
      type: "user",
      text: "fix the login bug",
      from: "p-po",
    },
    {
      ...base,
      seq: 3,
      participantId: "p-po",
      type: "user",
      text: "[reply from ana] end_turn, 1 tool call",
      from: "p-ana",
      kind: "reply",
    },
    {
      ...base,
      seq: 4,
      participantId: "p-po",
      type: "user",
      text: "[copy] you → ana",
      from: "p-ana",
      kind: "copy",
    },
    {
      ...base,
      seq: 5,
      participantId: "p-ana",
      type: "queued",
      text: "and push it",
      from: "p-po",
    },
    { ...base, seq: 6, participantId: "p-ana", type: "answer", text: "fixed" },
  ];
  assert.deepEqual(
    messages(all).map((e) => historyRow(state, e)),
    ["you → po: ask ana to fix the login bug", "po → ana: fix the login bug"],
  );
});

test("the rail active mark follows the viewport top and falls back to the first", () => {
  const tops = [4, 12, 20, 28, 36];
  const at = (i: number) => tops[i] as number;
  assert.equal(activeMark(0, at, 100), undefined);
  assert.equal(activeMark(5, at, 0), 0, "before the first message");
  assert.equal(activeMark(5, at, 19), 1);
  assert.equal(
    activeMark(5, at, 20),
    2,
    "a top on the viewport edge is active",
  );
  assert.equal(activeMark(5, at, 100), 4);
});

test("the rail window centres, clamps and pins to the tail", () => {
  assert.deepEqual(railWindow(10, 0, 6, false), { start: 0, end: 4 });
  assert.deepEqual(railWindow(10, 5, 6, false), { start: 3, end: 7 });
  assert.deepEqual(railWindow(10, 9, 6, false), { start: 6, end: 10 });
  assert.deepEqual(railWindow(10, 2, 6, true), { start: 6, end: 10 });
  assert.deepEqual(railWindow(2, 1, 8, false), { start: 0, end: 2 });
  assert.deepEqual(railWindow(10, 5, 2, false), { start: 0, end: 0 });
});

test("rail rows map to the two chevrons and the marks in the window", () => {
  const window = { start: 3, end: 7 };
  assert.deepEqual(railHit(window, 6, 0), { kind: "up" });
  assert.deepEqual(railHit(window, 6, 1), { kind: "mark", at: 3 });
  assert.deepEqual(railHit(window, 6, 4), { kind: "mark", at: 6 });
  assert.deepEqual(railHit(window, 6, 5), { kind: "down" });
  assert.equal(railHit(window, 6, 6), undefined);
  assert.equal(railHit({ start: 0, end: 2 }, 6, 4), undefined);
});

test("the chevrons pick the previous and next mark, with no wrap", () => {
  assert.equal(railNeighbour(5, 2, true), 1);
  assert.equal(railNeighbour(5, 2, false), 3);
  assert.equal(railNeighbour(5, 0, true), undefined);
  assert.equal(railNeighbour(5, 4, false), undefined);
});

test("the preview shares the history row and cuts its second line", () => {
  const row =
    "po → ana: fix the login bug in the session refresh path before the release";
  const lines = historyPreview(row, 24);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "po → ana: fix the login");
  assert.ok(lines[1]?.endsWith("…"));
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.deepEqual(historyPreview("short", 24), ["short"]);
});
