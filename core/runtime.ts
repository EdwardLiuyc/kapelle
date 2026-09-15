/**
 * The daemon's runtime directory — `daemon.json` and `children.json` live here.
 *
 * Its own file because two entry points need the one definition: `daemon.ts`
 * writes the token there and `cli.ts`'s `kapelle daemon add` reads it back
 * (M2-4, #34). `daemon.ts` cannot be imported for it — importing it starts a
 * daemon.
 */

import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
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
  // `lstat`, so a symlink planted where the directory should be is refused
  // rather than followed.
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
