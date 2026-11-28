/**
 * One participant (M12-8b): its harness, from the spawn to the stop. It
 * knows no room (M12-8c): it has an owner, which lends it an id, notices, a
 * stop flag and a watchdog, and hears of each turn's end. Its add, remove and
 * record are `core/room/member.ts`; the queue is `core/room/turns.ts`.
 *
 * **A real session reports its models and login state** (M9-4) to
 * `noteSession`, from the `session/new` or `session/load` response and an
 * auth notice. A load gives a login state only for an agent whose load needs
 * one (M9-4b). The participant never waits for the notice.
 *
 * **A stopped participant revives on its next message.** `paused`, `killed`
 * and `exited` all take the same path: a new harness in the same checkout.
 * It loads the old session when the harness advertises `loadSession` and
 * the registry records a working load (`measured.loads`, M6-7b); the load's
 * replay never reaches the bus. Otherwise, or when the load fails, it opens
 * a fresh session and does not remember earlier turns (Half A). The log gets
 * `_client_participant_revived` and the participant reads `resumed:
 * "loaded"` or `"fresh"`. The mode is sent again either way: a load does not
 * keep it (§Mode after load). A stopped owner never revives it: the
 * participant then reads `dismissed` and refuses a send as `room_dismissed`,
 * a room's words, the one owner so far.
 *
 * **A load can remember less than the files show** (§M0-9). That happened
 * only to a harness stopped during a turn, cancelled or cut: the cut turn
 * stays in the history it replays. So a load after `killed`, or after any
 * cancel before its prompt settled since the last revive (a person's, or a
 * pause's), says so with `memoryMayBeBehind`. A settled prompt whose checkout
 * read is still running is not a live harness turn, so a cancel or pause in
 * that window records no cut. Such a participant can read `idle` or
 * `paused`; the owner's record keeps the cancel as `turnCancelled`, which only
 * the next revive reads and clears (decided 2026-10-08, #179; the person's
 * cancel added in #238). So the flag is about the last revive, not about
 * the session's whole history.
 *
 * **A harness may rename its branch or rebase it (M6-6a).** After every turn
 * the participant reads the checkout again (`checkoutIdentity`): the branch
 * `HEAD` names, and the commit the branch's own reflog says its latest rebase
 * moved it onto. A rename updates the participant, and the owner follows it
 * into the held checkout and its record (`onCheckout`); a client that shows
 * the branch reads its owner again when the turn ends. A rebase also
 * moves the participant's saved `baseSha`. The whole-branch diff independently
 * finds the current merge base from the configured base ref, so it does not
 * depend on this reflog read. A restore reads the checkout once too, because a
 * crash can leave the owner's record older than the branch.
 *
 * **Each participant has its own mode** (M6-5, R12): `auto` by default,
 * `ask` or `safe` at add, and changed by `update` at any time. The filter
 * reads the mode live, so a change applies to the next request. The
 * harness's own mode follows before the next turn: `harnessModeId` picks
 * `modeMap.safe` for `safe` and `modeMap.ask` for the other two, never
 * `modeMap.auto`. An `ask` request waits in the daemon's queue, named by
 * owner id, participant and turn (S12a). When a turn ends for any reason, its
 * open decisions are denied as `cancel`; a mode that leaves `ask` answers
 * them as `mode_change`.
 *
 * **A participant may ask for a model** (M9-5). The participant sets the
 * session's option with `category: "model"` after every start, a load too,
 * right after the mode, so before the first turn. Whether a load keeps the
 * model was not measured; sending it again makes that not matter (decided
 * 2026-10-29). A
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
 * `null` when the harness names none. The owner's record keeps a change not yet
 * sent, so a pause or a restart does not drop it (#398 review). A
 * pending change refused at a start leaves the last model the harness took,
 * not the session's own: that one is set again first.
 *
 * **A participant may ask for a thinking level** (M9-9), at its add or
 * during a chat, as for the model. It is the option with `category:
 * "thought_level"`, and its list belongs to the model (§Thinking level). The
 * participant keeps that option as the harness last sent it: the session's, then
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
 * The answer a turn keeps for its reply follows the rules at the top of
 * `core/room.ts` (M8-2).
 */

