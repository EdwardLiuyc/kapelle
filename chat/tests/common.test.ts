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
