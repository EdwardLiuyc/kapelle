/**
 * Runs over the daemon's HTTP API: `POST /runs` and its key, `DELETE`, the
 * event stream (M2-2), the permission queue (M2-3, M5-4), and a run across a
 * restart and the boot sweep (M2-5, M2-6). A real `daemon.ts` and
 * `mock-agent.mjs`; no harness.
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` **and `XDG_STATE_HOME`**, so no
 * test ever meets another test's `daemon.json` or `repos.json` — or the
 * developer's real ones — even while the other files run at the same time.
 * The helpers more than one of these files needs live in
 * `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { join, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { stateDirFor } from "../core/runtime.ts";
import { processIdentity } from "../core/sweep.ts";
import { openWorktrees } from "../core/worktree.ts";
import {
  addRepo as added,
  alive,
  api,
  askRun,
  bootDaemon as boot,
  type Daemon,
  useDaemonDirs as dirs,
  exitOf,
  gitRepo,
  gone,
  hasBranch,
  MOCK_AGENT,
  mockRun,
  type Pending,
  pendingOne,
  type Reply,
  settled,
  spawnCli,
  startDaemon as start,
  tempDir,
  until,
} from "../integration/helpers.ts";

/** A finished run written straight to disk with a real checkout and branch:
 *  the shape M2-5's boot sweep reaps, without going through `POST /runs`. */
async function directFinishedRun(
  root: string,
  id: string,
  endedAt: string,
): Promise<{ dir: string; worktree: string; branch: string }> {
  const { worktrees } = await openWorktrees(root, id);
  assert.ok(worktrees, "the fixture repository should carry worktrees");
  const worktree = await worktrees.acquire("a");
  const branch = `kapelle/${id}/a`;
  const dir = join(stateDirFor(root), "runs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: id,
      root,
      cwd: root,
      status: "failed",
      startedAt: endedAt,
      endedAt,
      tasks: [{ id: "a", status: "failed", branch }],
    }),
  );
  await writeFile(join(dir, "events.jsonl"), "{}\n");
  return { dir, worktree, branch };
}

// --- POST /runs and GET ---------------------------------------------------------

test("POST /runs accepts a run, lists it with its folder, and reports it done", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));

  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202);

  const listed = await api<{ id: string; cwd: string }[]>(d, "GET", "/runs");
  assert.deepEqual(
    listed.body.map((r) => [r.id, r.cwd]),
    [[posted.body.id, await realpath(cwd)]],
  );

  const run = await settled(d, posted.body.id);
  assert.equal(run.status, "done");
  assert.equal(run.tasks[0]?.status, "done");
});

test("an invalid body is 400 in the validator's words, and creates no run", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));

  const noRun = await api(d, "POST", "/runs", { cwd });
  assert.equal(noRun.status, 400);

  const empty = await api(d, "POST", "/runs", { cwd, run: { tasks: [] } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, "invalid_run");
  assert.match(empty.body.error.message, /non-empty "tasks" array/);

  const garbled = await fetch(`${d.url}/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.token}`,
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(garbled.status, 400);
  assert.equal(((await garbled.json()) as Reply).error.code, "invalid_request");

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

// --- Idempotency-Key on POST /runs (M5-7, #139) ---------------------------------

/** `POST /runs` with an `Idempotency-Key`. */
async function postKeyed(
  d: Daemon,
  key: string,
  body: unknown,
  type = "application/json",
) {
  const res = await fetch(`${d.url}/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.token}`,
      "content-type": type,
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Reply };
}

test("one key and one body start one run; a different body is a conflict", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const body = { cwd, run: mockRun([{ id: "one", prompt: "hi" }]) };

  const first = await postKeyed(d, "key-1", body);
  assert.equal(first.status, 202);
  const again = await postKeyed(d, "key-1", body);
  assert.deepEqual(again, first);
  // The same fields in another order, at every depth, are the same body.
  const reordered = {
    run: {
      tasks: [{ prompt: "hi", id: "one" }],
      mode: "auto",
      cmd: body.run.cmd,
    },
    cwd,
  };
  assert.deepEqual(await postKeyed(d, "key-1", reordered), first);

  const other = { cwd, run: mockRun([{ id: "two", prompt: "hi" }]) };
  const conflict = await postKeyed(d, "key-1", other);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "idempotency_conflict");
  // A conflict leaves the key bound to its first run.
  assert.deepEqual(await postKeyed(d, "key-1", body), first);

  // The order of items in a list does matter: swapped tasks are another body.
  const two = [
    { id: "a", prompt: "hi" },
    { id: "b", prompt: "hi" },
  ];
  const pair = await postKeyed(d, "key-list", { cwd, run: mockRun(two) });
  assert.equal(pair.status, 202);
  const swapped = await postKeyed(d, "key-list", {
    cwd,
    run: mockRun(two.toReversed()),
  });
  assert.equal(swapped.status, 409);
  assert.equal(swapped.body.error.code, "idempotency_conflict");

  // No key: a second run, as before.
  assert.equal((await api(d, "POST", "/runs", body)).status, 202);
  const listed = await api<Reply[]>(d, "GET", "/runs");
  assert.equal(listed.body.length, 3);
  await settled(d, first.body.id);
  await settled(d, pair.body.id);
});

test("a refused request frees its key; a malformed key is 400", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));

  const refused = await postKeyed(d, "key-2", { cwd, run: { tasks: [] } });
  assert.equal(refused.body.error.code, "invalid_run");
  const fixed = await postKeyed(d, "key-2", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(fixed.status, 202);

  // "a, b" is what Node makes of a header sent twice; fetch cannot send one.
  for (const bad of ["has space", "x".repeat(256), "a, b"]) {
    const r = await postKeyed(d, bad, { cwd, run: mockRun([]) });
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error.code, "invalid_request");
  }
  await settled(d, fixed.body.id);
});

