/**
 * Worktree tests — story M1b-3, issue #19.
 *
 * Against a **real** `git init`, not a mock: every claim this module makes is
 * a claim about what git does — that `worktree remove` refuses while ignored
 * files sit there, that `check-ignore` never reports a tracked path, that a
 * branch outlives the worktree it was checked out in. A fake git would agree
 * with whatever this module already believes, which is the one thing a test
 * here must not do. `core/tests/ids.test.ts:69` takes the same line with
 * `check-ref-format`.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { isolateStateHome } from "../../integration/helpers.ts";
import { readProjectConfig, readProjectLinkPaths } from "../config.ts";
import { createEventBus } from "../events.ts";
import {
  RELEASES,
  runRun,
  type TaskExecutor,
  type TaskStatus,
} from "../run.ts";
import { validateRun } from "../runfile.ts";
import { stateDirFor } from "../runtime.ts";
import {
  changedPaths,
  checkoutIdentity,
  LinkPathError,
  moveWorkspace,
  openWorktrees,
  serializeWorktreeMutation,
  validateWorktreeLinks,
  type Worktrees,
} from "../worktree.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

const RUN_ID = "20260906-120000-abcd";

isolateStateHome();

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A repository with one commit and **no `.gitignore` at all** — since #129
 *  that is the shape a run must accept, so it is the shape every test here
 *  starts from. */
async function repo(t: TestContext): Promise<string> {
  const dir = await tempDir(t);
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@example.invalid");
  await git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "README.md"), "first\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "first");
  return dir;
}

const branchOf = (taskId: string) => `kapelle/${RUN_ID}/${taskId}`;

/** Where a task's checkout lands since #129 — outside the repository, under
 *  the state directory `isolateStateHome` has pointed somewhere throwaway. */
const wtOf = (root: string, ...rest: string[]) =>
  join(stateDirFor(root), "wt", RUN_ID, ...rest);

async function hasBranch(root: string, taskId: string): Promise<boolean> {
  try {
    await git(root, "rev-parse", "--verify", `refs/heads/${branchOf(taskId)}`);
    return true;
  } catch {
    return false;
  }
}

/** Acquire, put a file in the worktree, release with `status`. The shape every
 *  retention test needs: a worktree that is *not* untouched, so the rollback
 *  rule cannot be what removed it. */
async function workThenRelease(
  worktrees: Worktrees,
  taskId: string,
  status: TaskStatus,
): Promise<string> {
  const path = await worktrees.acquire(taskId);
  await writeFile(join(path, "made.txt"), "work\n");
  await worktrees.release(taskId, RELEASES.has(status) ? "commit" : "keep");
  return path;
}

// --- preflight ---------------------------------------------------------------

test("a cwd that is not a repository falls back with a notice", async (t) => {
  const dir = await tempDir(t);
  const { worktrees, notice } = await openWorktrees(dir, RUN_ID);

  assert.equal(worktrees, null);
  assert.match(String(notice), /not a git repository/);
});

test("a repository with no commits falls back with a notice", async (t) => {
  const dir = await tempDir(t);
  await git(dir, "init", "-b", "main");

  const { worktrees, notice } = await openWorktrees(dir, RUN_ID);

  assert.equal(worktrees, null);
  assert.match(String(notice), /no commits yet/);
});

test("a repository that never heard of .kapelle runs, and is left clean (#129)", async (t) => {
  // The whole of the toll #129 removes. `repo()` writes no `.gitignore` at
  // all, which before this issue was two refusals and a commit before the
  // first run could start.
  const root = await repo(t);

  const {
    worktrees,
    notice,
    root: stateRoot,
  } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);
  assert.equal(notice, undefined);
  await workThenRelease(worktrees, "a", "done");

  assert.equal(await git(root, "status", "--porcelain", "-uall"), "");
  assert.equal(existsSync(join(root, ".kapelle")), false);
  assert.ok(
    !stateRoot.startsWith(`${realpathSync(root)}/`),
    `${stateRoot} should not be inside ${root}`,
  );
});

test("a tracked .kapelle/ is fine — config.json is meant to be committed (#129)", async (t) => {
  const root = await repo(t);
  await run("mkdir", ["-p", join(root, ".kapelle")]);
  await writeFile(join(root, ".kapelle", "config.json"), '{"ttlMs":1000}\n');
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "project config");

  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);
});

test("a dirty working tree is an advisory notice, not a refusal (#129)", async (t) => {
  const root = await repo(t);
  await writeFile(join(root, "README.md"), "edited\n");
  await writeFile(join(root, "untracked.txt"), "new\n");
  const head = await git(root, "rev-parse", "--short", "HEAD");

  const { worktrees, advisory } = await openWorktrees(root, RUN_ID);

  assert.ok(worktrees, "a dirty tree no longer refuses the run");
  // The count and the base, not the file list: the operator working alongside
  // a run has a long list and does not need it read back.
  assert.match(String(advisory), /2 uncommitted/);
  assert.match(String(advisory), new RegExp(head));
  assert.match(String(advisory), /will not reach any task/);
});

test("a clean working tree gets no advisory", async (t) => {
  const { advisory } = await openWorktrees(await repo(t), RUN_ID);
  assert.equal(advisory, undefined);
});

test("the shared-cwd fallback gets no dirty advisory (#129)", async (t) => {
  // There the tasks run *in* the dirty tree, so "will not reach any task"
  // would be false — the one place the notice must not fire.
  const dir = await tempDir(t);
  await git(dir, "init", "-b", "main");
  await writeFile(join(dir, "wip.txt"), "uncommitted\n");

  const { worktrees, notice, advisory } = await openWorktrees(dir, RUN_ID);

  assert.equal(worktrees, null);
  assert.match(String(notice), /no commits yet/);
  assert.equal(advisory, undefined);
});

// --- acquire -----------------------------------------------------------------

test("acquire checks out the branch at the base ref's commit", async (t) => {
  const root = await repo(t);
  const head = await git(root, "rev-parse", "HEAD");
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const path = await worktrees.acquire("plan");

  assert.equal(path, wtOf(root, "plan"));
  assert.equal(await git(path, "rev-parse", "HEAD"), head);
  assert.equal(
    await git(path, "rev-parse", "--abbrev-ref", "HEAD"),
    branchOf("plan"),
  );
  assert.equal(worktrees.info("plan")?.baseRef, "refs/heads/main");
});

