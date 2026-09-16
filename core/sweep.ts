/**
 * The boot sweep — story M2-5, issue #35.
 *
 * The fuller version of "run `git worktree prune`". A daemon killed with
 * `kill -9` leaves three kinds of debris, and one boot pass reconciles all
 * three before the port opens:
 *
 * 1. **Live harnesses.** `children.json` (M2-4) names the pids that were
 *    running. Every measured harness exits when its stdin closes (§M2-4), but
 *    the file is the record for a build that does not — so a pid that is
 *    still the recorded process is signalled, and one that is not is left
 *    alone. A bare pid can be reused, so the daemon records `ps`'s start time
 *    at spawn and this pass compares it before sending anything.
 * 2. **Records left `running`.** M2-6 writes `run.json` on every task
 *    transition, so a crash leaves a record mid-flight. Those are rewritten
 *    terminal (`failed`, the status `core/run.ts` gives a task that died with
 *    its supervisor) with `endedAt` = recovery time, which is also what makes
 *    the run visible to the restore scan that follows.
 * 3. **Worktrees.** `git worktree list` is reconciled against the records: a
 *    run that is terminal **and** past the retention window loses its
 *    worktree, its branches and its run directory (log included, M2-2's only
 *    disk bound); a run inside the window keeps all of it. A worktree with no
 *    readable record is an orphan: a clean one loses its checkout but keeps
 *    its branch, and a dirty one is kept and named.
 *
 * **Whole-run reaping is ordered worktree-first.** If a checkout cannot be
 * removed, the record is kept too and the run is retried on the next boot —
 * deleting the record first would orphan the checkout, which is the one state
 * this pass cannot act on later.
 *
 * Nothing here throws on a bad repository: a daemon that refused to boot over
 * one record could not be reached by the request that fixes it, the same rule
 * `restoreRuns` follows.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { branchName } from "./ids.ts";
import { changedPaths, STATE_DIR } from "./worktree.ts";

const run = promisify(execFile);

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * How long a terminal run's state is kept (decided at pickup 2026-09-16,
 * raised to 30 days by the developer the same day). A constant until M2-7
 * gives the daemon-wide knobs a config file; this is the value it will load.
 */
export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface SweepOptions {
  /** Repository roots to reconcile, usually `readRepos()`. */
  repos: readonly string[];
  /** The previous daemon's `children.json`; nothing is read outside it. */
  childrenFile: string;
  retentionMs?: number;
  /** Injectable clock, so the retention boundary is a test and not a wait. */
  now?: number;
  onNotice?: (text: string) => void;
}

/**
 * A process's start time, as `ps` prints it — `null` when it cannot be read
 * (the process is gone, or `ps` is not answering).
 *
 * `ps` rather than `/proc`: one implementation for both supported platforms,
 * and equality is all the sweep needs. The two reads happen on the same
 * machine with the same locale, so a locale-formatted date compares equal to
 * itself and a recycled pid does not.
 */
export function processIdentity(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const identity = out.trim();
    return identity === "" ? null : identity;
  } catch {
    return null;
  }
}

/** Is `pid` a live process? `EPERM` means it is, and is someone else's. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGTERM, a moment, then SIGKILL — the order `AcpAgent.stop()` uses. */
async function terminate(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 20 && isAlive(pid); i++) {
    await new Promise((ok) => setTimeout(ok, 25));
  }
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Raced with its own exit.
  }
}

/** Step 1: the harnesses the previous daemon could not stop. */
async function sweepChildren(
  childrenFile: string,
  onNotice: (text: string) => void,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(childrenFile, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      onNotice(`cannot read ${childrenFile}: ${messageOf(err)}`);
    }
    rmSync(childrenFile, { force: true });
    return;
  }
  const entries =
    isObject(parsed) && Array.isArray(parsed.children) ? parsed.children : [];
  for (const raw of entries) {
    if (!isObject(raw)) continue;
    const pid = raw.pid;
    if (!isNumber(pid) || !Number.isInteger(pid)) continue;
    // Without the recorded identity this cannot prove the pid is the harness,
    // and a recycled pid would make the signal land on a stranger.
    const startedAt = raw.startedAt;
    if (!isString(startedAt)) continue;
    if (processIdentity(pid) !== startedAt) continue;
    await terminate(pid);
    onNotice(
      `killed harness pid ${pid} (run ${raw.runId}, task ` +
        `${raw.taskId}) left by a previous daemon`,
    );
  }
  rmSync(childrenFile, { force: true });
}

