/**
 * The client contract, as types — stories M5-1 (#133) and M5-2 (#134).
 *
 * `docs/CLIENT-API.md` is the promise; this file is the same reply and
 * stream-event shapes for a TypeScript client. A client imports this file
 * and never `daemon.ts` or `core/`; the `run` member of the `POST /runs`
 * request body is the run file, described by `schema/run.schema.json`. The
 * ACP event types that ride inside the stream are re-exported below, so a
 * client never has to know `protocol/` exists.
 *
 * `daemon.ts` declares its runs and rooms with these types and checks every
 * other reply with `satisfies`, so a removed or renamed field fails
 * `npm run check`, and so does a field added where the daemon builds the
 * reply itself. Three parts come from `core/`, which may not import this
 * file, and are checked for assignability only — an added field there is not
 * caught: a finished run's `report` (`core/run.ts`), `GET /permissions` and
 * `GET /permissions/:id` (`core/permissions.ts`). Which shapes are stable and
 * which will change is the stability table in the doc, not this file.
 *
 * Types only, plus two constants (decided 2026-09-22, B7): a JSON Schema can
 * be added for a client in another language once one exists.
 */

import type {
  AgentEvent,
  PermissionReason,
  ToolKind,
  Usage,
} from "../protocol/types.ts";

/** The event types a stream carries, the tool kinds a permission names, and
 *  why a permission closed. Re-exported, not copied, so there is one
 *  definition. @public */
export type { AgentEvent, PermissionReason, ToolKind };

/**
 * The contract version (B2, amended 2026-09-22). `major` goes up for a change
 * that breaks a client; `minor` goes up when something is added. A client
 * refuses a daemon with a different `major` and warns on a different `minor`
 * (B5).
 *
 * Only a **stable** part is versioned. A provisional part changes with its
 * named story and without a version step — that is what the label is for
 * (M5-2 changed one). Which rows are stable is the table in
 * `docs/CLIENT-API.md`.
 */
export const API_VERSION = { major: 1, minor: 4 } as const;

/**
 * What this daemon can do (B4). Names are only ever added, never removed or
 * renamed, so a client checks for the one it needs.
 */
export const CAPABILITIES = [
  "repos",
  "runs",
  "events",
  "permissions",
  "rooms",
] as const;

/** `GET /version`. `capabilities` is `string[]`, not the list above: a
 *  newer daemon sends names this file does not know yet. */
export interface VersionReply {
  apiVersion: { major: number; minor: number };
  capabilities: string[];
}

/**
 * What went wrong, one code per situation a client acts on differently (C7,
 * M5-3) — not one per status: `room_busy` means send again later, while
 * `already_decided` and `run_ended` mean stop. Codes are only ever added,
 * except a room's while `/rooms` is Experimental: M6-2 split `room_closed`
 * into `room_dismissed` and `agent_exited`.
 */
export type ErrorCode =
  | "host_not_allowed"
  | "unauthorized"
  | "no_route"
  | "unsupported_media_type"
  | "body_too_large"
  | "invalid_request"
  | "invalid_run"
  | "invalid_config"
  | "repo_not_added"
  | "run_not_found"
  | "room_not_found"
  | "permission_not_found"
  | "no_event_log"
  | "run_ended"
  | "already_decided"
  | "room_busy"
  | "room_dismissed"
  | "agent_exited"
  | "no_orchestrator"
  | "orchestrator_exists"
  | "name_taken"
  | "participant_not_found"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "shutting_down"
  | "room_open_failed"
  | "internal";

/** Every refusal, on every route. `code` is `string`, not `ErrorCode`: a
 *  newer daemon sends codes this file does not know yet, and a client falls
 *  back to the status for those. `message` is for a person, never parsed. */
export interface ErrorReply {
  error: { code: string; message: string };
}

/** `POST /repos` answers the repository root the path belongs to. */
export interface RepoAdded {
  root: string;
}

/** `GET /repos` answers every added repository root. */
export type RepoRoots = string[];

/** A finished task's verdict, mildest first. A run's status is the worst of
 *  its tasks. @public */
export type TaskStatus =
  | "done"
  | "warned"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "failed";

/** `killed` is written only by the daemon's boot sweep, for a run — and each
 *  task it had running — that was live when the daemon died (M5-5). It is
 *  never a verdict a run reaches on its own. @public */
export type RunStatus = "running" | TaskStatus | "killed";

/** `POST /runs` answers only the new run's id. */
export interface RunAccepted {
  id: string;
}

/** One task in a run, live or restored (M5-2). A field a restored record
 *  cannot fill is omitted, never `null`. `status` is a `TaskStatus`, or
 *  `queued` or `running` while the run is live, or `killed` after a crash; typed as `string` because a
 *  run read back from disk passes its record's word through unchecked: a
 *  client shows a word it does not know rather than failing on it. @public */
export interface TaskDto {
  id: string;
  status: string;
  /** The harness that ran the task. */
  agent?: string;
  /** Wall time the task took. */
  durationMs?: number;
  error?: string;
  usage?: Usage;
  usageSemantics?: "per-turn" | "cumulative" | "unknown";
  warnings?: { kind: string; text: string }[];
  summary?: string;
  summarySynthesised?: true;
  /** The task's worktree branch and the SHA it branched from, when it had one. */
  branch?: string;
  baseSha?: string;
  /** The harness session this task ran in (M2-6); a client can keep it for a
   *  future `session/load`. */
  sessionId?: string;
}

