/**
 * The result contract — story M1b-4, issue #20.
 *
 * Three pure pieces, in the order a task meets them: the preamble we glue onto
 * every prompt, the extractor that reads the block back out of the agent's
 * prose, and the cross-check that compares what the agent *said* against what
 * we *observed*.
 *
 * **There is no re-ask.** The original story sent one bounded follow-up when
 * the block was missing; `docs/STORIES.md:1046` strikes it and
 * `protocol/agent.ts:446` makes it unreachable — `prompt()` throws on a second
 * call, because copilot's prompt handler aborts the session unconditionally
 * and opencode reads a second prompt as an injection attempt (M0-4). So the
 * preamble lands on the first shot or not at all, and a miss is a warning plus
 * a synthesised summary — never a failure. Compliance with a prompt is not
 * enforceable, and failing on it would make a non-compliant harness unusable
 * rather than noisy.
 */

/** The extracted block. `status` is the agent's own word, not our vocabulary:
 *  a harness that writes "ok" instead of "success" has still reported, and
 *  rejecting the block would throw away a good summary over a synonym. Only
 *  the cross-check reads it, and only to recognise a success claim. */
export interface AgentResult {
  status: string;
  summary: string;
  details: string;
  files?: string[];
  branch?: string;
}

type ResultWarningKind =
  | "noResultBlock"
  | "claimedSuccessNoDiff"
  | "filesNotInDiff"
  | "policyNeverFired";

/** `kind` is what a test asserts on; `text` is what an operator reads. Same
 *  split, and for the same reason, as `registry.ts`'s `Warning`. */
export interface ResultWarning {
  kind: ResultWarningKind;
  text: string;
}

/**
 * Appended after the task's own prompt, with a blank line between.
 *
 * **Last, deliberately** — a model follows the last thing it read, and the
 * job itself must not be pushed down the page by our bookkeeping. M3-3 injects
 * a predecessor's summary into the same prompt; `docs/STORIES.md:1430` owns
 * that ordering and this story does not settle it.
 *
 * **No sample block.** A worked example is the surest way to get the tag names
 * right and the surest way to have the agent echo it back before doing the
 * work; the shape is described in one sentence instead. `extractResult` takes
 * the *last* block anyway, so an early echo is harmless either way.
 */
export const RESULT_PREAMBLE =
  `When the work is done, end your final message with a task-result block, ` +
  `and write nothing after it.\n\n` +
  `The block is a <task-result> element holding, in this order: <status> with ` +
  `exactly one of the words success, partial or failed; <summary>, one ` +
  `sentence; <details>, what you changed and why; then <files>, one ` +
  `repo-relative path per line, only if you changed files; then <branch>, ` +
  `only if you created or switched a branch.\n\n` +
  `Report only what you actually did. Do not write the block before the work ` +
  `is done.`;

export function withResultPreamble(prompt: string): string {
  return `${prompt}\n\n${RESULT_PREAMBLE}`;
}

/** Every block in the message, so the last one wins. Non-greedy: a greedy
 *  wrapper would span an echoed example and the real block as one, and the
 *  field reads below would then answer from the example. */
const BLOCK = /<task-result>([\s\S]*?)<\/task-result>/g;

function field(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  const text = m?.[1]?.trim();
  return text ? text : undefined;
}

/**
 * `null` when the wrapper is absent, or when any required field is missing or
 * empty after trimming. A missing *optional* field is `undefined` — absence is
 * not a rejection, or `<branch>` would fail every task that stayed on one.
 */
