/**
 * The daemon — `daemon.ts`, M2-1 (#31) — driven as a real subprocess over
 * real HTTP.
 *
 * **None of this needs a harness**, so it runs in CI like `tests/cli.test.ts`:
 * every run points at `mock-agent.mjs`, and every refusal fails before a
 * subprocess starts. Each daemon gets its own `XDG_RUNTIME_DIR`, so no test
 * ever meets another test's `daemon.json` — or the developer's real one.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import test, { type TestContext } from "node:test";

import {
  type CliResult,
  gitRepo,
  MOCK_AGENT,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";

interface Daemon {
  url: string;
  token: string;
  /** What `daemon.json` says, next to what the test actually spawned. */
  pid: number;
  childPid: number | undefined;
  file: string;
  /** The daemon's exit, for the tests that stop it. */
  done: Promise<CliResult>;
}

/** Spawns `daemon.ts` with `runtime` as its `XDG_RUNTIME_DIR`. */
function start(t: TestContext, runtime: string) {
  return spawnCli(t, ["--port", "0"], "daemon.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
}

/** Starts a daemon and reads back the record it wrote once listening. */
async function boot(t: TestContext, runtime?: string): Promise<Daemon> {
  const dir = runtime ?? (await tempDir(t));
  const d = start(t, dir);
  // A daemon that dies at startup must fail with its own words, not a timeout.
  const died = d.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([d.waitFor("listening on "), died]);
  died.catch(() => {});
  const file = join(dir, "kapelle", "daemon.json");
  const { port, token, pid } = JSON.parse(await readFile(file, "utf8"));
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    pid,
    childPid: d.child.pid,
    file,
    done: d.done,
  };
}

/** The exit of a daemon expected to refuse, or `null` if it kept running. */
async function exitOf(d: ReturnType<typeof start>): Promise<CliResult | null> {
  const late = new Promise<null>((ok) => setTimeout(() => ok(null), 5_000));
  return Promise.race([d.done, late]);
}

/** A run record, a repo, and the `{error}` every refusal sends, typed as the
 *  tests read them: each test asserts only the fields its reply carries. */
interface Reply {
  id: string;
  status: string;
  cwd: string;
  root: string;
  error: string;
  cancelRequested?: true;
  report: { tasks: { status: string }[] };
  notices: { taskId: string; text: string }[];
}

async function api<T = Reply>(
  d: Daemon,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = d.token,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(d.url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const mockRun = (
  tasks: Record<string, unknown>[],
  rest: Record<string, unknown> = {},
) => ({ cmd: `node ${MOCK_AGENT}`, mode: "auto", ...rest, tasks });

/** Registers `path` and returns it, so a test reads `cwd = await added(...)`. */
async function added(d: Daemon, path: string): Promise<string> {
  const r = await api(d, "POST", "/repos", { path });
  assert.equal(r.status, 200, r.body.error);
  return path;
}

/** Polls `GET /runs/:id` until the run leaves `running`. */
async function settled(d: Daemon, id: string): Promise<Reply> {
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const r = await api(d, "GET", `/runs/${id}`);
    assert.equal(r.status, 200);
    if (r.body.status !== "running") return r.body;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`run ${id} never settled`);
}

// --- the token and daemon.json --------------------------------------------------

test("a request without the right token is refused, and changes nothing", async (t) => {
  const d = await boot(t);
  const cwd = await tempDir(t);
  const run = { cwd, run: mockRun([{ id: "a", prompt: "hi" }]) };

  assert.equal(
    (await api(d, "POST", "/repos", { path: cwd }, null)).status,
    401,
  );
  assert.equal(
    (await api(d, "POST", "/runs", run, "0".repeat(64))).status,
    401,
  );
  assert.equal((await api(d, "GET", "/runs", undefined, "short")).status, 401);

  assert.deepEqual((await api(d, "GET", "/repos")).body, []);
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("daemon.json holds port, pid and a random token, and only the owner can read it", async (t) => {
  const d = await boot(t);
  const other = await boot(t);

  assert.match(d.token, /^[0-9a-f]{64}$/);
  assert.notEqual(d.token, other.token);
  assert.equal(d.pid, d.childPid);
  assert.equal((await stat(d.file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(d.file, ".."))).mode & 0o777, 0o700);
});

test("a second daemon refuses to start, and leaves the first one's token alone", async (t) => {
  const runtime = await tempDir(t);
  const first = await boot(t, runtime);
  const before = await readFile(first.file, "utf8");

  const second = await exitOf(start(t, runtime));
  assert.ok(second, "the second daemon kept running");
  assert.equal(second.code, 1);
  assert.match(second.stderr, new RegExp(`already running: pid ${first.pid}`));

  assert.equal(await readFile(first.file, "utf8"), before);
  assert.equal((await api(first, "GET", "/runs")).status, 200);
});

test("a daemon.json left by a daemon that died is replaced, not obeyed", async (t) => {
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: dead, port: 1, token: "stale" }),
    { mode: 0o600 },
  );

  const d = await boot(t, runtime);
  assert.notEqual(d.token, "stale");
  assert.equal(d.pid, d.childPid);
});

