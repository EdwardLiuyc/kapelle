/**
 * The daemon's rooms (#451): each one built, or a dismissed one the boot read
 * from `room.json` and did not build. Split from `daemon.ts` so the build
 * count can be tested without booting a server.
 *
 * A dismissed room takes no message and no new agent, and the chat hides it,
 * so the boot keeps only its record and root. `get` builds it on first use
 * and keeps the result. Two lookups at the same time share one build. A build
 * that fails drops the room, so it answers as a room the boot skipped did:
 * `GET /rooms` leaves it out, and every route is a 404. The caller's `build`
 * prints why. A `build` that throws leaves the room unbuilt, so the next
 * lookup tries again.
 *
 * Only a dismissed room may wait. Its list entry reads `dismissed` for the
 * room and every participant, and its pause is a no-op, so a shutdown that
 * meets a build still running loses nothing. A paused room deferred here
 * would list wrong and could miss its pause, so `defer` refuses one.
 *
 * `DELETE` and its preview build the room too, on purpose: every route takes
 * the one lookup, so none can meet a half-known room (#451, decision 3A).
 *
 * One map for both kinds, so `GET /rooms` keeps the boot's order: `set` on a
 * key already there keeps its place.
 *
 * It also keeps the ids of deleted rooms, the room creates and deletes that a
 * shutdown must wait for, and the scratch lock that serializes hall adds and
 * removes against scratch snapshots (M12-7a).
 */

import type { ServerResponse } from "node:http";
import type { RoomListEntry } from "../client/contract.ts";
import type { Room, RoomRecord } from "../core/room.ts";
import { type RoomState, toRecordListEntry, toRoomListEntry } from "./dto.ts";

/** A built room. `dismissed` is set only once a dismiss has *finished*
 *  tearing the room down, so it tells a settled dismiss from one still in
 *  flight. `root` keys the room's state directory, for a delete. */
export interface RoomEntry {
  room: Room;
  state: RoomState;
  root: string;
  dismissed?: boolean;
}

/** A dismissed room the boot did not build. */
export interface Unbuilt {
  record: RoomRecord;
  root: string;
}

const isBuilt = (slot: RoomEntry | Unbuilt): slot is RoomEntry =>
  "room" in slot;

/** `build` answers `undefined` for a room it could not build. */
export function createRooms(
  build: (id: string, unbuilt: Unbuilt) => Promise<RoomEntry | undefined>,
) {
  const slots = new Map<string, RoomEntry | Unbuilt>();
  const building = new Map<string, Promise<RoomEntry | undefined>>();
  const deleted = new Set<string>();
  /** A room create or delete still unanswered (#316). Neither room is in
   *  `slots` for the shutdown to pause, so it waits for the work and its
   *  reply instead. */
  const changes = new Set<Promise<void>>();
  return {
    set: (id: string, entry: RoomEntry) => void slots.set(id, entry),
    /** Keep a dismissed room's record; nothing is built until `get`. */
    defer(id: string, unbuilt: Unbuilt) {
      const { status } = unbuilt.record;
      if (status !== "dismissed") {
        throw new Error(`room ${id} is ${status}; only a dismissed one waits`);
      }
      slots.set(id, unbuilt);
    },
    delete: (id: string) => void slots.delete(id),
    /** Only the built rooms: an unbuilt one, or one still building, is
     *  dismissed and has nothing to pause. */
    built: () => [...slots.values()].filter(isBuilt),
    list: (): RoomListEntry[] =>
      [...slots.values()].map((slot) =>
        isBuilt(slot)
          ? toRoomListEntry(slot.state, slot.room)
          : toRecordListEntry(slot.record),
      ),
    /** The room `id` names, built if it was not, or undefined. */
    async get(id: string): Promise<RoomEntry | undefined> {
      const slot = slots.get(id);
      if (slot === undefined || isBuilt(slot)) return slot;
      let pending = building.get(id);
      if (!pending) {
        pending = build(id, slot)
          .then((entry) => {
            if (entry) slots.set(id, entry);
            else slots.delete(id);
            return entry;
          })
          .finally(() => building.delete(id));
        building.set(id, pending);
      }
      return pending;
    },
    /** Rooms deleted since this daemon started. Memory-only by design:
     *  after a restart the id is unknown again. */
    deleted,
    /** Holds the shutdown until `work` has settled and `res` is sent. A
     *  client that has gone does not end it: the work goes on without the
     *  client. Answers `work`, so its refusal still reaches the route. */
    hold(res: ServerResponse, work: Promise<void>) {
      const sent = new Promise<void>((ok) => res.once("close", ok));
      const held = Promise.all([work.catch(() => {}), sent]).then(() => {});
      changes.add(held);
      void held.then(() => changes.delete(held));
      return work;
    },
    /** Each held room create or delete still unanswered (#316). */
    changes: () => [...changes],
  };
}

/** Hall adds and removes are readers of the scratch tree, through `change`;
 *  listing and cleaning are writers, through `snapshot`. Readers may run
 *  together, but a writer waits for every in-flight reader and keeps new
 *  readers out until it finishes. An add makes a folder before its participant
 *  joins the roster, so a scratch snapshot must not run beside it. */
export function createScratchLock() {
  let scratchReaders = 0;
  let scratchWriting = false;
  let scratchWriters: Promise<void> = Promise.resolve();
  const scratchDrain: (() => void)[] = [];

  async function afterScratchWriter(
    previous: Promise<void>,
    mine: Promise<void>,
  ): Promise<void> {
    await previous;
    await mine;
  }

  async function change<T>(work: () => Promise<T>): Promise<T> {
    while (scratchWriting) await scratchWriters;
    scratchReaders++;
    try {
      return await work();
    } finally {
      scratchReaders--;
      if (scratchReaders === 0) {
        for (const wake of scratchDrain.splice(0)) wake();
      }
    }
  }

  async function snapshot<T>(work: () => Promise<T>): Promise<T> {
    const previous = scratchWriters;
    let finish!: () => void;
    const mine = new Promise<void>((resolve) => {
      finish = resolve;
    });
    scratchWriters = afterScratchWriter(previous, mine);
    await previous;
    scratchWriting = true;
    try {
      if (scratchReaders > 0) {
        await new Promise<void>((resolve) => scratchDrain.push(resolve));
      }
      return await work();
    } finally {
      scratchWriting = false;
      finish();
    }
  }

  return { change, snapshot };
}
