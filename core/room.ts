/**
 * A chat room — a container with a roster of participants (M6-2).
 *
 * **The room owns each harness's lifetime.** A run spawns a harness, sends one
 * prompt and stops it (`core/run.ts`). A room spawns a participant's harness
 * once, sends a prompt per message, and stops it only when the room is
 * dismissed. Measured safe on all four harnesses: a prompt sent after
 * `end_turn` completes on the same session with the first turn's context kept
 * (`docs/FINDINGS.md` §Multi-turn). A prompt *during* a live turn is still
 * refused, here as `busy` and below as `AcpAgent`'s in-flight guard (#62 R5).
 *
 * **One checkout per participant** (M6-6a, R14). Each one runs in
 * `stateDirFor(root)/wt/<roomId>/<participantId>`, on the branch
 * `kapelle/<roomId>/<participantId>`, so turns run in parallel without
 * touching each other's files (R6). Nothing is shared or inherited. `add`
 * takes the base to fork from: any ref, including another participant's
 * branch (R35c). A branch holds only what its participant committed, so a
 * participant started from it never sees the other's uncommitted files (R37).
 *
 * **A kept checkout lasts until the next daemon boot.** A room writes no
 * record until M6-7a, so the boot sweep (`core/sweep.ts`) takes every room
 * checkout for an orphan: it removes a clean one and keeps its branch, and
 * keeps a dirty one or one on a detached HEAD. No work is lost; the
 * directory may be.
 *
 * **A roster that changes** (M6-3). `add`, `update` and `remove` change it
 * after the room opens. A name is unique under ASCII case folding (R22), and
 * at most one participant is the orchestrator (R44). An add still in flight
 * holds its name and role, so two racing adds cannot both take one. A
 * removed participant leaves the roster. Its checkout is released as at
 * dismiss, and a release notice goes to the room's notices, since the
 * participant that would show it is gone. Each change is on the log —
 * `_client_participant_added`, `_changed` and `_removed`, starters included —
 * so a client builds the roster from the stream alone (M6-10).
 *
 * **The orchestrator is a label, not a slot** (R44). A participant has the
 * role it was given and no other; nothing is promoted by default.
 *
 * **One participant's branch can fast-forward to another's** (M6-11a, R45).
 * `fastForward` runs `git merge --ff-only` inside the target's checkout,
 * refuses a busy target, a dirty one (2c) and a diverged one, moves no source
 * branch, and logs `_client_participant_fast_forwarded` when it actually moves
 * a commit. A move to the commit the target already has is a silent no-op.
 * The move counts as busy, so a message sent during it queues behind it.
 *
 * **A message names its participant, and a busy one queues it** (M6-4).
 * `send` starts a turn, or puts the message in a FIFO queue behind the live
 * one (R32a); 16 wait at most, and the next is refused `queue_full` (R41).
 * The queue is in memory only, so a daemon restart loses it. `cancel` drops
 * the queue, then cancels the live turn; the session stays (S5a). A dropped
 * message is never sent, and `_client_queue_cleared` says how many.
 *
 * **One log for the room** (S10). The bus names each event's participant by
 * its id in `agent`, and the log writes it as `participantId` beside the
 * `roomId`. A thread is that log filtered by `participantId` (R8c over R13a).
 *
 * **Each participant has its own mode** (M6-5, R12): `auto` by default,
 * `ask` or `safe` at add, and changed by `update` at any time. The filter
 * reads the mode live, so a change applies to the next request. The
 * harness's own mode follows before the next turn: `harnessModeId` picks
 * `modeMap.safe` for `safe` and `modeMap.ask` for the other two, never
 * `modeMap.auto`. An `ask` request waits in the daemon's queue, named by
 * room, participant and turn (S12a). When a turn ends for any reason, its
 * open decisions are denied as `cancel`; a mode that leaves `ask` answers
 * them as `mode_change`.
 *
 * **MVP scope, deliberately.** The watchdog only warns, and only during a turn (R38):
 * a chat turn is never cut by a clock. No result preamble, no cross-check: a
 * chat turn is conversation, not a deliverable (R39). What stays is what makes a room
 * safe to leave running: its own worktree, the path guard `AcpAgent` always
 * applies, the containment notices, and the persisted event log a client
 * replays when it attaches.
 *
 * ponytail: nothing caps the live harness count across runs and rooms (R40).
 * `runs + Σ(busy participants)` is unbounded, with the default mode `auto`,
 * and so is the `agents` list of one `POST /rooms`, which starts them in turn.
 * A daemon-wide cap belongs in `daemon.ts`, where both spawners meet; add one
 * when a machine actually runs out of memory or file handles, not before.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { AcpAgent, type Policy } from "../protocol/agent.ts";
import {
  type ClientMode,
  type ResolvedAgent,
  resolveAgent,
  resolveEnv,
  type Warning,
  warningsFor,
} from "../protocol/registry.ts";
import { createEventLog, type EventLog } from "./eventlog.ts";
import type { EventBus } from "./events.ts";
import { newParticipantId } from "./ids.ts";
import type { PermissionQueue } from "./permissions.ts";
import { harnessModeId, modeLine, policyFor, resolvePolicy } from "./policy.ts";
import { stateDirFor } from "./runtime.ts";
import {
  createWatchdog,
  sweepIntervalMs,
  WATCHDOG_DEFAULTS,
  type Watchdog,
  type WatchdogLimits,
} from "./watchdog.ts";
import {
  BadBase,
  DirtyCheckout,
  fastForwardCheckout,
  NotFastForward,
  type WorktreeSetup,
} from "./worktree.ts";

/** How many messages may wait behind a participant's live turn (R41). */
export const QUEUE_BOUND = 16;