test("acquire keeps full refs and pins detached or relative bases", async (t) => {
  const root = await repo(t);
  const first = await git(root, "rev-parse", "HEAD");
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  await worktrees.acquire("explicit", "main");
  assert.equal(worktrees.info("explicit")?.baseRef, "refs/heads/main");
  await worktrees.acquire("pinned", first);
  assert.equal(worktrees.info("pinned")?.baseRef, first);
  await writeFile(join(root, "README.md"), "second\n");
  await git(root, "commit", "-qam", "second");
  const second = await git(root, "rev-parse", "HEAD");
  await worktrees.acquire("relative", "HEAD~1");
  assert.equal(worktrees.info("relative")?.baseRef, first);
  assert.equal(worktrees.info("relative")?.baseSha, first);
  await git(root, "checkout", "--detach", "HEAD");
  await worktrees.acquire("detached");
  assert.equal(worktrees.info("detached")?.baseRef, second);
});

test("a base ref that does not resolve throws naming the ref", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  await assert.rejects(
    worktrees.acquire("plan", "no-such-ref"),
    (err: Error) => {
      assert.match(err.message, /"no-such-ref"/);
      return true;
    },
  );
  assert.equal(await hasBranch(root, "plan"), false);
});

test("two tasks branch off the same commit and do not collide", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const a = await worktrees.acquire("plan");
  const b = await worktrees.acquire("impl");

  assert.notEqual(a, b);
  assert.equal(
    await git(a, "rev-parse", "HEAD"),
    await git(b, "rev-parse", "HEAD"),
  );
});

test("worktree mutations on one repository never overlap (#203)", async (t) => {
  // The real race -- one lost `git worktree add` in about 4,200 under
  // concurrency -- is far too rare to trigger on demand, so the seam holds
  // every mutation for a beat. Without the per-repository queue the seven
  // acquires, and then the seven removes, would all be inside the hold at
  // once and `peak` would be greater than one.
  const root = await repo(t);
  let live = 0;
  let peak = 0;
  const hold = async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 50));
    live -= 1;
  };
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    onWorktreeMutation: hold,
  });
  assert.ok(worktrees);
  const ids = ["a", "b", "c", "d", "e", "f", "g"];

  await Promise.all(ids.map((id) => worktrees.acquire(id)));
  assert.equal(peak, 1, "two worktree adds ran at once");

  // The removes are the other half of the race: an `add` can read a
  // `commondir` a concurrent `remove` is deleting.
  live = 0;
  peak = 0;
  await Promise.all(ids.map((id) => worktrees.release(id, "keep")));
  assert.equal(peak, 1, "two worktree removals ran at once");
});

test("an add and a remove on one repository never overlap (#203)", async (t) => {
  const root = await repo(t);
  let live = 0;
  let peak = 0;
  let calls = 0;
  let armed = false;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const hold = async () => {
    calls += 1;
    live += 1;
    peak = Math.max(peak, live);
    // Only the release's remove is held open, so the acquire behind it has a
    // real window to overlap if the two do not share the queue.
    if (armed) {
      armed = false;
      entered.resolve();
      await gate.promise;
    }
    live -= 1;
  };
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    onWorktreeMutation: hold,
  });
  assert.ok(worktrees);
  await worktrees.acquire("kept");
  live = 0;
  peak = 0;
  armed = true;

  const releasing = worktrees.release("kept", "keep");
  // A release that bypasses the mutation seam never calls `hold`; fail with
  // a reason instead of hanging on a gate that will never be opened.
  await Promise.race([
    entered.promise,
    new Promise<never>((_, reject) => {
      const fail = setTimeout(
        () => reject(new Error("release never entered the mutation queue")),
        2_000,
      );
      fail.unref();
    }),
  ]);

  const acquiring = worktrees.acquire("next");
  // Give a split queue time to enter while the release still holds.
  await new Promise((resolve) => setTimeout(resolve, 50));
  gate.resolve();
  await Promise.all([releasing, acquiring]);

  assert.equal(calls, 4, "release did not go through the mutation queue");
  assert.equal(peak, 1, "an add and a remove ran at once");
});

test("two checkouts of one repository share the mutation queue (#203)", async (t) => {
  // A run started inside a linked worktree writes the same `.git/worktrees/`
  // as one started in the main checkout, so the queue key is the common git
  // dir, not the checkout root.
  const root = await repo(t);
  const linked = join(await tempDir(t), "linked");
  await git(root, "worktree", "add", "--detach", linked, "HEAD");
  let live = 0;
  let peak = 0;
  const hold = async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 50));
    live -= 1;
  };
  const a = await openWorktrees(root, RUN_ID, { onWorktreeMutation: hold });
  const b = await openWorktrees(linked, RUN_ID, { onWorktreeMutation: hold });
  assert.ok(a.worktrees);
  assert.ok(b.worktrees);
  await Promise.all([
    a.worktrees.acquire("main"),
    b.worktrees.acquire("linked"),
  ]);
  assert.equal(peak, 1, "two checkouts of one repository raced");
});

test("symlinked spellings of one repository share the mutation queue (#203)", async (t) => {
  // A `.git` symlink makes the main checkout report `root/.git` while a
  // linked worktree reports the symlink's target. Without `realpath` those
  // are two queue keys for one admin directory, the split #85 measured
  // elsewhere.
  const root = await repo(t);
  const real = join(await tempDir(t), "gitdir");
  await run("mv", [join(root, ".git"), real]);
  await symlink(real, join(root, ".git"));
  const linked = join(await tempDir(t), "linked");
  await git(root, "worktree", "add", "--detach", linked, "HEAD");

  let live = 0;
  let peak = 0;
  const hold = async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 50));
    live -= 1;
  };
  const a = await openWorktrees(root, RUN_ID, { onWorktreeMutation: hold });
  const b = await openWorktrees(linked, RUN_ID, { onWorktreeMutation: hold });
  assert.ok(a.worktrees);
  assert.ok(b.worktrees);
  await Promise.all([
    a.worktrees.acquire("main"),
    b.worktrees.acquire("linked"),
  ]);
  assert.equal(peak, 1, "two spellings of one repository raced");
});

