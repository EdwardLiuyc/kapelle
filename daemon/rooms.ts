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
 * prints why.
 *
 * One map for both kinds, so `GET /rooms` keeps the boot's order: `set` on a
 * key already there keeps its place.
 */

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
  return {
    set: (id: string, entry: RoomEntry) => void slots.set(id, entry),
    /** Keep a dismissed room's record; nothing is built until `get`. */
    defer: (id: string, unbuilt: Unbuilt) => void slots.set(id, unbuilt),
    delete: (id: string) => void slots.delete(id),
    /** Only the built rooms: an unbuilt one has nothing to pause. */
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
  };
}
