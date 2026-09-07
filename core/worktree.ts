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
import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { branchName } from "./ids.ts";
import type { TaskStatus } from "./run.ts";

const run = promisify(execFile);

/** Where supervisor state lives, relative to the repo root. Exported for
 *  M1b-7's stderr logs, which live beside the worktrees (`core/run.ts`). */
export const STATE_DIR = ".agent-team";

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

/**
 * The working-tree state, and **never** a bare `status --porcelain`.
 *
 * `--porcelain` fixes the *format*, not the *content*: `status.showUntrackedFiles=no`
 * still empties the list, and a task whose whole output is new files then reads
 * as untouched — the checkout is removed with the work in it (measured
 * 2026-09-07, #85). `--untracked-files=all` cannot be weakened by anyone's
 * config, which is the only property a safety check may rely on. Ignored files
 * stay out, so `.agent-team/` is still invisible here.
 */
function statusOf(cwd: string): Promise<string> {
  return git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
}

/**
 * The tail both ignore refusals share, and the reason it is not just "re-run".
 *
 * Editing `.gitignore` is itself an uncommitted change, so the advice as first
 * written led straight into the dirty-tree refusal below — a fix whose own
 * result the next preflight rejects (#85). Committing settles it. The
 * `.git/info/exclude` alternative is offered because it is the one that leaves
 * no change to commit at all, which is what someone with a deliberately dirty
 * tree actually needs.
 */
const COMMIT_THEN =
  `commit that change, and re-run. To leave the working tree untouched ` +
  `instead, put the same line in .git/info/exclude, which is local to your ` +
  `clone and needs no commit.`;

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
  /** The checkout root — what `git worktree remove` is given. Not what the
   *  task runs in when `--cwd` named a subdirectory. */
  path: string;
  branch: string;
  /** The commit the branch started at. `release` compares against it to tell
   *  a task that did nothing from one that failed with work worth keeping. */
  baseSha: string;
}

export interface Worktrees {
  /** Creates the worktree and its branch, and returns the path to run in —
   *  the checkout root, or the same subdirectory inside it that `cwd` named.
   *  Throws — naming the ref — if `baseRef` does not resolve to a commit. */
  acquire(taskId: string, baseRef?: string): Promise<string>;
  /** Commits and removes on success, keeps on failure, and rolls back a task
   *  that produced nothing at all. Safe to call for a task never acquired.
   *  Returns a warning to print when it kept a checkout it meant to remove,
   *  and `null` when retention went as planned. */
  release(taskId: string, status: TaskStatus): Promise<string | null>;
}

