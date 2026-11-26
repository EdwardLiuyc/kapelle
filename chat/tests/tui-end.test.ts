/**
 * How the full-screen chat ends when every room's stream is gone —
 * `lostRoomEnd` in `chat/tui.ts`, M11-1.
 *
 * A refused client version is the reason even when the hidden hall is the
 * last room. With no daemon, the hall gets the local start command, or the
 * tunnel check for a configured remote client.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type DaemonAddress, VersionRefused } from "../../client/daemon.ts";
import { lostRoomEnd } from "../tui.ts";

const LOCAL: DaemonAddress = { port: 4719, token: "tok", fromClient: false };
const REMOTE: DaemonAddress = { ...LOCAL, fromClient: true };
const LOCAL_STOPPED =
  "! the daemon stopped: start it with kapelle daemon start, then run kapelle chat";
const REMOTE_STOPPED =
  "! the daemon stopped: check the SSH tunnel on local port 4719 or the remote daemon, then run kapelle chat";
const gone = { kind: "gone", message: "no daemon" } as const;

test("a refused version keeps its words when the hall ends last (M11-1)", () => {
  const err = new VersionRefused(
    "the daemon speaks API 2.0 and this client 1.25",
  );
  assert.deepEqual(lostRoomEnd("hall", gone, err, true, LOCAL), {
    code: 1,
    lines: [`! ${err.message}`],
  });
});

test("a hidden hall with no daemon names the command that starts one (M11-1)", () => {
  assert.deepEqual(lostRoomEnd("hall", gone, undefined, true, LOCAL), {
    code: 1,
    lines: [LOCAL_STOPPED],
  });
});

test("a remote client is sent to its SSH tunnel, not a local daemon (#567)", () => {
  const result = lostRoomEnd("hall", gone, undefined, true, REMOTE);
  assert.deepEqual(result, { code: 1, lines: [REMOTE_STOPPED] });
  const line = result.lines.join("\n");
  assert.match(line, /local port 4719/);
  assert.doesNotMatch(line, /kapelle daemon start/);
});

test("a hidden hall whose stream ends with the daemon up names no hall id (M11-1)", () => {
  const alive = { kind: "alive", status: "active" } as const;
  assert.deepEqual(lostRoomEnd("hall", alive, undefined, true, LOCAL), {
    code: 1,
    lines: [
      "! lost the chats' stream; they are still active — rejoin with: kapelle chat",
    ],
  });
});
