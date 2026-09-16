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

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * `$XDG_RUNTIME_DIR/kapelle`, or a per-user directory under the system temp
 * dir where that is unset (macOS). Either way it must be ours and closed to
 * everyone else: in a shared `/tmp`, another account could create the
 * directory first, and whoever owns it can read or replace the token.
 */
export function runtimeDir(): string {
  const { uid } = userInfo();
  const base = process.env.XDG_RUNTIME_DIR;
  const dir = base ? join(base, "kapelle") : join(tmpdir(), `kapelle-${uid}`);
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
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const dir = join(base, "kapelle");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return ours(dir);
}

/** Where the repository list lives. */
function reposFile(): string {
  return join(stateDir(), "repos.json");
}

/**
 * Every repository added to the daemon (M2-6, #36).
 *
 * A missing, unreadable or malformed file reads as an empty list rather than
 * throwing: that is the state before the first `POST /repos`, and a daemon
 * that refuses to boot over it would be unreachable by the very request that
 * fixes it. Entries are re-checked on use, so a repository that has since
 * moved is refused then, not here.
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
