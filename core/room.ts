/**
 * A chat room — a container with a roster of participants (M6-2).
 *
 * **The room owns each harness's lifetime.** A run spawns a harness, sends one
 * prompt and stops it (`core/run.ts`). A room spawns a participant's harness
 * once, sends a prompt per message, and stops it when the room is dismissed
 * or paused. Measured safe on all four harnesses: a prompt sent after
 * `end_turn` completes on the same session with the first turn's context kept
 * (`docs/FINDINGS.md` §Multi-turn). A prompt *during* a live turn is still
 * refused, here as `busy` and below as `AcpAgent`'s in-flight guard (#62 R5).
 *
 * **A real session reports its models and login state** (M9-4) to
 * `noteSession`, from the `session/new` or `session/load` response and an
 * auth notice. A load gives a login state only for an agent whose load needs
 * one (M9-4b). The room never waits for the notice.
 *
 * **A daemon shutdown is a pause, not a dismiss** (M6-7a, R42c). `pause`
 * cancels each live turn, waits `pauseGraceMs` (2 s, §M0-4) for it to end,
 * stops each harness and keeps every checkout as it is: nothing is released.
 * A participant whose turn ended reads `paused`; one whose cancel outlived
 * the grace reads `killed`, because its memory may not match its files
 * (R46). A harness that dies by itself reads `killed` during a turn and
 * `exited` when idle.
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
 *
 * **A stopped participant revives on its next message.** `paused`, `killed`
 * and `exited` all take the same path: a new harness in the same checkout.
 * It loads the old session when the harness advertises `loadSession` and
 * the registry records a working load (`measured.loads`, M6-7b); the load's
 * replay never reaches the bus. Otherwise, or when the load fails, it opens
 * a fresh session and does not remember earlier turns (Half A). The log gets
 * `_client_participant_revived` and the participant reads `resumed:
 * "loaded"` or `"fresh"`. The mode is sent again either way: a load does not
 * keep it (§Mode after load). A dismissed room never revives.
 *
 * **A load can remember less than the files show** (§M0-9). That happened
 * only to a harness stopped during a turn, cancelled or cut: the cut turn
 * stays in the history it replays. So a load after `killed`, or after any
 * cancel before its prompt settled since the last revive (a person's, or a
 * pause's), says so with `memoryMayBeBehind`. A settled prompt whose checkout
 * read is still running is not a live harness turn, so a cancel or pause in
 * that window records no cut. Such a participant can read `idle` or
 * `paused`; `room.json` keeps the cancel as `turnCancelled`, which only the
 * next revive reads and clears (decided 2026-10-08, #179; the person's
 * cancel added in #238). So the flag is about the last revive, not about
 * the session's whole history.
 *
 * **One checkout per participant** (M6-6a, R14). Each one runs in
 * `stateDirFor(root)/wt/<roomId>/<participantId>`, on the branch
 * `kapelle/<roomId>/<participantId>`, so turns run in parallel without
 * touching each other's files (R6). Nothing is shared or inherited. `add`
 * takes the base to fork from: any ref, including another participant's
 * branch (R35c). A branch holds only what its participant committed, so a
 * participant started from it never sees the other's uncommitted files (R37).
 *
 * **A kept checkout lasts while its room has a record.** The boot sweep
 * (`core/sweep.ts`) keeps every checkout under a room that has a
 * `room.json`, dismissed rooms too, until `DELETE /rooms/:id` or the
 * sweep's retention reap removes the room (`removeRoom`, #235).
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
 * **A harness may rename its branch or rebase it (M6-6a).** After every turn
 * the room reads the checkout again (`checkoutIdentity`): the branch `HEAD`
 * names, and the commit the branch's own reflog says its latest rebase moved
 * it onto. A rename updates the participant, the held checkout and
 * `room.json`; a client that shows the branch reads the room again when the
 * turn ends. A rebase also moves the participant's saved `baseSha`. The
 * whole-branch diff independently finds the current merge base from the
 * configured base ref, so it does not depend on this reflog read. A restore
 * reads the checkout once too, because a crash can leave `room.json` older
 * than the branch.
 *
 * **A message names its participant, and a busy one queues it** (M6-4).
 * `send` starts a turn, or puts the message in a FIFO queue behind the live
 * one (R32a); 16 wait at most, and the next is refused `queue_full` (R41).
 * The queue is in memory only, so a daemon restart loses it. `cancel` drops
 * the queue, then cancels the live turn; the session stays (S5a). A dropped
 * message is never sent, and `_client_queue_cleared` says how many. A
 * message may name the participant that sent it (M8-1); the harness then
 * reads `[from <name>]` first, and the log records the sender's id.
 *
 * **The orchestrator has a room-scoped turn cap** (M8-7). Each accepted
 * worker message from it counts, whether the message starts or queues. At the
 * cap the next one is refused `turn_cap` and logs
 * `_client_turn_cap_reached`; a person's messages and daemon replies do not
 * count. `room.json` keeps the cap and count across a restart, and the person
 * can only raise the cap.
 *
 * **A turn's answer goes back to its sender** (M8-2). When a turn from a
 * participant's message ends, its sender gets a reply: `[reply from <name>]`,
 * how the turn ended and its tool calls, then the answer. When the person
 * messaged a worker the orchestrator gave an order to (`orderedBy`, #333),
 * the orchestrator gets a copy instead: `[copy] you →
 * <name>`, the same status, the message, then the answer. The answer is the
 * text after the last tool call, or the last text before it when that is
 * empty, each cut at `ANSWER_CAP` bytes; the person's message is sent whole.
 * It is kept from the prompt's send to the turn's end, and dropped at a
 * cancel or the harness's exit. A cancelled turn replies with its first line
 * only, and that line says `cancelled by the person`: only the person
 * cancels a turn that replies (#377). An error turn, an exit included,
 * replies with the error in place of the answer. The answer is taken before
 * the checkout read that ends a turn, so a cancel during that read does not
 * cut it. A reply and a copy carry `kind`, skip `QUEUE_BOUND`, and their own
 * turns send nothing, so a loop cannot start. A stop (remove, dismiss or
 * pause) sends nothing either; a reply to a sender no longer on the roster
 * is dropped, and the daemon's stderr says so.
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
 * **A participant may ask for a model** (M9-5). The room sets the session's
 * option with `category: "model"` after every start, a load too, right after
 * the mode, so before the first turn. Whether a load keeps the model was not
 * measured; sending it again makes that not matter (decided 2026-10-29). A
 * refused model, or a harness with no model option, never fails the add or
 * the revive: the harness stays on the model it had, and a notice says so
 * (decided 2026-10-29). `model` on the participant is the one in use.
 *
 * **The person may change the model during a chat** (M9-6). `setModel` sends
 * it at once to an idle harness, and before the next turn to a busy one,
 * never during a turn (decided 2026-10-30, #301). It is the same set and the
 * same reply as at a start, so no new measurement backs it. Only a model the
 * harness took becomes the one a revive asks for: a refused one is not sent
 * again. A participant with no harness gets it at its next start. The reply
 * changes only the model in use: `models`, the live list, stays as the
 * session sent it, since copilot's reply leaves an option out (§Models and
 * login). `_client_participant_changed` then carries the model in use, or
 * `null` when the harness names none. `room.json` keeps a change not yet
 * sent, so a pause or a restart does not drop it (#398 review). A
 * pending change refused at a start leaves the last model the harness took,
 * not the session's own: that one is set again first.
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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { AcpAgent, type Policy, RpcError } from "../protocol/agent.ts";
import {
  type ClientMode,
  type ResolvedAgent,
  resolveAgent,
  resolveEnv,
  type Warning,
  warningsFor,
} from "../protocol/registry.ts";
import type { AgentEvent, MessageKind } from "../protocol/types.ts";
import {
  failureSeen,
  modelsOf,
  noticeSeen,
  type Seen,
  sessionSeen,
} from "./check.ts";
import {
  createEventLog,
  type EventLog,
  openEventLog,
  reopenEventLog,
} from "./eventlog.ts";
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
  checkoutIdentity,
  DirtyCheckout,
  fastForwardCheckout,
  LinkPathError,
  NotFastForward,
  type WorktreeSetup,
  type Worktrees,
} from "./worktree.ts";

/** How many messages may wait behind a participant's live turn (R41). */
export const QUEUE_BOUND = 16;

/** How many worker messages a room's orchestrator may send by default (M8-7). */
const DEFAULT_ORCHESTRATOR_TURN_CAP = 40;

