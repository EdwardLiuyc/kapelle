/**
 * The room's shared types, limits and refusal (M12-8a).
 *
 * **The orchestrator is a label, not a slot**. A participant has the
 * role it was given and no other; nothing is promoted by default.
 */

import type {
  ClientMode,
  ResolvedAgent,
  Warning,
} from "../../protocol/registry.ts";
import type { MessageKind } from "../../protocol/types.ts";
import type { EventLog } from "../eventlog.ts";

/** How many messages may wait behind a participant's live turn (R41). */
export const QUEUE_BOUND = 16;

/** How many worker messages a room's orchestrator may send by default (M8-7). */
export const DEFAULT_ORCHESTRATOR_TURN_CAP = 40;

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
export type RoomStatus = "active" | "paused" | "dismissed";

/** `exited`: the harness died while idle. `killed`: it stopped during a turn
 *  without a clean end (R46). `paused`: a shutdown stopped it cleanly. All
 *  three revive on the next message. */
export type ParticipantStatus =
  | "idle"
  | "busy"
  | "exited"
  | "paused"
  | "killed"
  | "dismissed";

/** R44's closed set. A label only: it sends no text to the harness. */
export const ROLES = [
  "orchestrator",
  "developer",
  "tester",
  "architect",
  "reviewer",
] as const;
export type Role = (typeof ROLES)[number];

export const MODES: readonly ClientMode[] = ["ask", "safe", "auto"];

/** R15, amended 2026-09-28 (#147): the run-file `Task` fields that act in a
 *  room today. The watchdog limits are the room's, from the daemon's config,
 *  not a participant's. No `purpose`: a person sends instructions as a
 *  message, never as a hidden prefix. */
export interface Settings {
  allowReadOutsideRoot: boolean;
}

/** A line the room kept for the operator, as `Warning` has it. */
export interface RoomNotice {
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
  /** Its own folder (M11-2); the room's when absent. The daemon checks it
   *  is an added folder, and passes it real and absolute. */
  cwd?: string;
  mode: ClientMode;
  settings: Settings;
  /** The model to set after each start; the harness's own when absent. */
  model?: string;
  /** The thinking level to set after the model (M9-9). */
  thoughtLevel?: string;
}

/** What `PATCH` may change. A `null` role clears it. `model` goes to
 *  `Room.setModel`, `thoughtLevel` to `Room.setLevel`, the rest to
 *  `Room.update`. */
export interface ParticipantChanges {
  name?: string;
  role?: Role | null;
  mode?: ClientMode;
  model?: string;
  thoughtLevel?: string;
}

/** Who sent a message, when a participant did (M8-1). */
export type Sender = Pick<Participant, "id" | "name">;

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
  /** The thinking level in use and the model's levels (M9-9), as the
   *  harness last said. Absent when the model has no level option, and
   *  before the first start; the list is also absent with no harness. */
  readonly thoughtLevel?: string;
  readonly thoughtLevels?: readonly { id: string; name: string }[];
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
export interface ParticipantRecord {
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
  /** The thinking level asked for, and a change not yet sent (M9-9), as
   *  `model` and `pendingModel`. */
  thoughtLevel?: string;
  pendingThoughtLevel?: string;
  worktree: string;
  /** The folder the participant asked for, when not the room's (M11-2). */
  cwd?: string;
  /** Its folder is a scratch folder the room made, `worktree` (M11-2). */
  scratch?: true;
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
  /** The repository root of every folder the room opened for a participant,
   *  besides its own (M11-2), whether or not a checkout was made there. Two
   *  folders in one repository are one entry. Kept after the
   *  participant leaves, and after a failed add, so delete still finds
   *  checkouts and branches in every repository the room touched; one with
   *  none costs delete nothing. */
  repositories?: string[];
}

/** The changes a `PATCH` sends to the harness, after the rest. */
export type Later = "model" | "thoughtLevel";

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
  update(id: string, changes: Omit<ParticipantChanges, Later>): Participant;
  /** Asks the participant's harness for another model (M9-6): now when it
   *  is idle, and before its next turn when it is busy. Resolves once an
   *  idle harness answered; a refusal is a notice, not a throw. */
  setModel(id: string, model: string): Promise<Participant>;
  /** Asks for another thinking level (M9-9), when and as `setModel` does.
   *  An unlisted level is refused with `invalid_request` when the list is
   *  known, before anything is sent. */
  setLevel(id: string, level: string): Promise<Participant>;
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
  /** Why a fast-forward between the two cannot work across repositories
   *  (M11-2), or undefined when they share one. The move and its preview
   *  both ask, after their own branch checks. */
  otherRepository(targetId: string, fromId: string): string | undefined;
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
