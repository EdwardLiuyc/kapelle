/**
 * The daemon's room map, called directly — `daemon/rooms.ts` (#451).
 * `tests/daemon-rooms.test.ts` covers a dismissed room over real sockets.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Room, RoomRecord } from "../../core/room.ts";
import { createRooms, type RoomEntry, type Unbuilt } from "../rooms.ts";

function record(id: string): RoomRecord {
  return {
    id,
    cwd: "/repo",
    title: "kept",
    createdAt: "2026-11-05T09:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    status: "dismissed",
    notices: [],
    participants: [
      {
        id: "p-1",
        name: "alice",
        role: "orchestrator",
        agent: "opencode",
        harness: "opencode",
        mode: "auto",
        settings: { allowReadOutsideRoot: false },
        worktree: "/wt/p-1",
        sessionId: "s-1",
        status: "paused",
        notices: [],
      },
    ],
  };
}

/** A map whose build counts its calls and waits for `release`. */
function counted(answer: (u: Unbuilt) => RoomEntry | undefined) {
  const built: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const rooms = createRooms(async (id, unbuilt) => {
    built.push(id);
    await gate;
    return answer(unbuilt);
  });
  return { rooms, built, release };
}

const entry = ({ record, root }: Unbuilt): RoomEntry => ({
  room: { status: () => "dismissed", participants: [] } as unknown as Room,
  state: { ...record, turnCap: 1, turnCount: 0 },
  root,
  dismissed: true,
});

test("a deferred room is listed from its record and not built", () => {
  const { rooms, built } = counted(entry);
  rooms.defer("a", { record: record("a"), root: "/repo" });
  rooms.defer("b", { record: record("b"), root: "/repo" });
  const [a, b] = rooms.list();
  assert.deepEqual(a, {
    id: "a",
    cwd: "/repo",
    title: "kept",
    status: "dismissed",
    updatedAt: "2026-11-05T10:00:00.000Z",
    participants: [
      { id: "p-1", name: "alice", role: "orchestrator", status: "dismissed" },
    ],
  });
  assert.equal(b?.id, "b");
  assert.deepEqual(rooms.built(), []);
  assert.deepEqual(built, [], "the boot builds no dismissed room");
});

test("two lookups at the same time share one build, and the next reuses it", async () => {
  const { rooms, built, release } = counted(entry);
  rooms.defer("a", { record: record("a"), root: "/repo" });
  const both = Promise.all([rooms.get("a"), rooms.get("a")]);
  release();
  const [one, two] = await both;
  assert.ok(one);
  assert.equal(one, two);
  assert.equal(await rooms.get("a"), one);
  assert.deepEqual(built, ["a"]);
  assert.deepEqual(rooms.built(), [one]);
});

test("a build that fails drops the room from the list and is not tried again", async () => {
  const { rooms, built, release } = counted(() => undefined);
  rooms.defer("a", { record: record("a"), root: "/repo" });
  rooms.defer("b", { record: record("b"), root: "/repo" });
  release();
  assert.equal(await rooms.get("a"), undefined);
  assert.deepEqual(
    rooms.list().map((r) => r.id),
    ["b"],
  );
  assert.equal(await rooms.get("a"), undefined);
  assert.deepEqual(built, ["a"]);
});

test("an unknown id is undefined, and a built room keeps its place in the list", async () => {
  const { rooms, release } = counted(entry);
  rooms.defer("a", { record: record("a"), root: "/repo" });
  rooms.defer("b", { record: record("b"), root: "/repo" });
  release();
  assert.equal(await rooms.get("nope"), undefined);
  await rooms.get("b");
  assert.deepEqual(
    rooms.list().map((r) => r.id),
    ["a", "b"],
  );
  assert.equal(rooms.built().length, 1);
  rooms.delete("a");
  assert.deepEqual(
    rooms.list().map((r) => r.id),
    ["b"],
  );
});

test("defer refuses a room that is not dismissed, so a paused one never lists as dismissed", () => {
  const { rooms } = counted(entry);
  assert.throws(
    () =>
      rooms.defer("a", {
        record: { ...record("a"), status: "paused" },
        root: "/repo",
      }),
    /room a is paused; only a dismissed one waits/,
  );
  assert.deepEqual(rooms.list(), []);
});

test("a build that throws leaves the room unbuilt, and the next lookup tries again", async () => {
  let calls = 0;
  const rooms = createRooms(async (_id, unbuilt) => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return entry(unbuilt);
  });
  rooms.defer("a", { record: record("a"), root: "/repo" });
  await assert.rejects(rooms.get("a"), /boom/);
  assert.deepEqual(
    rooms.list().map((r) => r.id),
    ["a"],
  );
  assert.ok(await rooms.get("a"));
  assert.equal(calls, 2);
});
