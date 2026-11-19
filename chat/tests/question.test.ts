/**
 * The question box's first line — `whereAsked` in `chat/tui/question.ts`.
 * A room's question names the room; a hall agent's names its chat, as the
 * screen hides the hall (M11-1).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { whereAsked } from "../tui/question.ts";

test("a room's question names the room, and a chat's names its agent (M11-1)", () => {
  assert.equal(
    whereAsked({ id: "room-1", title: "fix login" }, "ann", " · turn 2"),
    "room   fix login · turn 2",
  );
  assert.equal(whereAsked({ id: "room-1" }, "ann", ""), "room   room-1");
  assert.equal(
    whereAsked({ id: "hall", title: "hall", hall: true }, "ann", " · turn 2"),
    "chat   ann · turn 2",
  );
});