test("a runtime directory other users can enter is refused", async (t) => {
  const runtime = await tempDir(t);
  const dir = join(runtime, "kapelle");
  await mkdir(dir);
  await chmod(dir, 0o755);

  const r = await exitOf(start(t, runtime));
  assert.ok(r, "the daemon started anyway");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /0700/);
  await assert.rejects(readFile(join(dir, "daemon.json")));
});

for (const stale of ["null", "[]", "42"]) {
  test(`a daemon.json holding ${stale} is replaced, like any dead daemon's`, async (t) => {
    const runtime = await tempDir(t);
    const dir = join(runtime, "kapelle");
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, "daemon.json"), stale, { mode: 0o600 });

    const d = await boot(t, runtime);
    assert.equal(typeof d.pid, "number");
    process.kill(d.pid, "SIGTERM");
    assert.equal((await d.done).code, 0);
  });
}

// --- lifecycle (M2-4) --------------------------------------------------------------

/** True once `pid` is gone, false if it is still alive after 10s. */
async function gone(pid: number): Promise<boolean> {
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return false;
}

/** Starts a run whose harness never ends its turn, and returns the pid the
 *  daemon recorded for it in `children.json`. */
async function stalledHarness(t: TestContext, d: Daemon): Promise<number> {
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([
      { id: "stuck", prompt: "hi", cmd: `node ${MOCK_AGENT} --scenario stall` },
    ]),
  });
  assert.equal(posted.status, 202, posted.body.error);
  const children = join(d.file, "..", "children.json");
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    const record = await readFile(children, "utf8").catch(() => null);
    if (record) {
      const [child] = JSON.parse(record).children;
      // Registered before the assertions: a failing assertion must not skip
      // the reap and leave the harness behind.
      t.after(() => {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already gone: nothing left to kill.
        }
      });
      assert.equal(child.runId, posted.body.id);
      assert.equal(child.taskId, "stuck");
      return child.pid;
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("children.json never named the harness");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} cancels every run, stops its harness, removes daemon.json and exits 0`, async (t) => {
    const d = await boot(t);
    const harness = await stalledHarness(t, d);

    process.kill(d.pid, signal);
    const exit = await d.done;
    assert.equal(exit.code, 0, exit.stderr);
    assert.equal(await gone(harness), true, "the harness outlived the daemon");
    await assert.rejects(readFile(d.file), "daemon.json is removed");
    await assert.rejects(
      readFile(join(d.file, "..", "children.json")),
      "children.json is removed once no harness is live",
    );
  });
}

test("kill -9 of the daemon mid-turn leaves no harness alive, and the pid on record", async (t) => {
  const d = await boot(t);
  const harness = await stalledHarness(t, d);

  process.kill(d.pid, "SIGKILL");
  await d.done;
  // Nothing in the daemon ran: the harness saw its stdin close and exited.
  assert.equal(await gone(harness), true, "the harness outlived the daemon");
  const record = await readFile(join(d.file, "..", "children.json"), "utf8");
  assert.equal(JSON.parse(record).children[0].pid, harness);
});

test("daemons started together on a stale daemon.json: exactly one listens", async (t) => {
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: dead, port: 1, token: "stale" }),
    { mode: 0o600 },
  );

  const daemons = Array.from({ length: 6 }, () => start(t, runtime));
  const outcomes = await Promise.all(
    daemons.map((d) =>
      Promise.race([
        d.waitFor("listening on ").then(() => "listening"),
        d.done.then((r) => `exited ${r.code}`),
      ]),
    ),
  );
  assert.equal(
    outcomes.filter((o) => o === "listening").length,
    1,
    outcomes.join(", "),
  );
  assert.deepEqual(
    outcomes.filter((o) => o !== "listening"),
    Array(5).fill("exited 1"),
  );
});

test("the strict lock refuses a start while held, and is gone once a start succeeds", async (t) => {
  const runtime = await tempDir(t);
  const dir = join(runtime, "kapelle");
  await mkdir(dir, { mode: 0o700 });
  // A stale daemon.json makes a newcomer take the lock path at all; the held
  // lock is another starter mid-replace, so this one must refuse rather than
  // wait (M2-4).
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  await writeFile(
    join(dir, "daemon.json"),
    JSON.stringify({ pid: dead, port: 1, token: "stale" }),
    { mode: 0o600 },
  );
  const lock = join(dir, "daemon.json.lock");
  await mkdir(lock);

  const refused = await exitOf(start(t, runtime));
  assert.ok(refused, "a held lock refuses, it does not listen");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /another daemon is starting/);
  await stat(lock); // the loser does not remove a lock it did not take
  await rm(lock, { recursive: true, force: true });
  // A start that takes the lock releases it again, so the next one works.
  const first = await boot(t, runtime);
  await assert.rejects(stat(lock), "the winner removed its own lock");
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await boot(t, runtime);
  assert.equal(typeof second.pid, "number");
  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});

test("kapelle daemon start listens, and kapelle daemon add registers a repository", async (t) => {
  const runtime = await tempDir(t);
  const env = { XDG_RUNTIME_DIR: runtime };
  const repo = await tempDir(t);

  const none = await spawnCli(t, ["daemon", "add", repo], "cli.ts", env).done;
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no daemon is listening/);

  const daemon = spawnCli(t, ["daemon", "start", "--port", "0"], "cli.ts", env);
  const died = daemon.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([daemon.waitFor("listening on "), died]);
  died.catch(() => {});

  const add = await spawnCli(t, ["daemon", "add", repo], "cli.ts", env).done;
  assert.equal(add.code, 0, add.stderr);
  assert.equal(add.stdout.trim(), `added ${await realpath(repo)}`);

  const file = join(runtime, "kapelle", "daemon.json");
  const { port, token, pid } = JSON.parse(await readFile(file, "utf8"));
  const d = { url: `http://127.0.0.1:${port}`, token, pid } as Daemon;
  assert.deepEqual((await api<string[]>(d, "GET", "/repos")).body, [
    await realpath(repo),
  ]);
});