test("a retry while the first request has not answered is 409 in progress", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const body = JSON.stringify({
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  // The first request sends half its body and waits, so it holds the key.
  const { port } = new URL(d.url);
  let answer: (r: { status: number; body: string }) => void = () => {};
  const firstDone = new Promise<{ status: number; body: string }>((ok) => {
    answer = ok;
  });
  const first = request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/runs",
      headers: {
        authorization: `Bearer ${d.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "idempotency-key": "key-3",
      },
    },
    (res) => {
      let text = "";
      res.on("data", (c) => {
        text += c;
      });
      res.on("end", () => answer({ status: res.statusCode ?? 0, body: text }));
    },
  );
  first.write(body.slice(0, 10));
  await new Promise((ok) => first.once("socket", (s) => s.once("connect", ok)));

  // Poll until the daemon holds the first request's key. The poll is sent as
  // text/plain: a poll that arrives first is refused 415 before its body is
  // read, so it frees the key in the same turn of the event loop, and the
  // first request can never find it taken.
  let busy: Awaited<ReturnType<typeof postKeyed>> | undefined;
  for (const until = Date.now() + 5_000; Date.now() < until; ) {
    busy = await postKeyed(d, "key-3", {}, "text/plain");
    if (busy.status === 409) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(busy?.status, 409);
  assert.equal(busy?.body.error.code, "idempotency_in_progress");

  first.end(body.slice(10));
  const done = await firstDone;
  assert.equal(done.status, 202);
  const { id } = JSON.parse(done.body) as { id: string };
  assert.deepEqual(await postKeyed(d, "key-3", JSON.parse(body)), {
    status: 202,
    body: { id },
  });
  assert.equal((await api<Reply[]>(d, "GET", "/runs")).body.length, 1);
  await settled(d, id);
});

test("a dirty tree runs, and says so on the record (#129)", async (t) => {
  // It used to be a 409. The operator working alongside their own agents is
  // the normal case, and the daemon has no terminal to print a notice on, so
  // the advisory goes on the run record instead.
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  await writeFile(join(cwd, "wip.txt"), "uncommitted\n");

  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  assert.equal(posted.status, 202, posted.body.error?.message);
  const done = await settled(d, posted.body.id);
  assert.match(done.status, /^(done|warned)$/);
  assert.ok(
    (done.notices as { text: string }[]).some((n) =>
      /1 uncommitted file .* will not reach any task/.test(n.text),
    ),
    `no dirty-tree advisory in ${JSON.stringify(done.notices)}`,
  );
  // And the operator's own work is still there, untouched.
  assert.equal(await readFile(join(cwd, "wip.txt"), "utf8"), "uncommitted\n");
});

test("a subdirectory cwd runs inside its registered root, and the daemon writes nothing into the repo", async (t) => {
  // No ignore rule at all, so a file the daemon wrongly left in `pkg/` has
  // nowhere to hide (#129).
  const root = await gitRepo(t, {
    files: { "pkg/file.txt": "committed\n" },
  });
  const d = await boot(t);
  const cwd = await added(d, join(root, "pkg"));

  const status = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--ignored"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(status.stdout, "");

  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  // A worktree runs the result cross-check, and mock-agent reports
  // `ACP_TEST.md` from inside `pkg/`, so the run may promote to `warned`.
  // What this test owns is that nothing the daemon wrote failed it.
  assert.match((await settled(d, posted.body.id)).status, /^(done|warned)$/);

  // The pre-run status above cannot see what the run wrote. Since #129 the
  // daemon writes nothing here at all, so a clean status is the whole claim.
  const after = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(after.stdout, "");
});

test("a subdirectory run logs the workspace path it actually ran in", async (t) => {
  // M2-2's `_client_worktree_created.path` is the task's workspace, not the
  // checkout root: `Worktrees.info` must not leak its `Held.path` into the
  // event. `--cwd <root>/pkg` is the case where the two differ, and where the
  // silent spread used to overwrite `path: cwd`.
  const root = await gitRepo(t, {
    files: { "pkg/file.txt": "committed\n" },
  });
  const d = await boot(t);
  const cwd = await added(d, join(root, "pkg"));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const id = posted.body.id as string;
  assert.match((await settled(d, id)).status, /^(done|warned)$/);

  const events = (
    await readFile(join(stateDirFor(root), "runs", id, "events.jsonl"), "utf8")
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const created = events.find(
    (e) => e.update.sessionUpdate === "_client_worktree_created",
  );
  assert.ok(created, "the worktree event landed in the log");
  assert.ok(
    created.update.path.endsWith(`${sep}one${sep}pkg`),
    `path is the workspace inside the checkout, got ${created.update.path}`,
  );
  assert.ok(
    created.update.path.includes(`${sep}wt${sep}`),
    `path is inside the run's worktree, got ${created.update.path}`,
  );
  assert.equal(
    created.update.branch,
    `kapelle/${id}/one`,
    "the branch names the run and the task",
  );
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  assert.equal(created.update.baseSha, head, "the base sha is the clone point");
  const kinds = events.map((e) => e.update.sessionUpdate);
  const started = kinds.indexOf("_client_task_started");
  const worktree = kinds.indexOf("_client_worktree_created");
  const finished = kinds.indexOf("_client_task_finished");
  assert.ok(
    started !== -1 &&
      worktree !== -1 &&
      finished !== -1 &&
      started < worktree &&
      worktree < finished,
    `task boundaries are ordered started < worktree < finished: ${kinds.join(", ")}`,
  );
});

// --- DELETE /runs/:id, and what the record carries ------------------------------

test("DELETE cancels a live run, and refuses a settled or unknown one", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([
      { id: "stuck", prompt: "hi", cmd: `node ${MOCK_AGENT} --scenario stall` },
    ]),
  });
  const { id } = posted.body;

  // Cancel is cooperative, so the answer is an acknowledgement, not a verdict.
  const cancel = await api(d, "DELETE", `/runs/${id}`);
  assert.equal(cancel.status, 202);
  assert.equal(cancel.body.status, "running");
  assert.equal(cancel.body.cancelRequested, true);

  assert.equal((await settled(d, id)).status, "cancelled");
  const again = await api(d, "DELETE", `/runs/${id}`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "run_ended");
  const gone = await api(d, "DELETE", "/runs/nope");
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, "run_not_found");
  assert.equal((await api(d, "GET", "/runs/nope")).status, 404);
});

test("GET /runs and kapelle ps list a live run's tasks, then its verdict", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun(
      [
        {
          id: "stuck",
          prompt: "hi",
          cmd: `node ${MOCK_AGENT} --scenario stall`,
        },
        { id: "waiting", prompt: "hi" },
      ],
      { maxConcurrency: 1 },
    ),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;
  type Listed = { id: string; status: string; tasks: Reply["tasks"] }[];
  const tasksOf = async () =>
    (await api<Listed>(d, "GET", "/runs")).body.find((r) => r.id === id)?.tasks;

  // `runRun` hands over the queued list before the 202 is sent, so the first
  // listing already names both tasks. The ordering itself is pinned in
  // core/tests/run.test.ts; over HTTP the first persist usually wins anyway.
  assert.deepEqual(
    (await tasksOf())?.map((task) => task.id),
    ["stuck", "waiting"],
  );

  // Live: one task running, the other still queued behind it.
  const live = [
    { id: "stuck", status: "running" },
    { id: "waiting", status: "queued" },
  ];
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    if (JSON.stringify(await tasksOf()) === JSON.stringify(live)) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.deepEqual(await tasksOf(), live);

  const env = { XDG_RUNTIME_DIR: join(d.file, "..", "..") };
  const ps = await spawnCli(t, ["ps"], "cli.ts", env).done;
  assert.equal(ps.code, 0, ps.stderr);
  assert.match(ps.stdout, new RegExp(`^${id}  running  `, "m"));
  assert.match(ps.stdout, /^ {2}stuck {2}running$/m);
  assert.match(ps.stdout, /^ {2}waiting {2}queued$/m);

  // Finished: the run's status is its verdict, and every task has one.
  await api(d, "DELETE", `/runs/${id}`);
  assert.equal((await settled(d, id)).status, "cancelled");
  const after = await spawnCli(t, ["ps"], "cli.ts", env).done;
  assert.equal(after.code, 0, after.stderr);
  assert.match(after.stdout, new RegExp(`^${id}  cancelled  `, "m"));
  assert.match(after.stdout, /^ {2}stuck {2}cancelled$/m);
  assert.match(after.stdout, /^ {2}waiting {2}cancelled$/m);
});