/** A refusal the daemon answers with its own error code. Any other throw
 *  from `add`, `update` or `remove` is a failure, not a refusal. */
export class RoomRefusal extends Error {
  readonly code:
    | "invalid_request"
    | "name_taken"
    | "orchestrator_exists"
    | "participant_not_found"
    | "room_dismissed"
    | "agent_exited"
    | "agent_busy"
    | "not_fast_forward"
    | "dirty_worktree"
    | "no_branch"
    | "queue_full";
  constructor(code: RoomRefusal["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** `paused` is M6-7a's; nothing sets it yet. A room whose participant has
 *  exited still reads `active` (R33). */
type RoomStatus = "active" | "paused" | "dismissed";

/** `exited` is a harness that died before the room was dismissed. `paused`
 *  and `killed` are M6-7a's; nothing sets them yet. */
type ParticipantStatus =
  | "idle"
  | "busy"
  | "exited"
  | "paused"
  | "killed"
  | "dismissed";

/** R44's closed set. A label only: it sends no text to the harness. */
const ROLES = ["orchestrator", "developer", "tester", "architect"] as const;
type Role = (typeof ROLES)[number];

/** R22: ASCII on purpose, so the first word of an `@name` message is always
 *  the whole name, and Unicode case folding cannot make two names one.
 *  Because a name is ASCII, `toLowerCase` is ASCII case folding here. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** R15, amended 2026-09-28 (#147): the run-file `Task` fields that act in a
 *  room today. The watchdog limits are the room's, from the daemon's config,
 *  not a participant's. No `purpose`: a person sends instructions as a
 *  message, never as a hidden prefix. */
interface Settings {
  allowReadOutsideRoot: boolean;
}

/** A line the room kept for the operator, as `Warning` has it. */
interface RoomNotice {
  text: string;
  kind?: Warning["kind"];
}

/** One agent the request asked for, checked and resolved. */
export interface AgentRequest {
  spec: ResolvedAgent;
  name: string;
  role?: Role;
  /** The ref to fork from, such as another participant's `branch`; the
   *  repository's HEAD when absent. */
  base?: string;
  mode: ClientMode;
  settings: Settings;
}

/** What `PATCH` may change. A `null` role clears it. */
export interface ParticipantChanges {
  name?: string;
  role?: Role | null;
  mode?: ClientMode;
}

export interface Participant {
  /** Opaque (`newParticipantId`); a rename never moves it. */
  readonly id: string;
  /** Changed only through `Room.update`, which checks it. */
  name: string;
  role?: Role;
  readonly harness: string;
  /** Changed only through `Room.update`. */
  readonly mode: ClientMode;
  /** As they act: `safe` reads `allowReadOutsideRoot` as false. */
  readonly settings: Settings;
  /** Where the harness runs: its own checkout, or the cwd itself. */
  readonly worktree: string;
  /** The checkout's branch and the SHA it forked from, when there is one. */
  readonly branch?: string;
  readonly baseSha?: string;
  /** Recorded from the first version, though nothing loads it until
   *  `session/load` lands (R17, the M2-6 precedent). */
  readonly sessionId: string;
  /** The room's notices, then this participant's containment and worktree
   *  notices. #13's lines are never dropped, and a room has no terminal of
   *  its own, so the caller publishes them. */
  readonly notices: readonly RoomNotice[];
  status(): ParticipantStatus;
  /** Messages waiting behind the live turn. */
  readonly queued: number;
  /**
   * Starts a turn with this message, or queues it behind the live one.
   * Resolves when its turn ends, or when it is dropped from the queue.
   * Refuses with a `RoomRefusal` — before any byte reaches the harness — once
   * the room is dismissed or the harness is gone, and when `QUEUE_BOUND`
   * messages already wait. A turn that fails is not a rejection: it ends with
   * `_client_turn_ended` carrying `error`, which is how every client learns
   * of it.
   */
  send(text: string): Promise<void>;
  /** Drops the queue, then asks the harness to end the live turn. The
   *  session stays (S5a). False when no turn is live. */
  cancel(): boolean;
}

export interface Room {
  readonly participants: readonly Participant[];
  /** The room's persisted events, or undefined when it could not be written. */
  readonly eventLog: EventLog | undefined;
  status(): RoomStatus;
  /** Adds one participant in a checkout of its own, forked from
   *  `request.base` or from the repository's HEAD. Resolves once its harness
   *  has a session. A throw adds no participant, and removes the checkout and
   *  branch if the harness left them untouched. One it wrote into is kept,
   *  and a room notice names it. */
  add(request: AgentRequest): Promise<Participant>;
  /** Renames a participant, or changes its role or mode. Checks every
   *  change before it applies any. */
  update(id: string, changes: ParticipantChanges): Participant;
  /** Cancels the participant's turn, stops its harness and releases its
   *  checkout without committing (R37). It leaves the roster at once. */
  remove(id: string): Promise<void>;
  /** Moves `targetId`'s branch and checkout up to `fromId`'s branch,
   *  fast-forward only (M6-11a, R45). Runs `git merge --ff-only` inside the
   *  target's checkout; refuses a busy target, a dirty one (2c) and a
   *  diverged one, and nothing changes on a refusal. */
  fastForward(targetId: string, fromId: string): Promise<Participant>;
  /** Cancels every live turn, stops every harness, releases every checkout
   *  **without committing** (R37) and closes the log. Safe to call twice. A
   *  release that fails is reported as a notice and the checkout is left
   *  where it is; `dismiss()` still resolves, because a dismissed room can
   *  never be retried. */
  dismiss(): Promise<void>;
}

/** The harness `agent` or `cmd` names, or a throw naming what is wrong. */
function roomHarness(agent: unknown, cmd: unknown): ResolvedAgent {
  // A field that is present must be a string, as for `name`: a `7` or a
  // `null` is a bad value, not a missing one.
  const str = (field: string, v: unknown) => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v) {
      throw new Error(`"${field}" must be a non-empty string`);
    }
    return v;
  };
  const byName = str("agent", agent);
  const byCmd = str("cmd", cmd);
  if (!byName && !byCmd) throw new Error('an agent needs "agent" or "cmd"');
  return resolveAgent(byName ?? "", byCmd);
}

/** The ceiling check `resolvePolicy` owns: a mode above the harness's
 *  `maxMode` is refused, never run more contained than asked. */
function checkCeiling(spec: ResolvedAgent, mode: ClientMode) {
  resolvePolicy({
    run: { mode },
    harness: { name: spec.name, maxMode: spec.maxMode },
  });
}

/** The fields one agent takes, at `POST /rooms` and at
 *  `POST /rooms/:id/agents`. */
export const AGENT_FIELDS: readonly string[] = [
  "agent",
  "cmd",
  "name",
  "role",
  "mode",
  "base",
  "settings",
];

/** A name, or a throw naming what is wrong. `fallback` is the harness name
 *  an add uses when the request gave none. */
function checkName(name: unknown, fallback?: string): string {
  // `=== undefined`, not `??`: a JSON `null` is a bad name, not a missing one.
  const chosen = name === undefined ? fallback : name;
  if (typeof chosen !== "string" || !NAME_PATTERN.test(chosen)) {
    throw new Error(
      `invalid agent name ${JSON.stringify(chosen)}: must match ` +
        `${NAME_PATTERN.source}` +
        (name === undefined ? '; give the agent a "name"' : ""),
    );
  }
  return chosen;
}

function checkRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) {
    throw new Error(
      `invalid role ${JSON.stringify(role)}: one of ${ROLES.join(", ")}`,
    );
  }
  return role as Role;
}