test("kapelle --quiet daemon start starts the daemon, global flags included", async (t) => {
  const runtime = await tempDir(t);
  const daemon = spawnCli(
    t,
    ["--quiet", "daemon", "start", "--port", "0"],
    "cli.ts",
    { XDG_RUNTIME_DIR: runtime },
  );
  const died = daemon.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([daemon.waitFor("listening on "), died]);
  died.catch(() => {});

  const file = join(runtime, "kapelle", "daemon.json");
  assert.equal(typeof JSON.parse(await readFile(file, "utf8")).pid, "number");
});

test("kapelle daemon add treats a non-object daemon.json as no daemon", async (t) => {
  const runtime = await tempDir(t);
  const dir = join(runtime, "kapelle");
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, "daemon.json"), "null", { mode: 0o600 });

  const r = await spawnCli(t, ["daemon", "add", "/tmp"], "cli.ts", {
    XDG_RUNTIME_DIR: runtime,
  }).done;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no daemon is listening/);
});

// --- repos ----------------------------------------------------------------------

test("POST /repos registers the repository root, once, and GET /repos lists it", async (t) => {
  const root = await gitRepo(t, { files: { "pkg/file.txt": "x\n" } });
  const d = await boot(t);

  const sub = await api(d, "POST", "/repos", { path: join(root, "pkg") });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.root, await realpath(root));
  assert.equal((await api(d, "POST", "/repos", { path: root })).status, 200);

  assert.deepEqual((await api(d, "GET", "/repos")).body, [
    await realpath(root),
  ]);
});

