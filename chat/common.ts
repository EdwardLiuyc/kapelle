/**
 * `chat/common.ts` — what both chat screens use (M4-7).
 *
 * The daemon's address, the words for a stream that ended without our
 * dismiss, the colours, and the roster the resolver reads. It draws nothing
 * itself. Following a room is `client/roomset.ts` (M4-11).
 */

import { join } from "node:path";

import { type DaemonAddress, readDaemonFile } from "../client/daemon.ts";
import type { Named } from "../client/mention.ts";
import { type RoomState, roster } from "../client/room.ts";
import type { Ended } from "../client/roomset.ts";
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

/** The line for a room whose stream ended, from what `reconcile` found.
 *  It starts with `!` unless the room was dismissed. */
function endedLine(e: Ended, id: string): string {
  switch (e.kind) {
    case "dismissed":
      return "the room was dismissed";
    // The stream died, the room did not. Name the state the daemon reports
    // rather than the status of the GET that reported it, and say how to
    // get back in.
    case "alive":
      return (
        `! lost the room stream; the room is still ${e.status} — ` +
        `rejoin with: kapelle chat attach ${id}`
      );
    case "unknown":
      return `! the daemon no longer knows room ${id}; it may have restarted`;
    case "refused":
      return `! lost the room stream (HTTP ${e.status}); the room may still be alive`;
    case "gone":
      return `! lost the daemon: ${e.message}`;
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
  endedLine,
  green,
  italic,
  magenta,
  plain,
  rosterOf,
  sgr,
  underline,
  unpad,
  yellow,
};
