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
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { createEventBus } from "../events.ts";
import { runRun, type TaskExecutor, type TaskStatus } from "../run.ts";
import { validateRun } from "../runfile.ts";
import { changedPaths, openWorktrees, type Worktrees } from "../worktree.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

const RUN_ID = "20260906-120000-abcd";

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A repository with one commit and `.kapelle/` already ignored — the
 *  shape the preflight demands, so a test that wants a refusal undoes one
 *  part of it rather than building the broken repo from scratch. */
async function repo(t: TestContext): Promise<string> {
  const dir = await tempDir(t);
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@example.invalid");
  await git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, ".gitignore"), ".kapelle/\n");
  await writeFile(join(dir, "README.md"), "first\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "first");
  return dir;
}

const branchOf = (taskId: string) => `kapelle/${RUN_ID}/${taskId}`;

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
  await worktrees.release(taskId, status);
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
  await writeFile(join(dir, ".gitignore"), ".kapelle/\n");

  const { worktrees, notice } = await openWorktrees(dir, RUN_ID);

  assert.equal(worktrees, null);
  assert.match(String(notice), /no commits yet/);
});

test("a repository with no commits still refuses an unignored .kapelle", async (t) => {
  // The unborn-HEAD fallback is not a pass around the ignore preflight:
  // `core/run.ts` writes `.kapelle/runs/` even when worktrees cannot
  // exist, so a fresh `git init` with no .gitignore must refuse before the
  // run can create state that would be committed by accident.
  const dir = await tempDir(t);
  await git(dir, "init", "-b", "main");

  await assert.rejects(openWorktrees(dir, RUN_ID), (err: Error) => {
    assert.match(err.message, /not ignored by git/);
    return true;
  });
});

test("an unignored .kapelle/ refuses, and the message is the fix", async (t) => {
  const root = await repo(t);
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await git(root, "commit", "-am", "drop the ignore");

  await assert.rejects(openWorktrees(root, RUN_ID), (err: Error) => {
    assert.match(err.message, /not ignored by git/);
    assert.match(err.message, /add `\.kapelle\/` to \.gitignore/i);
    return true;
  });
});

test("a tracked .kapelle/ refuses as tracked, not as unignored", async (t) => {
  const root = await repo(t);
  // Ignored *and* committed: `check-ignore` still matches the pattern, so
  // only the tracked check can tell this apart from the case above — and it
  // is the case where following the other message would fix nothing.
  await run("mkdir", ["-p", join(root, ".kapelle")]);
  await writeFile(join(root, ".kapelle", "old.json"), "{}\n");
  await git(root, "add", "-f", ".kapelle");
  await git(root, "commit", "-m", "oops");

  await assert.rejects(openWorktrees(root, RUN_ID), (err: Error) => {
    assert.match(err.message, /is tracked by git/);
    assert.match(err.message, /git rm -r --cached/);
    return true;
  });
});

test("a dirty working tree refuses and names what is dirty", async (t) => {
  const root = await repo(t);
  await writeFile(join(root, "README.md"), "edited\n");

  await assert.rejects(openWorktrees(root, RUN_ID), (err: Error) => {
    assert.match(err.message, /uncommitted changes/);
    assert.match(err.message, /README\.md/);
    return true;
  });
});

test("supervisor state never trips the dirty-tree refusal", async (t) => {
  const root = await repo(t);
  // The second run onward starts here: the first run's worktrees, logs and
  // records are all sitting in the tree the preflight is about to check.
  await run("mkdir", ["-p", join(root, ".kapelle", "runs")]);
  await writeFile(join(root, ".kapelle", "runs", "old.log"), "noise\n");

  const { worktrees, notice } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);
  assert.equal(notice, undefined);
});

// --- acquire -----------------------------------------------------------------

test("acquire checks out the branch at the base ref's commit", async (t) => {
  const root = await repo(t);
  const head = await git(root, "rev-parse", "HEAD");
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const path = await worktrees.acquire("plan");

  assert.equal(path, join(root, ".kapelle", "wt", RUN_ID, "plan"));
  assert.equal(await git(path, "rev-parse", "HEAD"), head);
  assert.equal(
    await git(path, "rev-parse", "--abbrev-ref", "HEAD"),
    branchOf("plan"),
  );
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
  await worktrees.release("plan", "failed");

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
    await worktrees.release(status, status);

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
  await run("mkdir", ["-p", join(path, ".kapelle")]);
  await writeFile(join(path, ".kapelle", "state.json"), "{}\n");
  await writeFile(join(path, "src.txt"), "work\n");
  await worktrees.release("build", "done");

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
  assert.equal(seen.get("plan"), join(root, ".kapelle", "wt", RUN_ID, "plan"));
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
  assert.equal(existsSync(join(root, ".kapelle", "wt", RUN_ID, "plan")), true);
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
  assert.equal(existsSync(join(root, ".kapelle", "wt", RUN_ID, "plan")), false);
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
  assert.equal(await worktrees.release("plan", "done"), null);

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

test("the dirty-tree refusal survives status.showUntrackedFiles=no", async (t) => {
  const root = await repo(t);
  await git(root, "config", "status.showUntrackedFiles", "no");
  await writeFile(join(root, "stray.txt"), "uncommitted\n");

  await assert.rejects(openWorktrees(root, RUN_ID), (err: Error) => {
    assert.match(err.message, /uncommitted changes/);
    assert.match(err.message, /stray\.txt/);
    return true;
  });
});

test("both ignore refusals tell the operator to commit the change", async (t) => {
  // Following "add it to .gitignore and re-run" literally left the tree dirty,
  // so the very next preflight refused — a fix whose own result is rejected.
  const root = await repo(t);
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await git(root, "commit", "-am", "drop the ignore");

  await assert.rejects(openWorktrees(root, RUN_ID), (err: Error) => {
    assert.match(err.message, /commit that change, and re-run/);
    assert.match(err.message, /\.git\/info\/exclude/);
    return true;
  });
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

  const warning = await worktrees.release("plan", "done");

  assert.match(String(warning), /the-agents-own-branch/);
  assert.match(String(warning), /Nothing was committed or removed/);
  assert.equal(existsSync(path), true, "the work stays on disk");
  // The advertised branch is untouched rather than quietly wrong.
  assert.equal(
    await git(root, "rev-parse", branchOf("plan")),
    await git(root, "rev-parse", "HEAD"),
  );
});

test("a detached HEAD is kept too, and says so", async (t) => {
  const root = await repo(t);
  const { worktrees } = await openWorktrees(root, RUN_ID);
  assert.ok(worktrees);

  const path = await worktrees.acquire("plan");
  await git(path, "checkout", "-q", "--detach");
  await writeFile(join(path, "RESULT.md"), "the work\n");

  const warning = await worktrees.release("plan", "done");

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

  assert.equal(
    path,
    join(root, ".kapelle", "wt", RUN_ID, "plan", "packages", "app"),
  );
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
    assert.match(err.message, /packages\/app does not exist/);
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
  const wt = join(root, ".kapelle", "wt", RUN_ID);
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
  await writeFile(join(dir, ".kapelle", "state"), "s\n").catch(() => {});

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
  // Ignored state is invisible, which is what keeps it out of the cross-check.
  assert.ok(!paths.some((p) => p.startsWith(".kapelle")));
});

test("changedPaths is empty on a clean tree", async (t) => {
  assert.deepEqual(await changedPaths(await repo(t)), []);
});
