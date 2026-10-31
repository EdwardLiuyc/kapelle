/**
 * The watchdog — story M1c-1, issue #25.
 *
 * **One interval sweep for the whole run, not a timer per task.** Each task
 * still carries its own limits; the sweep simply compares each task against
 * its own numbers, so per-task settings and a single timer are not in tension.
 * The alternative — a deadline timer per signal per task — would have to be
 * cleared and re-armed on *every* event, and M0-4 measured 443 events in one
 * opencode turn (`docs/FINDINGS.md` §M0-4). Polling is the cheaper shape.
 *
 * Two signals, both chosen because they port across vendors:
 *
 * - **idle** — nothing on this task's bus for `stallIdleMs`, and no question
 *   waiting for a person.
 * - **repeat** — the same operation `stallRepeatCount` times running, which
 *   is the busy-loop case idle time structurally cannot see.
 *
 * **An operation is more than its title (#354).** claude names every shell
 * call `Terminal`, and pi names every read `read`: in our room logs, none of
 * the 195 same-title runs of 8 or more was one operation repeated
 * (`docs/FINDINGS.md` §Repeat by tool title). So two calls are the same when
 * their title, kind, whole `rawInput` and first location all match.
 *
 * **A call counts when it completes or fails (decided 2026-10-31 on #399).**
 * Its input comes in pieces: claude sends a shell command on the first
 * `tool_call_update`, and an `Edit`'s file first, its old and new text later.
 * Counted at the first update, eight edits of one file looked the same. So
 * every update is merged until the status is `completed` or `failed`. A call
 * that never gets there is never counted, so it can neither make a repeat nor
 * resolve one.
 *
 * **The whole input counts, prose included (decided 2026-10-31 on #399).**
 * claude's `description` is in the final input, so it is part of the
 * operation. A note that changes ("run 3 of 10") is more often planned work
 * than a stuck loop, and a false warning is the worse mistake.
 *
 * When a different operation follows a repeat warning, `onResolve` says the
 * loop is over. Only this module decides that; the chat reducer keeps no copy
 * of the rule.
 *
 * Both warn and the task keeps running. Only the longer `ttlMs` acts, and all
 * it does is ask the caller to cancel: ACP gives no way to nudge a turn in
 * flight, and a second `session/prompt` kills the running turn and reads as
 * prompt injection on two of the three harnesses (M0-4). So detection reports
 * rather than corrects, and there is deliberately no third rung.
 *
 * Every knob is disabled at `0`.
 *
 * **This module owns no timer.** `sweep()` is called by the caller's interval,
 * which is what lets an hour-long TTL be tested by moving a number.
 */

import { isDeepStrictEqual } from "node:util";

import type { AgentEventEnvelope } from "../protocol/agent.ts";

/** The two things a stalled task can look like. */
export type StallKind = "idle" | "repeat";

export interface WatchdogLimits {
  /** No events for this long → warn. `0` disables. */
  stallIdleMs: number;
  /** This many identical operations in a row → warn. `0` disables. */
  stallRepeatCount: number;
  /** Wall time for the whole task → cancel. `0` disables. */
  ttlMs: number;
}

/** Settled 2026-09-09 on #25. Minute-scale on purpose: these are the point at
 *  which a human would start wondering, not a performance budget. */
export const WATCHDOG_DEFAULTS: WatchdogLimits = {
  stallIdleMs: 300_000,
  stallRepeatCount: 8,
  ttlMs: 3_600_000,
};

/** Never busier than once a second, never lazier than once a minute. */
const MIN_SWEEP_MS = 1_000;
const MAX_SWEEP_MS = 60_000;

/**
 * How often to sweep, derived **once** from the limits the run actually asks
 * for.
 *
 * The sweep interval is the resolution of every check, so a fixed value would
 * silently round a small `stallIdleMs` up to the next tick. A quarter of the
 * finest limit keeps the error under 25% of what the operator asked for.
 * `stallRepeatCount` is a count, not a duration, and takes no part.
 */
