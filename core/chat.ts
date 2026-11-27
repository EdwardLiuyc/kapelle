/**
 * A chat: one agent outside every room (M11-12, #556; M11 D1).
 *
 * **A chat is not a room.** It has no roster, no orchestrator, no title, no
 * turn cap and no `@name`. It is one owner (`core/room/member.ts`) with one
 * member, so its agent is a room participant's parts: the same harness,
 * revive, mode, model, level and checkout code. Neither one is a kind of the
 * other.
 *
 * **Its folder is `<stateDir>/chats/<id>/`**: `chat.json` and the log
 * `events.jsonl`, whose line is `{seq, at, chatId, update}`
 * (`core/eventlog.ts`). The folder is one for the whole daemon, not one per
 * repository. `chat.json` is saved as `room.json` is: whole, a moment after
 * each line that changes it. It names the repository root of each folder
 * the chat opened (#476), so the sweep and a remove find its checkout and
 * branch. Its `updatedAt` moves at each of those saves while the chat is
 * live (a message, a turn's end, a revive, a mode, model or level change),
 * never at a pause or a restore. A remove sets it to `removedAt`, which
 * dates the remove.
 *
 * **Where it works.** In a repository it gets the checkout
 * `wt/<chatId>/<participantId>` on the branch `kapelle/<chatId>/<participantId>`,
 * so each chat owns its branches and a remove touches no other chat. A folder
 * with no git, or a repository with no commit, is used as it is. With no
 * folder it gets an empty scratch folder under `<stateDir>/scratch/chats/`,
 * which its remove deletes while it is still empty (M11-2).
 *
 * **A restart** restores the chat from `chat.json` with no harness started.
 * The next message revives it, with `session/load` where the harness keeps
 * one. A daemon shutdown is a pause, as for a room.
 *
 * **A remove goes `active` → `removing` → `archived`.** The record says
 * `removing` first. Then the turn and the queue are cancelled, which denies
 * its open questions, and the harness stops. The checkout is released as at
 * a room participant's remove: an untouched one goes with its branch, and
 * one with work is kept and a notice names it. The log closes, the folder
 * moves to `<stateDir>/chats/archive/<id>/`, and its record says `archived`.
 * A daemon that dies part way leaves the record at `removing`, before or
 * after the move; `finishChatRemove` does the rest at the next boot.
 *
 * **An open that fails after it tried to start a harness is archived at
 * once** (M11-14, decided at pickup 2026-11-27, #557). The harness may have
 * written into its checkout, and its stderr log is the one clue to why it
 * failed. So the folder moves to the archive with a record, as a remove
 * leaves it, and the boot sweep (`core/sweep.ts`) keeps it and reaps it as
 * any archive. The open's error names the archived folder and the kept
 * checkout. If the archive cannot be written, the live folder stays with
 * the stderr log, and its checkout follows the sweep's orphan rule. An open
 * that fails before a harness starts keeps nothing.
 *
 * Nothing reaches the API yet: M11-13 adds the routes.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import type { ClientMode } from "../protocol/registry.ts";
import type { Seen } from "./check.ts";
import { createEventLog, type EventLog, reopenEventLog } from "./eventlog.ts";
import type { EventBus } from "./events.ts";
import { isChatId, newChatId } from "./ids.ts";
import type { PermissionQueue } from "./permissions.ts";
import {
  addMember,
  type Member,
  type Notify,
  type Owner,
  ownerPlaces,
  ownWatchdog,
  PAUSE_GRACE_MS,
  type Place,
  recordOf,
  release,
  removeMember,
  restoreMember,
  SAVED_ON,
  stderrLogs,
} from "./room/member.ts";
import {
  adoptCheckout,
  crashedParticipant,
  readParticipantRecord,
  writeRecord,
} from "./room/record.ts";
import {
  type AgentRequest,
  type Participant,
  type ParticipantRecord,
  type RoomNotice,
  RoomRefusal,
} from "./room/types.ts";
import { checkCeiling } from "./room/validate.ts";
import { stateDir } from "./runtime.ts";
import { WATCHDOG_DEFAULTS, type WatchdogLimits } from "./watchdog.ts";
import type { WorktreeSetup } from "./worktree.ts";

type ChatLifecycle = "active" | "removing" | "archived";
const LIFECYCLES: readonly ChatLifecycle[] = ["active", "removing", "archived"];

/** `chat.json`. */
export interface ChatRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: ChatLifecycle;
  /** When its remove started: the retention reap (M11-14) and the archive
   *  list (M11-16) read it. */
  removedAt?: string;
  /** The chat's own lines: a log it cannot write, a checkout its remove
   *  kept. Its agent shows them before its own. */
  notices: RoomNotice[];
  /** The repository root of each folder the chat opened (#476). */
  repositories?: string[];
  participant: ParticipantRecord;
}

