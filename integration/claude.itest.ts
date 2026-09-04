/**
 * claude-agent-acp — the harness with an environment quirk.
 *
 * `asksPermission: true`, so the policy filter has real reach. The first test
 * is M0-2's regression insurance: older adapters refused to start a nested
 * session when they saw the markers a parent Claude Code session leaves behind,
 * and the registry scrubs `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT` and
 * `CLAUDE_CODE_ENTRYPOINT` for that reason. 0.49.0 no longer refuses, so the
 * scrub is insurance — and insurance nobody exercises is not insurance.
 *
 * **`safe` never reaches a write here, and that is the finding.** Measured
 * 2026-09-04, three runs of three: claude obeys the negotiated plan mode and
 * asks to *leave* it (`switch_mode`) rather than asking to write. `safePolicy`
 * denies that, so the write is never requested. `safe` against this harness is
 * an interlock — negotiate plan, then refuse the way back out — and a test that
 * only checked for an empty directory would pass with the policy deleted.
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

test("safe refuses the escape from plan mode, which is what stops the write", {
  skip,
}, async (t) => {
  // An empty directory proves nothing on its own: the harness obeying its
  // negotiated plan mode leaves exactly the same directory as a refusal, so
  // this asserts the client's own `_client_permission` line first.
  //
  // Measured 2026-09-04, three runs out of three: the request that arrives is
  // **not** the write. claude asks to leave plan mode (`Ready to code?`, kind
  // `switch_mode`), `switch_mode` is not in READ_ONLY_KINDS, and `safePolicy`
  // denies it — so the write is never requested at all. `safe` against this
  // harness is an interlock: negotiate plan, then refuse the way back out.
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
  assert.match(r.stdout, /✗ refused/, "the policy must actually have fired");
  assert.match(r.stdout, /\[switch_mode\]/, "and on the mode switch, not a write");
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
