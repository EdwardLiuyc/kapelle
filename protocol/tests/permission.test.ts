/** Pure permission-answer and option-selection tests. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { answerScope, pickOption } from "../permission.ts";
import type { PermissionOption } from "../types.ts";

function option(
  kind: PermissionOption["kind"],
  optionId: string = kind,
): PermissionOption {
  return { optionId, name: optionId, kind };
}

test("a policy answer is once only for true and session only for an explicit session yes", () => {
  assert.equal(answerScope(true), "once");
  assert.equal(answerScope(false), "deny");
  assert.equal(answerScope({ allow: true, scope: "session" }), "session");
});

test("denial prefers reject_once, falls back to reject_always, and never guesses", () => {
  const always = option("reject_always", "always");
  const once = option("reject_once", "once");
  assert.equal(pickOption([always, once], "deny"), "once");
  assert.equal(pickOption([always], "deny"), "always");
  assert.equal(pickOption([option("allow_always")], "deny"), null);
  assert.equal(pickOption([], "deny"), null);
});

test("a yes once takes allow_once only", () => {
  assert.equal(
    pickOption(
      [option("allow_always", "always"), option("allow_once", "once")],
      "once",
    ),
    "once",
  );
  assert.equal(pickOption([option("allow_always")], "once"), null);
  assert.equal(pickOption([], "once"), null);
});

test("a session yes prefers allow_once and falls back to allow_always", () => {
  assert.equal(
    pickOption(
      [option("allow_always", "always"), option("allow_once", "once")],
      "session",
    ),
    "once",
  );
  assert.equal(
    pickOption([option("allow_always", "always")], "session"),
    "always",
  );
  assert.equal(pickOption([option("reject_once")], "session"), null);
});