/** Every live chat's folder is in it, and so is `archive/`. */
export const chatsDir = () => join(stateDir(), "chats");

/** A live chat's folder. */
export const chatDir = (id: string) => join(chatsDir(), id);

/** A removed chat's folder. */
export const archivedChatDir = (id: string) => join(chatsDir(), "archive", id);

/** What `openChat` and `restoreChat` both take. */
interface ChatDeps {
  /** The chat's own bus: its log writes every event on it. */
  bus: EventBus;
  /** Where an `ask` agent's requests wait for a person. */
  permissions: PermissionQueue;
  /** The watchdog's warn limits; `WATCHDOG_DEFAULTS` when absent. */
  limits?: Pick<WatchdogLimits, "stallIdleMs" | "stallRepeatCount">;
  /** How long `pause` waits for a cancelled turn to end. */
  pauseGraceMs?: number;
  /** Gets what each real session said (M9-4, `core/check.ts`). */
  noteSession?: (agent: string, seen: Seen) => void;
  /** Opens the agent's folder: the project's links, then `openWorktrees`,
   *  as a room's `openPlace` does. Without it, a folder opens with no
   *  links. */
  openPlace?: (cwd: string, restoring: boolean) => Promise<WorktreeSetup>;
}

export interface Chat {
  readonly id: string;
  /** Its one agent. `send` and `cancel` are the chat's own. */
  readonly participant: Participant;
  readonly eventLog: EventLog | undefined;
  lifecycle(): ChatLifecycle;
  setMode(mode: ClientMode): void;
  setModel(model: string): Promise<void>;
  setLevel(level: string): Promise<void>;
  /** A daemon shutdown: the turn is cancelled, the harness stops, and the
   *  checkout and record stay for `restoreChat`. */
  pause(): Promise<void>;
  /** Removes the chat and answers the notices the remove added, such as a
   *  kept checkout. */
  remove(): Promise<readonly RoomNotice[]>;
}

function assertChatId(id: string): void {
  if (!isChatId(id)) throw new Error(`invalid chat id ${JSON.stringify(id)}`);
}

/**
 * A new chat, once its agent has a session. The id is new, or refused when
 * it is already a live or an archived chat's folder (`core/ids.ts`). A
 * harness that cannot start is a throw. Its folder goes to the archive, so
 * its stderr log and a kept checkout stay known (see the file header).
 */
