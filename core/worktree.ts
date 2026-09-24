/**
 * Worktrees — story M1b-3, issue #19.
 *
 * One `git worktree` per task, at `stateDirFor(root)/wt/<runId>/<taskId>`,
 * branched off a base ref as `kapelle/<runId>/<taskId>` (`core/ids.ts`). This
 * is the seam `core/run.ts`'s `taskCwd` held open: before this file, every
 * task in a run shared one working directory and only non-colliding work was
 * safe.
 *
 * **A run asks nothing of the operator's repository** (decided 2026-09-20,
 * #129). Worktrees and records used to sit at `<repo>/.kapelle/`, inside the
 * working tree of the repo being worked on, which cost three things: a
 * `.gitignore` edit and two refusals before the first run, a dirty-tree
 * refusal that forbade the operator from working alongside their own agents,
 * and a checkout nested inside the parent's `#guardPath` root. Moving the
 * state under `core/runtime.ts`'s state directory deletes all three. It
 * reverses M1b-3's own ratified decision (#62 B1, "keeping state in-repo is
 * right, discoverable and per-project") on a year of using it: discoverable
 * was true, and it was not worth the toll.
 *
 * `git` itself never minded — `worktree add` succeeds against a dirty main
 * tree, and a worktree is a separate checkout the operator's edits never
 * reach. What is left of the dirty check is one advisory line, because
 * `core/merge.ts` already refuses **per file** at the one moment a dirty
 * tree can cost work.
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
 * `kill -9` mid-spawn can still orphan one; `core/sweep.ts` reconciles orphans
 * at the next daemon boot, for the repositories the daemon knows
 * (`repos.json`).
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { branchName } from "./ids.ts";
import { stateDirFor } from "./runtime.ts";

const run = promisify(execFile);

/**
 * The one thing still kept **inside** the repository: `<repo>/.kapelle/`, which
 * since #129 holds `config.json` and nothing else (`core/config.ts:87`).
 *
 * It stays because it is a per-project setting a team may want committed, and
 * a file the operator writes on purpose — it is never auto-created, so it
 * needs no `.gitignore` line and trips no preflight. Everything a run
 * generates lives at `stateDirFor(root)` instead.
 */
export const STATE_DIR = ".kapelle";

/**
 * What `release` should do with a checkout: turn it into a commit on the task
 * branch and remove it, or leave it where it is.
 *
 * **The caller decides, because only the caller has a verdict.** A run maps
 * its `TaskStatus` through `RELEASES` (`core/run.ts`); a room has no verdict
 * at all and always keeps, because the supervisor never commits a
 * participant's branch (R37). Passing a status here would force a room to
 * borrow a task word — `done` commits work nobody approved, and `failed`
 * libels a room that simply closed.
 */
type ReleaseAction = "commit" | "keep";

/**
 * The paths the working tree shows as changed — M1b-4's cross-check input.
 *
 * `-z` rather than the text above, because the text is *lossy for machines*.
 * Without it Git C-quotes any unusual path (`"src/caf\303\251.ts"`) and writes
 * a rename as `old -> new`, where a path may itself contain ` -> `; with it
 * every path is verbatim and a rename's source arrives as its own entry. That
 * deleted a parser — unquoting, and a quote-state scan for the separator —
 * whose bugs a reviewer found before the code shipped (#88).
 *
 * The rename check reads **both** status columns. Git's porcelain v1 puts `R`
 * in the first for a staged rename (an unstaged one is reported as a delete
 * plus an untracked file, measured 2026-09-08), but the source entry that
 * follows must be consumed either way — reading one column would leave it to
 * be re-read as a status line and mangled.
 *
 * `--untracked-files=all` rather than a bare `--porcelain`, which
 * `status.showUntrackedFiles=no` silently empties: a task whose whole output
 * was new files then read as untouched, and its checkout was removed with the
 * work in it (measured 2026-09-07, #85). Ignored paths stay out, so nothing
 * the operator's own `.gitignore` covers reads as agent work.
 */
