/**
 * The room reducer (M6-10): room lines in, screen state out.
 *
 * **No I/O.** It reads the `{seq, roomId, participantId, update}` lines a
 * client already has and keeps what a screen draws: the roster and each
 * participant's status, the room timeline, each turn, the live stall
 * warning, the queue, the open permission questions, unread and attention
 * marks, and what an activity row and the footer show (M7-1): thinking, the
 * last tool, the last usage.
 * It keeps no thinking text, and of a tool's diff only its counts (M7-2).
 * A TUI and a bridge
 * share it, so neither parses events itself.
 *
 * **A tool's title and detail are several lines** (#351): most shell
 * commands are several commands in one. `commandLines` keeps a real
 * newline and breaks after a `;` that separates. Every screen draws the
 * first line with its own prefix and the rest under it.
 *
 * **It mutates the state it is given.** An answer arrives one chunk at a
 * time, and copying the timeline per chunk would be quadratic. `applyLine`
 * returns the entry it added or changed, so a screen redraws only that one.
 *
 * **The stream is the only source** (R13a, R8c). The roster is built from
 * `_client_participant_*` lines, so a replay shows it as it was at each
 * `seq`. A thread is the timeline filtered by `participantId`. A line whose
 * `seq` is not above the last one is skipped, so a reconnect that repeats a
 * line adds nothing.
 *
 * **A turn is open, ended or cut.** A cut turn has a `_client_user_message`
 * and no `_client_turn_ended`; the reducer learns of it when the next turn of
 * the same participant starts, or from `GET /rooms/:id`.
 *
 * **What a restart leaves is not on the stream** (M6-7a). The boot sweep adds
 * no line, so a participant a shutdown paused, or a crash killed, reads
 * `paused` or `killed` only in `GET /rooms/:id`. `applyStatus` takes that
 * reply. The reply and the replay can arrive in either order, so the reply's
 * `seq` says which lines it already counts: its status holds until a
 * `_client_participant_revived` line with a higher `seq`, and a revive at or
 * below it is old history. A turn it cuts is cut only until the log shows
 * its end. The room's own status (`dismissed`, `paused`) is read the same
 * way (S11).
 */

import type { UsageUpdate } from "../protocol/types.ts";
import type {
  Diff,
  PermissionReason,
  RoomDto,
  RoomEventLine,
  ToolCallStatus,
  ToolKind,
} from "./contract.ts";

type Mode = "ask" | "safe" | "auto";

/** One thing the timeline shows, in the order it first appeared. An answer
 *  grows in place while its chunks arrive, and a permission question gets
 *  its answer in place. A message's `from` is the id of the participant
 *  that sent it; none is the person (M8-1). */
export type Entry = {
  seq: number;
  participantId: string;
  /** When the line was written (M7-1): the heading shows it. */
  at: string;
} & (
  | { type: "user"; text: string; turn?: number; from?: string }
  | { type: "queued"; text: string; from?: string }
  | { type: "queue_cleared"; count: number }
  | { type: "answer"; text: string }
  /** One tool call. Its `tool_call_update`s change it in place (#240).
   *  `detail`: what the title does not say, such as the command or path.
   *  `kind`: one ACP defines. `added` and `removed`: the lines its diff
   *  changes, when an update carries one (M7-2). */
  | {
      type: "tool";
      title: string;
      detail?: string;
      status?: ToolCallStatus;
      kind?: ToolKind;
      added?: number;
      removed?: number;
    }
  | { type: "turn_ended"; stopReason?: string; error?: string }
  | { type: "exited" }
  /** A stopped participant has a new harness (M6-7a), with its old session
   *  or a fresh one (M6-7b). `resumed` is kept as sent, so a value this
   *  client does not know is shown as text. `behind`: a loaded one's memory
   *  may be behind its files. */
  | { type: "revived"; resumed: string; behind?: true }
  | { type: "forward"; from: string; branch: string; sha: string }
  | {
      type: "permission";
      id: string;
      title: string;
      kind: ToolKind;
      turn?: number;
      /** The tool's input, as `key: value` text (M4-3). */
      input?: Record<string, string>;
      /** What the edit would change, drawable (M4-6). */
      diff?: Diff;
      /** Both set once the question closed. */
      allow?: boolean;
      reason?: PermissionReason;
    }
  | { type: "stall"; kind: "idle" | "repeat"; text: string }
);

/**
 * The harness's text with its control and format characters made spaces, so
 * a title or an input can draw no escape sequence, clear no screen and break
 * no line (M4-3). Format characters (`Cf`: bidi overrides, zero-width
 * marks, the soft hyphen, the Tags block) and the line and paragraph
 * separators go too: they change what a person reads in the question box,
 * not what runs, so a right-to-left override could flip a command. The
 * question's text and a stall warning's go through it (M4-4: a repeat warning
 * quotes a tool title). Text with lines uses `cleanLines`.
 */
export const printable = (s: string) =>
  s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");