/** One entry of `GET /runs`. The shared fields are the same vocabulary as
 *  `RunDto`; filters, order and pages arrive in M5-9. */
export interface RunListEntry {
  id: string;
  cwd: string;
  root: string;
  /** A run status word; see `RunDto.status`. */
  status: string;
  source: "live" | "restored";
  startedAt?: string;
  endedAt?: string;
  tasks: { id: string; status: string }[];
}

/**
 * `GET /runs/:id`, and the `202` of `DELETE /runs/:id`. One shape for a live
 * run and one restored after a restart (M5-2): a field the record cannot
 * fill is omitted, never `null`, and `source` says where it came from.
 */
export interface RunDto {
  id: string;
  cwd: string;
  root: string;
  /** A `RunStatus`, or the word a hand-edited record carries: as with a
   *  task, a client shows a word it does not know rather than failing on it. */
  status: string;
  source: "live" | "restored";
  /** ISO 8601. On a restored run these come from the record. */
  startedAt?: string;
  endedAt?: string;
  /** The run's own elapsed time and turn count: live-only, not persisted. */
  durationMs?: number;
  turns?: number;
  /** The run itself failed to start, so no task record exists. */
  error?: string;
  cancelRequested?: true;
  notices: (Notice & { taskId: string })[];
  tasks: TaskDto[];
}

/** A line a run or a room kept for the operator. @public */
export interface Notice {
  text: string;
  kind?: "containment" | "unverified" | "version" | "advisory";
}

/** One entry of `GET /permissions`. */
export interface PendingDecision {
  id: string;
  runId: string;
  taskId: string;
  kind: ToolKind;
  title: string;
}

/** `GET /permissions/:id` (M5-4, #136): an open decision as the list shows
 *  it, or a closed one with its answer and why it closed. `allow` and
 *  `reason` come together or not at all; the `never` members make a reply
 *  with only one of them fail `satisfies`, which a plain
 *  `PendingDecision | (PendingDecision & {…})` would accept, the second
 *  member being a subtype of the first. */
export type PermissionDecision =
  | (PendingDecision & { allow?: never; reason?: never })
  | (PendingDecision & { allow: boolean; reason: PermissionReason });

/** `POST /permissions/:id` answers what was decided. */
export interface PermissionAnswered {
  id: string;
  allow: boolean;
}

/** A room's status (M6-2). `paused` is set only once M6-7a lands. A room
 *  whose participant has exited still reads `active`. @public */
export type RoomStatus = "active" | "paused" | "dismissed";

/** A participant's status (M6-2). `paused` and `killed` are set only once
 *  M6-7a lands. @public */
export type ParticipantStatus =
  | "idle"
  | "busy"
  | "exited"
  | "paused"
  | "killed"
  | "dismissed";

/** A label only (R44): it picks the default target and sends no text to the
 *  harness. More roles may be added; a client shows one it does not know as
 *  plain text. @public */
export type ParticipantRole =
  | "orchestrator"
  | "developer"
  | "tester"
  | "architect";

/** A participant's settings (R15, amended 2026-09-28): the run-file `Task`
 *  fields that act in a room today. Experimental. @public */
export interface ParticipantSettings {
  allowReadOutsideRoot: boolean;
}

/** One participant in full, from `GET /rooms/:id` and the
 *  `/rooms/:id/agents` routes. Experimental. */
export interface ParticipantDto {
  /** Opaque; a rename never moves it. */
  id: string;
  name: string;
  role?: ParticipantRole;
  /** The harness that runs it. */
  harness: string;
  mode: "auto";
  settings: ParticipantSettings;
  /** Where the harness runs: its own checkout, or the cwd itself when
   *  the cwd cannot carry worktrees. */
  worktree: string;
  /** The checkout's branch and the SHA it forked from, when it has one. */
  branch?: string;
  baseSha?: string;
  /** The harness session, kept for a future `session/load`. */
  sessionId: string;
  status: ParticipantStatus;
  notices: Notice[];
}

/** A room, from `POST /rooms`, `GET /rooms/:id` and
 *  `POST /rooms/:id/dismiss`. Experimental. */
export interface RoomDto {
  id: string;
  cwd: string;
  title?: string;
  /** ISO 8601. `updatedAt` moves on a message and on dismiss. */
  createdAt: string;
  updatedAt: string;
  status: RoomStatus;
  participants: ParticipantDto[];
}

/** One entry of `GET /rooms`: the roster inline and short, so a list of
 *  rooms is one call (R9). Experimental. */
export interface RoomListEntry {
  id: string;
  cwd: string;
  title?: string;
  status: RoomStatus;
  updatedAt: string;
  participants: {
    id: string;
    name: string;
    role?: ParticipantRole;
    status: ParticipantStatus;
  }[];
}

/** `POST /rooms/:id/messages`: the log's size before the message. The turn
 *  is over at the first `_client_turn_ended` with a `seq` above this one. */
export interface MessageAccepted {
  seq: number;
}

/**
 * The JSON in one SSE `data:` line. `agent` is the task id for a run, and the
 * harness name for a room. `update` is the raw ACP `session/update` value or
 * one of this client's `_client_*` events.
 *
 * @public — read by clients, never built by the daemon, which writes the
 * line as text.
 */
export interface EventLine {
  seq: number;
  /** ISO 8601, when the line was written (M5-5). Absent on older lines. */
  at?: string;
  /** `""` for the run's own `_client_run_finished`, which is no task's. */
  agent: string;
  update: AgentEvent;
}