/** A refusal the daemon answers with its own error code. Any other throw
 *  from `add`, `update` or `remove` is a failure, not a refusal. */
export class RoomRefusal extends Error {
  readonly code:
    | "invalid_request"
    | "invalid_config"
    | "name_taken"
    | "orchestrator_exists"
    | "participant_not_found"
    | "room_dismissed"
    | "agent_exited"
    | "agent_busy"
    | "not_fast_forward"
    | "dirty_worktree"
    | "no_branch"
    | "queue_full"
    | "turn_cap";
  constructor(code: RoomRefusal["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** `paused` from a daemon shutdown until the first revive or add. A room
 *  whose participant has exited still reads `active` (R33). */
type RoomStatus = "active" | "paused" | "dismissed";

/** `exited`: the harness died while idle. `killed`: it stopped during a turn
 *  without a clean end (R46). `paused`: a shutdown stopped it cleanly. All
 *  three revive on the next message. */
type ParticipantStatus =
  | "idle"
  | "busy"
  | "exited"
  | "paused"
  | "killed"
  | "dismissed";

/** R44's closed set. A label only: it sends no text to the harness. */
const ROLES = [
  "orchestrator",
  "developer",
  "tester",
  "architect",
  "reviewer",
] as const;
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
  /** What the request named, kept so a restored room resolves it again. */
  source: { agent: string } | { cmd: string };
  name: string;
  role?: Role;
  /** The ref to fork from, such as another participant's `branch`; the
   *  repository's HEAD when absent. */
  base?: string;
  mode: ClientMode;
  settings: Settings;
  /** The model to set after each start; the harness's own when absent. */
  model?: string;
}

/** What `PATCH` may change. A `null` role clears it. `model` goes to
 *  `Room.setModel`, the rest to `Room.update`. */
export interface ParticipantChanges {
  name?: string;
  role?: Role | null;
  mode?: ClientMode;
  model?: string;
}

/** Who sent a message, when a participant did (M8-1). */
type Sender = Pick<Participant, "id" | "name">;

/** How much of each answer block a turn keeps for its reply (M8-2), in
 *  UTF-8 bytes. A cut never splits a character. */
const ANSWER_CAP = 64 * 1024;

/** The longest start of `text` that fits in `bytes` of UTF-8. A streaming
 *  decode holds back a character the cut would split. */
const fitBytes = (text: string, bytes: number) =>
  new TextDecoder().decode(Buffer.from(text).subarray(0, bytes), {
    stream: true,
  });

/** A turn that ended, as its reply or copy needs it (M8-2). */
interface Answer {
  /** The message the turn started from, and its sender. */
  text: string;
  from?: Sender;
  /** The stop reason, `cancelled by the person`, `cancelled`, or `error`. */
  end: string;
  calls: number;
  /** The answer, the error, or empty after a cancel or an exit. */
  body: string;
  cut: boolean;
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
  /** The checkout's branch, as the last turn read it; a harness rename
   *  moves it by the time the turn's end is out. */
  readonly branch?: string;
  /** The commit the branch's work starts from. A rebase moves it: the room
   *  reads the branch's own reflog after a turn. */
  readonly baseSha?: string;
  /** The configured ref the whole-branch diff re-resolves. Absent on an old
   *  record, whose saved SHA is the fallback. Never part of the public DTO. */
  readonly baseRef?: string;
  /** The session a revive loads (R17). A fresh revive changes it. */
  readonly sessionId: string;
  /** How the last revive came back; absent before the first. */
  readonly resumed?: "loaded" | "fresh";
  /** The model in use, as the harness last said; absent when it lists
   *  none, or before its first start. */
  readonly model?: string;
  /** The live session's models (M9-6); absent with no harness, or when it
   *  lists none. A set's reply never changes them. */
  readonly models?: readonly { id: string; name: string }[];
  /** The room's notices, then this participant's containment and worktree
   *  notices. #13's lines are never dropped, and a room has no terminal of
   *  its own, so the caller publishes them. */
  readonly notices: readonly RoomNotice[];
  status(): ParticipantStatus;
  /** Messages waiting behind the live turn. */
  readonly queued: number;
  /** The id of the participant whose message the live turn runs (M8-3).
   *  None when the person sent it, or when no turn runs. */
  readonly turnFrom?: string;
  /** The id of the last participant whose order started one of its turns:
   *  a message with `from` and no `kind`. The orchestrator gets a copy of the person's
   *  message to it only when that is the orchestrator's id (#333). */
  readonly orderedBy?: string;
  /**
   * Starts a turn with this message, or queues it behind the live one.
   * Resolves when its turn ends, or when it is dropped from the queue.
   * Refuses with a `RoomRefusal` — before any byte reaches the harness — once
   * the room is dismissed or the harness is gone, and when `QUEUE_BOUND`
   * messages already wait. A turn that fails is not a rejection: it ends with
   * `_client_turn_ended` carrying `error`, which is how every client learns
   * of it.
   *
   * `from` is the participant that sent it; none means the person (M8-1).
   * Its harness then gets `[from <name>]` as an extra first line, with the
   * name as it is now; the log keeps `text` without it. The caller checks
   * who may send.
   *
   * `kind` is only the room's own: a reply or a copy (M8-2). It replaces
   * the `[from <name>]` line, and `QUEUE_BOUND` does not apply to it.
   */
  send(text: string, from?: Sender, kind?: MessageKind): Promise<void>;
  /** Drops the queue, then asks the harness to end the live prompt. The
   *  session stays (S5a). False when no prompt is live: before it starts, or
   *  after it has settled even if the checkout read still runs. */
  cancel(): boolean;
}

/** What the daemon shows about a room beyond its roster. The room saves it
 *  in `room.json`, and the daemon reads it from `Room.meta`. */
export interface RoomMeta {
  id: string;
  cwd: string;
  title?: string;
  createdAt: string;
  /** Moves on a message, a dismiss, a roster change, or a rename
   *  (`Room.touch`). */
  updatedAt: string;
  /** The room's worker-message limit, and how many the orchestrator sent. */
  turnCap: number;
  turnCount: number;
}

/** One participant in `room.json`. */
interface ParticipantRecord {
  id: string;
  name: string;
  role?: Role;
  /** One of the two, as `AgentRequest.source`. */
  agent?: string;
  cmd?: string;
  harness: string;
  mode: ClientMode;
  settings: Settings;
  /** The model asked for, sent again at each revive; not the one in use. */
  model?: string;
  /** A change the harness has not heard of yet (M9-6): the next start
   *  sends it, also after a pause or a daemon restart. */
  pendingModel?: string;
  worktree: string;
  /** The branch and base the checkout had at the last save. A restore
   *  reconciles both with the checkout again, in case a crash caught a
   *  rename or a rebase mid-turn. */
  branch?: string;
  baseSha?: string;
  /** The configured base ref, kept for topology-derived diffs after restart. */
  baseRef?: string;
  /** True when `branch` is a name the harness renamed into, proven by the
   *  branch's own reflog. Absent means a switch to a name this room did not
   *  create, so a delete leaves it alone. */
  branchRenamed?: true;
  sessionId: string;
  /** Its turns so far, so a restored one goes on counting (S12's `turn`). */
  turns?: number;
  /** As `Participant.orderedBy`, so a restored room still sends copies. */
  orderedBy?: string;
  status: ParticipantStatus;
  /** Its own notices: the worktree's and the sweep's, not the mode lines,
   *  which are worked out again. */
  notices: RoomNotice[];
  resumed?: "loaded" | "fresh";
  /** A live turn was cancelled since the last revive, so a load may
   *  remember less than the files show. Never on the DTO; the next revive
   *  clears it. */
  turnCancelled?: true;
}

/** `room.json`: the room, its own notices and every participant. Records
 *  from before M8-7 have no cap fields; restore supplies their defaults. */
export interface RoomRecord extends Omit<RoomMeta, "turnCap" | "turnCount"> {
  turnCap?: number;
  turnCount?: number;
  status: RoomStatus;
  notices: RoomNotice[];
  participants: ParticipantRecord[];
  /** Participants whose saved harness no longer resolves. They are not in
   *  the active roster, but their branch and worktree stay known to delete. */
  tombstones?: ParticipantRecord[];
}

export interface Room {
  readonly meta: RoomMeta;
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
  update(id: string, changes: Omit<ParticipantChanges, "model">): Participant;
  /** Asks the participant's harness for another model (M9-6): now when it
   *  is idle, and before its next turn when it is busy. Resolves once an
   *  idle harness answered; a refusal is a notice, not a throw. */
  setModel(id: string, model: string): Promise<Participant>;
  /** Gives the room a new title. `touch` saves it. The stream gets no
   *  line: a client reads the title from `GET /rooms`. */
  retitle(title: string): void;
  /** Sends an orchestrator's worker message, or refuses it at the room cap.
   *  An accepted message counts once, whether it starts or waits. */
  send(id: string, text: string, from: Sender): Promise<void>;
  /** Raises the room's cap. `touch` saves it. */
  raiseTurnCap(turnCap: number): void;
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
  /** A daemon shutdown (R42c): cancels each live turn, stops every harness,
   *  keeps every checkout, saves the room `paused` and closes the log. No
   *  call works on the room after it. A dismissed room stays dismissed. */
  pause(): Promise<void>;
  /** Moves `meta.updatedAt` to now and saves the room. */
  touch(): void;
  /** For a dismissed room nobody was handed: stops every save, a queued
   *  one too, and removes the room's folder, its record and log included. */
  forget(): void;
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
  "model",
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
  const { agent, cmd, name, role, mode, base, settings, model } =
    entry as Record<string, unknown>;
  const spec = roomHarness(agent, cmd);
  const request: AgentRequest = {
    spec,
    // `cmd` wins when both are given, as `resolveAgent` has it.
    source: cmd ? { cmd: cmd as string } : { agent: agent as string },
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
  // Any id: the harness checks it, not a list of ours (D3).
  if (model !== undefined) {
    if (typeof model !== "string" || !model.trim()) {
      throw new Error('"model" must be a non-empty string');
    }
    request.model = model;
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
  const { name, mode, role, model } = body;
  if (
    name === undefined &&
    mode === undefined &&
    role === undefined &&
    model === undefined
  ) {
    throw new Error('send at least one of "name", "mode", "role" or "model"');
  }
  const changes: ParticipantChanges = {};
  if (mode !== undefined) changes.mode = checkMode(mode);
  if (name !== undefined) changes.name = checkName(name);
  if (role !== undefined) changes.role = role === null ? null : checkRole(role);
  // As at add: any id, which the harness checks (D3).
  if (model !== undefined) {
    if (typeof model !== "string" || !model.trim()) {
      throw new Error('"model" must be a non-empty string');
    }
    changes.model = model;
  }
  return changes;
}

/** What `openRoom` and `restoreRoom` both take. */
interface RoomDeps {
  /** The preflight the caller already ran (`openWorktrees`). */
  setup: WorktreeSetup;
  bus: EventBus;
  /** Where an `ask` participant's requests wait for a person. */
  permissions: PermissionQueue;
  /** The watchdog's warn limits; `WATCHDOG_DEFAULTS` when absent. There is
   *  no TTL in a room (R38). */
  limits?: Pick<WatchdogLimits, "stallIdleMs" | "stallRepeatCount">;
  /** A new room's cap, or an old record's fallback. A saved cap wins. */
  turnCap?: number;
  /** How long `pause` waits for a cancelled turn to end. */
  pauseGraceMs?: number;
  /** A line to put in the room's own notices, such as the restore fallback
   *  when the project's `linkPaths` cannot be used. */
  roomNotice?: string;
  /** The daemon's own log, for what no client is told: a dropped reply. */
  log?: (line: string) => void;
  /** Gets what each real session of a registry agent said: its models and
   *  its login state (M9-4, `core/check.ts`). The daemon saves it. */
  noteSession?: (agent: string, seen: Seen) => void;
}

export interface RoomOptions extends RoomDeps {
  roomId: string;
  /** The folder the room was asked for; the harness runs here when there is
   *  no worktree, and at the same subdirectory inside one when there is. */
  cwd: string;
  title?: string;
  /** From `roomAgents`, added in this order. */
  agents: AgentRequest[];
}

/** §M0-4: every measured harness ends a cancelled turn within 64 ms, so a
 *  turn still live after 2 s is not going to end by itself. */
const PAUSE_GRACE_MS = 2_000;

type Notify = (text: string, kind?: Warning["kind"]) => void;

/** One participant, and what the room needs to end and save it. */
interface Member {
  participant: Participant;
  spec: ResolvedAgent;
  source: AgentRequest["source"];
  /** The model a revive asks for, which `room.json` keeps: the request's,
   *  or the last one the person changed to that the harness took. */
  asked: () => string | undefined;
  /** A change not yet sent, which `room.json` keeps too. */
  pending: () => string | undefined;
  /** Its own notices, which `room.json` keeps. */
  own: RoomNotice[];
  stop: () => Promise<void>;
  pause: (graceMs: number) => Promise<void>;
  launch: () => Promise<unknown>;
  turns: () => number;
  turnCancelled: () => boolean;
  setMode: (mode: ClientMode) => void;
  setModel: (model: string) => Promise<void>;
  hold: <T>(work: Promise<T>) => Promise<T>;
  onNotice: Notify;
  /** True when `branch` is a name the harness renamed into, proven by the
   *  branch's own reflog. */
  renamed: () => boolean;
  /** Re-reads the checkout after a turn, or once when a record is restored.
   *  Updates this member and the held checkout; true when the branch or the
   *  rebase base changed. */
  syncCheckout: () => Promise<boolean>;
}

/** Where a room's record and log live. */
const roomDir = (root: string, roomId: string) =>
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
  const tmp = `${path}.${process.pid}.tmp`;
  const { tombstones, ...rest } = record;
  const written = tombstones?.length ? { ...rest, tombstones } : rest;
  // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
  // pi-lens-ignore: no-raw-json-store-write
  writeFileSync(tmp, `${JSON.stringify(written, null, 2)}\n`, "utf8");
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
  const participants = r.participants as Record<string, unknown>[];
  const tombstones = (r.tombstones ?? []) as Record<string, unknown>[];
  for (const [where, records] of [
    ["participants", participants],
    ["tombstones", tombstones],
  ] as const) {
    for (const p of records) {
      for (const key of ["id", "name", "harness", "worktree", "sessionId"]) {
        if (typeof p?.[key] !== "string") {
          throw bad(
            `the ${where} list: a participant's "${key}" is not a string`,
          );
        }
      }
      if (typeof p.agent !== "string" && typeof p.cmd !== "string") {
        throw bad(
          `the ${where} list: participant ${p.id} names no "agent" or "cmd"`,
        );
      }
      if (!MODES.includes(p.mode as ClientMode)) {
        throw bad(
          `the ${where} list: participant ${p.id} has mode ${JSON.stringify(p.mode)}`,
        );
      }
      if (!PARTICIPANT_STATUSES.includes(p.status as ParticipantStatus)) {
        throw bad(
          `the ${where} list: participant ${p.id} has status ${JSON.stringify(p.status)}`,
        );
      }
      // The contract's set is closed (R44): a client may trust it.
      if (p.role !== undefined && !ROLES.includes(p.role as Role)) {
        throw bad(
          `the ${where} list: participant ${p.id} has role ${JSON.stringify(p.role)}`,
        );
      }
    }
  }
  const normalise = (p: Record<string, unknown>): ParticipantRecord => {
    // SAFETY: the checks above cover every required ParticipantRecord field.
    const saved = p as unknown as ParticipantRecord;
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
        typeof saved.model === "string" && saved.model
          ? saved.model
          : undefined,
      pendingModel:
        typeof saved.pendingModel === "string" && saved.pendingModel
          ? saved.pendingModel
          : undefined,
    };
  };
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
    participants: participants.map(normalise),
    tombstones: tombstones.map(normalise),
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
  const crashedStatus = (p: ParticipantRecord): ParticipantStatus => {
    if (p.status === "busy") return "killed";
    if (p.status === "idle") return "paused";
    return p.status;
  };
  return {
    ...record,
    status: "paused",
    participants: record.participants.map((p) =>
      p.status === "busy" || p.status === "idle"
        ? { ...p, status: crashedStatus(p) }
        : p,
    ),
  };
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

/** Hold a tombstone's checkout, so a dismiss can release it like a member. */
function adoptTombstone(
  worktrees: Worktrees | null,
  saved: ParticipantRecord,
): void {
  if (
    !worktrees ||
    !saved.branch ||
    !saved.baseSha ||
    !existsSync(saved.worktree)
  ) {
    return;
  }
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
async function tombstoneUnknownAgents(
  record: RoomRecord,
  root: string,
  log: (line: string) => void,
  worktrees: Worktrees | null,
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
    adoptTombstone(worktrees, next);
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

/** Opens a room and resolves once every participant's harness has a
 *  session. A harness that cannot start is a throw, never a dead
 *  participant (S13). Nothing is saved for a room that did not open. */
export async function openRoom({
  roomId,
  cwd,
  title,
  agents,
  turnCap,
  ...deps
}: RoomOptions): Promise<Room> {
  const now = new Date().toISOString();
  const meta: RoomMeta = {
    id: roomId,
    cwd,
    createdAt: now,
    updatedAt: now,
    turnCap: turnCap ?? DEFAULT_ORCHESTRATOR_TURN_CAP,
    turnCount: 0,
  };
  if (title !== undefined) meta.title = title;
  const built = await buildRoom(deps, meta);
  for (const request of agents) {
    try {
      await built.room.add(request);
    } catch (err) {
      await built.room.dismiss();
      throw err;
    }
  }
  built.keepSaved();
  return built.room;
}

/**
 * The room a `room.json` names, as an earlier daemon left it (M6-7a). No
 * harness starts: each participant waits, `paused`, `killed` or `exited`,
 * for its next message. Each checkout is held again, never created. The log
 * is reopened for appending, with `seq` carried on, or read only for a
 * dismissed room. A participant whose harness no longer resolves becomes a
 * tombstone; another failure throws.
 */
export async function restoreRoom({
  record,
  turnCap,
  ...deps
}: RoomDeps & { record: RoomRecord }): Promise<Room> {
  const { record: from, tombstoned } = await tombstoneUnknownAgents(
    crashed(record),
    deps.setup.root,
    deps.log ?? ((line) => console.error(line)),
    deps.setup.worktrees,
  );
  const meta: RoomMeta = {
    id: from.id,
    cwd: from.cwd,
    createdAt: from.createdAt,
    updatedAt: from.updatedAt,
    turnCap: from.turnCap ?? turnCap ?? DEFAULT_ORCHESTRATOR_TURN_CAP,
    turnCount: from.turnCount ?? 0,
  };
  if (from.title !== undefined) meta.title = from.title;
  const built = await buildRoom(deps, meta, from, tombstoned);
  built.keepSaved();
  return built.room;
}

/** The room both entries build: empty for `openRoom`, or the roster of
 *  `from` for `restoreRoom`. Nothing is saved until `keepSaved`. */
async function buildRoom(
  {
    setup,
    bus,
    permissions,
    limits = WATCHDOG_DEFAULTS,
    pauseGraceMs = PAUSE_GRACE_MS,
    roomNotice,
    log = (line) => console.error(line),
    noteSession,
  }: RoomDeps,
  meta: RoomMeta,
  from?: RoomRecord,
  tombstoned: readonly ParticipantRecord[] = [],
): Promise<{ room: Room; keepSaved: () => void }> {
  const { worktrees, notice, root } = setup;
  const roomId = meta.id;
  const { cwd } = meta;
  // The room's own lines: only the event log's today. With no participant
  // nothing publishes them, and a log failure shows only as `no_event_log`
  // on `GET /rooms/:id/events`. A room has no notices on the wire, so every
  // participant shows them before its own.
  const roomNotices: RoomNotice[] = from ? [...from.notices] : [];
  if (
    roomNotice !== undefined &&
    !roomNotices.some((n) => n.text === roomNotice)
  ) {
    roomNotices.push({ text: roomNotice });
  }
  const onRoomNotice: Notify = (text, kind) =>
    roomNotices.push(kind ? { text, kind } : { text });

  // #129: a room asks nothing of the operator's repository either — its log
  // and stderr live in the same workspace as a run's, outside the checkout.
  const logDir = roomDir(root, roomId);
  const logPath = join(logDir, "events.jsonl");
  let eventLog: EventLog | undefined;
  try {
    mkdirSync(logDir, { recursive: true });
    const onError = (err: Error) =>
      onRoomNotice(`cannot write event log: ${err.message}`);
    if (from?.status === "dismissed") {
      // Read only: nothing writes to a dismissed room, and its stream ends
      // once it has replayed, as a live dismiss ends it.
      eventLog = await openEventLog(logPath);
    } else {
      const log = from
        ? await reopenEventLog(logPath, onError)
        : createEventLog(logPath, onError);
      eventLog = log;
      // The bus's `agent` is the participant id (S10).
      bus.addListener(({ agent, update }) =>
        log.append({ roomId, participantId: agent, update }),
      );
    }
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
    onResolve: (id) =>
      bus.emit({
        agent: id,
        update: { sessionUpdate: "_client_repeat_resolved" },
      }),
    onTimeout: () => {},
  });
  const sweep = setInterval(
    () => watchdog.sweep(),
    sweepIntervalMs([watchLimits]),
  );
  // It watches harnesses that already keep the loop alive.
  sweep.unref();

  let dismissing: Promise<void> | undefined =
    from?.status === "dismissed" ? Promise.resolve() : undefined;
  let pausing: Promise<void> | undefined;
  /** `paused` until the first revive or add. */
  let paused = from?.status === "paused";
  const members: Member[] = [];
  const participants: Participant[] = [];

  // --- room.json ---------------------------------------------------------
  let saving = false;
  let saveFailed = false;
  const recordOf = (m: Member): ParticipantRecord => {
    const p = m.participant;
    const asked = m.asked();
    const pending = m.pending();
    return {
      id: p.id,
      name: p.name,
      ...(p.role && { role: p.role }),
      ...m.source,
      harness: p.harness,
      mode: p.mode,
      settings: { allowReadOutsideRoot: p.settings.allowReadOutsideRoot },
      ...(asked && { model: asked }),
      ...(pending && { pendingModel: pending }),
      worktree: p.worktree,
      ...(p.branch && { branch: p.branch }),
      ...(p.baseSha && { baseSha: p.baseSha }),
      ...(p.baseRef && { baseRef: p.baseRef }),
      ...(m.renamed() && { branchRenamed: true }),
      sessionId: p.sessionId,
      turns: m.turns(),
      ...(p.orderedBy && { orderedBy: p.orderedBy }),
      status: p.status(),
      notices: [...m.own],
      ...(p.resumed && { resumed: p.resumed }),
      ...(m.turnCancelled() && { turnCancelled: true }),
    };
  };
  const status = (): RoomStatus => {
    if (dismissing) return "dismissed";
    if (paused) return "paused";
    return "active";
  };
  const save = () => {
    if (!saving) return;
    try {
      writeRoomRecord(join(logDir, "room.json"), {
        ...meta,
        status: status(),
        notices: [...roomNotices],
        participants: members.map(recordOf),
        tombstones: [...(from?.tombstones ?? [])],
      });
    } catch (err) {
      // Once: a full disk would add the same line on every turn.
      if (saveFailed) return;
      saveFailed = true;
      onRoomNotice(
        `cannot save the room record in ${logDir}: ` +
          `${err instanceof Error ? err.message : String(err)}; ` +
          "a daemon restart brings this room back as it was at its last " +
          "save, or not at all when it has none, and then the boot removes " +
          "its participants' clean checkouts (their branches stay)",
      );
    }
  };
  // A moment after the event, not at it: a turn's state is set just after
  // its line goes out, and one save covers a burst of lines.
  let saveQueued = false;
  const saveSoon = () => {
    if (saveQueued || !saving) return;
    saveQueued = true;
    setImmediate(() => {
      saveQueued = false;
      save();
    });
  };
  const SAVED_ON = new Set([
    "_client_participant_added",
    "_client_participant_changed",
    "_client_participant_removed",
    "_client_participant_revived",
    "_client_user_message",
    "_client_turn_ended",
    "_client_harness_exited",
  ]);
  bus.addListener(({ update }) => {
    if (SAVED_ON.has(update.sessionUpdate)) saveSoon();
  });

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
  /** Any call after a pause: the daemon is going down. */
  const ended = () => dismissing !== undefined || pausing !== undefined;

  const teardown = () => {
    // A paused room is the daemon's last act; a dismiss then has nothing
    // left to stop, and the record must stay `paused`.
    if (pausing) return pausing;
    dismissing ??= (async () => {
      try {
        await Promise.allSettled(inflight);
        await Promise.all(members.map((m) => m.stop()));
        for (const { participant: p, onNotice } of members) {
          await release(p.id, p.worktree, onNotice);
        }
        for (const saved of from?.tombstones ?? []) {
          await release(saved.id, saved.worktree, onRoomNotice);
        }
      } finally {
        clearInterval(sweep);
        save();
        await eventLog?.close();
      }
    })();
    return dismissing;
  };

  const pause = () => {
    if (dismissing) return dismissing;
    pausing ??= (async () => {
      try {
        await Promise.allSettled(inflight);
        // In parallel, as a dismiss is (S6): the bound is one grace, not N.
        await Promise.all(members.map((m) => m.pause(pauseGraceMs)));
        paused = true;
      } finally {
        clearInterval(sweep);
        save();
        await eventLog?.close();
      }
    })();
    return pausing;
  };

  /** A stderr log per harness start, as `AcpAgent` opens them with `ax`: a
   *  revive must not write into the first harness's file. */
  let starts = 0;
  const stderrFor = (id: string) => () => {
    if (!eventLog) return undefined;
    const first = join(logDir, `${id}.stderr.log`);
    // The time tells two daemons apart; the count, two starts in one
    // millisecond.
    starts += 1;
    return existsSync(first)
      ? join(logDir, `${id}.${Date.now()}-${starts}.stderr.log`)
      : first;
  };

  // M8-2: a turn that ended sends its answer on. A message from a
  // participant gets a reply to it; a person's message to a worker, a copy
  // to the orchestrator. Looked up now, so a rename or a role change during
  // the turn counts.
  const answer = (worker: Participant, a: Answer) => {
    // A pause stops its members only after the adds and removes in flight;
    // a turn that ends in between must not send either (#295).
    if (ended()) return;
    const s = a.calls === 1 ? "" : "s";
    const status =
      `${a.end}, ${a.calls} tool call${s}` +
      (a.cut ? `, cut at ${ANSWER_CAP / 1024} KiB` : "");
    const as = { id: worker.id, name: worker.name };
    let target: Participant | undefined;
    let text: string;
    let kind: MessageKind;
    if (a.from) {
      const sender = a.from;
      target = participants.find((p) => p.id === sender.id);
      if (!target) {
        log(
          `room ${roomId}: the reply from ${worker.name} to ${sender.name} ` +
            `was dropped: ${sender.name} has left the room`,
        );
        return;
      }
      kind = "reply";
      text = `[reply from ${worker.name}] ${status}`;
      if (a.body) text += `\n${a.body}`;
    } else {
      // Only for a worker the orchestrator gave work to (#333): a room
      // with no loop wakes nobody.
      target = participants.find((p) => p.role === "orchestrator");
      if (!target || target === worker || worker.orderedBy !== target.id) {
        return;
      }
      kind = "copy";
      text = `[copy] you → ${worker.name} · ${status}\n${a.text}`;
      if (a.body) text += `\n\n[answer]\n${a.body}`;
    }
    try {
      void target.send(text, as, kind);
    } catch (err) {
      log(
        `room ${roomId}: the ${kind} from ${worker.name} to ${target.name} ` +
          `was dropped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const makeMember = (
    request: AgentRequest,
    id: string,
    worktree: string,
    info: { branch: string; baseSha: string; baseRef?: string } | undefined,
    own: RoomNotice[],
    saved?: ParticipantRecord,
  ): Member => {
    const onNotice: Notify = (text, kind) =>
      own.push(kind ? { text, kind } : { text });
    const made = createParticipant({
      id,
      roomId,
      permissions,
      request,
      worktree,
      info,
      bus,
      notices: () => [...roomNotices, ...own],
      stderrLog: stderrFor(id),
      dismissed: () => dismissing !== undefined,
      watchdog,
      limits: watchLimits,
      ...(saved && { saved }),
      ...(noteSession && {
        report: (seen: Seen) => noteSession(request.spec.name, seen),
      }),
      onRevive: () => {
        paused = false;
      },
      onAnswer: answer,
      onCheckout: (next) => {
        worktrees?.update(id, next);
        // No stream line carries this: the room record and the next reply do.
        saveSoon();
      },
    });
    return {
      ...made,
      spec: request.spec,
      source: request.source,
      own,
      onNotice,
    };
  };

  const spawn = async (request: AgentRequest, base: string | undefined) => {
    const id = newParticipantId();
    const own: RoomNotice[] = [];
    if (notice) own.push({ text: notice });

    // Taken here rather than in the participant, so a rollback knows which
    // path to look at.
    let worktree: string | undefined;
    let made: Member;
    try {
      worktree = worktrees ? await worktrees.acquire(id, base) : cwd;
      const info = worktrees?.info(id);
      if (info) {
        bus.emit({
          agent: id,
          update: {
            sessionUpdate: "_client_worktree_created",
            // Listed, not spread, as `core/run.ts` does: a wider `info` must
            // not shadow `path` (#85).
            path: worktree,
            branch: info.branch,
            baseSha: info.baseSha,
          },
        });
      }
      made = makeMember(request, id, worktree, info, own);
      await made.launch();
    } catch (err) {
      await rollback(id, worktree);
      if (err instanceof BadBase) {
        throw new RoomRefusal("invalid_request", err.message);
      }
      throw err instanceof LinkPathError
        ? new RoomRefusal("invalid_config", err.message)
        : err;
    }
    // A dismiss or pause that began while this harness was starting did not
    // see it.
    if (ended()) {
      await made.stop();
      await rollback(id, worktree);
      throw dismissed();
    }
    members.push(made);
    participants.push(made.participant);
    paused = false;
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
    return made.participant;
  };

  const start = async (request: AgentRequest) => {
    // Everything up to the first `await` runs at once, so the check and the
    // reservation cannot interleave with another add.
    if (ended()) throw dismissed();
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

  const setModel = async (id: string, model: string) => {
    if (ended()) throw dismissed();
    const found = member(id);
    await found.setModel(model);
    // A deferred change sends no line yet, and must outlive a restart.
    saveSoon();
    return found.participant;
  };

  const update = (id: string, changes: Omit<ParticipantChanges, "model">) => {
    if (ended()) throw dismissed();
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
    if (ended()) throw dismissed();
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
    if (ended()) throw dismissed();
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
        throw new RoomRefusal("no_branch", err.message);
      }
      throw err;
    }
    return target;
  };

  try {
    // A restored roster: each participant as it was saved, its checkout held
    // again so a dismiss can release it.
    for (const saved of from?.participants ?? []) {
      const spec = resolveAgent(saved.agent ?? "", saved.cmd);
      const request: AgentRequest = {
        spec,
        source:
          saved.cmd !== undefined
            ? { cmd: saved.cmd }
            : { agent: saved.agent as string },
        name: saved.name,
        mode: saved.mode,
        settings: saved.settings,
        ...(saved.role && { role: saved.role }),
        ...(saved.model && { model: saved.model }),
      };
      const info =
        saved.branch && saved.baseSha
          ? {
              branch: saved.branch,
              baseSha: saved.baseSha,
              ...(saved.baseRef && { baseRef: saved.baseRef }),
            }
          : undefined;
      if (info) {
        worktrees?.adopt(saved.id, {
          ...info,
          ...(saved.branchRenamed === true && { renamed: true }),
        });
      }
      const m = makeMember(
        request,
        saved.id,
        saved.worktree,
        info,
        [...saved.notices],
        saved,
      );
      // A crash can leave `room.json` older than the checkout: a rename or a
      // rebase in a turn that never ended. Read the truth before the record is
      // kept.
      await m.syncCheckout();
      members.push(m);
      participants.push(m.participant);
    }

    const room: Room = {
      meta,
      participants,
      eventLog,
      status,
      add: (request) => track(start(request)),
      update,
      setModel: (id, model) => track(setModel(id, model)),
      retitle(title) {
        if (ended()) throw dismissed();
        meta.title = title;
      },
      send(id, text, from) {
        if (ended()) throw dismissed();
        const target = participants.find((p) => p.id === id);
        if (!target) {
          throw new RoomRefusal(
            "participant_not_found",
            `no participant ${id}`,
          );
        }
        if (meta.turnCount >= meta.turnCap) {
          bus.emit({
            agent: id,
            update: { sessionUpdate: "_client_turn_cap_reached" },
          });
          throw new RoomRefusal(
            "turn_cap",
            `the orchestrator reached this room's ${meta.turnCap}-turn cap; ` +
              "raise it with /cap <n>",
          );
        }
        const turn = target.send(text, from);
        meta.turnCount += 1;
        return turn;
      },
      raiseTurnCap(turnCap) {
        if (ended()) throw dismissed();
        if (!Number.isInteger(turnCap) || turnCap < 1) {
          throw new RoomRefusal(
            "invalid_request",
            '"turnCap" must be a whole number 1 or greater',
          );
        }
        if (turnCap <= meta.turnCap) {
          throw new RoomRefusal(
            "invalid_request",
            `"turnCap" must be greater than the room's current cap (${meta.turnCap})`,
          );
        }
        meta.turnCap = turnCap;
      },
      remove: (id) => track(remove(id)),
      fastForward: (targetId, fromId) => track(forward(targetId, fromId)),
      dismiss: teardown,
      pause,
      touch() {
        meta.updatedAt = new Date().toISOString();
        save();
      },
      forget() {
        // A queued save reads `saving` when it runs, so this stops it too.
        saving = false;
        rmSync(logDir, { recursive: true, force: true });
      },
    };
    return {
      room,
      keepSaved() {
        // A tombstone is a roster change even though no harness produced it.
        // Without this line a replay keeps the participant from its earlier
        // `_client_participant_added` event. A dismissed room has no writable
        // log and is hidden from the chat, so it needs no line.
        if (from?.status !== "dismissed") {
          for (const saved of tombstoned) {
            bus.emit({
              agent: saved.id,
              update: { sessionUpdate: "_client_participant_removed" },
            });
          }
        }
        saving = true;
        save();
      },
    };
  } catch (err) {
    clearInterval(sweep);
    try {
      await eventLog?.close();
    } catch {
      // Keep the cause that stopped the room from opening.
    }
    throw err;
  }
}

/**
 * One participant. A new one has no harness until the room calls `launch`;
 * a restored one has none until its next message revives it. On a throw,
 * `launch` has stopped whatever it started; the caller releases the
 * checkout.
 */
function createParticipant({
  id,
  roomId,
  permissions,
  request: {
    spec,
    name,
    role,
    settings,
    mode: initialMode,
    model: initialModel,
  },
  worktree,
  info,
  bus,
  notices,
  stderrLog,
  dismissed,
  watchdog,
  limits,
  saved,
  onRevive,
  onAnswer,
  onCheckout,
  report,
}: {
  id: string;
  roomId: string;
  permissions: PermissionQueue;
  request: AgentRequest;
  /** Its own checkout, or the cwd when there are no worktrees. */
  worktree: string;
  info: { branch: string; baseSha: string; baseRef?: string } | undefined;
  bus: EventBus;
  /** The room's and the checkout's notices; the participant adds the lines
   *  that depend on its mode. */
  notices: () => readonly RoomNotice[];
  /** The stderr log for the next harness, or undefined for none. */
  stderrLog: () => string | undefined;
  dismissed: () => boolean;
  watchdog: Watchdog;
  limits: WatchdogLimits;
  /** A restored participant's record; absent for a new one. */
  saved?: ParticipantRecord;
  /** A revive gave the harness a new process. */
  onRevive: () => void;
  /** A turn ended that was not a reply's or a copy's, and not cut by a
   *  stop: the room sends its answer on (M8-2). */
  onAnswer: (worker: Participant, answer: Answer) => void;
  /** The checkout's branch or rebase base changed; the room follows it in
   *  the held checkout record. Absent when there is no worktree. */
  onCheckout?: (next: {
    branch: string;
    baseSha?: string;
    renamed?: boolean;
  }) => void;
  /** Where what a session said goes (M9-4). */
  report?: (seen: Seen) => void;
}): Omit<Member, "spec" | "source" | "own" | "onNotice"> {
  /** The live harness; undefined before `launch` and once it has stopped. */
  let agent: AcpAgent | undefined;
  /** Why there is no harness, once there was one (R46). */
  let stopped: "exited" | "killed" | "paused" | undefined =
    saved?.status === "exited" || saved?.status === "killed"
      ? saved.status
      : saved && "paused";
  let sessionId = saved?.sessionId ?? "";
  let resumed = saved?.resumed;
  let turnCancelled = saved?.turnCancelled === true;
  let mode = initialMode;
  // Read from the checkout after each turn; restored from `info` first.
  let branch = info?.branch;
  let baseSha = info?.baseSha;
  const baseRef = info?.baseRef;
  // True only when this name was renamed into from the one we held.
  let branchRenamed = saved?.branchRenamed === true;
  // Counts this participant's turns from 1 (S12's `turn`), and the live
  // turn's cancel. A turn that ends for any reason aborts it, which denies
  // what it left open in the queue as `cancel`. Between turns it is already
  // aborted, so a request there is denied, not queued.
  let turns = saved?.turns ?? 0;
  let orderedBy = saved?.orderedBy;
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

  // The lines that name the mode: `warningsFor`'s, and what the last mode
  // send said. A mode change replaces them, so `notices` shows the current
  // mode only (decided 2026-09-29, #194).
  let modeLines: RoomNotice[] = [];

  // The harness's own mode: `safe`'s id, or `ask`'s for the other two
  // (`harnessModeId`). Sent at session start, then before the first turn
  // after a change that moves it, never during a turn. `sent` is the id the
  // harness was last told. A send that failed is tried again before the next
  // turn; a mode with no id is never sent. A new harness starts with none
  // sent: a harness keeps no mode across processes.
  let sent: string | undefined;
  let failure: { modeId: string; why: string } | undefined;
  const unsent = () => {
    const modeId = harnessModeId(spec, mode);
    return modeId !== undefined && modeId !== sent;
  };
  const syncMode = async () => {
    const modeId = harnessModeId(spec, mode);
    if (!modeId || !agent) return;
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
    if (!modeId) return [{ text: modeLine(spec.name, mode) }];
    if (failure?.modeId === modeId) {
      return [{ text: modeLine(spec.name, mode, failure) }];
    }
    return [];
  };

  // The model in use, as the harness last said, and the line a refusal
  // left. Both are worked out again at each start. A change the harness
  // took leaves no line: notices are warnings, and the status line shows
  // the model in use.
  let model: string | undefined;
  let modelLine: RoomNotice | undefined;
  // The model a start asks for (M9-5). A change during a chat replaces it
  // once the harness takes it (M9-6).
  let asked = initialModel;
  // A change the harness has not heard of yet: it was busy, or had none.
  // `room.json` keeps it, so a pause or a restart does not drop it.
  let wanted = saved?.pendingModel;
  /** Sets `target` on the live harness. A refusal leaves it on the model it
   *  had: pi and claude say only `Internal error`, so the line is ours, with
   *  theirs after it. A time-out or an exit is no refusal, and the harness
   *  may still apply it, so its line says less. Only a set the harness took
   *  becomes `asked`. A failed set is not tried again in this process. */
  const applyModel = async (next: AcpAgent, target: string) => {
    const option = next.configOptions.find((o) => o.category === "model");
    const on = model ? `the model "${model}"` : "its own model";
    if (!option) {
      modelLine = {
        text: `${spec.name} lists no models, so the model "${target}" was not set; it runs on ${on}`,
      };
      return;
    }
    try {
      const res = await next.setConfigOption(option.id, target);
      const now = res?.configOptions?.find((o) => o.category === "model");
      model = now?.type === "select" ? now.currentValue : target;
      asked = target;
      // It took the set, yet names another model.
      modelLine =
        model === target
          ? undefined
          : {
              text: `${spec.name} took the model "${target}" but runs on "${model}"`,
            };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      modelLine = {
        text:
          err instanceof RpcError
            ? `${spec.name} refused the model "${target}" (${why}); it runs on ${on}`
            : `${spec.name} did not confirm the model "${target}" (${why}); ` +
              `it may still run on ${on}`,
      };
    }
  };
  /** Tells every client the result of a change: the model in use, or
   *  `null` when the harness names none, so each one reads the notice too.
   *  It also makes the room save `asked` and drop `pendingModel`. */
  const announceModel = () => {
    bus.emit({
      agent: id,
      update: {
        sessionUpdate: "_client_participant_changed",
        model: model ?? null,
      },
    });
  };
  /** A harness that just started: its own model, then the one asked for. */
  const syncModel = async (next: AcpAgent) => {
    const option = next.configOptions.find((o) => o.category === "model");
    model = option?.type === "select" ? option.currentValue : undefined;
    modelLine = undefined;
    const pending = wanted;
    const target = pending ?? asked;
    wanted = undefined;
    // Put back the accepted model first. If the pending change is refused,
    // the participant stays on that model, not the one the session chose.
    if (
      pending !== undefined &&
      asked !== undefined &&
      asked !== pending &&
      model !== asked
    ) {
      await applyModel(next, asked);
    }
    if (target) await applyModel(next, target);
    // A change made while there was no harness was answered here, so it gets
    // the same line as one made against a live harness (M9-6).
    if (pending !== undefined) announceModel();
  };
  /** The change the live harness has not heard of, then its result. */
  const sendWanted = async () => {
    const target = wanted;
    wanted = undefined;
    if (!agent || !target) return;
    await applyModel(agent, target);
    announceModel();
  };

  let turn: Promise<void> | undefined;
  /** True once the prompt phase is over: the prompt settled, or starting it
   *  failed before it was sent. `turn` can stay set through the checkout read
   *  that follows. */
  let promptSettled = false;
  /** A fast-forward of this checkout (M6-11a). It counts as busy, so a
   *  message queues behind it rather than start a turn on moving files. */
  let held: Promise<unknown> | undefined;
  /** Set by a remove, a dismiss or a pause: nothing starts after it. */
  let stopping = false;
  const waiting: {
    text: string;
    from?: Sender;
    kind?: MessageKind;
    done: () => void;
  }[] = [];

  // M8-2: the live turn's answer, from its prompt's send. A cancel and an
  // exit drop it, so a cut turn's half-written text is never sent on.
  // `calls` stays: the reply's first line counts them.
  let kept:
    | {
        since: string;
        sinceBytes: number;
        sinceCut: boolean;
        last: string;
        lastCut: boolean;
      }
    | undefined;
  let calls = 0;
  // M8-3: who sent the live turn's message, for `GET /rooms/:id`.
  let turnFrom: string | undefined;
  const keep = (update: AgentEvent) => {
    if (!kept) return;
    if (update.sessionUpdate === "tool_call") {
      calls += 1;
      if (kept.since.trim()) {
        kept.last = kept.since;
        kept.lastCut = kept.sinceCut;
      }
      kept.since = "";
      kept.sinceBytes = 0;
      kept.sinceCut = false;
    } else if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text"
    ) {
      const chunk = update.content.text;
      const left = ANSWER_CAP - kept.sinceBytes;
      const bytes = Buffer.byteLength(chunk);
      const fit = bytes <= left ? chunk : fitBytes(chunk, left);
      if (fit !== chunk) kept.sinceCut = true;
      kept.since += fit;
      kept.sinceBytes += fit === chunk ? bytes : Buffer.byteLength(fit);
    }
  };

  let version: string | undefined;
  const warn = () => {
    modeLines = warningsFor(spec.name, spec, mode, version).map(
      ({ text, kind }) => (kind ? { text, kind } : { text }),
    );
  };
  if (saved) warn();

  /** Starts a harness in the checkout, loads session `load` when the
   *  harness can, or else opens a fresh one. True when it loaded. */
  const launch = async (load?: string): Promise<boolean> => {
    // One login notice per harness start is saved (M9-4): each is a
    // synchronous write, and a harness may send many. A later change shows
    // at the next start or check.
    let noticed = false;
    const next: AcpAgent = new AcpAgent({
      name: spec.name,
      command: spec.launch.command,
      args: spec.launch.args,
      env: resolveEnv(spec.launch.env),
      cwd: worktree,
      policy,
      allowReadOutsideRoot: readsOutside(),
      stderrLog: stderrLog(),
      // Only a registry agent has a login signal; nothing waits for it.
      onAuthStatus: (kind) => {
        if (!spec.setup || noticed) return;
        noticed = true;
        report?.(noticeSeen(kind));
      },
      onEvent: ({ update }) => {
        // Only the live harness's exit stops the participant. A pause or a
        // remove sets the status itself. One that dies during a turn may
        // have left its files and its memory apart (R46).
        if (
          update.sessionUpdate === "_client_harness_exited" &&
          agent === next
        ) {
          agent = undefined;
          kept = undefined;
          if (!stopping) stopped = turn ? "killed" : "exited";
        }
        if (agent === next) keep(update);
        // Named by id, not by harness name (S10). Only the harness's own
        // events feed the watchdog, so its warning never resets it. After
        // the emit, so a resolve follows the line that caused it.
        const event = { agent: id, update };
        bus.emit(event);
        watchdog.note(event);
      },
    });
    let session: string | undefined;
    let loaded = false;
    try {
      const init = await next.start();
      version = init.agentInfo?.version;
      warn();
      if (load && spec.measured?.loads && init.agentCapabilities?.loadSession) {
        // A load that fails falls back to fresh, which the revive reports.
        // A harness that died in it fails `newSession` too. Its `-32000` is
        // not read: on codex and kimi, `newSession` gives the same one.
        session = await next.loadSession(load).catch(() => undefined);
        loaded = session !== undefined;
      }
      session ??= await next.newSession().catch((err: unknown) => {
        const seen = spec.setup && failureSeen(err);
        if (seen) report?.(seen);
        throw err;
      });
      // A real session's models replace the saved ones (3A): a revive's
      // load is a real session too. It gives a login state only on an agent
      // whose load needs one (`loadNeedsLogin`). Before `syncModel`, so
      // `model` here is the one the session started with; `configOptions`
      // does not follow a set, so `models` stays the session's list (M9-6).
      if (spec.setup) {
        report?.(sessionSeen(spec.setup, next.configOptions, loaded));
      }
    } catch (err) {
      await next.stop();
      throw err;
    }
    // A stop that came while this harness was starting did not see it.
    if (stopping) {
      await next.stop();
      throw new Error("the participant is stopping");
    }
    agent = next;
    sessionId = session;
    // A loaded session does not keep its mode either (§Mode after load).
    sent = undefined;
    failure = undefined;
    await syncMode();
    // Nor, maybe, its model: not measured, so it is sent again (M9-5).
    await syncModel(next);
    return loaded;
  };

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

  /** A new harness for a participant that has none. It loads the old
   *  session when it can, and says whether it did. */
  const revive = async () => {
    const behind = stopped === "killed" || turnCancelled;
    const loaded = await launch(sessionId || undefined);
    stopped = undefined;
    turnCancelled = false;
    resumed = loaded ? "loaded" : "fresh";
    bus.emit({
      agent: id,
      update: {
        sessionUpdate: "_client_participant_revived",
        resumed,
        sessionId,
        ...(loaded && behind && { memoryMayBeBehind: true as const }),
      },
    });
    onRevive();
  };

  const begin = (
    text: string,
    from?: Sender,
    kind?: MessageKind,
  ): Promise<void> => {
    turns += 1;
    const controller = new AbortController();
    turnAbort = controller;
    promptSettled = false;
    turnFrom = from?.id;
    // Before the line below, whose save keeps it.
    if (from && !kind) orderedBy = from.id;
    kept = undefined;
    calls = 0;
    bus.emit({
      agent: id,
      update: {
        sessionUpdate: "_client_user_message",
        text,
        turn: turns,
        ...(from && { from: from.id }),
        ...(kind && { kind }),
      },
    });
    const watch = watchdog.watch(id, limits);
    // At once when the harness is up and its mode is current, so a cancel
    // that follows `send` reaches a turn the harness already has. A turn
    // cancelled while its harness started or its mode was sent never sends
    // its prompt.
    const prompt = () => {
      if (controller.signal.aborted) {
        return { stopReason: "cancelled" as const };
      }
      if (!agent) throw new Error("the agent's harness has exited");
      // From here, not before: a load replays old turns as text.
      if (!kind)
        kept = {
          since: "",
          sinceBytes: 0,
          sinceCut: false,
          last: "",
          lastCut: false,
        };
      return agent.prompt(
        from && !kind ? `[from ${from.name}]\n${text}` : text,
      );
    };
    // The answer as the harness left it, taken before the checkout read:
    // a cancel during that read comes after the turn ended (#295).
    const take = (end: string, error?: string): Answer | undefined => {
      const answer = kept;
      kept = undefined;
      // A reply's or a copy's turn sends nothing.
      if (kind) return undefined;
      // None after a cancel or an exit: both dropped it.
      const [body, cut] = !answer
        ? ["", false]
        : answer.since.trim()
          ? [answer.since, answer.sinceCut]
          : [answer.last, answer.lastCut];
      return {
        text,
        ...(from && { from }),
        end,
        calls,
        body: error ?? body,
        cut: error === undefined && cut,
      };
    };
    // A stop sends nothing, also one that came during the checkout read.
    const finish = (answer: Answer | undefined) => {
      if (answer && !stopping && !dismissed()) onAnswer(participant, answer);
    };
    let ready: Promise<void> | undefined;
    if (!agent) ready = revive();
    else if (unsent()) ready = syncMode().then(sendWanted);
    else if (wanted) ready = sendWanted();
    // **Before the turn's own end line**, so a client that reloads the diff
    // on `_client_turn_ended` already has the rebased `baseSha`, and one that
    // re-reads the room then sees the new branch.
    const after = async () => {
      try {
        await syncCheckout();
      } catch {
        // The identity already on the record stands; a git read must never
        // fail a turn that ended.
      }
    };
    // `ready` is undefined only when the harness is up, so `prompt` cannot
    // throw here.
    turn = (ready ? ready.then(prompt) : Promise.resolve(prompt()))
      .then(
        async ({ stopReason }) => {
          promptSettled = true;
          // Our own record, not `stopReason`: copilot answers `end_turn` for
          // a turn it cancelled (§M0-4). The abort's reason says who cut it
          // (#377): `cancel()` gives `person`.
          const { aborted, reason } = controller.signal;
          const answer = take(
            !aborted
              ? stopReason
              : reason === "person"
                ? "cancelled by the person"
                : "cancelled",
          );
          await after();
          bus.emit({
            agent: id,
            update: { sessionUpdate: "_client_turn_ended", stopReason },
          });
          finish(answer);
        },
        async (err) => {
          promptSettled = true;
          const error = err instanceof Error ? err.message : String(err);
          const answer = take("error", error);
          await after();
          bus.emit({
            agent: id,
            update: { sessionUpdate: "_client_turn_ended", error },
          });
          finish(answer);
        },
      )
      .finally(() => {
        controller.abort();
        watch.close();
        turn = undefined;
        turnFrom = undefined;
        next();
      });
    return turn;
  };

  // A harness that is gone takes its queue with it. The harness reports its
  // exit before the prompt fails (`protocol/agent.ts`). The next message
  // revives it; a queued one does not, on purpose: it was written before
  // the stop, and the revive may be fresh, with none of that context, or a
  // load that remembers less than the files show (§M0-9). The person who
  // sends it again knows which. `_client_queue_cleared` tells them to.
  const next = () => {
    if (stopped || stopping || dismissed()) return drop();
    const queued = waiting.shift();
    if (queued) {
      void begin(queued.text, queued.from, queued.kind).then(queued.done);
    }
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
    // A settled prompt is over: only its checkout read runs. A late
    // session/cancel can abort background work, and no turn is live.
    if (turn && !promptSettled) {
      turnAbort.abort();
      agent?.cancel();
    }
    await agent?.stop();
    await turn;
    await held;
  };

  // A shutdown leaves a participant as a cancel does (R42): a live prompt is
  // cancelled and gets its `_client_turn_ended` before the harness stops. A
  // prompt still live after the grace is cut, so it reads `killed`. Once the
  // prompt has settled, only its checkout read remains: send no late cancel and
  // record no cut.
  const pause = async (graceMs: number) => {
    stopping = true;
    drop();
    const before = stopped;
    const live = promptSettled ? undefined : turn;
    let cut = false;
    if (live) {
      turnAbort.abort();
      agent?.cancel();
      let timer: NodeJS.Timeout | undefined;
      const ended = await Promise.race([
        live.then(() => true),
        new Promise<boolean>((ok) => {
          timer = setTimeout(() => ok(false), graceMs);
        }),
      ]);
      clearTimeout(timer);
      cut = !ended;
    }
    await agent?.stop();
    await turn;
    await held;
    stopped = cut ? "killed" : (before ?? "paused");
    // Ended by the cancel: `paused`, though its memory may be behind.
    turnCancelled ||= live !== undefined && !cut;
  };

  // The filter follows at once; the harness's own mode before the next turn.
  // A question that waits under `ask` gets the new mode's answer.
  const setMode = (next: ClientMode) => {
    const leftAsk = mode === "ask" && next !== "ask";
    mode = next;
    if (leftAsk) permissions.answerParticipant(roomId, id, next === "auto");
    if (agent) agent.allowReadOutsideRoot = readsOutside();
    warn();
  };

  // An idle harness hears of a new model at once, held, so a message sent
  // meanwhile waits behind the set. A busy one hears of it before its next
  // turn, and one with no harness at its next start (#301).
  const setModel = async (next: string) => {
    wanted = next;
    if (!agent || turn || held || stopping) return;
    await hold(sendWanted());
  };

  /** What the harness did to its own checkout: renamed the branch, or moved
   *  the commit its work starts from with a rebase. A git read that fails
   *  leaves the identity already recorded; a bad base would be worse than a
   *  stale one. The room follows the change into its held checkout and the
   *  saved record; the stream gets no line for it. */
  const syncCheckout = async (): Promise<boolean> => {
    if (!info) return false;
    let found: Awaited<ReturnType<typeof checkoutIdentity>>;
    try {
      found = await checkoutIdentity(worktree, branch);
    } catch {
      return false;
    }
    if (!found) return false;
    let changed = false;
    if (found.branch !== branch) {
      // A positive rename makes the new name the room's; any other switch
      // clears the claim, so release and delete leave that branch alone.
      branchRenamed = found.renamedFrom === branch;
      branch = found.branch;
      changed = true;
    }
    if (found.rebaseBase !== undefined && found.rebaseBase !== baseSha) {
      baseSha = found.rebaseBase;
      changed = true;
    }
    if (!changed) return false;
    onCheckout?.({
      branch,
      ...(baseSha && { baseSha }),
      ...(branchRenamed && { renamed: true }),
    });
    return true;
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
      return { allowReadOutsideRoot: readsOutside() };
    },
    worktree,
    get branch() {
      return branch;
    },
    get baseSha() {
      return baseSha;
    },
    get baseRef() {
      return baseRef;
    },
    get sessionId() {
      return sessionId;
    },
    get resumed() {
      return resumed;
    },
    get model() {
      return model;
    },
    get models() {
      // An option that lists none gives none, as the contract says.
      const list = agent && modelsOf(agent.configOptions).models;
      return list?.length ? list : undefined;
    },
    get notices() {
      return [
        ...notices(),
        ...modeLines,
        ...modeSend(),
        ...(modelLine ? [modelLine] : []),
      ];
    },
    status: () => {
      if (dismissed()) return "dismissed";
      if (turn || held) return "busy";
      return stopped ?? "idle";
    },
    get queued() {
      return waiting.length;
    },
    get turnFrom() {
      return turnFrom;
    },
    get orderedBy() {
      return orderedBy;
    },
    send(text, sender, kind) {
      if (dismissed()) {
        throw new RoomRefusal("room_dismissed", "the room is dismissed");
      }
      if (stopping) {
        throw new RoomRefusal("agent_exited", "the agent is stopping");
      }
      // A copy, so a rename while it waits does not change the line its
      // harness reads. A screen names `from` by the roster, so it shows the
      // new name: the id is what lasts.
      const from = sender && { id: sender.id, name: sender.name };
      if (!turn && !held) return begin(text, from, kind);
      // A reply or a copy is never refused (M8-2): a dropped one would leave
      // the loop waiting on nothing. Each comes from one finished turn.
      if (!kind && waiting.length >= QUEUE_BOUND) {
        throw new RoomRefusal(
          "queue_full",
          `${QUEUE_BOUND} messages already wait for this agent; ` +
            "wait for them to run, or cancel its live prompt to drop them",
        );
      }
      bus.emit({
        agent: id,
        update: {
          sessionUpdate: "_client_message_queued",
          text,
          ...(from && { from: from.id }),
          ...(kind && { kind }),
        },
      });
      return new Promise<void>((done) =>
        waiting.push({ text, from, kind, done }),
      );
    },
    cancel() {
      if (!turn || promptSettled) return false;
      drop();
      kept = undefined;
      // The history now holds a cut turn, as after a pause's cancel (§M0-9).
      turnCancelled = true;
      // Before the harness hears of the cancel, so the request it waits on
      // is answered at once. Only the person's route calls this: the reason
      // makes the reply say `cancelled by the person` (#377).
      turnAbort.abort("person");
      agent?.cancel();
      return true;
    },
  };
  return {
    participant,
    stop,
    pause,
    launch,
    setMode,
    setModel,
    asked: () => asked,
    pending: () => wanted,
    hold,
    renamed: () => branchRenamed,
    syncCheckout,
    turns: () => turns,
    turnCancelled: () => turnCancelled,
  };
}