/**
 * Text with each line drawable: a tab is four spaces, and the rest is as
 * `printable` makes it. The lines stay lines, and the zero-width joiner stays,
 * so a family emoji is one emoji. For a diff (M4-6), and for a person's
 * message and an agent's answer (#229): pi-tui's `Markdown` passes an escape
 * sequence through, so an answer that holds `ESC]52` could write the
 * clipboard. `core/text.ts` has the same rule as `clean`, as `client/`
 * cannot import `core/`; `tests/text.test.ts` checks that they agree.
 */
export const cleanLines = (text: string) =>
  text
    .replaceAll("\t", "    ")
    .replace(/[[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]--[\n\u200D]]/gv, " ");

type Answer = Extract<Entry, { type: "answer" }>;
type Question = Extract<Entry, { type: "permission" }>;
type Tool = Extract<Entry, { type: "tool" }>;

/** The `rawInput` keys a tool row may show, in this order (#240). Never a
 *  whole file (`old_string`, `file_text`, `content`) or `rawOutput`. */
const DETAIL_KEYS = [
  "command",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
  "url",
];
/** The most a tool row's title or detail keeps, in characters per line. */
const TOOL_TEXT = 200;
/** The most lines a tool row's title or detail shows, before `… N more
 *  lines` (#351). */
const TOOL_LINES = 4;
/** The most a slot keeps of each text: enough to compare, with no whole
 *  file in a command such as `python - <<'EOF'`. */
const SLOT_TEXT = 4 * TOOL_TEXT;

/** A tool call's entry, and what its detail is worked out from. Only the
 *  keys the detail can use are kept, each cut at `SLOT_TEXT`. */
interface ToolSlot {
  entry: Tool;
  /** Before `toolText`, so a long command still matches the title it is
   *  in: both are cut at the same length. */
  title: string;
  input: Record<string, string>;
  location?: string;
}

// The log is the harness's JSON: this decodes it at the edge.
// pi-lens-ignore: no-unknown-parameters
const str = (v: unknown) =>
  // pi-lens-ignore: no-runtime-typeof
  typeof v === "string" ? v.slice(0, SLOT_TEXT) : undefined;

const STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
/** The status if it is one ACP defines; the log is the harness's JSON. */
// The log is the harness's JSON: this decodes it at the edge.
// pi-lens-ignore: no-unknown-parameters
const statusOf = (v: unknown) =>
  STATUSES.has(v as string) ? (v as ToolCallStatus) : undefined;

const KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
/** The kind if it is one ACP defines; a fold line counts by it (M7-2). */
// The log is the harness's JSON: this decodes it at the edge.
// pi-lens-ignore: no-unknown-parameters
const kindOf = (v: unknown) =>
  KINDS.has(v as string) ? (v as ToolKind) : undefined;

/** A text's lines; a last newline ends a line, and starts none. */
const linesOf = (s: string) =>
  s === "" ? [] : s.replace(/\n$/, "").split("\n");

/**
 * The lines a tool's `diff` blocks add and remove (M7-2). Not a real diff:
 * the lines both texts share at the start and at the end are dropped, and
 * what is left of each is counted. Exact for one change in one place, too
 * high for an edit in several. An `oldText` that is not text is a new
 * file. `undefined` when the content has no diff.
 */
// ponytail: counts too high for an edit in several places; a line diff
// (Myers) if the numbers mislead.
// The log is the harness's JSON: this decodes it at the edge.
// pi-lens-ignore: no-unknown-parameters
function diffCount(content: unknown) {
  if (!Array.isArray(content)) return undefined;
  let added = 0;
  let removed = 0;
  let any = false;
  for (const c of content) {
    // pi-lens-ignore: no-runtime-typeof
    if (c?.type !== "diff" || typeof c.newText !== "string") continue;
    any = true;
    // pi-lens-ignore: no-runtime-typeof
    const a = linesOf(typeof c.oldText === "string" ? c.oldText : "");
    const b = linesOf(c.newText);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
      start++;
    }
    let end = 0;
    while (
      end < a.length - start &&
      end < b.length - start &&
      a[a.length - 1 - end] === b[b.length - 1 - end]
    ) {
      end++;
    }
    added += b.length - start - end;
    removed += a.length - start - end;
  }
  return any ? { added, removed } : undefined;
}

/** Sets a tool entry's kind and counts from a `tool_call` or its update,
 *  where they say them. */
function toolFacts(entry: Tool, u: { kind?: unknown; content?: unknown }) {
  const kind = kindOf(u.kind);
  if (kind) entry.kind = kind;
  const n = diffCount(u.content);
  if (n) Object.assign(entry, n);
}

/**
 * A shell command's lines (#351). Most commands are several commands in
 * one, so a real newline stays a line, and a `;` starts the next one. Not
 * a shell parser: it knows the common places where a `;` does not
 * separate — inside `'…'` or `"…"`, `$(…)`, process substitutions,
 * arithmetic, `${…}`, backticks, comments, and heredoc bodies. `&&`,
 * `||` and `|` never break, because they read as one thought. A `;` ends
 * its own line, so a trailing one makes no empty line, and a line with
 * nothing on it is dropped.
 *
 * A newline always breaks, even inside a quote: what a person reads must
 * match what the harness sent. A quote can stay open across that row, as
 * it does in the shell.
 */
