/**
 * `git diff` text, read for a screen (M4-6): where each file starts, the
 * one line a question box shows. `cleanDiff` (`client/room.ts`) makes it
 * safe to draw.
 *
 * **Any `git diff` text**, not only the daemon's: a question's edit, an
 * agent's checkout (`GET /rooms/:id/agents/:agentId/diff`), or a diff a
 * later story hands in before a merge (M6-11a, M6-11b). The counts come
 * from the daemon's `Diff`, taken before it cut the text.
 *
 * `agentDiff` is the one call; the rest does no I/O.
 */

import type { Diff } from "./contract.ts";
import { call, type DaemonAddress } from "./daemon.ts";

/** One file in a diff: its path, the line its header starts on, and
 *  whether git calls it new or deleted. */
export interface DiffFile {
  path: string;
  line: number;
  tag?: "new" | "deleted";
}

/**
 * The path in a `diff --git a/<path> b/<path>` header. Both halves are the
 * same path (renames are off), so its length is known; a header that does
 * not fit is shown from its last ` b/`.
 */
function pathOf(header: string): string {
  const rest = header.slice("diff --git ".length);
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && n > 0 && rest.slice(2, 2 + n) === rest.slice(-n)) {
    return rest.slice(-n);
  }
  const at = rest.lastIndexOf(" b/");
  return at >= 0 ? rest.slice(at + 3) : rest;
}

/** Each file of `lines`, in order. */
export function filesOf(lines: readonly string[]): DiffFile[] {
  const files: DiffFile[] = [];
  let header = false;
  for (const [line, text] of lines.entries()) {
    if (text.startsWith("diff --git ")) {
      files.push({ path: pathOf(text), line });
      header = true;
    } else if (text.startsWith("@@")) header = false;
    else if (header && text.startsWith("new file mode")) {
      (files.at(-1) as DiffFile).tag = "new";
    } else if (header && text.startsWith("deleted file mode")) {
      (files.at(-1) as DiffFile).tag = "deleted";
    }
  }
  return files;
}

/** A file's path with its tag: `notes.md (new)`. */
export const named = (f: DiffFile) => (f.tag ? `${f.path} (${f.tag})` : f.path);

/**
 * The question box's one line (decided 2026-10-05, #204):
 * `± cli.ts +4 −1`, or `± cli.ts and 19 more files +120 −30`.
 */
export function diffLine(d: Diff): string {
  const first = filesOf(d.text.split("\n"))[0];
  const name = first ? named(first) : "?";
  const more = d.files - 1;
  const others = more > 0 ? ` and ${more} more file${more > 1 ? "s" : ""}` : "";
  return `± ${name}${others} +${d.added} −${d.removed}`;
}

/** `GET /rooms/:id/agents/:agentId/diff`: what an agent changed, against
 *  `head` (what is not committed) or `base` (the whole branch). */
export const agentDiff = (
  d: DaemonAddress,
  roomId: string,
  agentId: string,
  against: "head" | "base",
) =>
  call<Diff>(d, `/rooms/${roomId}/agents/${agentId}/diff?against=${against}`);
