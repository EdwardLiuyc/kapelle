/**
 * The workspace path guard. It reads the disk to compare realpaths.
 *
 * **The path guard is not the policy.** It applies in every mode, `auto`
 * included. A missing tail is resolved through its nearest existing ancestor;
 * an unresolved symlink is refused rather than followed at write time.
 */

import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The absolute path to use, or a throw naming the root it left.
 *
 * The prefix check is on **realpaths** (M1b-6, issue #22). `resolve` is
 * string arithmetic and never touches the filesystem, so before this a
 * symlink sitting inside the root and pointing outside it read as in-root
 * and was followed — the hole `protocol/tests/agent.test.ts` recorded as a
 * documented gap rather than a pass.
 *
 * What is returned is still the resolved-but-not-realpathed path, so a write
 * lands where the harness asked and `_client_wrote_file` reports that name.
 * Following the link at write time is safe because it is the same link this
 * check just resolved.
 */
export async function guardPathOnDisk(
  cwd: string,
  p: string,
  {
    write,
    allowReadOutsideRoot = false,
  }: { write: boolean; allowReadOutsideRoot?: boolean },
): Promise<string> {
  const abs = resolve(cwd, p);
  const root = await realPathOrNearest(cwd);
  const real = await realPathOrNearest(abs);
  const inRoot = real === root || real.startsWith(root + sep);
  if (!inRoot && (write || !allowReadOutsideRoot)) {
    throw new Error(
      `path outside workspace root refused: ${real} (root: ${root})`,
    );
  }
  return abs;
}

/**
 * The real path of `p`, following symlinks as far as the filesystem goes.
 *
 * `realpath` throws on a path that does not exist, which every write to a new
 * file is, so a plain missing tail is resolved against the nearest ancestor
 * that does exist and re-appended. An unresolved symlink is refused instead:
 * rejoining its name would hide its target from the guard, and a later write
 * would follow it (#309). Links that resolve normally return above. The
 * blanket refusal is intentional: it includes in-root targets and cycles,
 * without growing a second resolver for links no caller needs to follow.
 */
async function realPathOrNearest(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    let isSymlink = false;
    try {
      const stats = await lstat(p);
      isSymlink = stats.isSymbolicLink();
    } catch {
      // A plain missing tail is resolved through its parent below.
    }
    if (isSymlink) throw new Error(`unresolved symlink refused: ${p}`);
    return join(await realPathOrNearest(parent), basename(p));
  }
}