test("kapelle ps with no daemon exits 1 and says so", async (t) => {
  const r = await spawnCli(t, ["ps"], "cli.ts", dirs(await tempDir(t))).done;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no daemon is listening/);
});

test("containment notices reach the run record, where nothing drops them", async (t) => {
  // #13: these lines are never suppressed. A daemon has no terminal, so the
  // record is the only place a caller can still read them.
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }], { mode: "safe" }),
  });

  const { notices } = await settled(d, posted.body.id);
  const find = (re: RegExp) => notices.find((n) => re.test(n.text));
  assert.equal(find(/safe mode was not negotiated/)?.taskId, "one");
  assert.equal(find(/is not a git repository/)?.taskId, "run");
});

// --- GET /runs/:id/events, M2-2 -------------------------------------------------

interface Stream {
  status: number;
  frames: {
    id: number;
    data: {
      seq: number;
      agent: string;
      update: { sessionUpdate: string; status?: string };
    };
  }[];
  /** Resolves when the daemon ends the stream. */
  ended: Promise<void>;
}

/** Opens the SSE stream and parses frames as they arrive. */
async function stream(
  d: Daemon,
  id: string,
  lastEventId?: number | string,
): Promise<Stream> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${d.token}`,
  };
  if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
  const res = await fetch(`${d.url}/runs/${id}/events`, { headers });
  const out: Stream = {
    status: res.status,
    frames: [],
    ended: Promise.resolve(),
  };
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    return out;
  }
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const body = res.body.pipeThrough(new TextDecoderStream());
  out.ended = (async () => {
    let buffer = "";
    for await (const text of body) {
      buffer += text;
      for (
        let end = buffer.indexOf("\n\n");
        end !== -1;
        end = buffer.indexOf("\n\n")
      ) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const id = /^id: (\d+)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        // A `: ping` block (M5-6) has no data and is no event.
        if (data === undefined) continue;
        out.frames.push({ id: Number(id), data: JSON.parse(data) });
      }
    }
  })();
  return out;
}

test("a stream attached mid-run gets the history then the live tail, contiguously, as the log file has it", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun(
      [
        { id: "one", prompt: "hi" },
        {
          id: "stuck",
          prompt: "hi",
          cmd: `node ${MOCK_AGENT} --scenario stall`,
        },
      ],
      { maxConcurrency: 1 },
    ),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;

  const first = await stream(d, id);
  assert.equal(first.status, 200);
  const has = (s: Stream, agent: string, kind: string) =>
    s.frames.some(
      (f) => f.data.agent === agent && f.data.update.sessionUpdate === kind,
    );
  // Mid-run for certain: `one` is over and `stuck` never answers its prompt.
  // Wait for the spawn, not the start: `_client_task_started` comes before the
  // harness is spawned, and a spawn line that lands after the tail cursor was
  // read reaches the caught-up stream below as a live event (CI, #172).
  await until(
    "the second task's harness to spawn",
    () =>
      has(first, "one", "_client_task_finished") &&
      has(first, "stuck", "_client_harness_spawned"),
  );
  const finished = first.frames.find(
    (f) =>
      f.data.agent === "one" &&
      f.data.update.sessionUpdate === "_client_task_finished",
  );
  assert.ok(finished, "the first task's verdict is logged");
  assert.ok(
    finished.data.update.status === "done" ||
      finished.data.update.status === "warned",
    `a non-cancelled task finished with ${String(finished.data.update.status)}`,
  );

  // A reconnect whose cursor is already the tail has no history to write, so
  // the 200 has to flush on its own. Without `flushHeaders` this fetch would
  // never resolve until the next event — and `stuck` never sends one. The
  // cursor is the last seq the first stream received, never the log file's
  // line count: bytes can be on disk before the write callback advances
  // `committed`, and a cursor past `log.size` is a 400.
  const tailStream = stream(d, id, first.frames.at(-1)?.id ?? 0);
  // If the timeout below wins, this still settles later; nothing may reject
  // unhandled just because the assertion already failed.
  void tailStream.then((s) => void s.ended.catch(() => {})).catch(() => {});
  let slow: ReturnType<typeof setTimeout> | undefined;
  const caught = await Promise.race([
    tailStream,
    new Promise<never>((_, fail) => {
      slow = setTimeout(
        () => fail(new Error("a caught-up stream never received its headers")),
        5_000,
      );
    }),
  ]).finally(() => clearTimeout(slow));
  assert.equal(caught.status, 200, "headers arrive before any event does");
  assert.deepEqual(caught.frames, [], "no history is replayed past the tail");

  const late = await stream(d, id);
  const resumed = await stream(d, id, 2);
  await until(
    "the late stream to catch up",
    () => late.frames.length >= first.frames.length,
  );
  assert.equal((await api(d, "DELETE", `/runs/${id}`)).status, 202);
  await Promise.all([first.ended, late.ended, resumed.ended, caught.ended]);

  const seqs = (s: Stream) => s.frames.map((f) => f.id);
  const n = first.frames.length;
  assert.deepEqual(
    seqs(first),
    Array.from({ length: n }, (_, i) => i + 1),
  );
  assert.deepEqual(late.frames, first.frames);
  assert.deepEqual(resumed.frames, first.frames.slice(2));
  assert.ok(
    has(first, "stuck", "_client_task_finished"),
    "the tail reached the end",
  );

  const file = await readFile(
    join(stateDirFor(cwd), "runs", id, "events.jsonl"),
    "utf8",
  );
  assert.deepEqual(
    file
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l)),
    first.frames.map((f) => f.data),
  );
});

test("a stream-only client learns the run is over and its status, live and after a restart", async (t) => {
  // M5-5 (#137): `_client_run_finished` is the last frame, and a `GET` sent
  // after it has arrived already agrees with it — never `running`.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const cwd = await added(first, await tempDir(t));
  const posted = await api(first, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;

  const live = await stream(first, id);
  const isEnd = (f: Stream["frames"][number]) =>
    f.data.update.sessionUpdate === "_client_run_finished";
  await until("the run's last event", () => live.frames.some(isEnd));
  const got = await api(first, "GET", `/runs/${id}`);
  await live.ended;
  const end = live.frames.at(-1);
  assert.ok(end && isEnd(end), "the run's event is the last frame");
  assert.equal(end.data.agent, "");
  assert.equal(got.body.status, end.data.update.status);
  assert.equal(got.body.turns, 1);
  assert.equal(live.frames.filter(isEnd).length, 1);
  for (const f of live.frames) {
    const at = (f.data as { at?: unknown }).at;
    assert.equal(typeof at, "string", "every frame has at");
    assert.equal(new Date(at as string).toISOString(), at);
  }

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = await boot(t, runtime, [], state);
  const replay = await stream(second, id);
  await replay.ended;
  assert.deepEqual(replay.frames, live.frames, "a replay ends the same way");
  // The restart half must prove the criterion at the source too: a GET after
  // the replayed event agrees with that event's status.
  const replayEnd = replay.frames.at(-1);
  assert.ok(replayEnd && isEnd(replayEnd), "the replayed run event is last");
  const replayed = await api(second, "GET", `/runs/${id}`);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.status, replayEnd?.data.update.status);
});

test("a run whose preflight throws after its 202 keeps a record, a log and its error across a restart (#317)", async (t) => {
  // A corrupt index passes every check before the 202, then fails the
  // preflight's `git status`. The record and the log are written before the
  // preflight, so the failure has a record that a restart can read.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await gitRepo(t);
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  await writeFile(join(root, gitDir, "index"), "not an index\n");
  const cwd = await added(first, root);

  const posted = await api(first, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  // The 202 is sent before the async failure lands, so the client is told the
  // run exists and must ask for its status.
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;

  const live = await settled(first, id);
  assert.equal(live.status, "failed");
  assert.equal(typeof live.error, "string");
  const liveEvents = await stream(first, id);
  assert.equal(liveEvents.status, 200, "a stream, not no_event_log");
  await liveEvents.ended;
  assert.deepEqual(liveEvents.frames, [], "an empty log that ends");

  const record = JSON.parse(
    await readFile(join(stateDirFor(cwd), "runs", id, "run.json"), "utf8"),
  );
  assert.equal(record.status, "failed");
  assert.equal(record.error, live.error);

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = await boot(t, runtime, [], state);
  const restored = await api(second, "GET", `/runs/${id}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, "failed");
  assert.equal(restored.body.error, live.error);
  const replay = await stream(second, id);
  assert.equal(replay.status, 200, "a stream after a restart too");
  await replay.ended;
  assert.deepEqual(replay.frames, [], "the same empty log after a restart");
});

