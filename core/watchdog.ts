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
 * call `Terminal`, and pi names every read `read`: 185 of 185 same-title runs
 * of 8 or more in our room logs were different commands. So two calls are the
 * same when their title, kind, whole `rawInput` and first path all match. A
 * call counts at its first `tool_call_update`, not at `tool_call`: claude,
 * opencode and pi send the command and the real title there (§M0-3, #240).
 * When the next operation differs from the one a repeat warning named,
 * `onResolve` says the loop is over. Only this module decides that; the chat
 * reducer keeps no copy of the rule.
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
  /** The operation a repeat warning named was followed by another one. */
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

/** A call announced by `tool_call` and not counted yet. */
interface Call {
  title: string;
  kind?: string;
  // Free-form by protocol design (see `ToolCall.rawInput`).
  // pi-lens-ignore: no-unsafe-dictionary-unknown
  input: Record<string, unknown>;
  path?: string;
}

/** Calls that wait for their first update. pi was measured sending 581
 *  calls before an earlier call's update, so this must stay well above that.
 *  It only stops a harness that never sends an update from growing this
 *  without bound; a call dropped here is never counted. */
const MAX_PENDING = 4_096;

interface WatchState {
  limits: WatchdogLimits;
  startedAt: number;
  lastEventAt: number;
  pending: Map<string, Call>;
  /** The last counted operation, as `identity` writes it, and its title. */
  lastOperation?: string;
  lastTitle?: string;
  repeatCount: number;
  /** The operation the live repeat warning named. */
  warnedOperation?: string;
  /** Questions asked and not yet answered. Idle does not count while one waits. */
  asking: number;
  idleWarned: boolean;
  timedOut: boolean;
}

/** Two calls are one operation when these all match. */
const identity = (call: Call): string =>
  JSON.stringify([call.title, call.kind, call.input, call.path]);

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
    if (u.sessionUpdate === "tool_call") {
      state.pending.set(u.toolCallId, {
        title: u.title,
        ...(u.kind !== undefined && { kind: u.kind }),
        input: { ...u.rawInput },
        ...(u.locations?.[0] && { path: u.locations[0].path }),
      });
      if (state.pending.size > MAX_PENDING) {
        const [oldest] = state.pending.keys();
        state.pending.delete(oldest);
      }
      return;
    }
    // A call counts once, at its first update. Later ones are progress on it,
    // and counting them would make one slow tool look like a loop.
    if (u.sessionUpdate !== "tool_call_update") return;
    const call = state.pending.get(u.toolCallId);
    if (!call) return;
    state.pending.delete(u.toolCallId);
    if (u.title !== undefined) call.title = u.title;
    if (u.kind !== undefined) call.kind = u.kind;
    // Merged: an update sends only what changed.
    Object.assign(call.input, u.rawInput);
    if (u.locations?.[0]) call.path = u.locations[0].path;

    const operation = identity(call);
    if (operation === state.lastOperation) {
      state.repeatCount += 1;
      return;
    }
    state.lastOperation = operation;
    state.lastTitle = call.title;
    state.repeatCount = 1;
    if (state.warnedOperation !== undefined) {
      state.warnedOperation = undefined;
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

  if (
    stallRepeatCount > 0 &&
    state.warnedOperation === undefined &&
    state.repeatCount >= stallRepeatCount
  ) {
    state.warnedOperation = state.lastOperation;
    hooks.onWarn(
      taskId,
      "repeat",
      `${state.repeatCount}× "${state.lastTitle}" in a row — ` +
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
