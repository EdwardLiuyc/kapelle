/**
 * The daemon's wire shapes — stories M2-6, M5-2 and M12-3, split out of
 * `daemon.ts`.
 *
 * Pure functions from what the daemon holds (a live `TaskRun`, a restored
 * `run.json`, a `RunState`, permission decisions and the project config view)
 * to what `client/contract.ts` promises. Kept apart from `daemon.ts` because
 * that file starts a daemon when imported, and these need tests of their own.
 * Not in `core/`: `core/` never imports `client/`.
 */

import type {
  ArchivedChat,
  ChatDto,
  ConfigRow,
  ConfigView,
  Diff,
  Notice,
  ParticipantDto,
  PendingDecision,
  PermissionDecision,
  RoomDto,
  RoomListEntry,
  RunDto,
  RunListEntry,
  RunStatus,
  TaskDto,
} from "../client/contract.ts";
import type { Chat, ChatRecord } from "../core/chat.ts";
import type { projectConfigView } from "../core/config.ts";
import { HALL_ID } from "../core/ids.ts";
import type {
  PendingDecision as CorePendingDecision,
  SettledDecision as CoreSettledDecision,
} from "../core/permissions.ts";
import type {
  Participant,
  Room,
  RoomMeta,
  RoomRecord,
} from "../core/room/types.ts";
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

/** The contract fields these DTOs copy (M12-3). A new contract field fails
 *  `npm run check` here until the matching builder copies it. The Pending
 *  decision pin covers the shape every asker variant shares; the three pins
 *  below cover their variant-only fields. */
const PENDING_KEYS = {
  id: 0,
  kind: 0,
  title: 0,
  input: 0,
  diff: 0,
} as const satisfies Record<keyof PendingDecision, 0>;
type RunAskerKeys = Exclude<
  keyof Extract<PendingDecision, { runId: string }>,
  keyof PendingDecision
>;
type RoomAskerKeys = Exclude<
  keyof Extract<PendingDecision, { roomId: string }>,
  keyof PendingDecision
>;
const RUN_ASKER_KEYS = {
  runId: 0,
  taskId: 0,
} as const satisfies Record<RunAskerKeys, 0>;
const ROOM_ASKER_KEYS = {
  roomId: 0,
  participantId: 0,
  turn: 0,
} as const satisfies Record<RoomAskerKeys, 0>;
type ChatAskerKeys = Exclude<
  keyof Extract<PendingDecision, { chatId: string }>,
  keyof PendingDecision
>;
const CHAT_ASKER_KEYS = {
  chatId: 0,
  turn: 0,
} as const satisfies Record<ChatAskerKeys, 0>;
const DIFF_KEYS = {
  text: 0,
  files: 0,
  added: 0,
  removed: 0,
} as const satisfies Record<keyof Diff, 0>;
const CONFIG_VIEW_KEYS = {
  path: 0,
  rows: 0,
  invalid: 0,
} as const satisfies Record<keyof Omit<ConfigView, "root">, 0>;
const CONFIG_ROW_KEYS = {
  key: 0,
  value: 0,
  source: 0,
  default: 0,
  file: 0,
  env: 0,
} as const satisfies Record<keyof ConfigRow, 0>;

