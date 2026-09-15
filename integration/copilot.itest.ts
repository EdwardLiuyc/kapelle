/**
 * copilot — the harness whose behaviour moved between builds.
 *
 * `asksPermission: true`, and the mode ids are full canonical URLs: the bare
 * `#plan` fragment returns -32602 (M0-7). It also shells out to explore, so
 * `safe` refuses `ls`/`find` as `execute` and a task that has to look around
 * dies as a clean `end_turn` with no output — which is why the write test below
 * names the file rather than asking the harness to go find anything.
 *
 * Measured 2026-09-04, copilot requested an `edit` under `safe` and the policy
 * refused it. Measured 2026-09-09 on 1.0.83, it stays in plan mode and ends the
 * turn without ever requesting the write. The test below therefore accepts both
 * outcomes: a refusal if one arrives, or an empty workspace when plan mode is
 * enough to stop the model.
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { needs, runCli, tempDir, twoTurns, WRITE_PROMPT } from "./helpers.ts";

const skip = needs("copilot");

test("safe leaves the workspace empty, by refusal or by plan-mode obedience", {
  skip,
}, async (t) => {
  // An empty directory alone cannot prove the policy fired: a harness obeying
  // its negotiated plan mode leaves the same directory. On 1.0.83 copilot does
  // exactly that, so this test accepts both client-controlled outcomes. If a
  // permission request does arrive, it must be an edit that `safePolicy`
  // refused; if none arrives, plan mode is what stopped the write.
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    WRITE_PROMPT,
    "--agent",
    "copilot",
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(
    r.stderr,
    /safe mode was not negotiated|session\/set_mode/,
    "safe mode negotiation should succeed",
  );
  assert.deepEqual(
    await readdir(cwd),
    [],
    "safe must leave the workspace empty",
  );
  if (/✗ refused/.test(r.stdout)) {
    assert.match(
      r.stdout,
      /\[edit\]/,
      "when a refusal happens it must be on the write, not something else",
    );
  }
});

test("auto is the control: the same prompt writes", { skip }, async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    WRITE_PROMPT,
    "--agent",
    "copilot",
    "--mode",
    "auto",
    "--cwd",
    cwd,
  ]);

  assert.equal(r.code, 0);
  assert.notDeepEqual(
    await readdir(cwd),
    [],
    "auto must actually write something",
  );
});

test("the containment notice names the shell", { skip }, async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "say hi",
    "--agent",
    "copilot",
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.match(r.stderr, /runs its own commands \(shell: internal\)/);
});

test("a second prompt after end_turn runs on the same session", {
  skip,
}, async (t) => {
  const r = await twoTurns(t, "copilot");
  assert.equal(r.first, "end_turn");
  assert.equal(r.second, "end_turn", "the follow-up turn completed");
  assert.equal(r.sessionAfter, r.sessionBefore, "no new session was opened");
  assert.equal(r.spawns, 1, "one harness served both turns");
});