export function sweepIntervalMs(limits: readonly WatchdogLimits[]): number {
  // `Math.min()` of nothing is `Infinity`, which clamps to the ceiling — the
  // right answer when every time limit is disabled.
  const finest = Math.min(
    ...limits.flatMap((l) => [l.stallIdleMs, l.ttlMs].filter((ms) => ms > 0)),
  );
  return Math.min(MAX_SWEEP_MS, Math.max(MIN_SWEEP_MS, finest / 4));
}

export interface WatchdogHooks {
  /** A stall was detected. Advisory: the task keeps running. */
  onWarn: (taskId: string, kind: StallKind, text: string) => void;
  /** A different operation followed the one a repeat warning named. */
  onResolve?: (taskId: string) => void;
  /** The TTL expired. The caller cancels; the watchdog never touches an agent. */
  onTimeout: (taskId: string) => void;
  /** Injected so a test can reach an hour-long TTL without waiting. */
  now?: () => number;
}

/** One task's handle. `note` is shaped to be handed straight to `addListener`.
 *  Not exported: `watch`'s return type carries it structurally, the same rule
 *  `core/events.ts` applies to `BusListener`. */
interface TaskWatch {
  note: (event: AgentEventEnvelope) => void;
  close: () => void;
}

export interface Watchdog {
  watch: (taskId: string, limits: WatchdogLimits) => TaskWatch;
  /** Feed an event to whichever watched task it names. */
  note: (event: AgentEventEnvelope) => void;
  /** One pass over every live task. Called by the caller's interval. */
  sweep: () => void;
}

/** What makes two calls one operation. Held from `tool_call` until the call
 *  completes or fails. */
interface Operation {
  title: string;
  kind?: string;
  // Free-form by protocol design (see `ToolCall.rawInput`).
  // pi-lens-ignore: no-unsafe-dictionary-unknown
  input: Record<string, unknown>;
  location?: { path: string; line?: number };
}

/** Calls that have not completed or failed. In our room logs, at most 6 ran
 *  at once (pi; claude 4). The cap only stops a harness that never ends its
 *  calls from growing this. A dropped call is never counted, so a drop
 *  restarts the count: the calls around a hole are not a run. It keeps the
 *  last operation, so the next call is judged against it as usual. If 64
 *  calls never end, every new call drops one and resets the count, so a
 *  repeat then counts only calls that complete with no new call between
 *  them. */
// ponytail: ten times the measured peak; raise it if a harness batches more.
const MAX_PENDING = 64;

interface WatchState {
  limits: WatchdogLimits;
  startedAt: number;
  lastEventAt: number;
  pending: Map<string, Operation>;
  /** The last counted operation. Its title goes in the warning. Once set, it
   *  is never cleared, so `repeatCount > 0` means it is set. */
  lastOperation?: Operation;
  repeatCount: number;
  /** A repeat warning is live: the next different operation resolves it. */
  repeatWarned: boolean;
  /** Questions asked and not yet answered. Idle does not count while one waits. */
  asking: number;
  idleWarned: boolean;
  timedOut: boolean;
}

