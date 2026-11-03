/**
 * Shared subprocess cleanup (#428): graceful exits flush V8 coverage, and a
 * stuck process still meets the bounded SIGKILL fallback.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  alive,
  bootDaemon,
  gone,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";

test("spawnCli cleanup stops a daemon gracefully", async (t) => {
  const runtime = await tempDir(t);
  let d: Awaited<ReturnType<typeof bootDaemon>> | undefined;
  await t.test("the daemon is running", async (t) => {
    d = await bootDaemon(t, runtime);
    assert.equal(alive(d.pid), true);
  });

  assert.ok(d);
  const exit = await d.done;
  assert.equal(exit.code, 0);
  assert.match(exit.stdout, /SIGTERM: cancelling/);
  assert.equal(await gone(d.pid), true);
  await assert.rejects(
    readFile(d.file),
    "graceful shutdown removes the record",
  );
});

test("spawnCli cleanup SIGKILLs a child that ignores SIGTERM", async (t) => {
  const dir = await tempDir(t);
  const script = join(dir, "ignore-term.mjs");
  await writeFile(
    script,
    'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);\n',
  );
  let spawned: ReturnType<typeof spawnCli> | undefined;
  await t.test("the child is running", async (t) => {
    spawned = spawnCli(t, [], script);
    await spawned.waitFor("ready");
  });

  assert.ok(spawned);
  assert.equal((await spawned.done).code, null);
  assert.equal(spawned.child.signalCode, "SIGKILL");
  assert.ok(spawned.child.pid);
  assert.equal(alive(spawned.child.pid), false);
});