export async function changedPaths(cwd: string): Promise<string[]> {
  const { stdout } = await run(
    "git",
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    { cwd },
  );
  const entries = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    // "XY path": two status letters, one space, then the path. Anything
    // shorter is the empty tail after the final NUL.
    const entry = entries[i];
    if (entry === undefined || entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      const from = entries[++i];
      if (from) paths.push(from);
    }
  }
  return paths;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

/** `git` for the questions whose answer is the exit code — `rev-parse
 *  --verify`, `--show-toplevel` — where a non-zero exit is information. */
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * The root supervisor state hangs off, resolved but not checked.
 *
 * `git rev-parse --show-toplevel`, or `cwd` itself when it is not a
 * repository (`isRepo: false`, the shared-cwd fallback). **Never throws** —
 * since #129 there is nothing about a repository that can refuse a run, so
 * this is the whole of the root preflight. `daemon.ts` needs it to answer "is
 * this folder inside an added repository?" (403) without a second git call.
 */
export async function stateDirRoot(
  cwd: string,
): Promise<{ root: string; isRepo: boolean }> {
  const root = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) return { root: cwd, isRepo: false };
  return { root, isRepo: true };
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
  release(taskId: string, action: ReleaseAction): Promise<string | null>;
  /** The branch and base SHA for an acquired task, or undefined when the task
   *  never acquired a worktree. Used to write the run record merge reads. */
  info(taskId: string): { branch: string; baseSha: string } | undefined;
}

export interface WorktreeSetup {
  /** `null` when the cwd cannot carry worktrees; `notice` says why. */
  worktrees: Worktrees | null;
  /** Containment-shaped, so `--quiet` never drops it (#13): it says isolation
   *  is absent. */
  notice?: string;
  /** Advisory, and `--quiet` drops it (#129): the operator's uncommitted work
   *  will not reach any task. Set only on the worktree path — in the
   *  shared-cwd fallback the tasks run *in* the dirty tree, so it would be a
   *  lie there. */
  advisory?: string;
  /** Which repository this run's supervisor state hangs off — the repository
   *  root whenever git reports one (including the no-commit fallback), or the
   *  requested cwd itself when there is no repository at all. The state
   *  itself lives at `stateDirFor(root)`, outside the repository since #129;
   *  this is the key, not the location. Returned because worktrees are not
   *  the only state kept there — M1b-7's stderr logs go beside them — and a
   *  caller that guessed `cwd` would split the directory in two whenever
   *  `--cwd` named a subdirectory. */
  root: string;
}

/**
 * Preflight, then a handle for the run.
 *
 * Returns a fallback with a notice when the cwd cannot carry worktrees. Since
 * #129 it **throws for nothing a repository can be in**: state no longer
 * lands in the working tree, so there is nothing to ignore, and a dirty tree
 * is a notice rather than a refusal. `core/merge.ts` still refuses a dirty
 * path a task branch touched, which is the one moment dirtiness costs work.
 */