const MODES: readonly ClientMode[] = ["ask", "safe", "auto"];

function checkMode(mode: unknown): ClientMode {
  if (!MODES.includes(mode as ClientMode)) {
    throw new Error(
      `invalid mode ${JSON.stringify(mode)}: one of ${MODES.join(", ")}`,
    );
  }
  return mode as ClientMode;
}

function checkSettings(raw: unknown): Settings {
  if (raw === undefined) return { allowReadOutsideRoot: false };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('"settings" must be an object');
  }
  const extra = Object.keys(raw).find((key) => key !== "allowReadOutsideRoot");
  if (extra !== undefined) {
    throw new Error(
      `unknown setting "${extra}"; "settings" takes allowReadOutsideRoot`,
    );
  }
  const { allowReadOutsideRoot = false } = raw as Record<string, unknown>;
  if (typeof allowReadOutsideRoot !== "boolean") {
    throw new Error('"allowReadOutsideRoot" must be true or false');
  }
  return { allowReadOutsideRoot };
}

/** The refusal a name or role meets among `others`, or undefined (R22,
 *  R44). */
function clash(
  others: Iterable<{ name: string; role?: Role | undefined }>,
  next: { name?: string | undefined; role?: Role | null | undefined },
): RoomRefusal | undefined {
  for (const other of others) {
    if (next.name?.toLowerCase() === other.name.toLowerCase()) {
      return new RoomRefusal(
        "name_taken",
        `the name "${next.name}" is taken by "${other.name}"`,
      );
    }
    if (next.role === "orchestrator" && other.role === "orchestrator") {
      return new RoomRefusal(
        "orchestrator_exists",
        `"${other.name}" is already the orchestrator; change its role first`,
      );
    }
  }
  return undefined;
}