// ponytail: quoting rules only, no words and no expansion. A real shell
// lexer if a command ever breaks in the wrong place.
function commandLines(text: string) {
  type Frame =
    | { kind: "single" }
    | { kind: "double" }
    | { kind: "command"; depth: number }
    | { kind: "tick" }
    | { kind: "parameter"; depth: number }
    | { kind: "arithmetic"; depth: number }
    | { kind: "comment" };
  /** A heredoc's delimiter, after quote removal. */
  type Heredoc = { tag: string; stripTabs: boolean };
  const out: string[] = [];
  /** The shell context around this character. */
  const frames: Frame[] = [];
  /** Tags read on the current command line, in body order. */
  const pending: Heredoc[] = [];
  /** Bodies whose delimiter has not arrived, in order. */
  const bodies: Heredoc[] = [];
  const top = () => frames.at(-1);

  /** The delimiter after `<<`, if this is a heredoc rather than a
   *  here-string (`<<<`) or the tail of one. Reads a shell word and
   *  removes its quotes and backslashes, as the shell does for a tag. */
  const heredocAt = (raw: string, from: number) => {
    if (
      raw[from] !== "<" ||
      raw[from + 1] !== "<" ||
      raw[from + 2] === "<" ||
      raw[from - 1] === "<"
    ) {
      return undefined;
    }
    let i = from + 2;
    const stripTabs = raw[i] === "-";
    if (stripTabs) i++;
    while (raw[i] === " " || raw[i] === "\t") i++;
    let tag = "";
    let found = false;
    while (i < raw.length) {
      const c = raw[i] as string;
      if (c === "'") {
        found = true;
        i++;
        while (i < raw.length && raw[i] !== "'") tag += raw[i++];
        if (i < raw.length) i++;
        continue;
      }
      if (c === '"') {
        found = true;
        i++;
        while (i < raw.length && raw[i] !== '"') {
          const d = raw[i] as string;
          if (d === "\\" && i + 1 < raw.length) {
            const next = raw[i + 1] as string;
            if (next === "$" || next === "`" || next === '"' || next === "\\") {
              tag += next;
              i += 2;
              continue;
            }
          }
          tag += d;
          i++;
        }
        if (i < raw.length) i++;
        continue;
      }
      if (c === "\\") {
        i++;
        if (i < raw.length) {
          found = true;
          tag += raw[i++];
        }
        continue;
      }
      if (/[\s;&|<>()]/.test(c)) break;
      found = true;
      tag += c;
      i++;
    }
    if (!found) return undefined;
    return { tag, stripTabs, end: i };
  };

  /** A `$(` or `$((` at `i`: push its context and return the last char it
   *  takes. The caller appends the rest of the operator. */
  const dollarAt = (raw: string, i: number) => {
    if (raw[i + 1] !== "(") return undefined;
    if (raw[i + 2] === "(") {
      frames.push({ kind: "arithmetic", depth: 2 });
      return i + 2;
    }
    frames.push({ kind: "command", depth: 0 });
    return i + 1;
  };

  for (const raw of text.split("\n")) {
    const body = bodies[0];
    if (body) {
      out.push(raw);
      const line = body.stripTabs ? raw.replace(/^[\t ]+/, "") : raw;
      if (line === body.tag) bodies.shift();
      continue;
    }
    let cur = "";
    let first = true;
    const push = () => {
      const seg = first ? cur : cur.trimStart();
      if (seg !== "") out.push(seg);
      first = false;
      cur = "";
    };
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i] as string;
      cur += c;
      const frame = top();
      if (frame?.kind === "comment") continue;
      if (frame?.kind === "single") {
        if (c === "'") frames.pop();
        continue;
      }
      if (frame?.kind === "double") {
        if (c === "\\" && i + 1 < raw.length) {
          cur += raw[++i];
          continue;
        }
        if (c === '"') {
          frames.pop();
          continue;
        }
        if (c === "$") {
          const end = dollarAt(raw, i);
          if (end !== undefined) {
            cur += raw.slice(i + 1, end + 1);
            i = end;
            continue;
          }
          if (raw[i + 1] === "{") {
            cur += raw[++i];
            frames.push({ kind: "parameter", depth: 1 });
            continue;
          }
        }
        if (c === "`") frames.push({ kind: "tick" });
        continue;
      }
      if (frame?.kind === "tick") {
        if (c === "\\" && i + 1 < raw.length) {
          cur += raw[++i];
          continue;
        }
        if (c === "`") frames.pop();
        continue;
      }
      if (frame?.kind === "parameter") {
        if (c === "\\" && i + 1 < raw.length) {
          cur += raw[++i];
          continue;
        }
        if (c === "'") {
          frames.push({ kind: "single" });
          continue;
        }
        if (c === '"') {
          frames.push({ kind: "double" });
          continue;
        }
        if (c === "`") {
          frames.push({ kind: "tick" });
          continue;
        }
        if (c === "$") {
          const end = dollarAt(raw, i);
          if (end !== undefined) {
            cur += raw.slice(i + 1, end + 1);
            i = end;
            continue;
          }
          if (raw[i + 1] === "{") {
            cur += raw[++i];
            frame.depth++;
            continue;
          }
        }
        if (c === "{") {
          frame.depth++;
          continue;
        }
        if (c === "}") {
          frame.depth--;
          if (frame.depth === 0) frames.pop();
        }
        continue;
      }
      if (frame?.kind === "arithmetic") {
        if (c === "\\" && i + 1 < raw.length) {
          cur += raw[++i];
          continue;
        }
        if (c === "(") {
          frame.depth++;
          continue;
        }
        if (c === ")") {
          frame.depth--;
          if (frame.depth === 0) frames.pop();
        }
        continue;
      }
      if (frame?.kind === "command") {
        if (c === "\\" && i + 1 < raw.length) {
          cur += raw[++i];
          continue;
        }
        if (c === "'") {
          frames.push({ kind: "single" });
          continue;
        }
        if (c === '"') {
          frames.push({ kind: "double" });
          continue;
        }
        if (c === "`") {
          frames.push({ kind: "tick" });
          continue;
        }
        if (c === "$") {
          const end = dollarAt(raw, i);
          if (end !== undefined) {
            cur += raw.slice(i + 1, end + 1);
            i = end;
            continue;
          }
          if (raw[i + 1] === "{") {
            cur += raw[++i];
            frames.push({ kind: "parameter", depth: 1 });
            continue;
          }
        }
        const heredoc = heredocAt(raw, i);
        if (heredoc) {
          cur += raw.slice(i + 1, heredoc.end);
          i = heredoc.end - 1;
          pending.push({ tag: heredoc.tag, stripTabs: heredoc.stripTabs });
          continue;
        }
        if (c === "(") {
          if (raw[i + 1] === "(") {
            cur += raw[++i];
            frames.push({ kind: "arithmetic", depth: 2 });
          } else {
            frame.depth++;
          }
          continue;
        }
        if (c === ")") {
          if (frame.depth > 0) frame.depth--;
          else frames.pop();
          continue;
        }
        if (
          c === "#" &&
          (i === 0 || /[\s;|&(){}]/.test(raw[i - 1] as string))
        ) {
          frames.push({ kind: "comment" });
        }
        continue;
      }
      // No frame: the top level of a command.
      if (c === "\\" && i + 1 < raw.length) {
        cur += raw[++i];
        continue;
      }
      if (c === "'") {
        frames.push({ kind: "single" });
        continue;
      }
      if (c === '"') {
        frames.push({ kind: "double" });
        continue;
      }
      if (c === "`") {
        frames.push({ kind: "tick" });
        continue;
      }
      if (c === "$") {
        const end = dollarAt(raw, i);
        if (end !== undefined) {
          cur += raw.slice(i + 1, end + 1);
          i = end;
          continue;
        }
        if (raw[i + 1] === "{") {
          cur += raw[++i];
          frames.push({ kind: "parameter", depth: 1 });
          continue;
        }
      }
      const heredoc = heredocAt(raw, i);
      if (heredoc) {
        cur += raw.slice(i + 1, heredoc.end);
        i = heredoc.end - 1;
        pending.push({ tag: heredoc.tag, stripTabs: heredoc.stripTabs });
        continue;
      }
      if ((c === "<" || c === ">") && raw[i + 1] === "(") {
        cur += raw[++i];
        frames.push({ kind: "command", depth: 0 });
        continue;
      }
      if (c === "(" && raw[i + 1] === "(") {
        cur += raw[++i];
        frames.push({ kind: "arithmetic", depth: 2 });
        continue;
      }
      if (c === "#" && (i === 0 || /[\s;|&(){}]/.test(raw[i - 1] as string))) {
        frames.push({ kind: "comment" });
        continue;
      }
      if (c === ";") push();
    }
    push();
    while (top()?.kind === "comment") frames.pop();
    if (pending.length > 0) bodies.push(...pending.splice(0));
  }
  return out;
}

