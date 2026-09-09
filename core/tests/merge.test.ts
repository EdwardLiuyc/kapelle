/**
 * Merge tests — story M1c-3, issue #27.
 *
 * Against real git, like `core/tests/worktree.test.ts`: merge's claims are
 * about what git does with refs, the index and the working tree.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await writeFile(join(dir, ".gitignore"), ".agent-team/\n");
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

  const record = join(root, ".agent-team", "runs", RUN_ID, "run.json");
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
    await readFile(
      join(root, ".agent-team", "runs", RUN_ID, "run.json"),
      "utf8",
    ),
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

test("a missing run record is a clear error", async (t) => {
  const root = await repo(t);
  await assert.rejects(mergeRun(RUN_ID, root), /no run record/);
});
