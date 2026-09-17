/**
 * Sweep tests — story M2-5, issue #35.
 *
 * Against real git, like `core/tests/worktree.test.ts`: every claim here is a
 * claim about what git does with worktrees and refs. The clock is injected,
 * so the retention boundary is a value and not a wait.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { gitRepo, tempDir } from "../../integration/helpers.ts";
import { DEFAULT_RETENTION_MS, processIdentity, sweepBoot } from "../sweep.ts";
import { openWorktrees } from "../worktree.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

const RUN_ID = "20260906-120000-abcd";
/** A second run id, for a worktree that must survive the first run's pass. */
const ORPHAN_ID = "20260906-120001-efgh";
const NOW = Date.parse("2026-09-17T00:00:00.000Z");

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
  const dir = join(root, ".kapelle", "runs", id);
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

/** A checkout under `.kapelle/wt/<runId>/<taskId>`, the shape a run leaves. */
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

test("a crashed record is rewritten: running tasks failed, queued left", async (t) => {
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

  await sweep(root, join(await tempDir(t), "children.json"));

  const record = await readRun(dir);
  assert.equal(record.status, "failed");
  assert.equal(record.endedAt, new Date(NOW).toISOString());
  assert.deepEqual(
    record.tasks.map((task) => [task.id, task.status]),
    [
      ["a", "failed"],
      ["b", "queued"],
    ],
  );
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

test("an unreadable record counts as absent", async (t) => {
  const root = await gitRepo(t);
  const path = await addWorktree(root, "a");
  const dir = join(root, ".kapelle", "runs", RUN_ID);
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
  const runsDir = join(root, ".kapelle", "runs");
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

// --- git refusing to answer --------------------------------------------------

test("worktrees that cannot be listed stop the reap, not just the list", async (t) => {
  // A root that is not a repository at all: `git worktree prune` fails there,
  // which stands in for any git that will not answer.
  const root = await tempDir(t);
  await mkdir(join(root, ".kapelle", "wt", RUN_ID, "a"), { recursive: true });
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
