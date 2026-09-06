/**
 * Worktrees — story M1b-3, issue #19.
 *
 * One `git worktree` per task, at `.agent-team/wt/<runId>/<taskId>`, branched
 * off a base ref as `agent-team/<runId>/<taskId>` (`core/ids.ts`). This is the
 * seam `core/run.ts`'s `taskCwd` held open: before this file, every task in a
 * run shared one working directory and only non-colliding work was safe.
 *
 * **The state directory has to be invisible to git** (`docs/STORIES.md:932`).
 * `.agent-team/` sits inside the working tree of the repo being worked on, so
 * an unignored one would make the dirty-tree refusal below refuse on our own
 * files from the second run onward, and would put supervisor state into
 * M1b-4's diff cross-check. The preflight therefore **refuses with the fix in
 * the message** rather than appending the line itself: appending dirties the
 * very tree it is about to check, and is a write to someone's repository that
 * nobody asked for (`docs/STORIES.md:942`).
 *
 * **A cwd that cannot carry worktrees falls back rather than refusing**
 * (decided 2026-09-06, #19). Not a repo, or a repo with no commit to branch
 * from: the run proceeds in the shared cwd and says so once. Refusing would
 * make a git repository a precondition of the CLI's own suite, which drives
 * `--file` runs in plain `mkdtemp` directories (`integration/helpers.ts:36`).
 *
 * **The spawn transaction is in-memory only** (decided 2026-09-06, #19). A
 * task that produced nothing has its worktree *and* its branch removed, so a
 * harness that fails to start leaves neither behind. A supervisor killed with
 * `kill -9` mid-spawn can still orphan one; that is M2-5's crash-recovery
 * sweep, which needs the persisted run record M2-6 has not written yet.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { branchName } from "./ids.ts";
import type { TaskStatus } from "./run.ts";

const run = promisify(execFile);

/** Where supervisor state lives, relative to the repo root. Not exported —
 *  nothing outside this file names it yet; M1b-7's stderr logs will be the
 *  first, and can export it then. */
const STATE_DIR = ".agent-team";

/**
 * Which statuses give the worktree back.
 *
 * `done` and `warned` are the two the CLI exits 0 for (`run.ts:405`), and
 * teardown agrees with that rather than with a narrower reading of success.
 * Everything below them keeps its worktree so partial work stays inspectable.
 *
 * `warned` (M1b-4) and `timed_out` (M1c-1) have no producer in the tree yet.
 * They are handled here, not later, for the reason M1b-2 gave for shipping the
 * whole severity ordering ahead of its producers: the union is already the
 * contract, and a rung added afterwards rewrites this table and its test
 * rather than extending them.
 */
const RELEASES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "done",
  "warned",
]);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

/** `git` for the questions whose answer is the exit code — `check-ignore`,
 *  `rev-parse --verify` — where a non-zero exit is information, not a fault. */
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** One task's checkout, held from `acquire` to `release`. */
interface Held {
  path: string;
  branch: string;
  /** The commit the branch started at. `release` compares against it to tell
   *  a task that did nothing from one that failed with work worth keeping. */
  baseSha: string;
}

export interface Worktrees {
  /** Creates the worktree and its branch, and returns the path to run in.
   *  Throws — naming the ref — if `baseRef` does not resolve to a commit. */
  acquire(taskId: string, baseRef?: string): Promise<string>;
  /** Commits and removes on success, keeps on failure, and rolls back a task
   *  that produced nothing at all. Safe to call for a task never acquired. */
  release(taskId: string, status: TaskStatus): Promise<void>;
}

export interface WorktreeSetup {
  /** `null` when the cwd cannot carry worktrees; `notice` says why. */
  worktrees: Worktrees | null;
  notice?: string;
}

/**
 * Preflight, then a handle for the run.
 *
 * Returns a fallback with a notice when the cwd cannot carry worktrees.
 * **Throws** when it can but must not: `.agent-team/` tracked or unignored, or
 * a dirty working tree. The difference is deliberate — the first is a place
 * that never promised isolation, the second is a repository we would damage.
 */
