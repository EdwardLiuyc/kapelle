/**
 * The daemon's wire shapes — stories M2-6 and M5-2, split out of `daemon.ts`.
 *
 * Pure functions from what the daemon holds (a live `TaskRun`, a restored
 * `run.json`, a `RunState`) to what `client/contract.ts` promises. Kept apart
 * from `daemon.ts` because that file starts a daemon when imported, and these
 * need tests of their own. Not in `core/`: `core/` never imports `client/`.
 */

import type {
  Notice,
  ParticipantDto,
  RoomDto,
  RoomListEntry,
  RunDto,
  RunListEntry,
  RunStatus,
  TaskDto,
} from "../client/contract.ts";
import type { Participant, Room, RoomMeta, RoomRecord } from "../core/room.ts";
import type { RunReport, TaskRun } from "../core/run.ts";

const USAGE_SEMANTICS = new Set(["per-turn", "cumulative", "unknown"]);

/** The string fields `toTaskDto` copies, pinned to both sides of the edge:
 *  `TaskDto` in `client/contract.ts` and the live `TaskRun` in `core/run.ts`.
 *  A rename on either side fails `npm run check` instead of silently leaving
 *  the field off the wire. */
const STRING_KEYS = [
  "agent",
  "error",
  "summary",
  "branch",
  "baseSha",
  "sessionId",
] as const satisfies readonly (keyof TaskDto & keyof TaskRun)[];

/** The non-string fields, pinned the same way. The `Record`'s key set is
 *  the complement of `STRING_KEYS` plus `id`/`status`, so a field added to
 *  `TaskDto` fails `npm run check` until `toTaskDto` handles it. */
const TYPED_KEYS = {
  durationMs: "durationMs",
  usage: "usage",
  usageSemantics: "usageSemantics",
  warnings: "warnings",
  summarySynthesised: "summarySynthesised",
} as const satisfies Record<
  Exclude<keyof TaskDto, (typeof STRING_KEYS)[number] | "id" | "status">,
  keyof TaskDto & keyof TaskRun
>;

/** A `Usage` from a value of unknown provenance, rebuilt key by key so a
 *  hand-edited record cannot put a wrong-typed or unknown nested value on the
 *  wire. `_meta` is the one exception: C11 passes it through. `undefined`
 *  when the required numbers are not all finite. */
function usageOf(value: unknown): TaskDto["usage"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    !Number.isFinite(raw.inputTokens) ||
    !Number.isFinite(raw.outputTokens) ||
    !Number.isFinite(raw.totalTokens)
  ) {
    return undefined;
  }
  const usage: NonNullable<TaskDto["usage"]> = {
    inputTokens: raw.inputTokens as number,
    outputTokens: raw.outputTokens as number,
    totalTokens: raw.totalTokens as number,
  };
  for (const key of [
    "thoughtTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
  ] as const satisfies readonly (keyof NonNullable<TaskDto["usage"]>)[]) {
    const n = raw[key];
    if (Number.isFinite(n)) usage[key] = n as number;
  }
  if (
    typeof raw._meta === "object" &&
    raw._meta !== null &&
    !Array.isArray(raw._meta)
  ) {
    usage._meta = raw._meta as Record<string, unknown>;
  }
  return usage;
}

/** The contract's warnings, keeping only `{kind, text}` entries. `undefined`
 *  when nothing is left, so a junk array is omitted rather than served as
 *  `[]` — the same rule as every other gap (C2). */
function warningsOf(value: unknown): TaskDto["warnings"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const warnings = value.flatMap((w) =>
    typeof w?.kind === "string" && typeof w?.text === "string"
      ? [{ kind: w.kind, text: w.text }]
      : [],
  );
  return warnings.length > 0 ? warnings : undefined;
}

/** One task, live or restored, as the contract carries it (M2-6, M5-2). `id`
 *  and `status` are trusted — for a record, by the guard in `restoreRuns`.
 *  Every other field is copied only when the contract names it and its value
 *  has the contract's type: a `run.json` anyone can edit must not put an
 *  unknown key, or a known key with a wrong value, on the wire, and
 *  `"warnings": 5` crashed `attach`'s `printTask`. A field the source does
 *  not have, or has with the wrong type, is left out, never `null` (C2). */
export function toTaskDto(task: { id: string; status: string }): TaskDto {
  const t: Record<string, unknown> = { ...task };
  const dto: TaskDto = { id: task.id, status: task.status };
  for (const key of STRING_KEYS) {
    const value = t[key];
    if (typeof value === "string") dto[key] = value;
  }
  const durationMs = t[TYPED_KEYS.durationMs];
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    dto.durationMs = durationMs;
  }
  const usage = usageOf(t[TYPED_KEYS.usage]);
  if (usage !== undefined) dto.usage = usage;
  const usageSemantics = t[TYPED_KEYS.usageSemantics];
  if (
    typeof usageSemantics === "string" &&
    USAGE_SEMANTICS.has(usageSemantics)
  ) {
    dto.usageSemantics = usageSemantics as TaskDto["usageSemantics"];
  }
  const warnings = warningsOf(t[TYPED_KEYS.warnings]);
  if (warnings !== undefined) dto.warnings = warnings;
  if (t[TYPED_KEYS.summarySynthesised] === true) dto.summarySynthesised = true;
  return dto;
}

