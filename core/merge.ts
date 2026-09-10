/**
 * Merge — story M1c-3, issue #27.
 *
 * `kapelle merge <runId> --squash` lands a run's task branches as combined,
 * unstaged working-tree changes without creating a commit. It is never
 * automatic: the branches are the run's output, and landing them is a separate
 * operator act.
 *
 * Merge reads the run record written by `core/run.ts` (`run.json`). It refuses
 * if any task is not `done`/`warned`, if two branches touch the same file or
 * overlapping file/directory positions, if the working tree already has
 * changes in a position a branch touches, or if the current HEAD has committed
 * changes in such a position since the run's base. Only after every preflight
 * passes does it run git's squash merge, then `git reset` so the combined
 * result is unstaged. A merge that still fails is rolled back over the touched
 * paths.
 */

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertRunId } from "./ids.ts";
import { changedPaths, STATE_DIR } from "./worktree.ts";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

interface RecordTask {
  id: string;
  status: string;
  branch?: string;
  baseSha?: string;
}

interface RunRecord {
  runId: string;
  root: string;
  tasks: RecordTask[];
}

/** Merge a run's branches into the current working tree, unstaged. */
export async function mergeRun(runId: string, cwd: string): Promise<void> {
  const record = await readRunRecord(runId, cwd);
  const release = record.tasks.filter(
    (t) => t.status === "done" || t.status === "warned",
  );
  const unfinished = record.tasks.filter(
    (t) => t.status !== "done" && t.status !== "warned",
  );

  if (unfinished.length > 0) {
    throw new Error(
      `run ${runId} has unfinished task${unfinished.length === 1 ? "" : "s"}: ` +
        `${unfinished.map((t) => `${t.id} (${t.status})`).join(", ")}. ` +
        `Inspect or finish them before merging.`,
    );
  }

  const touchedBy = new Map<string, string>();
  for (const task of release) {
    if (!task.branch || !task.baseSha) {
      throw new Error(
        `run record for ${runId} is missing branch/base for ${task.id} — ` +
          `the task may have been left on another branch. Inspect before merging.`,
      );
    }
    const files = await changedFiles(record.root, task);
    for (const file of files) {
      const other = conflictTask(file, touchedBy);
      if (other !== undefined) {
        throw new Error(
          `cannot merge ${runId}: ${file} is touched by both ${other} and ${task.id}.`,
        );
      }
      touchedBy.set(file, task.id);
    }
  }

  const dirty = await changedPaths(record.root);
  const conflicts = dirty.filter(
    (path) => conflictTask(path, touchedBy) !== undefined,
  );
  if (conflicts.length > 0) {
    throw new Error(
      `working tree has changes on file${conflicts.length === 1 ? "" : "s"} ` +
        `a task branch touches: ${conflicts.join(", ")}. Commit or stash them first.`,
    );
  }

  // The working tree can be clean while current HEAD has moved past the run's
  // base. Those committed changes can still collide with a task branch (for
  // example, HEAD adds file `dir` while a task branch adds `dir/file.txt`), so
  // refuse before git's squash merge starts.
  for (const task of release) {
    const headFiles = await changedFilesBetween(
      record.root,
      task.baseSha as string,
      "HEAD",
      `on current HEAD since ${task.baseSha}`,
    );
    for (const path of headFiles) {
      const other = conflictTask(path, touchedBy);
      if (other !== undefined) {
        throw new Error(
          `cannot merge ${runId}: current HEAD has changes on ${path}, ` +
            `conflicting with ${other}. Move or merge those changes before running merge.`,
        );
      }
    }
  }

  const branches = release.map((t) => t.branch as string);
  const touched = [...touchedBy.keys()];
  try {
    await git(record.root, ["merge", "--squash", "--no-commit", ...branches]);
    // The story's contract is "unstaged": squash merge stages, so reset the
    // touched paths back to the working tree without disturbing unrelated
    // changes that were already staged.
    if (touched.length > 0) {
      await git(record.root, ["reset", "--", ...touched]);
    }
  } catch (err) {
    const original = err instanceof Error ? err.message : String(err);
    try {
      await restoreTouched(record.root, touched);
    } catch (rollbackErr) {
      throw new Error(
        `merge failed and rollback also failed: ${
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr)
        } (original: ${original})`,
      );
    }
    throw new Error(`merge failed and was rolled back: ${original}`);
  }
}