export async function openWorktrees(
  cwd: string,
  runId: string,
): Promise<WorktreeSetup> {
  const root = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) {
    return {
      worktrees: null,
      notice:
        `${cwd} is not a git repository — every task runs in it directly, ` +
        `so tasks that touch the same files will collide.`,
    };
  }

  // An unborn HEAD is a repository with nothing to branch from. Same fallback
  // as no repository at all: `git worktree add` would fail per task, and one
  // notice up front beats N identical spawn failures.
  if ((await tryGit(root, ["rev-parse", "--verify", "HEAD"])) === null) {
    return {
      worktrees: null,
      notice:
        `${root} has no commits yet — nothing to branch from, so every task ` +
        `runs in it directly and tasks that touch the same files will collide.`,
    };
  }

  // Tracked is checked before ignored because it is the worse diagnosis and
  // `check-ignore` never reports a tracked path: without this, a committed
  // `.agent-team/` would be reported as merely missing from `.gitignore`, and
  // following that advice would leave it tracked *and* ignored.
  if ((await git(root, ["ls-files", "--", STATE_DIR])) !== "") {
    throw new Error(
      `${STATE_DIR}/ is tracked by git. It holds supervisor state — worktrees, ` +
        `logs, run records — and must not be committed. Run ` +
        `\`git rm -r --cached ${STATE_DIR}\`, add \`${STATE_DIR}/\` to ` +
        `.gitignore, and re-run.`,
    );
  }

  if (
    (await tryGit(root, ["check-ignore", "-q", "--", `${STATE_DIR}/`])) === null
  ) {
    throw new Error(
      `${STATE_DIR}/ is not ignored by git. Worktrees and supervisor state go ` +
        `there, and an unignored one would show up as your changes. Add ` +
        `\`${STATE_DIR}/\` to .gitignore and re-run.`,
    );
  }

  // `.agent-team/` is ignored by the check above, so it can never be the
  // reason this fires — the criterion that the supervisor's own state does not
  // trip its own refusal is met by ordering, not by a second exclusion list.
  const dirty = await git(root, ["status", "--porcelain"]);
  if (dirty !== "") {
    throw new Error(
      `the working tree at ${root} has uncommitted changes, and a run branches ` +
        `off a commit — the changes below would not reach any task. Commit or ` +
        `stash them and re-run.\n${dirty}`,
    );
  }

  const held = new Map<string, Held>();

  return {
    worktrees: {
      async acquire(taskId, baseRef = "HEAD") {
        const branch = branchName(runId, taskId);
        // Resolved to a sha, and the worktree created from the sha: a branch
        // used as a base could move between two tasks of the same run, which
        // would silently give them different starting points.
        const baseSha = await tryGit(root, [
          "rev-parse",
          "--verify",
          `${baseRef}^{commit}`,
        ]);
        if (baseSha === null) {
          throw new Error(
            `base ref ${JSON.stringify(baseRef)} does not resolve to a commit ` +
              `in ${root}.`,
          );
        }

        const path = join(root, STATE_DIR, "wt", runId, taskId);
        await git(root, ["worktree", "add", "-b", branch, path, baseSha]);
        held.set(taskId, { path, branch, baseSha });
        return path;
      },

      async release(taskId, status) {
        const task = held.get(taskId);
        if (!task) return;
        held.delete(taskId);

        const dirty = (await git(task.path, ["status", "--porcelain"])) !== "";
        const head = await git(task.path, ["rev-parse", "HEAD"]);
        const untouched = !dirty && head === task.baseSha;

        // Nothing was produced, so there is nothing to inspect. The branch
        // decision still keys on status: a done/warned task with an empty
        // diff leaves its branch at the base ref (#19), while a task that
        // failed before it wrote anything is the rollback half of the
        // transactional spawn — no worktree and no branch.
        if (untouched) {
          await removeWorktree(root, task.path);
          if (!RELEASES.has(status)) {
            await git(root, ["branch", "-D", task.branch]);
          }
          return;
        }

        if (!RELEASES.has(status)) return;

        // The commit is what makes "remove the worktree, keep the branch"
        // coherent: without it, removal either refuses on the dirty tree or
        // throws the work away, and M1c-3 would later merge a branch sitting
        // at its own base ref.
        if (dirty) {
          await git(task.path, ["add", "-A"]);
          await git(task.path, [
            "commit",
            "--no-verify",
            "-m",
            `agent-team: ${taskId} (${runId})`,
          ]);
        }
        await removeWorktree(root, task.path);
      },
    },
  };
}

/** `--force` because `git worktree remove` refuses while *ignored* files are
 *  present — a `node_modules/` the task installed would block every removal.
 *  Tracked work is committed before this runs; what --force discards is by
 *  definition what the repository was told not to keep. */
function removeWorktree(root: string, path: string): Promise<string> {
  return git(root, ["worktree", "remove", "--force", path]);
}
