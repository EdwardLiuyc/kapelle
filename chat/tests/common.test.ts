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
    endedLine({ kind: "alive", status: "active" }, "hall", { hall: true }),
    endedLine({ kind: "unknown" }, "hall", { hall: true }),
    endedLine({ kind: "refused", status: 500 }, "hall", { hall: true }),
    endedLine({ kind: "gone", message: "fetch failed" }, "hall", {
      hall: true,
    }),
  ];
  for (const line of lines) assert.doesNotMatch(line, /attach hall|room hall/);
  assert.equal(
    lines[0],
    "! lost the chats' stream; they are still active — rejoin with: kapelle chat",
  );
  assert.equal(
    lines[1],
    "! the daemon has no hall; check the daemon's log for why",
  );
  assert.equal(
    lines[2],
    "! lost the chats' stream (HTTP 500); they may still be alive",
  );
});

test("a lost hall chat names how to attach that chat on a pipe", () => {
  assert.equal(
    endedLine({ kind: "alive", status: "active" }, "hall", {
      hall: true,
      pin: { name: "ann", removed: false },
    }),
    "! lost the chat's stream; ann is still active — rejoin with: kapelle chat attach @ann",
  );
  assert.equal(
    endedLine({ kind: "refused", status: 500 }, "hall", {
      hall: true,
      pin: { name: "ann", removed: false },
    }),
    "! lost the chat's stream (HTTP 500); ann may still be alive",
  );
  assert.equal(
    endedLine({ kind: "alive", status: "active" }, "hall", {
      hall: true,
      pin: { name: "ann", removed: true },
    }),
    "! the chat's agent is gone; /leave to exit",
  );
});

test("a removed hall chat keeps the stream end's own cause", () => {
  assert.equal(
    endedLine({ kind: "gone", message: "fetch failed" }, "hall", {
      hall: true,
      pin: { name: "ann", removed: true },
    }),
    "! lost the daemon: fetch failed",
  );
  assert.equal(
    endedLine({ kind: "unknown" }, "hall", {
      hall: true,
      pin: { name: "ann", removed: true },
    }),
    "! the daemon has no hall; check the daemon's log for why",
  );
  assert.equal(
    endedLine({ kind: "refused", status: 500 }, "hall", {
      hall: true,
      pin: { name: "ann", removed: true },
    }),
    "! the chat's agent is gone; /leave to exit",
  );
});
