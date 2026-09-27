/**
 * M1a-8 acceptance tests — issue #16.
 *
 * Two things are worth proving and neither is visible in the regex. First,
 * the ids the amendment removed (`plan..impl`, `impl.`, `build.lock`) are
 * rejected, because those are exactly the ones that used to pass validation
 * and then fail at branch creation. Second, a minted name really does survive
 * `git check-ref-format` — the story asks for the round-trip, not for a
 * second copy of git's rules written out in JavaScript.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  assertRunId,
  assertTaskId,
  branchName,
  newParticipantId,
  newRoomId,
  newRunId,
} from "../ids.ts";

test("newRunId is YYYYMMDD-HHMMSS-<4 char base36>, in UTC", () => {
  const id = newRunId(new Date("2026-09-03T12:34:56.789Z"));
  assert.match(id, /^20260903-123456-[0-9a-z]{4}$/);
});

test("run ids sort chronologically as plain strings", () => {
  const early = newRunId(new Date("2026-09-03T12:34:56Z"));
  const late = newRunId(new Date("2026-09-03T12:34:57Z"));
  assert.ok(early < late, `${early} should sort before ${late}`);
});

test("legal task ids pass through unchanged", () => {
  for (const id of [
    "plan",
    "impl2",
    "a",
    "build_step-3",
    "0",
    "z".repeat(64),
  ]) {
    assert.equal(assertTaskId(id), id);
  }
});

test("illegal task ids throw rather than being sanitised", () => {
  const bad = [
    "plan..impl", // refs may not contain '..'
    "impl.", // refs may not end in a dot
    "build.lock", // no ref component may end in '.lock'
    "-lead", // first character must be a letter or digit
    "_lead", // likewise
    "Plan", // uppercase: two refs on Linux, one on macOS
    "a b", // space
    "a/b", // would add a path component
    "", // empty
    "z".repeat(65), // one over the limit
  ];
  for (const id of bad) {
    assert.throws(
      () => assertTaskId(id),
      /invalid task id/,
      `${id} was accepted`,
    );
  }
});

test("branchName validates both halves it is given", () => {
  assert.throws(() => branchName(newRunId(), "build.lock"), /invalid task id/);
  assert.throws(
    () => branchName("not-a-run-id", "plan"),
    /invalid run or room id/,
  );
});

test("a room id is its own namespace: branchName takes it, assertRunId does not", () => {
  const roomId = newRoomId();
  assert.match(roomId, /^room-\d{8}-\d{6}-[0-9a-z]{4}$/);
  // The branch a participant's work lands on. `core/worktree.ts` serves runs
  // and rooms alike, so `branchName` has to take both.
  assert.equal(branchName(roomId, "room"), `kapelle/${roomId}/room`);
  // But nothing that takes a run id from the command line may accept one —
  // `kapelle merge <runId>` must not reach into a room's branches (S9).
  assert.throws(() => assertRunId(roomId), /invalid run id/);
});

test("a participant id is opaque, ref-safe, and a legal task id", () => {
  const id = newParticipantId();
  assert.match(id, /^p-[0-9a-z]{8}$/);
  // M6-6a names the participant's branch with it.
  const roomId = newRoomId();
  assert.equal(branchName(roomId, id), `kapelle/${roomId}/${id}`);
  assert.notEqual(newParticipantId(), newParticipantId());
});

test("minted branch names round-trip through git check-ref-format", () => {
  const branch = branchName(newRunId(), "build_step-3");
  // No skip-if-missing: git is a hard requirement of this project (worktrees,
  // merge), so a machine without it should fail here rather than report a
  // green run that verified nothing.
  const git = spawnSync("git", ["check-ref-format", `refs/heads/${branch}`]);
  assert.equal(git.error, undefined, `could not run git: ${git.error}`);
  assert.equal(git.status, 0, `git rejected ${branch}: ${git.stderr}`);
});