import { AcpAgent, type Policy, RpcError } from "../../protocol/agent.ts";
import {
  type ClientMode,
  resolveEnv,
  warningsFor,
} from "../../protocol/registry.ts";
import type { AgentEvent, SessionConfigOption } from "../../protocol/types.ts";
import {
  failureSeen,
  modelsOf,
  noticeSeen,
  type Seen,
  sessionSeen,
  startHelp,
} from "../check.ts";
import type { EventBus } from "../events.ts";
import type { OwnerAsker, PermissionQueue } from "../permissions.ts";
import { harnessModeId, modeLine, policyFor } from "../policy.ts";
import type { Watchdog, WatchdogLimits } from "../watchdog.ts";
import { checkoutIdentity } from "../worktree.ts";
import { createTurns, type Message } from "./turns.ts";
import {
  type AgentRequest,
  ANSWER_CAP,
  type Answer,
  type Participant,
  type ParticipantRecord,
  type ParticipantStatus,
  type RoomNotice,
  RoomRefusal,
} from "./types.ts";

/** The longest start of `text` that fits in `bytes` of UTF-8. A streaming
 *  decode holds back a character the cut would split. */
const fitBytes = (text: string, bytes: number) =>
  new TextDecoder().decode(Buffer.from(text).subarray(0, bytes), {
    stream: true,
  });

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

/** Who the participant is, and where it starts. */
interface Seat {
  id: string;
  /** Its owner's id, which the permission queue names it by. */
  ownerId: string;
  request: AgentRequest;
  /** Its own checkout, or the cwd when there are no worktrees. */
  worktree: string;
  info: { branch: string; baseSha: string; baseRef?: string } | undefined;
  /** A restored participant's record; absent for a new one. */
  saved?: ParticipantRecord;
  /** Who a question names for turn `turn`; a room's participant when
   *  absent. A chat names itself (M11-13). */
  asker?: (turn: number) => OwnerAsker;
}

/** What its owner lends it. */
interface Lent {
  bus: EventBus;
  permissions: PermissionQueue;
  /** The owner's and the checkout's notices; the participant adds the lines
   *  that depend on its mode. */
  notices: () => readonly RoomNotice[];
  /** The stderr log for the next harness, or undefined for none. */
  stderrLog: () => string | undefined;
  /** True once the owner stops for good: no revive, no send. */
  stopped: () => boolean;
  /** What `status()` reports while `stopped()` is true. A room dismisses a
   *  participant; a chat's lifecycle owns removal, so it stays `idle`. */
  stoppedStatus?: ParticipantStatus;
  /** What a send refused because the owner stopped says. */
  stoppedMessage?: string;
  watchdog: Watchdog;
  limits: WatchdogLimits;
}

/** What it tells its owner. */
interface Hooks {
  /** A revive gave the harness a new process. */
  onRevive: () => void;
  /** A turn ended that was not a reply's or a copy's, and not cut by a
   *  stop: a room sends its answer on (M8-2). */
  onTurnEnd: (worker: Participant, answer: Answer) => void;
  /** The checkout's branch or rebase base changed; the owner follows it in
   *  the held checkout record. Absent when there is no worktree. */
  onCheckout?: (next: {
    branch: string;
    baseSha?: string;
    renamed?: boolean;
  }) => void;
  /** Where what a session said goes (M9-4). */
  report?: (seen: Seen) => void;
}

/** What the owner drives a participant with, beside its `Participant`. */
export interface ParticipantControl {
  participant: Participant;
  /** The model a revive asks for, which the owner's record keeps: the
   *  request's, or the last one the person changed to that the harness took. */
  asked: () => string | undefined;
  /** A change not yet sent, which the owner's record keeps too. */
  pending: () => string | undefined;
  /** The same two for the thinking level (M9-9). */
  askedLevel: () => string | undefined;
  pendingLevel: () => string | undefined;
  stop: () => Promise<void>;
  pause: (graceMs: number) => Promise<void>;
  launch: () => Promise<unknown>;
  turns: () => number;
  turnCancelled: () => boolean;
  setMode: (mode: ClientMode) => void;
  setModel: (model: string) => Promise<void>;
  setLevel: (level: string) => Promise<void>;
  hold: <T>(work: Promise<T>) => Promise<T>;
  /** True when `branch` is a name the harness renamed into, proven by the
   *  branch's own reflog. */
  renamed: () => boolean;
  /** Re-reads the checkout after a turn, or once when a record is restored.
   *  Updates this participant and the held checkout; true when the branch or
   *  the rebase base changed. */
  syncCheckout: () => Promise<boolean>;
}

/**
 * One participant. A new one has no harness until the owner calls `launch`;
 * a restored one has none until its next message revives it. On a throw,
 * `launch` has stopped whatever it started; the caller releases the
 * checkout.
 */
