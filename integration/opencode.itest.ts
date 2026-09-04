/**
 * opencode — the harness that never asks.
 *
 * `asksPermission: false` in the registry, measured. The policy filter reaches
 * nothing here, so **the mode negotiation is the whole of `safe`** against this
 * harness (`modeMap.safe` is `plan`).
 *
 * **Nothing here asserts on a file appearing or not appearing**, and that is
 * the point rather than a weakness. Against claude and copilot a refusal is
 * ours: they send `session/request_permission`, `safePolicy` denies it, and the
 * write cannot happen. Against opencode nothing is denied, because nothing is
 * asked — plan mode is an instruction the model chooses to follow. Measured
 * 2026-09-04 while writing this suite: it usually declines, and **on one run it
 * wrote the file anyway**. So the disk is not ours to assert on. These tests
 * pin what the client controls: that the negotiation was sent and accepted, and
 * that the notice telling you all of the above is printed.
 *
 * **`--mode ask` cannot be tested from here**, and not for want of trying: a
 * test runner has no TTY, so `ask` re-resolves to `safe` before the first
 * notice is even composed. What that fallback does is covered in
 * `cli.test.ts`; the prompt itself stays a manual check.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { needs, runCli, spawnCli, tempDir, WRITE_PROMPT } from "./helpers.ts";

const skip = needs("opencode");

test("safe negotiates a mode, rather than skipping or failing", {
  skip,
}, async (t) => {
  // `negotiateSafeMode` is silent on success and prints on any skip or failure,
  // so an empty match is the whole assertion. A missing `measured` half prints
  // the skip sentence; a stale `modeMap.safe` makes opencode answer -32602 and
  // prints the `session/set_mode` failure sentence. Both must make this red.
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    WRITE_PROMPT,
    "--agent",
    "opencode",
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.equal(r.code, 0, "the turn should end cleanly, not error");
  assert.doesNotMatch(r.stderr, /safe mode was not negotiated/);
  assert.doesNotMatch(r.stderr, /session\/set_mode/);
});

test("the never-asks notice survives --quiet", { skip }, async (t) => {
  // #62 R1 kept the name `safe` and paid for it by making this line the only
  // carrier of the caveat, so #13 forbids silencing it. If this ever passes
  // with an empty stderr, the mode needs renaming.
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "say hi",
    "--agent",
    "opencode",
    "--mode",
    "safe",
    "--quiet",
    "--cwd",
    cwd,
  ]);

  assert.match(r.stderr, /never asks permission/);
  assert.equal(r.stdout, "", "--quiet still means quiet on stdout");
});

test("the never-asks notice is loudest in auto, where nothing bounds it", {
  skip,
}, async (t) => {
  // The other containment line stays silent in `auto` on purpose. This one must
  // not: a harness the policy cannot reach, running unattended, is the case
  // where silence is most expensive.
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "say hi",
    "--agent",
    "opencode",
    "--mode",
    "auto",
    "--cwd",
    cwd,
  ]);

  assert.match(r.stderr, /never asks permission/);
  assert.match(r.stderr, /--mode auto does not bound what it does/);
});

test("SIGINT cancels the turn, then gives up after the grace period", {
  skip,
}, async (t) => {
  // Cancellation is best-effort by design, so this asserts our side of it: the
  // notice, and the exit code. Whether the harness honours session/cancel is
  // its business — copilot answers end_turn for turns it cancelled.
  const cwd = await tempDir(t);
  const cli = spawnCli(t, [
    "write a very long essay about the history of git, at least 2000 words",
    "--agent",
    "opencode",
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  await cli.waitFor("session ");
  cli.child.kill("SIGINT");
  const r = await cli.done;

  assert.match(r.stderr, /cancelling turn/);
  assert.equal(r.code, 130, "128 + SIGINT, after the 2s grace");
});
