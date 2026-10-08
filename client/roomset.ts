/**
 * The rooms a screen follows (M4-11): one stream and one reducer per room.
 *
 * - A room made elsewhere joins on the next `GET /rooms`, every 5 s.
 * - A dismissed room leaves the set.
 * - A room whose stream ended and that was not dismissed stays, marked
 *   lost.
 * - The set ends when every room in it lost its stream. With no room left
 *   it stays (M4-5), until the daemon is gone or answers `401`: a daemon
 *   that came back has a new token, and no stream would say so.
 *
 * `readRoom` and `reconcile` are here too: the piped screen follows its one
 * room with them. `reconcile` says what happened, not a line. Its lines name
 * `kapelle chat attach`, so the screen writes the words (`chat/common.ts`).
 *
 * **Two addresses, as before M4-11.** The poll and `GET /rooms/:id` use the
 * address the screen started with. The streams and `reconcile` read it again
 * each time, through `address`, because `client/` may not import
 * `core/runtime.ts` (S8). A poll that read it again would follow a restarted
 * daemon instead of ending the screen; riding out a restart is M6-7d's (#236).
 *
 * It draws nothing. The screen gets each line after the reducer took it,
 * and keeps the view, the question box and the words.
 */

import type {
  RoomDto,
  RoomEventLine,
  RoomListEntry,
  RoomStatus,
} from "./contract.ts";
import { call, type DaemonAddress, request } from "./daemon.ts";
import {
  applyLine,
  applyStatus,
  type Entry,
  newRoomState,
  type RoomState,
} from "./room.ts";
import { type Connect, followEvents } from "./stream.ts";

/** The daemon's address, read again on each call. Throws when there is no
 *  daemon, with a message that says how to start one. */
export type ReadAddress = () => Promise<DaemonAddress>;

/** What happened to a room whose stream ended without our dismiss. */
export type Ended =
  /** Someone dismissed it. */
  | { kind: "dismissed" }
  /** The stream died and the room did not. */
  | { kind: "alive"; status: RoomStatus }
  /** The daemon answered `404`: it may have restarted. */
  | { kind: "unknown" }
  /** The daemon answered with another status. */
  | { kind: "refused"; status: number }
  /** No daemon answered. */
  | { kind: "gone"; message: string };

/** The exit code for a room that ended so. */
export const codeOf = (e: Ended) => (e.kind === "dismissed" ? 0 : 1);

/**
 * Reads a room's events into `onEvent` until the daemon ends the stream —
 * which it does when the room is dismissed. A cut while the daemon still
 * answers reconnects and resumes after the last event seen
 * (`client/stream.ts`). Throws when the daemon stops or refuses the stream.
 */
export async function readRoom(
  address: ReadAddress,
  id: string,
  onEvent: (event: RoomEventLine) => void,
): Promise<void> {
  // A room survives a daemon restart (M6-7a), but this reader does not wait
  // for one yet; that is M6-7d's (#236). No daemon, or one that does not
  // answer, ends the stream at once, which is also why there is no version
  // check here.
  const connect: Connect = async (after, signal) => {
    let d: DaemonAddress;
    try {
      d = await address();
    } catch {
      return undefined;
    }
    try {
      return await request(d, `/rooms/${encodeURIComponent(id)}/events`, {
        signal,
        headers: { "last-event-id": String(after) },
      });
    } catch (err) {
      // An abort is the reader's own silence timer: try again.
      if (signal.aborted) throw err;
      return undefined;
    }
  };
  for await (const event of followEvents<RoomEventLine>(connect)) {
    onEvent(event);
  }
}

/** The stream ended without our dismiss: ask the daemon what happened. */
export async function reconcile(
  address: ReadAddress,
  id: string,
): Promise<Ended> {
  try {
    const r = await call<RoomDto>(await address(), `/rooms/${id}`);
    if (r.ok) {
      return r.body.status === "dismissed"
        ? { kind: "dismissed" }
        : { kind: "alive", status: r.body.status };
    }
    if (r.status === 404) return { kind: "unknown" };
    return { kind: "refused", status: r.status };
  } catch (err) {
    return { kind: "gone", message: (err as Error).message };
  }
}

/** One room the set follows: its stream runs into its own reducer for as
 *  long as the set is up. */
export interface Followed {
  entry: RoomListEntry;
  state: RoomState;
  /** From `GET /rooms/:id`: each participant's checkout and notices. */
  dto?: RoomDto;
  /** Set when its stream ended and the room did not: what happened. */
  lost?: Ended;
}

/** Why the set ends: every room lost its stream (the last one to go is
 *  `roomId`), or no room is left and the daemon is gone. */
