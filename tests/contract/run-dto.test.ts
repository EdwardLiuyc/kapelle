/**
 * The run DTO — story M5-2, issue #134.
 *
 * One shape for a live run and a run restored from its `run.json` (C2(c)):
 * `source` says which one it is, a field the record cannot fill is omitted,
 * never `null`, and no key outside `client/contract.ts` reaches the wire. The
 * daemon is a real subprocess reached over HTTP; the types are the ones a
 * client imports.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RunDto, RunListEntry, TaskDto } from "../../client/contract.ts";
import { stateDirFor } from "../../core/runtime.ts";
import {
  gitRepo,
  MOCK_AGENT,
  spawnCli,
  tempDir,
} from "../../integration/helpers.ts";

interface Daemon {
  url: string;
  token: string;
  pid: number;
  done: ReturnType<typeof spawnCli>["done"];
}

async function boot(
  t: TestContext,
  runtime: string,
  state: string,
): Promise<Daemon> {
  const d = spawnCli(t, ["--port", "0"], "daemon.ts", {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(state, "config-home"),
  });
  await d.waitFor("listening on ");
  const { port, token, pid } = JSON.parse(
    await readFile(join(runtime, "kapelle", "daemon.json"), "utf8"),
  );
  return { url: `http://127.0.0.1:${port}`, token, pid, done: d.done };
}

async function api<T>(
  d: Daemon,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(d.url + path, {
    method,
    headers: {
      authorization: `Bearer ${d.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** Every key `RunDto` declares; a reply may not carry any other. */
const RUN_KEYS = new Set([
  "id",
  "cwd",
  "root",
  "status",
  "source",
  "startedAt",
  "endedAt",
  "durationMs",
  "turns",
  "error",
  "cancelRequested",
  "notices",
  "tasks",
]);

/** Every key `TaskDto` declares. */
const TASK_KEYS = new Set([
  "id",
  "status",
  "agent",
  "durationMs",
  "error",
  "usage",
  "usageSemantics",
  "warnings",
  "summary",
  "summarySynthesised",
  "branch",
  "baseSha",
  "sessionId",
]);

function assertNoNull(value: unknown, path = "reply"): void {
  if (value === null) assert.fail(`${path} is null`);
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertNoNull(entry, `${path}[${index}]`);
    }
  } else if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertNoNull(entry, `${path}.${key}`);
    }
  }
}

test("a live run and its boot-restored reply carry the same DTO shape", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const repo = await gitRepo(t);

  const first = await boot(t, runtime, state);
  const added = await api<{ root: string }>(first, "POST", "/repos", {
    path: repo,
  });
  assert.equal(added.status, 200);
  const root = added.body.root;

  const posted = await api<{ id: string }>(first, "POST", "/runs", {
    cwd: root,
    run: {
      cmd: `node ${MOCK_AGENT}`,
      mode: "auto",
      tasks: [{ id: "one", prompt: "hi" }],
    },
  });
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const id = posted.body.id;

  let live: RunDto | undefined;
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const poll = await api<RunDto>(first, "GET", `/runs/${id}`);
    assert.equal(poll.status, 200);
    if (poll.body.status !== "running") {
      live = poll.body;
      break;
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.ok(live, "the run never settled");

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await boot(t, runtime, state);
  const restoredRes = await api<RunDto>(second, "GET", `/runs/${id}`);
  assert.equal(restoredRes.status, 200);
  const restored = restoredRes.body;

  // Every key on either reply is one the contract declares, and no gap is a
  // `null` (C2(c)).
  for (const [label, dto] of [
    ["live", live],
    ["restored", restored],
  ] as const) {
    for (const key of Object.keys(dto)) {
      assert.ok(RUN_KEYS.has(key), `${label} carries unknown run key ${key}`);
    }
    for (const task of dto.tasks) {
      for (const key of Object.keys(task)) {
        assert.ok(
          TASK_KEYS.has(key),
          `${label} task carries unknown key ${key}`,
        );
      }
    }
    assertNoNull(dto, label);
  }

  // The core fields are on both, and `source` names where each came from.
  for (const key of ["id", "cwd", "root", "status", "notices", "tasks"]) {
    assert.ok(key in live, `live reply is missing ${key}`);
    assert.ok(key in restored, `restored reply is missing ${key}`);
  }
  assert.equal(live.source, "live");
  assert.equal(restored.source, "restored");
  assert.equal(restored.id, live.id);
  assert.equal(restored.cwd, live.cwd);
  assert.equal(restored.root, live.root);
  assert.equal(restored.status, live.status);

  // Times ride the record both ways (C5).
  assert.equal(typeof live.startedAt, "string");
  assert.equal(typeof live.endedAt, "string");
  assert.equal(typeof restored.startedAt, "string");
  assert.equal(typeof restored.endedAt, "string");

  // The extended record fills the card fields, so the restart loses none.
  const filled = (task: TaskDto) => ({
    id: task.id,
    status: task.status,
    agent: task.agent,
    durationMs: task.durationMs,
    sessionId: task.sessionId,
    warnings: task.warnings,
  });
  assert.deepEqual(restored.tasks.map(filled), live.tasks.map(filled));

  // The run-level report fields are live-only: no record, so omitted.
  assert.equal(typeof live.durationMs, "number");
  assert.equal(typeof live.turns, "number");
  assert.equal(restored.durationMs, undefined);
  assert.equal(restored.turns, undefined);

  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});

