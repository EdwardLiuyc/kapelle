/**
 * Merge — story M1c-3, issue #27.
 *
 * `agent-team merge <runId> --squash` lands a run's task branches as combined,
 * unstaged working-tree changes without creating a commit. It is never
 * automatic: the branches are the run's output, and landing them is a separate
 * operator act.
 *
 * Merge reads the run record written by `core/run.ts` (`run.json`). It refuses
 * if any task is not `done`/`warned`, if two branches touch the same file, or
 * if the working tree already has changes on a file a branch touches. Only
 * after every preflight passes does it run git's squash merge, then `git
 * reset` so the combined result is unstaged.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
      const other = touchedBy.get(file);
      if (other !== undefined) {
        throw new Error(
          `cannot merge ${runId}: ${file} is touched by both ${other} and ${task.id}.`,
        );
      }
      touchedBy.set(file, task.id);
    }
  }

  const dirty = await changedPaths(record.root);
  const conflicts = dirty.filter((path) => touchedBy.has(path));
  if (conflicts.length > 0) {
    throw new Error(
      `working tree has changes on file${conflicts.length === 1 ? "" : "s"} ` +
        `a task branch touches: ${conflicts.join(", ")}. Commit or stash them first.`,
    );
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
    throw new Error(
      `merge failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  if (typeof object.root !== "string" || object.root === "") {
    throw new Error(`run record ${path}: "root" must be a non-empty string.`);
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
  try {
    const { stdout } = await run(
      "git",
      [
        "diff",
        "--name-only",
        "-z",
        task.baseSha as string,
        task.branch as string,
      ],
      { cwd: root },
    );
    return stdout.split("\0").filter(Boolean);
  } catch (err) {
    throw new Error(
      `cannot read files changed by ${task.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