test("events for an unknown run are 404, a bad Last-Event-ID is 400, and the token is required", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  const { id } = posted.body;
  await settled(d, id);

  const nope = await api(d, "GET", "/runs/nope/events");
  assert.equal(nope.status, 404);
  assert.equal(nope.body.error.code, "run_not_found");
  assert.match(nope.body.error.message, /no run nope/, "the 404 names the run");
  assert.equal(
    (await api(d, "GET", `/runs/${id}/events`, undefined, null)).status,
    401,
  );
  assert.equal(
    (await api(d, "GET", `/runs/${id}/events`, undefined, "0".repeat(64)))
      .status,
    401,
    "a wrong token is 401 on the events route too",
  );
  for (const bad of ["x", -1, 1.5, 100_000]) {
    const r = await fetch(`${d.url}/runs/${id}/events`, {
      headers: {
        authorization: `Bearer ${d.token}`,
        "last-event-id": String(bad),
      },
    });
    assert.equal(r.status, 400, `Last-Event-ID ${bad}`);
    const refused = (await r.json()) as Reply;
    assert.equal(refused.error.code, "invalid_request", `Last-Event-ID ${bad}`);
  }

  const done = await stream(d, id);
  await done.ended;
  assert.ok(done.frames.length > 0, "a settled run still replays, then ends");

  const fromZero = await stream(d, id, 0);
  await fromZero.ended;
  assert.deepEqual(
    fromZero.frames,
    done.frames,
    "Last-Event-ID: 0 is the full replay",
  );
});

test("a restored run whose event log is gone answers no_event_log", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  const posted = await api(first, "POST", "/runs", {
    cwd: root,
    run: mockRun([{ id: "a", prompt: "hi" }]),
  });
  const { id } = posted.body;
  await settled(first, id);

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // The record survives the restart, the log does not: the run exists, but
  // there is nothing to stream and the code must say so rather than 404 the
  // run itself.
  await rm(join(stateDirFor(root), "runs", id, "events.jsonl"));

  const second = await boot(t, runtime, [], state);
  const events = await api(second, "GET", `/runs/${id}/events`);
  assert.equal(events.status, 404);
  assert.equal(events.body.error.code, "no_event_log");
});

