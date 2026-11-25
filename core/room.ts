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
 * **A participant may pick its own folder** (M11-2, decided 2026-11-19,
 * #476). An add with `cwd` gets its checkout in that folder's repository,
 * `stateDirFor(<that root>)/wt/<roomId>/<participantId>`, or runs in the
 * folder itself when it has no git or no commit. An add without `cwd` uses
 * the room's own folder, as before, except in a room with `scratchDir` (the
 * hall): there it gets an empty folder of its own, which its release removes
 * while it is still empty. `room.json` keeps the participant's `cwd`, or
 * `scratch`, so a restore opens the same place. It also keeps the
 * repository root of every folder the room opened for a participant, even
 * after that participant leaves or an add fails, so delete can find a kept
 * checkout and its branch. The room's record and log stay under the room's
 * own root; the boot sweep reads every room's record before it calls a
 * checkout an orphan (`core/sweep.ts`).
 *
 * **A kept checkout lasts while its room has a record.** The boot sweep
 * (`core/sweep.ts`) keeps every checkout under a room that has a
 * `room.json`, dismissed rooms too, until `DELETE /rooms/:id` or the
 * sweep's retention reap removes the room (`removeRoom`, #235).
 *
 * **A roster that changes** (M6-3). `add`, `update` and `remove` change it
 * after the room opens. An add still in flight
 * holds its name and role, so two racing adds cannot both take one. A
 * removed participant leaves the roster. Its checkout is released as at
 * dismiss, and a release notice goes to the room's notices, since the
 * participant that would show it is gone. Each change is on the log —
 * `_client_participant_added`, `_changed` and `_removed`, starters included —
 * so a client builds the roster from the stream alone (M6-10).
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
 * **A participant may ask for a thinking level** (M9-9), at its add or
 * during a chat, as for the model. It is the option with `category:
 * "thought_level"`, and its list belongs to the model (§Thinking level). The
 * room keeps that option as the harness last sent it: the session's, then
 * the reply to each set of the model or of the level. A reply with no level
 * option means the model has none. Five rules come from the measurement and
 * the pickup (decided 2026-11-17, #501):
 *
 * - Only a listed level is sent: pi and copilot take any value and change
 *   the level. With a live list and no model change waiting, `setLevel`
 *   refuses an unlisted level before any send. Otherwise the check waits for
 *   the send, which then skips it and leaves a notice.
 * - The level goes after the model, at a start and before a turn: opencode
 *   resets the level on every change to another model.
 * - After a start, a load too, the level asked for is sent only when the
 *   harness reports another one. A load can lose it: pi's level is its mode
 *   (§Mode after load).
 * - A model change during a chat never sends a level. Once the harness took
 *   the model, the same model again included, the level asked for becomes
 *   the one in use, moved or not, so a revive does not bring an old one
 *   back. The level line changes with it: a notice when the level moved, and
 *   none when it did not, since no open request is left for a notice to
 *   describe. A refused model changes neither. A model change that waits for
 *   a start is part of that start.
 * - On pi a level set also sends `current_mode_update`. Nothing here reads
 *   that, so a level never changes the mode or its notices.
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
 * A daemon-wide cap belongs in `daemon/app.ts`, where both spawners meet; add
 * one when a machine actually runs out of memory or file handles, not before.
 */

import { existsSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
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
import type {
  AgentEvent,
  MessageKind,
  SessionConfigOption,
} from "../protocol/types.ts";
import {
  failureSeen,
  modelsOf,
  noticeSeen,
  type Seen,
  sessionSeen,
  startHelp,
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
import { harnessModeId, modeLine, policyFor } from "./policy.ts";
import {
  crashed,
  roomDir,
  tombstoneUnknownAgents,
  writeRoomRecord,
} from "./room/record.ts";
import {
  type AgentRequest,
  DEFAULT_ORCHESTRATOR_TURN_CAP,
  type Later,
  type Participant,
  type ParticipantChanges,
  type ParticipantRecord,
  QUEUE_BOUND,
  type Room,
  type RoomMeta,
  type RoomNotice,
  type RoomRecord,
  RoomRefusal,
  type RoomStatus,
  type Sender,
} from "./room/types.ts";
import { checkCeiling, clash } from "./room/validate.ts";
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
  openWorktrees,
  type WorktreeSetup,
} from "./worktree.ts";

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

/** A thinking level option that is a list (M9-9). */
type LevelOption = Extract<SessionConfigOption, { type: "select" }>;

/** The thinking level option of `options`, when it is a list. */
function levelOptionOf(
  options: SessionConfigOption[] | undefined,
): LevelOption | undefined {
  const o = options?.find((x) => x.category === "thought_level");
  return o?.type === "select" && Array.isArray(o.options) ? o : undefined;
}

/** Its levels, made flat, as `modelsOf` makes the models. */
function levelsOf(o: LevelOption): { id: string; name: string }[] {
  return o.options
    .flatMap((x) => ("options" in x ? x.options : [x]))
    .map(({ value, name }) => ({ id: value, name }));
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
  /** Where an add with no `cwd` gets an empty folder of its own (M11-2),
   *  instead of the room's folder. The hall sets it. */
  scratchDir?: string;
  /** Opens a participant's own folder for this room (M11-2): the project's
   *  links, then `openWorktrees`. `restoring` opens without links rather
   *  than throwing. Without it, a folder opens with no links. A folder is
   *  opened once per room, so a restore that opened it without links keeps
   *  it so for the room's life, as the room's own `linkPaths` do (#274). */
  openPlace?: (cwd: string, restoring: boolean) => Promise<WorktreeSetup>;
}

/** Where one participant works: the room's own setup, one for the folder
 *  it picked, or a scratch folder. `dir` is where it runs with no worktrees. */
type Place = WorktreeSetup & { dir: string; scratch?: true };

/** The places of one room's participants, each folder opened once. */
function roomPlaces(
  roomId: string,
  cwd: string,
  setup: WorktreeSetup,
  openPlace: RoomDeps["openPlace"],
  remembered: readonly string[] = [],
) {
  const home: Place = { ...setup, dir: cwd };
  const opened = new Map<string, Promise<Place>>();
  const roots = new Set([setup.root, ...remembered]);
  const open = (dir: string, restoring: boolean): Promise<Place> => {
    if (dir === cwd) return Promise.resolve(home);
    let found = opened.get(dir);
    if (!found) {
      found = (
        openPlace
          ? openPlace(dir, restoring)
          : openWorktrees(dir, roomId, { advisory: false })
      ).then((s) => {
        roots.add(s.root);
        return { ...s, dir };
      });
      // A failed open is tried again by the next add.
      found.catch(() => opened.delete(dir));
      opened.set(dir, found);
    }
    return found;
  };
  return {
    home,
    open,
    /** The room's own repository is already in the record's `cwd`. */
    repositories: () => [...roots].filter((root) => root !== setup.root),
    /** The place a saved participant had. */
    saved: (p: ParticipantRecord): Promise<Place> => {
      if (p.scratch) {
        return Promise.resolve({
          worktrees: null,
          root: p.worktree,
          dir: p.worktree,
          scratch: true,
        });
      }
      return p.cwd ? open(p.cwd, true) : Promise.resolve(home);
    },
  };
}
type Places = ReturnType<typeof roomPlaces>;

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
  /** Where it works, and the folder it asked for (M11-2). */
  place: Place;
  cwd?: string;
  /** The model a revive asks for, which `room.json` keeps: the request's,
   *  or the last one the person changed to that the harness took. */
  asked: () => string | undefined;
  /** A change not yet sent, which `room.json` keeps too. */
  pending: () => string | undefined;
  /** The same two for the thinking level (M9-9). */
  askedLevel: () => string | undefined;
  pendingLevel: () => string | undefined;
  /** Its own notices, which `room.json` keeps. */
  own: RoomNotice[];
  stop: () => Promise<void>;
  pause: (graceMs: number) => Promise<void>;
  launch: () => Promise<unknown>;
  turns: () => number;
  turnCancelled: () => boolean;
  setMode: (mode: ClientMode) => void;
  setModel: (model: string) => Promise<void>;
  setLevel: (level: string) => Promise<void>;
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
  const places = roomPlaces(roomId, cwd, deps.setup, deps.openPlace);
  const built = await buildRoom(deps, meta, places);
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
  const places = roomPlaces(
    record.id,
    record.cwd,
    deps.setup,
    deps.openPlace,
    record.repositories,
  );
  const { record: from, tombstoned } = await tombstoneUnknownAgents(
    crashed(record),
    deps.setup.root,
    deps.log ?? ((line) => console.error(line)),
    places,
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
  const built = await buildRoom(deps, meta, places, from, tombstoned);
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
    scratchDir,
  }: RoomDeps,
  meta: RoomMeta,
  places: Places,
  from?: RoomRecord,
  tombstoned: readonly ParticipantRecord[] = [],
): Promise<{ room: Room; keepSaved: () => void }> {
  const { root } = setup;
  const roomId = meta.id;
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
    const askedLevel = m.askedLevel();
    const pendingLevel = m.pendingLevel();
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
      ...(askedLevel && { thoughtLevel: askedLevel }),
      ...(pendingLevel && { pendingThoughtLevel: pendingLevel }),
      worktree: p.worktree,
      ...(m.cwd && { cwd: m.cwd }),
      ...(m.place.scratch && { scratch: true }),
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
      const repositories = places.repositories();
      writeRoomRecord(join(logDir, "room.json"), {
        ...meta,
        status: status(),
        notices: [...roomNotices],
        participants: members.map(recordOf),
        tombstones: [...(from?.tombstones ?? [])],
        ...(repositories.length > 0 && { repositories }),
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
    place: Place,
  ): Promise<boolean> => {
    try {
      const kept = await place.worktrees?.release(id, "keep");
      if (kept) onNotice(kept);
      if (kept || !place.scratch || !worktree) return Boolean(kept);
      // M11-2: `rmdir` removes only an empty folder, which is what
      // untouched means; one the harness wrote into is kept.
      try {
        rmdirSync(worktree);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        onNotice(
          `the scratch folder ${worktree} is kept: ` +
            ((err as NodeJS.ErrnoException).code === "ENOTEMPTY"
              ? "the agent wrote into it"
              : (err as Error).message),
        );
        return true;
      }
      return false;
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
  const rollback = async (
    id: string,
    worktree: string | undefined,
    place: Place,
  ) => {
    const named = await release(id, worktree, onRoomNotice, place);
    if (!named && place.worktrees && worktree && existsSync(worktree)) {
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
        for (const { participant: p, onNotice, place } of members) {
          await release(p.id, p.worktree, onNotice, place);
        }
        for (const saved of from?.tombstones ?? []) {
          await release(
            saved.id,
            saved.worktree,
            onRoomNotice,
            await places.saved(saved),
          );
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
    place: Place,
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
        place.worktrees?.update(id, next);
        // No stream line carries this: the room record and the next reply do.
        saveSoon();
      },
    });
    return {
      ...made,
      spec: request.spec,
      source: request.source,
      place,
      ...(request.cwd !== undefined && { cwd: request.cwd }),
      own,
      onNotice,
    };
  };

  const spawn = async (request: AgentRequest, base: string | undefined) => {
    const id = newParticipantId();
    const own: RoomNotice[] = [];

    // Taken here rather than in the participant, so a rollback knows which
    // path to look at.
    let worktree: string | undefined;
    let place = places.home;
    let made: Member;
    try {
      if (request.cwd !== undefined) {
        place = await places.open(request.cwd, false);
      } else if (scratchDir !== undefined) {
        const dir = join(scratchDir, id);
        place = { worktrees: null, root: dir, dir, scratch: true };
      }
      const { worktrees, notice } = place;
      // Refused, not ignored: the caller asked to start from someone's
      // work, and a folder with no worktrees has no branch to start from.
      if (base !== undefined && !worktrees) {
        throw new RoomRefusal(
          "invalid_request",
          `cannot start from ${JSON.stringify(base)}: ${place.dir} is not a ` +
            "git repository with a commit, so no participant has a branch",
        );
      }
      if (notice) own.push({ text: notice });
      if (place.scratch) mkdirSync(place.dir, { recursive: true, mode: 0o700 });
      worktree = worktrees ? await worktrees.acquire(id, base) : place.dir;
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
      made = makeMember(request, id, place, worktree, info, own);
      await made.launch();
    } catch (err) {
      await rollback(id, worktree, place);
      // The record keeps a repository even when its add failed and left a
      // written checkout. A later room delete must still find that work.
      saveSoon();
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
      await rollback(id, worktree, place);
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
    pending.add(request);
    try {
      return await spawn(request, request.base);
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

  const setLevel = async (id: string, level: string) => {
    if (ended()) throw dismissed();
    const found = member(id);
    await found.setLevel(level);
    saveSoon();
    return found.participant;
  };

  const update = (id: string, changes: Omit<ParticipantChanges, Later>) => {
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
    await release(id, found.participant.worktree, onRoomNotice, found.place);
  };

  // M11-2: a branch lives in one repository only.
  const otherRepository = (targetId: string, fromId: string) => {
    const target = member(targetId);
    const source = member(fromId);
    if (target.place.root === source.place.root) return undefined;
    return (
      `${target.participant.name} and ${source.participant.name} ` +
      "work in different repositories"
    );
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
      // M11-2: a scratch folder or a folder with no git reaches this too.
      const { place } = found;
      throw new RoomRefusal(
        "no_branch",
        `${target.name} has no branch: it works in ` +
          (place.scratch
            ? "a scratch folder"
            : `${place.dir}, which is not a git repository with a commit`),
      );
    }
    if (!source.branch) {
      throw new RoomRefusal(
        "no_branch",
        `${source.name} has no branch to move to`,
      );
    }
    // After the branch checks: two scratch folders differ too, but the
    // reason there is that neither has a branch.
    const other = otherRepository(targetId, fromId);
    if (other) throw new RoomRefusal("no_branch", other);
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
        ...(saved.thoughtLevel && { thoughtLevel: saved.thoughtLevel }),
      };
      if (saved.cwd !== undefined) request.cwd = saved.cwd;
      const place = await places.saved(saved);
      const info =
        saved.branch && saved.baseSha
          ? {
              branch: saved.branch,
              baseSha: saved.baseSha,
              ...(saved.baseRef && { baseRef: saved.baseRef }),
            }
          : undefined;
      if (info) {
        place.worktrees?.adopt(saved.id, {
          ...info,
          ...(saved.branchRenamed === true && { renamed: true }),
        });
      }
      const m = makeMember(
        request,
        saved.id,
        place,
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
      setLevel: (id, level) => track(setLevel(id, level)),
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
      otherRepository,
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
    thoughtLevel: initialLevel,
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
}): Omit<Member, "spec" | "source" | "place" | "cwd" | "own" | "onNotice"> {
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
   *  becomes `asked`. A failed set is not tried again in this process.
   *  True when the harness took it. */
  const applyModel = async (
    next: AcpAgent,
    target: string,
  ): Promise<boolean> => {
    const option = next.configOptions.find((o) => o.category === "model");
    const on = model ? `the model "${model}"` : "its own model";
    if (!option) {
      modelLine = {
        text: `${spec.name} lists no models, so the model "${target}" was not set; it runs on ${on}`,
      };
      return false;
    }
    try {
      const res = await next.setConfigOption(option.id, target);
      const now = res?.configOptions?.find((o) => o.category === "model");
      model = now?.type === "select" ? now.currentValue : target;
      asked = target;
      // The level list belongs to the model: take the reply's, or none
      // (M9-9). A reply without an option means the new model has none. A
      // reply with no `configOptions` at all reads the same, unlike
      // `applyLevel`, which keeps its list: here the old model's list could
      // let through a level the new model does not list (#508 review).
      levelOption = levelOptionOf(res?.configOptions);
      // It took the set, yet names another model.
      modelLine =
        model === target
          ? undefined
          : {
              text: `${spec.name} took the model "${target}" but runs on "${model}"`,
            };
      return true;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      modelLine = {
        text:
          err instanceof RpcError
            ? `${spec.name} refused the model "${target}" (${why}); it runs on ${on}`
            : `${spec.name} did not confirm the model "${target}" (${why}); ` +
              `it may still run on ${on}`,
      };
      return false;
    }
  };
  /** Tells every client the result of a change: the model in use, or
   *  `null` when the harness names none, so each one reads the notice too.
   *  It also makes the room save `asked` and drop `pendingModel`. */
  const announceModel = (levelMoved = false) => {
    bus.emit({
      agent: id,
      update: {
        sessionUpdate: "_client_participant_changed",
        model: model ?? null,
        ...(levelMoved && { thoughtLevel: levelOption?.currentValue ?? null }),
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
  /** The change the live harness has not heard of, then its result. No
   *  level is sent (decided 2026-11-17, #501). Once the harness took the
   *  model, the same one again included, the level it reports is the level
   *  asked for, moved or not, so a revive changes nothing. The level line is
   *  the move, or none: no open request is left for a line to describe
   *  (#508 review). A refused model changes neither. */
  const sendWanted = async () => {
    const target = wanted;
    wanted = undefined;
    if (!agent || !target) return;
    const before = levelOption?.currentValue;
    const took = await applyModel(agent, target);
    const after = levelOption?.currentValue;
    const moved = after !== before;
    if (took) {
      const on = model ? ` with the model "${model}"` : "";
      askedLevel = after;
      levelLine = !moved
        ? undefined
        : {
            text:
              after === undefined
                ? `${spec.name} has no thinking level${on}; it was on "${before}"`
                : `${spec.name}'s thinking level moved ${before === undefined ? "" : `from "${before}" `}to "${after}"${on}`,
          };
    }
    announceModel(moved);
  };

  // The thinking level (M9-9): its option as the harness last sent it, the
  // line a refusal or a move left, the level a start asks for, and a change
  // the harness has not heard of yet, which `room.json` keeps.
  let levelOption: LevelOption | undefined;
  let levelLine: RoomNotice | undefined;
  let askedLevel = initialLevel;
  let wantedLevel = saved?.pendingThoughtLevel;
  /** Sets `target` on the live harness, only when the model lists it: pi
   *  and copilot take any value. A refusal, or a level it does not list,
   *  leaves the level it had and a line. Only a set the harness took
   *  becomes `askedLevel`. */
  const applyLevel = async (next: AcpAgent, target: string) => {
    const option = levelOption;
    const onModel = model ? ` on the model "${model}"` : "";
    if (!option) {
      levelLine = {
        text: `${spec.name} has no thinking level${onModel}, so the level "${target}" was not set`,
      };
      return;
    }
    const on = `the thinking level "${option.currentValue}"`;
    if (!levelsOf(option).some((l) => l.id === target)) {
      levelLine = {
        text: `${spec.name} does not list the thinking level "${target}"${onModel}, so it was not sent; it stays on ${on}`,
      };
      return;
    }
    try {
      const res = await next.setConfigOption(option.id, target);
      // The reply to a level set always held the option (§Thinking level);
      // one that does not leaves the list as it was.
      levelOption = levelOptionOf(res?.configOptions) ?? {
        ...option,
        currentValue: target,
      };
      askedLevel = target;
      const now = levelOption.currentValue;
      levelLine =
        now === target
          ? undefined
          : {
              text: `${spec.name} took the thinking level "${target}" but is on "${now}"`,
            };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      levelLine = {
        text:
          err instanceof RpcError
            ? `${spec.name} refused the thinking level "${target}" (${why}); it stays on ${on}`
            : `${spec.name} did not confirm the thinking level "${target}" (${why}); ` +
              `it may still be on ${on}`,
      };
    }
  };
  const announceLevel = () => {
    bus.emit({
      agent: id,
      update: {
        sessionUpdate: "_client_participant_changed",
        thoughtLevel: levelOption?.currentValue ?? null,
      },
    });
  };
  /** After a start's model: the level asked for, sent only when the harness
   *  reports another (decided 2026-11-17, #501). A pending change refused
   *  here leaves the level asked for before it, as for the model. */
  const syncLevel = async (next: AcpAgent) => {
    levelLine = undefined;
    const pending = wantedLevel;
    wantedLevel = undefined;
    const send = async (target: string) => {
      if (levelOption?.currentValue === target) askedLevel = target;
      else await applyLevel(next, target);
    };
    if (pending !== undefined && askedLevel !== undefined) {
      if (askedLevel !== pending) await send(askedLevel);
    }
    const target = pending ?? askedLevel;
    if (target !== undefined) await send(target);
    if (pending !== undefined) announceLevel();
  };
  /** The level change the live harness has not heard of, then its result. */
  const sendWantedLevel = async () => {
    const target = wantedLevel;
    wantedLevel = undefined;
    if (!agent || target === undefined) return;
    await applyLevel(agent, target);
    announceLevel();
  };
  /** What waits for the live harness: the model, then the level. */
  const sendPending = async () => {
    await sendWanted();
    await sendWantedLevel();
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
      // A start that failed carries its next step (M10-2): the room's open,
      // add or revive error shows it.
      if (session === undefined && err instanceof Error) {
        const help = startHelp(err, spec.setup, next.stderrLog);
        if (help) err.message += `\n${help}`;
      }
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
    levelOption = levelOptionOf(next.configOptions);
    await syncModel(next);
    // Then the level, after the model (M9-9).
    await syncLevel(next);
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
    else if (unsent()) ready = syncMode().then(sendPending);
    else if (wanted || wantedLevel !== undefined) ready = sendPending();
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

  // As `setModel`. With a live list and no model change waiting, an
  // unlisted level is refused here, before anything is sent (M9-9).
  const setLevel = async (next: string) => {
    if (agent && wanted === undefined) {
      const levels = levelOption ? levelsOf(levelOption) : [];
      if (!levels.some((l) => l.id === next)) {
        throw new RoomRefusal(
          "invalid_request",
          levels.length
            ? `"${next}" is not a thinking level of ${spec.name} on its model; it lists ${levels.map((l) => l.id).join(", ")}`
            : `${spec.name} has no thinking level on its model`,
        );
      }
    }
    wantedLevel = next;
    if (!agent || turn || held || stopping) return;
    await hold(sendWantedLevel());
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
    get thoughtLevel() {
      return levelOption?.currentValue;
    },
    get thoughtLevels() {
      const list = agent && levelOption && levelsOf(levelOption);
      return list?.length ? list : undefined;
    },
    get notices() {
      return [
        ...notices(),
        ...modeLines,
        ...modeSend(),
        ...(modelLine ? [modelLine] : []),
        ...(levelLine ? [levelLine] : []),
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
    setLevel,
    asked: () => asked,
    pending: () => wanted,
    askedLevel: () => askedLevel,
    pendingLevel: () => wantedLevel,
    hold,
    renamed: () => branchRenamed,
    syncCheckout,
    turns: () => turns,
    turnCancelled: () => turnCancelled,
  };
}