export type End =
  | { kind: "lost"; roomId: string; ended: Ended; err?: unknown }
  | { kind: "gone" };

export interface RoomSetEvents {
  /** A line came, and the room's reducer took it: `entry` is what it made. */
  line(roomId: string, line: RoomEventLine, entry: Entry | undefined): void;
  /** `GET /rooms/:id` answered: the room's `dto` changed. */
  loaded(roomId: string): void;
  /** The poll answered. */
  polled(): void;
  /** A room's stream ended and the set goes on. `r` is the room, already
   *  out of the set when it was dismissed. */
  closed(roomId: string, ended: Ended, r: Followed | undefined): void;
  /** The set ends: called once, and the poll stops with it. A stream that
   *  ends later still calls `closed`. */
  end(why: End): void;
}

export interface RoomSet {
  /** The rooms, in the order they joined. */
  readonly rooms: ReadonlyMap<string, Followed>;
  /** Follows a room, as one the screen just made. A room followed already
   *  is left as it is. */
  add(entry: RoomListEntry): void;
  /** Follows `list` and starts the poll. */
  start(list: readonly RoomListEntry[]): void;
  /** Stops the poll. */
  stop(): void;
}

/** The set over `d`. `pollMs` is a parameter so a test need not wait 5 s. */
export function roomSet(
  d: DaemonAddress,
  address: ReadAddress,
  on: RoomSetEvents,
  pollMs = 5000,
): RoomSet {
  const rooms = new Map<string, Followed>();
  let poll: NodeJS.Timeout | undefined;
  let over = false;
  /** Ends the set once: a poll that fails again must not end it again. */
  const finish = (why: End) => {
    if (over) return;
    over = true;
    clearInterval(poll);
    on.end(why);
  };

  /** Reads the room again for each participant's checkout and notices, and
   *  the `paused` or `killed` a restart left, which no line says (M6-7a). */
  const loadDto = (r: Followed) => {
    call<RoomDto>(d, `/rooms/${r.entry.id}`).then(
      (res) => {
        if (!res.ok) return;
        r.dto = res.body;
        applyStatus(r.state, res.body);
        on.loaded(r.entry.id);
      },
      // The stream says what happened to the daemon; a header can wait.
      () => {},
    );
  };

  const onLine = (r: Followed, line: RoomEventLine) => {
    const e = applyLine(r.state, line);
    on.line(r.entry.id, line, e);
    // A participant who joined after the room was read has no checkout or
    // notices in the header until the room is read again.
    if (
      line.update.sessionUpdate === "_client_participant_added" &&
      r.dto &&
      !r.dto.participants.some((p) => p.id === line.participantId)
    ) {
      loadDto(r);
    }
  };

  /** A room's stream ended: ask the daemon why. */
  const closed = async (id: string, err?: unknown) => {
    const ended = await reconcile(address, id);
    const r = rooms.get(id);
    if (ended.kind === "dismissed") rooms.delete(id);
    else if (r) r.lost = ended;
    const all = [...rooms.values()];
    if (all.length > 0 && !all.some((x) => !x.lost)) {
      finish({ kind: "lost", roomId: id, ended, err });
      return;
    }
    on.closed(id, ended, r);
  };

  const add = (entry: RoomListEntry) => {
    if (rooms.has(entry.id)) return;
    const r: Followed = { entry, state: newRoomState() };
    rooms.set(entry.id, r);
    loadDto(r);
    readRoom(address, entry.id, (line) => onLine(r, line)).then(
      () => closed(entry.id),
      (err) => closed(entry.id, err),
    );
  };

  // Rooms made in another terminal join here. While a room is open, a failed
  // poll changes nothing: a stream that ends says what happened. With none
  // open, no stream would: a daemon that is gone, or one that came back with
  // a new token (`401`), ends the set (M4-5).
  // ponytail: ends rather than follows a restarted daemon; M6-7d (#236) makes the
  // screen ride out a restart, as `attach` does.
  const tick = () => {
    call<RoomListEntry[]>(d, "/rooms").then(
      (res) => {
        if (!res.ok) {
          if (res.status === 401 && rooms.size === 0) finish({ kind: "gone" });
          return;
        }
        for (const entry of res.body) {
          const r = rooms.get(entry.id);
          if (r) r.entry = entry;
          else if (entry.status !== "dismissed") add(entry);
        }
        on.polled();
      },
      () => {
        if (rooms.size === 0) finish({ kind: "gone" });
      },
    );
  };

  return {
    rooms,
    add,
    start(list) {
      clearInterval(poll);
      poll = setInterval(tick, pollMs);
      for (const entry of list) add(entry);
    },
    stop() {
      clearInterval(poll);
    },
  };
}