test("a non-refusal error is a 500 internal, never a leaked code", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  await writeFile(join(root, gitDir, "index"), "not an index\n");
  const cwd = await added(d, root);

  // `openWorktrees` runs `git status`, which now throws an execFile error
  // whose own numeric `code` must not reach the envelope (M5-3, #135).
  const r = await api(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}` }],
  });
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, "internal");
  assert.equal(typeof r.body.error.code, "string");
});

test("a client that disconnects mid-run leaves no reader holding the log open", {
  skip: process.platform !== "linux" && "reads /proc/<pid>/fd",
}, async (t) => {
  // A reader is invisible over HTTP, but a reader that has touched the file
  // keeps it open until it detaches. With the writer that is two handles; a
  // reader left attached after its client left would keep the second until
  // the run ends — and this run never ends on its own.
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([
      { id: "stuck", prompt: "hi", cmd: `node ${MOCK_AGENT} --scenario stall` },
    ]),
  });
  const { id } = posted.body;
  const log = join(stateDirFor(cwd), "runs", id, "events.jsonl");
  const handles = () => {
    const fds = join("/proc", String(d.pid), "fd");
    return readdirSync(fds).filter((fd) => {
      try {
        return readlinkSync(join(fds, fd)) === log;
      } catch {
        return false; // closed between the listing and the read
      }
    }).length;
  };
  await until("the writer to open the log", () => handles() === 1);

  // A reader opens the file only when the daemon already counts a committed
  // line. The bytes can be visible before the write callback advances
  // `committed`, so do not gate on the file: a stream that arrives at the tail
  // stays bell-driven, never opens the file, and `handles() === 2` never
  // arrives. Retry with fresh streams until one opens the file, cancelling
  // each abandoned stream so it leaves no reader behind.
  let client: AbortController | undefined;
  let res: Awaited<ReturnType<typeof fetch>> | undefined;
  for (let attempt = 0; attempt < 20 && handles() !== 2; attempt++) {
    client = new AbortController();
    res = await fetch(`${d.url}/runs/${id}/events`, {
      headers: { authorization: `Bearer ${d.token}` },
      signal: client.signal,
    });
    assert.equal(res.status, 200);
    await until("the reader to open the log", () => handles() === 2, 250).catch(
      () => {},
    );
    if (handles() === 2) break;
    client.abort();
    await res.body?.cancel().catch(() => {});
    await until("the reader to let go", () => handles() === 1, 5_000);
    client = undefined;
    res = undefined;
  }
  assert.ok(client, "a reader attached");
  assert.ok(res, "a reader attached and opened the log");
  await until("the reader to open the log", () => handles() === 2);

  client.abort();
  await res.body?.cancel().catch(() => {});
  await until("the reader to let go", () => handles() === 1);
  assert.equal((await api(d, "GET", `/runs/${id}`)).body.status, "running");

  await api(d, "DELETE", `/runs/${id}`);
  await settled(d, id);
});

// --- permissions over the API, M2-3 ---------------------------------------------

test("an ask run with no client attached is denied at the timeout, and completes", async (t) => {
  const d = await boot(t, undefined, ["--permission-timeout", "2"]);
  const cwd = await added(d, await tempDir(t));

  const posted = await api(d, "POST", "/runs", askRun(cwd));
  assert.equal(posted.status, 202, posted.body.error?.message);
  // Capture the first decision while it is still pending: with the 2 s timeout
  // it is still listed, and a late answer after the run must read as settled.
  const pending = await pendingOne(d);
  assert.equal(pending.runId, posted.body.id);
  assert.equal(pending.kind, "edit");

  const run = await settled(d, posted.body.id);
  assert.equal(run.status, "done");

  // The criterion names the file, not the stream: read events.jsonl directly.
  const events = (
    await readFile(
      join(stateDirFor(cwd), "runs", posted.body.id, "events.jsonl"),
      "utf8",
    )
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  // Only the queue emits `_client_permission_queued`, so this cannot pass on
  // the `safePolicy` fallback an unwired `askPolicy` would leave behind.
  assert.ok(
    events.some((e) => e.update.sessionUpdate === "_client_permission_queued"),
    "the queue announced the pending decision on the run bus",
  );
  const decisions = events
    .map((e) => e.update as { sessionUpdate: string; allow?: boolean })
    .filter((u) => u.sessionUpdate === "_client_permission");
  // The mock asks twice — the edit, then a delete with an allow-only menu.
  assert.deepEqual(
    decisions.map((u) => u.allow),
    [false, false],
  );

  // A timed-out decision is settled, not unknown: a late allow is 409.
  assert.equal(
    (await api(d, "POST", `/permissions/${pending.id}`, { allow: true }))
      .status,
    409,
  );
  await assert.rejects(stat(join(cwd, "ACP_TEST.md")));
  assert.deepEqual((await api(d, "GET", "/permissions")).body, []);

  // M2-9: a replay carries every decision the run ever queued, and this run
  // settled both at the timeout. `attach` must not re-ask them: without the
  // `GET /permissions` guard this prints the wait line for both, and on a TTY
  // it would sit at a prompt for a decision the daemon settled long ago.
  const attached = await spawnCli(t, ["attach", posted.body.id], "cli.ts", {
    XDG_RUNTIME_DIR: join(d.file, "..", ".."),
  }).done;
  assert.equal(attached.code, 0, attached.stderr);
  assert.match(attached.stdout, /▸ one \(mock-agent\) done/);
  assert.doesNotMatch(attached.stderr, /waiting on/);
});

/** Boots with `env`, starts an ask run with no client, and returns it settled. */
async function unanswered(t: TestContext, env: Record<string, string>) {
  const d = await boot(t, await tempDir(t), [], undefined, env);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", askRun(cwd));
  assert.equal(posted.status, 202, posted.body.error?.message);
  await pendingOne(d);
  return { cwd, run: await settled(d, posted.body.id) };
}

test("a user-config permission timeout settles an unanswered decision", async (t) => {
  const config = await tempDir(t);
  await mkdir(join(config, "kapelle"), { recursive: true });
  // 0o644, not the umask's default: a group-writable config is refused
  // (core/config.ts), and umask 0002 would make one.
  await writeFile(
    join(config, "kapelle", "config.json"),
    JSON.stringify({ permissionTimeoutMs: 1500 }),
    { mode: 0o644 },
  );

  // The default is 120 s; settling inside the 20 s poll can only mean the
  // user file's 1.5 s window was applied.
  const { cwd, run } = await unanswered(t, { XDG_CONFIG_HOME: config });
  assert.equal(run.status, "done");
  await assert.rejects(stat(join(cwd, "ACP_TEST.md")));
});

test("KAPELLE_PERMISSION_TIMEOUT_MS settles an unanswered decision", async (t) => {
  const { run } = await unanswered(t, {
    KAPELLE_PERMISSION_TIMEOUT_MS: "1500",
  });
  assert.equal(run.status, "done");
});

test("an answer lets the write happen; a second answer is 409, an unknown id 404, a bad body 400", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", askRun(cwd));
  assert.equal(posted.status, 202, posted.body.error?.message);

  const pending = await pendingOne(d);
  assert.equal(pending.runId, posted.body.id);
  assert.equal(pending.taskId, "one");
  assert.equal(pending.kind, "edit");

  const path = `/permissions/${pending.id}`;
  assert.equal((await api(d, "POST", path, { allow: "yes" })).status, 400);
  assert.equal((await api(d, "POST", path, { allow: true })).status, 200);
  const second = await api(d, "POST", path, { allow: false });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "already_decided");
  const unknown = await api(d, "POST", "/permissions/nope", { allow: true });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "permission_not_found");

  // The mock's second request, the allow-only delete; the queue is not
  // answered by the first decision's id.
  const next = await pendingOne(d);
  assert.notEqual(next.id, pending.id);
  assert.equal(next.kind, "delete");
  assert.equal(
    (await api(d, "POST", `/permissions/${next.id}`, { allow: false })).status,
    200,
  );

  assert.equal((await settled(d, posted.body.id)).status, "done");
  await stat(join(cwd, "ACP_TEST.md"));
});

test("cancelling a run denies its pending decision at once, not at the timeout", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", askRun(cwd));
  const pending = await pendingOne(d);

  assert.equal((await api(d, "DELETE", `/runs/${posted.body.id}`)).status, 202);
  // The default timeout is 120 s; `settled` gives up after 20.
  assert.equal((await settled(d, posted.body.id)).status, "cancelled");
  assert.deepEqual((await api(d, "GET", "/permissions")).body, []);
  assert.equal(
    (await api(d, "POST", `/permissions/${pending.id}`, { allow: true }))
      .status,
    409,
  );
});

// --- M5-4, #136: two clients agree on which question closed, and why ---------

/** The reasons one stream gave for the decisions it saw close, by id. */
function reasonsIn(s: Stream): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { data } of s.frames) {
    const u = data.update as {
      sessionUpdate: string;
      id?: string;
      reason?: string;
    };
    if (u.sessionUpdate === "_client_permission_answered") {
      out[u.id as string] = u.reason as string;
    }
  }
  return out;
}

for (const [how, args, close] of [
  ["the timeout", ["--permission-timeout", "2"], async () => {}],
  [
    "a DELETE",
    [],
    async (d: Daemon, id: string) => {
      assert.equal((await api(d, "DELETE", `/runs/${id}`)).status, 202);
    },
  ],
] as const) {
  const reason = how === "the timeout" ? "timeout" : "cancel";
  test(`two stream readers attribute ${how} to the same id and reason, and GET /permissions/:id agrees`, async (t) => {
    const d = await boot(t, undefined, [...args]);
    const cwd = await added(d, await tempDir(t));
    const posted = await api(d, "POST", "/runs", askRun(cwd));
    assert.equal(posted.status, 202, posted.body.error?.message);
    const pending = await pendingOne(d);

    const open = await api(d, "GET", `/permissions/${pending.id}`);
    assert.equal(open.status, 200);
    assert.deepEqual(open.body, pending, "open: exactly as the list shows it");

    const [a, b] = [
      await stream(d, posted.body.id),
      await stream(d, posted.body.id),
    ];
    await close(d, posted.body.id);
    await settled(d, posted.body.id);
    await Promise.all([a.ended, b.ended]);

    const seen = reasonsIn(a);
    assert.equal(seen[pending.id], reason);
    assert.deepEqual(reasonsIn(b), seen, "both clients saw the same closes");

    const done = await api(d, "GET", `/permissions/${pending.id}`);
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { ...pending, allow: false, reason });
    const unknown = await api(d, "GET", "/permissions/nope");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "permission_not_found");
  });
}

test("a --permission-timeout that is not above 0 refuses to start", async (t) => {
  const r = await exitOf(
    start(t, await tempDir(t), ["--permission-timeout", "0"]),
  );
  assert.ok(r, "the daemon started anyway");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--permission-timeout/);
});

test("a --permission-timeout above Node's timer ceiling refuses to start", async (t) => {
  const over = await exitOf(
    start(t, await tempDir(t), ["--permission-timeout", "2147484"]),
  );
  assert.ok(over, "the daemon started anyway");
  assert.equal(over.code, 1);
  assert.match(over.stderr, /--permission-timeout/);

  // The last whole second below Node's 2^31-1 ms ceiling still boots.
  const d = await boot(t, undefined, ["--permission-timeout", "2147483"]);
  assert.ok(d.token);
});

test("a task the watchdog cuts drops its pending decision at once, while its siblings run", async (t) => {
  // The run-wide signal never fires here: the TTL cuts one task, the other
  // keeps the run alive. Without the per-task deny the entry would sit in
  // `GET /permissions` for the whole 120 s timeout.
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: {
      cmd: `node ${MOCK_AGENT}`,
      maxConcurrency: 2,
      tasks: [
        { id: "asker", prompt: "hi", ttlMs: 2_000 },
        {
          id: "busy",
          prompt: "hi",
          mode: "auto",
          cmd: `node ${MOCK_AGENT} --scenario stall`,
        },
      ],
    },
  });
  assert.equal(posted.status, 202, posted.body.error?.message);

  const pending = await pendingOne(d);
  assert.equal(pending.taskId, "asker");
  await until("the cut task's decision to be denied", async () => {
    const r = await api<Pending[]>(d, "GET", "/permissions");
    return r.body.length === 0;
  });
  // Still running: this was the task's own TTL, not the run's cancel.
  assert.equal(
    (await api(d, "GET", `/runs/${posted.body.id}`)).body.status,
    "running",
  );
  assert.equal(
    (await api(d, "POST", `/permissions/${pending.id}`, { allow: true }))
      .status,
    409,
  );

  await api(d, "DELETE", `/runs/${posted.body.id}`);
  await settled(d, posted.body.id);
});

// --- across a restart (M2-6, #36) -------------------------------------------

test("a restarted daemon keeps its repositories and serves the runs from before", async (t) => {
  const runtime = await tempDir(t);
  // State outlives the runtime dir (a reboot), so keep them distinct: the
  // list must land in the state dir, not beside `daemon.json`.
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  const posted = await api(first, "POST", "/runs", {
    cwd: root,
    run: mockRun([{ id: "a", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;
  assert.equal((await settled(first, id)).status, "done");

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // Same user-level directories, a new process: everything below comes off
  // the disk, since this daemon ran none of it.
  const second = await boot(t, runtime, [], state);
  assert.deepEqual((await api<string[]>(second, "GET", "/repos")).body, [root]);
  // Owner-only, same as daemon.json: the list names every repository the
  // daemon will run in.
  assert.equal(
    (await stat(join(state, "kapelle", "repos.json"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    existsSync(join(runtime, "kapelle", "repos.json")),
    false,
    "the list must not sit in the runtime dir",
  );
  const listed = (await api<Reply[]>(second, "GET", "/runs")).body;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, id);
  assert.equal(listed[0]?.cwd, root);
  assert.equal(listed[0]?.root, root);
  assert.equal(listed[0]?.status, "done");
  assert.equal(listed[0]?.source, "restored");
  // The record fills these (M5-2); the list keeps its tasks slim.
  assert.equal(typeof listed[0]?.startedAt, "string");
  assert.equal(typeof listed[0]?.endedAt, "string");
  assert.deepEqual(
    listed[0]?.tasks.map((task) => [task.id, task.status]),
    [["a", "done"]],
  );

  const one = await api(second, "GET", `/runs/${id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(
    one.body.tasks.map((task) => [task.id, task.status]),
    [["a", "done"]],
  );
  // The fields the extended record carries (M5-2, D2): the card's header
  // and elapsed time survive the restart.
  assert.equal(typeof one.body.tasks[0]?.agent, "string");
  assert.equal(typeof one.body.tasks[0]?.durationMs, "number");
  // The field M2-6 exists to carry: one session id, so `session/load` can be
  // picked up later without a migration. `String(undefined)` is `"undefined"`,
  // which matches a non-empty regex — assert the type, not its printout.
  const restoredSession = one.body.tasks[0]?.sessionId;
  assert.equal(typeof restoredSession, "string");
  assert.equal(restoredSession, "sess_mock_1");

  // And the log replays, although nothing is writing it: `createEventLog`
  // opens `flags: "w"`, so this has to come from the read-only open.
  const replay = await stream(second, id);
  assert.equal(replay.status, 200);
  await replay.ended;
  assert.ok(
    replay.frames.some(
      (f) => f.data.update.sessionUpdate === "_client_task_finished",
    ),
    "the restored stream should carry the task's end",
  );
  assert.deepEqual(
    replay.frames.map((f) => f.id),
    replay.frames.map((_, i) => i + 1),
  );

  // A cursor into the restored log resumes after it, and one past the end
  // gets the same 400 a live log gives.
  const resumed = await stream(second, id, 1);
  assert.equal(resumed.status, 200);
  await resumed.ended;
  assert.deepEqual(
    resumed.frames.map((f) => f.id),
    replay.frames.map((f) => f.id).filter((n) => n > 1),
  );
  const pastEnd = await stream(second, id, replay.frames.length + 1);
  assert.equal(pastEnd.status, 400);
});

