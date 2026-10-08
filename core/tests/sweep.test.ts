/**
 * Sweep tests — story M2-5, issue #35.
 *
 * Against real git, like `core/tests/worktree.test.ts`: every claim here is a
 * claim about what git does with worktrees and refs. The clock is injected,
 * so the retention boundary is a value and not a wait.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, type TestContext, test } from "node:test";
import { promisify } from "node:util";
import {
  gitRepo,
  isolateStateHome,
  tempDir,
} from "../../integration/helpers.ts";
import { newRoomId } from "../ids.ts";
import {
  type RoomRecord,
  readRoomRecord,
  roomFile,
  writeRoomRecord,
} from "../room.ts";
import { stateDirFor } from "../runtime.ts";
import { DEFAULT_RETENTION_MS, processIdentity, sweepBoot } from "../sweep.ts";
import { openWorktrees } from "../worktree.ts";

isolateStateHome();

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

const RUN_ID = "20260906-120000-abcd";
/** A second run id, for a worktree that must survive the first run's pass. */
const ORPHAN_ID = "20260906-120001-efgh";
const NOW = Date.parse("2026-09-17T00:00:00.000Z");

/**
 * The sweep reads `KAPELLE_*` from the process, so an ambient knob would move
 * every window in this file. Clear them around each test; a test that wants
 * the env sets it explicitly, and nothing here meets the developer's shell.
 */
let savedConfigEnv: Record<string, string> = {};

beforeEach(() => {
  savedConfigEnv = {};
  for (const name of Object.keys(process.env)) {
    if (!name.startsWith("KAPELLE_")) continue;
    savedConfigEnv[name] = process.env[name] ?? "";
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("KAPELLE_")) delete process.env[name];
  }
  for (const [name, value] of Object.entries(savedConfigEnv)) {
    process.env[name] = value;
  }
});

async function sweep(
  roots: string | string[],
  childrenFile: string,
  now = NOW,
): Promise<string[]> {
  const notices: string[] = [];
  await sweepBoot({
    repos: Array.isArray(roots) ? roots : [roots],
    childrenFile,
    now,
    onNotice: (text) => notices.push(text),
  });
  return notices;
}

async function writeRun(
  root: string,
  record: Record<string, unknown>,
  id = RUN_ID,
): Promise<string> {
  const dir = join(stateDirFor(root), "runs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), JSON.stringify(record, null, 2));
  return dir;
}

interface WrittenRecord {
  status: string;
  endedAt?: string;
  tasks: { id: string; status: string; branch?: string }[];
}

const readRun = async (dir: string): Promise<WrittenRecord> =>
  JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as WrittenRecord;

/** A checkout under `<stateDirFor(root)>/wt/<runId>/<taskId>`, the shape a run leaves. */
async function addWorktree(
  root: string,
  taskId: string,
  id = RUN_ID,
): Promise<string> {
  const { worktrees } = await openWorktrees(root, id);
  assert.ok(worktrees, "the fixture repository should carry worktrees");
  return worktrees.acquire(taskId);
}

async function hasBranch(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, "rev-parse", "--verify", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (const until = Date.now() + 5_000; Date.now() < until; ) {
    if (!isAlive(pid)) return true;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  return false;
}

async function waitForIdentity(pid: number): Promise<string> {
  for (const until = Date.now() + 5_000; Date.now() < until; ) {
    const identity = await processIdentity(pid);
    if (identity) return identity;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`ps never named pid ${pid}`);
}

/** A process that stays alive until it is signalled or the test ends. */
function sleeper(t: TestContext): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  return child;
}

/** A process that ignores SIGTERM until the sweep escalates to SIGKILL. */
async function sigtermIgnorer(
  t: TestContext,
): Promise<ReturnType<typeof spawn>> {
  const readyFile = join(await tempDir(t), "sigterm-ignorer-ready");
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const fs = require('node:fs');" +
        " process.on('SIGTERM', () => {});" +
        " fs.writeFileSync(process.env.KAPELLE_READY, 'ready');" +
        " setInterval(() => {}, 1000)",
    ],
    {
      stdio: "ignore",
      env: { ...process.env, KAPELLE_READY: readyFile },
    },
  );
  t.after(() => child.kill("SIGKILL"));
  for (const until = Date.now() + 5_000; Date.now() < until; ) {
    if (existsSync(readyFile)) return child;
    if (child.exitCode !== null) {
      throw new Error("sigterm ignorer exited before installing its handler");
    }
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("sigterm ignorer never installed its handler");
}

// --- records left mid-flight (M2-6 -> M2-5) ---------------------------------

test("a crashed record is rewritten: running tasks killed, queued left, log untouched", async (t) => {
  const root = await gitRepo(t);
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "running",
    startedAt: "2026-09-01T00:00:00.000Z",
    tasks: [
      { id: "a", status: "running" },
      { id: "b", status: "queued" },
    ],
  });
  // A crash can leave a half-written last line. M5-5 (#137): the sweep never
  // adds a `_client_run_finished` the run did not write, and touches nothing.
  const log = `${JSON.stringify({ seq: 1, agent: "a", update: {} })}\n{"seq":2,`;
  await writeFile(join(dir, "events.jsonl"), log);

  await sweep(root, join(await tempDir(t), "children.json"));

  const record = await readRun(dir);
  assert.equal(record.status, "killed");
  assert.equal(record.endedAt, new Date(NOW).toISOString());
  assert.deepEqual(
    record.tasks.map((task) => [task.id, task.status]),
    [
      ["a", "killed"],
      ["b", "queued"],
    ],
  );
  assert.equal(await readFile(join(dir, "events.jsonl"), "utf8"), log);
});