async function readRunRecord(runId: string, cwd: string): Promise<RunRecord> {
  assertRunId(runId);
  const root = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) {
    throw new Error(`${cwd} is not a git repository.`);
  }

  const path = join(root, STATE_DIR, "runs", runId, "run.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`no run record for ${runId} at ${path}. Run it first.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`run record ${path} is not valid JSON: ${messageOf(err)}`);
  }

  const object = asObject(parsed, "run record");
  const recordedRunId = requiredString(object.runId, "runId");
  if (recordedRunId !== runId) {
    throw new Error(
      `run record ${path} is for ${recordedRunId}, not ${runId}.`,
    );
  }
  const recordedRoot = requiredString(object.root, "root");
  if (recordedRoot !== root) {
    throw new Error(
      `run record ${path} was created in ${recordedRoot}, not ${root}. ` +
        `Refusing to merge a copied or misplaced record.`,
    );
  }
  if (!Array.isArray(object.tasks) || object.tasks.length === 0) {
    throw new Error(`run record ${path}: "tasks" must be a non-empty array.`);
  }

  const tasks = object.tasks.map((raw, index) => {
    const task = asObject(raw, `tasks[${index}]`);
    const id = requiredString(task.id, `tasks[${index}].id`);
    const status = requiredString(task.status, `tasks[${index}].status`);
    const branch =
      task.branch === undefined
        ? undefined
        : requiredString(task.branch, `tasks[${index}].branch`);
    const baseSha =
      task.baseSha === undefined
        ? undefined
        : requiredString(task.baseSha, `tasks[${index}].baseSha`);
    return { id, status, branch, baseSha };
  });

  return { runId, root, tasks };
}

async function changedFiles(root: string, task: RecordTask): Promise<string[]> {
  return changedFilesBetween(
    root,
    task.baseSha as string,
    task.branch as string,
    `by ${task.id}`,
  );
}

/** Files changed between two refs, with rename/copy preimages included. */
async function changedFilesBetween(
  root: string,
  from: string,
  to: string,
  label: string,
): Promise<string[]> {
  try {
    // `--name-status -z` is used instead of `--name-only`: renames report only
    // the destination with `--name-only`, but the preimage is just as touched
    // (a staged deletion after squash, and an overlap a branch really has).
    const { stdout } = await run(
      "git",
      ["diff", "--name-status", "-z", from, to],
      { cwd: root },
    );
    const entries = stdout.split("\0");
    const files: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const status = entries[i];
      if (!status) continue;
      const first = entries[++i];
      if (first === undefined) break;
      files.push(first);
      // Rename/copy lines carry both the source and destination paths.
      if (status.startsWith("R") || status.startsWith("C")) {
        const second = entries[++i];
        if (second !== undefined) files.push(second);
      }
    }
    return files;
  } catch (err) {
    throw new Error(
      `cannot read files changed ${label}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** The task that already touches a path in the same tree position, if any. */
function conflictTask(
  path: string,
  touchedBy: Map<string, string>,
): string | undefined {
  for (const [existing, taskId] of touchedBy) {
    if (pathsConflict(path, existing)) return taskId;
  }
  return undefined;
}

/** Two paths conflict when one is the other or one is under the other. */
function pathsConflict(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Put touched paths back to HEAD after a failed squash merge. */
async function restoreTouched(root: string, touched: string[]): Promise<void> {
  if (touched.length > 0) {
    const tracked = new Set(
      (
        await git(root, [
          "ls-tree",
          "-r",
          "-z",
          "--name-only",
          "HEAD",
          "--",
          ...touched,
        ])
      )
        .split("\0")
        .filter(Boolean),
    );
    // Clear index entries for every path the merge touched, including files that
    // only exist in the merge result. Preflight guarantees none of these paths
    // had pre-existing worktree changes we would be clobbering.
    await git(root, ["reset", "-q", "HEAD", "--", ...touched]);
    // Remove files the failed merge created that are not present at HEAD.
    await git(root, ["clean", "-f", "--", ...touched]);
    // Restore files that do exist at HEAD to their committed content.
    if (tracked.size > 0) {
      await git(root, ["checkout", "--", ...tracked]);
    }
  }
  // A squash merge can leave .git/SQUASH_MSG even when it fails. After a rollback
  // there is no squash commit to make, so remove the stale message or a later
  // unrelated `git commit` would consume it as its default message.
  const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
  await rm(join(gitDir, "SQUASH_MSG"), { force: true });
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} must be a non-empty string.`);
  }
  return value;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
