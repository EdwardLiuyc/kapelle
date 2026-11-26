/**
 * A chat room — a container with a roster of participants (M6-2).
 *
 * **The room owns each harness's lifetime.** A run spawns a harness, sends one
 * prompt and stops it (`core/run.ts`). A room spawns a participant's harness
 * once, sends a prompt per message, and stops it when the room is dismissed
 * or paused. Measured safe on all four harnesses: a prompt sent after
 * `end_turn` completes on the same session with the first turn's context kept
 * (`docs/FINDINGS.md` §Multi-turn). The room is one owner of participants
 * (M12-8c): one participant's add, remove and record are
 * `core/room/member.ts`; its harness, from its spawn to its stop, with its
 * revive, mode, model and level, is `core/room/participant.ts`; its queue is
 * `core/room/turns.ts`. The room keeps the roster, the log, `room.json`, the
 * reply to a sender and the turn cap.
 *
 * **A daemon shutdown is a pause, not a dismiss** (M6-7a, R42c). `pause`
 * cancels each live turn, waits `pauseGraceMs` (2 s, §M0-4) for it to end,
 * stops each harness and keeps every checkout as it is: nothing is released.
 * A participant whose turn ended reads `paused`; one whose cancel outlived
 * the grace reads `killed`, because its memory may not match its files
 * (R46). A harness that dies by itself reads `killed` during a turn and
 * `exited` when idle.
 *
 * **One checkout per participant** (M6-6a, R14), named by the room's id
 * (`core/room/member.ts`), so turns run in parallel without touching each
 * other's files (R6). Nothing is shared or inherited. `add`
 * takes the base to fork from: any ref, including another participant's
 * branch (R35c). A branch holds only what its participant committed, so a
 * participant started from it never sees the other's uncommitted files (R37).
 *
 * **A participant may pick its own folder** (M11-2, decided 2026-11-19,
 * #476), as `core/room/member.ts` says. The hall is the room with
 * `scratchDir`. `room.json` keeps the repository root of every folder the
 * room opened for a participant, besides its own root, which its `cwd`
 * names. The room's record and log stay under the
 * room's own root; the boot sweep reads every room's record before it calls
 * a checkout an orphan (`core/sweep.ts`).
 *
 * **A kept checkout lasts while its room has a record.** The boot sweep
 * (`core/sweep.ts`) keeps every checkout under a room that has a
 * `room.json`, dismissed rooms too, until `DELETE /rooms/:id` or the
 * sweep's retention reap removes the room (`removeRoom`, #235).
 *
 * **A roster that changes** (M6-3). `add`, `update` and `remove` change it
 * after the room opens. An add still in flight holds its name and role, so
 * two racing adds cannot both take the same name or the orchestrator role
 * (`core/room/validate.ts`). A removed participant leaves the roster. Its
 * checkout is released as at dismiss, and a release notice goes to the room's
 * notices, since the participant that would show it is gone. Each change is
 * on the log —
 * `_client_participant_added`, `_changed` and `_removed`, starters included —
 * so a client builds the roster from the stream alone (M6-10).
 *
 * **One participant's branch can fast-forward to another's** (M6-11a, R45).
 * `fastForward` runs `git merge --ff-only` inside the target's checkout,
 * refuses a busy target, a dirty one (2c) and a diverged one, moves no source
 * branch, and logs `_client_participant_fast_forwarded` when it actually moves
 * a commit. A move to the commit the target already has is a silent no-op.
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

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { MessageKind } from "../protocol/types.ts";
import type { Seen } from "./check.ts";
import {
  createEventLog,
  type EventLog,
  openEventLog,
  reopenEventLog,
} from "./eventlog.ts";
import type { EventBus } from "./events.ts";
import type { PermissionQueue } from "./permissions.ts";
import {
  addMember,
  type Member,
  type Notify,
  type Owner,
  ownerPlaces,
  ownWatchdog,
  PAUSE_GRACE_MS,
  type Places,
  recordOf,
  release,
  removeMember,
  restoreMember,
  rollback,
  SAVED_ON,
  stderrLogs,
} from "./room/member.ts";
import {
  crashed,
  roomDir,
  tombstoneUnknownAgents,
  writeRoomRecord,
} from "./room/record.ts";
import {
  type AgentRequest,
  ANSWER_CAP,
  type Answer,
  DEFAULT_ORCHESTRATOR_TURN_CAP,
  type Later,
  type Participant,
  type ParticipantChanges,
  type ParticipantRecord,
  type Room,
  type RoomMeta,
  type RoomNotice,
  type RoomRecord,
  RoomRefusal,
  type RoomStatus,
} from "./room/types.ts";
import { checkCeiling, clash } from "./room/validate.ts";
import { WATCHDOG_DEFAULTS, type WatchdogLimits } from "./watchdog.ts";
import {
  BadBase,
  DirtyCheckout,
  fastForwardCheckout,
  NotFastForward,
  type WorktreeSetup,
} from "./worktree.ts";

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

export interface RoomOptions extends RoomDeps {
  roomId: string;
  /** The folder the room was asked for; the harness runs here when there is
   *  no worktree, and at the same subdirectory inside one when there is. */
  cwd: string;
  title?: string;
  /** From `roomAgents`, added in this order. */
  agents: AgentRequest[];
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
  const places = ownerPlaces(roomId, cwd, deps.setup, deps.openPlace);
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
  const places = ownerPlaces(
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

  // One sweep for the room, as for a run.
  const watch = ownWatchdog(bus, limits);

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
  bus.addListener(({ update }) => {
    if (SAVED_ON.has(update.sessionUpdate)) saveSoon();
  });

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
        watch.stop();
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
        watch.stop();
        save();
        await eventLog?.close();
      }
    })();
    return pausing;
  };

  const nextStderr = stderrLogs(logDir);
  const stderrFor = (id: string) => (eventLog ? nextStderr(id) : undefined);

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

  const owner: Owner = {
    id: roomId,
    bus,
    permissions,
    places,
    ...(scratchDir !== undefined && { scratchDir }),
    notices: () => roomNotices,
    onNotice: onRoomNotice,
    stderrLog: stderrFor,
    stopped: () => dismissing !== undefined,
    watchdog: watch.watchdog,
    limits: watch.limits,
    ...(noteSession && { noteSession }),
    onRevive: () => {
      paused = false;
    },
    onTurnEnd: answer,
    onChange: saveSoon,
  };

  const spawn = async (request: AgentRequest) => {
    const made = await addMember(owner, request);
    // A dismiss or pause that began while this harness was starting did not
    // see it.
    if (ended()) {
      await made.stop();
      await rollback(
        owner,
        made.participant.id,
        made.participant.worktree,
        made.place,
      );
      throw dismissed();
    }
    members.push(made);
    participants.push(made.participant);
    paused = false;
    const { role } = request;
    bus.emit({
      agent: made.participant.id,
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
      return await spawn(request);
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
    await removeMember(owner, found);
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
      const m = await restoreMember(owner, saved);
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
    watch.stop();
    try {
      await eventLog?.close();
    } catch {
      // Keep the cause that stopped the room from opening.
    }
    throw err;
  }
}
