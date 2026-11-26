/**
 * The room's persisted record and tombstones (M12-8a).
 *
 * **`room.json` is the room's record** (S4b, R17). It sits beside the event
 * log, holds the room and every participant in one file, and is written with
 * a temp file and `rename`, so a reader never sees half of it. It is saved a
 * moment after each change of the roster or of a status, so a daemon killed
 * with `kill -9` leaves the statuses it last had. The boot sweep turns those
 * into `paused` and `killed` (`crashed`, below), and `restoreRoom` builds the
 * room again from the file, without starting a harness.
 *
 * **A saved harness that no longer resolves is tombstoned** (#312). Its full
 * record stays in `room.json` under `tombstones`, outside the active roster,
 * so its checkout and branch remain known to delete. The rest of the room
 * restores normally, the daemon logs the room, agent and record path when the
 * participant is first tombstoned, and a writable restored log gets a
 * participant-removed line so a replay drops it from the roster. A dismissed
 * room's log stays read-only. A tombstone is permanent: later restores do not
 * retry the agent, even if the harness is installed again. Deleting the room
 * is the supported way to remove it.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ClientMode, resolveAgent } from "../../protocol/registry.ts";
import { stateDirFor } from "../runtime.ts";
import { checkoutIdentity, type Worktrees } from "../worktree.ts";
import {
  MODES,
  type ParticipantRecord,
  type ParticipantStatus,
  ROLES,
  type Role,
  type RoomNotice,
  type RoomRecord,
  type RoomStatus,
} from "./types.ts";

/** The part of the room's places that tombstone restore needs. */
interface RecordPlaces {
  saved: (
    participant: ParticipantRecord,
  ) => Promise<{ worktrees: Worktrees | null }>;
}

/** Where a room's record and log live. */
export const roomDir = (root: string, roomId: string) =>
  join(stateDirFor(root), "rooms", roomId);

/** `room.json` for the room `roomId` of the repository at `root`. */
export const roomFile = (root: string, roomId: string) =>
  join(roomDir(root, roomId), "room.json");

/**
 * Writes `room.json` with a temp file and `rename`, as `run.json` is, so a
 * reader sees the old record or the new one and never half of either. The
 * temp name carries the pid, because the boot sweep writes the same file.
 * An empty `tombstones` is omitted here, the one writer both paths use, so the
 * optional field does not grow back during a sweep.
 */
export function writeRoomRecord(path: string, record: RoomRecord): void {
  const { tombstones, ...rest } = record;
  writeRecord(path, tombstones?.length ? { ...rest, tombstones } : rest);
}

/** An owner's record file, written whole or not at all: `room.json`, or a
 *  chat's `chat.json` (`core/chat.ts`). */