export async function openChat({
  id = newChatId(),
  agent,
  ...deps
}: ChatDeps & { id?: string; agent: AgentRequest }): Promise<Chat> {
  assertChatId(id);
  if (agent.role !== undefined) {
    throw new RoomRefusal("invalid_request", "a chat has no roles");
  }
  const dir = chatDir(id);
  if (existsSync(archivedChatDir(id))) {
    throw new Error(`chat ${id} already exists, archived`);
  }
  mkdirSync(chatsDir(), { recursive: true });
  // Not recursive: the folder is the claim, so two opens of one id cannot
  // both take it.
  try {
    mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`chat ${id} already exists`);
    }
    throw err;
  }
  const now = new Date().toISOString();
  const claim: OpenClaim = {};
  try {
    return await buildChat(
      deps,
      { id, createdAt: now, updatedAt: now },
      agent,
      claim,
    );
  } catch (err) {
    // A harness start keeps the folder for its stderr log, whether or not it
    // could be archived. A failure before that leaves nothing worth keeping.
    if (!claim.keepFolder) rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * The chat `chat.json` names, as an earlier daemon left it. No harness
 * starts: its agent waits, `paused`, `killed` or `exited`, for its next
 * message. Its checkout is held again, never created, and its log reopened
 * with `seq` carried on. A chat that is not `active` throws. So does one
 * whose harness no longer resolves: a room keeps such a participant as a
 * tombstone (#312), and a chat has no roster to keep it in. M11-13 restores
 * chats at boot and decides what it does with that chat; the boot sweep
 * only finishes removes and reaps archives (M11-14).
 */
export async function restoreChat({
  id,
  ...deps
}: ChatDeps & { id: string }): Promise<Chat> {
  assertChatId(id);
  const record = readChatRecord(join(chatDir(id), "chat.json"), id);
  if (record.lifecycle !== "active") {
    throw new Error(`chat ${id} is ${record.lifecycle}, not active`);
  }
  const { createdAt, updatedAt } = record;
  return buildChat(
    deps,
    { id, createdAt, updatedAt },
    {
      ...record,
      participant: crashedParticipant(record.participant),
    },
  );
}

/**
 * Finishes a remove a daemon left at `removing`. The boot sweep calls it
 * (M11-14), before M11-13's boot restores the live chats (`restoreChat`).
 * Before the move, the harness died with the daemon: the checkout is
 * released here, then the folder moves. After the move only the record is
 * left to say `archived`. Answers the notices it added. It throws when the
 * saved folder cannot be opened, such as a repository that is gone; the
 * chat then stays `removing`, so the caller must survive the throw.
 */
export async function finishChatRemove(
  id: string,
  { openPlace }: Pick<ChatDeps, "openPlace"> = {},
): Promise<readonly RoomNotice[]> {
  assertChatId(id);
  const live = chatDir(id);
  const at = existsSync(join(live, "chat.json")) ? live : archivedChatDir(id);
  const record = readChatRecord(join(at, "chat.json"), id);
  if (record.lifecycle !== "removing") {
    throw new Error(`chat ${id} is ${record.lifecycle}, not removing`);
  }
  const notices = [...record.notices];
  const before = notices.length;
  const saved = record.participant;
  if (at === live) {
    const places = ownerPlaces(
      id,
      live,
      { worktrees: null, root: live },
      openPlace,
      record.repositories,
    );
    const place = await places.saved(saved);
    adoptCheckout(place.worktrees, saved);
    const onNotice: Notify = (text, kind) =>
      notices.push(kind ? { text, kind } : { text });
    if (!(await release(saved.id, saved.worktree, onNotice, place))) {
      nameKept(saved, place, notices);
    }
  } else {
    // The move only follows a release. A checkout still on disk was kept, but
    // a second crash, after the move and before this record write, lost its
    // notice with the live record. Name it again before finishing.
    nameKeptSaved(saved, notices);
  }
  // Persist the notices before the folder moves, as `remove` does, so a second
  // crash cannot lose them whether it lands before or after the move.
  writeRecord(join(at, "chat.json"), { ...record, notices });
  archive(id, at, { ...record, notices });
  return notices.slice(before);
}

/** Names a checkout a release kept, once, when the record has already moved. */
function nameKeptSaved(
  p: { worktree: string; branch?: string; scratch?: true },
  notices: RoomNotice[],
): void {
  if (!p.scratch && p.branch === undefined) return;
  const text = keptText(p);
  if (!text || notices.some((n) => n.text.includes(p.worktree))) return;
  notices.push({ text });
}

/** The line that names a checkout a release kept with work in it. */
function keptText(p: {
  worktree: string;
  branch?: string;
  scratch?: true;
}): string | undefined {
  if (!existsSync(p.worktree)) return undefined;
  if (p.scratch) {
    return `the scratch folder ${p.worktree} is kept: it holds work`;
  }
  const on = p.branch ? ` on ${p.branch}` : "";
  return `the checkout ${p.worktree}${on} is kept: it holds work`;
}

/** Names a checkout a release kept with work in it, once: a `keep` release
 *  removes only an untouched checkout, and says nothing of one it keeps. */
function nameKept(
  p: { worktree: string; branch?: string },
  place: Place,
  notices: RoomNotice[],
): void {
  if (!place.worktrees) return;
  const text = keptText(p);
  // A remove a crash cut short can come here twice.
  if (text && !notices.some((n) => n.text === text)) notices.push({ text });
}

/** Whether a failed `openChat` keeps the live folder it claimed. The live
 *  folder is kept when a harness started, whether or not the archive could
 *  be written; it still holds the stderr log a person needs. */
type OpenClaim = { keepFolder?: boolean };

/** Moves a chat's folder to the archive, unless it is there, and marks it
 *  `archived`. */
function archive(id: string, at: string, record: ChatRecord): void {
  const to = archivedChatDir(id);
  if (at !== to) {
    mkdirSync(join(chatsDir(), "archive"), { recursive: true });
    renameSync(at, to);
  }
  writeRecord(join(to, "chat.json"), { ...record, lifecycle: "archived" });
}

/**
 * Archives an open that failed after it tried to start a harness, dated
 * now, and makes its error name the folder that holds the stderr log and
 * each notice, such as a kept checkout. A folder that cannot move stays at
 * its live path, so the stderr log is still there to read; its checkout
 * then follows the sweep's orphan rule.
 */
function keepFailedOpen(record: ChatRecord, err: Error | undefined): void {
  const removedAt = new Date().toISOString();
  const from = chatDir(record.id);
  const to = archivedChatDir(record.id);
  const lines = record.notices.map((n) => n.text);
  let keptAt: string | undefined;
  try {
    archive(record.id, from, { ...record, updatedAt: removedAt, removedAt });
    keptAt = to;
    lines.push(`the chat's folder and stderr log are kept in ${to}`);
  } catch (moveErr) {
    // A failed write after the rename leaves the folder in the archive. A
    // failed rename or mkdir leaves it at the live path.
    if (existsSync(from)) keptAt = from;
    else if (existsSync(to)) keptAt = to;
    lines.push(
      `cannot archive the chat's folder: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`,
    );
    if (keptAt) {
      lines.push(`the chat's folder and stderr log are kept in ${keptAt}`);
    }
  }
  if (err === undefined) return;
  // The start's help names the stderr log where it was written.
  if (keptAt) err.message = err.message.replaceAll(from, keptAt);
  for (const line of lines) err.message += `\n${line}`;
}

/** The chat both entries build: a new agent from `agent`, or the one
 *  `from` saved. Nothing is saved until the agent is there. */
// One closure holds the chat's state, as `buildRoom` does.
// pi-lens-ignore: high-complexity
async function buildChat(
  {
    bus,
    permissions,
    limits = WATCHDOG_DEFAULTS,
    pauseGraceMs = PAUSE_GRACE_MS,
    noteSession,
    openPlace,
  }: ChatDeps,
  meta: Pick<ChatRecord, "id" | "createdAt" | "updatedAt">,
  start: AgentRequest | ChatRecord,
  claim?: OpenClaim,
): Promise<Chat> {
  const from = "lifecycle" in start ? start : undefined;
  const { id } = meta;
  const dir = chatDir(id);
  const notices: RoomNotice[] = from ? [...from.notices] : [];
  const onNotice: Notify = (text, kind) =>
    notices.push(kind ? { text, kind } : { text });

  const logPath = join(dir, "events.jsonl");
  let eventLog: EventLog | undefined;
  try {
    const onError = (err: Error) =>
      onNotice(`cannot write event log: ${err.message}`);
    const log = from
      ? await reopenEventLog(logPath, onError)
      : createEventLog(logPath, onError);
    eventLog = log;
    bus.addListener(({ update }) => log.append({ chatId: id, update }));
  } catch (err) {
    onNotice(
      `cannot write chat logs to ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const watch = ownWatchdog(bus, limits);
  // The chat's own folder is never a place: its agent always has a folder
  // or a scratch folder. So every root opened is in `repositories`.
  const places = ownerPlaces(
    id,
    dir,
    { worktrees: null, root: dir },
    openPlace,
    from?.repositories,
  );
  let lifecycle: ChatLifecycle = "active";
  let removedAt: string | undefined;
  let removing: Promise<readonly RoomNotice[]> | undefined;
  let pausing: Promise<void> | undefined;
  let member: Member | undefined;

  const record = (m: Member): ChatRecord => {
    const repositories = places.repositories();
    return {
      ...meta,
      lifecycle,
      ...(removedAt && { removedAt }),
      notices: [...notices],
      ...(repositories.length > 0 && { repositories }),
      participant: recordOf(m),
    };
  };
  let saving = false;
  let saveFailed = false;
  const save = () => {
    if (!saving || !member) return;
    try {
      writeRecord(join(dir, "chat.json"), record(member));
    } catch (err) {
      // Once: a full disk would add the same line on every turn.
      if (saveFailed) return;
      saveFailed = true;
      onNotice(
        `cannot save the chat record in ${dir}: ` +
          `${err instanceof Error ? err.message : String(err)}; ` +
          "a daemon restart brings this chat back as it was at its last save",
      );
    }
  };
  // Each save a change asks for moves `updatedAt`, while the chat is live.
  // A pause or a remove stops the harness, and its exit line asks for a save
  // too: that save keeps the clock, since a stop is no activity. A remove
  // sets the clock itself, to `removedAt`.
  let saveQueued = false;
  const saveSoon = () => {
    if (saveQueued || !saving) return;
    saveQueued = true;
    setImmediate(() => {
      saveQueued = false;
      if (!saving) return;
      if (!removing && !pausing) meta.updatedAt = new Date().toISOString();
      save();
    });
  };
  bus.addListener(({ update }) => {
    if (SAVED_ON.has(update.sessionUpdate)) saveSoon();
  });

  const nextStderr = stderrLogs(dir);
  let failed: ParticipantRecord | undefined;
  const owner: Owner = {
    id,
    bus,
    permissions,
    places,
    scratchDir: join(stateDir(), "scratch", "chats"),
    notices: () => notices,
    onNotice,
    stderrLog: (pid) => (eventLog ? nextStderr(pid) : undefined),
    stopped: () => removing !== undefined,
    // A chat's lifecycle says it was archived. Its participant keeps one of
    // the chat statuses rather than reading a room's `dismissed`.
    stoppedStatus: "idle",
    stoppedMessage: "the chat is removed",
    watchdog: watch.watchdog,
    limits: watch.limits,
    ...(noteSession && { noteSession }),
    onRevive: () => {},
    // A chat has nobody to send an answer on to.
    onTurnEnd: () => {},
    onChange: saveSoon,
    onAddFailed: (saved) => {
      failed = saved;
    },
  };

  let m: Member;
  try {
    if (from) {
      m = await restoreMember(owner, from.participant);
    } else {
      const request = start as AgentRequest;
      m = await addMember(owner, request);
      bus.emit({
        agent: m.participant.id,
        update: {
          sessionUpdate: "_client_participant_added",
          name: request.name,
          harness: request.spec.name,
          mode: request.mode,
        },
      });
    }
  } catch (err) {
    watch.stop();
    try {
      await eventLog?.close();
    } catch {
      // Keep the cause that stopped the chat from opening.
    }
    if (failed) {
      // Even if archiving fails, keep the folder: it holds the stderr log.
      if (claim) claim.keepFolder = true;
      const repositories = places.repositories();
      keepFailedOpen(
        {
          ...meta,
          lifecycle: "archived",
          notices,
          ...(repositories.length > 0 && { repositories }),
          participant: { ...failed, status: "exited" },
        },
        err instanceof Error ? err : undefined,
      );
    }
    throw err;
  }
  member = m;
  const pid = m.participant.id;

  const removed = () =>
    new RoomRefusal(
      "room_dismissed",
      removing ? "the chat is removed" : "the chat is paused",
    );
  const ended = () => removing !== undefined || pausing !== undefined;

  const remove = async () => {
    lifecycle = "removing";
    removedAt = new Date().toISOString();
    meta.updatedAt = removedAt;
    save();
    const before = notices.length;
    // The stop cancels the turn and the queue, so each open question is
    // denied, then the harness stops and the release follows.
    if (!(await removeMember(owner, m))) {
      nameKept(m.participant, m.place, notices);
    }
    watch.stop();
    save();
    // No save may land in the old folder once it moves.
    saving = false;
    await eventLog?.close();
    archive(id, dir, record(m));
    lifecycle = "archived";
    return notices.slice(before);
  };

  const chat: Chat = {
    id,
    participant: m.participant,
    eventLog,
    lifecycle: () => lifecycle,
    setMode(mode) {
      if (ended()) throw removed();
      try {
        checkCeiling(m.spec, mode);
      } catch (err) {
        throw new RoomRefusal(
          "invalid_request",
          err instanceof Error ? err.message : String(err),
        );
      }
      m.setMode(mode);
      bus.emit({
        agent: pid,
        update: { sessionUpdate: "_client_participant_changed", mode },
      });
    },
    async setModel(model) {
      if (ended()) throw removed();
      await m.setModel(model);
      // A deferred change sends no line yet, and must outlive a restart.
      saveSoon();
    },
    async setLevel(level) {
      if (ended()) throw removed();
      await m.setLevel(level);
      saveSoon();
    },
    pause() {
      if (removing) return removing.then(() => {});
      pausing ??= (async () => {
        try {
          await m.pause(pauseGraceMs);
        } finally {
          watch.stop();
          save();
          await eventLog?.close();
        }
      })();
      return pausing;
    },
    remove() {
      if (pausing) return Promise.reject(removed());
      removing ??= remove();
      return removing;
    },
  };
  saving = true;
  save();
  return chat;
}

/** `chat.json` for `id`, read and checked, or a throw naming what is wrong. */
export function readChatRecord(path: string, id: string): ChatRecord {
  const bad = (why: string) => new Error(`${path}: ${why}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw bad(err instanceof Error ? err.message : String(err));
  }
  if (typeof raw !== "object" || raw === null) throw bad("not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !isChatId(r.id)) {
    throw bad('"id" is not a chat id');
  }
  if (r.id !== id) {
    throw bad(`"id" is ${JSON.stringify(r.id)}, not ${JSON.stringify(id)}`);
  }
  for (const key of ["createdAt", "updatedAt"]) {
    if (typeof r[key] !== "string") throw bad(`"${key}" is not a string`);
  }
  if (!LIFECYCLES.includes(r.lifecycle as ChatLifecycle)) {
    throw bad(`unknown lifecycle ${JSON.stringify(r.lifecycle)}`);
  }
  if (r.removedAt !== undefined && typeof r.removedAt !== "string") {
    throw bad('"removedAt" is not a string');
  }
  if (r.lifecycle !== "active" && r.removedAt === undefined) {
    throw bad(`"removedAt" is required when the lifecycle is ${r.lifecycle}`);
  }
  const repositories = r.repositories;
  if (
    repositories !== undefined &&
    (!Array.isArray(repositories) ||
      repositories.some((root) => typeof root !== "string"))
  ) {
    throw bad('"repositories" is not a list of strings');
  }
  // A finish reads each notice's text, so a bad one is named here.
  const notices = r.notices ?? [];
  if (
    !Array.isArray(notices) ||
    notices.some((n) => typeof (n as RoomNotice | null)?.text !== "string")
  ) {
    throw bad('"notices" is not a list of notices with a "text"');
  }
  const participant = readParticipantRecord(r.participant, (why) =>
    bad(`the participant: ${why}`),
  );
  if (participant.role !== undefined) {
    throw bad("the participant has a role; a chat has no roles");
  }
  if (participant.status === "dismissed") {
    throw bad(
      'the participant has status "dismissed"; a chat uses idle, busy, ' +
        "exited, paused or killed",
    );
  }
  return {
    ...(raw as ChatRecord),
    notices: notices as RoomNotice[],
    participant,
  };
}