export interface WorktreeSetup {
  /** `null` when the cwd cannot carry worktrees; `notice` says why. */
  worktrees: Worktrees | null;
  notice?: string;
  /** Where `.agent-team/` lives for this run — the repository root whenever
   *  git reports one (including the no-commit fallback), or the requested
   *  cwd itself when there is no repository at all. Returned because
   *  worktrees are not the only supervisor state kept there: M1b-7's stderr
   *  logs go beside them, and a caller that guessed `cwd` would split the
   *  directory in two whenever `--cwd` named a subdirectory. */
  root: string;
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
      root: cwd,
      notice:
        `${cwd} is not a git repository — every task runs in it directly, ` +
        `so tasks that touch the same files will collide.`,
    };
  }

  // Tracked is checked before ignored because it is the worse diagnosis and
  // `check-ignore` never reports a tracked path: without this, a committed
  // `.agent-team/` would be reported as merely missing from `.gitignore`, and
  // following that advice would leave it tracked *and* ignored. This runs
  // before the unborn-HEAD fallback too: `core/run.ts` writes `.agent-team/`
  // even when worktrees cannot exist, so an unignored one has to refuse here
  // rather than let the log directory create the state the preflight exists
  // to prevent.
  if ((await git(root, ["ls-files", "--", STATE_DIR])) !== "") {
    throw new Error(
      `${STATE_DIR}/ is tracked by git. It holds supervisor state — worktrees, ` +
        `logs, run records — and must not be committed. Run ` +
        `\`git rm -r --cached ${STATE_DIR}\`, add \`${STATE_DIR}/\` to ` +
        `.gitignore, ${COMMIT_THEN}`,
    );
  }

  if (
    (await tryGit(root, ["check-ignore", "-q", "--", `${STATE_DIR}/`])) === null
  ) {
    throw new Error(
      `${STATE_DIR}/ is not ignored by git. Worktrees and supervisor state go ` +
        `there, and an unignored one would show up as your changes. Add ` +
        `\`${STATE_DIR}/\` to .gitignore, ${COMMIT_THEN}`,
    );
  }

  // An unborn HEAD is a repository with nothing to branch from. Same fallback
  // as no repository at all: `git worktree add` would fail per task, and one
  // notice up front beats N identical spawn failures. The ignore/tracked
  // refusals above still run first for the reason given there — the log
  // directory is created no matter which fallback this ends in.
  if ((await tryGit(root, ["rev-parse", "--verify", "HEAD"])) === null) {
    return {
      worktrees: null,
      root,
      notice:
        `${root} has no commits yet — nothing to branch from, so every task ` +
        `runs in it directly and tasks that touch the same files will collide.`,
    };
  }

  // `.agent-team/` is ignored by the check above, so it can never be the
  // reason this fires — the criterion that the supervisor's own state does not
  // trip its own refusal is met by ordering, not by a second exclusion list.
  const dirty = await statusOf(root);
  if (dirty !== "") {
    throw new Error(
      `the working tree at ${root} has uncommitted changes, and a run branches ` +
        `off a commit — the changes below would not reach any task. Commit or ` +
        `stash them and re-run.\n${dirty}`,
    );
  }

  // Where `cwd` sits inside the repository, so each task's checkout can be
  // entered at the same place. Empty for a run started at the repo root, which
  // is every run today — `join(path, "")` is `path`.
  //
  // **Both sides are real paths before they are subtracted** (#85). `git
  // rev-parse --show-toplevel` resolves symlinks; `--cwd` is whatever string
  // was typed. Subtracting a real root from a symlinked cwd yields a prefix
  // full of `..`, and measured 2026-09-07 that walked one task into *another
  // task's checkout* — the collision worktrees exist to prevent, with the
  // escaping task's own branch left empty. `process.cwd()` is already real, so
  // this only ever changes an explicit `--cwd`.
  const prefix = relative(realpathSync(root), realpathSync(cwd));

  const held = new Map<string, Held>();

  return {
    root,
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

        // **The workspace root keeps its shape.** `--cwd packages/app` in a
        // monorepo asks for that subtree and nothing else, and `#guardPath`
        // bounds this client's file service to whatever it is handed. Returning
        // the checkout root would quietly widen that to the whole repository —
        // a safety boundary moved by an implementation detail of where a
        // worktree happens to live (measured 2026-09-07, #85).
        const inside = join(path, prefix);

        // Defence in depth on a boundary that has already broken once. The
        // `realpath` pair above is what makes `prefix` relative and keeps it
        // so; this says out loud that nothing may leave the checkout, and
        // fails the task rather than the run if it ever does. No input reaches
        // it today — that is the point, not an oversight.
        if (
          resolve(inside) !== path &&
          !resolve(inside).startsWith(path + sep)
        ) {
          throw new Error(
            `refusing to run ${taskId} at ${inside}: it is outside the ` +
              `worktree ${path}. The workspace root must sit inside the ` +
              `task's own checkout.`,
          );
        }

        if (!existsSync(inside)) {
          throw new Error(
            `${prefix} does not exist at ${baseRef} — the run was asked for ` +
              `that subdirectory as its workspace root, and the base commit ` +
              `has no such path to give each task.`,
          );
        }
        return inside;
      },

      async release(taskId, status) {
        const task = held.get(taskId);
        if (!task) return null;
        held.delete(taskId);

        // **Retention assumes the checkout is still on the task branch, and
        // says so out loud rather than assuming silently.** An agent that runs
        // `git checkout -b` in its own worktree moves HEAD, and every line
        // below would then act on the wrong ref: the commit lands elsewhere
        // (or dangles, on a detached HEAD), the forced removal takes the
        // checkout away, and the branch this run advertises stays at its base
        // ref — so M1c-3 would merge nothing and call it a success (measured
        // 2026-09-07, #85). Keeping the checkout is the only safe answer: the
        // work is on disk, and a person can see where it went.
        const on = await tryGit(task.path, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ]);
        if (on !== task.branch) {
          return (
            `left its worktree at ${task.path}: it is on ` +
            `${on === null ? "a detached HEAD" : `branch ${on}`}, not ` +
            `${task.branch}, so committing there would put the work on a ref ` +
            `this run does not track. Nothing was committed or removed.`
          );
        }

        const dirty = (await statusOf(task.path)) !== "";
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
          return null;
        }

        if (!RELEASES.has(status)) return null;

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
        return null;
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