test("a boot skips a record it cannot trust with a notice, and answers anyway", async (t) => {
  const runtime = await tempDir(t);
  const first = await boot(t, runtime);
  const root = await realpath(await added(first, await gitRepo(t)));
  // A second repository that never runs: no run directory is ever made
  // under its workspace, which must boot quietly — nothing was skipped.
  const quiet = await realpath(await added(first, await gitRepo(t)));
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // One record truncated mid-write, one written by something else.
  const runs = join(stateDirFor(root), "runs");
  await mkdir(join(runs, "truncated"), { recursive: true });
  await writeFile(join(runs, "truncated", "run.json"), '{"runId": "trun');
  await mkdir(join(runs, "foreign"));
  await writeFile(
    join(runs, "foreign", "run.json"),
    JSON.stringify({ runId: "not-this-one", status: "done", tasks: [] }),
  );
  // A record still saying `running` is a crash: M2-5's sweep rewrites it to
  // `killed` before this daemon restores, so it is served, not skipped.
  await mkdir(join(runs, "live"));
  await writeFile(
    join(runs, "live", "run.json"),
    JSON.stringify({ runId: "live", status: "running", tasks: [] }),
  );
  // A trusted record whose `tasks` array holds junk: the run is served with
  // the bad element dropped, because the route destructures every element and
  // one `[null]` would otherwise 500 the whole list.
  await mkdir(join(runs, "corrupt-tasks"));
  await writeFile(
    join(runs, "corrupt-tasks", "run.json"),
    JSON.stringify({
      runId: "corrupt-tasks",
      status: "done",
      tasks: [
        null,
        { foo: "bar" },
        // A key the contract does not name must not reach the wire (#160),
        // and nor does a named key with the wrong type: `"warnings": 5`
        // crashed `attach`'s `printTask`, and a malformed `usage` is rebuilt
        // from the contract's keys or dropped (M5-2).
        {
          id: "ok",
          status: "done",
          note: "hand-edited",
          agent: 7,
          durationMs: "3",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            _task: "ok",
            evil: true,
          },
          usageSemantics: "sometimes",
          summarySynthesised: "yes",
          warnings: [null, 5, { kind: "k", text: "t", extra: 1 }],
        },
        {
          id: "bad-usage",
          status: "done",
          usage: { inputTokens: "many", outputTokens: 2, totalTokens: 3 },
        },
        { id: "bad-warnings", status: "done", warnings: 5 },
        // Every entry is junk: the field stays omitted rather than serving `[]`.
        { id: "junk-warnings", status: "done", warnings: [null, 5] },
      ],
    }),
  );
  // A run directory with no record at all, and a record with no status: both
  // are skipped with a notice.
  await mkdir(join(runs, "no-record"));
  await mkdir(join(runs, "no-status"));
  await writeFile(
    join(runs, "no-status", "run.json"),
    JSON.stringify({ runId: "no-status", tasks: [] }),
  );

  const second = await boot(t, runtime);
  const list = await api<Reply[]>(second, "GET", "/runs");
  assert.equal(list.status, 200);
  // `live` was left `running` and the sweep rewrote it terminal: it reads
  // `killed` (M5-5). `corrupt-tasks` is trusted for its runId/status, so it is
  // served too, with the junk element dropped. Sorted: restore order is
  // readdir order, which is not part of the contract.
  const rows = [...list.body].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    rows.map((row) => [row.id, row.cwd, row.root, row.status, row.source]),
    [
      ["corrupt-tasks", root, root, "done", "restored"],
      ["live", root, root, "killed", "restored"],
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.tasks),
    [
      [
        { id: "ok", status: "done" },
        { id: "bad-usage", status: "done" },
        { id: "bad-warnings", status: "done" },
        { id: "junk-warnings", status: "done" },
      ],
      [],
    ],
  );
  // The sweep rewrote `live`, so it carries the `endedAt` it wrote (M2-5);
  // the hand-made record has neither timestamp, so both are omitted.
  assert.equal(typeof rows[1]?.endedAt, "string");
  assert.equal(rows[0]?.startedAt, undefined);
  const live = await api(second, "GET", "/runs/live");
  assert.equal(live.status, 200);
  assert.equal(live.body.status, "killed");
  const corrupt = await api(second, "GET", "/runs/corrupt-tasks");
  assert.deepEqual(corrupt.body.tasks, [
    {
      id: "ok",
      status: "done",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      warnings: [{ kind: "k", text: "t" }],
    },
    { id: "bad-usage", status: "done" },
    { id: "bad-warnings", status: "done" },
    { id: "junk-warnings", status: "done" },
  ]);

  process.kill(second.pid, "SIGTERM");
  const out = await second.done;
  assert.equal(out.code, 0);
  assert.match(out.stderr, /skipping .*truncated.*run\.json/);
  assert.match(out.stderr, /skipping .*foreign.*run\.json/);
  assert.match(out.stderr, /skipping .*no-record.*run\.json/);
  assert.match(out.stderr, /skipping .*no-status.*run\.json/);
  assert.equal(
    out.stderr.includes(join(runs, "live")),
    false,
    "rewriting a crashed record is silent, not a notice",
  );
  assert.equal(
    out.stderr.includes(`skipping runs under ${quiet}`),
    false,
    "a repository that never ran has no records to skip",
  );
});