/** One agent of a request body, checked, or a throw naming what is wrong. */
export function roomAgent(entry: unknown): AgentRequest {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("an agent must be an object");
  }
  const extra = Object.keys(entry).find((key) => !AGENT_FIELDS.includes(key));
  if (extra !== undefined) {
    throw new Error(
      `unknown agent field "${extra}"; an agent takes ${AGENT_FIELDS.join(", ")}`,
    );
  }
  const { agent, cmd, name, role, mode, base, settings } = entry as Record<
    string,
    unknown
  >;
  const spec = roomHarness(agent, cmd);
  const request: AgentRequest = {
    spec,
    name: checkName(name, spec.name),
    // R12: `auto` by default, so an unattended room never waits on a person.
    mode: mode === undefined ? "auto" : checkMode(mode),
    settings: checkSettings(settings),
  };
  checkCeiling(spec, request.mode);
  if (role !== undefined) request.role = checkRole(role);
  if (base !== undefined) {
    if (typeof base !== "string" || !base) {
      throw new Error('"base" must be a non-empty string');
    }
    request.base = base;
  }
  return request;
}

/**
 * The `agents` of a `POST /rooms` body, checked, or a throw naming what is
 * wrong. Split from `openRoom` so the daemon can answer a bad request before
 * it touches the repository. A name or role that clashes inside the list is
 * a `RoomRefusal`, as it would be at add.
 */
export function roomAgents(raw: unknown): AgentRequest[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('"agents" must be a list');
  const requests: AgentRequest[] = [];
  for (const entry of raw) {
    const request = roomAgent(entry);
    const refused = clash(requests, request);
    if (refused) throw refused;
    requests.push(request);
  }
  return requests;
}

/** A `PATCH /rooms/:id/agents/:agentId` body, checked. */
export function participantChanges(
  body: Record<string, unknown>,
): ParticipantChanges {
  const { name, mode, role } = body;
  if (name === undefined && mode === undefined && role === undefined) {
    throw new Error('send at least one of "name", "mode" or "role"');
  }
  const changes: ParticipantChanges = {};
  if (mode !== undefined) changes.mode = checkMode(mode);
  if (name !== undefined) changes.name = checkName(name);
  if (role !== undefined) changes.role = role === null ? null : checkRole(role);
  return changes;
}

export interface RoomOptions {
  roomId: string;
  /** The folder the room was asked for; the harness runs here when there is
   *  no worktree, and at the same subdirectory inside one when there is. */
  cwd: string;
  /** From `roomAgents`, added in this order. */
  agents: AgentRequest[];
  /** The preflight the caller already ran (`openWorktrees`). */
  setup: WorktreeSetup;
  bus: EventBus;
  /** Where an `ask` participant's requests wait for a person. */
  permissions: PermissionQueue;
  /** The watchdog's warn limits; `WATCHDOG_DEFAULTS` when absent. There is
   *  no TTL in a room (R38). */
  limits?: Pick<WatchdogLimits, "stallIdleMs" | "stallRepeatCount">;
}

type Notify = (text: string, kind?: Warning["kind"]) => void;

/** One participant, and what the room needs to end it. */
interface Member {
  participant: Participant;
  spec: ResolvedAgent;
  stop: () => Promise<void>;
  setMode: (mode: ClientMode) => void;
  hold: <T>(work: Promise<T>) => Promise<T>;
  onNotice: Notify;
}

/** Opens a room and resolves once every participant's harness has a
 *  session. A harness that cannot start is a throw, never a dead
 *  participant (S13). */
