/**
 * pi-acp — the adapter that exposes thinking levels where safety modes would go.
 *
 * Measured 2026-09-09 on pi-acp 0.0.33 / pi v0.85.1: pi never sends
 * `session/request_permission` — it wrote the requested file under `safe` — so
 * the policy has no jurisdiction over it in any mode. Its ACP `modes` are
 * thinking-effort levels (`off`…`xhigh`), not plan/build/bypass style modes, so
 * the measured registry entry deliberately has no `modeMap` and `safe` does not
 * pretend to negotiate a restrictive mode.
 *
 * **Nothing here asserts on a file appearing or not appearing.** Under `safe`
 * the file can appear because pi never asks permission and a thinking level is
 * not an instruction to stop writing. These tests pin what the client controls:
 * the never-asks notice, the no-safety-mode negotiation notice, and the fact
 * that `auto` is the mode where pi's autonomy is unbounded.
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { needs, runCli, tempDir, WRITE_PROMPT } from "./helpers.ts";

const skip = needs("pi-acp");

test("safe prints the never-asks and no-safety-mode notices", {
  skip,
}, async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    WRITE_PROMPT,
    "--agent",
    "pi",
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stderr,
    /never asks permission/,
    "the no-jurisdiction caveat must print even when the write succeeds",
  );
  assert.match(
    r.stderr,
    /safe mode was not negotiated/,
    "pi has no safety mode to negotiate; a thinking level would not bind it",
  );
  assert.doesNotMatch(
    r.stderr,
    /no measured labels/,
    "the measured half must not still warn as unverified",
  );
});

test("auto is the control: the same prompt writes", { skip }, async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    WRITE_PROMPT,
    "--agent",
    "pi",
    "--mode",
    "auto",
    "--cwd",
    cwd,
  ]);

  assert.equal(r.code, 0, r.stderr);
  const files = await readdir(cwd);
  assert.ok(
    files.includes("PROOF.md"),
    `auto must actually write PROOF.md; got ${files.join(", ")}`,
  );
});

test("the never-asks notice survives --quiet", { skip }, async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "say hi",
    "--agent",
    "pi",
    "--mode",
    "safe",
    "--quiet",
    "--cwd",
    cwd,
  ]);

  assert.match(r.stderr, /never asks permission/);
  assert.equal(r.stdout, "", "--quiet still means quiet on stdout");
});

test("the never-asks notice is loudest in auto", { skip }, async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "say hi",
    "--agent",
    "pi",
    "--mode",
    "auto",
    "--cwd",
    cwd,
  ]);

  assert.match(r.stderr, /never asks permission/);
  assert.match(r.stderr, /--mode auto does not bound what it does/);
});