test("a failed mutation does not wedge later ones for the same repository", async () => {
  const key = `${RUN_ID}:recovery`;
  // Both are queued before either settles: `failed` first, then `after`
  // behind it. A regression that drops the rejection handler leaves `after`
  // rejected without ever running its work.
  const [failed, after] = await Promise.allSettled([
    serializeWorktreeMutation(key, async () => {
      throw new Error("git failed");
    }),
    serializeWorktreeMutation(key, async () => "ran"),
  ]);
  assert.equal(failed.status, "rejected");
  assert.equal(
    after.status,
    "fulfilled",
    "the failed mutation wedged the next one",
  );
  if (after.status === "fulfilled") assert.equal(after.value, "ran");
});

// --- release: the full status union ------------------------------------------

test("every TaskStatus releases or keeps the worktree", async (t) => {
  // `warned` (M1b-4) and `timed_out` (M1c-1) have no producer yet, and
  // `skipped` (M3-1) has none either. They are driven directly here for the
  // reason M1b-2 gave for shipping the whole severity ordering early: the
  // union is the contract, so teardown agrees with it before the producers
  // land rather than being edited three more times.
  const table: [TaskStatus, boolean][] = [
    ["done", false],
    ["warned", false],
    ["cancelled", true],
    ["skipped", true],
    ["timed_out", true],
    ["failed", true],
  ];

  for (const [status, kept] of table) {
    const root = await repo(t);
    const { worktrees } = await openWorktrees(root, RUN_ID);
    assert.ok(worktrees);

    const path = await workThenRelease(worktrees, status, status);

    assert.equal(existsSync(path), kept, `${status}: worktree kept?`);
    // The branch always survives, whichever way retention went.
    assert.equal(await hasBranch(root, status), true, `${status}: branch`);
  }
});

test("released work is committed on the branch and reachable after removal", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const path = await workThenRelease(worktrees, "plan", "done");

  assert.equal(existsSync(path), false);
  // Read through the branch, from the main worktree: the checkout that held
  // the file is gone, so this is the only place the work can still be.
  const listed = await git(root, "ls-tree", "--name-only", branchOf("plan"));
  assert.match(listed, /made\.txt/);
});

test("a kept worktree keeps its work uncommitted, for reading", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const path = await workThenRelease(worktrees, "plan", "failed");

  assert.match(await git(path, "status", "--porcelain"), /made\.txt/);
});

test("a task that changed nothing rolls back worktree and branch", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  // The spawn-failure shape: the worktree exists, the harness never wrote.
  const path = await worktrees.acquire("plan");
  await worktrees.release("plan", "keep");

  assert.equal(existsSync(path), false);
  assert.equal(await hasBranch(root, "plan"), false);
});

for (const status of ["done", "warned"] as const) {
  test(`a ${status} task with an empty diff leaves the branch at its base`, async (t) => {
    const root = await repo(t);
    const head = await git(root, "rev-parse", "HEAD");
    const { worktrees } = await openWorktrees(root, RUN_ID);
    assert.ok(worktrees);

    // A read-only stage is a legitimate success, and must not mint an empty
    // commit — M1c-3 would merge it as if something had happened. The branch
    // still survives, at the base ref, because #19's retention rule is that
    // the branch always survives for a released task; only the rollback of a
    // non-releasing status deletes one.
    const path = await worktrees.acquire(status);
    await worktrees.release(status, "commit");

    assert.equal(existsSync(path), false);
    assert.equal(await hasBranch(root, status), true);
    assert.equal(await git(root, "rev-parse", branchOf(status)), head);
    assert.equal(await git(root, "rev-parse", "HEAD"), head);
  });
}

test("ignored files in the worktree do not block removal", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  // `git worktree remove` refuses while untracked or ignored files sit there,
  // and a task that ran an install leaves exactly that behind.
  const path = await worktrees.acquire("build");
  await run("mkdir", ["-p", join(path, "node_modules")]);
  await writeFile(join(path, "node_modules", "state.json"), "{}\n");
  await writeFile(join(path, ".gitignore"), "node_modules/\n");
  await writeFile(join(path, "src.txt"), "work\n");
  await worktrees.release("build", "commit");

  assert.equal(existsSync(path), false);
  const listed = await git(
    root,
    "ls-tree",
    "-r",
    "--name-only",
    branchOf("build"),
  );
  assert.match(listed, /src\.txt/);
  assert.doesNotMatch(listed, /state\.json/);
});

// --- the pool's half ---------------------------------------------------------

const runOf = (ids: string[]) =>
  validateRun({
    maxConcurrency: 2,
    tasks: ids.map((id) => ({ id, prompt: "x", agent: "opencode" })),
  });