/**
 * A run record as read from disk. Only the fields the sweep uses are named;
 * every one is decoded where it is read, because a crash can leave the file
 * truncated or hand-edited, and `JSON.parse` is `unknown` until that decode.
 */
type RunRecord = Record<string, unknown>;

type TaskEntry = Record<string, unknown>;

/** Is `value` a JSON object (not `null`, not an array)? */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** The task objects in a record, ignoring anything malformed. */
function taskEntries(record: RunRecord): TaskEntry[] {
  if (!Array.isArray(record.tasks)) return [];
  return record.tasks.filter(isObject);
}

/** `run.json`, or `null` when it is missing, truncated or not this run's. */
function readRecord(path: string, id: string): RunRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(parsed)) return null;
    return parsed.runId === id && isString(parsed.status) ? parsed : null;
  } catch {
    return null;
  }
}

/** The record's `endedAt` as a time, or `null` when it is absent or invalid. */
function endedAtOf(record: RunRecord): number | null {
  const value = record.endedAt;
  if (!isString(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rewrite with temp file plus `rename`, the shape `core/run.ts` uses: a reader
 * racing the sweep sees the old record or the new one, never half of either.
 */
async function writeRecord(path: string, record: RunRecord): Promise<void> {
  const tmp = `${path}.tmp`;
  // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
  // pi-lens-ignore: no-raw-json-store-write
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** One managed checkout, keyed by the run that owns it. */
interface ManagedWorktree {
  path: string;
  runId: string;
}

/** One repository's sweep, in one bag so the helpers stay readable. */
interface RepoPass {
  root: string;
  runsDir: string;
  retentionMs: number;
  now: number;
  onNotice: (text: string) => void;
}

/** Worktrees under `<root>/.kapelle/wt`, after pruning vanished checkouts. */
async function managedWorktrees(pass: RepoPass): Promise<ManagedWorktree[]> {
  const { root, onNotice } = pass;
  try {
    // An admin entry whose working tree is gone is what plain `git worktree
    // prune` exists for; clearing it first keeps the list below honest.
    await git(root, ["worktree", "prune"]);
    const out = await git(root, ["worktree", "list", "--porcelain"]);
    const wtRoot = join(root, STATE_DIR, "wt");
    const managed: ManagedWorktree[] = [];
    for (const line of out.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length);
      const rel = relative(wtRoot, path);
      // The repository's own checkout is a `..` away and is never ours.
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) continue;
      const runId = rel.split(sep)[0];
      if (!runId) continue;
      managed.push({ path, runId });
    }
    return managed;
  } catch (err) {
    onNotice(`cannot reconcile worktrees in ${root}: ${messageOf(err)}`);
    return [];
  }
}

/**
 * Remove one orphan checkout. The branch stays: with no record, the sweep
 * cannot tell whether it carries work worth keeping (decided at pickup).
 */
async function reconcileOrphan(path: string, pass: RepoPass): Promise<void> {
  const { root, onNotice } = pass;
  let changed: string[];
  try {
    changed = await changedPaths(path);
  } catch (err) {
    onNotice(`cannot inspect orphan worktree ${path}: ${messageOf(err)}`);
    return;
  }
  if (changed.length > 0) {
    onNotice(`leaving orphan worktree ${path}: it has uncommitted changes`);
    return;
  }
  try {
    await git(root, ["worktree", "remove", "--force", path]);
  } catch (err) {
    onNotice(`cannot remove orphan worktree ${path}: ${messageOf(err)}`);
    return;
  }
  onNotice(`removed orphan worktree ${path}; its branch is kept`);
}

/** Does the repository have this exact local branch? */
async function hasBranch(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete every branch the run owns. A task killed mid-run never reached the
 * record write that carries `branch`, so its name is reconstructed from the
 * run and task ids (`core/ids.ts`); a task that never acquired one has no
 * branch to delete and is skipped.
 */
async function dropBranches(
  root: string,
  id: string,
  record: RunRecord,
  onNotice: (text: string) => void,
): Promise<void> {
  for (const task of taskEntries(record)) {
    const taskId = task.id;
    if (!isString(taskId)) continue;
    let branch = isString(task.branch) ? task.branch : null;
    if (branch === null) {
      try {
        branch = branchName(id, taskId);
      } catch {
        // An id the naming scheme refuses names no branch of ours.
        continue;
      }
    }
    try {
      if (!(await hasBranch(root, branch))) continue;
      await git(root, ["branch", "-D", branch]);
    } catch (err) {
      // A branch checked out somewhere else cannot be deleted, and the run is
      // still past retention; the record goes and the ref is left behind
      // rather than blocking the reap forever.
      onNotice(
        `cannot delete branch ${branch} for run ${id}: ${messageOf(err)}`,
      );
    }
  }
}

/** Remove a whole run past its window. Worktrees first; see the file header. */
async function reapRun(
  id: string,
  record: RunRecord,
  managed: readonly ManagedWorktree[],
  pass: RepoPass,
): Promise<void> {
  const { root, runsDir, onNotice } = pass;
  for (const worktree of managed) {
    if (worktree.runId !== id) continue;
    try {
      await git(root, ["worktree", "remove", "--force", worktree.path]);
    } catch (err) {
      onNotice(
        `cannot remove worktree ${worktree.path} for run ${id}; the run is ` +
          `kept for the next sweep: ${messageOf(err)}`,
      );
      return;
    }
  }
  // The checkouts are gone; the run's own husk of a directory may not be.
  rmSync(join(root, STATE_DIR, "wt", id), { recursive: true, force: true });

  await dropBranches(root, id, record, onNotice);

  rmSync(join(runsDir, id), { recursive: true, force: true });
  onNotice(`reaped run ${id}`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout;
}

/** Every run record under one repository, `null` where unreadable. */
function readRecords(pass: RepoPass): Map<string, RunRecord | null> {
  const { runsDir, onNotice } = pass;
  const records = new Map<string, RunRecord | null>();
  let ids: string[] = [];
  try {
    ids = readdirSync(runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      onNotice(`skipping runs under ${runsDir}: ${messageOf(err)}`);
    }
  }
  for (const id of ids) {
    records.set(id, readRecord(join(runsDir, id, "run.json"), id));
  }
  return records;
}

/**
 * A run left mid-flight is terminal from here on: `failed` (the status
 * `core/run.ts` gives a task that died with its supervisor) with a fresh
 * `endedAt`, which is also what keeps it inside the retention window.
 */
async function markCrashed(
  records: Map<string, RunRecord | null>,
  pass: RepoPass,
): Promise<void> {
  const { runsDir, now } = pass;
  for (const [id, record] of records) {
    if (record?.status !== "running") continue;
    const rewritten: RunRecord = {
      ...record,
      status: "failed",
      endedAt: new Date(now).toISOString(),
      tasks: taskEntries(record).map((task) =>
        task.status === "running" ? { ...task, status: "failed" } : task,
      ),
    };
    await writeRecord(join(runsDir, id, "run.json"), rewritten);
    records.set(id, rewritten);
  }
}

/** Reap every run whose window has passed. */
async function reapExpired(
  records: Map<string, RunRecord | null>,
  managed: readonly ManagedWorktree[],
  pass: RepoPass,
): Promise<void> {
  for (const [id, record] of records) {
    if (!record) continue;
    const endedAt = endedAtOf(record);
    if (endedAt === null || pass.now - endedAt <= pass.retentionMs) continue;
    await reapRun(id, record, managed, pass);
  }
}

/** Steps 2 and 3 for one repository. */
async function sweepRepo(
  root: string,
  retentionMs: number,
  now: number,
  onNotice: (text: string) => void,
): Promise<void> {
  const pass: RepoPass = {
    root,
    runsDir: join(root, STATE_DIR, "runs"),
    retentionMs,
    now,
    onNotice,
  };
  const records = readRecords(pass);
  await markCrashed(records, pass);

  const managed = existsSync(join(root, STATE_DIR, "wt"))
    ? await managedWorktrees(pass)
    : [];

  await reapExpired(records, managed, pass);

  // Orphans last: a run reaped just above may have failed to remove a
  // checkout, in which case its record is still there and it is not an orphan.
  for (const worktree of managed) {
    if (records.get(worktree.runId)) continue;
    await reconcileOrphan(worktree.path, pass);
  }
}

/**
 * Reconcile every added repository, then the previous daemon's children.
 * Called between the instance claim and `restoreRuns`, so no request ever
 * meets half-swept state.
 */
export async function sweepBoot(options: SweepOptions): Promise<void> {
  const {
    repos,
    childrenFile,
    retentionMs = DEFAULT_RETENTION_MS,
    now = Date.now(),
    onNotice = (text: string) => console.error(text),
  } = options;

  await sweepChildren(childrenFile, onNotice);
  for (const root of repos) {
    try {
      await sweepRepo(root, retentionMs, now, onNotice);
    } catch (err) {
      onNotice(`cannot sweep ${root}: ${messageOf(err)}`);
    }
  }
}
