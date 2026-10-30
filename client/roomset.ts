/**
 * The rooms a screen follows (M4-11): one stream and one reducer per room.
 *
 * - A room made elsewhere joins on the next `GET /rooms`, every 5 s.
 * - A dismissed room leaves the set, unless the screen retains it for
 *   `/delete` (#352).
 * - A room whose stream ended and that was not dismissed stays, marked
 *   lost.
 * - The set ends when every room in it lost its stream. With no room left
 *   it stays (M4-5), until the daemon is gone for `waitMs` or answers `401`.
 *
 * **A restart is waited out** (M6-7d, #236). A daemon that stops, cleanly or
 * not, gets `waitMs` (30 s) to come back; then the set ends as before. A
 * clean stop closes the listener first, then pauses each room, which ends
 * its stream normally (`daemon.ts`, `shutdown`). So a stream that ends when
 * no daemon answers is a stop, and it waits too.
 * `followDaemon` reads `daemon.json` on every call, through `address`,
 * because `client/` may not import `core/runtime.ts` (S8). A new token gets
 * `GET /version` once, then the screen's one address object takes it in
 * place, so every later call goes to the new daemon. A restart writes no line
 * (E5), so each room is read again then for its `paused` and `killed`.
 *
 * `readRoom` and `reconcile` are here too: the piped screen follows its one
 * room with them. `reconcile` says what happened, not a line. Its lines name
 * `kapelle chat attach`, so the screen writes the words (`chat/common.ts`).
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
import {
  call,
  checkVersion,
  type DaemonAddress,
  request,
  VersionRefused,
} from "./daemon.ts";
import {
  applyLine,
  applyStatus,
  type Entry,
  newRoomState,
  printable,
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

/** How long a screen waits for a daemon that went away (M6-7d). */
const WAIT_MS = 30_000;

/**
 * `address`, over `d`: the one address object a screen passes to every call.
 * A new token in `daemon.json` is checked with `GET /version` once, then `d`
 * takes it in place and `onNew` runs with the `minor` warning, if any. A
 * different `major` throws `VersionRefused` to this call and every later one.
 */
export function followDaemon(
  d: DaemonAddress,
  address: ReadAddress,
  onNew: (warning?: string) => void,
): ReadAddress {
  let checking: { token: string; done: Promise<void> } | undefined;
  return async () => {
    const fresh = await address();
    if (fresh.token === d.token) return d;
    if (checking?.token !== fresh.token) {
      const done = checkVersion(fresh).then((warning) => {
        Object.assign(d, fresh);
        onNew(warning);
      });
      checking = { token: fresh.token, done };
      // A daemon that did not answer is asked again on the next call.
      done.catch((err) => {
        if (!(err instanceof VersionRefused) && checking?.done === done) {
          checking = undefined;
        }
      });
    }
    await checking.done;
    return d;
  };
}

/**
 * Reads a room's events into `onEvent` until a daemon that answers ends
 * the stream, and resolves with what `reconcile` found then. A cut
 * reconnects and resumes after the last event seen (`client/stream.ts`).
 * With no daemon, it waits `waitMs` for one; a clean end when no daemon
 * answers is a stop, and it waits too. Throws when no daemon came back, or
 * when one refuses the stream or its version.
 *
 * **This rests on the shutdown order** (`daemon.ts`, `shutdown`): the
 * listener closes before the rooms pause, so the reconcile after a clean
 * stop finds no daemon. A daemon that still answered would say `paused`, and
 * the screen would end instead of waiting.
 */
