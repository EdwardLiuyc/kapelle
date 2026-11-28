/**
 * Tab completion for a folder path (M4-5): the new-room form's folder field.
 *
 * pi-tui's own path completion reads a line that starts with `/` as a slash
 * command, and every absolute path starts with `/`, so the form uses this.
 * It lists folders only, never files.
 *
 * **Which disk counts** (M11-5). With no daemon address in `client.json`
 * (M11-4), the daemon runs on this machine as this user, so the screen reads
 * its own disk. It turns a typed folder into a full path, from its own home
 * and current folder, because the daemon's current folder is not the
 * person's. When the current folder was removed, `process.cwd()` throws, so
 * `absoluteFolder` gives no path instead.
 * With an address set (`DaemonAddress.fromClient`), the daemon's machine is
 * another disk. The client reads no folder from its own disk and resolves
 * nothing against its own home or current folder: it sends a folder as
 * typed, `~` for none, and the daemon resolves it from its user's home
 * (`existingDir`). Completion asks `GET /folders`.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { FolderList } from "./contract.ts";
import { call, type DaemonAddress } from "./daemon.ts";

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

/** The `cwd` to send for a typed folder: as typed, `~` for none, when the
 *  daemon is `remote`; else `absoluteFolder`'s full path on this disk. */
export const folderToSend = (typed: string | undefined, remote: boolean) =>
  remote ? typed || "~" : absoluteFolder(typed);

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

type Completion = { value: string; options: string[] };

/** The typed path cut at its last `/`: the folder to list, and the start of
 *  the name. A bare `~` is the home folder itself, not a name under some
 *  parent: it completes to `~/`, or Tab would leave it and the next name
 *  would join the `~`. */
function splitTyped(typed: string): { dir: string; prefix: string } {
  const path = typed === "~" ? "~/" : typed;
  const cut = path.lastIndexOf("/") + 1;
  return { dir: path.slice(0, cut), prefix: path.slice(cut) };
}

/** The typed path, completed as far as `names` (the folders in `dir`)
 *  allow, and the names that still match when there is more than one.
 *  Hidden folders match only when the typed name starts with `.`. */
function narrow(typed: string, names: readonly string[]): Completion {
  const { dir, prefix } = splitTyped(typed);
  const hidden = prefix.startsWith(".");
  const found = names.filter(
    (n) => n.startsWith(prefix) && (hidden || !n.startsWith(".")),
  );
  const [first] = found;
  if (first === undefined) return { value: typed, options: [] };
  if (found.length === 1) return { value: `${dir}${first}/`, options: [] };
  let common = first;
  for (const n of found) {
    while (!n.startsWith(common)) common = common.slice(0, -1);
  }
  return { value: dir + common, options: found };
}

/** `typed` completed from this disk; a relative path from `cwd`. */
export function completeFolder(
  typed: string,
  cwd: string | undefined,
): Completion {
  const real = expandHome(splitTyped(typed).dir);
  const where = real.startsWith("/") ? real : cwd && join(cwd, real);
  // A relative path with the current folder removed: nothing to list.
  if (!where) return { value: typed, options: [] };
  const names: string[] = [];
  try {
    for (const e of readdirSync(where, { withFileTypes: true })) {
      if (isFolder(e, where)) names.push(e.name);
    }
  } catch {
    return { value: typed, options: [] }; // no such folder, or no access
  }
  return narrow(
    typed,
    names.sort((a, b) => a.localeCompare(b)),
  );
}

/** `typed` completed from the daemon's disk (M11-5), through
 *  `GET /folders`. A relative path starts from the daemon user's home.
 *  A refusal or a lost daemon completes nothing. */
export async function completeDaemonFolder(
  d: DaemonAddress,
  typed: string,
): Promise<Completion> {
  const dir = splitTyped(typed).dir || ".";
  const r = await call<FolderList>(
    d,
    `/folders?path=${encodeURIComponent(dir)}`,
  ).catch(() => undefined);
  return r?.ok ? narrow(typed, r.body.folders) : { value: typed, options: [] };
}