test("kill -9 then restart rewrites the run, keeps queued tasks queued, and keeps its worktree", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  const posted = await api(first, "POST", "/runs", {
    cwd: root,
    run: mockRun(
      [
        {
          id: "stuck",
          prompt: "hi",
          cmd: `node ${MOCK_AGENT} --scenario stall`,
        },
        { id: "waiting", prompt: "hi" },
      ],
      { maxConcurrency: 1 },
    ),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;

  // The harness is live once children.json names it with its recorded start
  // time, and the first task's record already reads `running`, so the kill
  // lands mid-turn with `waiting` still queued behind it.
  const childrenFile = join(runtime, "kapelle", "children.json");
  const recordPath = join(stateDirFor(root), "runs", id, "run.json");
  let harness = 0;
  let recordedStartedAt = "";
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    const children = await readFile(childrenFile, "utf8").catch(() => null);
    const record = await readFile(recordPath, "utf8").catch(() => null);
    if (children && record) {
      const [child] = JSON.parse(children).children;
      const tasks = JSON.parse(record).tasks;
      if (
        child?.unitId === "stuck" &&
        typeof child.startedAt === "string" &&
        tasks?.[0]?.status === "running"
      ) {
        harness = child.pid;
        recordedStartedAt = child.startedAt;
        break;
      }
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.ok(
    harness > 0,
    "children.json never named the harness with its identity",
  );
  t.after(() => {
    try {
      process.kill(harness, "SIGKILL");
    } catch {
      // Already gone: nothing left to kill.
    }
  });
  // Pins the daemon-side identity write: the kill test would still pass if
  // `daemon.ts` never recorded `startedAt`, since the harness dies on EOF.
  assert.equal(await processIdentity(harness), recordedStartedAt);

  const worktree = join(stateDirFor(root), "wt", id, "stuck");
  assert.equal(existsSync(worktree), true, "the run should own a worktree");

  process.kill(first.pid, "SIGKILL");
  await first.done;

  // Same runtime and state, a new process: everything below is the sweep's.
  const second = await boot(t, runtime, [], state);
  const restored = await api(second, "GET", `/runs/${id}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, "killed");
  assert.deepEqual(
    restored.body.tasks.map((task) => [task.id, task.status]),
    [
      ["stuck", "killed"],
      ["waiting", "queued"],
    ],
  );
  const record = JSON.parse(
    await readFile(join(stateDirFor(root), "runs", id, "run.json"), "utf8"),
  );
  assert.equal(typeof record.endedAt, "string");
  // M5-5: the sweep writes no `_client_run_finished` the run never wrote.
  const replay = await stream(second, id);
  await replay.ended;
  assert.ok(replay.frames.length > 0, "the log still replays");
  assert.ok(
    !replay.frames.some(
      (f) => f.data.update.sessionUpdate === "_client_run_finished",
    ),
  );
  assert.equal(existsSync(worktree), true, "a worktree inside retention stays");
  assert.equal(await gone(harness), true, "the harness outlived the restart");
  assert.equal(existsSync(childrenFile), false);

  // M2-9: the partial log carries no `_client_task_finished`, so `attach`
  // must reconcile with the record `restoreRuns` built. The regression: it
  // printed only `stuck` and said `done — 1 task`, exit 0, for a crashed run.
  const attachEnv = dirs(runtime, state);
  const attached = await spawnCli(t, ["attach", id], "cli.ts", attachEnv).done;
  assert.equal(attached.code, 1, attached.stderr);
  assert.match(attached.stdout, /stuck \([^)]*\) killed/);
  assert.match(attached.stdout, /waiting \([^)]*\) queued/);
  assert.doesNotMatch(attached.stdout, /\bdone\b/);
  assert.match(attached.stdout, /killed — 2 tasks/);
  // `--quiet` keeps the run's verdict even when card lines were printed: a
  // `killed` card and a `queued` one do not say the run itself was killed.
  const quiet = await spawnCli(
    t,
    ["attach", id, "--quiet"],
    "cli.ts",
    attachEnv,
  ).done;
  assert.equal(quiet.code, 1, quiet.stderr);
  assert.match(quiet.stderr, /error: \[stuck\] killed/);
  assert.match(quiet.stderr, new RegExp(`error: run ${id} killed`));

  const oneTask = await spawnCli(
    t,
    ["attach", id, "--task", "waiting"],
    "cli.ts",
    attachEnv,
  ).done;
  assert.equal(oneTask.code, 1, oneTask.stderr);
  assert.match(oneTask.stdout, /waiting \([^)]*\) queued/);
  // `--task` keeps the card's own word in the summary, never `failed` (#170).
  assert.match(oneTask.stdout, /queued — 1 task/);
  const stuckTask = await spawnCli(
    t,
    ["attach", id, "--task", "stuck"],
    "cli.ts",
    attachEnv,
  ).done;
  assert.equal(stuckTask.code, 1, stuckTask.stderr);
  assert.match(stuckTask.stdout, /stuck \([^)]*\) killed/);
  assert.match(stuckTask.stdout, /killed — 1 task/);

  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});

test("kill -9 with a harness that ignores stdin and SIGTERM: the next boot kills it", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  const posted = await api(first, "POST", "/runs", {
    cwd: root,
    run: mockRun([
      {
        id: "stuck",
        prompt: "hi",
        cmd: `node ${MOCK_AGENT} --scenario stubborn`,
      },
    ]),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;

  const childrenFile = join(runtime, "kapelle", "children.json");
  let harness = 0;
  t.after(() => {
    if (harness <= 0) return;
    try {
      process.kill(harness, "SIGKILL");
    } catch {
      // Already gone: nothing left to kill.
    }
  });
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    const record = await readFile(childrenFile, "utf8").catch(() => null);
    if (record) {
      const [child] = JSON.parse(record).children;
      if (child?.unitId === "stuck" && typeof child.startedAt === "string") {
        harness = child.pid;
        break;
      }
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.ok(harness > 0, "children.json never named the stubborn harness");
  assert.equal(alive(harness), true, "the harness should be alive");

  process.kill(first.pid, "SIGKILL");
  await first.done;
  // SIGKILL closes the daemon's end of the harness pipes. `stubborn` has a
  // live timer, so EOF alone must not end it.
  await new Promise((ok) => setTimeout(ok, 300));
  const harnessStderr = async (): Promise<string> =>
    (await readFile(
      join(stateDirFor(root), "runs", id, "stuck.stderr.log"),
      "utf8",
    ).catch(() => "")) || "(no stderr)";
  assert.equal(
    alive(harness),
    true,
    `stdin EOF alone must not end it; harness stderr: ${await harnessStderr()}`,
  );

  const second = await boot(t, runtime, [], state);
  assert.equal(
    await gone(harness),
    true,
    `the next boot must kill it; harness stderr: ${await harnessStderr()}`,
  );
  assert.equal(existsSync(childrenFile), false);
  const restored = await api(second, "GET", `/runs/${id}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, "killed");

  process.kill(second.pid, "SIGTERM");
  const out = await second.done;
  assert.equal(out.code, 0);
  assert.match(out.stderr, new RegExp(`killed harness pid ${harness}`));
});

test("a boot reaps expired runs in every added repository and serves the in-window one", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const rootA = await realpath(await added(first, await gitRepo(t)));
  const rootB = await realpath(await added(first, await gitRepo(t)));
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const OLD = "20260801-000000-olda";
  const OLD2 = "20260801-000001-oldb";
  const RECENT = "20260915-000000-recn";
  const since = Date.now();
  const expired = new Date(since - 40 * 24 * 60 * 60 * 1000).toISOString();
  const inWindow = new Date(since - 60_000).toISOString();
  const old = await directFinishedRun(rootA, OLD, expired);
  const recent = await directFinishedRun(rootA, RECENT, inWindow);
  const old2 = await directFinishedRun(rootB, OLD2, expired);

  const second = await boot(t, runtime, [], state);

  assert.equal(existsSync(old.worktree), false);
  assert.equal(existsSync(old.dir), false);
  assert.equal(hasBranch(rootA, old.branch), false);
  assert.equal(existsSync(old2.worktree), false);
  assert.equal(existsSync(old2.dir), false);
  assert.equal(hasBranch(rootB, old2.branch), false);
  assert.equal(existsSync(recent.worktree), true);
  assert.equal(existsSync(recent.dir), true);
  assert.equal(hasBranch(rootA, recent.branch), true);

  const list = await api<Reply[]>(second, "GET", "/runs");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((run) => run.id).sort(), [RECENT]);
  assert.equal((await api(second, "GET", `/runs/${OLD}`)).status, 404);
  const served = await api(second, "GET", `/runs/${RECENT}`);
  assert.equal(served.status, 200);
  assert.equal(served.body.status, "failed");

  process.kill(second.pid, "SIGTERM");
  const out = await second.done;
  assert.equal(out.code, 0);
  assert.ok(out.stderr.includes(`reaped run ${OLD}`));
  assert.ok(out.stderr.includes(`reaped run ${OLD2}`));
  assert.equal(out.stderr.includes(`reaped run ${RECENT}`), false);
});

