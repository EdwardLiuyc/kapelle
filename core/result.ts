/**
 * The result contract — story M1b-4, issue #20.
 *
 * Three pure pieces, in the order a task meets them: the preamble we glue onto
 * every prompt, the extractor that reads the block back out of the agent's
 * prose, and the cross-check that compares what the agent *said* against what
 * we *observed*.
 *
 * **There is no re-ask.** The original story sent one bounded follow-up when
 * the block was missing; `docs/STORIES.md:1084` strikes it and
 * `protocol/agent.ts` refuses a prompt during a live turn. A re-ask after the
 * turn ends would reach the harness, but copilot's prompt handler aborts
 * background work unconditionally (github/copilot-cli#4555), and a concurrent
 * prompt reads as an injection attempt on opencode (M0-4). So the
 * preamble lands on the first shot or not at all, and a miss is a warning plus
 * a synthesised summary — never a failure. Compliance with a prompt is not
 * enforceable, and failing on it would make a non-compliant harness unusable
 * rather than noisy.
 */

/** The extracted block. `status` is the agent's own word, not our vocabulary:
 *  a harness that writes "ok" instead of "success" has still reported, and
 *  rejecting the block would throw away a good summary over a synonym. No
 *  check branches on it since #119 dropped `claimedSuccessNoDiff`; it rides
 *  the result for whoever reads it.
 *
 *  `RESULT_PREAMBLE` below *asks* for a closed list even so — see the
 *  asymmetry it documents, which is deliberate rather than a contradiction. */
export interface AgentResult {
  status: string;
  summary: string;
  details: string;
  files?: string[];
  branch?: string;
}

type ResultWarningKind =
  | "noResultBlock"
  | "filesNotInDiff"
  | "filesUnclaimed"
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
 *
 * **Asked strictly, accepted liberally, on purpose** (#88). This text names a
 * closed vocabulary — `success | partial | failed` — while `AgentResult.status`
 * accepts whatever arrives. Both halves earn their side: a model given a free
 * choice writes "ok", "complete" or "done-ish", and every reader of the
 * status — a person, or a later stage's prompt — is then left to guess what
 * the synonym meant. Enforcing the
 * list on the way back in would cost more — a block rejected over one word
 * loses its summary and its `<files>` too, and compliance with a prompt is not
 * enforceable anyway (see the no-re-ask note at the top). So the ask is strict
 * and the parse is forgiving.
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
  // One path per line is what the preamble asks for; a comma *followed by
  // whitespace* is what half of them send anyway. A bare comma is not a
  // separator, because `docs/a,b.md` is a legal path and splitting it would
  // invent two files that do not exist (#88). A trailing comma is punctuation.
  const files = field(body, "files")
    ?.split(/\n|,[ \t]/)
    .map((f) => f.trim().replace(/,$/, ""))
    .filter(Boolean);
  if (files?.length) out.files = files;
  const branch = field(body, "branch");
  if (branch) out.branch = branch;
  return out;
}

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
  /** What `changedPaths` saw in the task's own checkout, or `undefined` when
   *  nothing could attribute a change to *this* task — no repository to read,
   *  or no worktree isolating it from its siblings (#88). Undefined is
   *  *unknown*, never *empty*: every check below that compares against the
   *  working tree skips itself rather than guessing. Ignored paths are already
   *  out, which is what keeps `.kapelle/` from reading as agent work
   *  (M1b-3). */
  changed?: readonly string[];
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
  const { result, changed, permissionCount, asksPermission } = input;
  const out: ResultWarning[] = [];
  const touched = changed !== undefined && changed.length > 0;

  if (!result) {
    out.push({
      kind: "noResultBlock",
      text: touched
        ? `no <task-result> block, and the working tree changed — what was ` +
          `done is only in the prose.`
        : `no <task-result> block; the summary below is synthesised from the ` +
          `agent's prose, not reported by it.`,
    });
  } else {
    // Exact paths, never a substring search of the status text: a listed
    // `run.ts` would otherwise match `core/run.ts.new`.
    const seen = new Set(changed ?? []);
    const missing = result.files?.filter((f) => !seen.has(f)) ?? [];
    if (changed !== undefined && missing.length) {
      out.push({
        kind: "filesNotInDiff",
        text: `<files> names ${missing.join(", ")}, which the working tree does not show as changed.`,
      });
    }

    // The other direction, and the one `RESULT_PREAMBLE` already asks for:
    // "one repo-relative path per line, only if you changed files". Measured
    // 2026-09-10 (M1c-6, #30) — pi loads the `pi-lens` extension from
    // `~/.pi/agent/settings.json`, which writes telemetry
    // (`.pi-lens-probe-home/`, eight files) into whatever workspace root it is
    // handed; the task claimed `NOTE-pi.md` alone, and the run said `done` with nothing
    // to read. `release` commits the whole tree, so those eight reached a
    // branch and then a merge on the strength of a list that did not mention
    // them.
    //
    // **Only when `<files>` is present and non-empty.** The field is optional
    // and omitting it is what a real agent that forgot looks like
    // (`mock-agent.mjs`'s `unasked-write` is exactly that shape), so firing on
    // its absence would warn on every task that never used it and drown the
    // case where a list exists and is short. That absence stays uncovered on
    // purpose; `policyNeverFired` is the check that speaks for a tree nobody
    // described.
    const claimed = new Set(result.files ?? []);
    const unclaimed =
      changed !== undefined && claimed.size
        ? changed.filter((f) => !claimed.has(f))
        : [];
    if (unclaimed.length) {
      out.push({
        kind: "filesUnclaimed",
        text: `the working tree also shows ${unclaimed.join(", ")}, which <files> does not name.`,
      });
    }
  }

  // Not an anomaly report, because on opencode it is not an anomaly: the M0-1
  // survey found it mutating a workspace with zero permission requests, in
  // every mode. Where the registry already says so, `warningsFor` prints its
  // containment line and this warning would only repeat it per task (#20).
  if (touched && permissionCount === 0 && asksPermission !== false) {
    out.push({
      kind: "policyNeverFired",
      text: `changed the working tree without ever asking permission, on a harness that normally asks.`,
    });
  }

  return out;
}
