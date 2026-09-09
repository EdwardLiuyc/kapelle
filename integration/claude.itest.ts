/**
 * claude-agent-acp — the harness with an environment quirk.
 *
 * `asksPermission: true`, so the policy filter has real reach. The first test
 * is M0-2's regression insurance: older adapters refused to start a nested
 * session when they saw the markers a parent Claude Code session leaves behind,
 * and the registry scrubs `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT` and
 * `CLAUDE_CODE_ENTRYPOINT` for that reason. **Re-checked on 0.75.1,
 * 2026-09-09** (#80): with all three markers set and the scrub bypassed, the
 * adapter still starts and completes a turn, so the scrub stays insurance
 * rather than a fix — and insurance nobody exercises is not insurance.
 *
 * **`safe` against claude is an interlock, not a sandbox.** Measured
 * 2026-09-04, three runs of three: claude usually obeys the negotiated plan
 * mode and asks to *leave* it (`switch_mode`) rather than asking to write.
 * `safePolicy` denies that. But plan mode is advisory: a harness can ignore the
 * refusal and write anyway, so the integration suite asserts the refusal line,
 * not an empty disk.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { needs, runCli, tempDir, WRITE_PROMPT } from "./helpers.ts";

const skip = needs("claude-agent-acp");

test("claude-agent-acp spawns and completes a handshake", {
  skip,
}, async (t) => {
  // This does **not** prove the env scrub: the scrub is deterministic and is
  // covered by `resolveEnv`'s unit tests in `protocol/tests/registry.test.ts`.
  // This integration test only proves the real adapter starts and completes
  // a handshake from the environment this suite runs in.
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

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /connected to/);
});

test("safe refuses the escape from plan mode", { skip }, async (t) => {
  // The client-controlled guarantee is the refusal line, not an empty
  // directory. Claude usually asks to leave plan mode (`switch_mode`), and
  // `safePolicy` denies it. But the harness can still write after that refusal
  // because plan mode is an instruction, not a sandbox — so asserting an empty
  // workspace would be asserting something the client does not control.
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

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /✗ refused/, "the policy must actually have fired");
  assert.match(
    r.stdout,
    /\[switch_mode\]/,
    "the refusal should be on the mode switch, not a write",
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