test("boot reconciles record-less worktrees: clean removed, dirty kept and noticed", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const CLEAN = "20260915-000000-clna";
  const DIRTY = "20260915-000001-drtb";
  const { worktrees: cleanWt } = await openWorktrees(root, CLEAN);
  assert.ok(cleanWt, "the fixture repository should carry worktrees");
  const cleanPath = await cleanWt.acquire("a");
  const { worktrees: dirtyWt } = await openWorktrees(root, DIRTY);
  assert.ok(dirtyWt, "the fixture repository should carry worktrees");
  const dirtyPath = await dirtyWt.acquire("a");
  await writeFile(join(dirtyPath, "partial.txt"), "work\n");

  const second = await boot(t, runtime, [], state);

  assert.equal(existsSync(cleanPath), false, "the clean orphan is removed");
  assert.equal(hasBranch(root, `kapelle/${CLEAN}/a`), true);
  assert.equal(existsSync(dirtyPath), true, "the dirty orphan is kept");
  assert.equal(existsSync(join(dirtyPath, "partial.txt")), true);
  assert.deepEqual((await api(second, "GET", "/runs")).body, []);

  process.kill(second.pid, "SIGTERM");
  const out = await second.done;
  assert.equal(out.code, 0);
  assert.match(out.stderr, /removed orphan worktree/);
  assert.match(out.stderr, /uncommitted changes/);
});
