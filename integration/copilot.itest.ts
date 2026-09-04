/**
 * copilot — the harness whose behaviour moved between builds.
 *
 * `asksPermission: true`, and the mode ids are full canonical URLs: the bare
 * `#plan` fragment returns -32602 (M0-7). It also shells out to explore, so
 * `safe` refuses `ls`/`find` as `execute` and a task that has to look around
 * dies as a clean `end_turn` with no output — which is why the write test below
 * names the file rather than asking the harness to go find anything.
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { needs, runCli, tempDir, WRITE_PROMPT } from "./helpers.ts";

const skip = needs("copilot");

test("safe refuses the write", { skip }, async (t) => {
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

  assert.equal(r.code, 0);
  assert.deepEqual(
    await readdir(cwd),
    [],
    "safe must leave the workspace empty",
  );
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
