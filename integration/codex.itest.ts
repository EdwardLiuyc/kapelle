/**
 * codex-acp — the adapter whose start mode never asks.
 *
 * Measured 2026-10-21 on codex-acp 2.2.2 / codex-cli 0.163.0 (§Codex): in its
 * start mode `agent` a review model approves each call, and we are never asked.
 * `read-only` asks for every edit and command, so `safe` and `ask` both send
 * it. A stale id makes the mode negotiation fail, and the first test catches
 * that. These tests pin what the client controls, never the agent's prose.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { needs, runCli, tempDir, twoTurns } from "./helpers.ts";

const skip = needs("codex-acp");

test("safe negotiates a mode, rather than skipping or failing", {
  skip,
}, async (t) => {
  // Silent on success: a missing `modeMap` prints the skip sentence, and a
  // stale `modeMap.safe` prints the `session/set_mode` failure.
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "say hi and stop",
    "--agent",
    "codex",
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /safe mode was not negotiated/);
  assert.doesNotMatch(r.stderr, /session\/set_mode/);
  assert.doesNotMatch(r.stderr, /no measured labels/);
});

test("the containment notice names the shell", { skip }, async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "say hi",
    "--agent",
    "codex",
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
  const r = await twoTurns(t, "codex");
  assert.equal(r.first, "end_turn");
  assert.equal(r.second, "end_turn", "the follow-up turn completed");
  assert.equal(r.sessionAfter, r.sessionBefore, "no new session was opened");
  assert.equal(r.spawns, 1, "one harness served both turns");
});