test("a running record with missing or malformed tasks still becomes killed", async (t) => {
  const root = await gitRepo(t);
  const startedAt = "2026-09-01T00:00:00.000Z";
  const dirs = {
    "no-tasks": await writeRun(
      root,
      { runId: "no-tasks", root, cwd: root, status: "running", startedAt },
      "no-tasks",
    ),
    "bad-array": await writeRun(
      root,
      {
        runId: "bad-array",
        root,
        cwd: root,
        status: "running",
        startedAt,
        tasks: "nope",
      },
      "bad-array",
    ),
    mixed: await writeRun(
      root,
      {
        runId: "mixed",
        root,
        cwd: root,
        status: "running",
        startedAt,
        tasks: [
          null,
          42,
          {
            id: "a",
            status: "running",
            branch: "kapelle/mixed/a",
            sessionId: "s",
          },
          "x",
          { id: "b", status: "done" },
        ],
      },
      "mixed",
    ),
  };

  await sweep(root, join(await tempDir(t), "children.json"));

  for (const [id, dir] of Object.entries(dirs)) {
    const record = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
    assert.equal(record.status, "killed", id);
    assert.equal(record.endedAt, new Date(NOW).toISOString(), id);
    assert.equal(record.root, root, id);
    assert.equal(record.cwd, root, id);
    assert.equal(record.startedAt, startedAt, id);
  }
  const noTasks = JSON.parse(
    await readFile(join(dirs["no-tasks"], "run.json"), "utf8"),
  );
  assert.deepEqual(noTasks.tasks, []);
  const badArray = JSON.parse(
    await readFile(join(dirs["bad-array"], "run.json"), "utf8"),
  );
  assert.deepEqual(badArray.tasks, []);
  const mixed = JSON.parse(
    await readFile(join(dirs.mixed, "run.json"), "utf8"),
  );
  assert.deepEqual(mixed.tasks, [
    { id: "a", status: "killed", branch: "kapelle/mixed/a", sessionId: "s" },
    { id: "b", status: "done" },
  ]);
});

// --- retention ---------------------------------------------------------------

test("a terminal run past retention is reaped whole", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });
  await writeFile(join(dir, "events.jsonl"), "{}\n");
  await writeFile(join(dir, "a.stderr.log"), "noise\n");

  await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(path), false, "the worktree should be gone");
  assert.equal(existsSync(dir), false, "the run directory should be gone");
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), false);
});

test("reaping reconstructs a branch the record never wrote", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const endedAt = "2026-08-01T00:00:00.000Z";
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: endedAt,
    endedAt,
    // No `branch` on either: this is the record a task killed mid-run leaves,
    // written before `acquire` could add the branch it owns.
    tasks: [
      { id: "a", status: "failed" },
      { id: "b", status: "queued" },
    ],
  });

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(path), false);
  assert.equal(existsSync(dir), false);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), false);
  assert.equal(
    notices.some((notice) => notice.includes("cannot delete branch")),
    false,
    "a task that never acquired a worktree has no branch to miss",
  );
});

test("the boundary holds: kept at 30 days, reaped just past it", async (t) => {
  assert.equal(DEFAULT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const childrenFile = join(await tempDir(t), "children.json");
  // Hard-coded rather than derived from the constant: this is the literal
  // 30-day contract, exactly at NOW - 30 days.
  const endedAt = "2026-08-18T00:00:00.000Z";
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: endedAt,
    endedAt,
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });

  // Exactly at the window is inside it: retention is "not past".
  await sweep(root, childrenFile);
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(dir), true);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), true);

  await sweep(root, childrenFile, NOW + 1);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(dir), false);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), false);
});

test("a terminal record with no endedAt is dated by its startedAt", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  // The record a run written before M2-6 leaves, or a hand-edited one. Without
  // a fallback stamp it is never past the window and never an orphan either,
  // so its checkout, branches and event log would be kept for good.
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });

  await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(path), false);
  assert.equal(existsSync(dir), false);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), false);
});

test("a terminal record that cannot be dated is kept, not reaped", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(path), true, "the worktree has a record");
  assert.equal(existsSync(join(dir, "run.json")), true, "the record stays");
  assert.ok(notices.some((notice) => notice.includes("cannot be dated")));
});

test("a past-retention run loses every worktree it owns", async (t) => {
  const root = await gitRepo(t);
  const a = await addWorktree(root, "a");
  const b = await addWorktree(root, "b");
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [
      { id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` },
      { id: "b", status: "failed", branch: `kapelle/${RUN_ID}/b` },
    ],
  });

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(a), false, "the first checkout should be gone");
  assert.equal(existsSync(b), false, "the second checkout should be gone");
  assert.equal(existsSync(dir), false);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), false);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/b`), false);
  assert.ok(notices.some((notice) => notice.includes(`reaped run ${RUN_ID}`)));
});

