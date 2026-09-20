/**
 * The daemon's user-level files.
 *
 * Two directories, because they answer to different lifetimes. The **runtime**
 * directory holds what is only true while a daemon is up — `daemon.json` and
 * `children.json` — and is wiped at logout. The **state** directory holds what
 * must outlive that: `repos.json`, the list of repositories added with
 * `POST /repos` (M2-6, #36).
 *
 * Its own file because two entry points need the one definition: `daemon.ts`
 * writes the token there and `cli.ts`'s `kapelle daemon add` reads it back
 * (M2-4, #34). `daemon.ts` cannot be imported for it — importing it starts a
 * daemon.
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

/**
 * `$XDG_RUNTIME_DIR/kapelle`, or a per-user directory under the system temp
 * dir where that is unset (macOS). Either way it must be ours and closed to
 * everyone else: in a shared `/tmp`, another account could create the
 * directory first, and whoever owns it can read or replace the token.
 *
 * Unset means **empty or relative**, the same rule `stateDir` follows. A
 * relative value would put the token under whatever directory the daemon
 * started in — a repository, for `kapelle daemon start`, where a checkout
 * could commit it.
 */
export function runtimeDir(): string {
  const { uid } = userInfo();
  const base = process.env.XDG_RUNTIME_DIR;
  const dir =
    base && isAbsolute(base)
      ? join(base, "kapelle")
      : join(tmpdir(), `kapelle-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return ours(dir);
}

/**
 * `dir`, once it is ours and closed to everyone else.
 *
 * `lstat`, so a symlink planted where the directory should be is refused
 * rather than followed. Both directories take it: one holds the token, the
 * other holds the list of repositories the daemon will run harnesses in, and
 * neither is something to inherit from whoever got there first.
 */
function ours(dir: string): string {
  const { uid } = userInfo();
  const st = lstatSync(dir);
  const mode = st.mode & 0o777;
  if (!st.isDirectory() || st.uid !== uid || (mode & 0o077) !== 0) {
    throw new Error(
      `${dir} must be a directory owned by you with mode 0700; it is owned ` +
        `by uid ${st.uid} with mode ${mode.toString(8)}. Fix or remove it, ` +
        `then try again.`,
    );
  }
  return dir;
}

/**
 * `$XDG_STATE_HOME/kapelle`, or `~/.local/state/kapelle` where that is unset.
 *
 * **Not `runtimeDir()`** (decided 2026-09-16, #36). On Linux that resolves to
 * `/run/user/<uid>`, a tmpfs cleared at logout, so a repository list kept
 * there would survive a daemon restart and not a reboot — and a list that is
 * sometimes there is worse than one that never was.
 *
 * Guarded exactly as `runtimeDir` is. The default sits under `$HOME` and is
 * not the shared place `tmpdir()` is, but `XDG_STATE_HOME` can name anywhere,
 * and this file decides which folders the daemon will start harnesses in —
 * a list worth no less care than the token beside it.
 */
function stateDir(): string {
  // XDG says an empty or relative value means unset, and `runtimeDir` already
  // treats an empty base the same way. A `""` base here would otherwise
  // resolve to the relative `./kapelle`, putting the list in whatever
  // directory the daemon happened to start in.
  const configured = process.env.XDG_STATE_HOME;
  const base =
    configured && isAbsolute(configured)
      ? configured
      : join(homedir(), ".local", "state");
  const dir = join(base, "kapelle");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Canonicalize `base`, not `dir`: `dir` is the thing `ours` is about to
  // guard, and following symlinks before that guard runs would let a symlink
  // planted at `<base>/kapelle` point the guard at a directory it did not
  // check. `git worktree list --porcelain` reports symlink-resolved paths
  // (macOS: `tmpdir()` is `/var`, realpath is `/private/var`), so a spelling
  // that disagreed with that would make every managed checkout look unrelated
  // to `core/sweep.ts`'s `managedWorktrees()` and go unreconciled.
  return ours(join(realpathSync(base), "kapelle"));
}

/** Where the repository list lives. */
function reposFile(): string {
  return join(stateDir(), "repos.json");
}

/**
 * Where one repository's supervisor state lives (issue #129).
 *
 * `<stateDir()>/repos/<name>-<hash>` — worktrees, run records, event logs and
 * stderr logs. It used to be `<repo>/.kapelle/`, which cost every repository a
 * `.gitignore` edit and two refusals before its first run
 * (`core/worktree.ts`), for state that belongs to this machine and to no
 * repository. Only `<repo>/.kapelle/config.json` stays behind, and that one is
 * a file the operator writes on purpose and may commit.
 *
 * **Both halves of the name earn their place.** The basename is for the
 * operator, who reads a failed task's checkout by eye; the digest is because
 * `~/src/api` and `~/work/api` are both `api`, and one folder for both would
 * put one repository's worktrees into the other's sweep.
 *
 * **Keyed on the path, so a moved or renamed repository strands its
 * workspace** (decided 2026-09-20, #129). A marker file inside `.git/` would
 * survive the move, and was judged more machinery than the problem is worth.
 * `core/sweep.ts` reports a stranded workspace instead of guessing, because a
 * path that is gone reads the same whether the operator renamed the
 * repository or deleted it, and those want opposite answers.
 *
 * Never throws for a path that does not exist, for that same reason: the sweep
 * asks about repositories that are gone, and a throw there would refuse a boot
 * over debris. `realpath` first so a symlinked `--cwd` and the real path agree
 * — `git rev-parse --show-toplevel` already resolves, and subtracting one from
 * the other is what #85 measured going wrong elsewhere.
 *
 * Does throw, though, through `stateDir()`: that call creates the state
 * directory and guards it with `ours` (yours, `0700`), so a state directory
 * owned by someone else or with a looser mode is a refusal here, not a
 * silent pass-through.
 */
export function stateDirFor(root: string): string {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    real = resolve(root);
  }
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  return join(stateDir(), "repos", `${basename(real)}-${hash}`);
}

/**
 * Every repository added to the daemon (M2-6, #36).
 *
 * A missing, unreadable or malformed file reads as an empty list rather than
 * throwing: that is the state before the first `POST /repos`, and a daemon
 * that refuses to boot over it would be unreachable by the very request that
 * fixes it. Entries are re-checked on use, so a repository that has since
 * moved is refused then, not here.
 *
 * Entries are canonical realpaths — `daemon.ts` realpaths at `POST /repos`,
 * matching what `stateDirFor` keys on — because a path that is gone cannot be
 * re-resolved to check it against anything else.
 */
export function readRepos(): string[] {
  // Outside the `try`, so the directory guard is never swallowed: a state
  // directory somebody else owns is a refusal to start, the same answer the
  // runtime directory gives, and not an empty list that looks like a fresh
  // install.
  const path = reposFile();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/** Replace the list, atomically — a half-written one reads as empty. */
export function writeRepos(repos: readonly string[]): void {
  const path = reposFile();
  const tmp = `${path}.tmp`;
  // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
  // pi-lens-ignore: no-raw-json-store-write
  writeFileSync(tmp, `${JSON.stringify([...repos], null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}
