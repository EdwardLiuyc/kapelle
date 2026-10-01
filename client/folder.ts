/**
 * Tab completion for a folder path (M4-5): the new-room form's folder field.
 *
 * pi-tui's own path completion reads a line that starts with `/` as a slash
 * command, and every absolute path starts with `/`, so the form uses this.
 * It lists folders only, never files. It reads the local disk: the daemon
 * listens on loopback only, so the screen and the daemon share it.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~` and `~/…` as the home folder: no shell expands them in a form. */
export const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;

/** The typed path, completed as far as it can be, and the folder names that
 *  still match when there is more than one. Hidden folders are listed only
 *  when the typed name starts with `.`. */
export function completeFolder(
  typed: string,
  cwd: string,
): { value: string; options: string[] } {
  const cut = typed.lastIndexOf("/") + 1;
  const dir = typed.slice(0, cut);
  const prefix = typed.slice(cut);
  const real = expandHome(dir);
  const where = real.startsWith("/") ? real : join(cwd, real);
  let names: string[];
  try {
    names = readdirSync(where, { withFileTypes: true })
      .filter((e) => e.name.startsWith(prefix))
      .filter((e) => prefix.startsWith(".") || !e.name.startsWith("."))
      .filter((e) => {
        if (e.isDirectory()) return true;
        if (!e.isSymbolicLink()) return false;
        try {
          return statSync(join(where, e.name)).isDirectory();
        } catch {
          return false; // a broken link
        }
      })
      .map((e) => e.name)
      .sort();
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