/** A tool's title or detail as rows: its lines, each cut at `TOOL_TEXT`,
 *  at most `TOOL_LINES` of them, then `… N more lines` (#351). The rows
 *  are one string with newlines, as every screen draws them together. */
const toolText = (s: string) => {
  const lines = commandLines(cleanLines(s));
  const rows = lines
    .slice(0, TOOL_LINES)
    .map((l) => (l.length > TOOL_TEXT ? `${l.slice(0, TOOL_TEXT - 1)}…` : l));
  const more = lines.length - rows.length;
  if (more > 0) rows.push(`… ${more} more line${more === 1 ? "" : "s"}`);
  return rows.join("\n");
};

/** The keys of `raw` a detail can use. `raw` is the harness's JSON. */
// The log is the harness's JSON: this decodes it at the edge.
// pi-lens-ignore: no-unknown-parameters
function detailInput(raw: unknown): Record<string, string> {
  // pi-lens-ignore: no-runtime-typeof
  if (typeof raw !== "object" || raw === null) return {};
  // Filled key by key below, so the literal starts empty.
  // pi-lens-ignore: no-known-value-widening
  const input: Record<string, string> = {};
  for (const k of [...DETAIL_KEYS, "description"]) {
    // pi-lens-ignore: no-unsafe-dictionary-unknown
    const v = str((raw as Record<string, unknown>)[k]);
    if (v) input[k] = v;
  }
  return input;
}

