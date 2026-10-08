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
 *    terminal (`killed`, M5-5: a status only this pass writes, so a client
 *    can tell a run its daemon died under from one that failed) with
 *    `endedAt` = recovery time, which is also what makes
 *    the run visible to the restore scan that follows.
 * 3. **Worktrees.** `git worktree list` is reconciled against the records: a
 *    run that is terminal **and** past the retention window loses its
 *    worktree, its branches and its run directory (log included, M2-2's only
 *    disk bound); a run inside the window keeps all of it. A worktree with no
 *    readable record is an orphan: a clean one still on a branch loses its
 *    checkout but keeps that branch, and one that is dirty or on a detached
 *    HEAD — where the work is on no ref to keep — is kept and named.
 * 4. **Rooms left live** (M6-7a, R46). A `room.json` that still reads
 *    `active` belongs to a daemon that died. It is rewritten as `crashed`
 *    has it: the room and each idle participant `paused`, each busy one
 *    `killed`. Every killed participant's checkout, a crash's or a
 *    shutdown's, gets one notice when git left its `index.lock` behind; the
 *    file is kept, since a git started by the harness's shell may still
 *    run. Nothing is added to the room's log, as for runs (M5-5). Every
 *    checkout under a room with a record is kept: it is not an orphan.
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

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { resolveRetentionMs } from "./config.ts";
import { branchName } from "./ids.ts";
import {
  crashed,
  type RoomRecord,
  readRoomRecord,
  writeRoomRecord,
} from "./room.ts";
import { stateDirFor } from "./runtime.ts";
import { changedPaths } from "./worktree.ts";

const run = promisify(execFile);

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * The retention window when neither `KAPELLE_RETENTION_MS` nor the
 * repository's `.kapelle/config.json` names one (decided at pickup
 * 2026-09-16, raised to 30 days by the developer the same day; the knob
 * landed with M2-7).
 */
export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface SweepOptions {
  /** Repository roots to reconcile, usually `readRepos()`. */
  repos: readonly string[];
  /** The previous daemon's `children.json`; nothing is read outside it. */
  childrenFile: string;
  /** Overrides the per-repo `KAPELLE_*`/config value; the tests use it. */
  retentionMs?: number;
  /** Injectable clock, so the retention boundary is a test and not a wait. */
  now?: number;
  onNotice?: (text: string) => void;
  /**
   * Asks the operator a yes/no question, when there is one to ask (#129).
   *
   * Only `sweepStranded` uses it, and only `daemon.ts` supplies it — and only
   * on a TTY, which `kapelle daemon start` has and a background daemon does
   * not. Absent, every stranded workspace is reported and kept: this is the
   * one place the sweep would delete a checkout it cannot prove is debris,
   * and it does not guess.
   */
  ask?: (question: string) => Promise<boolean>;
}

/**
 * A process's start time, as `ps` prints it — `null` when it cannot be read
 * (the process is gone, or `ps` is not answering).
 *
 * `ps` rather than `/proc`: one implementation for both supported platforms,
 * and equality is all the sweep needs. Both reads are normalized to `C`/UTC,
 * so a locale- or timezone-formatted start time compares equal across daemon
 * processes and a recycled pid does not.
 *
 * **Asynchronous because of its other caller.** `daemon.ts` records the
 * identity from the `_client_harness_spawned` listener, and a synchronous
 * fork+exec there blocks the event loop for every other run — SSE writes and
 * permission answers included — on the spawn of each task's harness.
 */
export async function processIdentity(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
    });
    const identity = stdout.trim();
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

/** What the sweep managed to do to a harness whose identity it verified. */
type StopOutcome = "gone" | "killed" | "survived";

/**
 * SIGTERM, half a second, then SIGKILL.
 *
 * **Not `AcpAgent.stop()`'s order**, which closes stdin first and only SIGKILLs
 * a harness still alive after 5 s, and never sends SIGTERM at all. Closing
 * stdin is the stop that works — §M2-4 measured SIGTERM leaving opencode's
 * shell command alive where end of file left nothing — but the sweep inherits
 * no pipe to a process it did not spawn, so signals are all it has. The grace
 * is short for the same reason: SIGTERM is the signal measured not to be
 * enough, so waiting the harness's own 5 s on it would only delay the boot.
 *
 * Returns what actually happened instead of assuming the signal worked:
 * `gone` when the pid exited before it could be signalled, `killed` once it
 * is gone or a fatal signal was delivered, `survived` when it could not be
 * signalled at all.
 */
