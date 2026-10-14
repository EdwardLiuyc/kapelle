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
 *
 * **A room's fast-forward runs here** (M6-11a): `fastForwardCheckout` moves
 * the target's checked-out branch with `git merge --ff-only`, and only
 * tracked changes in that checkout refuse (2c).
 *
 * **A room's checkout is read here too** (M6-6a): `checkoutIdentity` answers
 * which branch `HEAD` is really on, and the base a rebase moved its work
 * onto, so a harness rename or rebase does not leave the room's record and
 * whole-branch diff pointing at the old ref.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
 * libels a room that was simply dismissed.
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
  return statusPaths(cwd, "--untracked-files=all");
}

/**
 * The tracked paths the working tree shows as changed (M6-11a, decided 2c).
 * Untracked and ignored files are left out: an untracked file does not stop a
 * fast-forward, and a collision with one is Git's own refusal at merge time.
 * The parser is the one `changedPaths` uses, so a rename consumes both sides.
 */
async function trackedChangedPaths(cwd: string): Promise<string[]> {
  return statusPaths(cwd, "--untracked-files=no");
}

async function statusPaths(cwd: string, untracked: string): Promise<string[]> {
  const { stdout } = await run(
    "git",
    ["status", "--porcelain", "-z", untracked],
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
 * A promise chain per repository, so commands that read or write the shared
 * `.git/worktrees/` admin directory never overlap in this process (#203).
 *
 * `git worktree add` and `git worktree remove` both scan and write that
 * directory, and run concurrently they can read a sibling's half-written
 * entry. Measured 2026-10-10 on Git 2.43.0: one add in about 4,200 lost that
 * race with `fatal: failed to read .../commondir`, which `core/run.ts` then
 * recorded as a task failed for no fault of the harness. Worktrees are one
 * per task and the pool runs tasks in parallel, so the overlap is the normal
 * case, not an accident.
 *
 * Every other command that touches that directory uses this queue too:
 * `core/sweep.ts`'s `prune`, `list`, `remove --force` and `branch -D` (git
 * reads every checkout to refuse a branch that is in use; measured 2026-10-11,
 * it lost the same race), and `moveWorkspace`'s `repair`.
 *
 * The key is the common git dir (`mutationKey`), so every checkout of one
 * repository — the main one and its linked worktrees — shares one queue. It
 * is **in-process only**: two CLI processes on one repository can still
 * overlap, and a cross-process lock or retry is the upgrade if that is ever
 * measured.
 */
const worktreeMutations = new Map<string, Promise<unknown>>();

export function serializeWorktreeMutation<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = worktreeMutations.get(key) ?? Promise.resolve();
  // Both handlers are the work: a failed mutation must not wedge every later
  // one for the same repository.
  const next = previous.then(work, work);
  worktreeMutations.set(key, next);
  const settled = () => {
    if (worktreeMutations.get(key) === next) worktreeMutations.delete(key);
  };
  void next.then(settled, settled);
  return next;
}

/**
 * The key the mutation queue is shared under: the git directory every
 * checkout of one repository writes — `.git` for the main checkout, the
 * common dir git reports inside a linked worktree.
 *
 * `stateDirRoot` returns the *checkout* root, so using that directly gave a
 * linked worktree its own queue while `git worktree add` from it still wrote
 * the shared `.git/worktrees/`; two runs in one process, one per checkout,
 * could then race as before (#203).
 */
export async function mutationKey(root: string): Promise<string> {
  const common = await tryGit(root, ["rev-parse", "--git-common-dir"]);
  const key = common === null ? root : resolve(root, common);
  // `realpath`, because two spellings of one directory — a symlinked `.git`,
  // or macOS's `/var` and `/private/var` — must share one queue (#85).
  try {
    return realpathSync(key);
  } catch {
    return key;
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

/** A base the caller cannot use: a ref that is not a commit, or a commit
 *  without the subdirectory the workspace asked for. The caller's mistake,
 *  not a failure of git. */
export class BadBase extends Error {}

/** The checkout has work the move must not touch (M6-11a, decided 2c):
 *  tracked changes, or an untracked file the incoming files would overwrite.
 *  The message says which. */
export class DirtyCheckout extends Error {}

/** The move is not possible: the target branch is not an ancestor of the
 *  source, or the checkout is not on the branch it would move. Nothing has
 *  changed. */
export class NotFastForward extends Error {}

/** A configured worktree link that cannot be made safely: a tracked path,
 *  one whose real target leaves the checkout, an overlap, or a link git
 *  still sees as untracked. The caller answers it as invalid config. */
export class LinkPathError extends Error {}

/**
 * `git merge --ff-only <sourceRef>` inside `cwd` (M6-11a).
 *
 * **The target's own checkout**, never `git update-ref`: the branch is checked
 * out there, and moving only the ref leaves the index and files behind, which
 * the agent would commit on top of. The return value says whether the branch
 * actually changed: a move to the commit it already has is a no-op the caller
 * does not log.
 *
 * Throws `DirtyCheckout` for tracked changes (2c) or a merge Git refuses
 * because an untracked file collides, `NotFastForward` when the source is not
 * ahead of the target or the checkout is not on `expectedBranch`, and
 * `BadBase` when a branch ref does not resolve. The merge runs the target
 * checkout's own `post-merge`/`post-checkout` hooks; the harness can already
 * run shell there, so this adds no trust.
 */
export async function fastForwardCheckout(
  cwd: string,
  sourceRef: string,
  expectedBranch: string,
): Promise<{ sha: string; moved: boolean }> {
  const on = await tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (on !== expectedBranch) {
    throw new NotFastForward(
      `the checkout is on ${on === null ? "a detached HEAD" : `branch ${on}`}, ` +
        `not ${expectedBranch}; refusing to move a branch it is not on.`,
    );
  }
  const target = await tryGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (target === null) {
    throw new BadBase(
      `the target branch ${JSON.stringify(expectedBranch)} does not resolve ` +
        `to a commit in ${cwd}.`,
    );
  }
  const dirty = await trackedChangedPaths(cwd);
  if (dirty.length > 0) {
    throw new DirtyCheckout(
      `the checkout has ${dirty.length} uncommitted tracked ` +
        `${dirty.length === 1 ? "change" : "changes"}: ${dirty.join(", ")}. ` +
        "Commit or stash them first.",
    );
  }
  const source = await tryGit(cwd, [
    "rev-parse",
    "--verify",
    `${sourceRef}^{commit}`,
  ]);
  if (source === null) {
    throw new BadBase(
      `source branch ${JSON.stringify(sourceRef)} does not resolve to a commit ` +
        `in ${cwd}.`,
    );
  }
  if (!(await isAncestor(cwd, target, source))) {
    throw new NotFastForward(
      `${JSON.stringify(sourceRef)} is not ahead of the target branch; ` +
        "this is a merge, not a fast-forward.",
    );
  }
  const before = await git(cwd, ["rev-parse", "HEAD"]);
  try {
    // `LC_ALL=C` so the stderr pattern below is the one Git prints; a
    // localized message would otherwise read as a 500, not `dirty_worktree`.
    await run("git", ["merge", "--ff-only", source], {
      cwd,
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const text = typeof stderr === "string" ? stderr : "";
    if (
      /would be overwritten|untracked working tree files|local changes/i.test(
        text,
      )
    ) {
      throw new DirtyCheckout(
        "the checkout has files the move would overwrite; commit, stash or " +
          "remove them first.",
      );
    }
    throw err;
  }
  const sha = await git(cwd, ["rev-parse", "HEAD"]);
  return { sha, moved: sha !== before };
}

/** `git merge-base --is-ancestor`: exit 1 is false, anything else is a real
 *  failure. The plain `git` helper would read both as `null`. */
async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
    });
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return false;
    throw err;
  }
}

/** What a checkout's branch says about itself (M6-6a, M7-3). */
export interface CheckoutIdentity {
  /** The branch `HEAD` names. A harness that renamed its branch reads here. */
  branch: string;
  /** The branch this one was renamed from, when the branch's own reflog has
   *  the `Branch: renamed refs/heads/<old> to refs/heads/<new>` entry for
   *  the name the caller held, and that old ref is gone. That is the positive
   *  proof a room owns the new name; a switch to someone else's branch has no
   *  such entry. Set only on the read that first sees the new name, so it is
   *  not a standing fact once `branch` equals the caller's current name. */
  renamedFrom?: string;
  /** The commit the branch's newest rebase or `pull --rebase` finished onto,
   *  when that commit is still an ancestor of the branch. A harness that
   *  rebases onto a newer master moves the point its diff should start at. */
  rebaseBase?: string;
}

/** A branch's own actions that do not move where its work starts: its own
 *  non-merge commits, its creation and a rename. The scan passes them. A
 *  `commit (merge):` is deliberately not here: a hand-resolved merge stops
 *  the scan, as a clean one does. */
const NEUTRAL_REFLOG =
  /^(commit(?! \(merge\))( \(|:)|branch: Created|Branch: renamed)/;

/** The rename entry `git branch -m` writes into the new branch's reflog. */
const RENAME_REFLOG =
  /^Branch: renamed refs\/heads\/(.+) to refs\/heads\/(.+)$/;

/** The commit named at the end of a rebase or `pull --rebase` finish. */
const REBASE_ONTO = /\(finish\).*\bonto ([0-9a-f]{40,64})$/;

/**
 * What the checkout at `cwd` is now: the branch `HEAD` names and, when its
 * own reflog says a rebase moved it, the commit its work starts from.
 *
 * **The branch is read live, not from the worktree's creation record.** A
 * harness may run `git branch -m` or `git switch -c`; `symbolic-ref` is the
 * one answer already true. `null` for a detached HEAD; a git failure may
 * throw, and `syncCheckout` treats that as no answer and keeps its record.
 * `expected` is the branch name the caller held: when the current name was
 * renamed into from it, the reflog's own `Branch: renamed …` entry and the
 * disappearance of the old ref prove it, and `renamedFrom` is set. A rename
 * is the positive fact a room needs; a stale entry copied onto a branch that
 * still has the old ref is not.
 *
 * **The rebase base comes from the branch ref's reflog.** A `rebase
 * (finish)` subject names the commit the branch was replayed onto, whether
 * the rebase was explicit or a `pull --rebase`; the newest one that is still
 * an ancestor of the branch is the base its diff should use. The scan walks
 * past the branch's own commits, a rename, and a rebase onto its own history
 * (a squash), and stops at any other action:
 * a merge or reset may have moved the branch somewhere this function cannot
 * describe, and a wrong base is worse than the recorded one.
 */
export async function checkoutIdentity(
  cwd: string,
  expected?: string,
): Promise<CheckoutIdentity | null> {
  const branch = await tryGit(cwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (branch === null) return null;
  // 500 entries is far more than one turn can write, and enough to reach the
  // last rebase after a long run of commits. A missing or unreadable reflog
  // is not an error: the branch alone is still the answer.
  const reflog = await tryGit(cwd, [
    "reflog",
    "show",
    "--format=%H%x00%gs",
    "-n",
    "500",
    branch,
    // After the ref, so a branch named like a path (`docs`, `src`) is not
    // ambiguous. Before the ref, `--` makes the name a pathspec, which reads
    // the wrong reflog (or nothing).
    "--",
  ]);
  if (reflog === null || reflog === "") return { branch };
  const lines = reflog.split("\n");
  // Ownership is a positive fact: find the rename entry that says this name
  // came from the name the caller held. A switch to a branch that already
  // existed has no such entry.
  let renamedFrom: string | undefined;
  if (expected !== undefined) {
    for (const line of lines) {
      const nul = line.indexOf("\0");
      if (nul < 0) continue;
      const match = RENAME_REFLOG.exec(line.slice(nul + 1));
      if (match?.[1] === expected && match[2] === branch) {
        // A pre-existing branch can carry a rename entry from the same old
        // name; only a rename that removed that old ref is this checkout's.
        const previous = await tryGit(cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${expected}`,
        ]);
        if (previous === null) renamedFrom = expected;
        break;
      }
    }
  }
  const identity: CheckoutIdentity = {
    branch,
    ...(renamedFrom !== undefined && { renamedFrom }),
  };
  for (const [i, line] of lines.entries()) {
    const nul = line.indexOf("\0");
    if (nul < 0) continue;
    const tip = line.slice(0, nul);
    const subject = line.slice(nul + 1);
    if (NEUTRAL_REFLOG.test(subject)) continue;
    const onto = REBASE_ONTO.exec(subject)?.[1];
    if (onto === undefined) break;
    const base = await tryGit(cwd, [
      "rev-parse",
      "--verify",
      `${onto}^{commit}`,
    ]);
    if (base === null || !(await isAncestor(cwd, base, tip))) break;
    // A rebase onto the branch's own history, such as a squash, brings in no
    // new base: pass it, as a commit is passed. The line below is the tip
    // before the rebase; without it, nothing can tell the two apart.
    const before = lines[i + 1]?.split("\0")[0];
    if (!before) break;
    if (await isAncestor(cwd, base, before)) continue;
    return { ...identity, rebaseBase: base };
  }
  return identity;
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
  /** True when the branch is a name the harness renamed into, proven by the
   *  branch's own reflog. Absent for a switch to a branch this run did not
   *  create, and for an ordinary acquired task. */
  renamed?: true;
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
  /** Follows a checkout the harness changed in place: a renamed branch, or a
   *  rebase that moved the commit its work starts from (`checkoutIdentity`).
   *  `release` and `info` read this record, so a room releases the branch the
   *  harness is really on. Runs do not call it; their old caution stands. */
  update(
    taskId: string,
    changes: { branch?: string; baseSha?: string; renamed?: boolean },
  ): void;
  /** Holds a checkout an earlier daemon acquired, as if this one had, so
   *  `release` can act on it (M6-7a: a room restored after a restart). It
   *  creates nothing. */
  adopt(
    taskId: string,
    info: { branch: string; baseSha: string; renamed?: boolean },
  ): void;
}

export interface WorktreeSetupOptions {
  /**
   * Test seam: awaited once per worktree-admin git command, inside the
   * per-repository queue. The real race is one lost add in about 4,200
   * (measured 2026-10-10, #203), far too rare to trigger on demand, so
   * `core/tests/worktree.test.ts` holds here and asserts two commands never
   * overlap.
   */
  onWorktreeMutation?: () => void | Promise<void>;
  /** Project `linkPaths`, already through `core/config.ts`'s shape rules.
   *  Absent means no links. */
  linkPaths?: readonly string[];
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

/** One configured path the worktree linker will make. */
interface LinkSource {
  /** The relative path as configured. */
  path: string;
  /** The absolute path in the main checkout. */
  source: string;
  /** A directory is mirrored entry by entry; a file is one symlink. */
  kind: "dir" | "file";
  /** `<repo>/.kapelle/config.json: "linkPaths[i]"`, for error messages. */
  where: string;
}

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Separators and harmless `.` parts removed, so `folder_a/` and `folder_a`
 *  are one entry for overlap checks. */
function canonicalLinkPath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/**
 * Plan the configured links against the main checkout. `core/config.ts`
 * checks the list's shape; the answers that need git or the filesystem are
 * here: tracked, real-target containment, and overlap. A path that does not
 * exist is skipped.
 */
async function planLinkSources(
  root: string,
  paths: readonly string[],
): Promise<LinkSource[]> {
  if (paths.length === 0) return [];
  const realRoot = await realpath(root);
  const configFile = join(root, STATE_DIR, "config.json");
  const plans: LinkSource[] = [];
  const seen = new Map<string, string>();

  for (const [index, path] of paths.entries()) {
    const where = `${configFile}: "linkPaths[${index}]"`;
    checkLinkPath(path, where, seen);
    const plan = await planLinkSource(root, realRoot, path, where);
    if (plan) plans.push(plan);
  }
  return plans;
}

/** The shape rules `core/config.ts` already applies, repeated for this
 *  function's test seam: relative, inside the checkout, not `.git`, and no
 *  overlap with an earlier entry. */
function checkLinkPath(
  path: string,
  where: string,
  seen: Map<string, string>,
): void {
  const key = canonicalLinkPath(path);
  if (path === "" || isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new LinkPathError(
      `${where} must be a relative path inside the checkout; ` +
        `got ${JSON.stringify(path)}.`,
    );
  }
  if (
    key === "" ||
    key.toLowerCase() === ".git" ||
    key.toLowerCase().startsWith(".git/")
  ) {
    throw new LinkPathError(
      `${where} must not name .git or anything inside it; got ` +
        `${JSON.stringify(path)}.`,
    );
  }
  for (const [seenKey, seenPath] of seen) {
    if (
      key === seenKey ||
      key.startsWith(`${seenKey}/`) ||
      seenKey.startsWith(`${key}/`)
    ) {
      throw new LinkPathError(
        `${where} overlaps ${JSON.stringify(seenPath)}; ` +
          "each path must stand alone.",
      );
    }
  }
  seen.set(key, path);
}

/** One path's git and filesystem checks, or `undefined` when it is missing. */
async function planLinkSource(
  root: string,
  realRoot: string,
  path: string,
  where: string,
): Promise<LinkSource | undefined> {
  // Tracked is a refusal even when the working copy is missing: the new
  // checkout would check the path out and collide with the link.
  const listed = await git(root, [
    "--literal-pathspecs",
    "ls-files",
    "-z",
    "--",
    path,
  ]);
  if (listed !== "") {
    throw new LinkPathError(
      `${where} is tracked by git; a new checkout would collide with it.`,
    );
  }

  const source = resolve(root, path);
  const sourceStat = await statOrMissing(source);
  if (sourceStat === undefined) return undefined;

  // `realpath` follows a symlink, so a listed path that points outside the
  // checkout is refused no matter how it is spelled.
  const realSource = await realpath(source);
  if (realSource !== realRoot && !realSource.startsWith(`${realRoot}${sep}`)) {
    throw new LinkPathError(
      `${where} resolves outside ${root}, to ${realSource}.`,
    );
  }

  return {
    path,
    source,
    kind: sourceStat.isDirectory() ? "dir" : "file",
    where,
  };
}

/** `stat`, with a missing path as the `undefined` the caller skips. */
async function statOrMissing(source: string): Promise<Stats | undefined> {
  try {
    return await stat(source);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Check the configured links without creating anything. Request paths use
 *  it to answer `invalid_config` before a run or a room starts. */
export async function validateWorktreeLinks(
  root: string,
  paths: readonly string[],
): Promise<void> {
  await planLinkSources(root, paths);
}

/** The link type Windows needs; ignored on POSIX, where symlinks need none. */
async function linkType(
  source: string,
): Promise<"file" | "junction" | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    return (await stat(source)).isDirectory() ? "junction" : "file";
  } catch {
    return "file";
  }
}

async function makeLink(
  source: string,
  target: string,
  where: string,
): Promise<void> {
  try {
    await symlink(source, target, await linkType(source));
  } catch (err) {
    throw new LinkPathError(
      `${where} cannot be linked at ${target}: ${messageOf(err)}.`,
    );
  }
}

/**
 * Make the planned links inside one fresh checkout. The last step of each
 * path is the point of the whole design: `git status` must show nothing for
 * it, or the link would later read as a task's work and could be committed.
 * Any link made before a refusal is removed again, so the caller's normal
 * rollback sees an untouched checkout.
 */
async function applyLinkSources(
  checkout: string,
  plans: readonly LinkSource[],
): Promise<void> {
  const created: string[] = [];
  try {
    for (const plan of plans) {
      const target = join(checkout, plan.path);
      if (
        resolve(target) !== checkout &&
        !resolve(target).startsWith(`${checkout}${sep}`)
      ) {
        throw new LinkPathError(
          `${plan.where} must stay inside the checkout; ` +
            `got ${JSON.stringify(plan.path)}.`,
        );
      }

      const parent = dirname(target);
      const parentStat = await linkParent(parent, plan.where);
      if (!parentStat.isDirectory()) {
        throw new LinkPathError(
          `${plan.where} would be linked inside ${parent}, which is not a ` +
            "folder in the checkout.",
        );
      }

      if (plan.kind === "file") {
        await makeLink(plan.source, target, plan.where);
        created.push(target);
      } else {
        try {
          await mkdir(target);
        } catch (err) {
          throw new LinkPathError(
            `${plan.where} cannot be made at ${target}: ${messageOf(err)}.`,
          );
        }
        created.push(target);
        for (const name of await readdir(plan.source)) {
          await makeLink(
            join(plan.source, name),
            join(target, name),
            plan.where,
          );
        }
      }

      const dirty = await git(checkout, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        plan.path,
      ]);
      if (dirty !== "") {
        throw new LinkPathError(
          `${plan.where} is not ignored in a new checkout: git status ` +
            `reports ${JSON.stringify(dirty.split("\n")[0])}. Add an ignore ` +
            "rule that matches the link, or remove it from linkPaths.",
        );
      }
    }
  } catch (err) {
    for (const target of created.toReversed()) {
      await discardLink(target);
    }
    throw err;
  }
}

/** The target's parent must exist and be a real directory; a symlink parent
 *  could send the link outside the checkout. */
async function linkParent(parent: string, where: string): Promise<Stats> {
  try {
    return await lstat(parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LinkPathError(
        `${where} has no parent folder in the checkout: ${parent}.`,
      );
    }
    throw err;
  }
}

/** Rollback is best effort: the refusal that led here is the error to report. */
async function discardLink(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    // The original LinkPathError still says what was refused.
  }
}

/**
 * Preflight, then a handle for the run.
 *
 * Returns a fallback with a notice when the cwd cannot carry worktrees. Since
 * #129 it **throws for nothing a repository can be in**: state no longer
 * lands in the working tree, so there is nothing to ignore, and a dirty tree
 * is a notice rather than a refusal. `core/merge.ts` still refuses a dirty
 * path a task branch touched, which is the one moment dirtiness costs work.
 *
 * Every read or write of one repository's `.git/worktrees/` in the client
 * goes through the per-repository queue below — this file's `add` and
 * `remove`, `core/sweep.ts`'s admin commands, and `moveWorkspace`'s `repair`
 * — so tasks, rooms and the sweep cannot race each other (#203). `options`
 * carries the test seam for that queue and the project's `linkPaths`.
 */
// One preflight: the ordered refusals are its contract, and the tests pin them.
// pi-lens-ignore: high-complexity, high-fan-out
export async function openWorktrees(
  cwd: string,
  runId: string,
  options: WorktreeSetupOptions = {},
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

  // The project's links are planned once, before any task runs: a tracked
  // path or one that leaves the checkout refuses the whole setup, not the
  // first task that happens to acquire a worktree.
  const linkPlans = await planLinkSources(root, options.linkPaths ?? []);

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
  const queueKey = await mutationKey(root);

  // Every mutation below runs through the repository's queue; the optional
  // hook is the test seam for `core/tests/worktree.test.ts`, not behaviour.
  const mutateWorktrees = <T>(work: () => Promise<T>): Promise<T> =>
    serializeWorktreeMutation(queueKey, async () => {
      await options.onWorktreeMutation?.();
      return work();
    });

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
          throw new BadBase(
            `base ref ${JSON.stringify(baseRef)} does not resolve to a commit ` +
              `in ${root}.`,
          );
        }

        const path = join(stateDirFor(root), "wt", runId, taskId);
        await mutateWorktrees(() =>
          git(root, ["worktree", "add", "-b", branch, path, baseSha]),
        );
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
          // Worded for runs and rooms alike: a room client reads it too.
          throw new BadBase(
            `the folder ${prefix} is not in ${baseRef}, so a checkout of that ` +
              "commit has no such folder to work in. Commit the folder, or " +
              "start from a commit that has it.",
          );
        }
        await applyLinkSources(path, linkPlans);
        return inside;
      },

      info(taskId) {
        // Deliberately the declared shape, never the `Held` record: callers
        // spread what they get, and `Held.path` is the checkout root — not the
        // workspace `acquire` returned when `--cwd` named a subdirectory.
        const task = held.get(taskId);
        return task && { branch: task.branch, baseSha: task.baseSha };
      },

      update(taskId, changes) {
        const task = held.get(taskId);
        // No checkout, no record: `info` must stay `undefined` for a task that
        // never acquired one.
        if (!task) return;
        if (changes.branch !== undefined) {
          task.branch = changes.branch;
          // A rename is proven by the reflog; anything else means the
          // checkout switched to a branch this run did not create.
          task.renamed = changes.renamed === true ? true : undefined;
        }
        if (changes.baseSha !== undefined) task.baseSha = changes.baseSha;
      },

      adopt(taskId, { branch, baseSha, renamed }) {
        const path = join(stateDirFor(root), "wt", runId, taskId);
        held.set(taskId, {
          path,
          branch,
          baseSha,
          ...(renamed === true && { renamed: true }),
        });
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
        //
        // `update` may track a name the harness renamed into (a room does).
        // That name is ours only when the branch's own reflog proved the
        // rename from the name we held; a switch to a branch this run did
        // not create clears the flag, so that name is never deleted.
        const original = branchName(runId, taskId);
        const ours = task.branch === original || task.renamed === true;
        const on = await tryGit(task.path, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ]);
        if (on !== task.branch || !ours) {
          return (
            `left its worktree at ${task.path}: it is on ` +
            `${on === null ? "a detached HEAD" : `branch ${on}`}, not ` +
            `${ours ? task.branch : original}, so committing there would put ` +
            `the work on a ref this run does not track. Nothing was committed ` +
            `or removed.`
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
          await mutateWorktrees(() => removeWorktree(root, task.path));
          if (action === "keep") {
            // `branch -D` reads every checkout to refuse a branch in use, so
            // a concurrent `worktree add` can hand it a half-written entry.
            await mutateWorktrees(() =>
              git(root, ["branch", "-D", task.branch]),
            );
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
        await mutateWorktrees(() => removeWorktree(root, task.path));
        return null;
      },
    },
  };
}

/** `--force` because `git worktree remove` refuses while *ignored* files are
 *  present — a `node_modules/` the task installed would block every removal.
 *  Tracked work is committed before this runs; what --force discards is by
 *  definition what the repository was told not to keep.
 *
 *  Callers must hold the repository's mutation queue — `mutateWorktrees` in
 *  `openWorktrees` — because `remove` races a concurrent `add` on the shared
 *  `.git/worktrees/` directory (#203). */
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
    await serializeWorktreeMutation(await mutationKey(to), () =>
      git(to, ["worktree", "repair", ...checkouts]),
    );
  }

  return target;
}