/** Copy only the named fields, omitting absent optional values. */
function pick<T extends object, K extends keyof T>(
  source: T,
  fields: Record<K, 0>,
): Pick<T, K> {
  const copy: Partial<Pick<T, K>> = {};
  for (const key of Object.keys(fields) as K[]) {
    if (source[key] !== undefined) copy[key] = source[key];
  }
  return copy as Pick<T, K>;
}

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
 *  wire. Live runs are built in `daemon/routes/runs.ts`; finished ones are
 *  read back from their `run.json` at boot (M2-6, #36). Notices keep every
 *  line, containment included: #13 says those are never suppressed, and
 *  with no terminal this record is where they survive. */
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

/** One permission decision as the contract carries it (M12-3). The asker,
 *  `input` and `diff` are rebuilt so a field added to `core/permissions.ts`
 *  cannot reach the wire. `input` is a dictionary by contract, so its keys
 *  stay; `diff` is a fixed shape, so its fields are selected through
 *  `DIFF_KEYS`. */
export function toPendingDecision(
  decision: CorePendingDecision,
): PendingDecision {
  const shared = pick(
    {
      ...decision,
      ...(decision.input !== undefined && { input: { ...decision.input } }),
      ...(decision.diff !== undefined && {
        diff: pick(decision.diff, DIFF_KEYS),
      }),
    },
    PENDING_KEYS,
  );
  if ("runId" in decision) {
    return { ...shared, ...pick(decision, RUN_ASKER_KEYS) };
  }
  if ("chatId" in decision) {
    return { ...shared, ...pick(decision, CHAT_ASKER_KEYS) };
  }
  return { ...shared, ...pick(decision, ROOM_ASKER_KEYS) };
}

/** `GET /permissions/:id`: an open decision, or a closed one with its answer
 *  and why it closed (M12-3). */
export function toPermissionDecision(
  decision: CorePendingDecision | CoreSettledDecision,
): PermissionDecision {
  if (!("allow" in decision)) return toPendingDecision(decision);
  return {
    ...toPendingDecision(decision),
    allow: decision.allow,
    reason: decision.reason,
  };
}

/** The project config view the contract carries (M12-3). The top level,
 *  every row and each row's array values are rebuilt so a field added to
 *  `core/config.ts` does not reach the wire. */
export function toConfigView(
  root: string,
  view: ReturnType<typeof projectConfigView>,
): ConfigView {
  const rows = view.rows.map((row) =>
    pick(
      {
        ...row,
        value: Array.isArray(row.value) ? [...row.value] : row.value,
        default: Array.isArray(row.default) ? [...row.default] : row.default,
        ...(row.file !== undefined && {
          file: Array.isArray(row.file) ? [...row.file] : row.file,
        }),
      },
      CONFIG_ROW_KEYS,
    ),
  );
  return {
    root,
    ...pick({ ...view, rows }, CONFIG_VIEW_KEYS),
  };
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
  if (p.thoughtLevel !== undefined) dto.thoughtLevel = p.thoughtLevel;
  if (p.thoughtLevels !== undefined)
    dto.thoughtLevels = p.thoughtLevels.map(({ id, name }) => ({ id, name }));
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
  if (state.id === HALL_ID) dto.hall = true;
  return dto;
}

/** One `GET /rooms` entry: the room and a short roster (R9, R44). */
export function toRoomListEntry(state: RoomState, room: Room): RoomListEntry {
  return listEntry(state, room.status(), room.participants, (p) => p.status());
}

/** The same entry for a dismissed room the boot did not build (#451), from
 *  its `room.json`. A built dismissed room reads `dismissed` for every
 *  participant, so the record's own statuses are not used. */
export function toRecordListEntry(record: RoomRecord): RoomListEntry {
  return listEntry(record, "dismissed", record.participants, () => "dismissed");
}

/** The one builder both entries share, so a field reaches both or neither. */
function listEntry<P extends Pick<Participant, "id" | "name" | "role">>(
  state: Pick<RoomState, "id" | "cwd" | "title" | "updatedAt">,
  status: RoomListEntry["status"],
  roster: readonly P[],
  statusOf: (p: P) => RoomListEntry["participants"][number]["status"],
): RoomListEntry {
  const entry: RoomListEntry = {
    id: state.id,
    cwd: state.cwd,
    status,
    updatedAt: state.updatedAt,
    participants: roster.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.role && { role: p.role }),
      status: statusOf(p),
    })),
  };
  if (state.title !== undefined) entry.title = state.title;
  if (state.id === HALL_ID) entry.hall = true;
  return entry;
}

/** One live chat (M11-13). Key by key, as `toRoomDto`. */
export function toChatDto(chat: Chat): ChatDto {
  return {
    id: chat.id,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt(),
    seq: chat.eventLog?.size ?? 0,
    agent: toParticipantDto(chat.participant),
  };
}

/** One archived chat from its `chat.json`, at `folder` (M11-13). An
 *  archived record always has `removedAt` (`readChatRecord`). */
export function toArchivedChat(
  record: ChatRecord,
  folder: string,
): ArchivedChat {
  return {
    id: record.id,
    name: record.participant.name,
    harness: record.participant.harness,
    createdAt: record.createdAt,
    removedAt: record.removedAt ?? record.updatedAt,
    folder,
    notices: record.notices.map(({ text, kind }) => ({
      text,
      ...(kind && { kind }),
    })),
  };
}