test("POST /repos refuses a relative, missing or unignored path, and registers none", async (t) => {
  const d = await boot(t);

  const relative = await api(d, "POST", "/repos", { path: "src/app" });
  assert.equal(relative.status, 400);
  assert.match(relative.body.error, /absolute/);

  const missing = await api(d, "POST", "/repos", {
    path: join(await tempDir(t), "typo"),
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /does not exist/);

  const unignored = await api(d, "POST", "/repos", {
    path: await gitRepo(t, { ignore: "" }),
  });
  assert.equal(unignored.status, 409);
  assert.match(unignored.body.error, /is not ignored by git/);

  assert.deepEqual((await api(d, "GET", "/repos")).body, []);
});

test("POST /runs in a folder never added is 403, and starts nothing", async (t) => {
  const d = await boot(t);
  const r = await api(d, "POST", "/runs", {
    cwd: await tempDir(t),
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  assert.equal(r.status, 403);
  assert.match(r.body.error, /POST \/repos/);
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("an unadded repo with an unsafe .kapelle/ is still 403, by membership first", async (t) => {
  // The state-dir refusal is a 409 for repositories we own; for one never
  // added it must not pre-empt the 403 the story promises.
  const d = await boot(t);
  const cwd = await gitRepo(t, { ignore: "" });

  const r = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  assert.equal(r.status, 403);
  assert.match(r.body.error, /POST \/repos/);
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("an added repo that becomes unsafe is a 409 before the 202", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  await writeFile(join(cwd, ".gitignore"), "");
  assert.equal(spawnSync("git", ["add", "-A"], { cwd }).status, 0);
  assert.equal(
    spawnSync("git", ["commit", "-m", "drop the ignore"], { cwd }).status,
    0,
  );

  const r = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  assert.equal(r.status, 409);
  assert.match(r.body.error, /is not ignored by git/);
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

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
  assert.equal(run.report.tasks[0]?.status, "done");
});

test("an invalid body is 400 in the validator's words, and creates no run", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));

  const noRun = await api(d, "POST", "/runs", { cwd });
  assert.equal(noRun.status, 400);

  const empty = await api(d, "POST", "/runs", { cwd, run: { tasks: [] } });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /non-empty "tasks" array/);

  const garbled = await fetch(`${d.url}/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${d.token}` },
    body: "{",
  });
  assert.equal(garbled.status, 400);

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("a run that would ask is refused naming M2-3, a bare file included", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));

  // No mode anywhere: every registry entry defaults to `ask`, so this is the
  // run file people actually write, and it must not quietly run as `safe`.
  const bare = await api(d, "POST", "/runs", {
    cwd,
    run: { cmd: `node ${MOCK_AGENT}`, tasks: [{ id: "one", prompt: "hi" }] },
  });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /M2-3/);

  const mixed = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([
      { id: "calm", prompt: "hi" },
      { id: "curious", prompt: "hi", mode: "ask" },
    ]),
  });
  assert.equal(mixed.status, 400);
  assert.match(mixed.body.error, /"curious"/);

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("a dirty tree is 409 in the preflight's words, and creates no run", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  await writeFile(join(cwd, "wip.txt"), "uncommitted\n");

  const r = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /uncommitted changes/);
  assert.match(r.body.error, /wip\.txt/);

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("a subdirectory cwd runs inside its registered root, and the daemon writes nothing into the repo", async (t) => {
  // A root-anchored ignore: an unanchored `.kapelle/` would hide a file the
  // daemon wrongly left in `pkg/`, and let exactly that bug pass.
  const root = await gitRepo(t, {
    ignore: "/.kapelle/\n",
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
  assert.equal(posted.status, 202, posted.body.error);
  // A worktree runs the result cross-check, and mock-agent reports
  // `ACP_TEST.md` from inside `pkg/`, so the run may promote to `warned`.
  // What this test owns is that nothing the daemon wrote failed it.
  assert.match((await settled(d, posted.body.id)).status, /^(done|warned)$/);

  // The pre-run status above cannot see what the run wrote. Without
  // `--ignored`, the daemon's own `.kapelle/` is allowed while an unanchored
  // `pkg/.kapelle/` would surface — which is the claim in the test name.
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
    ignore: "/.kapelle/\n",
    files: { "pkg/file.txt": "committed\n" },
  });
  const d = await boot(t);
  const cwd = await added(d, join(root, "pkg"));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error);
  const id = posted.body.id as string;
  assert.match((await settled(d, id)).status, /^(done|warned)$/);

  const events = (
    await readFile(
      join(await realpath(root), ".kapelle", "runs", id, "events.jsonl"),
      "utf8",
    )
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
    created.update.path.includes(`${sep}.kapelle${sep}wt${sep}`),
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
  assert.equal((await api(d, "DELETE", `/runs/${id}`)).status, 409);
  assert.equal((await api(d, "DELETE", "/runs/nope")).status, 404);
  assert.equal((await api(d, "GET", "/runs/nope")).status, 404);
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
        out.frames.push({ id: Number(id), data: JSON.parse(data as string) });
      }
    }
  })();
  return out;
}

