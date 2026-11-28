/**
 * The kept scratch folders for the hall and chats: list what each holds,
 * and remove only the folders no live participant owns.
 *
 * The daemon serializes every hall or chat add and remove against a snapshot
 * (list or clean) with its scratch lock (`daemon/rooms.ts`). That is what
 * protects a folder an add has just made before its participant joins the
 * owner's live list. `cleanScratch` checks that list for each id before
 * removing that folder.
 *
 * Symlinks are never followed. A symlink at a folder path is listed as a
 * problem and left alone; a symlink inside a folder is an entry and is
 * removed with the folder, not read. A missing scratch root is an empty list;
 * a root that is not a real folder is an error before anything is touched.
 */

import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ScratchCleanResult, ScratchFolder } from "../client/contract.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
const missing = (err: unknown) =>
  (err as NodeJS.ErrnoException).code === "ENOENT";

type Live = ReadonlyMap<string, string>;
type ScanResult = Pick<ScratchFolder, "entries" | "files" | "bytes">;

/** A child name in the scratch root, without letting a request name another
 *  folder through `..` or a path separator. */
function scratchPath(root: string, id: string): string | undefined {
  if (id === "" || id === "." || id === ".." || /[/\\\0]/.test(id)) {
    return undefined;
  }
  return join(root, id);
}

async function scan(dir: string): Promise<ScanResult> {
  const rows = await readdir(dir, { withFileTypes: true });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const entries: string[] = [];
  let files = 0;
  let bytes = 0;
  for (const row of rows) {
    const at = join(dir, row.name);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(at);
    } catch (err) {
      if (missing(err)) continue;
      throw err;
    }
    if (st.isDirectory()) {
      let below: Awaited<ReturnType<typeof scan>>;
      try {
        below = await scan(at);
      } catch (err) {
        if (missing(err)) continue;
        throw err;
      }
      entries.push(`${row.name}/`);
      files += below.files;
      bytes += below.bytes;
    } else {
      entries.push(st.isSymbolicLink() ? `${row.name}@` : row.name);
      if (st.isFile()) {
        files++;
        bytes += st.size;
      }
    }
  }
  return { entries, files, bytes };
}

/** `root` as a real directory, `false` when it does not exist. */
async function rootIsFolder(root: string): Promise<boolean> {
  try {
    const st = await lstat(root);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`${root} is not a real folder`);
    }
    return true;
  } catch (err) {
    if (missing(err)) return false;
    throw err;
  }
}

/** Every entry under `root`, including entries that are not real folders,
 *  so the operator sees them and no symlink is followed. */
export async function listScratch(
  root: string,
  live: Live,
  // Test seam: a folder can vanish between its `lstat` and its scan, and a
  // real filesystem cannot be told to stage that race. Nothing passes it.
  scanFolder: (dir: string) => Promise<ScanResult> = scan,
): Promise<ScratchFolder[]> {
  if (!(await rootIsFolder(root))) return [];
  const names = await readdir(root);
  names.sort((a, b) => a.localeCompare(b));
  const folders: ScratchFolder[] = [];
  for (const id of names) {
    const path = join(root, id);
    const participant = live.get(id);
    const folder: ScratchFolder = {
      id,
      path,
      inUse: participant !== undefined,
      kind: "directory",
      files: 0,
      bytes: 0,
      entries: [],
    };
    if (participant !== undefined) folder.participant = participant;
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink()) {
        folder.kind = "symlink";
        folder.problem = "it is a symbolic link; it was not followed";
      } else if (!st.isDirectory()) {
        folder.kind = "other";
        folder.problem = "it is not a folder";
      } else {
        Object.assign(folder, await scanFolder(path));
      }
    } catch (err) {
      if (missing(err)) continue;
      folder.kind = "other";
      folder.problem = messageOf(err);
    }
    folders.push(folder);
  }
  return folders;
}

/** Remove the requested folders that are still stale. Every result is for
 *  one id, so one failure does not stop the others. */
export async function cleanScratch(
  root: string,
  ids: readonly string[],
  live: Live,
): Promise<ScratchCleanResult[]> {
  if (!(await rootIsFolder(root))) {
    return ids.map((id) => ({
      id,
      path: join(root, id),
      removed: false,
      error: `${root} does not exist`,
    }));
  }
  const results: ScratchCleanResult[] = [];
  for (const id of ids) {
    const path = scratchPath(root, id);
    if (path === undefined) {
      results.push({
        id,
        path: join(root, id),
        removed: false,
        error: "the id is not a safe folder name",
      });
      continue;
    }
    const participant = live.get(id);
    if (participant !== undefined) {
      results.push({
        id,
        path,
        removed: false,
        protected: true,
        error: `the folder is in use by @${participant}`,
      });
      continue;
    }
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink()) {
        results.push({
          id,
          path,
          removed: false,
          error: "it is a symbolic link; it was not followed",
        });
        continue;
      }
      if (!st.isDirectory()) {
        results.push({
          id,
          path,
          removed: false,
          error: "it is not a folder",
        });
        continue;
      }
      await rm(path, { recursive: true });
      results.push({ id, path, removed: true });
    } catch (err) {
      results.push({ id, path, removed: false, error: messageOf(err) });
    }
  }
  return results;
}
