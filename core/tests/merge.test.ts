/**
 * Merge tests — story M1c-3, issue #27.
 *
 * Against real git, like `core/tests/worktree.test.ts`: merge's claims are
 * about what git does with refs, the index and the working tree.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { createEventBus } from "../events.ts";
import { mergeRun } from "../merge.ts";
import { runRun, type TaskExecutor } from "../run.ts";
import { validateRun } from "../runfile.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

const RUN_ID = "20260909-120000-abcd";

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "merge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

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

const runOf = (ids: string[]) =>
  validateRun({
    maxConcurrency: 2,
    tasks: ids.map((id) => ({ id, prompt: "x", agent: "opencode" })),
  });

function writer(file: string): TaskExecutor {
  return async (_task, ctx) => {
    await writeFile(join(ctx.cwd, file), "work\n");
    return { stopReason: "end_turn" };
  };
}

const perTaskWriter: TaskExecutor = async (task, ctx) => {
  await writeFile(join(ctx.cwd, `${task.id}.txt`), "work\n");
  return { stopReason: "end_turn" };
};

test("a two-task run writes run.json, then merge lands both changes unstaged", async (t) => {
  const root = await repo(t);
  const report = await runRun(
    runOf(["a", "b"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    perTaskWriter,
  );
  assert.equal(report.status, "done");

  const record = join(root, ".kapelle", "runs", RUN_ID, "run.json");
  assert.equal(existsSync(record), true);
  const parsed = JSON.parse(await readFile(record, "utf8")) as {
    tasks: { id: string; branch: string; baseSha: string }[];
  };
  assert.deepEqual(parsed.tasks.map((task) => task.id).sort(), ["a", "b"]);

  const before = await git(root, "rev-parse", "HEAD");
  await mergeRun(RUN_ID, root);
  assert.equal(await git(root, "rev-parse", "HEAD"), before);

  const status = await git(
    root,
    "status",
    "--porcelain",
    "--untracked-files=all",
  );
  assert.match(status, /a\.txt/);
  assert.match(status, /b\.txt/);
  // The merge must not have staged anything: added files are untracked (`??`),
  // not staged (`A `), and there is no new commit.
  assert.doesNotMatch(status, /^A /m);
});

test("a conflicting local edit aborts before changing anything", async (t) => {
  const root = await repo(t);
  await runRun(
    runOf(["a"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    writer("conflict.txt"),
  );

  // The main worktree does not have conflict.txt at HEAD; an untracked file at
  // the same path is still a change a task branch would touch.
  await writeFile(join(root, "conflict.txt"), "mine\n");
  const head = await git(root, "rev-parse", "HEAD");
  await assert.rejects(mergeRun(RUN_ID, root), /working tree has changes/);

  assert.equal(await readFile(join(root, "conflict.txt"), "utf8"), "mine\n");
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
});

test("two branches touching the same file refuse before merging", async (t) => {
  const root = await repo(t);
  const report = await runRun(
    runOf(["a", "b"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    writer("shared.txt"),
  );
  assert.equal(report.status, "done");

  await assert.rejects(mergeRun(RUN_ID, root), /touched by both a and b/);
  const status = await git(root, "status", "--porcelain");
  assert.equal(status, "");
});

test("a task left on another branch is not silently mergeable", async (t) => {
  const root = await repo(t);
  const report = await runRun(
    runOf(["a"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    async (_task, ctx) => {
      await git(ctx.cwd, "checkout", "-q", "-b", "agent-own-branch");
      await writeFile(join(ctx.cwd, "work.txt"), "work\n");
      await git(ctx.cwd, "add", "-A");
      await git(ctx.cwd, "commit", "-q", "-m", "agent work");
      return { stopReason: "end_turn" };
    },
  );
  assert.equal(report.status, "done");

  const record = JSON.parse(
    await readFile(join(root, ".kapelle", "runs", RUN_ID, "run.json"), "utf8"),
  ) as { tasks: { branch?: string }[] };
  assert.equal(record.tasks[0]?.branch, undefined);

  await assert.rejects(mergeRun(RUN_ID, root), /missing branch\/base/);
});

test("an incomplete run refuses and names the unfinished task", async (t) => {
  const root = await repo(t);
  const report = await runRun(
    runOf(["a"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    async (_task, ctx) => {
      await writeFile(join(ctx.cwd, "partial.txt"), "partial\n");
      throw new Error("harness died");
    },
  );
  assert.equal(report.status, "failed");

  await assert.rejects(mergeRun(RUN_ID, root), /unfinished task/);
});

test("a rename lands as unstaged deletion and untracked addition", async (t) => {
  const root = await repo(t);
  await writeFile(join(root, "old.txt"), "old\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "old");

  const report = await runRun(
    runOf(["a"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    async (_task, ctx) => {
      await git(ctx.cwd, "mv", "old.txt", "new.txt");
      return { stopReason: "end_turn" };
    },
  );
  assert.equal(report.status, "done");
  await mergeRun(RUN_ID, root);
  const { stdout: status } = await run(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: root },
  );
  // A squash merge stages the old deletion; the reset must unstage it too.
  assert.doesNotMatch(status, /^D /m);
  assert.doesNotMatch(status, /^A /m);
  assert.match(status, /^ D old\.txt$/m);
  assert.match(status, /\?\? new\.txt/);
  assert.equal(await readFile(join(root, "new.txt"), "utf8"), "old\n");
});

test("branches whose file and directory paths overlap refuse before merging", async (t) => {
  const root = await repo(t);
  const report = await runRun(
    runOf(["a", "b"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    async (task, ctx) => {
      if (task.id === "a") {
        await mkdir(join(ctx.cwd, "dir"), { recursive: true });
        await writeFile(join(ctx.cwd, "dir", "file.txt"), "a\n");
      } else {
        await writeFile(join(ctx.cwd, "dir"), "b\n");
      }
      return { stopReason: "end_turn" };
    },
  );
  assert.equal(report.status, "done");

  await assert.rejects(mergeRun(RUN_ID, root), /touched by both/);
  assert.equal(await git(root, "status", "--porcelain"), "");
});

test("a dirty file where a task branch needs a directory refuses", async (t) => {
  const root = await repo(t);
  await runRun(
    runOf(["a"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    async (_task, ctx) => {
      await mkdir(join(ctx.cwd, "dir"), { recursive: true });
      await writeFile(join(ctx.cwd, "dir", "file.txt"), "work\n");
      return { stopReason: "end_turn" };
    },
  );

  // The main worktree has no dir/ yet; an untracked file named `dir` is still
  // in the tree position a task branch would create `dir/file.txt` under.
  await writeFile(join(root, "dir"), "mine\n");
  await assert.rejects(mergeRun(RUN_ID, root), /working tree has changes/);
  assert.equal(await readFile(join(root, "dir"), "utf8"), "mine\n");
});

test("advanced HEAD changes that conflict with a task branch refuse before merging", async (t) => {
  const root = await repo(t);
  const report = await runRun(
    runOf(["a"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    writer("shared.txt"),
  );
  assert.equal(report.status, "done");

  // Move main ahead with the same path after the run: the working tree is
  // clean, but the committed HEAD change is exactly the conflict preflight must
  // catch before Git starts a squash merge.
  await writeFile(join(root, "shared.txt"), "main\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "main work");
  const head = await git(root, "rev-parse", "HEAD");

  await assert.rejects(
    mergeRun(RUN_ID, root),
    /current HEAD has changes on shared\.txt/,
  );
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(
    await git(root, "status", "--porcelain", "--untracked-files=all"),
    "",
  );
  assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "main\n");
});

test("advanced HEAD file/directory overlap refuses before merging", async (t) => {
  const root = await repo(t);
  const report = await runRun(
    runOf(["a"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    async (_task, ctx) => {
      await mkdir(join(ctx.cwd, "dir"), { recursive: true });
      await writeFile(join(ctx.cwd, "dir", "file.txt"), "work\n");
      return { stopReason: "end_turn" };
    },
  );
  assert.equal(report.status, "done");

  // The task branch will add dir/file.txt; main now owns a committed file named
  // dir. Git would hit a file/directory conflict, so preflight must refuse.
  await writeFile(join(root, "dir"), "main\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "main has a file named dir");
  const head = await git(root, "rev-parse", "HEAD");

  await assert.rejects(
    mergeRun(RUN_ID, root),
    /current HEAD has changes on dir/,
  );
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(
    await git(root, "status", "--porcelain", "--untracked-files=all"),
    "",
  );
  assert.equal(await readFile(join(root, "dir"), "utf8"), "main\n");
});

test("rollback removes a stale SQUASH_MSG", async (t) => {
  const root = await repo(t);
  const report = await runRun(
    runOf(["a", "b"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    perTaskWriter,
  );
  assert.equal(report.status, "done");

  // A staged unrelated change makes Git's multi-branch octopus merge refuse.
  // That failure goes through rollback but does not create SQUASH_MSG itself;
  // pre-seed one so the test proves rollback also clears stale squash state.
  await writeFile(join(root, "unrelated.txt"), "staged\n");
  await git(root, "add", "unrelated.txt");
  const squashMsg = join(
    root,
    await git(root, "rev-parse", "--git-dir"),
    "SQUASH_MSG",
  );
  await writeFile(squashMsg, "stale squash message\n");
  const head = await git(root, "rev-parse", "HEAD");

  await assert.rejects(
    mergeRun(RUN_ID, root),
    /merge failed and was rolled back/,
  );
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(existsSync(squashMsg), false);
  const status = await git(
    root,
    "status",
    "--porcelain",
    "--untracked-files=all",
  );
  assert.match(status, /^A {2}unrelated\.txt$/m);
});

test("a run record copied from another repo is refused", async (t) => {
  const root = await repo(t);
  await runRun(
    runOf(["a"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    perTaskWriter,
  );

  const recordPath = join(root, ".kapelle", "runs", RUN_ID, "run.json");
  const record = JSON.parse(await readFile(recordPath, "utf8")) as {
    root: string;
  };
  record.root = "/somewhere/else";
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  await assert.rejects(mergeRun(RUN_ID, root), /created in/);
});

test("a missing run record is a clear error", async (t) => {
  const root = await repo(t);
  await assert.rejects(mergeRun(RUN_ID, root), /no run record/);
});

test("merge refuses a run that is still going, naming the task (M2-6)", async (t) => {
  const root = await repo(t);
  let refusal: string | undefined;
  await runRun(
    runOf(["a"]),
    { cwd: root, runId: RUN_ID, bus: createEventBus() },
    async (_task, ctx) => {
      // Mid-task, so the record on disk says `running`. Before M2-6 no record
      // existed until the run was over, and merge said "Run it first" — which
      // reads as "you never ran it", not "it is running now".
      refusal = await mergeRun(RUN_ID, root).then(
        () => undefined,
        (err: Error) => err.message,
      );
      await writeFile(join(ctx.cwd, "a.txt"), "work\n");
      return { stopReason: "end_turn" };
    },
  );

  assert.match(String(refusal), /unfinished task: a \(running\)/);
});