test("a run gives each task its own worktree and cleans up after", async (t) => {
  const root = await repo(t);
  const seen = new Map<string, string>();
  const isolation: boolean[] = [];
  const exec: TaskExecutor = async (task, ctx) => {
    seen.set(task.id, ctx.cwd);
    isolation.push(ctx.isolated);
    await writeFile(join(ctx.cwd, `${task.id}.txt`), "work\n");
    return { stopReason: "end_turn" };
  };

  const report = await runRun(
    runOf(["plan", "impl"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    exec,
  );

  assert.equal(report.status, "done");
  assert.notEqual(seen.get("plan"), seen.get("impl"));
  assert.equal(seen.get("plan"), wtOf(root, "plan"));
  // `git worktree list` back to just the main worktree is the story's own
  // *done when*, and it is one line rather than two `existsSync` calls.
  assert.equal((await git(root, "worktree", "list")).split("\n").length, 1);
  assert.equal(await hasBranch(root, "plan"), true);
  // Its own checkout is what lets M1b-4 attribute a change to this task.
  assert.deepEqual(isolation, [true, true]);
});

test("a run in a non-repo cwd still runs, and says isolation is off", async (t) => {
  const dir = await tempDir(t);
  const notices: string[] = [];
  const isolation: boolean[] = [];
  const exec: TaskExecutor = async (_task, ctx) => {
    notices.push(ctx.cwd);
    isolation.push(ctx.isolated);
    return { stopReason: "end_turn" };
  };

  const report = await runRun(
    runOf(["plan", "impl"]),
    {
      cwd: dir,
      runId: RUN_ID,
      bus: createEventBus(),
      onNotice: (_id, text) => notices.push(text),
    },
    exec,
  );

  assert.equal(report.status, "done");
  assert.ok(notices.some((n) => /not a git repository/.test(n)));
  // Both tasks share the cwd, which is the caveat the notice exists to state.
  assert.deepEqual(
    report.tasks.map((task) => task.cwd),
    [dir, dir],
  );
  // And the same caveat in the form M1b-4 reads: nothing here can say which
  // task changed what, so the cross-check is told the tree is unknown (#88).
  assert.deepEqual(isolation, [false, false]);
});

test("a failed task keeps its worktree for reading", async (t) => {
  const root = await repo(t);
  const exec: TaskExecutor = async (_task, ctx) => {
    await writeFile(join(ctx.cwd, "half-done.txt"), "partial\n");
    throw new Error("harness died mid-turn");
  };

  const report = await runRun(
    runOf(["plan"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    exec,
  );

  assert.equal(report.status, "failed");
  assert.equal(existsSync(wtOf(root, "plan")), true);
});

test("a task that throws before writing leaves no worktree and no branch through the pool", async (t) => {
  const root = await repo(t);
  // The issue's spawn-failure acceptance: injected executor, through `runRun`,
  // not just `worktrees.release` called directly.
  const exec: TaskExecutor = async () => {
    throw new Error("harness never started");
  };

  const report = await runRun(
    runOf(["plan"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    exec,
  );

  assert.equal(report.status, "failed");
  assert.equal(existsSync(wtOf(root, "plan")), false);
  assert.equal(await hasBranch(root, "plan"), false);
});

// --- what #85's review found -------------------------------------------------

test("untracked output survives status.showUntrackedFiles=no", async (t) => {
  const root = await repo(t);
  // The setting is a display preference, and `--porcelain` does not override
  // it. Before #85 this emptied the status output, so a task whose whole
  // result was new files read as untouched and the checkout was removed with
  // the work still in it.
  await git(root, "config", "status.showUntrackedFiles", "no");
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const path = await worktrees.acquire("plan");
  await writeFile(join(path, "RESULT.md"), "the whole output of the task\n");
  assert.equal(await worktrees.release("plan", "commit"), null);

  assert.equal(existsSync(path), false);
  const listed = await git(
    root,
    "ls-tree",
    "-r",
    "--name-only",
    branchOf("plan"),
  );
  assert.match(listed, /RESULT\.md/);
});

test("the dirty-tree advisory survives status.showUntrackedFiles=no", async (t) => {
  // #85's property outlives the refusal it was found in: `--porcelain` alone
  // does not override the setting, so a count taken without
  // `--untracked-files=all` would read a tree of new files as clean.
  const root = await repo(t);
  await git(root, "config", "status.showUntrackedFiles", "no");
  await writeFile(join(root, "stray.txt"), "uncommitted\n");

  const { advisory } = await openWorktrees(root, RUN_ID);
  assert.match(String(advisory), /1 uncommitted file /);
});

test("a checkout left on another branch is kept, with a warning", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  // An ordinary thing for a coding agent to do inside its own checkout — and
  // every retention step below it would have acted on the wrong ref.
  const path = await worktrees.acquire("plan");
  await git(path, "checkout", "-q", "-b", "the-agents-own-branch");
  await writeFile(join(path, "RESULT.md"), "the work\n");

  const warning = await worktrees.release("plan", "commit");

  assert.match(String(warning), /the-agents-own-branch/);
  assert.match(String(warning), /Nothing was committed or removed/);
  assert.equal(existsSync(path), true, "the work stays on disk");
  // The advertised branch is untouched rather than quietly wrong.
  assert.equal(
    await git(root, "rev-parse", branchOf("plan")),
    await git(root, "rev-parse", "HEAD"),
  );
});

test("a checkout switched to an existing branch is kept even after update follows the name", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const path = await worktrees.acquire("plan");
  await git(path, "checkout", "-q", "-b", "the-agents-own-branch");
  worktrees.update("plan", { branch: "the-agents-own-branch" });

  const warning = await worktrees.release("plan", "keep");

  assert.match(String(warning), /the-agents-own-branch/);
  assert.equal(existsSync(path), true, "the foreign branch is not deleted");
  // Both refs stay: the switched-to name was not the run's to remove.
  await git(root, "rev-parse", "--verify", "refs/heads/the-agents-own-branch");
  await git(root, "rev-parse", "--verify", branchOf("plan"));
});

test("a checkout switched to a branch after the original ref is gone is kept", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const path = await worktrees.acquire("plan");
  // Rename the run's branch away, then switch to a pre-existing branch: the
  // original ref is gone, but neither name is ours to delete.
  await git(path, "branch", "-m", "wip-away");
  await git(root, "branch", "user-topic");
  await git(path, "switch", "-q", "user-topic");
  worktrees.update("plan", { branch: "user-topic", renamed: false });

  const warning = await worktrees.release("plan", "keep");

  assert.match(String(warning), /user-topic/);
  assert.ok(existsSync(path), "the checkout is kept");
  await git(root, "rev-parse", "--verify", "refs/heads/user-topic");
  await git(root, "rev-parse", "--verify", "refs/heads/wip-away");
});

test("checkoutIdentity proves a rename from the branch's own reflog", async (t) => {
  const root = await repo(t);
  await git(root, "branch", "old-name");
  await git(root, "switch", "-q", "old-name");
  await git(root, "branch", "-m", "new-name");

  assert.deepEqual(await checkoutIdentity(root, "old-name"), {
    branch: "new-name",
    renamedFrom: "old-name",
  });
  // A branch with no such entry is not proven to have come from the name.
  await git(root, "switch", "-q", "main");
  assert.deepEqual(await checkoutIdentity(root, "old-name"), {
    branch: "main",
  });
});

test("a stale rename entry on a pre-existing branch does not claim it", async (t) => {
  const root = await repo(t);
  await git(root, "branch", "held-name");
  await git(root, "switch", "-q", "held-name");
  await git(root, "branch", "-m", "pre-existing");
  // The old name exists again as its own branch: the entry is stale.
  await git(root, "branch", "held-name");

  assert.deepEqual(await checkoutIdentity(root, "held-name"), {
    branch: "pre-existing",
  });
});

test("a detached HEAD is kept too, and says so", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const path = await worktrees.acquire("plan");
  await git(path, "checkout", "-q", "--detach");
  await writeFile(join(path, "RESULT.md"), "the work\n");

  const warning = await worktrees.release("plan", "commit");

  assert.match(String(warning), /detached HEAD/);
  assert.equal(existsSync(path), true);
});

test("a subdirectory cwd stays the workspace root inside the worktree", async (t) => {
  const root = await repo(t);
  await run("mkdir", ["-p", join(root, "packages", "app")]);
  await writeFile(join(root, "packages", "app", "a.txt"), "x\n");
  await writeFile(join(root, "outside.txt"), "not in the requested subtree\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "monorepo");

  const sub = join(root, "packages", "app");
  const { worktrees } = await openWorktrees(sub, RUN_ID);
  assert.ok(worktrees);

  // Returning the checkout root would hand the task the whole repository, and
  // `#guardPath` bounds this client's file service to whatever it is given —
  // so the requested subtree would silently become the repo.
  const path = await worktrees.acquire("plan");

  assert.equal(path, wtOf(root, "plan", "packages", "app"));
  assert.equal(existsSync(join(path, "a.txt")), true);
  assert.equal(existsSync(join(path, "outside.txt")), false);
});

test("a subdirectory missing at the base ref throws naming it", async (t) => {
  const root = await repo(t);
  const sub = join(root, "packages", "app");
  await run("mkdir", ["-p", sub]);

  // The directory exists now but not in the commit each task branches from,
  // so there is no such workspace root to give them.
  const { worktrees } = await openWorktrees(sub, RUN_ID);
  assert.ok(worktrees);

  await assert.rejects(worktrees.acquire("plan"), (err: Error) => {
    assert.match(err.message, /the folder packages\/app is not in HEAD/);
    return true;
  });
});

test("a symlinked --cwd cannot walk a task out of its own checkout", async (t) => {
  const root = await repo(t);
  await run("mkdir", ["-p", join(root, "packages", "app")]);
  await writeFile(join(root, "packages", "app", "a.txt"), "x\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "monorepo");

  // `git rev-parse --show-toplevel` resolves symlinks; `--cwd` is the string
  // the operator typed. Subtracting one from the other gave a prefix full of
  // `..`, and this exact shape — a link named like another task in the run —
  // put `plan` inside `impl`'s checkout (#85). `process.cwd()` is already
  // real, so only an explicit `--cwd` ever reaches this.
  const link = join(root, "..", "impl");
  await symlink(join(root, "packages", "app"), link);
  t.after(() => rm(link, { force: true }));

  const { worktrees } = await openWorktrees(link, RUN_ID);
  assert.ok(worktrees);

  const impl = await worktrees.acquire("impl");
  const plan = await worktrees.acquire("plan");

  assert.notEqual(impl, plan);
  const wt = wtOf(root);
  assert.equal(plan, join(wt, "plan", "packages", "app"));
  assert.equal(impl, join(wt, "impl", "packages", "app"));
  // The subtree the operator asked for, and nothing above it.
  assert.equal(existsSync(join(plan, "a.txt")), true);
  assert.equal(existsSync(join(plan, "README.md")), false);
});

// --- changedPaths, against git itself (#88) -----------------------------------

// Every case here is one a reviewer raised or one that reached `crossCheck`
// wrongly before `-z`: a single modified file lost its leading status column
// to `trim()` and read as `un.ts`; quoted UTF-8, a quote in a name and a
// rename's two halves all went through a hand-written unquoter. `-z` writes
// paths verbatim and puts a rename's source in its own entry, so the only
// thing left to prove is that this reading agrees with git.
test("changedPaths reports what git changed, verbatim", async (t) => {
  const dir = await repo(t);
  await writeFile(join(dir, ".gitignore"), "ignored/\n");
  await writeFile(join(dir, "run.ts"), "one\n");
  await writeFile(join(dir, "café.ts"), "u\n");
  await writeFile(join(dir, 'q"uote.ts'), "q\n");
  await writeFile(join(dir, "old.ts"), "o\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "second");

  // One modified file on its own: the shape whose leading space `trim()` ate.
  await writeFile(join(dir, "run.ts"), "two\n");
  assert.deepEqual(await changedPaths(dir), ["run.ts"]);

  await writeFile(join(dir, "café.ts"), "v\n");
  await writeFile(join(dir, 'q"uote.ts'), "r\n");
  await writeFile(join(dir, "un tracked.ts"), "n\n");
  await git(dir, "mv", "old.ts", "new.ts");
  await run("mkdir", ["-p", join(dir, "ignored")]);
  await writeFile(join(dir, "ignored", "state"), "s\n");

  const paths = await changedPaths(dir);
  for (const path of [
    "run.ts",
    "café.ts",
    'q"uote.ts',
    "un tracked.ts",
    "new.ts",
    "old.ts", // a rename contributes both halves
  ]) {
    assert.ok(paths.includes(path), `${path} missing from ${paths.join(", ")}`);
  }
  // Whatever the operator ignores stays invisible, which is what keeps build
  // output out of the cross-check.
  assert.ok(!paths.some((p) => p.startsWith("ignored/")));
});

test("changedPaths is empty on a clean tree", async (t) => {
  assert.deepEqual(await changedPaths(await repo(t)), []);
});

// --- moveWorkspace (#129) ----------------------------------------------------

// Renaming a repository strands its workspace, because `stateDirFor` keys on
// the path. `mv` alone does not repair it: measured 2026-09-20, git keeps the
// old absolute path on both sides of the link and reports the moved checkout
// as `prunable` — so a later `git worktree prune` would delete the work. The
// two halves must therefore be one command nobody can half-run.

test("moveWorkspace carries the workspace to the renamed repository", async (t) => {
  const from = await repo(t);
  const { worktrees } = await openWorktrees(from, RUN_ID);
  assert.ok(worktrees);
  const before = await worktrees.acquire("a");
  await writeFile(join(before, "made.txt"), "work\n");
  const oldWorkspace = stateDirFor(from);

  const to = join(await tempDir(t), "renamed");
  await run("mv", [from, to]);

  const workspace = await moveWorkspace(from, to);

  assert.equal(workspace, stateDirFor(to));
  assert.equal(existsSync(oldWorkspace), false, "the old workspace is gone");
  assert.equal(
    await readFile(join(workspace, "wt", RUN_ID, "a", "made.txt"), "utf8"),
    "work\n",
    "the task's work came with it",
  );
});

test("moveWorkspace repairs the worktree links, so nothing is prunable", async (t) => {
  // The half that `mv` cannot do. Without `git worktree repair` the checkout
  // is listed at its old path and marked `prunable`, which is the shape that
  // loses work.
  const from = await repo(t);
  const { worktrees } = await openWorktrees(from, RUN_ID);
  assert.ok(worktrees);
  await workThenRelease(worktrees, "a", "failed");

  const to = join(await tempDir(t), "renamed");
  await run("mv", [from, to]);
  const workspace = await moveWorkspace(from, to);

  const listed = await git(to, "worktree", "list");
  assert.doesNotMatch(listed, /prunable/, listed);
  assert.ok(
    listed.includes(join(workspace, "wt", RUN_ID, "a")),
    `the checkout is listed at its new path, got:\n${listed}`,
  );
  // And it is a working checkout, not just a listed one.
  assert.equal(
    await git(
      join(workspace, "wt", RUN_ID, "a"),
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ),
    branchOf("a"),
  );
});

test("moveWorkspace refuses a destination that is not a repository", async (t) => {
  const from = await repo(t);
  const setup = await openWorktrees(from, RUN_ID);
  assert.ok(setup.worktrees);
  await setup.worktrees.acquire("a");
  const to = await tempDir(t);

  await assert.rejects(moveWorkspace(from, to), (err: Error) => {
    assert.match(err.message, new RegExp(to));
    assert.match(err.message, /not a git repository/);
    return true;
  });
});

test("moveWorkspace refuses when the source has no workspace", async (t) => {
  // Nothing to move is an error the operator should see, not a silent no-op:
  // they ran this because a notice named a workspace.
  const from = join(await tempDir(t), "never-ran");
  const to = await repo(t);

  await assert.rejects(moveWorkspace(from, to), /no kapelle workspace/);
});

test("moveWorkspace refuses rather than overwrite an existing workspace", async (t) => {
  // Both must have *acquired*: `openWorktrees` creates no directory, so a
  // repository that only preflighted has no workspace to collide with.
  const from = await repo(t);
  const a = await openWorktrees(from, RUN_ID);
  assert.ok(a.worktrees);
  await a.worktrees.acquire("a");
  const to = await repo(t);
  const b = await openWorktrees(to, RUN_ID);
  assert.ok(b.worktrees);
  await b.worktrees.acquire("a");

  await assert.rejects(moveWorkspace(from, to), (err: Error) => {
    assert.match(err.message, new RegExp(stateDirFor(to)));
    assert.match(err.message, /already has/);
    return true;
  });
});

/** `repo`, with a `topic` branch of two commits and `main` one commit on. */
async function forked(t: TestContext) {
  const root = await repo(t);
  const fork = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-q", "-c", "topic");
  await git(root, "commit", "-q", "--allow-empty", "-m", "A");
  const a = await git(root, "rev-parse", "HEAD");
  await git(root, "commit", "-q", "--allow-empty", "-m", "B");
  await git(root, "switch", "-q", "main");
  await git(root, "commit", "-q", "--allow-empty", "-m", "base moves");
  const newer = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-q", "topic");
  return { root, fork, a, newer };
}

/** Squashes the branch's top two commits with `rebase -i`, as an agent might. */
const squash = (root: string) =>
  git(
    root,
    "-c",
    "sequence.editor=sed -i 2s/^pick/fixup/",
    "rebase",
    "-q",
    "-i",
    "HEAD~2",
  );

test("a rebase onto a newer base moves the base; a squash after it keeps it", async (t) => {
  const { root, newer } = await forked(t);
  await git(root, "rebase", "-q", "main");
  await git(root, "commit", "-q", "--allow-empty", "-m", "C");
  assert.deepEqual(await checkoutIdentity(root), {
    branch: "topic",
    rebaseBase: newer,
  });
  await squash(root);
  assert.deepEqual(await checkoutIdentity(root), {
    branch: "topic",
    rebaseBase: newer,
  });
});

test("a squash onto the branch's own commit is no new base", async (t) => {
  const { root } = await forked(t);
  await git(root, "commit", "-q", "--allow-empty", "-m", "C");
  await squash(root);
  assert.deepEqual(await checkoutIdentity(root), { branch: "topic" });
});

test("a reset after a rebase leaves the base to the record", async (t) => {
  const { root, a } = await forked(t);
  await git(root, "rebase", "-q", "main");
  await git(root, "reset", "-q", "--hard", a);
  assert.deepEqual(await checkoutIdentity(root), { branch: "topic" });
});

test("a merge after a rebase leaves the base to the record", async (t) => {
  const { root } = await forked(t);
  await git(root, "rebase", "-q", "main");
  // A branch from the same base, so the merge makes a commit.
  await git(root, "switch", "-q", "-c", "feature", "main");
  await git(root, "commit", "-q", "--allow-empty", "-m", "F");
  await git(root, "switch", "-q", "topic");
  await git(root, "merge", "-q", "--no-edit", "feature");
  assert.deepEqual(await checkoutIdentity(root), { branch: "topic" });
});

test("a merge resolved by hand leaves the base to the record", async (t) => {
  const { root } = await forked(t);
  await git(root, "rebase", "-q", "main");
  await writeFile(join(root, "README.md"), "topic\n");
  await git(root, "commit", "-qam", "topic edit");
  await git(root, "switch", "-q", "-c", "feature", "main");
  await writeFile(join(root, "README.md"), "feature\n");
  await git(root, "commit", "-qam", "feature edit");
  await git(root, "switch", "-q", "topic");
  // The conflict is resolved by hand, so the reflog says `commit (merge)`
  // rather than `merge …`; both forms must stop the scan.
  try {
    await run("git", ["merge", "feature"], { cwd: root });
  } catch {
    // The expected conflict; the commit below completes the merge.
  }
  await writeFile(join(root, "README.md"), "resolved\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-q", "--no-edit");
  assert.deepEqual(await checkoutIdentity(root), { branch: "topic" });
});

test("checkoutIdentity reads a branch named like a path", async (t) => {
  const { root, newer } = await forked(t);
  await git(root, "rebase", "-q", "main");
  await git(root, "branch", "-m", "topic", "docs");
  // A file with the branch's name makes `reflog show docs` ambiguous; the
  // `--` after the ref is what keeps the reflog readable.
  await writeFile(join(root, "docs"), "x\n");
  assert.deepEqual(await checkoutIdentity(root, "docs"), {
    branch: "docs",
    rebaseBase: newer,
  });
});

// --- worktree links (#274) ---------------------------------------------------

/** A repo with a real `node_modules/` and an ignore rule that matches only a
 *  directory. The rule is committed, so every checkout sees it. */
async function repoWithLinks(t: TestContext): Promise<string> {
  const root = await repo(t);
  await writeFile(join(root, ".gitignore"), "node_modules/\nvendor.txt\n");
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "module\n");
  await writeFile(join(root, "vendor.txt"), "vendor\n");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "ignore links");
  return root;
}

test("a listed directory is mirrored and a listed file is symlinked (#274)", async (t) => {
  const root = await repoWithLinks(t);
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["node_modules", "vendor.txt"],
  });
  assert.ok(worktrees);

  const wt = await worktrees.acquire("plan");
  assert.equal((await lstat(join(wt, "node_modules"))).isDirectory(), true);
  assert.equal(
    (await lstat(join(wt, "node_modules", "pkg"))).isSymbolicLink(),
    true,
  );
  assert.equal((await lstat(join(wt, "vendor.txt"))).isSymbolicLink(), true);
  // The point of the directory-only ignore rule: the links are invisible.
  assert.deepEqual(await changedPaths(wt), []);

  // Removing the checkout takes the links, never the main folders.
  await worktrees.release("plan", "commit");
  assert.ok(existsSync(join(root, "node_modules", "pkg", "index.js")));
  assert.ok(existsSync(join(root, "vendor.txt")));
});

test("a missing link path is skipped (#274)", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["not-installed"],
  });
  assert.ok(worktrees);

  const wt = await worktrees.acquire("plan");
  assert.equal(existsSync(join(wt, "not-installed")), false);
  await worktrees.release("plan", "keep");
});

