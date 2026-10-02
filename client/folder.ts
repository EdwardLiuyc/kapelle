/**
 * Tab completion for a folder path (M4-5): the new-room form's folder field.
 *
 * pi-tui's own path completion reads a line that starts with `/` as a slash
 * command, and every absolute path starts with `/`, so the form uses this.
 * It lists folders only, never files. It reads the local disk: the daemon
 * listens on loopback only, so the screen and the daemon share it.
 *
 * It also turns a typed folder into a full path. When the current folder was
 * removed, `process.cwd()` throws, so `absoluteFolder` gives no path instead.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** `~` and `~/…` as the home folder: no shell expands them in a form. */
export const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;

/** Said when a path needs the current folder and that folder was removed. */
export const FOLDER_GONE =
  "the current folder was removed: give a full path, or cd to a folder that exists";

/** `typed` as an absolute path: `~` expanded, relative to the current
 *  folder. `undefined` when it needs the current folder and that folder was
 *  removed: `process.cwd()` throws then. */
export function absoluteFolder(typed = "."): string | undefined {
  const path = expandHome(typed);
  if (isAbsolute(path)) return resolve(path);
  try {
    return resolve(process.cwd(), path);
  } catch {
    return undefined;
  }
}

/** Whether a folder entry is one, following a link; a broken link is not. */
function isFolder(e: Dirent, where: string): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(where, e.name)).isDirectory();
  } catch {
    return false; // a broken link
  }
}

/** The typed path, completed as far as it can be, and the folder names that
 *  still match when there is more than one. Hidden folders are listed only
 *  when the typed name starts with `.`. */
export function completeFolder(
  typed: string,
  cwd: string | undefined,
): { value: string; options: string[] } {
  // A bare `~` is the home folder itself, not a name under some parent:
  // complete it to `~/`, or Tab would leave it and the next name would
  // join the `~`.
  const path = typed === "~" ? "~/" : typed;
  const cut = path.lastIndexOf("/") + 1;
  const dir = path.slice(0, cut);
  const prefix = path.slice(cut);
  const real = expandHome(dir);
  const where = real.startsWith("/") ? real : cwd && join(cwd, real);
  // A relative path with the current folder removed: nothing to list.
  if (!where) return { value: typed, options: [] };
  const names: string[] = [];
  try {
    for (const e of readdirSync(where, { withFileTypes: true })) {
      if (!e.name.startsWith(prefix)) continue;
      if (e.name.startsWith(".") && !prefix.startsWith(".")) continue;
      if (isFolder(e, where)) names.push(e.name);
    }
    names.sort((a, b) => a.localeCompare(b));
  } catch {
    return { value: typed, options: [] }; // no such folder, or no access
  }
  const [first] = names;
  if (first === undefined) return { value: typed, options: [] };
  if (names.length === 1) return { value: `${dir}${first}/`, options: [] };
  let common = first;
  for (const n of names) {
    while (!n.startsWith(common)) common = common.slice(0, -1);
  }
  return { value: dir + common, options: names };
}