export async function openRoom({
  roomId,
  cwd,
  agents,
  setup,
  bus,
  permissions,
  limits = WATCHDOG_DEFAULTS,
}: RoomOptions): Promise<Room> {
  const { worktrees, notice, root } = setup;
  // The room's own lines: only the event log's today. With no participant
  // nothing publishes them, and a log failure shows only as `no_event_log`
  // on `GET /rooms/:id/events`. A room has no notices on the wire, so every
  // participant shows them before its own.
  const roomNotices: RoomNotice[] = [];
  const onRoomNotice: Notify = (text, kind) =>
    roomNotices.push(kind ? { text, kind } : { text });

  // #129: a room asks nothing of the operator's repository either — its log
  // and stderr live in the same workspace as a run's, outside the checkout.
  const logDir = join(stateDirFor(root), "rooms", roomId);
  let eventLog: EventLog | undefined;
  try {
    mkdirSync(logDir, { recursive: true });
    const log = createEventLog(join(logDir, "events.jsonl"), (err) =>
      onRoomNotice(`cannot write event log: ${err.message}`),
    );
    eventLog = log;
    // The bus's `agent` is the participant id (S10).
    bus.addListener(({ agent, update }) =>
      log.append({ roomId, participantId: agent, update }),
    );
  } catch (err) {
    onRoomNotice(
      `cannot write room logs to ${logDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // One sweep for the room, as for a run. `ttlMs` is 0, so it never cancels.
  const watchLimits: WatchdogLimits = {
    stallIdleMs: limits.stallIdleMs,
    stallRepeatCount: limits.stallRepeatCount,
    ttlMs: 0,
  };
  const watchdog = createWatchdog({
    onWarn: (id, kind, text) =>
      bus.emit({
        agent: id,
        update: { sessionUpdate: "_client_stall_warning", kind, text },
      }),
    onTimeout: () => {},
  });
  const sweep = setInterval(
    () => watchdog.sweep(),
    sweepIntervalMs([watchLimits]),
  );
  // It watches harnesses that already keep the loop alive.
  sweep.unref();

  let dismissing: Promise<void> | undefined;
  const members: Member[] = [];
  const participants: Participant[] = [];

  // **Never `commit` (R37).** The supervisor stays out of the commit business:
  // a participant commits its own branch, and whatever is left uncommitted at
  // dismiss stays in the checkout for a person to look at. `keep` is also the
  // right answer for a participant whose harness never got a session — an
  // untouched worktree is removed and its branch rolled back either way.
  //
  // A release that throws — a locked worktree, a missing git — must not
  // strand the room: the log still closes, `dismiss()` still resolves, and
  // the checkout is left in place rather than committed or deleted. The
  // participant is told, because a dismissed room can never be retried.
  // The line names the path: after a failed add it is the only record.
  //
  // Returns whether it wrote a notice, so the caller never adds a second
  // line about the same checkout.
  const release = async (
    id: string,
    worktree: string | undefined,
    onNotice: Notify,
  ): Promise<boolean> => {
    try {
      const kept = await worktrees?.release(id, "keep");
      if (kept) onNotice(kept);
      return Boolean(kept);
    } catch (err) {
      onNotice(
        `could not release the participant's checkout` +
          `${worktree ? ` at ${worktree}` : ""}: ` +
          `${err instanceof Error ? err.message : String(err)}; ` +
          "the checkout, its branch or both may be left in place",
      );
      return true;
    }
  };

  // The rollback half of the spawn, for an add that failed or met a dismiss.
  // `keep` removes an untouched checkout and its branch, so the room is as it
  // was. One the harness already wrote into is kept, as at dismiss. A
  // participant that never joined has no notices of its own, so both lines
  // go to the room's, which every participant shows.
  const rollback = async (id: string, worktree: string | undefined) => {
    const named = await release(id, worktree, onRoomNotice);
    if (!named && worktrees && worktree && existsSync(worktree)) {
      onRoomNotice(
        `a participant that did not join left its worktree at ${worktree}: ` +
          "its harness wrote into it, so the worktree and its branch are kept",
      );
    }
  };

  // A dismiss waits for every add and remove in flight, so nothing either
  // started outlives `dismiss()`: an add sees the dismiss and rolls itself
  // back, and a remove finishes its release.
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => {
    inflight.add(p);
    const done = () => inflight.delete(p);
    p.then(done, done);
    return p;
  };
  // The adds that have not joined yet. Each holds its name and role, so a
  // second add or a rename cannot take them while the harness starts.
  const pending = new Set<AgentRequest>();
  const dismissed = () =>
    new RoomRefusal("room_dismissed", "the room is dismissed");

  const teardown = () => {
    dismissing ??= (async () => {
      try {
        await Promise.allSettled(inflight);
        await Promise.all(members.map((m) => m.stop()));
        for (const { participant: p, onNotice } of members) {
          await release(p.id, p.worktree, onNotice);
        }
      } finally {
        clearInterval(sweep);
        await eventLog?.close();
      }
    })();
    return dismissing;
  };

  const spawn = async (request: AgentRequest, base: string | undefined) => {
    const id = newParticipantId();
    const own: RoomNotice[] = [];
    const onNotice: Notify = (text, kind) =>
      own.push(kind ? { text, kind } : { text });
    if (notice) onNotice(notice);

    // Taken here rather than in `startParticipant`, so a rollback knows
    // which path to look at.
    let worktree: string | undefined;
    let started: Awaited<ReturnType<typeof startParticipant>>;
    try {
      worktree = worktrees ? await worktrees.acquire(id, base) : cwd;
      started = await startParticipant({
        id,
        roomId,
        permissions,
        request,
        worktree,
        info: worktrees?.info(id),
        bus,
        notices: () => [...roomNotices, ...own],
        stderrLog: eventLog ? join(logDir, `${id}.stderr.log`) : undefined,
        dismissed: () => dismissing !== undefined,
        watchdog,
        limits: watchLimits,
      });
    } catch (err) {
      await rollback(id, worktree);
      throw err instanceof BadBase
        ? new RoomRefusal("invalid_request", err.message)
        : err;
    }
    // A dismiss that began while this harness was starting did not see it.
    if (dismissing) {
      await started.stop();
      await rollback(id, worktree);
      throw dismissed();
    }
    members.push({ ...started, spec: request.spec, onNotice });
    participants.push(started.participant);
    const { role } = request;
    bus.emit({
      agent: id,
      update: {
        sessionUpdate: "_client_participant_added",
        name: request.name,
        ...(role && { role }),
        harness: request.spec.name,
        mode: request.mode,
      },
    });
    return started.participant;
  };

  const start = async (request: AgentRequest) => {
    // Everything up to the first `await` runs at once, so the check and the
    // reservation cannot interleave with another add.
    if (dismissing) throw dismissed();
    const refused = clash([...participants, ...pending], request);
    if (refused) throw refused;
    const { base } = request;
    // Refused, not ignored: the caller asked to start from someone's work,
    // and a shared cwd has no branch to start from.
    if (base !== undefined && !worktrees) {
      throw new RoomRefusal(
        "invalid_request",
        `cannot start from ${JSON.stringify(base)}: ${cwd} is not a git ` +
          "repository with a commit, so no participant has a branch",
      );
    }
    pending.add(request);
    try {
      return await spawn(request, base);
    } finally {
      pending.delete(request);
    }
  };

  const member = (id: string) => {
    const found = members.find((m) => m.participant.id === id);
    if (!found) {
      throw new RoomRefusal("participant_not_found", `no participant ${id}`);
    }
    return found;
  };

  const update = (id: string, changes: ParticipantChanges) => {
    if (dismissing) throw dismissed();
    const found = member(id);
    const p = found.participant;
    const others = participants.filter((o) => o !== p);
    const refused = clash([...others, ...pending], changes);
    if (refused) throw refused;
    if (changes.mode !== undefined) {
      try {
        checkCeiling(found.spec, changes.mode);
      } catch (err) {
        throw new RoomRefusal(
          "invalid_request",
          err instanceof Error ? err.message : String(err),
        );
      }
      // The last check has passed, so the changes apply from here.
      found.setMode(changes.mode);
    }
    if (changes.name !== undefined) p.name = changes.name;
    if (changes.role === null) delete p.role;
    else if (changes.role !== undefined) p.role = changes.role;
    bus.emit({
      agent: id,
      update: { sessionUpdate: "_client_participant_changed", ...changes },
    });
    return p;
  };

  const remove = async (id: string) => {
    if (dismissing) throw dismissed();
    const found = member(id);
    // Off the roster before the first `await`, so its name is free and a
    // second remove is told it is gone.
    members.splice(members.indexOf(found), 1);
    participants.splice(participants.indexOf(found.participant), 1);
    // No `finally` for the release: `stop()` cannot reject. It awaits the
    // harness's exit, which only resolves, and a turn whose handlers only
    // emit on a bus that catches every listener. A step that can reject,
    // added to `stop()`, would strand this checkout with no notice.
    await found.stop();
    // After the stop, so the turn's end and the harness's exit come first
    // and this is the participant's last line.
    bus.emit({
      agent: id,
      update: { sessionUpdate: "_client_participant_removed" },
    });
    // The participant is gone, so a kept checkout is the room's to report.
    await release(id, found.participant.worktree, onRoomNotice);
  };

  const forward = async (targetId: string, fromId: string) => {
    if (dismissing) throw dismissed();
    if (targetId === fromId) {
      throw new RoomRefusal(
        "invalid_request",
        "the target and source are the same participant",
      );
    }
    const found = member(targetId);
    const target = found.participant;
    const source = member(fromId).participant;
    if (target.status() === "busy") {
      throw new RoomRefusal(
        "agent_busy",
        `${target.name} is busy; wait for its turn to end`,
      );
    }
    if (!target.branch) {
      throw new RoomRefusal(
        "no_branch",
        `${target.name} has no branch; its checkout is shared with the ` +
          "repository",
      );
    }
    if (!source.branch) {
      throw new RoomRefusal(
        "no_branch",
        `${source.name} has no branch to move to`,
      );
    }
    const branch = target.branch;
    const sourceBranch = source.branch;
    // The event goes out inside the hold, so a message that queued during
    // the move starts its turn after every observer has seen the move.
    const move = async () => {
      const { sha, moved } = await fastForwardCheckout(
        target.worktree,
        sourceBranch,
        branch,
      );
      if (!moved) return;
      bus.emit({
        agent: target.id,
        update: {
          sessionUpdate: "_client_participant_fast_forwarded",
          from: source.id,
          branch,
          sha,
        },
      });
    };
    try {
      await found.hold(move());
    } catch (err) {
      if (err instanceof DirtyCheckout) {
        throw new RoomRefusal("dirty_worktree", err.message);
      }
      if (err instanceof NotFastForward) {
        throw new RoomRefusal("not_fast_forward", err.message);
      }
      if (err instanceof BadBase) {
        throw new RoomRefusal("invalid_request", err.message);
      }
      throw err;
    }
    return target;
  };

  for (const request of agents) {
    try {
      await track(start(request));
    } catch (err) {
      await teardown();
      throw err;
    }
  }

  return {
    participants,
    eventLog,
    status: () => (dismissing ? "dismissed" : "active"),
    add: (request) => track(start(request)),
    update,
    remove: (id) => track(remove(id)),
    fastForward: (targetId, fromId) => track(forward(targetId, fromId)),
    dismiss: teardown,
  };
}