export async function openWorktrees(
  cwd: string,
  runId: string,
): Promise<WorktreeSetup> {
  const { root, isRepo } = await stateDirRoot(cwd);
  if (!isRepo) {
    return {
      worktrees: null,
      root,
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
      root,
      notice:
        `${root} has no commits yet — nothing to branch from, so every task ` +
        `runs in it directly and tasks that touch the same files will collide.`,
    };
  }

  // A notice, never a refusal (#129). A supervisor whose whole point is to
  // work while the operator works cannot demand a clean tree first: that
  // forces a stash-or-temp-commit decision on changes the run never touches.
  // What is left is the surprise — a run branches off a commit — and one line
  // closes that. The count and the base, not the list: someone working
  // alongside a run has a long list and does not need it read back.
  //
  // `core/merge.ts` keeps the refusal that matters, per file, at the one
  // moment a dirty tree can actually cost work.
  const dirty = (await changedPaths(root)).length;
  const advisory =
    dirty === 0
      ? undefined
      : `${dirty} uncommitted ${dirty === 1 ? "file" : "files"} in ${root} ` +
        `will not reach any task — tasks branch from HEAD ` +
        `(${await git(root, ["rev-parse", "--short", "HEAD"])}).`;

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
    advisory,
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

        const path = join(stateDirFor(root), "wt", runId, taskId);
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

      info(taskId) {
        // Deliberately the declared shape, never the `Held` record: callers
        // spread what they get, and `Held.path` is the checkout root — not the
        // workspace `acquire` returned when `--cwd` named a subdirectory.
        const task = held.get(taskId);
        return task && { branch: task.branch, baseSha: task.baseSha };
      },

      async release(taskId, action) {
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

        const dirty = (await changedPaths(task.path)).length > 0;
        const head = await git(task.path, ["rev-parse", "HEAD"]);
        const untouched = !dirty && head === task.baseSha;

        // Nothing was produced, so there is nothing to inspect. The branch
        // decision still keys on the action: a committing task with an empty
        // diff leaves its branch at the base ref (#19), while a task that
        // failed before it wrote anything is the rollback half of the
        // transactional spawn — no worktree and no branch.
        if (untouched) {
          await removeWorktree(root, task.path);
          if (action === "keep") {
            await git(root, ["branch", "-D", task.branch]);
          }
          return null;
        }

        if (action === "keep") return null;

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
            `kapelle: ${taskId} (${runId})`,
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

/**
 * Carry a repository's workspace to where the repository now is (#129).
 *
 * `stateDirFor` keys on the path, so renaming or moving a repository strands
 * its workspace — with, very possibly, the only copy of a failed task's work
 * in it. This is the repair `core/sweep.ts`'s stranded notice names.
 *
 * **One command, because the two halves must not be separable.** `mv` alone
 * is not the fix: measured 2026-09-20, git keeps the old absolute path on
 * both sides of a worktree link, so after the move `git worktree list`
 * reports the checkout at its old path and marks it `prunable` — and the next
 * `git worktree prune` deletes the work. `git worktree repair` rewrites both
 * sides. An operator who ran the `mv` from a printed recipe and not the
 * repair would be left in exactly the shape that loses the work they moved,
 * which is why no recipe is printed.
 *
 * Refuses rather than guesses: a destination that is not a repository, a
 * source with no workspace, and a destination that already has one. The last
 * matters most — merging two workspaces would put two repositories' run
 * records in one directory, and `mv` onto an existing directory nests rather
 * than replaces.
 *
 * Returns the new workspace path.
 */
export async function moveWorkspace(
  fromRepo: string,
  toRepo: string,
): Promise<string> {
  const { root: to, isRepo } = await stateDirRoot(toRepo);
  if (!isRepo) {
    throw new Error(
      `${toRepo} is not a git repository, so it has no workspace to move to.`,
    );
  }

  const from = stateDirFor(fromRepo);
  if (!existsSync(from)) {
    throw new Error(`${fromRepo} has no kapelle workspace at ${from}.`);
  }

  const target = stateDirFor(to);
  if (target === from) return from;
  if (existsSync(target)) {
    throw new Error(
      `${to} already has a workspace at ${target}. Moving ${from} onto it ` +
        `would put two repositories' worktrees and run records in one ` +
        `directory. Move or remove one of them first.`,
    );
  }

  await run("mv", [from, target]);

  // Every checkout at once: `repair` takes the *new* paths and fixes the link
  // from both ends. A path that is no longer a checkout is reported and
  // skipped by git itself, so a workspace holding debris still repairs the
  // rest — which is the case this exists for.
  const checkouts: string[] = [];
  const wt = join(target, "wt");
  if (existsSync(wt)) {
    for (const runId of readdirSync(wt)) {
      for (const taskId of readdirSync(join(wt, runId))) {
        checkouts.push(join(wt, runId, taskId));
      }
    }
  }
  if (checkouts.length > 0) {
    await git(to, ["worktree", "repair", ...checkouts]);
  }

  return target;
}