test("a branch held in another worktree is kept, and its expired run still clears", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const branch = `kapelle/${RUN_ID}/a`;
  // Detach the run's own checkout so the branch can move to the repository
  // root, where `git branch -D` must refuse to delete a checked-out branch.
  await git(path, "checkout", "--detach");
  await git(root, "checkout", branch);
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch }],
  });

  let notices: string[] = [];
  try {
    notices = await sweep(root, join(await tempDir(t), "children.json"));
  } finally {
    // Back to the base branch so the temp directory can remove the root.
    await git(root, "checkout", "-");
  }

  assert.ok(
    notices.some((notice) => notice.includes(`cannot delete branch ${branch}`)),
  );
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(dir), false);
  assert.equal(await hasBranch(root, branch), true);
});

test("endedAt decides the window when it disagrees with startedAt", async (t) => {
  const root = await gitRepo(t);
  const keptPath = await addWorktree(root, "a", RUN_ID);
  const reapedPath = await addWorktree(root, "a", ORPHAN_ID);
  const keptDir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    // Old `startedAt`, recent `endedAt`: `endedAt` alone keeps this one.
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-09-10T00:00:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });
  const reapedDir = await writeRun(
    root,
    {
      runId: ORPHAN_ID,
      root,
      cwd: root,
      status: "failed",
      // Recent `startedAt`, old `endedAt`: `endedAt` alone reaps this one.
      startedAt: "2026-09-10T00:00:00.000Z",
      endedAt: "2026-07-01T00:00:00.000Z",
      tasks: [{ id: "a", status: "failed", branch: `kapelle/${ORPHAN_ID}/a` }],
    },
    ORPHAN_ID,
  );

  await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(keptPath), true);
  assert.equal(existsSync(keptDir), true);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), true);
  assert.equal(existsSync(reapedPath), false);
  assert.equal(existsSync(reapedDir), false);
  assert.equal(await hasBranch(root, `kapelle/${ORPHAN_ID}/a`), false);
});

test("retentionMs overrides the default window", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const endedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: endedAt,
    endedAt,
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });

  await sweepBoot({
    repos: [root],
    childrenFile: join(await tempDir(t), "children.json"),
    now: NOW,
    retentionMs: 60 * 60 * 1000,
    onNotice: () => {},
  });

  assert.equal(existsSync(path), false);
  assert.equal(existsSync(dir), false);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), false);
});

test("retention is per repository, read from each repo's config", async (t) => {
  const short = await gitRepo(t);
  const long = await gitRepo(t);
  const endedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const record = (root: string) => ({
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: endedAt,
    endedAt,
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });

  const shortWorktree = await addWorktree(short, "a");
  const longWorktree = await addWorktree(long, "a");
  const shortDir = await writeRun(short, record(short));
  const longDir = await writeRun(long, record(long));
  // `.kapelle/` is no longer created by the run itself (#129) — the project
  // config is a file the operator writes, so the test writes it too.
  await mkdir(join(short, ".kapelle"), { recursive: true });
  // 0o644, not the umask's default: a group-writable config is refused
  // (core/config.ts), and umask 0002 would make one.
  await writeFile(
    join(short, ".kapelle", "config.json"),
    JSON.stringify({ retentionMs: 60 * 60 * 1000 }),
    { mode: 0o644 },
  );

  const notices = await sweep(
    [short, long],
    join(await tempDir(t), "children.json"),
  );

  assert.equal(existsSync(shortWorktree), false);
  assert.equal(existsSync(shortDir), false);
  assert.equal(await hasBranch(short, `kapelle/${RUN_ID}/a`), false);
  // The repository with no config keeps the built-in 30 days.
  assert.equal(existsSync(longWorktree), true, notices.join("\n"));
  assert.equal(existsSync(longDir), true);
  assert.equal(await hasBranch(long, `kapelle/${RUN_ID}/a`), true);
});