export function extractResult(message: string): AgentResult | null {
  const blocks = [...message.matchAll(BLOCK)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return null;

  const status = field(body, "status");
  const summary = field(body, "summary");
  const details = field(body, "details");
  if (!status || !summary || !details) return null;

  const out: AgentResult = { status, summary, details };
  // One path per line is what the preamble asks for; commas are what half of
  // them send anyway, and splitting on both costs one character.
  const files = field(body, "files")
    ?.split(/[\n,]/)
    .map((f) => f.trim())
    .filter(Boolean);
  if (files?.length) out.files = files;
  const branch = field(body, "branch");
  if (branch) out.branch = branch;
  return out;
}

/**
 * Paths named by `git status --porcelain --untracked-files=all`.
 *
 * Renames contribute both halves: an agent may reasonably report either the
 * old path it changed or the new path it created. Quoted paths are decoded
 * with Git's C-style rules, so `"src/caf\303\251.ts"` compares equal to the
 * `src/café.ts` an agent reports. An unquoted path containing ` -> ` on a
 * rename line is ambiguous in porcelain v1; the first top-level separator is
 * the conventional reading, and this parser does not pretend to solve what
 * Git itself does not delimit.
 */
function porcelainPaths(status: string): string[] {
  const paths = new Set<string>();
  for (const line of status.split("\n")) {
    // Two status letters, one space, then the path. A shorter line carries
    // no path and therefore says nothing about the tree.
    if (line.length < 4) continue;
    const body = line.slice(3);
    const rename = /^[ACDR]/.test(line) && hasTopLevelSeparator(body);
    if (!rename) {
      paths.add(unquoteGitPath(body));
      continue;
    }
    const at = topLevelSeparator(body);
    if (at === undefined) continue;
    paths.add(unquoteGitPath(body.slice(0, at)));
    paths.add(unquoteGitPath(body.slice(at + 4)));
  }
  return [...paths];
}

/** The index of the first ` -> ` outside a quoted path, for rename lines. */
function topLevelSeparator(body: string): number | undefined {
  let quoted = false;
  for (let i = 0; i < body.length - 3; i++) {
    if (body[i] === '"') quoted = !quoted;
    if (!quoted && body.startsWith(" -> ", i)) return i;
  }
  return undefined;
}

const hasTopLevelSeparator = (body: string): boolean =>
  topLevelSeparator(body) !== undefined;

/** Turns a possibly C-quoted porcelain path into the path Git names. */
function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) {
    return path;
  }
  // Decode through bytes: Git octal-escapes UTF-8 byte by byte, so collecting
  // the bytes and decoding once keeps a multi-byte character intact.
  const bytes: number[] = [];
  const escaped = path.slice(1, -1);
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] !== "\\") {
      bytes.push(...encoder.encode(escaped[i]));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(escaped.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += octal[0].length;
      continue;
    }
    const char = escaped[++i];
    bytes.push(
      ...encoder.encode(
        char === "n"
          ? "\n"
          : char === "r"
            ? "\r"
            : char === "t"
              ? "\t"
              : char === "b"
                ? "\b"
                : char === "f"
                  ? "\f"
                  : char === "v"
                    ? "\v"
                    : char,
      ),
    );
  }
  return decoder.decode(new Uint8Array(bytes));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The summary for a task that reported nothing structured.
 *
 * The *tail* of the prose, because a final message ends with what the agent
 * did and begins with what it planned to do. Always flagged as synthesised by
 * the caller — M3-3 must be able to tell a successor that its predecessor
 * reported nothing, rather than passing our guess off as the agent's words.
 */
export function synthesiseSummary(transcript: string, max = 240): string {
  const prose = transcript.trim().replace(/\s+/g, " ");
  return prose.length <= max ? prose : `…${prose.slice(-max)}`;
}

export interface CrossCheckInput {
  result: AgentResult | null;
  /** `git status --porcelain --untracked-files=all` for the task's checkout,
   *  or `undefined` when there was no repository to read one from. Undefined
   *  is *unknown*, never *empty*: every check below that compares against the
   *  working tree is skipped rather than guessed. Ignored paths are already
   *  out, which is what keeps `.agent-team/` from reading as agent work
   *  (M1b-3). */
  diff?: string;
  /** `_client_permission` events seen for this task. */
  permissionCount: number;
  /** The registry's `measured.asksPermission`, `undefined` for a harness with
   *  no measured half. */
  asksPermission?: boolean;
}

/**
 * What the agent said, against what we saw. Never fatal — a read-only stage
 * legitimately produces no diff, and making disagreement fail the task would
 * turn every harness quirk into a hard stop.
 */
export function crossCheck(input: CrossCheckInput): ResultWarning[] {
  const { result, diff, permissionCount, asksPermission } = input;
  const out: ResultWarning[] = [];
  const changed = diff !== undefined && diff !== "";

  if (!result) {
    out.push({
      kind: "noResultBlock",
      text: changed
        ? `no <task-result> block, and the working tree changed — what was ` +
          `done is only in the prose.`
        : `no <task-result> block; the summary below is synthesised from the ` +
          `agent's prose, not reported by it.`,
    });
  } else {
    if (result.status.toLowerCase() === "success" && diff === "") {
      out.push({
        kind: "claimedSuccessNoDiff",
        text: `reported success, but the working tree is unchanged.`,
      });
    }
    // Parse the porcelain paths rather than substring-search the text: a
    // listed `run.ts` would otherwise match `core/run.ts.new`, and a quoted
    // path would never match the name the agent reports.
    const changedPaths = new Set(
      diff === undefined ? [] : porcelainPaths(diff),
    );
    const missing = result.files?.filter((f) => !changedPaths.has(f)) ?? [];
    if (diff !== undefined && missing.length) {
      out.push({
        kind: "filesNotInDiff",
        text: `<files> names ${missing.join(", ")}, which the working tree does not show as changed.`,
      });
    }
  }

  // Not an anomaly report, because on opencode it is not an anomaly: the M0-1
  // survey found it mutating a workspace with zero permission requests, in
  // every mode. Where the registry already says so, `warningsFor` prints its
  // containment line and this warning would only repeat it per task (#20).
  if (changed && permissionCount === 0 && asksPermission !== false) {
    out.push({
      kind: "policyNeverFired",
      text: `changed the working tree without ever asking permission, on a harness that normally asks.`,
    });
  }

  return out;
}
