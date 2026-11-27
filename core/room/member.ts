/**
 * One participant's add, remove and save, for any owner (M12-8c). A room
 * (`core/room.ts`) is one owner; a chat with one agent can be another. The
 * owner keeps its roster, its log and its record file; this file opens a
 * participant's place and checkout, starts it, rolls a failed add back,
 * releases its checkout at a remove, and makes its record. The harness
 * itself is `core/room/participant.ts`.
 *
 * **The owner id names the work.** Each checkout runs in
 * `stateDirFor(root)/wt/<ownerId>/<participantId>`, on the branch
 * `kapelle/<ownerId>/<participantId>`, and an `ask` request waits in the
 * daemon's queue under the owner id (S12a).
 *
 * **A participant may pick its own folder** (M11-2, #476). An add with `cwd`
 * gets its checkout in that folder's repository, or runs in the folder itself
 * when it has no git or no commit. An add without `cwd` uses the owner's own
 * folder, except for an owner with `scratchDir`: there it gets an empty
 * folder of its own, which its release removes while it is still empty. The
 * record keeps the participant's `cwd`, or `scratch`, so a restore opens the
 * same place. `places.repositories` names the repository root of every
 * folder opened, besides the owner's own root, which the owner's record
 * already names. It keeps a root even after that participant leaves or an
 * add fails, so delete can find a kept checkout and its branch.
 *
 * **Never `commit` (R37).** The supervisor stays out of the commit business:
 * a participant commits its own branch, and whatever is left uncommitted at a
 * release stays in the checkout for a person to look at. `keep` is also the
 * right answer for a participant whose harness never got a session — an
 * untouched worktree is removed and its branch rolled back either way.
 */

import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

import {
  type ResolvedAgent,
  resolveAgent,
  type Warning,
} from "../../protocol/registry.ts";
import type { Seen } from "../check.ts";
import type { EventBus } from "../events.ts";
import { newParticipantId } from "../ids.ts";
import type { PermissionQueue } from "../permissions.ts";
import {
  createWatchdog,
  sweepIntervalMs,
  type Watchdog,
  type WatchdogLimits,
} from "../watchdog.ts";
import {
  BadBase,
  LinkPathError,
  openWorktrees,
  type WorktreeSetup,
} from "../worktree.ts";
import { createParticipant, type ParticipantControl } from "./participant.ts";
import {
  type AgentRequest,
  type Answer,
  type Participant,
  type ParticipantRecord,
  type ParticipantStatus,
  type RoomNotice,
  RoomRefusal,
} from "./types.ts";

export type Notify = (text: string, kind?: Warning["kind"]) => void;

/** Where one participant works: the owner's own setup, one for the folder
 *  it picked, or a scratch folder. `dir` is where it runs with no worktrees. */
export type Place = WorktreeSetup & { dir: string; scratch?: true };