async function until(
  what: string,
  check: () => boolean,
  ms = 20_000,
): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
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
  assert.equal(posted.status, 202, posted.body.error);
  const { id } = posted.body;

  const first = await stream(d, id);
  assert.equal(first.status, 200);
  const has = (s: Stream, agent: string, kind: string) =>
    s.frames.some(
      (f) => f.data.agent === agent && f.data.update.sessionUpdate === kind,
    );
  // Mid-run for certain: `one` is over and `stuck` never answers its prompt.
  await until(
    "the second task to start",
    () =>
      has(first, "one", "_client_task_finished") &&
      has(first, "stuck", "_client_task_started"),
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
    join(cwd, ".kapelle", "runs", id, "events.jsonl"),
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

test("events for an unknown run are 404, a bad Last-Event-ID is 400, and the token is required", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  const { id } = posted.body;
  await settled(d, id);

  const nope = await api<{ error: string }>(d, "GET", "/runs/nope/events");
  assert.equal(nope.status, 404);
  assert.match(nope.body.error, /no run nope/, "the 404 names the run");
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
    assert.equal(
      (await stream(d, id, bad)).status,
      400,
      `Last-Event-ID ${bad}`,
    );
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
  const log = join(await realpath(cwd), ".kapelle", "runs", id, "events.jsonl");
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

// --- chat rooms (chat MVP) ------------------------------------------------------

const REMEMBER = `node ${MOCK_AGENT} --scenario remember`;

interface RoomReply {
  id: string;
  status: string;
  harness: string;
  workspace: string;
  error: string;
  seq: number;
}

/** Polls `GET /rooms/:id` until the room is no longer `busy`. */
async function roomIdle(d: Daemon, id: string): Promise<RoomReply> {
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const r = await api<RoomReply>(d, "GET", `/rooms/${id}`);
    assert.equal(r.status, 200);
    if (r.body.status !== "busy") return r.body;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`room ${id} never went idle`);
}

/** Every event of a room, read from its SSE stream. Only call once the room
 *  is dismissed: the stream ends only when its log closes. */
async function roomEvents(
  d: Daemon,
  id: string,
): Promise<{ agent: string; update: Record<string, unknown> }[]> {
  const res = await fetch(`${d.url}/rooms/${id}/events`, {
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(res.status, 200);
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

test("a room keeps one harness and its context across messages, until it is dismissed", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));

  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    cmd: REMEMBER,
  });
  assert.equal(open.status, 201, open.body.error);
  assert.equal(open.body.status, "idle");
  const { id } = open.body;
  assert.match(
    open.body.workspace,
    /\.kapelle\/wt\//,
    "the room has its own checkout",
  );

  for (const text of ["alpha", "beta"]) {
    const r = await api<RoomReply>(d, "POST", `/rooms/${id}/messages`, {
      text,
    });
    assert.equal(r.status, 202, r.body.error);
    await roomIdle(d, id);
  }

  const gone = await api<RoomReply>(d, "DELETE", `/rooms/${id}`);
  assert.equal(gone.status, 200, gone.body.error);
  assert.equal(gone.body.status, "closed");

  const events = await roomEvents(d, id);
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.deepEqual(
    of("_client_user_message").map((e) => e.update.text),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    of("agent_message_chunk").map(
      (e) => (e.update.content as { text: string }).text,
    ),
    ["previous: (none)", "previous: alpha"],
    "the second turn saw the first: one session, context kept",
  );
  assert.deepEqual(
    of("_client_turn_ended").map((e) => e.update.stopReason),
    ["end_turn", "end_turn"],
  );
  assert.equal(
    of("_client_harness_spawned").length,
    1,
    "one harness for both turns",
  );
  assert.equal(of("_client_harness_exited").length, 1, "dismiss stopped it");

  const late = await api<RoomReply>(d, "POST", `/rooms/${id}/messages`, {
    text: "gamma",
  });
  assert.equal(late.status, 409);
  assert.equal((await api<RoomReply>(d, "DELETE", `/rooms/${id}`)).status, 409);
});