/** The detail line: the command, path, pattern, query or url; else the
 *  description or the first location, the first the title does not say.
 *  A part the title already says is left out: between spaces or at an
 *  end, also in quotes or backticks, or as the end of a path, since
 *  claude's title gives a path from its folder. Only a title word with a
 *  `/` or a `.` can be that end: copilot's title is prose, and `config` in
 *  "Update the config" must not hide `/w/etc/config`. `str_replace` still
 *  shows under `str_replace_editor`. */
function detailOf({ title, input, location }: ToolSlot) {
  const bare = title.replace(/[`"']/g, "");
  const paths = bare.split(" ").filter((w) => /[/.]/.test(w));
  const said = (v: string) =>
    ` ${title} `.includes(` ${v} `) ||
    ` ${bare} `.includes(` ${v} `) ||
    paths.some((w) => v.endsWith(`/${w}`));
  const parts = DETAIL_KEYS.flatMap((k) => input[k] ?? []);
  const shown =
    parts.length > 0
      ? parts.filter((v) => !said(v))
      : [input.description, location]
          .filter((v): v is string => Boolean(v) && !said(v as string))
          .slice(0, 1);
  return shown.length > 0 ? toolText(shown.join(" ")) : undefined;
}

/** Sets the entry's title and detail from its slot. */
function showTool(slot: ToolSlot) {
  slot.entry.title = toolText(slot.title);
  const detail = detailOf(slot);
  if (detail) slot.entry.detail = detail;
  // The entry has no detail key, not an undefined one.
  // pi-lens-ignore: ts-delete-property
  else delete slot.entry.detail;
}

interface Turn {
  /** From `_client_user_message`; absent on lines written before M6-5. */
  number?: number;
  text: string;
  /** The `at` of its `_client_user_message`: the activity row's timer
   *  counts from it (M7-1). */
  start?: string;
  state: "open" | "ended" | "cut";
  /** Cut because the daemon says the participant stopped, not because the
   *  log says so: its `_client_turn_ended` may still be on the way. */
  tentative?: true;
  stopReason?: string;
  error?: string;
}

/** A live stall warning (#348). The timeline entry is its history; this is
 *  only what still asks for attention. */
interface Stall {
  kind: "idle" | "repeat";
  text: string;
  /** Its line's `seq`: a later warning in the same turn rings again. */
  seq: number;
  /** The person looked. Unlike a resolve, `seen` keeps it for the bell
   *  (M4-4): it rings for a person who looks somewhere else. */
  seen: boolean;
  /** For `repeat`, the `tool_call` title it warned about. */
  title?: string;
}

interface ParticipantState {
  id: string;
  name: string;
  role?: string;
  harness: string;
  mode: Mode;
  /** `killed`: stopped during a turn (R46). `paused`: a shutdown stopped it
   *  cleanly. */
  status: "idle" | "busy" | "exited" | "paused" | "killed";
  /** What `GET /rooms/:id` said the stream cannot, and the reply's `seq`:
   *  it holds until a revive above that `seq`. */
  reported?: Report;
  /** The `seq` of its last revive: a reply below it is older. */
  revivedAt?: number;
  /** Off the roster. Kept, so its old lines still have a name. */
  removed: boolean;
  turns: Turn[];
  /** The texts that wait behind the live turn, oldest first. */
  queue: string[];
  /** The answer being streamed, until another line of this participant's. */
  answer?: Answer;
  /** Timeline entries not from the person, since the last `seen`. */
  unread: number;
  /** The live stall warning, until it is resolved or its turn ends. An
   *  idle one is resolved by its harness's next line; a repeat one by a
   *  `tool_call` with another title. */
  stall?: Stall;
  /** The line that resolved an idle warning, so `quiet` keeps its frame. */
  stallResolvedAt?: number;
  /** The `seq` of the thought chunk that set the flag (M7-1). Only the
   *  flag: the text is large (pi), and never drawn. An answer chunk, a tool
   *  call or the turn's end clears it, and nothing else: a `usage_update`
   *  would make the row flicker. The `seq` says which chunk changed it, so a
   *  screen draws a frame for that one only. */
  thinking?: number;
  /** The live turn's last tool call (M7-1). The entry, not its title:
   *  its updates set the title in place (#240). */
  tool?: Tool;
  /** The live turn's last `tool_call` title, as the watchdog compares it. */
  callTitle?: string;
  /** The last `usage_update`. The cost in it is a running total for the
   *  session (§M0-5): never add two of them up. */
  usage?: UsageUpdate;
}

/** A `paused` or `killed` from `GET /rooms/:id`, and the log's size when
 *  the daemon answered. */
interface Report {
  status: "paused" | "killed";
  seq: number;
}

export interface RoomState {
  /** The last line applied; 0 before the first. */
  seq: number;
  /** In join order, the removed ones included. */
  participants: Map<string, ParticipantState>;
  timeline: Entry[];
  /** The questions still open, by id. */
  questions: Map<string, Question>;
  /** What `applyStatus` read for a participant the replay has not added
   *  yet: GET can answer first. */
  reported: Map<string, Report>;
  /** Each tool call, by participant and `toolCallId`: two harnesses can
   *  use the same id. */
  tools: Map<string, ToolSlot>;
}

export const newRoomState = (): RoomState => ({
  seq: 0,
  participants: new Map(),
  timeline: [],
  questions: new Map(),
  reported: new Map(),
  tools: new Map(),
});

/** The `_client_` events `protocol/agent.ts` emits. With every harness
 *  update, they are what the watchdog sees; the room's own lines, such as a
 *  queued message or a rename, never reach it (`core/room.ts`). */
const AGENT_EVENTS = new Set([
  "_client_harness_spawned",
  "_client_harness_exited",
  "_client_permission_pending",
  "_client_permission",
  "_client_wrote_file",
  "_client_cancel_requested",
]);

/** A line the harness's process sent, so the watchdog counted it. */
const fromHarness = (kind: string) =>
  !kind.startsWith("_client_") || AGENT_EVENTS.has(kind);

/**
 * Applies one line. Returns the timeline entry it added or changed, or
 * `undefined` when the timeline did not change: a repeated `seq`, a roster
 * line, or an event no screen draws.
 */
// One switch over the event kinds is the reducer's shape.
// pi-lens-ignore: high-complexity, high-fan-out
export function applyLine(
  state: RoomState,
  { seq, at: time, participantId, update: u }: RoomEventLine,
): Entry | undefined {
  if (seq <= state.seq) return undefined;
  state.seq = seq;
  const p = state.participants.get(participantId);
  // Its harness's traffic ends an idle spell, as in `core/watchdog.ts`. A
  // busy loop is traffic too, so a repeat warning waits for a new title.
  if (p?.stall?.kind === "idle" && fromHarness(u.sessionUpdate)) {
    p.stall = undefined;
    p.stallResolvedAt = seq;
  }
  const add = (entry: Entry) => {
    state.timeline.push(entry);
    if (p) {
      p.answer = undefined;
      if (!fromPerson(entry)) p.unread += 1;
    }
    return entry;
  };
  const at = { seq, participantId, at: time };
  const openTurn = () => {
    const last = p?.turns.at(-1);
    return last?.state === "open" ? last : undefined;
  };
  /** The open turn, or the one `applyStatus` cut before its end arrived. */
  const liveTurn = () => {
    const last = p?.turns.at(-1);
    return last?.state === "open" || last?.tentative ? last : undefined;
  };

  switch (u.sessionUpdate) {
    case "_client_participant_added": {
      const reported = state.reported.get(participantId);
      state.reported.delete(participantId);
      state.participants.set(participantId, {
        id: participantId,
        name: u.name,
        ...(u.role && { role: u.role }),
        harness: u.harness,
        mode: u.mode,
        status: reported?.status ?? "idle",
        ...(reported && { reported }),
        removed: false,
        turns: [],
        queue: [],
        unread: 0,
      });
      return undefined;
    }
    case "_client_participant_changed":
      if (!p) return undefined;
      if (u.name !== undefined) p.name = u.name;
      if (u.mode !== undefined) p.mode = u.mode;
      // A role is absent from the roster, not present as undefined.
      // pi-lens-ignore: ts-delete-property
      if (u.role === null) delete p.role;
      else if (u.role !== undefined) p.role = u.role;
      return undefined;
    case "_client_participant_removed":
      if (p) p.removed = true;
      return undefined;
    case "_client_participant_fast_forwarded":
      return add({
        ...at,
        type: "forward",
        from: u.from,
        branch: u.branch,
        sha: u.sha,
      });
    case "_client_user_message": {
      const text = cleanLines(u.text);
      const cut = liveTurn();
      if (cut) {
        cut.state = "cut";
        cut.tentative = undefined;
      }
      if (p) {
        // A turn that starts while messages wait is the oldest of them.
        p.queue.shift();
        p.status = p.reported?.status ?? "busy";
        p.stall = undefined;
        // A cut turn ends here.
        p.thinking = undefined;
        p.tool = undefined;
        p.callTitle = undefined;
        p.turns.push({
          ...(u.turn !== undefined && { number: u.turn }),
          text,
          start: time,
          // A participant the daemon says is stopped: cut, unless its end or
          // its revive follows.
          ...(p.reported
            ? { state: "cut" as const, tentative: true as const }
            : { state: "open" as const }),
        });
      }
      return add({
        ...at,
        type: "user",
        text,
        ...(u.turn !== undefined && { turn: u.turn }),
        ...(u.from !== undefined && { from: u.from }),
      });
    }
    case "_client_message_queued": {
      const text = cleanLines(u.text);
      p?.queue.push(text);
      return add({
        ...at,
        type: "queued",
        text,
        ...(u.from !== undefined && { from: u.from }),
      });
    }
    case "_client_queue_cleared":
      if (p) p.queue = [];
      return add({ ...at, type: "queue_cleared", count: u.count });
    case "agent_message_chunk": {
      if (p) p.thinking = undefined;
      if (u.content?.type !== "text") return undefined;
      // Per chunk: a sequence split over two chunks loses its `ESC` here.
      const text = cleanLines(u.content.text);
      if (p?.answer) {
        p.answer.text += text;
        return p.answer;
      }
      const answer = add({ ...at, type: "answer", text });
      if (p) p.answer = answer as Answer;
      return answer;
    }
    case "agent_thought_chunk":
      if (p && p.thinking === undefined) p.thinking = seq;
      return undefined;
    case "usage_update":
      if (p) {
        p.usage = {
          used: u.used,
          size: u.size,
          ...(u.cost && {
            cost: {
              amount: Number(u.cost.amount),
              currency: printable(String(u.cost.currency)),
            },
          }),
        };
      }
      return undefined;
    case "tool_call": {
      const status = statusOf(u.status);
      const slot: ToolSlot = {
        entry: add({
          ...at,
          type: "tool",
          title: "",
          ...(status && { status }),
        }) as Tool,
        title: str(u.title) ?? "",
        input: detailInput(u.rawInput),
      };
      const location = str(u.locations?.[0]?.path);
      if (location) slot.location = location;
      showTool(slot);
      toolFacts(slot.entry, u);
      state.tools.set(`${participantId} ${u.toolCallId}`, slot);
      if (p) {
        p.thinking = undefined;
        p.tool = slot.entry;
        p.callTitle = slot.title;
        if (
          p.stall?.kind === "repeat" &&
          p.stall.title !== undefined &&
          p.stall.title !== slot.title
        ) {
          p.stall = undefined;
        }
      }
      return slot.entry;
    }
    case "tool_call_update": {
      // In place: not a new line, so the answer streaming goes on and
      // nothing more is unread.
      const slot = state.tools.get(`${participantId} ${u.toolCallId}`);
      if (!slot) return undefined;
      const { entry } = slot;
      const drawn = () =>
        [
          entry.title,
          entry.detail,
          entry.status,
          entry.kind,
          entry.added,
          entry.removed,
        ].join("\0");
      const was = drawn();
      const title = str(u.title);
      if (title !== undefined) slot.title = title;
      // Merged, not replaced: claude's first `rawInput` is `{}` and its
      // update has the input, and an update sends only what changed. A key
      // an update leaves out stays; no measured harness drops one.
      Object.assign(slot.input, detailInput(u.rawInput));
      const location = str(u.locations?.[0]?.path);
      if (location) slot.location = location;
      const status = statusOf(u.status);
      if (status) entry.status = status;
      showTool(slot);
      toolFacts(entry, u);
      // Output alone (`_meta.terminal_output`) changes nothing drawn.
      return drawn() === was ? undefined : entry;
    }
    case "_client_turn_ended": {
      // Both come from the harness: its reply, or its error's message.
      const stopReason =
        u.stopReason === undefined
          ? undefined
          : printable(String(u.stopReason));
      const error =
        u.error === undefined ? undefined : printable(String(u.error));
      const turn = liveTurn();
      if (turn) {
        turn.state = "ended";
        turn.tentative = undefined;
        if (stopReason !== undefined) turn.stopReason = stopReason;
        if (error !== undefined) turn.error = error;
      }
      if (p) {
        // The harness reports its exit before the turn it broke ends.
        if (!p.reported && p.status !== "exited" && p.status !== "killed") {
          p.status = "idle";
        }
        p.stall = undefined;
        p.thinking = undefined;
        p.tool = undefined;
        p.callTitle = undefined;
      }
      return add({
        ...at,
        type: "turn_ended",
        ...(stopReason !== undefined && { stopReason }),
        ...(error !== undefined && { error }),
      });
    }
    case "_client_harness_exited":
      // During a turn, its files and its memory may not match (R46).
      if (p && !p.reported) p.status = openTurn() ? "killed" : "exited";
      return add({ ...at, type: "exited" });
    case "_client_participant_revived": {
      if (p) p.revivedAt = seq;
      // A revive the reply already counted came before the stop it reports.
      if (p && !(p.reported && seq <= p.reported.seq)) {
        p.reported = undefined;
        // It follows the message that revived it, whose turn is live.
        const turn = liveTurn();
        if (turn) {
          turn.state = "open";
          turn.tentative = undefined;
        }
        p.status = turn ? "busy" : "idle";
      }
      return add({
        ...at,
        type: "revived",
        resumed: printable(String(u.resumed)),
        // Only with `loaded`, as the contract has it.
        ...(u.resumed === "loaded" &&
          u.memoryMayBeBehind === true && { behind: true as const }),
      });
    }
    case "_client_stall_warning": {
      // A repeat warning quotes the harness's tool title.
      const text = printable(u.text);
      if (p) {
        p.stall = { kind: u.kind, text, seq, seen: false };
        if (u.kind === "repeat" && p.callTitle !== undefined) {
          p.stall.title = p.callTitle;
        }
      }
      return add({ ...at, type: "stall", kind: u.kind, text });
    }
    case "_client_permission_queued": {
      const number = openTurn()?.number;
      const question = add({
        ...at,
        type: "permission",
        id: u.id,
        title: printable(u.title),
        kind: kindOf(u.kind) ?? "other",
        ...(number !== undefined && { turn: number }),
        ...(u.input && {
          input: Object.fromEntries(
            Object.entries(u.input).map(([k, v]) => [
              printable(k),
              printable(String(v)),
            ]),
          ),
        }),
        ...(u.diff && { diff: { ...u.diff, text: cleanLines(u.diff.text) } }),
      }) as Question;
      state.questions.set(u.id, question);
      return question;
    }
    case "_client_permission_answered": {
      const question = state.questions.get(u.id);
      if (!question) return undefined;
      state.questions.delete(u.id);
      question.allow = u.allow;
      question.reason = u.reason;
      return question;
    }
    default:
      // Harness setup, file writes and the rest: nothing a screen draws.
      // A `_client_*` name this client does not know is dropped too.
      return undefined;
  }
}

/**
 * Takes what `GET /rooms/:id` says of each participant that the stream
 * cannot: `paused` or `killed` after a restart. A live turn is cut, until
 * the log shows its end. Call it whenever the room is read; a status the
 * stream already shows is left to the stream. Returns whether it changed
 * what a screen draws, so a header-only reader can skip a transcript
 * rebuild when the reply carried no such status.
 */
export function applyStatus(state: RoomState, room: RoomDto): boolean {
  let changed = false;
  for (const { id, status } of room.participants) {
    if (status !== "paused" && status !== "killed") continue;
    const report = { status, seq: room.seq };
    const p = state.participants.get(id);
    if (!p) {
      // The replay has not added it yet; its added line takes this.
      state.reported.set(id, report);
      continue;
    }
    // A reply made before the last revive: the stream is newer.
    if (p.revivedAt !== undefined && p.revivedAt > room.seq) continue;
    // Only what a screen draws counts: a participant already paused stays
    // paused, and its every turn end must not rebuild the transcript.
    const last = p.turns.at(-1);
    const moved =
      p.status !== status || p.stall?.seen === false || last?.state === "open";
    p.reported = report;
    p.status = status;
    p.stall = undefined;
    if (last?.state === "open") {
      last.state = "cut";
      last.tentative = true;
    }
    if (moved) changed = true;
  }
  return changed;
}

/** One participant's thread: the timeline filtered by id (R8c). It walks
 *  the whole timeline, so call it when a screen opens a thread, not per
 *  line: a streamed line redraws the one entry `applyLine` returns. */
export const thread = (state: RoomState, id: string) =>
  state.timeline.filter((e) => e.participantId === id);

/** The participants still on the roster, in join order. */
export const roster = (state: RoomState) =>
  [...state.participants.values()].filter((p) => !p.removed);

/** The roster's name for an id, or the id for one it never named. */
export const nameOf = (state: RoomState, id: string) =>
  state.participants.get(id)?.name ?? id;

/** The person wrote this entry: a message with no `from` (M8-1). A message
 *  the orchestrator sent counts as unread, since nobody watched it go. */
export const fromPerson = (e: Entry) =>
  (e.type === "user" || e.type === "queued") && e.from === undefined;

/** Who sent a message: `you`, or the participant that did (M8-1). */
export const senderOf = (state: RoomState, from: string | undefined) =>
  from === undefined ? "you" : nameOf(state, from);

/** The person looked at this participant's thread. An open question still
 *  needs attention after this; only its answer clears it. */
export function seen(state: RoomState, id: string) {
  const p = state.participants.get(id);
  if (!p) return;
  p.unread = 0;
  if (p.stall) p.stall.seen = true;
}

/** This participant's oldest open question, if one waits. */
export const questionOf = (state: RoomState, id: string) =>
  [...state.questions.values()].find((q) => q.participantId === id);

/** Whether this participant needs the person: a question waits, or a live
 *  stall warning the person has not seen. */
export const needsAttention = (state: RoomState, id: string) =>
  state.participants.get(id)?.stall?.seen === false ||
  questionOf(state, id) !== undefined;