export function writeRecord(path: string, record: object): void {
  const tmp = `${path}.${process.pid}.tmp`;
  // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
  // pi-lens-ignore: no-raw-json-store-write
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

const ROOM_STATUSES: readonly RoomStatus[] = ["active", "paused", "dismissed"];
const PARTICIPANT_STATUSES: readonly ParticipantStatus[] = [
  "idle",
  "busy",
  "exited",
  "paused",
  "killed",
  "dismissed",
];

/**
 * One participant's record, checked and made whole (M12-8c): a room keeps
 * one per participant in `room.json`, and any other owner can keep one the
 * same way. `fail` makes the error, so the owner names the file and the list.
 */
// One pass keeps the first bad field and the owner's exact error text stable.
// pi-lens-ignore: high-complexity
export function readParticipantRecord(
  raw: unknown,
  fail: (why: string) => Error,
): ParticipantRecord {
  const p = raw as Record<string, unknown> | null | undefined;
  for (const key of ["id", "name", "harness", "worktree", "sessionId"]) {
    if (typeof p?.[key] !== "string") {
      throw fail(`a participant's "${key}" is not a string`);
    }
  }
  // SAFETY: the loop above proved `p` is an object.
  const r = p as Record<string, unknown>;
  if (typeof r.agent !== "string" && typeof r.cmd !== "string") {
    throw fail(`participant ${r.id} names no "agent" or "cmd"`);
  }
  if (!MODES.includes(r.mode as ClientMode)) {
    throw fail(`participant ${r.id} has mode ${JSON.stringify(r.mode)}`);
  }
  if (!PARTICIPANT_STATUSES.includes(r.status as ParticipantStatus)) {
    throw fail(`participant ${r.id} has status ${JSON.stringify(r.status)}`);
  }
  // The contract's set is closed (R44): a client may trust it.
  if (r.role !== undefined && !ROLES.includes(r.role as Role)) {
    throw fail(`participant ${r.id} has role ${JSON.stringify(r.role)}`);
  }
  // SAFETY: the checks above cover every required ParticipantRecord field.
  const saved = r as unknown as ParticipantRecord;
  return {
    ...saved,
    settings: {
      allowReadOutsideRoot: saved.settings?.allowReadOutsideRoot === true,
    },
    notices: Array.isArray(saved.notices) ? saved.notices : [],
    // A `turns` that is not a whole number, or an `orderedBy` that is not a
    // string, is dropped, so it is never saved again.
    turns: Number.isInteger(saved.turns) ? saved.turns : undefined,
    orderedBy:
      typeof saved.orderedBy === "string" ? saved.orderedBy : undefined,
    model:
      typeof saved.model === "string" && saved.model ? saved.model : undefined,
    pendingModel:
      typeof saved.pendingModel === "string" && saved.pendingModel
        ? saved.pendingModel
        : undefined,
    thoughtLevel:
      typeof saved.thoughtLevel === "string" && saved.thoughtLevel
        ? saved.thoughtLevel
        : undefined,
    pendingThoughtLevel:
      typeof saved.pendingThoughtLevel === "string" && saved.pendingThoughtLevel
        ? saved.pendingThoughtLevel
        : undefined,
  };
}

/** `room.json`, read and checked, or a throw naming what is wrong. The file
 *  is ours, so the check is for a crash or a hand edit, not an attack: it
 *  is in the operator's own state directory, next to what it names. */
export function readRoomRecord(path: string): RoomRecord {
  const bad = (why: string) => new Error(`${path}: ${why}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw bad(err instanceof Error ? err.message : String(err));
  }
  if (typeof raw !== "object" || raw === null) throw bad("not an object");
  const r = raw as Record<string, unknown>;
  for (const key of ["id", "cwd", "createdAt", "updatedAt"]) {
    if (typeof r[key] !== "string") throw bad(`"${key}" is not a string`);
  }
  if (!ROOM_STATUSES.includes(r.status as RoomStatus)) {
    throw bad(`unknown status ${JSON.stringify(r.status)}`);
  }
  if (r.title !== undefined && typeof r.title !== "string") {
    throw bad('"title" is not a string');
  }
  if (!Array.isArray(r.participants)) throw bad('"participants" is not a list');
  if (r.tombstones !== undefined && !Array.isArray(r.tombstones)) {
    throw bad('"tombstones" is not a list');
  }
  if (r.repositories !== undefined && !Array.isArray(r.repositories)) {
    throw bad('"repositories" is not a list');
  }
  const repositories = r.repositories as unknown[] | undefined;
  if (repositories?.some((path) => typeof path !== "string")) {
    throw bad('"repositories" must name strings');
  }
  const list = (where: string, records: unknown[]) =>
    records.map((p) =>
      readParticipantRecord(p, (why) => bad(`the ${where} list: ${why}`)),
    );
  const participants = list("participants", r.participants);
  const tombstones = list("tombstones", (r.tombstones ?? []) as unknown[]);
  return {
    ...(raw as RoomRecord),
    turnCap:
      Number.isInteger(r.turnCap) && (r.turnCap as number) >= 1
        ? (r.turnCap as number)
        : undefined,
    turnCount:
      Number.isInteger(r.turnCount) && (r.turnCount as number) >= 0
        ? (r.turnCount as number)
        : undefined,
    notices: Array.isArray(r.notices) ? (r.notices as RoomNotice[]) : [],
    participants,
    tombstones,
    ...(repositories?.length && { repositories: repositories as string[] }),
  };
}

/**
 * What a record says once its daemon is gone (R46). A room still `active`
 * is `paused`; a participant that was `busy` stopped during a turn without a
 * clean end, so it is `killed`, and one that was `idle` is `paused`. The
 * other statuses stay. A dismissed room is left as it is. The boot sweep
 * writes this; `restoreRoom` applies it too, for a record the sweep could
 * not write.
 */
export function crashed(record: RoomRecord): RoomRecord {
  if (record.status !== "active") return record;
  return {
    ...record,
    status: "paused",
    participants: record.participants.map(crashedParticipant),
  };
}

/** One participant as `crashed` leaves it; a chat's record uses it alone. */
export function crashedParticipant(p: ParticipantRecord): ParticipantRecord {
  if (p.status === "busy") return { ...p, status: "killed" };
  if (p.status === "idle") return { ...p, status: "paused" };
  return p;
}

/** Read the checkout once when a participant is first tombstoned, so its
 *  record names the branch the harness left it on. Later restores do not retry
 *  it. A read that fails keeps the saved identity. */
async function syncTombstoneCheckout(
  saved: ParticipantRecord,
): Promise<ParticipantRecord> {
  if (!saved.branch || !saved.baseSha) return saved;
  let found: Awaited<ReturnType<typeof checkoutIdentity>>;
  try {
    found = await checkoutIdentity(saved.worktree, saved.branch);
  } catch {
    return saved;
  }
  if (!found) return saved;
  let next = saved;
  if (found.branch !== saved.branch) {
    const { branchRenamed: _oldRename, ...rest } = saved;
    next = {
      ...rest,
      branch: found.branch,
      ...(found.renamedFrom === saved.branch && {
        branchRenamed: true as const,
      }),
    };
  }
  if (found.rebaseBase !== undefined && found.rebaseBase !== saved.baseSha) {
    next = { ...next, baseSha: found.rebaseBase };
  }
  return next;
}

/** Add an unresolved participant once, without duplicating a tombstone. */
function rememberTombstone(
  tombstones: ParticipantRecord[],
  known: Set<string>,
  saved: ParticipantRecord,
): boolean {
  if (known.has(saved.id)) return false;
  tombstones.push(saved);
  known.add(saved.id);
  return true;
}

/** Hold a saved participant's checkout, or the branch a crash left after
 *  removing its checkout, so a release can finish it as a member's: a room's
 *  tombstone, or a chat whose remove a crash cut short. */
export function adoptCheckout(
  worktrees: Worktrees | null,
  saved: ParticipantRecord,
): void {
  if (!worktrees || !saved.branch || !saved.baseSha) return;
  worktrees.adopt(saved.id, {
    branch: saved.branch,
    baseSha: saved.baseSha,
    ...(saved.baseRef && { baseRef: saved.baseRef }),
    ...(saved.branchRenamed === true && { renamed: true }),
  });
}

/** Move saved participants whose harness no longer resolves out of the active
 *  roster. Their full record stays as a tombstone, so delete can still find
 *  the checkout and a branch the participant renamed. */
export async function tombstoneUnknownAgents(
  record: RoomRecord,
  root: string,
  log: (line: string) => void,
  places: RecordPlaces,
): Promise<{ record: RoomRecord; tombstoned: ParticipantRecord[] }> {
  const tombstones = [...(record.tombstones ?? [])];
  const known = new Set(tombstones.map((p) => p.id));
  const participants: ParticipantRecord[] = [];
  const tombstoned: ParticipantRecord[] = [];
  for (const saved of record.participants) {
    try {
      resolveAgent(saved.agent ?? "", saved.cmd);
      participants.push(saved);
    } catch {
      if (rememberTombstone(tombstones, known, saved)) tombstoned.push(saved);
    }
  }
  let changed =
    participants.length !== record.participants.length ||
    tombstones.length !== (record.tombstones?.length ?? 0);
  const fresh = new Set(tombstoned.map((p) => p.id));
  for (const [i, saved] of tombstones.entries()) {
    const isNew = fresh.has(saved.id);
    const next = isNew ? await syncTombstoneCheckout(saved) : saved;
    if (next !== saved) changed = true;
    tombstones[i] = next;
    adoptCheckout((await places.saved(next)).worktrees, next);
    if (isNew) {
      log(
        `room ${record.id} at ${roomFile(root, record.id)}: participant ` +
          `${next.name} (${next.id}) cannot resolve saved agent ` +
          `${JSON.stringify(next.agent ?? next.cmd ?? "")}; kept out of the ` +
          "active roster as a tombstone",
      );
    }
  }
  return {
    record: changed ? { ...record, participants, tombstones } : record,
    tombstoned,
  };
}