test("a message while the harness is still answering is refused, and dismiss ends that turn", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    cmd: `node ${MOCK_AGENT} --scenario stall`,
  });
  assert.equal(open.status, 201, open.body.error);
  const { id } = open.body;

  assert.equal(
    (await api(d, "POST", `/rooms/${id}/messages`, { text: "one" })).status,
    202,
  );
  const busy = await api<RoomReply>(d, "POST", `/rooms/${id}/messages`, {
    text: "two",
  });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /still answering/);

  assert.equal((await api(d, "DELETE", `/rooms/${id}`)).status, 200);
  const ended = (await roomEvents(d, id)).filter(
    (e) => e.update.sessionUpdate === "_client_turn_ended",
  );
  assert.equal(ended.length, 1, "the live turn ended on dismiss");
});

test("POST /rooms refuses an unadded folder, a missing or unknown harness, and a bad message", async (t) => {
  const d = await boot(t);
  const repo = await gitRepo(t);

  const unadded = await api<RoomReply>(d, "POST", "/rooms", {
    cwd: repo,
    cmd: REMEMBER,
  });
  assert.equal(unadded.status, 403);

  const cwd = await added(d, repo);
  const none = await api<RoomReply>(d, "POST", "/rooms", { cwd });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /"agent" or "cmd"/);
  const unknown = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agent: "nope",
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /unknown agent "nope"/);

  assert.equal(
    (await api(d, "POST", "/rooms/missing/messages", { text: "x" })).status,
    404,
  );
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    cmd: REMEMBER,
  });
  const empty = await api(d, "POST", `/rooms/${open.body.id}/messages`, {
    text: " ",
  });
  assert.equal(empty.status, 400);
  await api(d, "DELETE", `/rooms/${open.body.id}`);
});

test("chat.ts talks to a room end to end: messages in, answers out, /dismiss stops it", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));

  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("alpha\nbeta\n/dismiss\n");
  const r = await c.done;

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /you: alpha\nmock-agent: previous: \(none\)\n/);
  assert.match(r.stdout, /you: beta\nmock-agent: previous: alpha\n/);
  assert.match(r.stdout, /the room was dismissed/);
  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  assert.deepEqual(
    rooms.body.map((room) => room.status),
    ["closed"],
  );
});