test("tracked, escaping, and .git link paths are refused (#274)", async (t) => {
  const root = await repoWithLinks(t);

  await assert.rejects(
    openWorktrees(root, RUN_ID, { linkPaths: ["README.md"] }),
    /tracked by git/,
  );
  await assert.rejects(
    openWorktrees(root, RUN_ID, { linkPaths: ["../outside"] }),
    /relative path inside the checkout/,
  );
  await assert.rejects(
    openWorktrees(root, RUN_ID, { linkPaths: [".git"] }),
    /must not name \.git/,
  );
  await assert.rejects(
    openWorktrees(root, RUN_ID, { linkPaths: ["sub/.git"] }),
    /must not name \.git/,
  );

  const outside = await tempDir(t);
  await symlink(outside, join(root, "escape"));
  await assert.rejects(
    openWorktrees(root, RUN_ID, { linkPaths: ["escape"] }),
    /resolves outside/,
  );
});

test("an escaping or dangling link entry refuses the config (#311)", async (t) => {
  const outside = await tempDir(t);
  for (const [name, target, reason] of [
    ["ssh", outside, "resolves outside"],
    ["next", "nowhere", "cannot be resolved"],
  ] as const) {
    const root = await repoWithLinks(t);
    await symlink(target, join(root, "node_modules", name));
    await assert.rejects(
      validateWorktreeLinks(root, ["node_modules"]),
      (err: unknown) =>
        err instanceof LinkPathError &&
        err.message.includes(`"linkPaths[0]" entry "${name}" ${reason}`),
    );
  }
});