export async function readRoom(
  address: ReadAddress,
  id: string,
  onEvent: (event: RoomEventLine) => void,
  waitMs = WAIT_MS,
): Promise<Ended> {
  let seen = 0;
  let away: number | undefined;
  /** No daemon answered: try again until `waitMs` after the first miss. */
  const missed = () => {
    away ??= Date.now();
    if (Date.now() - away >= waitMs) return undefined;
    throw new Error("waiting for the daemon");
  };
  // `seen`, not the reader's `after`: a new reader after a stop starts at 0.
  const connect: Connect = async (_after, signal) => {
    let d: DaemonAddress;
    try {
      d = await address();
    } catch (err) {
      if (err instanceof VersionRefused) throw err;
      return missed();
    }
    try {
      const res = await request(d, `/rooms/${encodeURIComponent(id)}/events`, {
        signal,
        headers: { "last-event-id": String(seen) },
      });
      away = undefined;
      return res;
    } catch (err) {
      // An abort is the reader's own silence timer: try again.
      if (signal.aborted) throw err;
      return missed();
    }
  };
  for (;;) {
    for await (const event of followEvents<RoomEventLine>(connect)) {
      // Each turn is a new reader, which drops only what it saw itself (F4).
      if (event.seq <= seen) continue;
      seen = event.seq;
      onEvent(event);
    }
    // A daemon that answers ended the stream on purpose: a dismiss, or a
    // room it cannot serve.
    const ended = await reconcile(address, id);
    if (ended.kind !== "gone") return ended;
    await new Promise((ok) => setTimeout(ok, 250));
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
  /** One `GET /rooms/:id` at a time: two replies cannot land out of order. */
  reading?: boolean;
  /** A trigger arrived while that read was in flight: read once more after
   *  it, because the answer may predate the trigger (#232). `loaded` redraws
   *  more than `reloaded`, so it wins when both wait. */
  again?: "loaded" | "reloaded";
  /** Set when its stream ended and the room did not: what happened. */
  lost?: Ended;
  /** The last poll asked before this screen renamed the room. Its reply,
   *  and every older one, may hold the old title, so they keep this one. */
  renamedAfter?: number;
  /** Kept in the set after its stream ended `dismissed`, so its screen can
   *  offer `/delete` (#352). */
  held?: boolean;
}

/** Why the set ends: every room lost its stream (the last one to go is
 *  `roomId`), or no room is left and the daemon is gone, or a new one
 *  refused this client's version (`message`). */
export type End =
  | { kind: "lost"; roomId: string; ended: Ended; err?: unknown }
  | { kind: "gone"; message?: string };

export interface RoomSetEvents {
  /** A line came, and the room's reducer took it: `entry` is what it made. */
  line(roomId: string, line: RoomEventLine, entry: Entry | undefined): void;
  /** `GET /rooms/:id` answered: the room's `dto` changed. */
  loaded(roomId: string): void;
  /** A turn ended and the room was read again, so its header (the branch,
   *  the checkout) may have changed; the timeline did not. A screen updates
   *  the header without rebuilding the transcript. */
  reloaded(roomId: string): void;
  /** The poll answered. */
  polled(): void;
  /** A new daemon answered after a restart, with its `minor` warning. */
  restarted(warning?: string): void;
  /** The poll found no daemon, once per outage: the set waits `waitMs`. */
  away(waitMs: number): void;
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
  /** Shows the title this screen gave room `id` at once. The stream has no
   *  line for it, and a poll asked before it cannot bring the old one back. */
  retitle(id: string, title: string): void;
  /** Stops the poll. */
  stop(): void;
  /** Keep a room in the set after its stream ends `dismissed` (`keep`
   *  false undoes it). Used for an attached dismissed room and while a
   *  delete runs, so the screen can show its refusal and retry. */
  retain(id: string, keep?: boolean): void;
  /** Drops a room without treating its end as a close. The screen calls this
   *  after a successful delete and chooses where to go. */
  drop(id: string): void;
  /** Reads `daemon.json` now, as the next poll would, so a send right after
   *  a restart has the new token. Never throws: a call on `d` says why. */
  fresh(): Promise<void>;
}

/** The set over `d`, which follows a restart in place. `pollMs` and `waitMs`
 *  are parameters so a test need not wait 5 s or 30 s. */
export function roomSet(
  d: DaemonAddress,
  address: ReadAddress,
  on: RoomSetEvents,
  pollMs = 5000,
  waitMs = WAIT_MS,
): RoomSet {
  const rooms = new Map<string, Followed>();
  const retained = new Set<string>();
  /** Rooms a successful delete removed. A poll answer from before it must
   *  not bring one back. */
  const dropped = new Set<string>();
  // A restart writes no line: read each room again for what it left.
  const current = followDaemon(d, address, (warning) => {
    on.restarted(warning);
    for (const r of rooms.values()) loadDto(r);
  });
  let poll: NodeJS.Timeout | undefined;
  /** How many polls were asked. */
  let asked = 0;
  let over = false;
  /** Ends the set once: a poll that fails again must not end it again. */
  const finish = (why: End) => {
    if (over) return;
    over = true;
    clearInterval(poll);
    on.end(why);
  };

  /** Reads the room again for each participant's checkout and notices, and
   *  the `paused` or `killed` a restart left, which no line says (M6-7a).
   *  `why` is `reloaded` for the read a turn end asks for: the timeline is
   *  unchanged, so the screen need not rebuild the transcript.
   *
   *  One read at a time per room. A trigger that lands during a read marks
   *  `again`, and that read answers it with one more: the reply may predate
   *  the trigger, and serialized replies cannot land out of order (#232). */
  const loadDto = (r: Followed, why: "loaded" | "reloaded" = "loaded") => {
    if (r.reading) {
      // `loaded` redraws more than `reloaded`, so it wins.
      if (r.again !== "loaded") r.again = why;
      return;
    }
    r.reading = true;
    /** The read is over. A trigger during it gets one more read, also when
     *  this one failed: the reply, if any, may predate the trigger. */
    const done = () => {
      r.reading = false;
      const again = r.again;
      r.again = undefined;
      if (!again) return;
      // The room may have left the set (dismissed) or the set may have
      // ended while the read ran: a chained read would answer nobody.
      if (over || rooms.get(r.entry.id) !== r) return;
      loadDto(r, again);
    };
    call<RoomDto>(d, `/rooms/${r.entry.id}`).then(
      (res) => {
        if (res.ok) {
          r.dto = res.body;
          // A reply can carry a status no line did; that changes the
          // timeline too, so it needs the full redraw `loaded` asks for.
          const moved = applyStatus(r.state, res.body);
          if (why === "loaded" || moved) on.loaded(r.entry.id);
          else on.reloaded(r.entry.id);
        }
        done();
      },
      // The stream says what happened to the daemon; a header can wait.
      done,
    );
  };

  const onLine = (r: Followed, line: RoomEventLine) => {
    const e = applyLine(r.state, line);
    on.line(r.entry.id, line, e);
    const update = line.update.sessionUpdate;
    // The header's branch, base and model are in `GET /rooms/:id`, not the
    // reducer. A turn can rename the branch or rebase it, and a revive can
    // set the model, so read the room again when either ends. A change of
    // model (M9-6) can also add a refusal notice, so that read redraws the
    // transcript; the others only need the header.
    if (
      update === "_client_participant_changed" &&
      line.update.model !== undefined
    ) {
      loadDto(r, "loaded");
    } else if (
      update === "_client_turn_ended" ||
      update === "_client_participant_revived"
    ) {
      loadDto(r, "reloaded");
    } else if (
      // A participant who joined after the room was read has no checkout or
      // notices in the header until the room is read again. An unset dto
      // counts as missing too, so a join that beats the first answer reads
      // again (#232); `loadDto` keeps it to one read at a time.
      update === "_client_participant_added" &&
      !r.dto?.participants.some((p) => p.id === line.participantId)
    ) {
      loadDto(r);
    }
  };

  /** A room's stream ended: ask the daemon why. */
  /** A room's stream ended. `known` is what `readRoom` found; after a
   *  throw, ask the daemon. */
  const closed = async (id: string, known?: Ended, err?: unknown) => {
    const ended = known ?? (await reconcile(current, id));
    const r = rooms.get(id);
    if (!r && dropped.has(id)) return;
    // A delete still reading a dirty room is briefly out of `GET /rooms`:
    // while held, its stream's 404 is not the room's end (#352).
    const held =
      r?.held === true &&
      (ended.kind === "dismissed" || ended.kind === "unknown");
    if (ended.kind === "dismissed" && !held) rooms.delete(id);
    else if (r) {
      if (held) r.lost = undefined;
      else r.lost = ended;
    }
    const all = [...rooms.values()];
    if (all.length > 0 && !all.some((x) => !x.lost || x.held)) {
      finish({ kind: "lost", roomId: id, ended, err });
      return;
    }
    if (held) return;
    on.closed(id, ended, r);
  };

  /** An entry as a screen draws it: a title is free text, and every screen
   *  draws it on one line. */
  const shownEntry = (entry: RoomListEntry): RoomListEntry =>
    entry.title === undefined
      ? entry
      : { ...entry, title: printable(entry.title) };

  const add = (entry: RoomListEntry) => {
    if (rooms.has(entry.id)) return;
    const r: Followed = {
      entry: shownEntry(entry),
      state: newRoomState(),
      ...(retained.has(entry.id) && { held: true }),
    };
    rooms.set(entry.id, r);
    loadDto(r);
    readRoom(current, entry.id, (line) => onLine(r, line), waitMs).then(
      (ended) => closed(entry.id, ended),
      (err) => closed(entry.id, undefined, err),
    );
  };

  // Rooms made in another terminal join here. While a room is open, a failed
  // poll changes nothing: a stream that ends says what happened. With no live
  // stream left, one would: a daemon gone for `waitMs`, a `401`, or a new
  // daemon that refuses our version ends the set (M4-5, M6-7d).
  let away: number | undefined;
  /** A held dismissed room has no live stream but must keep the screen open
   *  while the daemon answers, so `/delete` can still be used (#352). */
  const noLive = () => ![...rooms.values()].some((r) => !r.lost && !r.held);
  const tick = () => {
    const ask = ++asked;
    current()
      .then((a) => call<RoomListEntry[]>(a, "/rooms"))
      .then(
        (res) => {
          away = undefined;
          if (!res.ok) {
            if (res.status === 401 && noLive()) {
              finish({ kind: "gone" });
            }
            return;
          }
          for (const entry of res.body) {
            const r = rooms.get(entry.id);
            if (r) {
              const stale = ask <= (r.renamedAfter ?? 0);
              r.entry = shownEntry(
                stale ? { ...entry, title: r.entry.title } : entry,
              );
            } else if (entry.status !== "dismissed" && !dropped.has(entry.id))
              add(entry);
          }
          on.polled();
        },
        (err) => {
          if (err instanceof VersionRefused) {
            if (noLive()) finish({ kind: "gone", message: err.message });
            return;
          }
          if (away === undefined) on.away(waitMs);
          away ??= Date.now();
          if (noLive() && Date.now() - away >= waitMs) {
            finish({ kind: "gone" });
          }
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
    retain(id, keep = true) {
      if (keep) retained.add(id);
      else retained.delete(id);
      const r = rooms.get(id);
      if (r) r.held = keep;
    },
    drop(id) {
      retained.delete(id);
      dropped.add(id);
      rooms.delete(id);
    },
    retitle(id, title) {
      const r = rooms.get(id);
      if (!r) return;
      r.entry = shownEntry({ ...r.entry, title });
      r.renamedAfter = asked;
    },
    fresh: () =>
      current().then(
        () => {},
        () => {},
      ),
  };
}