test("a bad repo's config is skipped while the env window reaps another repo", async (t) => {
  const bad = await gitRepo(t);
  const good = await gitRepo(t);
  const oldEndedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const recentEndedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
  const record = (root: string, id: string, endedAt: string) => ({
    runId: id,
    root,
    cwd: root,
    status: "failed",
    startedAt: endedAt,
    endedAt,
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${id}/a` }],
  });

  const oldWorktree = await addWorktree(good, "a", RUN_ID);
  const oldDir = await writeRun(good, record(good, RUN_ID, oldEndedAt), RUN_ID);
  const recentWorktree = await addWorktree(good, "a", ORPHAN_ID);
  const recentDir = await writeRun(
    good,
    record(good, ORPHAN_ID, recentEndedAt),
    ORPHAN_ID,
  );
  await mkdir(join(bad, ".kapelle"), { recursive: true });
  await writeFile(
    join(bad, ".kapelle", "config.json"),
    JSON.stringify({ stallIdle: 1 }),
    { mode: 0o644 },
  );

  // The env must win for `good`, but it must not hide `bad`'s broken file:
  // the sweep skips that repo instead of reaping it under the env window.
  process.env.KAPELLE_RETENTION_MS = String(60 * 60 * 1000);
  const notices = await sweep(
    [bad, good],
    join(await tempDir(t), "children.json"),
  );

  assert.ok(
    notices.some((text) => text.includes(bad) && text.includes('"stallIdle"')),
    notices.join("\n"),
  );
  assert.equal(existsSync(oldWorktree), false, notices.join("\n"));
  assert.equal(existsSync(oldDir), false);
  assert.equal(await hasBranch(good, `kapelle/${RUN_ID}/a`), false);
  // In-window for the same env: the good repo's recent run is kept.
  assert.equal(existsSync(recentWorktree), true, notices.join("\n"));
  assert.equal(existsSync(recentDir), true);
  assert.equal(await hasBranch(good, `kapelle/${ORPHAN_ID}/a`), true);
});

test("a second sweep with the same clock says nothing and changes nothing", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "running",
    startedAt: "2026-09-01T00:00:00.000Z",
    tasks: [{ id: "a", status: "running" }],
  });
  const childrenFile = join(await tempDir(t), "children.json");

  await sweep(root, childrenFile);
  const after = await readFile(join(dir, "run.json"), "utf8");
  const second = await sweep(root, childrenFile);

  assert.equal(await readFile(join(dir, "run.json"), "utf8"), after);
  assert.equal((await readRun(dir)).status, "killed");
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(childrenFile), false);
  assert.deepEqual(second, []);
});

// --- orphans: no readable record --------------------------------------------

test("a clean orphan loses its checkout but keeps its branch", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(path), false);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), true);
  assert.ok(
    notices.some((notice) => notice.includes("removed orphan worktree")),
  );
});

test("a clean orphan is reconciled even when XDG_STATE_HOME is a symlink", async (t) => {
  // `git worktree list --porcelain` reports symlink-resolved paths. If
  // `stateDirFor` kept the symlink's own spelling, `managedWorktrees()`'s
  // `relative(wtRoot, path)` would read every managed checkout as `..` and
  // skip it — the shape this reproduces without depending on the platform's
  // own tmpdir being a symlink (macOS: `/var` -> `/private/var`).
  const holder = mkdtempSync(join(realpathSync(tmpdir()), "kapelle-links-"));
  t.after(() => rm(holder, { recursive: true, force: true }));
  const real = join(holder, "real");
  const link = join(holder, "link");
  await mkdir(real, { recursive: true, mode: 0o700 });
  symlinkSync(real, link);
  const before = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = link;
  t.after(() => {
    if (before === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = before;
  });

  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(path), false);
  assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), true);
  assert.ok(
    notices.some((notice) => notice.includes("removed orphan worktree")),
  );
});

test("an unreadable record counts as absent", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const dir = join(stateDirFor(root), "runs", RUN_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), '{"runId": "');

  await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(dir, "run.json")), true, "the record stays");
});

test("an unreadable runs directory skips reap and orphan cleanup", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });
  const recordPath = join(dir, "run.json");
  const before = await readFile(recordPath, "utf8");
  const runsDir = join(stateDirFor(root), "runs");
  await chmod(runsDir, 0o000);
  let notices: string[] = [];
  try {
    notices = await sweep(root, join(await tempDir(t), "children.json"));
  } finally {
    await chmod(runsDir, 0o700);
  }

  assert.equal(existsSync(path), true, "the worktree is kept");
  assert.equal(
    await hasBranch(root, `kapelle/${RUN_ID}/a`),
    true,
    "the branch is kept",
  );
  assert.equal(await readFile(recordPath, "utf8"), before, "record unchanged");
  assert.ok(
    notices.some((notice) =>
      notice.includes("skipping reap and orphan cleanup"),
    ),
  );
  assert.equal(
    notices.some((notice) => notice.includes("removed orphan worktree")),
    false,
  );
});

test("an unreadable runs directory skips an expired reap too", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    // Past retention: without the unreadable-directory skip, this record
    // would be reaped, so the skip is not vacuous.
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });
  const recordPath = join(dir, "run.json");
  const before = await readFile(recordPath, "utf8");
  const runsDir = join(stateDirFor(root), "runs");
  await chmod(runsDir, 0o000);
  let notices: string[] = [];
  try {
    notices = await sweep(root, join(await tempDir(t), "children.json"));
  } finally {
    await chmod(runsDir, 0o700);
  }

  assert.equal(existsSync(path), true, "the worktree is kept");
  assert.equal(
    await hasBranch(root, `kapelle/${RUN_ID}/a`),
    true,
    "the branch is kept",
  );
  assert.equal(await readFile(recordPath, "utf8"), before, "record unchanged");
  assert.ok(
    notices.some((notice) =>
      notice.includes("skipping reap and orphan cleanup"),
    ),
  );
  assert.equal(
    notices.some((notice) => notice.includes(`reaped run ${RUN_ID}`)),
    false,
  );
  assert.equal(
    notices.some((notice) => notice.includes("removed orphan worktree")),
    false,
  );
});

test("an orphan on a detached HEAD is kept, however clean it looks", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  // What `kill -9` can interrupt: the agent moved off the task branch and
  // committed, so the work is on no ref and the clean tree below is a lie.
  await git(path, "checkout", "--detach");
  await writeFile(join(path, "work.txt"), "kept\n");
  await git(path, "add", "-A");
  await git(
    path,
    "-c",
    "user.email=t@e",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "w",
  );

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(path), true, "the checkout carries the only copy");
  assert.ok(notices.some((notice) => notice.includes("detached HEAD")));
});

test("a dirty orphan is kept and noticed", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  await writeFile(join(path, "partial.txt"), "work\n");

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(join(path, "partial.txt")), true);
  assert.ok(notices.some((notice) => notice.includes("uncommitted changes")));
});

// --- the previous daemon's children -----------------------------------------

test("a recorded harness still matching its identity is killed", async (t) => {
  const child = sleeper(t);
  const startedAt = await waitForIdentity(child.pid as number);
  const childrenFile = join(await tempDir(t), "children.json");
  await writeFile(
    childrenFile,
    JSON.stringify({
      pid: process.pid,
      children: [{ pid: child.pid, runId: RUN_ID, taskId: "a", startedAt }],
    }),
  );

  const notices = await sweep([], childrenFile);

  assert.equal(await gone(child.pid as number), true);
  assert.equal(existsSync(childrenFile), false);
  assert.ok(
    notices.some((notice) =>
      notice.includes(`killed harness pid ${child.pid}`),
    ),
  );
});

test("processIdentity is normalized across TZ changes", async (t) => {
  const child = sleeper(t);
  const pid = child.pid as number;
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utc = await waitForIdentity(pid);
    process.env.TZ = "America/New_York";
    assert.equal(await processIdentity(pid), utc);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test("a SIGTERM-ignoring harness is escalated to SIGKILL", async (t) => {
  const child = await sigtermIgnorer(t);
  const pid = child.pid as number;
  const startedAt = await waitForIdentity(pid);
  const childrenFile = join(await tempDir(t), "children.json");
  await writeFile(
    childrenFile,
    JSON.stringify({
      pid: process.pid,
      children: [{ pid, runId: RUN_ID, taskId: "a", startedAt }],
    }),
  );

  const notices = await sweep([], childrenFile);

  assert.equal(await gone(pid), true);
  assert.equal(existsSync(childrenFile), false);
  assert.ok(
    notices.some((notice) => notice.includes(`killed harness pid ${pid}`)),
  );
});

test("a pid that no longer matches its identity is not signalled", async (t) => {
  const child = sleeper(t);
  const startedAt = await waitForIdentity(child.pid as number);
  const childrenFile = join(await tempDir(t), "children.json");
  await writeFile(
    childrenFile,
    JSON.stringify({
      pid: process.pid,
      children: [
        {
          pid: child.pid,
          runId: RUN_ID,
          taskId: "a",
          startedAt: `${startedAt} (recycled)`,
        },
      ],
    }),
  );

  const notices = await sweep([], childrenFile);

  assert.equal(isAlive(child.pid as number), true);
  assert.equal(
    notices.some((notice) => notice.includes("killed")),
    false,
  );
  assert.equal(existsSync(childrenFile), false);
});

test("a pid recorded without an identity is left alone, but named", async (t) => {
  const child = sleeper(t);
  const childrenFile = join(await tempDir(t), "children.json");
  // What `daemon.ts` writes when `ps` could not answer at spawn: `startedAt`
  // is absent, so nothing here can tell this pid from a reused one.
  await writeFile(
    childrenFile,
    JSON.stringify({
      pid: process.pid,
      children: [{ pid: child.pid, runId: RUN_ID, taskId: "a" }],
    }),
  );

  const notices = await sweep([], childrenFile);

  assert.equal(isAlive(child.pid as number), true);
  assert.ok(
    notices.some(
      (notice) =>
        notice.includes(`${child.pid}`) && notice.includes("no start time"),
    ),
    "the file is deleted next, so the notice is the last trace of this pid",
  );
});

test("a malformed run or task id is labelled unknown, not stringified", async (t) => {
  const child = sleeper(t);
  const childrenFile = join(await tempDir(t), "children.json");
  await writeFile(
    childrenFile,
    JSON.stringify({
      pid: process.pid,
      children: [{ pid: child.pid, runId: { nested: true }, taskId: 42 }],
    }),
  );

  const notices = await sweep([], childrenFile);

  assert.ok(
    notices.some((notice) =>
      notice.includes(`harness pid ${child.pid} (run unknown, task unknown)`),
    ),
    "a malformed id must not stringify into the notice",
  );
});

test("malformed children.json cannot throw and is removed", async (t) => {
  const childrenFile = join(await tempDir(t), "children.json");
  await writeFile(childrenFile, "not json");

  const notices = await sweep([], childrenFile);

  assert.ok(notices.some((notice) => notice.includes("cannot read")));
  assert.equal(existsSync(childrenFile), false);
});

test("malformed children entries cannot throw and are removed", async (t) => {
  const childrenFile = join(await tempDir(t), "children.json");
  await writeFile(
    childrenFile,
    JSON.stringify({ children: [null, 42, { pid: "x" }] }),
  );

  await sweep([], childrenFile);

  assert.equal(existsSync(childrenFile), false);
});

test("a dead pid with a recorded identity is ignored silently", async (t) => {
  const child = sleeper(t);
  const pid = child.pid as number;
  const startedAt = await waitForIdentity(pid);
  const exited = new Promise<void>((ok) => child.once("exit", () => ok()));
  child.kill("SIGKILL");
  await exited;
  const childrenFile = join(await tempDir(t), "children.json");
  await writeFile(
    childrenFile,
    JSON.stringify({
      pid: process.pid,
      children: [{ pid, runId: RUN_ID, taskId: "a", startedAt }],
    }),
  );

  const notices = await sweep([], childrenFile);

  assert.deepEqual(notices, []);
  assert.equal(existsSync(childrenFile), false);
});

test("non-positive and non-integer pids are ignored", async (t) => {
  const childrenFile = join(await tempDir(t), "children.json");
  await writeFile(
    childrenFile,
    JSON.stringify({
      children: [
        { pid: 0, runId: RUN_ID, taskId: "a" },
        {
          pid: -1,
          runId: RUN_ID,
          taskId: "b",
          startedAt: "2026-09-01T00:00:00.000Z",
        },
        { pid: 1.5, runId: RUN_ID, taskId: "c" },
      ],
    }),
  );

  const notices = await sweep([], childrenFile);

  for (const notice of notices) {
    assert.equal(/alive|no start time|killed/.test(notice), false, notice);
  }
  assert.equal(existsSync(childrenFile), false);
});

// --- git refusing to answer --------------------------------------------------

test("worktrees that cannot be listed stop the reap, not just the list", async (t) => {
  // A root that is not a repository at all: `git worktree prune` fails there,
  // which stands in for any git that will not answer.
  const root = await tempDir(t);
  await mkdir(join(stateDirFor(root), "wt", RUN_ID, "a"), { recursive: true });
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(
    existsSync(dir),
    true,
    "an unanswered list is not an empty one: reaping here would delete " +
      "checkouts behind git's back",
  );
  assert.ok(notices.some((n) => n.includes("cannot reconcile worktrees")));
  assert.ok(notices.some((n) => n.includes("skipping reap")));
});

test("a failed worktree removal keeps the run and its checkout", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const childrenFile = join(await tempDir(t), "children.json");
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });
  // A locked worktree makes a single `git worktree remove --force` fail, the
  // shape a checkout the sweep cannot remove leaves behind.
  await git(root, "worktree", "lock", path);
  try {
    const notices = await sweep(root, childrenFile);

    assert.ok(
      notices.some((notice) => notice.includes("cannot remove worktree")),
    );
    assert.ok(
      notices.some((notice) => notice.includes("kept for the next sweep")),
    );
    assert.equal(existsSync(join(dir, "run.json")), true);
    assert.equal(existsSync(path), true);
    assert.equal(await hasBranch(root, `kapelle/${RUN_ID}/a`), true);
  } finally {
    try {
      await git(root, "worktree", "unlock", path);
    } catch {
      // The temp directory cleanup can still remove an unlocked-or-gone tree.
    }
  }
});

test("one unwritable record does not stop the rest of the repository", async (t) => {
  const root = await gitRepo(t);
  const kept = await addWorktree(root, "a", RUN_ID);
  const orphan = await addWorktree(root, "a", ORPHAN_ID);
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "running",
    // Old enough that the `startedAt` fallback would reap this run if a
    // non-terminal record were reapable at all.
    startedAt: "2026-07-01T00:00:00.000Z",
    tasks: [{ id: "a", status: "running" }],
  });
  // Readable, not writable: `markCrashed` cannot land its temp file here.
  await chmod(dir, 0o500);

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  // Restored here rather than in an `after` hook: the temp directory's own
  // cleanup is registered first and so runs first, and it cannot unlink a
  // record out of a directory it may not write.
  await chmod(dir, 0o700);

  assert.equal((await readRun(dir)).status, "running", "retried next boot");
  assert.ok(notices.some((notice) => notice.includes("cannot mark run")));
  assert.ok(
    notices.some((notice) => notice.includes("still reads running")),
    "retention must not date a run that is not terminal",
  );
  assert.equal(
    existsSync(kept),
    true,
    "a running record's worktree is not reapable",
  );
  assert.equal(existsSync(orphan), false, "the orphan pass still ran");
});

test("a reap that cannot finish does not stop the rest of the repository", async (t) => {
  const root = await gitRepo(t);
  const orphan = await addWorktree(root, "a", ORPHAN_ID);
  const dir = await writeRun(root, {
    runId: RUN_ID,
    root,
    cwd: root,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed" }],
  });
  // Past retention, and its run directory cannot be removed: `rmSync` throws
  // after the worktree pass, the shape the per-record catch exists for.
  await chmod(dir, 0o500);

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  await chmod(dir, 0o700);

  assert.ok(notices.some((notice) => notice.includes("cannot reap run")));
  assert.equal(existsSync(orphan), false, "later cleanup still ran");
});

// --- the repository list is the boundary ------------------------------------

test("only repositories in the list are swept", async (t) => {
  const swept = await gitRepo(t);
  const left = await gitRepo(t);
  const sweptPath = await addWorktree(swept, "a");
  const leftPath = await addWorktree(left, "a");
  const record = {
    runId: RUN_ID,
    cwd: "",
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  };
  const sweptDir = await writeRun(swept, { ...record, root: swept });
  const leftDir = await writeRun(left, { ...record, root: left });

  await sweep(swept, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(sweptPath), false);
  assert.equal(existsSync(sweptDir), false);
  assert.equal(existsSync(leftPath), true);
  assert.equal(existsSync(leftDir), true);
  assert.equal(await hasBranch(left, `kapelle/${RUN_ID}/a`), true);
});

test("one sweep reconciles every repository in the list", async (t) => {
  const first = await gitRepo(t);
  const second = await gitRepo(t);
  const firstPath = await addWorktree(first, "a", RUN_ID);
  const secondPath = await addWorktree(second, "a", ORPHAN_ID);
  const firstDir = await writeRun(first, {
    runId: RUN_ID,
    root: first,
    cwd: first,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });
  const secondDir = await writeRun(
    second,
    {
      runId: ORPHAN_ID,
      root: second,
      cwd: second,
      status: "failed",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:10:00.000Z",
      tasks: [{ id: "a", status: "failed", branch: `kapelle/${ORPHAN_ID}/a` }],
    },
    ORPHAN_ID,
  );

  const notices = await sweep(
    [first, second],
    join(await tempDir(t), "children.json"),
  );

  assert.equal(existsSync(firstPath), false);
  assert.equal(existsSync(secondPath), false);
  assert.equal(existsSync(firstDir), false);
  assert.equal(existsSync(secondDir), false);
  assert.equal(await hasBranch(first, `kapelle/${RUN_ID}/a`), false);
  assert.equal(await hasBranch(second, `kapelle/${ORPHAN_ID}/a`), false);
  assert.ok(notices.includes(`reaped run ${RUN_ID}`));
  assert.ok(notices.includes(`reaped run ${ORPHAN_ID}`));
});

test("a broken repository does not stop a later repository's sweep", async (t) => {
  // Not a repository at all: `git worktree prune` fails here, so the record
  // cannot be reaped, but the loop must still reach the second root.
  const bad = await tempDir(t);
  await mkdir(join(stateDirFor(bad), "wt", RUN_ID, "a"), {
    recursive: true,
  });
  const badDir = await writeRun(bad, {
    runId: RUN_ID,
    root: bad,
    cwd: bad,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });
  const good = await gitRepo(t);
  const goodPath = await addWorktree(good, "a");
  const goodDir = await writeRun(good, {
    runId: RUN_ID,
    root: good,
    cwd: good,
    status: "failed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:10:00.000Z",
    tasks: [{ id: "a", status: "failed", branch: `kapelle/${RUN_ID}/a` }],
  });

  const notices = await sweep(
    [bad, good],
    join(await tempDir(t), "children.json"),
  );

  assert.equal(existsSync(join(badDir, "run.json")), true);
  assert.ok(
    notices.some((notice) => notice.includes("cannot reconcile worktrees")),
  );
  assert.ok(notices.some((notice) => notice.includes("skipping reap")));
  assert.equal(existsSync(goodPath), false);
  assert.equal(existsSync(goodDir), false);
  assert.equal(await hasBranch(good, `kapelle/${RUN_ID}/a`), false);
  assert.ok(notices.some((notice) => notice.includes(`reaped run ${RUN_ID}`)));
});

// --- stranded workspaces (#129) ----------------------------------------------

// Since #129 a run's state lives at `stateDirFor(root)`, keyed on the
// repository's path. Move or rename the repository and that key changes, so
// the old workspace is stranded — with, very possibly, the only copy of a
// failed task's work in it. The sweep may not guess: a path that is gone reads
// exactly the same whether the operator renamed the repository or deleted it,
// and those want opposite answers.

/** A repository, a workspace full of state, and then the repository gone. */
async function stranded(t: TestContext): Promise<{
  root: string;
  workspace: string;
}> {
  // Canonicalized: `repos.json` entries are realpaths (`daemon.ts` realpaths
  // at `POST /repos`), and `stateDirFor` keys on `realpathSync(root)`. Passing
  // `gitRepo`'s unresolved spelling would disagree with that key whenever the
  // tmpdir chain contains a symlink (macOS: `tmpdir()` is `/var`, realpath is
  // `/private/var`), and `sweepStranded` would find nothing to strand.
  const root = realpathSync(await gitRepo(t));
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);
  await worktrees.acquire("a");
  const workspace = stateDirFor(root);
  await rm(root, { recursive: true, force: true });
  return { root, workspace };
}

test("a repository that is gone strands its workspace, and nothing is deleted", async (t) => {
  const { root, workspace } = await stranded(t);

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.ok(existsSync(workspace), "the workspace survived the sweep");
  const stranded1 = notices.find((n) => n.includes(workspace));
  assert.ok(
    stranded1,
    `no notice named ${workspace} in ${notices.join(" | ")}`,
  );
  assert.match(stranded1, new RegExp(root));
});

test("the stranded notice names an exact command for each ending", async (t) => {
  // The operator has to be able to act without reading the source: one
  // command to re-point a renamed repository, one to drop a deleted one.
  // The move is `kapelle workspace move`, never a printed `mv` — `mv` alone
  // leaves every checkout `prunable` and the next prune deletes the work.
  const { root, workspace } = await stranded(t);

  const notices = await sweep(root, join(await tempDir(t), "children.json"));
  const text = notices.find((n) => n.includes(workspace)) ?? "";

  assert.match(text, new RegExp(`kapelle workspace move ${root} <new-path>`));
  assert.match(text, new RegExp(`rm -rf ${workspace}`));
  assert.match(text, /nothing will delete it/);
});

test("an asker that says yes removes the stranded workspace", async (t) => {
  const { root, workspace } = await stranded(t);
  const asked: string[] = [];

  await sweepBoot({
    repos: [root],
    childrenFile: join(await tempDir(t), "children.json"),
    now: NOW,
    onNotice: () => {},
    ask: async (question) => {
      asked.push(question);
      return true;
    },
  });

  assert.equal(asked.length, 1, `asked ${asked.length} times`);
  assert.match(String(asked[0]), new RegExp(workspace));
  assert.equal(existsSync(workspace), false, "yes means remove it");
});

test("an asker that says no keeps the stranded workspace", async (t) => {
  const { root, workspace } = await stranded(t);

  await sweepBoot({
    repos: [root],
    childrenFile: join(await tempDir(t), "children.json"),
    now: NOW,
    onNotice: () => {},
    ask: async () => false,
  });

  assert.ok(existsSync(workspace), "no means keep it");
});

test("a repository that is still there is never asked about", async (t) => {
  const root = await gitRepo(t);
  const asked: string[] = [];

  await sweepBoot({
    repos: [root],
    childrenFile: join(await tempDir(t), "children.json"),
    now: NOW,
    onNotice: () => {},
    ask: async (q) => {
      asked.push(q);
      return true;
    },
  });

  assert.deepEqual(asked, []);
});

test("a repository gone with no workspace to strand says nothing", async (t) => {
  // Removing a repository that never ran leaves nothing behind, so there is
  // nothing to report and nothing to ask.
  const root = await gitRepo(t);
  await rm(root, { recursive: true, force: true });

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.deepEqual(notices, []);
});

// --- rooms (M6-7a) ---------------------------------------------------------

/** A room's record, as a daemon writes it, with one participant per
 *  `status`, each in a checkout of its own. */
async function writeRoom(
  root: string,
  roomStatus: RoomRecord["status"],
  statuses: RoomRecord["participants"][number]["status"][],
): Promise<{ id: string; file: string; worktrees: string[] }> {
  const id = newRoomId();
  const worktrees: string[] = [];
  const participants: RoomRecord["participants"] = [];
  for (const [i, status] of statuses.entries()) {
    const pid = `p${i}`;
    const worktree = await addWorktree(root, pid, id);
    worktrees.push(worktree);
    participants.push({
      id: pid,
      name: pid,
      cmd: "node mock-agent.mjs",
      harness: "mock-agent",
      mode: "auto",
      settings: { allowReadOutsideRoot: false },
      worktree,
      branch: `kapelle/${id}/${pid}`,
      baseSha: await git(root, "rev-parse", "HEAD"),
      sessionId: `sess_${i}`,
      status,
      notices: [],
    });
  }
  const file = roomFile(root, id);
  await mkdir(join(file, ".."), { recursive: true });
  writeRoomRecord(file, {
    id,
    cwd: root,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    status: roomStatus,
    notices: [],
    participants,
  });
  return { id, file, worktrees };
}

test("a room left active is paused, its busy participant killed, and its log untouched", async (t) => {
  const root = await gitRepo(t);
  const { file, worktrees } = await writeRoom(root, "active", [
    "busy",
    "idle",
    "exited",
  ]);
  const log = join(file, "..", "events.jsonl");
  await writeFile(log, '{"seq":1}\n');

  await sweep(root, join(await tempDir(t), "children.json"));

  const record = readRoomRecord(file);
  assert.equal(record.status, "paused");
  assert.deepEqual(
    record.participants.map((p) => p.status),
    ["killed", "paused", "exited"],
  );
  assert.equal(await readFile(log, "utf8"), '{"seq":1}\n', "no line added");
  for (const worktree of worktrees) {
    assert.equal(existsSync(worktree), true, "a room's checkout is no orphan");
  }
});

test("a killed participant's stale index.lock gets a notice, and the file stays", async (t) => {
  const root = await gitRepo(t);
  const { file, worktrees } = await writeRoom(root, "active", ["busy", "idle"]);
  const lock = (wt: string) =>
    git(wt, "rev-parse", "--absolute-git-dir").then((d) =>
      join(d, "index.lock"),
    );
  const killedLock = await lock(worktrees[0] as string);
  const idleLock = await lock(worktrees[1] as string);
  await writeFile(killedLock, "");
  await writeFile(idleLock, "");

  await sweep(root, join(await tempDir(t), "children.json"));

  const [killed, idle] = readRoomRecord(file).participants;
  assert.equal(killed?.notices.length, 1);
  assert.match(killed?.notices[0]?.text ?? "", /index\.lock/);
  assert.ok(killed?.notices[0]?.text.includes(killedLock));
  assert.equal(existsSync(killedLock), true, "the sweep deletes nothing");
  assert.deepEqual(idle?.notices, [], "only a killed participant is checked");
});

test("a paused or dismissed room is left as it is, and so are its checkouts", async (t) => {
  const root = await gitRepo(t);
  const paused = await writeRoom(root, "paused", ["paused", "killed"]);
  const dismissed = await writeRoom(root, "dismissed", ["dismissed"]);
  const before = [paused, dismissed].map((r) => readRoomRecord(r.file));

  await sweep(root, join(await tempDir(t), "children.json"));

  assert.deepEqual(
    [paused, dismissed].map((r) => readRoomRecord(r.file)),
    before,
  );
  for (const wt of [...paused.worktrees, ...dismissed.worktrees]) {
    assert.equal(existsSync(wt), true);
  }
});

test("a room checkout with no record is still an orphan", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "p0", newRoomId());

  const notices = await sweep(root, join(await tempDir(t), "children.json"));

  assert.equal(existsSync(path), false);
  assert.ok(notices.some((n) => n.includes("removed orphan worktree")));
});

test("a participant a shutdown killed gets the index.lock notice once", async (t) => {
  const root = await gitRepo(t);
  const { file, worktrees } = await writeRoom(root, "paused", ["killed"]);
  const lock = join(
    await git(worktrees[0] as string, "rev-parse", "--absolute-git-dir"),
    "index.lock",
  );
  await writeFile(lock, "");

  await sweep(root, join(await tempDir(t), "children.json"));
  await sweep(root, join(await tempDir(t), "children.json"));

  const [killed] = readRoomRecord(file).participants;
  assert.equal(killed?.notices.length, 1, "one notice, after two boots");
  assert.ok(killed?.notices[0]?.text.includes(lock));
  assert.equal(existsSync(lock), true);
});
