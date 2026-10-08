/**
 * The room reducer (M6-10): room lines in, screen state out.
 *
 * **No I/O.** It reads the `{seq, roomId, participantId, update}` lines a
 * client already has and keeps what a screen draws: the roster and each
 * participant's status, the room timeline, each turn, the queue, the open
 * permission questions, and unread and attention marks. A TUI and a bridge
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
 * reply. The reply and the replay can arrive in either order, so the status
 * it gives holds until a `_client_participant_revived` line, and a turn it
 * cuts is cut only until the log shows its end. The room's own status
 * (`dismissed`, `paused`) is read the same way (S11).
 */

import type {
  Diff,
  PermissionReason,
  RoomDto,
  RoomEventLine,
  ToolKind,
} from "./contract.ts";

type Mode = "ask" | "safe" | "auto";

/** One thing the timeline shows, in the order it first appeared. An answer
 *  grows in place while its chunks arrive, and a permission question gets
 *  its answer in place. */
export type Entry = { seq: number; participantId: string } & (
  | { type: "user"; text: string; turn?: number }
  | { type: "queued"; text: string }
  | { type: "queue_cleared"; count: number }
  | { type: "answer"; text: string }
  | { type: "tool"; title: string }
  | { type: "turn_ended"; stopReason?: string; error?: string }
  | { type: "exited" }
  /** A stopped participant has a new harness and a fresh session (M6-7a). */
  | { type: "revived" }
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
 * quotes a tool title); an answer is markdown, which draws its own.
 */
export const printable = (s: string) =>
  s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");

/**
 * Diff text with each line drawable (M4-6): a tab is four spaces, and the
 * rest goes through `printable`. The lines stay lines.
 */
export const cleanDiff = (text: string) =>
  text
    .split("\n")
    .map((l) => printable(l.replaceAll("\t", "    ")))
    .join("\n");

type Answer = Extract<Entry, { type: "answer" }>;
type Question = Extract<Entry, { type: "permission" }>;

interface Turn {
  /** From `_client_user_message`; absent on lines written before M6-5. */
  number?: number;
  text: string;
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
  /** What `GET /rooms/:id` said the stream cannot: it holds until a revive. */
  reported?: "paused" | "killed";
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
  reported: Map<string, "paused" | "killed">;
}

export const newRoomState = (): RoomState => ({
  seq: 0,
  participants: new Map(),
  timeline: [],
  questions: new Map(),
  reported: new Map(),
});

/**
 * Applies one line. Returns the timeline entry it added or changed, or
 * `undefined` when the timeline did not change: a repeated `seq`, a roster
 * line, or an event no screen draws.
 */
export function applyLine(
  state: RoomState,
  { seq, participantId, update: u }: RoomEventLine,
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
  const at = { seq, participantId };
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
        status: reported ?? "idle",
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
      const cut = liveTurn();
      if (cut) {
        cut.state = "cut";
        delete cut.tentative;
      }
      if (p) {
        // A turn that starts while messages wait is the oldest of them.
        p.queue.shift();
        p.status = p.reported ?? "busy";
        p.stalled = false;
        p.turns.push({
          ...(u.turn !== undefined && { number: u.turn }),
          text: u.text,
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
        text: u.text,
        ...(u.turn !== undefined && { turn: u.turn }),
      });
    }
    case "_client_message_queued":
      p?.queue.push(u.text);
      return add({ ...at, type: "queued", text: u.text });
    case "_client_queue_cleared":
      if (p) p.queue = [];
      return add({ ...at, type: "queue_cleared", count: u.count });
    case "agent_message_chunk": {
      if (u.content?.type !== "text") return undefined;
      if (p?.answer) {
        p.answer.text += u.content.text;
        return p.answer;
      }
      const answer = add({ ...at, type: "answer", text: u.content.text });
      if (p) p.answer = answer as Answer;
      return answer;
    }
    case "tool_call":
      return add({ ...at, type: "tool", title: u.title });
    case "_client_turn_ended": {
      const turn = liveTurn();
      if (turn) {
        turn.state = "ended";
        delete turn.tentative;
        if (u.stopReason !== undefined) turn.stopReason = u.stopReason;
        if (u.error !== undefined) turn.error = u.error;
      }
      if (p) {
        // The harness reports its exit before the turn it broke ends.
        if (!p.reported && p.status !== "exited" && p.status !== "killed") {
          p.status = "idle";
        }
        p.stalled = false;
      }
      return add({
        ...at,
        type: "turn_ended",
        ...(u.stopReason !== undefined && { stopReason: u.stopReason }),
        ...(u.error !== undefined && { error: u.error }),
      });
    }
    case "_client_harness_exited":
      // During a turn, its files and its memory may not match (R46).
      if (p && !p.reported) p.status = openTurn() ? "killed" : "exited";
      return add({ ...at, type: "exited" });
    case "_client_participant_revived": {
      if (p) {
        delete p.reported;
        // It follows the message that revived it, whose turn is live.
        const turn = liveTurn();
        if (turn) {
          turn.state = "open";
          delete turn.tentative;
        }
        p.status = turn ? "busy" : "idle";
      }
      return add({ ...at, type: "revived" });
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
        ...(u.diff && { diff: { ...u.diff, text: cleanDiff(u.diff.text) } }),
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
    const p = state.participants.get(id);
    if (!p) {
      // The replay has not added it yet; its added line takes this.
      state.reported.set(id, status);
      continue;
    }
    p.reported = status;
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

/** Whether this participant needs the person: a question waits, or its
 *  live turn looks stuck. */
export const needsAttention = (state: RoomState, id: string) =>
  Boolean(state.participants.get(id)?.stalled) ||
  [...state.questions.values()].some((q) => q.participantId === id);
