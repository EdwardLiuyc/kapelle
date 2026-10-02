/**
 * `chat/common.ts` — what both chat screens use (M4-7).
 *
 * The daemon's address, a room's stream and the words for a stream that
 * ended without our dismiss, the colours, and the roster the resolver
 * reads. It draws nothing itself. M4-11 moves `readRoom` and `reconcile`
 * on to `client/`.
 */

import { join } from "node:path";

import type { RoomDto, RoomEventLine } from "../client/contract.ts";
import {
  call,
  type DaemonAddress,
  readDaemonFile,
  request,
} from "../client/daemon.ts";
import type { Named } from "../client/mention.ts";
import { type RoomState, roster } from "../client/room.ts";
import { type Connect, followEvents } from "../client/stream.ts";
import { runtimeDir } from "../core/runtime.ts";

const daemonFile = () => join(runtimeDir(), "daemon.json");

/** The daemon named in `daemon.json`, or a throw that says how to start one.
 *  Read again on every call: a daemon that restarts has a new token. */
async function address(): Promise<DaemonAddress> {
  const d = await readDaemonFile(daemonFile());
  if (typeof d === "string") {
    throw new Error(
      `no daemon is listening (${daemonFile()} is missing or not ready). ` +
        "Start one with: kapelle daemon start",
    );
  }
  return d;
}

/**
 * Reads a room's events into `onEvent` until the daemon ends the stream —
 * which it does when the room is dismissed. A cut while the daemon still
 * answers reconnects and resumes after the last event seen
 * (`client/stream.ts`). Throws when the daemon stops or refuses the stream.
 */
async function readRoom(
  id: string,
  onEvent: (event: RoomEventLine) => void,
): Promise<void> {
  // A room does not survive a daemon restart, so there is nothing to wait
  // for: no daemon, or one that does not answer, ends the stream at once.
  // That is also why there is no version check here.
  const connect: Connect = async (after, signal) => {
    const d = await readDaemonFile(daemonFile());
    if (typeof d === "string") return undefined;
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

/** The stream ended without our dismiss: ask the daemon what happened.
 *  `dismissed` is someone else's dismissal; anything else means the daemon or
 *  its stream is gone and the room's fate is unknown. */
async function reconcile(id: string): Promise<{ code: number; line: string }> {
  try {
    const r = await call<RoomDto>(await address(), `/rooms/${id}`);
    if (r.ok) {
      if (r.body.status === "dismissed") {
        return { code: 0, line: "the room was dismissed" };
      }
      // The stream died, the room did not. Name the state the daemon
      // reports rather than the status of the GET that reported it, and
      // say how to get back in.
      return {
        code: 1,
        line:
          `! lost the room stream; the room is still ${r.body.status} — ` +
          `rejoin with: kapelle chat attach ${id}`,
      };
    }
    if (r.status === 404) {
      return {
        code: 1,
        line: `! the daemon no longer knows room ${id}; it may have restarted`,
      };
    }
    return {
      code: 1,
      line: `! lost the room stream (HTTP ${r.status}); the room may still be alive`,
    };
  } catch (err) {
    return { code: 1, line: `! lost the daemon: ${(err as Error).message}` };
  }
}

const sgr = (open: number, close: number) => (s: string) =>
  `\x1b[${open}m${s}\x1b[${close}m`;
const bold = sgr(1, 22);
const dim = sgr(2, 22);
const italic = sgr(3, 23);
const underline = sgr(4, 24);
const cyan = sgr(36, 39);
const green = sgr(32, 39);
const yellow = sgr(33, 39);
const magenta = sgr(35, 39);
const plain = (s: string) => s;

/** A rendered line without its padding: the trailing spaces and the style
 *  codes among them go, and a styled line ends with a reset, because a
 *  wrapped line can open a style and leave it open. */
const unpad = (line: string) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const text = line.replace(/(?: |\x1b\[[0-9;]*m)+$/, "");
  return text.includes("\x1b") ? `${text}\x1b[0m` : text;
};

/** The roster the resolver reads. Before the stream replays the roster
 *  lines, the one the daemon sent with the room stands in. Only before:
 *  once the last participant is removed, the stand-in would name it. */
const rosterOf = (state: RoomState, fallback: readonly Named[]) =>
  state.participants.size > 0 ? roster(state) : fallback;

export {
  address,
  bold,
  cyan,
  dim,
  green,
  italic,
  magenta,
  plain,
  readRoom,
  reconcile,
  rosterOf,
  sgr,
  underline,
  unpad,
  yellow,
};