export function createParticipant({
  id,
  ownerId,
  asker,
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
  stopped: ownerStopped,
  stoppedStatus = "dismissed",
  stoppedMessage = "the room is dismissed",
  watchdog,
  limits,
  saved,
  onRevive,
  onTurnEnd,
  onCheckout,
  report,
}: Seat & Lent & Hooks): ParticipantControl {
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
      ? permissions.ownerPolicy(
          asker?.(turns) ?? { roomId: ownerId, participantId: id, turn: turns },
          id,
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
  // The owner's record keeps it, so a pause or a restart does not drop it.
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
   *  It also makes the owner save `asked` and drop `pendingModel`. */
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
  // the harness has not heard of yet, which the owner's record keeps.
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

  /** True once the prompt phase is over: the prompt settled, or starting it
   *  failed before it was sent. The live turn can stay set through the
   *  checkout read that follows. */
  let promptSettled = false;
  /** Set by a remove, a dismiss or a pause: nothing starts after it. */
  let stopping = false;

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
          if (!stopping) stopped = queue.live ? "killed" : "exited";
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
      // A start that failed carries its next step (M10-2): an open, add or
      // revive error shows it.
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
    { text, from, kind }: Message,
    ended: () => void,
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
      if (answer && !stopping && !ownerStopped())
        onTurnEnd(participant, answer);
    };
    let ready: Promise<void> | undefined;
    if (!agent) ready = revive();
    else if (unsent()) ready = syncMode().then(sendPending);
    else if (wanted || wantedLevel !== undefined) ready = sendPending();
    // **Before the turn's own end line**, so a client that reloads the diff
    // on `_client_turn_ended` already has the rebased `baseSha`, and one that
    // reads its owner again then sees the new branch.
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
    return (ready ? ready.then(prompt) : Promise.resolve(prompt()))
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
        turnFrom = undefined;
        ended();
      });
  };

  const queue = createTurns({
    id,
    bus,
    begin,
    closed: () => Boolean(stopped) || stopping || ownerStopped(),
  });
  const { drop, hold } = queue;

  // The harness answers a cancel within 64 ms on every measured build
  // (§M0-4), and `stop()` closes stdin after it, which ends the turn for one
  // that ignores the cancel.
  const stop = async () => {
    stopping = true;
    drop();
    // A settled prompt is over: only its checkout read runs. A late
    // session/cancel can abort background work, and no turn is live.
    if (queue.live && !promptSettled) {
      turnAbort.abort();
      agent?.cancel();
    }
    await agent?.stop();
    await queue.settled();
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
    const live = promptSettled ? undefined : queue.live;
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
    await queue.settled();
    stopped = cut ? "killed" : (before ?? "paused");
    // Ended by the cancel: `paused`, though its memory may be behind.
    turnCancelled ||= live !== undefined && !cut;
  };

  // The filter follows at once; the harness's own mode before the next turn.
  // A question that waits under `ask` gets the new mode's answer.
  const setMode = (next: ClientMode) => {
    const leftAsk = mode === "ask" && next !== "ask";
    mode = next;
    if (leftAsk) permissions.answerParticipant(ownerId, id, next === "auto");
    if (agent) agent.allowReadOutsideRoot = readsOutside();
    warn();
  };

  // An idle harness hears of a new model at once, held, so a message sent
  // meanwhile waits behind the set. A busy one hears of it before its next
  // turn, and one with no harness at its next start (#301).
  const setModel = async (next: string) => {
    wanted = next;
    if (!agent || queue.busy() || stopping) return;
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
    if (!agent || queue.busy() || stopping) return;
    await hold(sendWantedLevel());
  };

  /** What the harness did to its own checkout: renamed the branch, or moved
   *  the commit its work starts from with a rebase. A git read that fails
   *  leaves the identity already recorded; a bad base would be worse than a
   *  stale one. The owner follows the change into the held checkout and the
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
      // A positive rename makes the new name the owner's; any other switch
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
      if (ownerStopped()) return stoppedStatus;
      if (queue.busy()) return "busy";
      return stopped ?? "idle";
    },
    get queued() {
      return queue.queued;
    },
    get turnFrom() {
      return turnFrom;
    },
    get orderedBy() {
      return orderedBy;
    },
    send(text, sender, kind) {
      if (ownerStopped()) {
        throw new RoomRefusal("room_dismissed", stoppedMessage);
      }
      if (stopping) {
        throw new RoomRefusal("agent_exited", "the agent is stopping");
      }
      // A copy, so a rename while it waits does not change the line its
      // harness reads. A screen names `from` by the roster, so it shows the
      // new name: the id is what lasts.
      const from = sender && { id: sender.id, name: sender.name };
      return queue.send({ text, from, kind });
    },
    cancel() {
      if (!queue.live || promptSettled) return false;
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