/** Starts one harness in the participant's checkout and opens its session.
 *  On a throw it has stopped whatever it started; the caller releases the
 *  checkout. */
async function startParticipant({
  id,
  roomId,
  permissions,
  request: { spec, name, role, settings, mode: initialMode },
  worktree,
  info,
  bus,
  notices,
  stderrLog,
  dismissed,
  watchdog,
  limits,
}: {
  id: string;
  roomId: string;
  permissions: PermissionQueue;
  request: AgentRequest;
  /** Its own checkout, or the cwd when there are no worktrees. */
  worktree: string;
  info: { branch: string; baseSha: string } | undefined;
  bus: EventBus;
  /** The room's and the checkout's notices; the participant adds the lines
   *  that depend on its mode. */
  notices: () => readonly RoomNotice[];
  stderrLog: string | undefined;
  dismissed: () => boolean;
  watchdog: Watchdog;
  limits: WatchdogLimits;
}): Promise<{
  participant: Participant;
  stop: () => Promise<void>;
  setMode: (mode: ClientMode) => void;
  hold: <T>(work: Promise<T>) => Promise<T>;
}> {
  if (info) {
    bus.emit({
      agent: id,
      update: {
        sessionUpdate: "_client_worktree_created",
        // Listed, not spread, as `core/run.ts` does: a wider `info` must not
        // shadow `path` (#85).
        path: worktree,
        branch: info.branch,
        baseSha: info.baseSha,
      },
    });
  }

  let exited = false;
  let mode = initialMode;
  // Counts this participant's turns from 1 (S12's `turn`), and the live
  // turn's cancel. A turn that ends for any reason aborts it, which denies
  // what it left open in the queue as `cancel`. Between turns it is already
  // aborted, so a request there is denied, not queued.
  let turns = 0;
  let turnAbort = new AbortController();
  turnAbort.abort();
  // Read live, so a mode change applies to the next request.
  const policy: Policy = (req) =>
    mode === "ask"
      ? permissions.roomPolicy(
          { roomId, participantId: id, turn: turns },
          bus,
          turnAbort.signal,
        )(req)
      : policyFor(mode)(req);
  // `safe` reads nothing outside the checkout, whatever the setting says,
  // as `resolvePolicy` has it for a run.
  const readsOutside = () => mode !== "safe" && settings.allowReadOutsideRoot;
  const agent = new AcpAgent({
    name: spec.name,
    command: spec.launch.command,
    args: spec.launch.args,
    env: resolveEnv(spec.launch.env),
    cwd: worktree,
    policy,
    allowReadOutsideRoot: readsOutside(),
    stderrLog,
    onEvent: ({ update }) => {
      if (update.sessionUpdate === "_client_harness_exited") exited = true;
      // Named by id, not by harness name (S10). Only the harness's own
      // events feed the watchdog, so its warning never resets it.
      const event = { agent: id, update };
      watchdog.note(event);
      bus.emit(event);
    },
  });

  // The lines that name the mode: `warningsFor`'s, and what the last mode
  // send said. A mode change replaces them, so `notices` shows the current
  // mode only (decided 2026-09-29, #194).
  let modeLines: RoomNotice[] = [];

  // The harness's own mode: `safe`'s id, or `ask`'s for the other two
  // (`harnessModeId`). Sent at session start, then before the first turn
  // after a change that moves it, never during a turn. `sent` is the id the
  // harness was last told. A send that failed is tried again before the next
  // turn; a mode with no id is never sent.
  let sent: string | undefined;
  let failure: { modeId: string; why: string } | undefined;
  const unsent = () => {
    const modeId = harnessModeId(spec, mode);
    return modeId !== undefined && modeId !== sent;
  };
  const syncMode = async () => {
    const modeId = harnessModeId(spec, mode);
    if (!modeId) return;
    try {
      await agent.setMode(modeId);
      sent = modeId;
      failure = undefined;
    } catch (err) {
      failure = {
        modeId,
        why: err instanceof Error ? err.message : String(err),
      };
    }
  };
  // What the harness was not told, named by the mode it is in now. No kind:
  // the not-negotiated line is never suppressible (#13).
  const modeSend = (): RoomNotice[] => {
    const modeId = harnessModeId(spec, mode);
    if (!modeId) return [{ text: modeLine(agent.name, mode) }];
    if (failure?.modeId === modeId) {
      return [{ text: modeLine(agent.name, mode, failure) }];
    }
    return [];
  };

  let turn: Promise<void> | undefined;
  /** A fast-forward of this checkout (M6-11a). It counts as busy, so a
   *  message queues behind it rather than start a turn on moving files. */
  let held: Promise<unknown> | undefined;
  let stopping = false;
  const waiting: { text: string; done: () => void }[] = [];

  // Never sent, so each waiting `send` resolves here.
  const drop = () => {
    if (waiting.length === 0) return;
    const dropped = waiting.splice(0);
    bus.emit({
      agent: id,
      update: { sessionUpdate: "_client_queue_cleared", count: dropped.length },
    });
    for (const { done } of dropped) done();
  };

  const begin = (text: string): Promise<void> => {
    turns += 1;
    const controller = new AbortController();
    turnAbort = controller;
    bus.emit({
      agent: id,
      update: { sessionUpdate: "_client_user_message", text, turn: turns },
    });
    const watch = watchdog.watch(id, limits);
    // At once when the harness's mode is current, so a cancel that follows
    // `send` reaches a turn the harness already has. A turn cancelled while
    // its mode was being sent never sends its prompt.
    const prompt = () =>
      controller.signal.aborted
        ? { stopReason: "cancelled" as const }
        : agent.prompt(text);
    turn = (unsent() ? syncMode().then(prompt) : Promise.resolve(prompt()))
      .then(
        ({ stopReason }) => {
          bus.emit({
            agent: id,
            update: { sessionUpdate: "_client_turn_ended", stopReason },
          });
        },
        (err) => {
          bus.emit({
            agent: id,
            update: {
              sessionUpdate: "_client_turn_ended",
              error: err instanceof Error ? err.message : String(err),
            },
          });
        },
      )
      .finally(() => {
        controller.abort();
        watch.close();
        turn = undefined;
        next();
      });
    return turn;
  };

  // A harness that is gone takes its queue with it. The harness reports its
  // exit before the prompt fails (`protocol/agent.ts`).
  const next = () => {
    if (exited || stopping || dismissed()) return drop();
    const queued = waiting.shift();
    if (queued) void begin(queued.text).then(queued.done);
  };

  // The caller has checked the participant is idle, with no await since.
  // The caller gets the work's own result; `held` only marks the time.
  const hold = <T>(work: Promise<T>): Promise<T> => {
    const release = () => {
      held = undefined;
      next();
    };
    held = work.then(release, release);
    return work;
  };

  // The harness answers a cancel within 64 ms on every measured build
  // (§M0-4), and `stop()` closes stdin after it, which ends the turn for one
  // that ignores the cancel.
  const stop = async () => {
    stopping = true;
    drop();
    if (turn) {
      turnAbort.abort();
      agent.cancel();
    }
    await agent.stop();
    await turn;
    await held;
  };

  let version: string | undefined;
  const warn = () => {
    modeLines = warningsFor(spec.name, spec, mode, version).map(
      ({ text, kind }) => (kind ? { text, kind } : { text }),
    );
  };

  let sessionId: string;
  try {
    const init = await agent.start();
    version = init.agentInfo?.version;
    warn();
    sessionId = await agent.newSession();
    await syncMode();
  } catch (err) {
    await agent.stop();
    throw err;
  }

  // The filter follows at once; the harness's own mode before the next turn.
  // A question that waits under `ask` gets the new mode's answer.
  const setMode = (next: ClientMode) => {
    const leftAsk = mode === "ask" && next !== "ask";
    mode = next;
    if (leftAsk) permissions.answerParticipant(roomId, id, next === "auto");
    agent.allowReadOutsideRoot = readsOutside();
    warn();
  };

  const participant: Participant = {
    id,
    name,
    ...(role && { role }),
    harness: spec.name,
    get mode() {
      return mode;
    },
    get settings() {
      return { allowReadOutsideRoot: agent.allowReadOutsideRoot };
    },
    worktree,
    ...(info && { branch: info.branch, baseSha: info.baseSha }),
    sessionId,
    get notices() {
      return [...notices(), ...modeLines, ...modeSend()];
    },
    status: () => {
      if (dismissed()) return "dismissed";
      if (exited) return "exited";
      return turn || held ? "busy" : "idle";
    },
    get queued() {
      return waiting.length;
    },
    send(text) {
      if (dismissed()) {
        throw new RoomRefusal("room_dismissed", "the room is dismissed");
      }
      if (exited || stopping) {
        throw new RoomRefusal("agent_exited", "the agent's harness has exited");
      }
      if (!turn && !held) return begin(text);
      if (waiting.length >= QUEUE_BOUND) {
        throw new RoomRefusal(
          "queue_full",
          `${QUEUE_BOUND} messages already wait for this agent; ` +
            "wait for a turn to end, or cancel the turn to drop them",
        );
      }
      bus.emit({
        agent: id,
        update: { sessionUpdate: "_client_message_queued", text },
      });
      return new Promise<void>((done) => waiting.push({ text, done }));
    },
    cancel() {
      if (!turn) return false;
      drop();
      // Before the harness hears of the cancel, so the request it waits on
      // is answered at once.
      turnAbort.abort();
      agent.cancel();
      return true;
    },
  };
  return { participant, stop, setMode, hold };
}