async function terminate(pid: number): Promise<StopOutcome> {
  if (!isAlive(pid)) return "gone";
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return isAlive(pid) ? "survived" : "gone";
  }
  for (let i = 0; i < 20 && isAlive(pid); i++) {
    await new Promise((ok) => setTimeout(ok, 25));
  }
  if (!isAlive(pid)) return "killed";
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return isAlive(pid) ? "survived" : "killed";
  }
  // The kernel took a fatal signal; a zombie it leaves is its parent's to
  // reap, not a harness still running.
  return "killed";
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
    if (!isNumber(pid) || !Number.isInteger(pid) || pid <= 0) continue;
    // S14's shape is `{pid, kind, ownerId, unitId}`. A legacy
    // `{pid, runId, taskId}` entry — written by a daemon from before rooms
    // landed — is read as a run, so an upgrade never strands a live harness.
    const kind = raw.kind === "room" ? "room" : "run";
    const owner = isString(raw.ownerId)
      ? raw.ownerId
      : isString(raw.runId)
        ? raw.runId
        : "unknown";
    const unit = isString(raw.unitId)
      ? raw.unitId
      : isString(raw.taskId)
        ? raw.taskId
        : "unknown";
    const where =
      kind === "room"
        ? `room ${owner}, participant ${unit}`
        : `run ${owner}, task ${unit}`;
    // Without the recorded identity this cannot prove the pid is the harness,
    // and a recycled pid would make the signal land on a stranger — so an
    // unverifiable pid is left alive, which is the safer of two bad answers.
    // **Never silently**: `children.json` is deleted a few lines down, so this
    // notice is the last trace of a harness someone may have to stop by hand.
    const startedAt = raw.startedAt;
    if (!isString(startedAt)) {
      if (isAlive(pid)) {
        onNotice(
          `harness pid ${pid} (${where}) is alive but was recorded with no ` +
            `start time, so it cannot be told apart from a reused pid; left ` +
            `alone — stop it by hand if it is still running`,
        );
      }
      continue;
    }
    if ((await processIdentity(pid)) !== startedAt) {
      if (isAlive(pid)) {
        onNotice(
          `pid ${pid} (${where}) is alive but no longer the recorded ` +
            `harness; left alone`,
        );
      }
      continue;
    }
    const stopped = await terminate(pid);
    if (stopped === "killed") {
      onNotice(
        `killed harness pid ${pid} (${where}) left by a previous daemon`,
      );
    } else if (stopped === "survived") {
      onNotice(
        `harness pid ${pid} (${where}) could not be stopped; stop it by hand`,
      );
    }
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

/**
 * When a record's retention window starts: its `endedAt`, falling back to its
 * `startedAt`.
 *
 * The fallback is what keeps a record mortal. A terminal record with no
 * readable `endedAt` — written before M2-6 added the field, or hand-edited
 * since — is otherwise never past the window *and* never an orphan either,
 * because its worktree does have a record; it would keep its checkout, its
 * branches and its `events.jsonl` forever, and retention is M2-2's only disk
 * bound. `null` only when neither stamp parses, which is a record the sweep
 * cannot date at all and reports rather than reaps.
 */