/** The places of one owner's participants, each folder opened once. */
export function ownerPlaces(
  ownerId: string,
  cwd: string,
  setup: WorktreeSetup,
  openPlace?: (cwd: string, restoring: boolean) => Promise<WorktreeSetup>,
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
          : openWorktrees(dir, ownerId, { advisory: false })
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
    /** The owner's own repository is already in its record's `cwd`. */
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
export type Places = ReturnType<typeof ownerPlaces>;

/** A watchdog of an owner's own, with its sweep. `ttlMs` is 0, so it only
 *  warns and never cancels (R38). `stop` ends the sweep. */
export function ownWatchdog(
  bus: EventBus,
  { stallIdleMs, stallRepeatCount }: Omit<WatchdogLimits, "ttlMs">,
) {
  const limits: WatchdogLimits = { stallIdleMs, stallRepeatCount, ttlMs: 0 };
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
  const sweep = setInterval(() => watchdog.sweep(), sweepIntervalMs([limits]));
  // It watches harnesses that already keep the loop alive.
  sweep.unref();
  return { watchdog, limits, stop: () => clearInterval(sweep) };
}

/** §M0-4: every measured harness ends a cancelled turn within 64 ms, so a
 *  turn still live after 2 s is not going to end by itself. An owner's
 *  pause waits this long. */
export const PAUSE_GRACE_MS = 2_000;

/** The lines after which an owner saves its record: each changes what
 *  `recordOf` gives. */
export const SAVED_ON: ReadonlySet<string> = new Set([
  "_client_participant_added",
  "_client_participant_changed",
  "_client_participant_removed",
  "_client_participant_revived",
  "_client_user_message",
  "_client_turn_ended",
  "_client_harness_exited",
]);

/** A stderr log per harness start in `dir`, as `AcpAgent` opens them with
 *  `ax`: a revive must not write into the first harness's file. */
export function stderrLogs(dir: string) {
  let starts = 0;
  return (participantId: string) => {
    const first = join(dir, `${participantId}.stderr.log`);
    // The time tells two daemons apart; the count, two starts in one
    // millisecond.
    starts += 1;
    return existsSync(first)
      ? join(dir, `${participantId}.${Date.now()}-${starts}.stderr.log`)
      : first;
  };
}

/** What an owner lends each participant, and what it hears back. A member
 *  reads some fields once, when it is made, and others at each call, so an
 *  owner never replaces a field once its first member exists. */
export interface Owner {
  /** Names the checkouts, the branches and the queue's asker. */
  id: string;
  bus: EventBus;
  /** Where an `ask` participant's requests wait for a person. */
  permissions: PermissionQueue;
  places: Places;
  /** Where an add with no `cwd` gets an empty folder of its own (M11-2). */
  scratchDir?: string;
  /** The owner's own notices, shown before each participant's. */
  notices: () => readonly RoomNotice[];
  /** Adds one: a release with no participant left to show it. */
  onNotice: Notify;
  /** The stderr log for this participant's next harness, or none. */
  stderrLog: (participantId: string) => string | undefined;
  /** True once the owner stops for good: no revive, no send. */
  stopped: () => boolean;
  /** What `status()` reports while the owner is stopped. A room dismisses a
   *  participant; a chat keeps a participant status and archives its
   *  lifecycle instead. */
  stoppedStatus?: ParticipantStatus;
  /** What a send refused because the owner stopped says. */
  stoppedMessage?: string;
  watchdog: Watchdog;
  limits: WatchdogLimits;
  /** Gets what each real session said (M9-4, `core/check.ts`). */
  noteSession?: (agent: string, seen: Seen) => void;
  /** A revive gave a harness a new process. */
  onRevive: () => void;
  /** A turn ended that was not a reply's or a copy's, and not cut by a stop
   *  (M8-2). */
  onTurnEnd: (worker: Participant, answer: Answer) => void;
  /** Something changed that no stream line carries, which a save keeps. */
  onChange: () => void;
  /** An add failed after it tried to start a harness. Its record, after the
   *  rollback, so a chat can keep the stderr log and a kept checkout
   *  (M11-14). */
  onAddFailed?: (saved: ParticipantRecord) => void;
}

/** One participant, and what its owner needs to end and save it. */
export interface Member extends ParticipantControl {
  spec: ResolvedAgent;
  source: AgentRequest["source"];
  /** Where it works, and the folder it asked for (M11-2). */
  place: Place;
  cwd?: string;
  /** Its own notices, which the record keeps. */
  own: RoomNotice[];
  onNotice: Notify;
}

type Info = { branch: string; baseSha: string; baseRef?: string };

function makeMember(
  owner: Owner,
  request: AgentRequest,
  id: string,
  place: Place,
  worktree: string,
  info: Info | undefined,
  own: RoomNotice[],
  saved?: ParticipantRecord,
): Member {
  const onNotice: Notify = (text, kind) =>
    own.push(kind ? { text, kind } : { text });
  const { noteSession } = owner;
  const made = createParticipant({
    id,
    ownerId: owner.id,
    permissions: owner.permissions,
    request,
    worktree,
    info,
    bus: owner.bus,
    notices: () => [...owner.notices(), ...own],
    stderrLog: () => owner.stderrLog(id),
    stopped: owner.stopped,
    ...(owner.stoppedStatus && { stoppedStatus: owner.stoppedStatus }),
    ...(owner.stoppedMessage && { stoppedMessage: owner.stoppedMessage }),
    watchdog: owner.watchdog,
    limits: owner.limits,
    ...(saved && { saved }),
    ...(noteSession && {
      report: (seen: Seen) => noteSession(request.spec.name, seen),
    }),
    onRevive: owner.onRevive,
    onTurnEnd: owner.onTurnEnd,
    onCheckout: (next) => {
      place.worktrees?.update(id, next);
      // No stream line carries this: the record and the next reply do.
      owner.onChange();
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
}

/**
 * Releases a checkout with `keep`. A release that throws — a locked
 * worktree, a missing git — must not strand the owner: the checkout is left
 * in place rather than committed or deleted, and `onNotice` is told, with the
 * path, because after a failed add it is the only record. Returns whether it
 * wrote a notice, so the caller never adds a second line about the same
 * checkout.
 */
export async function release(
  id: string,
  worktree: string | undefined,
  onNotice: Notify,
  place: Place,
): Promise<boolean> {
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
}

/**
 * The rollback half of the spawn, for an add that failed or met its owner's
 * stop. `keep` removes an untouched checkout and its branch, so the owner is
 * as it was. One the harness already wrote into is kept. A participant that
 * never joined has no notices of its own, so both lines go to the owner's.
 */
export async function rollback(
  owner: Owner,
  id: string,
  worktree: string | undefined,
  place: Place,
): Promise<void> {
  const named = await release(id, worktree, owner.onNotice, place);
  if (!named && place.worktrees && worktree && existsSync(worktree)) {
    owner.onNotice(
      `a participant that did not join left its worktree at ${worktree}: ` +
        "its harness wrote into it, so the worktree and its branch are kept",
    );
  }
}

/**
 * A new participant: its place, its checkout from `request.base`, and a
 * harness with a session. A failure rolls the checkout back and throws. The
 * caller puts it on its roster and logs `_client_participant_added`.
 */
export async function addMember(
  owner: Owner,
  request: AgentRequest,
): Promise<Member> {
  const { base } = request;
  const id = newParticipantId();
  const own: RoomNotice[] = [];
  // Taken here rather than in the participant, so a rollback knows which
  // path to look at.
  let worktree: string | undefined;
  let place = owner.places.home;
  let made: Member | undefined;
  try {
    if (request.cwd !== undefined) {
      place = await owner.places.open(request.cwd, false);
    } else if (owner.scratchDir !== undefined) {
      const dir = join(owner.scratchDir, id);
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
      owner.bus.emit({
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
    made = makeMember(owner, request, id, place, worktree, info, own);
    await made.launch();
    return made;
  } catch (err) {
    await rollback(owner, id, worktree, place);
    if (made) owner.onAddFailed?.(recordOf(made));
    // The record keeps a repository even when its add failed and left a
    // written checkout. A later delete must still find that work.
    owner.onChange();
    if (err instanceof BadBase) {
      throw new RoomRefusal("invalid_request", err.message);
    }
    throw err instanceof LinkPathError
      ? new RoomRefusal("invalid_config", err.message)
      : err;
  }
}

/**
 * A saved participant, as an earlier daemon left it. No harness starts: it
 * waits for its next message. Its checkout is held again, never created, and
 * read once, because a crash can leave the record older than the branch.
 */
export async function restoreMember(
  owner: Owner,
  saved: ParticipantRecord,
): Promise<Member> {
  const request: AgentRequest = {
    spec: resolveAgent(saved.agent ?? "", saved.cmd),
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
  const place = await owner.places.saved(saved);
  const info: Info | undefined =
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
    owner,
    request,
    saved.id,
    place,
    saved.worktree,
    info,
    [...saved.notices],
    saved,
  );
  await m.syncCheckout();
  return m;
}

/**
 * Stops a participant the caller already took off its roster, logs
 * `_client_participant_removed`, and releases its checkout. A kept checkout
 * is the owner's to report, since the participant is gone. Answers what
 * `release` does: whether the release wrote a notice.
 */
export async function removeMember(owner: Owner, m: Member): Promise<boolean> {
  const { id, worktree } = m.participant;
  // No `finally` for the release: `stop()` cannot reject. It awaits the
  // harness's exit, which only resolves, and a turn whose handlers only
  // emit on a bus that catches every listener. A step that can reject,
  // added to `stop()`, would strand this checkout with no notice.
  await m.stop();
  // After the stop, so the turn's end and the harness's exit come first
  // and this is the participant's last line.
  owner.bus.emit({
    agent: id,
    update: { sessionUpdate: "_client_participant_removed" },
  });
  return release(id, worktree, owner.onNotice, m.place);
}

/** The record of one participant, as its owner's record file keeps it. */
// One literal keeps every optional record field in the file's own order.
// pi-lens-ignore: high-complexity
export function recordOf(m: Member): ParticipantRecord {
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
}
