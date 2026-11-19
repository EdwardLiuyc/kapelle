/**
 * The words both chat screens use for a room whose stream ended, from
 * `chat/common.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { endedLine } from "../common.ts";

test("a deleted room is named plainly", () => {
  assert.equal(endedLine({ kind: "deleted" }, "r1"), "the room was deleted");
});

test("an unknown room does not guess that the daemon restarted", () => {
  assert.equal(
    endedLine({ kind: "unknown" }, "r1"),
    "! the daemon does not know room r1",
  );
});

test("a hall's end line names the chats, never the hall's id (M11-1)", () => {
  const lines = [
    endedLine({ kind: "alive", status: "active" }, "hall", true),
    endedLine({ kind: "unknown" }, "hall", true),
    endedLine({ kind: "refused", status: 500 }, "hall", true),
    endedLine({ kind: "gone", message: "fetch failed" }, "hall", true),
  ];
  for (const line of lines) assert.doesNotMatch(line, /attach hall|room hall/);
  assert.equal(
    lines[0],
    "! lost the chats' stream; they are still active — rejoin with: kapelle chat",
  );
  assert.match(lines[1] ?? "", /the daemon has no hall: .*the daemon's log/);
  assert.equal(
    lines[2],
    "! lost the chats' stream (HTTP 500); they may still be alive",
  );
});
