/**
 * What the full-screen chat shows — `chat/view.ts`, story M4-10 (#210).
 * One test per rule the story names.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newRoomState, type RoomState } from "../../client/room.ts";
import {
  dismissed,
  edited,
  left,
  opened,
  renamed,
  rows,
  seenIn,
  shows,
  step,
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
      stalled: false,
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

test("typing drops the pre-fill; an empty thread composer holds @name again", () => {
  const s = room(["ann"]);
  const ann = { roomId: "r1", participantId: "p-ann" };
  assert.deepEqual(edited(s, ann, "@ann hi", "@ann "), { prefill: "" });
  assert.deepEqual(edited(s, ann, "@ann ", "@ann "), { prefill: "@ann " });
  assert.deepEqual(edited(s, ann, "", ""), { prefill: "@ann ", text: "@ann " });
  assert.deepEqual(edited(s, { roomId: "r1" }, "", ""), { prefill: "" });
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
  assert.deepEqual(left(ann, "r1", "p-ann"), { roomId: "r1" });
  assert.equal(left(ann, "r1", "p-bob"), undefined);
  assert.equal(left(ann, "r2", "p-ann"), undefined);
  assert.equal(left({ roomId: "r1" }, "r1", "p-ann"), undefined);
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
