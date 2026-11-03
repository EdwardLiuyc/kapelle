/**
 * Shared subprocess cleanup (#428): graceful exits flush V8 coverage, and a
 * stuck process still meets the bounded SIGKILL fallback.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  addRepo,
  alive,
  bootDaemon,
  daemonApi,
  gitRepo,
  gone,
  MOCK_AGENT,
  roomLog,
  spawnCli,
  tempDir,
  until,
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

test("spawnCli cleanup ends a room harness waiting for its test file", async (t) => {
  const runtime = await tempDir(t);
  let harness = 0;

  await t.test("the harness is waiting", async (t) => {
    const d = await bootDaemon(t, runtime);
    const cwd = await addRepo(d, await gitRepo(t));
    const open = await daemonApi<{ id: string; error?: { message: string } }>(
      d,
      "POST",
      "/rooms",
      {
        cwd,
        agents: [
          { cmd: `node ${MOCK_AGENT} --scenario runs`, role: "orchestrator" },
        ],
      },
    );
    assert.equal(open.status, 201, open.body.error?.message);
    const sent = await daemonApi<{ error?: { message: string } }>(
      d,
      "POST",
      `/rooms/${open.body.id}/messages`,
      { text: "go" },
    );
    assert.equal(sent.status, 202, sent.body.error?.message);

    await until("the runs harness to wait", async () => {
      const lines = await roomLog(cwd, open.body.id);
      const pid = lines.find(
        (line) => line.update.sessionUpdate === "_client_harness_spawned",
      )?.update.pid;
      if (typeof pid === "number") harness = pid;
      return lines.some((line) => {
        if (line.update.sessionUpdate !== "agent_message_chunk") return false;
        const content = line.update.content as { text?: unknown } | undefined;
        return (
          typeof content?.text === "string" && content.text.includes("Looking.")
        );
      });
    });
    assert.ok(harness > 0, "the runs harness pid is on the log");
  });

  assert.equal(await gone(harness), true, "the harness outlived its daemon");
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