test("a record written before M5-2 serves with the new fields omitted", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const repo = await gitRepo(t);
  // Relative to now: the boot sweep's 30-day retention (core/sweep.ts) would
  // otherwise reap a fixed date out from under this test.
  const endedAt = new Date(Date.now() - 60_000).toISOString();
  const startedAt = new Date(Date.now() - 120_000).toISOString();

  // One daemon long enough to register the repository; its repos.json is what
  // the second boot reads.
  const first = await boot(t, runtime, state);
  const added = await api<{ root: string }>(first, "POST", "/repos", {
    path: repo,
  });
  assert.equal(added.status, 200);
  const root = added.body.root;
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // The five fields M2-6 wrote, and no `agent`/`durationMs`/`warnings`.
  process.env.XDG_STATE_HOME = state;
  const dir = join(stateDirFor(root), "runs", "old");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: "old",
      root,
      cwd: root,
      status: "done",
      startedAt,
      endedAt,
      tasks: [
        {
          id: "a",
          status: "done",
          branch: "kapelle/old/a",
          sessionId: "sess_old",
        },
      ],
    }),
  );

  const second = await boot(t, runtime, state);
  const got = await api<RunDto>(second, "GET", "/runs/old");
  assert.equal(got.status, 200);
  assert.equal(got.body.source, "restored");
  assert.equal(got.body.startedAt, startedAt);
  assert.equal(got.body.endedAt, endedAt);
  assert.deepEqual(got.body.tasks, [
    { id: "a", status: "done", branch: "kapelle/old/a", sessionId: "sess_old" },
  ]);
  assertNoNull(got.body, "old record");

  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});

test("a hand-edited record cannot put a null or a junk time on the wire", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const repo = await gitRepo(t);
  // Relative to now for the same retention reason as the old-record test.
  const endedAt = new Date(Date.now() - 60_000).toISOString();

  // One daemon long enough to register the repository; its repos.json is what
  // the second boot reads.
  const first = await boot(t, runtime, state);
  const added = await api<{ root: string }>(first, "POST", "/repos", {
    path: repo,
  });
  assert.equal(added.status, 200);
  const root = added.body.root;
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  process.env.XDG_STATE_HOME = state;
  const dir = join(stateDirFor(root), "runs", "raw");
  await mkdir(dir, { recursive: true });
  // Raw text, not `JSON.stringify`: `1e999` must reach `JSON.parse` as
  // `Infinity`, which `JSON.stringify` would already have written as `null`.
  await writeFile(
    join(dir, "run.json"),
    `{"runId":"raw","root":${JSON.stringify(root)},` +
      `"cwd":${JSON.stringify(root)},"status":"done",` +
      `"startedAt":"yesterday","endedAt":${JSON.stringify(endedAt)},` +
      `"tasks":[{"id":"a","status":"done","durationMs":1e999}]}`,
  );

  const second = await boot(t, runtime, state);
  const got = await api<RunDto>(second, "GET", "/runs/raw");
  assert.equal(got.status, 200);
  // C5: a junk timestamp is omitted, a valid one still serves.
  assert.equal(got.body.startedAt, undefined);
  assert.equal(got.body.endedAt, endedAt);
  // C2: a non-finite `durationMs` is omitted, never serialised as null.
  const task = got.body.tasks[0];
  assert.ok(task, "the task is served");
  assert.equal(task.id, "a");
  assert.equal("durationMs" in task, false);
  assert.equal(task.durationMs, undefined);
  assertNoNull(got.body, "raw record");

  // The list route sanitises the same record.
  const listed = await api<RunListEntry[]>(second, "GET", "/runs");
  const row = listed.body.find((entry) => entry.id === "raw");
  assert.ok(row, "the hand-edited run is listed");
  assert.equal(row.startedAt, undefined);
  assert.equal(row.endedAt, endedAt);

  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});