export function createWatchdog(hooks: WatchdogHooks): Watchdog {
  const now = hooks.now ?? Date.now;
  const live = new Map<string, WatchState>();

  const note = (event: AgentEventEnvelope): void => {
    const state = live.get(event.agent);
    if (!state) return;

    state.lastEventAt = now();
    // Any traffic ends the idle spell, so the next one warns on its own merits.
    state.idleWarned = false;

    // A question waits for a person, not for the harness, so it pauses the
    // idle clock (#195). `AcpAgent` emits the pair around every policy call.
    if (event.update.sessionUpdate === "_client_permission_pending") {
      state.asking += 1;
    } else if (event.update.sessionUpdate === "_client_permission") {
      state.asking = Math.max(0, state.asking - 1);
    }

    if (state.limits.stallRepeatCount === 0) return;
    const u = event.update;
    if (
      u.sessionUpdate !== "tool_call" &&
      u.sessionUpdate !== "tool_call_update"
    ) {
      return;
    }
    let operation = state.pending.get(u.toolCallId);
    if (u.sessionUpdate === "tool_call") {
      operation = { title: u.title, input: {} };
      state.pending.set(u.toolCallId, operation);
      if (state.pending.size > MAX_PENDING) {
        const [oldest] = state.pending.keys();
        state.pending.delete(oldest);
        state.repeatCount = 0;
      }
    }
    if (!operation) return;
    // Merged key by key: a later value replaces an earlier one, and a key a
    // later message leaves out stays. `AcpAgent` keeps the last `rawInput`
    // whole instead. The measured shapes agree on both: claude resends a
    // growing input, and opencode's last update carries none.
    if (u.title !== undefined) operation.title = u.title;
    if (u.kind !== undefined) operation.kind = u.kind;
    Object.assign(operation.input, u.rawInput);
    const location = u.locations?.[0];
    if (location) {
      operation.location = {
        path: location.path,
        ...(location.line !== undefined && { line: location.line }),
      };
    }
    // A call counts once, when it ends. Updates before are its input
    // arriving, and updates after are dropped with it.
    if (u.status !== "completed" && u.status !== "failed") return;
    state.pending.delete(u.toolCallId);

    if (
      state.lastOperation &&
      isDeepStrictEqual(operation, state.lastOperation)
    ) {
      state.repeatCount += 1;
      return;
    }
    state.lastOperation = operation;
    state.repeatCount = 1;
    if (state.repeatWarned) {
      state.repeatWarned = false;
      hooks.onResolve?.(event.agent);
    }
  };

  return {
    watch(taskId, limits) {
      const started = now();
      live.set(taskId, {
        limits,
        startedAt: started,
        lastEventAt: started,
        pending: new Map(),
        repeatCount: 0,
        repeatWarned: false,
        asking: 0,
        idleWarned: false,
        timedOut: false,
      });
      return {
        note,
        close: () => {
          live.delete(taskId);
        },
      };
    },

    note,

    sweep() {
      const at = now();
      for (const [taskId, state] of live) {
        // Best-effort: a consumer that throws is that consumer's bug, never a
        // reason to leave the tasks behind it unchecked.
        try {
          check(taskId, state, at, hooks);
        } catch {
          // Deliberately swallowed. There is no sink here that is not itself
          // one of the hooks that just failed.
        }
      }
    },
  };
}

function check(
  taskId: string,
  state: WatchState,
  at: number,
  hooks: WatchdogHooks,
): void {
  const { stallIdleMs, stallRepeatCount, ttlMs } = state.limits;

  if (
    stallIdleMs > 0 &&
    state.asking === 0 &&
    !state.idleWarned &&
    at - state.lastEventAt > stallIdleMs
  ) {
    state.idleWarned = true;
    hooks.onWarn(
      taskId,
      "idle",
      `no activity for ${seconds(at - state.lastEventAt)}s — still running`,
    );
  }

  const last = state.lastOperation;
  if (
    stallRepeatCount > 0 &&
    last &&
    !state.repeatWarned &&
    state.repeatCount >= stallRepeatCount
  ) {
    state.repeatWarned = true;
    hooks.onWarn(
      taskId,
      "repeat",
      `${state.repeatCount}× "${last.title}" in a row — ` +
        `possible loop, still running`,
    );
  }

  // Wall time, not idle time: a task that streams steadily forever is exactly
  // what this rung is for.
  if (ttlMs > 0 && !state.timedOut && at - state.startedAt > ttlMs) {
    state.timedOut = true;
    hooks.onTimeout(taskId);
  }
}

const seconds = (ms: number): string => Math.round(ms / 1000).toString();
