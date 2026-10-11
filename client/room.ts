/**
 * The room reducer (M6-10): room lines in, screen state out.
 *
 * **No I/O.** It reads the `{seq, roomId, participantId, update}` lines a
 * client already has and keeps what a screen draws: the roster and each
 * participant's status, the room timeline, each turn, the queue, the open
 * permission questions, unread and attention marks, and what an activity
 * row and the footer show (M7-1): thinking, the last tool, the last usage.
 * It keeps no thinking text. A TUI and a bridge
 * share it, so neither parses events itself.
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
 *  its answer in place. */
export type Entry = {
  seq: number;
  participantId: string;
  /** When the line was written (M7-1): the heading shows it. */
  at: string;
} & (
  | { type: "user"; text: string; turn?: number }
  | { type: "queued"; text: string }
  | { type: "queue_cleared"; count: number }
  | { type: "answer"; text: string }
  /** One tool call. Its `tool_call_update`s change it in place (#240).
   *  `detail`: what the title does not say, such as the command or path. */
  | {
      type: "tool";
      title: string;
      detail?: string;
      status?: ToolCallStatus;
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
/** The most a tool row's title or detail keeps, in characters. */
const TOOL_TEXT = 200;
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

const str = (v: unknown) =>
  typeof v === "string" ? v.slice(0, SLOT_TEXT) : undefined;

const STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
/** The status if it is one ACP defines; the log is the harness's JSON. */
const statusOf = (v: unknown) =>
  STATUSES.has(v as string) ? (v as ToolCallStatus) : undefined;

const toolText = (s: string) => {
  const t = printable(s);
  return t.length > TOOL_TEXT ? `${t.slice(0, TOOL_TEXT - 1)}…` : t;
};

/** The keys of `raw` a detail can use. `raw` is the harness's JSON. */
function detailInput(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null) return {};
  const input: Record<string, string> = {};
  for (const k of [...DETAIL_KEYS, "description"]) {
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
  /** The last stall warning's text. Unlike `stalled`, `seen` keeps it: the
   *  bell (M4-4) rings for a person who looks somewhere else. */
  stall?: string;
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
  /** A stall warning in the live turn, until it ends or is `seen`. */
  stalled: boolean;
  /** The `seq` of the thought chunk that set the flag (M7-1). Only the
   *  flag: the text is large (pi), and never drawn. An answer chunk, a tool
   *  call or the turn's end clears it, and nothing else: a `usage_update`
   *  would make the row flicker. The `seq` says which chunk changed it, so a
   *  screen draws a frame for that one only. */
  thinking?: number;
  /** The live turn's last tool call (M7-1). The entry, not its title:
   *  its updates set the title in place (#240). */
  tool?: Tool;
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

/**
 * Applies one line. Returns the timeline entry it added or changed, or
 * `undefined` when the timeline did not change: a repeated `seq`, a roster
 * line, or an event no screen draws.
 */
export function applyLine(
  state: RoomState,
  { seq, at: time, participantId, update: u }: RoomEventLine,
): Entry | undefined {
  if (seq <= state.seq) return undefined;
  state.seq = seq;
  const p = state.participants.get(participantId);
  const add = (entry: Entry) => {
    state.timeline.push(entry);
    if (p) {
      p.answer = undefined;
      if (entry.type !== "user" && entry.type !== "queued") p.unread += 1;
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
        stalled: false,
      });
      return undefined;
    }
    case "_client_participant_changed":
      if (!p) return undefined;
      if (u.name !== undefined) p.name = u.name;
      if (u.mode !== undefined) p.mode = u.mode;
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
        p.stalled = false;
        // A cut turn ends here.
        p.thinking = undefined;
        p.tool = undefined;
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
      });
    }
    case "_client_message_queued": {
      const text = cleanLines(u.text);
      p?.queue.push(text);
      return add({ ...at, type: "queued", text });
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
      state.tools.set(`${participantId} ${u.toolCallId}`, slot);
      if (p) {
        p.thinking = undefined;
        p.tool = slot.entry;
      }
      return slot.entry;
    }
    case "tool_call_update": {
      // In place: not a new line, so the answer streaming goes on and
      // nothing more is unread.
      const slot = state.tools.get(`${participantId} ${u.toolCallId}`);
      if (!slot) return undefined;
      const { entry } = slot;
      const was = [entry.title, entry.detail, entry.status].join("\0");
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
      // Output alone (`_meta.terminal_output`) changes nothing drawn.
      return [entry.title, entry.detail, entry.status].join("\0") === was
        ? undefined
        : entry;
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
        p.stalled = false;
        p.thinking = undefined;
        p.tool = undefined;
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
      if (p) p.stalled = true;
      // A repeat warning quotes the harness's tool title.
      const text = printable(u.text);
      const turn = openTurn();
      if (turn) turn.stall = text;
      return add({ ...at, type: "stall", kind: u.kind, text });
    }
    case "_client_permission_queued": {
      const number = openTurn()?.number;
      const question = add({
        ...at,
        type: "permission",
        id: u.id,
        title: printable(u.title),
        kind: u.kind,
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
 * stream already shows is left to the stream.
 */
export function applyStatus(state: RoomState, room: RoomDto) {
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
    p.reported = report;
    p.status = status;
    p.stalled = false;
    const last = p.turns.at(-1);
    if (last?.state === "open") {
      last.state = "cut";
      last.tentative = true;
    }
  }
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

/** The person looked at this participant's thread. An open question still
 *  needs attention after this; only its answer clears it. */
export function seen(state: RoomState, id: string) {
  const p = state.participants.get(id);
  if (!p) return;
  p.unread = 0;
  p.stalled = false;
}

/** This participant's oldest open question, if one waits. */
export const questionOf = (state: RoomState, id: string) =>
  [...state.questions.values()].find((q) => q.participantId === id);

/** Whether this participant needs the person: a question waits, or its
 *  live turn looks stuck. */
export const needsAttention = (state: RoomState, id: string) =>
  Boolean(state.participants.get(id)?.stalled) ||
  questionOf(state, id) !== undefined;