function terminalSince(record: RunRecord): number | null {
  for (const value of [record.endedAt, record.startedAt]) {
    if (!isString(value)) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Rewrite with temp file plus `rename`, the shape `core/run.ts` uses: a reader
 * racing the sweep sees the old record or the new one, never half of either.
 *
 * The temp name carries this process's pid because the sweep is **not** the
 * only writer of `run.json`: a `node cli.ts run --file` run in an added
 * repository writes the same file on every task transition, and a shared
 * `run.json.tmp` is exactly how two processes turn one atomic write into a
 * torn one.
 *
 * ponytail: the pid suffix keeps the write atomic, not the decision. A CLI run
 * that is genuinely live still reads as `running` to a daemon booting beside
 * it and is marked `killed` under it. Closing that needs the writer's pid in
 * the record itself; M2-7 landed as config and did not add one, so this
 * stays open until a record carries its writer.
 */
async function writeRecord(path: string, record: RunRecord): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
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

/**
 * Worktrees under `<stateDirFor(root)>/wt`, after pruning vanished checkouts.
 *
 * `null` — not `[]` — when git could not answer, because the two mean opposite
 * things to every caller below. An empty list says "this run owns no
 * checkouts", which sends `reapRun` straight to `rmSync` and `branch -D`,
 * removing checkouts behind git's back and leaving stale `.git/worktrees`
 * admin entries; and it makes every real checkout look like an orphan. A
 * repository whose worktrees cannot be listed is left for the next boot.
 */
async function managedWorktrees(
  pass: RepoPass,
): Promise<ManagedWorktree[] | null> {
  const { root, onNotice } = pass;
  try {
    // An admin entry whose working tree is gone is what plain `git worktree
    // prune` exists for; clearing it first keeps the list below honest.
    await git(root, ["worktree", "prune"]);
    const out = await git(root, ["worktree", "list", "--porcelain"]);
    const wtRoot = join(stateDirFor(root), "wt");
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
    return null;
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
  // **A clean checkout is not the same as an empty one, and "the branch is
  // kept" only holds while HEAD is still on a branch.** `release`
  // (`core/worktree.ts`) refuses the same way and for the same measured reason
  // (#85): an agent that ran `git checkout <sha>` and committed left that work
  // on no ref at all, and removing the checkout takes its reflog with it, so
  // the commits become unreachable. Orphans are precisely the `kill -9` case,
  // which is when an agent is most likely to have been interrupted mid-move.
  const on = await tryGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (on === null) {
    onNotice(
      `leaving orphan worktree ${path}: it is on a detached HEAD, so any ` +
        `commit there is on no branch and removing it would lose the work`,
    );
    return;
  }
  try {
    await git(root, ["worktree", "remove", "--force", path]);
  } catch (err) {
    onNotice(`cannot remove orphan worktree ${path}: ${messageOf(err)}`);
    return;
  }
  onNotice(`removed orphan worktree ${path}; its branch ${on} is kept`);
}

/** `git`, but a failure is an answer (`null`) rather than a throw. */
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const out = await git(cwd, args);
    return out.trim();
  } catch {
    return null;
  }
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
  rmSync(join(stateDirFor(root), "wt", id), { recursive: true, force: true });

  await dropBranches(root, id, record, onNotice);

  rmSync(join(runsDir, id), { recursive: true, force: true });
  onNotice(`reaped run ${id}`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout;
}

/** Every run record under one repository, or `null` when the directory cannot be read. */
function readRecords(pass: RepoPass): Map<string, RunRecord | null> | null {
  const { runsDir, onNotice } = pass;
  const records = new Map<string, RunRecord | null>();
  let ids: string[] = [];
  try {
    ids = readdirSync(runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return records;
    onNotice(`skipping runs under ${runsDir}: ${messageOf(err)}`);
    return null;
  }
  for (const id of ids) {
    records.set(id, readRecord(join(runsDir, id, "run.json"), id));
  }
  return records;
}

/**
 * A run left mid-flight is terminal from here on: `killed`, and so is each
 * task it had running, with a fresh `endedAt`, which is also what keeps it
 * inside the retention window. `killed` is a record word like `queued` and
 * `running` — `core/run.ts` never settles on it — and it tells a client the
 * daemon died under the run rather than that the run failed (M5-5, #137).
 * `events.jsonl` is left alone: a `_client_run_finished` the run never wrote
 * would be a lie, and a stream that ends without one already means "ask
 * `GET /runs/:id`".
 */
async function markCrashed(
  records: Map<string, RunRecord | null>,
  pass: RepoPass,
): Promise<void> {
  const { runsDir, now, onNotice } = pass;
  for (const [id, record] of records) {
    if (record?.status !== "running") continue;
    const rewritten: RunRecord = {
      ...record,
      status: "killed",
      endedAt: new Date(now).toISOString(),
      tasks: taskEntries(record).map((task) =>
        task.status === "running" ? { ...task, status: "killed" } : task,
      ),
    };
    // Isolated per record: one unwritable `run.json` — a full disk, a
    // read-only mount, the wrong owner — must not take this repository's
    // worktree reconciliation, reaping and orphan cleanup down with it, which
    // is what an escape to `sweepBoot`'s catch would do on this and every
    // later boot. The old record stays `running` and is retried next time.
    try {
      await writeRecord(join(runsDir, id, "run.json"), rewritten);
      records.set(id, rewritten);
    } catch (err) {
      onNotice(
        `cannot mark run ${id} in ${pass.root} as killed: ${messageOf(err)}`,
      );
    }
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
    // Only terminal runs are reapable. A `running` record can still be here:
    // `markCrashed` above isolates a write that failed, and a live
    // `cli.ts run --file` run in an added repository writes the same status.
    // Its worktree is the one thing this pass exists to keep, and `startedAt`
    // is no licence to remove it — the story reaps terminal runs only.
    if (record.status === "running") {
      pass.onNotice(
        `keeping run ${id} in ${pass.root}: it still reads running, so it ` +
          `is not terminal and retention does not apply`,
      );
      continue;
    }
    const since = terminalSince(record);
    if (since === null) {
      pass.onNotice(
        `keeping run ${id} in ${pass.root}: its record carries no readable ` +
          `startedAt or endedAt, so it cannot be dated against retention`,
      );
      continue;
    }
    if (pass.now - since <= pass.retentionMs) continue;
    try {
      await reapRun(id, record, managed, pass);
    } catch (err) {
      // Isolated like `markCrashed`: a directory that cannot be removed must
      // not take the repository's later records and orphan pass down with it.
      pass.onNotice(`cannot reap run ${id} in ${pass.root}: ${messageOf(err)}`);
    }
  }
}

/**
 * Step 4: rewrite each room a crash left `active`, and answer which rooms
 * have a record, so their checkouts are not taken for orphans. A record
 * that cannot be read is named and its room's checkouts are kept anyway:
 * the directory is ours, so whatever is in it is not an orphan's.
 */
async function sweepRooms(pass: RepoPass): Promise<Set<string>> {
  const { root, onNotice } = pass;
  const dir = join(stateDirFor(root), "rooms");
  const kept = new Set<string>();
  let ids: string[];
  try {
    ids = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      onNotice(`skipping rooms under ${dir}: ${messageOf(err)}`);
    }
    return kept;
  }
  for (const id of ids) {
    const file = join(dir, id, "room.json");
    if (!existsSync(file)) continue;
    kept.add(id);
    let record: RoomRecord;
    try {
      record = readRoomRecord(file);
    } catch (err) {
      onNotice(`skipping ${file}: ${messageOf(err)}`);
      continue;
    }
    const fixed = crashed(record);
    let changed = fixed !== record;
    // A crash or a shutdown's grace can kill a turn. Once per lock: the
    // notice stays in the record while the file does, and goes at the boot
    // after it is deleted, revived or not.
    for (const p of fixed.participants) {
      const noted = p.notices.filter(isLockNotice);
      if (p.status !== "killed" && noted.length === 0) continue;
      const lock = await indexLock(p.worktree);
      if (!lock && noted.length > 0) {
        changed = true;
        p.notices = p.notices.filter((n) => !isLockNotice(n));
      } else if (lock && !noted.some((n) => n.text.includes(lock))) {
        changed = true;
        p.notices = [...p.notices, { text: lockNotice(lock) }];
      }
    }
    if (!changed) continue;
    try {
      writeRoomRecord(file, fixed);
    } catch (err) {
      onNotice(
        `cannot mark room ${id} in ${root} as paused: ${messageOf(err)}`,
      );
    }
  }
  return kept;
}

const LOCK_NOTICE_START = "git left ";

/** The notice for a lock a cut turn left. */
const lockNotice = (lock: string) =>
  `${LOCK_NOTICE_START}${lock} when this participant's turn was cut; git ` +
  "refuses to commit in this checkout while it is there. Check that no git " +
  "process still runs in it, then delete the file.";

/** Whether `notice` is one `lockNotice` wrote. */
const isLockNotice = (notice: { text: string }) =>
  notice.text.startsWith(LOCK_NOTICE_START) &&
  notice.text.includes("index.lock when this participant's turn was cut");

/** The checkout's `index.lock`, when git left one, or `null`. */
async function indexLock(worktree: string): Promise<string | null> {
  const gitDir = await tryGit(worktree, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir === null) return null;
  const lock = join(gitDir, "index.lock");
  return existsSync(lock) ? lock : null;
}

/** Steps 2 to 4 for one repository. */
async function sweepRepo(
  root: string,
  retentionMs: number,
  now: number,
  onNotice: (text: string) => void,
): Promise<void> {
  const pass: RepoPass = {
    root,
    runsDir: join(stateDirFor(root), "runs"),
    retentionMs,
    now,
    onNotice,
  };
  // Before the runs: a runs directory that cannot be read must not leave a
  // crashed room reading `active`.
  const rooms = await sweepRooms(pass);
  const records = readRecords(pass);
  if (records === null) {
    onNotice(`skipping reap and orphan cleanup in ${root} until the next boot`);
    return;
  }
  await markCrashed(records, pass);

  const managed = existsSync(join(stateDirFor(root), "wt"))
    ? await managedWorktrees(pass)
    : [];
  // Records were still worth marking — that needs no git — but nothing below
  // is safe without the list: see `managedWorktrees` on why `null` is not `[]`.
  if (managed === null) {
    onNotice(`skipping reap and orphan cleanup in ${root} until the next boot`);
    return;
  }

  await reapExpired(records, managed, pass);

  // Orphans last: a run reaped just above may have failed to remove a
  // checkout, in which case its record is still there and it is not an orphan.
  for (const worktree of managed) {
    if (records.get(worktree.runId) || rooms.has(worktree.runId)) continue;
    await reconcileOrphan(worktree.path, pass);
  }
}

/**
 * A workspace whose repository is no longer at the path that keys it (#129).
 *
 * State is keyed on the repository's path (`stateDirFor`), which is the
 * decision that makes this case exist: a rename changes the key, and the old
 * workspace — possibly holding the only copy of a failed task's work — is
 * orphaned. A path that is gone reads identically for a rename, a move and a
 * delete, and those want opposite answers, so this **never deletes on its own
 * judgement**. With an asker it asks; without one it reports and keeps.
 */
async function sweepStranded(
  root: string,
  onNotice: (text: string) => void,
  ask?: (question: string) => Promise<boolean>,
): Promise<void> {
  const workspace = stateDirFor(root);
  // A repository that never ran leaves nothing behind, so there is nothing to
  // report and nobody to interrupt.
  if (!existsSync(workspace)) return;

  const where = `${root} is gone, but its kapelle workspace is still at ${workspace}`;
  if (ask && (await ask(`${where}. Remove it?`))) {
    try {
      rmSync(workspace, { recursive: true, force: true });
      onNotice(`removed the stranded workspace ${workspace}`);
    } catch (err) {
      onNotice(`cannot remove ${workspace}: ${messageOf(err)}`);
    }
    return;
  }

  // Both endings get an exact command. The move is one verb rather than a
  // printed `mv`, because `mv` alone leaves every checkout `prunable` and the
  // next `git worktree prune` deletes the work it just moved (measured
  // 2026-09-20; `moveWorkspace` in `core/worktree.ts` does the repair).
  onNotice(
    `${where}. It holds that repository's worktrees and run records, and ` +
      `nothing will delete it. If you moved or renamed the repository: ` +
      `kapelle workspace move ${root} <new-path>. If you deleted it: ` +
      `rm -rf ${workspace}.`,
  );
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
    retentionMs: overrideRetentionMs,
    now = Date.now(),
    onNotice = (text: string) => console.error(text),
  } = options;

  // Caught like a repository: `sweepChildren` removes files and signals
  // processes, and the file header's promise is that nothing here throws — an
  // unhandled rejection out of the boot path would exit past `daemon.ts`'s
  // `orExit` and leave the claim file behind.
  try {
    await sweepChildren(childrenFile, onNotice);
  } catch (err) {
    onNotice(`cannot sweep ${childrenFile}: ${messageOf(err)}`);
  }
  for (const root of repos) {
    try {
      // The repository itself is gone — moved, renamed, or deleted. Its
      // workspace is not, and the three cases are indistinguishable from
      // here, so nothing is reaped without an answer (#129).
      if (!existsSync(root)) {
        await sweepStranded(root, onNotice, options.ask);
        continue;
      }
      // M2-7: per repository. An explicit option (tests) wins, then
      // `KAPELLE_RETENTION_MS`, then that repo's `.kapelle/config.json`,
      // then the built-in — and a bad config skips only this repo.
      const retentionMs =
        overrideRetentionMs ?? resolveRetentionMs(root) ?? DEFAULT_RETENTION_MS;
      await sweepRepo(root, retentionMs, now, onNotice);
    } catch (err) {
      onNotice(`cannot sweep ${root}: ${messageOf(err)}`);
    }
  }
}