test("an in-root symlink entry still mirrors, and git status stays clean (#311)", async (t) => {
  const root = await repoWithLinks(t);
  await symlink("pkg", join(root, "node_modules", "alias"));
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["node_modules"],
  });
  assert.ok(worktrees);

  const wt = await worktrees.acquire("plan");
  assert.equal(
    (await lstat(join(wt, "node_modules", "alias"))).isSymbolicLink(),
    true,
  );
  assert.equal(
    await readFile(join(wt, "node_modules", "alias", "index.js"), "utf8"),
    "module\n",
  );
  assert.deepEqual(await changedPaths(wt), []);
  await worktrees.release("plan", "keep");
});

test("an entry planted after setup leaves no outside link (#311)", async (t) => {
  const outside = await tempDir(t);
  for (const [name, target] of [
    ["ssh", outside],
    ["next", "nowhere"],
  ] as const) {
    const root = await repoWithLinks(t);
    const { worktrees } = await openWorktrees(root, RUN_ID, {
      linkPaths: ["node_modules"],
    });
    assert.ok(worktrees);

    await symlink(target, join(root, "node_modules", name));
    await assert.rejects(
      worktrees.acquire("plan"),
      (err: unknown) =>
        err instanceof LinkPathError && err.message.includes(`entry "${name}"`),
    );
    // `lstat`, not `existsSync`: the latter follows the link and is false for
    // a dangling one, which is exactly the link this test says is absent.
    await assert.rejects(lstat(wtOf(root, "plan", "node_modules", name)), {
      code: "ENOENT",
    });
    await worktrees.release("plan", "keep");
  }
});

