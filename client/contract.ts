/**
 * The client contract, as types — story M5-1, issue #133.
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
 * reply itself. Two parts come from `core/`, which may not import this file,
 * and are checked for assignability only — an added field there is not
 * caught: a finished run's `report` (`core/run.ts`) and `GET /permissions`
 * (`core/permissions.ts`). Which shapes are stable and which will change is
 * the stability table in the doc, not this file.
 *
 * Types only, plus two constants (decided 2026-09-22, B7): a JSON Schema can
 * be added for a client in another language once one exists.
 */

import type { AgentEvent, ToolKind, Usage } from "../protocol/types.ts";

/** The event types a stream carries, and the tool kinds a permission names.
 *  Re-exported, not copied, so there is one definition. @public */
export type { AgentEvent, ToolKind };

/**
 * The contract version (B2, amended 2026-09-22). `major` goes up for a change
 * that breaks a client; `minor` goes up when something is added. A client
 * refuses a daemon with a different `major` and warns on a different `minor`
 * (B5).
 */
export const API_VERSION = { major: 1, minor: 0 } as const;

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

/** Every refusal, on every route. */
export interface ErrorReply {
  error: string;
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

/** @public */
export type RunStatus = "running" | TaskStatus;

/** `POST /runs` answers only the new run's id. */
export interface RunAccepted {
  id: string;
}

/** One task as a run lists it. `status` is a `TaskStatus`, or `queued` or
 *  `running` while the run is live. Typed as `string` because a run read back
 *  from disk passes its record's word through unchecked: a client shows a
 *  word it does not know rather than failing on it. @public */
export interface TaskEntry {
  id: string;
  status: string;
  branch?: string;
  baseSha?: string;
  sessionId?: string;
}

/** One entry of `GET /runs`. */
export interface RunListEntry {
  id: string;
  cwd: string;
  status: RunStatus;
  tasks: { id: string; status: string }[];
}

/** A line a run or a room kept for the operator. @public */
export interface Notice {
  text: string;
  kind?: "containment" | "unverified" | "version" | "advisory";
}

/** One finished task in a live run's `report`. Provisional: M5-2 replaces
 *  it with a curated shape. @public */
export interface TaskReport {
  id: string;
  agent: string;
  cwd: string;
  branch?: string;
  baseSha?: string;
  sessionId?: string;
  status: TaskStatus;
  stopReason?: string;
  usage?: Usage;
  usageSemantics?: "per-turn" | "cumulative" | "unknown";
  durationMs: number;
  transcript: string;
  error?: string;
  result?: {
    status: string;
    summary: string;
    details: string;
    files?: string[];
    branch?: string;
  };
  warnings?: { kind: string; text: string }[];
  summary?: string;
  summarySynthesised?: true;
}

/**
 * `GET /runs/:id`, and the `202` of `DELETE /runs/:id`. Provisional: a live
 * run and a run restored after a restart do not carry the same fields yet
 * (M5-2).
 */
export interface RunDetail {
  id: string;
  cwd: string;
  status: RunStatus;
  /** A live run, once it has finished. */
  report?: {
    status: TaskStatus;
    durationMs: number;
    turns: number;
    tasks: TaskReport[];
  };
  /** The run itself failed to start, so no task record exists. */
  error?: string;
  cancelRequested?: true;
  notices: (Notice & { taskId: string })[];
  /** Read back from disk after a daemon restart. */
  restored?: true;
  tasks?: TaskEntry[];
}

/** One entry of `GET /permissions`. */
export interface PendingDecision {
  id: string;
  runId: string;
  taskId: string;
  kind: ToolKind;
  title: string;
}

/** `POST /permissions/:id` answers what was decided. */
export interface PermissionAnswered {
  id: string;
  allow: boolean;
}

/** A room, from `POST /rooms`, `GET /rooms`, `GET /rooms/:id` and
 *  `DELETE /rooms/:id`. Experimental until M6-2. */
export interface RoomView {
  id: string;
  cwd: string;
  harness: string;
  workspace: string;
  notices: Notice[];
  status: "idle" | "busy" | "exited" | "closed";
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
  agent: string;
  update: AgentEvent;
}
