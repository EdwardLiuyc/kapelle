/**
 * `git diff` text for a person to read (M4-6).
 *
 * Three sources, one shape (`Diff`):
 *
 * - **A question's edit.** `AcpAgent` names the files a tool call would
 *   write, after the path guard (`PolicyEdit`). `editDiff` writes the old and
 *   the new text to a temporary folder and runs `git diff --no-index`, so a
 *   harness `diff` block, copilot's `file_text` and our own
 *   `fs/write_text_file` all read the same. The queue calls it only for a
 *   question that waits for a person, so `auto` and `safe` pay nothing.
 * - **An agent's checkout.** `checkoutDiff` is the checkout against a ref:
 *   `HEAD` for what is not committed, or the base for the whole branch. New
 *   files git does not track yet are in it too: `git add -N` marks them in a
 *   copy of the index, so the agent's own index never changes. A room uses
 *   `mergeBase` to find that base from the configured ref and live `HEAD`.
 * - **A fast-forward preview.** `rangeDiff` diffs `from...to`, so it starts at
 *   the two refs' merge base: a target's own commits are not shown as
 *   deletions, and the source's additions are (M6-11a).
 *
 * **The cap** (decided 2026-10-05, #204): a question's diff is kept for the
 * daemon's life, so it is cut at 32 KB; the route's is not kept, so 512 KB.
 * Both cut at a line end and add `… N more lines`. The counts are taken
 * before the cut.
 *
 * A question's diff rides on `_client_permission_queued`, so the event log
 * writes it to disk and replays it to every client that attaches, as it
 * does the question's `input`.
 *
 * Every git call turns off what a user's config could add: colour, an
 * external diff, a text conversion and renames, and quotes in a path.
 */

import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { PolicyEdit } from "../protocol/agent.ts";
import type { Diff } from "../protocol/types.ts";

const run = promisify(execFile);

const QUESTION_CAP = 32 * 1024;
const ROUTE_CAP = 512 * 1024;

/** What every diff call passes, so a user's config changes nothing. */
const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
];

/** The absolute file path inside `dir`, or a throw when `path` leaves it. */
function underDir(dir: string, path: string): string {
  const target = resolve(dir, path);
  const rel = relative(dir, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`diff path leaves its temporary folder: ${path}`);
  return target;
}

/** `git` with its stdout. `git diff` exits 1 when the two sides differ,
 *  which is not an error here. */
async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await run(
      "git",
      ["-c", "core.quotepath=false", ...args],
      // ponytail: a diff past 64 MB fails; stream and cut it if one ever
      // needs to show.
      { cwd, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string };
    if (e.code === 1 && args.includes("diff") && e.stdout !== undefined) {
      return e.stdout;
    }
    throw err;
  }
}

/**
 * The counts of `text`, and the text cut to `cap` bytes at a line end. A
 * line counts as added or removed only inside a hunk, so a header line
 * (`--- a/x`) never counts.
 */
export function capDiff(text: string, cap: number): Diff {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let files = 0;
  let added = 0;
  let removed = 0;
  let hunk = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      files += 1;
      hunk = false;
    } else if (line.startsWith("@@")) hunk = true;
    else if (hunk && line.startsWith("+")) added += 1;
    else if (hunk && line.startsWith("-")) removed += 1;
  }
  let kept = 0;
  let bytes = 0;
  for (const line of lines) {
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > cap) break;
    kept += 1;
  }
  const out = lines.slice(0, kept);
  if (kept < lines.length) out.push(`… ${lines.length - kept} more lines`);
  return { text: out.join("\n"), files, added, removed };
}

/**
 * The diff of the files a question's tool call would write, or `undefined`
 * when it changes nothing. A missing old text is read from disk; a file
 * that is not there is new.
 */
export async function editDiff(
  edits: readonly PolicyEdit[],
  cap = QUESTION_CAP,
): Promise<Diff | undefined> {
  const tmp = await mkdtemp(join(tmpdir(), "kapelle-diff-"));
  try {
    const parts: string[] = [];
    for (const [i, e] of edits.entries()) {
      // A path from a symlink outside the root can carry `..` back into the
      // workspace. Refuse it before any write: the diff text is not worth
      // changing a file before the person answers.
      if (isAbsolute(e.path))
        throw new Error(`diff path is absolute: ${e.path}`);
      // One folder per edit, so two edits of one path do not meet. git
      // names each side as it is passed: `a/<path>` and `b/<path>`.
      const dir = join(tmp, String(i));
      const a = join("a", e.path);
      const b = join("b", e.path);
      const aFile = underDir(dir, a);
      const bFile = underDir(dir, b);
      const old =
        e.oldText !== undefined
          ? e.oldText
          : await readFile(e.abs, "utf8").catch(() => null);
      for (const [file, text] of [
        [aFile, old],
        [bFile, e.newText],
      ] as const) {
        if (text === null) continue;
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text, "utf8");
      }
      let out = await git(dir, [
        "diff",
        "--no-index",
        "--no-prefix",
        ...DIFF_FLAGS,
        old === null ? "/dev/null" : a,
        b,
      ]);
      // A new file's header names `b/` twice; say `a/` first, as git does
      // in a repository.
      if (old === null) out = out.replace(/^diff --git b\//, "diff --git a/");
      parts.push(out);
    }
    const text = parts.join("");
    return text ? capDiff(text, cap) : undefined;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * The merge base of a configured base ref and another ref. Undefined when
 * the base ref no longer resolves, so a room can use its saved SHA. Other
 * git failures stay errors.
 */
export async function mergeBase(
  dir: string,
  baseRef: string,
  ref: string,
): Promise<string | undefined> {
  let base: string;
  try {
    base = await git(dir, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  } catch {
    return undefined;
  }
  return (await git(dir, ["merge-base", base.trim(), ref])).trim();
}

/**
 * An agent's checkout against `ref`: `HEAD` for what is not committed, or
 * the base for the whole branch. The new files git does not track are in it
 * as new, from a copy of the index. Throws when `dir` is not in a git
 * checkout or `ref` does not resolve.
 */
export async function checkoutDiff(
  dir: string,
  ref: string,
  cap = ROUTE_CAP,
): Promise<Diff> {
  const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  const index = resolve(
    top,
    (await git(top, ["rev-parse", "--git-path", "index"])).trim(),
  );
  const tmp = await mkdtemp(join(tmpdir(), "kapelle-index-"));
  try {
    const copy = join(tmp, "index");
    // A checkout with no commit yet has no index: start from none.
    await copyFile(index, copy).catch(() => {});
    const env = { ...process.env, GIT_INDEX_FILE: copy };
    await git(top, ["add", "--intent-to-add", "--", "."], env);
    const text = await git(
      top,
      ["diff", ...DIFF_FLAGS, "--src-prefix=a/", "--dst-prefix=b/", ref, "--"],
      env,
    );
    return capDiff(text, cap);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * What `toRef` adds over `fromRef` (M6-11a): the commits a fast-forward
 * would bring, with no working-tree changes and no untracked files. Used by
 * the TUI's preview before it confirms the move.
 */
export async function rangeDiff(
  cwd: string,
  fromRef: string,
  toRef: string,
  cap = ROUTE_CAP,
): Promise<Diff> {
  const text = await git(cwd, [
    "diff",
    ...DIFF_FLAGS,
    "--src-prefix=a/",
    "--dst-prefix=b/",
    // Three dots: from where the two meet, so a target commit the source
    // lacks is not shown as removed.
    `${fromRef}...${toRef}`,
    "--",
  ]);
  return capDiff(text, cap);
}