test("an entry planted after the plan is refused at mirror time (#311)", async (t) => {
  const root = await repoWithLinks(t);
  const outside = await tempDir(t);
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["node_modules"],
    onLinkPlan: () => symlink(outside, join(root, "node_modules", "ssh")),
  });
  assert.ok(worktrees);

  await assert.rejects(
    worktrees.acquire("plan"),
    /"linkPaths\[0\]" entry "ssh" resolves outside/,
  );
  await assert.rejects(lstat(wtOf(root, "plan", "node_modules", "ssh")), {
    code: "ENOENT",
  });
  await worktrees.release("plan", "keep");
});

test("a linked path swapped for an outside symlink after the plan is refused at mirror time (#311)", async (t) => {
  for (const name of ["node_modules", "vendor.txt"] as const) {
    const root = await repoWithLinks(t);
    const outside = await tempDir(t);
    await writeFile(join(outside, "secret.txt"), "outside\n");
    const { worktrees } = await openWorktrees(root, RUN_ID, {
      linkPaths: [name],
      onLinkPlan: async () => {
        await rm(join(root, name), { recursive: true, force: true });
        await symlink(
          name === "node_modules" ? outside : join(outside, "secret.txt"),
          join(root, name),
        );
      },
    });
    assert.ok(worktrees);

    await assert.rejects(
      worktrees.acquire("plan"),
      (err: unknown) =>
        err instanceof LinkPathError &&
        err.message.includes('"linkPaths[0]"') &&
        /resolves outside/.test(err.message),
    );
    const linked =
      name === "node_modules"
        ? wtOf(root, "plan", name, "secret.txt")
        : wtOf(root, "plan", name);
    await assert.rejects(lstat(linked), { code: "ENOENT" });
    await worktrees.release("plan", "keep");
  }
});

