/**
 * The question queue — `client/questions.ts`, story M4-9 (#209). One test
 * per rule M4-3 decided.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { questionQueue } from "../questions.ts";

/** Open questions by room, as the reducers would hold them. A test closes
 *  one by deleting it, or a whole room by deleting the room. */
const setup = () => {
  const rooms = new Map<string, Set<string>>();
  const ask = (roomId: string, id: string) => {
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId)?.add(id);
    queue.add(id, roomId);
  };
  const queue = questionQueue((roomId, id) =>
    rooms.get(roomId)?.has(id) ? id : undefined,
  );
  return { rooms, ask, queue };
};

test("one queue over every room, oldest first", () => {
  const { ask, queue } = setup();
  ask("r1", "q1");
  ask("r2", "q2");
  ask("r1", "q3");
  assert.deepEqual(queue.open(), ["q1", "q2", "q3"]);
  assert.equal(queue.next(false), "q1");
});

test("a question put aside never opens by itself again, but is still listed", () => {
  const { ask, queue } = setup();
  ask("r1", "q1");
  ask("r1", "q2");
  queue.show("q1");
  assert.equal(queue.away(), "q1");
  assert.equal(queue.asking, undefined);
  assert.equal(queue.next(false), "q2");
  queue.show("q2");
  queue.away();
  assert.equal(queue.next(false), undefined);
  assert.deepEqual(queue.open(), ["q1", "q2"]);
});

test("a box that held no question puts nothing aside", () => {
  const { ask, queue } = setup();
  ask("r1", "q1");
  assert.equal(queue.away(), undefined);
  assert.equal(queue.next(false), "q1");
});

test("another pop-up over the box does not put its question aside", () => {
  const { ask, queue } = setup();
  ask("r1", "q1");
  queue.show("q1");
  queue.show(undefined);
  assert.equal(queue.away(), undefined);
  assert.equal(queue.next(false), "q1");
});

test("a question closed elsewhere leaves the queue, aside or not", () => {
  const { rooms, ask, queue } = setup();
  ask("r1", "q1");
  ask("r2", "q2");
  ask("r2", "q3");
  queue.show("q1");
  queue.away();
  rooms.get("r1")?.delete("q1");
  rooms.delete("r2");
  assert.deepEqual(queue.open(), []);
  // Back in the reducer, as after a replay: no longer aside.
  ask("r1", "q1");
  assert.equal(queue.next(false), "q1");
});

test("a question asked again keeps its place while open, and goes last once closed", () => {
  const { rooms, ask, queue } = setup();
  ask("r1", "q1");
  ask("r1", "q2");
  ask("r1", "q1");
  assert.deepEqual(queue.open(), ["q1", "q2"]);
  rooms.get("r1")?.delete("q1");
  assert.deepEqual(queue.open(), ["q2"]);
  ask("r1", "q1");
  assert.deepEqual(queue.open(), ["q2", "q1"]);
});

test("nothing opens while something is in the way", () => {
  const { ask, queue } = setup();
  ask("r1", "q1");
  assert.equal(queue.next(true), undefined);
  assert.equal(queue.next(false), "q1");
});

test("the box's place is n of m, and follows the open questions", () => {
  const { rooms, ask, queue } = setup();
  ask("r1", "q1");
  ask("r1", "q2");
  queue.show("q2");
  assert.deepEqual(queue.place(), { at: 2, of: 2 });
  ask("r2", "q3");
  assert.deepEqual(queue.place(), { at: 2, of: 3 });
  rooms.get("r1")?.delete("q1");
  assert.deepEqual(queue.place(), { at: 1, of: 2 });
});

test("a shown question that closed has no place, and is not shown or aside", () => {
  const { rooms, ask, queue } = setup();
  ask("r1", "q1");
  queue.show("q1");
  rooms.delete("r1");
  assert.equal(queue.place(), undefined);
  assert.equal(queue.asking, undefined);
  assert.equal(queue.away(), undefined);
});