test("chat.ts reaches the daemon over HTTP only: its one repo import is core/runtime.ts", async () => {
  // Packages (pi-tui) are allowed; only a relative import reaches this repo.
  const source = await readFile(
    join(import.meta.dirname, "..", "chat.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/^import[^;]*?from "([^"]+)";/gms)].map(
    (m) => m[1],
  );
  const local = imports.filter((spec) => spec?.startsWith("."));
  assert.deepEqual(local, ["./core/runtime.ts"]);
});

test("chat.ts /leave keeps the room alive, and attach replays the conversation before the next turn", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const env = { XDG_RUNTIME_DIR: runtime };

  const first = spawnCli(
    t,
    ["new", "--cmd", REMEMBER, "--cwd", cwd],
    "chat.ts",
    env,
  );
  first.child.stdin.end("alpha\n/leave\n");
  assert.equal((await first.done).code, 0);

  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  assert.deepEqual(
    rooms.body.map((room) => room.status),
    ["idle"],
    "leaving kept it",
  );
  const id = rooms.body[0]?.id as string;

  const again = spawnCli(t, ["attach", id], "chat.ts", env);
  again.child.stdin.end("beta\n/dismiss\n");
  const r = await again.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /you: alpha\nmock-agent: previous: \(none\)\n[\s\S]*you: beta\nmock-agent: previous: alpha\n/,
    "history first, then the new turn — on the same harness",
  );
});

/** `script` from util-linux gives a child a real pseudo-terminal. Its flags
 *  differ on macOS, so the TTY test is Linux-only; it skips elsewhere. */
const noPty =
  process.platform !== "linux" ||
  spawnSync("script", ["--version"]).status !== 0
    ? "needs util-linux script(1) for a pseudo-terminal"
    : false;

test("chat.ts on a real terminal is the full-screen chat, and leaves the conversation in scrollback", {
  skip: noPty,
}, async (t) => {
  // Pipes never reach this path: only a TTY gets the pi-tui screen. A pty
  // made by `script` from a pipe has no size, so the command sets one.
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const cmd = `stty cols 100 rows 30; node chat.ts new --cmd '${REMEMBER}' --cwd '${cwd}'`;
  const child = spawn("script", ["-qfec", cmd, "/dev/null"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, XDG_RUNTIME_DIR: runtime },
  });
  t.after(() => void child.kill("SIGKILL"));

  let out = "";
  const seen = (text: string) =>
    new Promise<void>((ok, fail) => {
      const bail = setTimeout(
        () => fail(new Error(`never saw ${text}: ${out}`)),
        20_000,
      );
      const check = () => {
        if (!out.includes(text)) return;
        clearTimeout(bail);
        child.stdout.off("data", check);
        ok();
      };
      child.stdout.on("data", check);
      check();
    });
  child.stdout.setEncoding("utf8").on("data", (c: string) => {
    out += c;
  });
  const exited = new Promise<number | null>((ok) =>
    child.on("close", (code) => ok(code)),
  );

  // The status line, not the banner: keys sent before the screen takes the
  // terminal would be echoed by the terminal itself and prove nothing.
  await seen("enter to send");
  child.stdin.write("alpha\r");
  await seen("previous: (none)");
  child.stdin.write("/dismiss\r");
  await seen("the room was dismissed");
  assert.equal(await exited, 0, out);

  // What stays on the normal screen once the alternate one is left.
  // CSI, OSC and APC sequences; pi-tui writes all three.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
  const escapes =
    /\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(\x07|\x1b\\)|_[^\x1b]*\x1b\\)/g;
  const text = out
    .slice(out.lastIndexOf("\x1b[?1049l"))
    .replace(escapes, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "");
  assert.match(
    text,
    /you\n\s*alpha\n[\s\S]*mock-agent\n\s*previous: \(none\)\n[\s\S]*the room was dismissed/,
    "the typed message, the answer, then the exit line",
  );
});