test("a linked file replaced by a directory after the plan is checked at mirror time (#311)", async (t) => {
  const root = await repoWithLinks(t);
  const outside = await tempDir(t);
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["vendor.txt"],
    onLinkPlan: async () => {
      await rm(join(root, "vendor.txt"), { force: true });
      await mkdir(join(root, "vendor.txt"));
      await symlink(outside, join(root, "vendor.txt", "ssh"));
    },
  });
  assert.ok(worktrees);

  await assert.rejects(
    worktrees.acquire("plan"),
    (err: unknown) =>
      err instanceof LinkPathError &&
      /entry "ssh" resolves outside/.test(err.message),
  );
  await assert.rejects(lstat(wtOf(root, "plan", "vendor.txt", "ssh")), {
    code: "ENOENT",
  });
  await worktrees.release("plan", "keep");
});

test("a run gets the project's configured links (#274)", async (t) => {
  const root = await repoWithLinks(t);
  await mkdir(join(root, ".kapelle"), { recursive: true });
  await writeFile(
    join(root, ".kapelle", "config.json"),
    `${JSON.stringify({ linkPaths: ["node_modules"] })}\n`,
    { mode: 0o644 },
  );

  const exec: TaskExecutor = async (_task, ctx) => {
    assert.equal(
      (await lstat(join(ctx.cwd, "node_modules"))).isDirectory(),
      true,
    );
    assert.equal(
      (await lstat(join(ctx.cwd, "node_modules", "pkg"))).isSymbolicLink(),
      true,
    );
    return { stopReason: "end_turn" };
  };

  const report = await runRun(
    runOf(["plan"]),
    {
      cwd: root,
      runId: RUN_ID,
      bus: createEventBus(),
      linkPaths: readProjectLinkPaths(root),
    },
    exec,
  );
  assert.equal(report.status, "done");
});

test("a link git would see is refused, and the checkout is left clean (#274)", async (t) => {
  const root = await repo(t);
  // Untracked and not ignored: a link to it would show in `git status`.
  await writeFile(join(root, "vendor.txt"), "vendor\n");
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["vendor.txt"],
  });
  assert.ok(worktrees);

  await assert.rejects(
    worktrees.acquire("plan"),
    /"linkPaths\[0\]" is not ignored in a new checkout/,
  );
  assert.equal(existsSync(wtOf(root, "plan", "vendor.txt")), false);
  assert.deepEqual(await changedPaths(wtOf(root, "plan")), []);
  await worktrees.release("plan", "keep");
});

test("a path installed after setup is linked into the next checkout (#274)", async (t) => {
  const root = await repo(t);
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "ignore node_modules");
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["node_modules"],
  });
  assert.ok(worktrees);

  // A room lives for days: `npm ci` can run after it opened.
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  const wt = await worktrees.acquire("plan");
  assert.equal(
    (await lstat(join(wt, "node_modules", "pkg"))).isSymbolicLink(),
    true,
  );
  await worktrees.release("plan", "keep");
});

test("a visible link with glob characters is still refused (#274)", async (t) => {
  const root = await repo(t);
  await mkdir(join(root, "foo[1]"));
  await writeFile(join(root, "foo[1]", "file.txt"), "x\n");
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["foo[1]"],
  });
  assert.ok(worktrees);

  await assert.rejects(
    worktrees.acquire("plan"),
    /is not ignored in a new checkout/,
  );
  assert.equal(existsSync(join(wtOf(root, "plan", "foo[1]"))), false);
  await worktrees.release("plan", "keep");
});

test("a nested link cannot follow a symlinked parent out of the checkout (#274)", async (t) => {
  const root = await repo(t);
  const outside = await tempDir(t);
  await mkdir(join(outside, "b"), { recursive: true });
  await symlink(outside, join(root, "a"));
  await git(root, "add", "a");
  await git(root, "commit", "-m", "symlink a");
  await rm(join(root, "a"), { recursive: true, force: true });
  await mkdir(join(root, "a", "b", "c"), { recursive: true });

  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["a/b/c"],
  });
  assert.ok(worktrees);
  await assert.rejects(
    worktrees.acquire("plan"),
    /parent outside the checkout/,
  );
  assert.equal(existsSync(join(outside, "b", "c")), false);
  await worktrees.release("plan", "keep");
});

test("a link path that cannot be resolved is refused as a link error (#274)", async (t) => {
  const root = await repo(t);
  await symlink("loop", join(root, "loop"));
  await assert.rejects(
    openWorktrees(root, RUN_ID, { linkPaths: ["loop"] }),
    /cannot be read/,
  );
});

test("a trailing slash on a file link is normalized (#274)", async (t) => {
  const root = await repoWithLinks(t);
  const { worktrees } = await openWorktrees(root, RUN_ID, {
    linkPaths: ["vendor.txt/"],
  });
  assert.ok(worktrees);

  const wt = await worktrees.acquire("plan");
  assert.equal((await lstat(join(wt, "vendor.txt"))).isSymbolicLink(), true);
  assert.deepEqual(await changedPaths(wt), []);
  await worktrees.release("plan", "keep");
});

test("the config and worktree shape checks refuse the same link paths (#274)", async (t) => {
  const root = await repo(t);
  await mkdir(join(root, ".kapelle"), { recursive: true });
  const refused: string[][] = [
    [""],
    ["/abs"],
    ["../up"],
    ["a/../b"],
    [".git"],
    ["sub/.git"],
    ["a", "a/sub"],
  ];

  for (const linkPaths of refused) {
    await writeFile(
      join(root, ".kapelle", "config.json"),
      `${JSON.stringify({ linkPaths })}\n`,
      { mode: 0o644 },
    );
    assert.throws(
      () => readProjectConfig(root),
      Error,
      `config accepted ${JSON.stringify(linkPaths)}`,
    );
    await assert.rejects(
      openWorktrees(root, RUN_ID, { linkPaths }),
      Error,
      `worktree accepted ${JSON.stringify(linkPaths)}`,
    );
  }
});
