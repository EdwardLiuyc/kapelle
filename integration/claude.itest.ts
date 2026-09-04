/**
 * claude-agent-acp — the harness with an environment quirk.
 *
 * `asksPermission: true`, so the policy filter has real reach. The first test
 * is M0-2's regression insurance: older adapters refused to start a nested
 * session when they saw the markers a parent Claude Code session leaves behind,
 * and the registry scrubs `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT` and
 * `CLAUDE_CODE_ENTRYPOINT` for that reason. 0.49.0 no longer refuses, so the
 * scrub is insurance — and insurance nobody exercises is not insurance.
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { needs, runCli, tempDir, WRITE_PROMPT } from "./helpers.ts";

const skip = needs("claude-agent-acp");

test("starts from inside a Claude Code session, with no env -u prefix", {
  skip,
}, async (t) => {
  // Meaningful only when this suite is itself run from a Claude Code session,
  // which is where the markers exist. Harmless and still green elsewhere.
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "say hi and stop",
    "--agent",
    "claude",
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.equal(r.code, 0, "a spawn refusal surfaces as an opaque -32603 here");
  assert.match(r.stdout, /connected to/);
});

test("safe refuses the write", { skip }, async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    WRITE_PROMPT,
    "--agent",
    "claude",
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.equal(r.code, 0);
  assert.deepEqual(
    await readdir(cwd),
    [],
    "safe must leave the workspace empty",
  );
});

test("the containment notice names the shell", { skip }, async (t) => {
  // It runs its own commands, so the policy sees only what crosses the
  // protocol. The notice has to keep saying so.
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "say hi",
    "--agent",
    "claude",
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.match(r.stderr, /runs its own commands \(shell: internal\)/);
});