/** One run as the daemon holds it. The wire reply is `RunDto`, built by
 *  `toRunDto`: a live run's `report` and the record-level fields stay off the
 *  wire. Live runs are built in `daemon.ts`; finished ones are read back from
 *  their `run.json` at boot (M2-6, #36). Notices keep every line, containment
 *  included: #13 says those are never suppressed, and with no terminal this
 *  record is where they survive. */
export interface RunState {
  id: string;
  cwd: string;
  root: string;
  status: RunStatus;
  source: "live" | "restored";
  startedAt?: string;
  endedAt?: string;
  /** A live run's final report (`core/run.ts`). Flattened by `toRunDto`. */
  report?: RunReport;
  error?: string;
  cancelRequested?: true;
  notices: (Notice & { taskId: string })[];
  /** The record-level list: `queued`/`running` entries while live, the
   *  restored record after a boot. */
  tasks: TaskDto[];
}

/** The wire shape of one run: a live run's `report` flattened onto the same
 *  fields a restored record carries. A gap is omitted, never `null`. */
export function toRunDto(state: RunState): RunDto {
  const dto: RunDto = {
    id: state.id,
    cwd: state.cwd,
    root: state.root,
    status: state.status,
    source: state.source,
    notices: state.notices,
    tasks: state.report ? state.report.tasks.map(toTaskDto) : state.tasks,
  };
  if (state.startedAt !== undefined) dto.startedAt = state.startedAt;
  if (state.endedAt !== undefined) dto.endedAt = state.endedAt;
  if (state.report) {
    dto.durationMs = state.report.durationMs;
    dto.turns = state.report.turns;
  }
  if (state.error !== undefined) dto.error = state.error;
  if (state.cancelRequested) dto.cancelRequested = true;
  return dto;
}

/** One `GET /runs` entry: the shared run fields plus id/status per task. */
export function toRunListEntry(state: RunState): RunListEntry {
  const entry: RunListEntry = {
    id: state.id,
    cwd: state.cwd,
    root: state.root,
    status: state.status,
    source: state.source,
    tasks: state.tasks.map(({ id, status }) => ({ id, status })),
  };
  if (state.startedAt !== undefined) entry.startedAt = state.startedAt;
  if (state.endedAt !== undefined) entry.endedAt = state.endedAt;
  return entry;
}

/** What the daemon shows about a room beyond its roster: `Room.meta`, which
 *  the room saves in `room.json` (M6-7a). */
export type RoomState = RoomMeta;

/** One participant in full. Built key by key, so a field `core/room.ts`
 *  adds does not reach the wire until the contract names it. */
export function toParticipantDto(p: Participant): ParticipantDto {
  const dto: ParticipantDto = {
    id: p.id,
    name: p.name,
    harness: p.harness,
    mode: p.mode,
    settings: { allowReadOutsideRoot: p.settings.allowReadOutsideRoot },
    worktree: p.worktree,
    sessionId: p.sessionId,
    status: p.status(),
    notices: [...p.notices],
  };
  if (p.role !== undefined) dto.role = p.role;
  if (p.branch !== undefined) dto.branch = p.branch;
  if (p.baseSha !== undefined) dto.baseSha = p.baseSha;
  if (p.resumed !== undefined) dto.resumed = p.resumed;
  if (p.turnFrom !== undefined) dto.turnFrom = p.turnFrom;
  if (p.model !== undefined) dto.model = p.model;
  if (p.models !== undefined)
    dto.models = p.models.map(({ id, name }) => ({ id, name }));
  return dto;
}

/** `GET /rooms/:id`: the room and every participant in full. */
export function toRoomDto(state: RoomState, room: Room): RoomDto {
  // Key by key, not `...state`: a spread skips the excess-property check, so
  // a field added to `RoomState` would reach the wire unnoticed.
  const dto: RoomDto = {
    id: state.id,
    cwd: state.cwd,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    status: room.status(),
    seq: room.eventLog?.size ?? 0,
    participants: room.participants.map(toParticipantDto),
  };
  if (state.title !== undefined) dto.title = state.title;
  return dto;
}

/** One `GET /rooms` entry: the room and a short roster (R9, R44). */
export function toRoomListEntry(state: RoomState, room: Room): RoomListEntry {
  const entry: RoomListEntry = {
    id: state.id,
    cwd: state.cwd,
    status: room.status(),
    updatedAt: state.updatedAt,
    participants: room.participants.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.role && { role: p.role }),
      status: p.status(),
    })),
  };
  if (state.title !== undefined) entry.title = state.title;
  return entry;
}

/** The same entry for a dismissed room the boot did not build (#451), from
 *  its `room.json`. A built dismissed room reads `dismissed` for every
 *  participant, so the record's own statuses are not used. */
export function toRecordListEntry(record: RoomRecord): RoomListEntry {
  const entry: RoomListEntry = {
    id: record.id,
    cwd: record.cwd,
    status: "dismissed",
    updatedAt: record.updatedAt,
    participants: record.participants.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.role && { role: p.role }),
      status: "dismissed",
    })),
  };
  if (record.title !== undefined) entry.title = record.title;
  return entry;
}
