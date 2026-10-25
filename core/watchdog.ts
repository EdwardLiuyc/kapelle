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
 * - **repeat** — the same logical tool operation `stallRepeatCount` times
 *   running, which is the busy-loop case idle time structurally cannot see.
 *   Identity is title, kind and stable `rawInput`/location, with title and
 *   kind as the fallback. `toolCallId` correlates updates and is never the
 *   identity itself: a new id is a new call, not necessarily a new operation.
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
  /** This many identical tool operations in a row → warn. `0` disables. */
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

interface ToolOperation {
  id: string;
  title: string;
  kind: string;
  input: Record<string, string>;
  location?: string;
  identity: string;
}

interface WatchState {
  limits: WatchdogLimits;
  startedAt: number;
  lastEventAt: number;
  lastTitle?: string;
  lastIdentity?: string;
  repeatCount: number;
  operations: ToolOperation[];
  /** Tool calls by id, so a late update refines the operation it belongs to. */
  byId: Map<string, ToolOperation>;
  /** Questions asked and not yet answered. Idle does not count while one waits. */
  asking: number;
  idleWarned: boolean;
  repeatWarned: boolean;
  timedOut: boolean;
}

/** Keep enough to compare a command without retaining a whole heredoc. */
const STABLE_TEXT = 800;

/** The `rawInput` keys that identify one operation, in a stable order. */
const STABLE_INPUT_KEYS = [
  "command",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
  "url",
] as const;

// `rawInput` is ACP's free-form JSON, so this decoder narrows it.
// pi-lens-ignore: no-unknown-parameters, no-runtime-typeof, no-known-value-widening, no-unsafe-dictionary-unknown
const stableInput = (raw: unknown): Record<string, string> => {
  // pi-lens-ignore: no-runtime-typeof
  if (typeof raw !== "object" || raw === null) return {};
  // pi-lens-ignore: no-known-value-widening
  const input: Record<string, string> = {};
  for (const key of STABLE_INPUT_KEYS) {
    // pi-lens-ignore: no-unsafe-dictionary-unknown
    const value = (raw as Record<string, unknown>)[key];
    // pi-lens-ignore: no-runtime-typeof
    if (typeof value === "string" && value) {
      input[key] = value.slice(0, STABLE_TEXT);
    }
  }
  return input;
};

/** Title and kind, then a stable detail when there is one (`rawInput` first). */
const identityOf = (operation: ToolOperation): string => {
  const input = STABLE_INPUT_KEYS.flatMap((key) => {
    const value = operation.input[key];
    return value ? [`${key}=${value}`] : [];
  });
  let detail: string[] = [];
  if (input.length > 0) detail = input;
  else if (operation.location) detail = [`location=${operation.location}`];
  return JSON.stringify([operation.title, operation.kind, detail]);
};

/** Keeps the history the check needs and nothing more: the last threshold
 *  operations are enough to tell whether a streak reaches it. */
function trimOperations(state: WatchState): void {
  const excess = state.operations.length - state.limits.stallRepeatCount;
  if (excess <= 0) return;
  for (const old of state.operations.splice(0, excess)) {
    if (state.byId.get(old.id) === old) state.byId.delete(old.id);
  }
}

/** Recomputes the trailing streak after a call or a late identity update. */
function refreshRepeat(state: WatchState): void {
  const last = state.operations.at(-1);
  if (!last) {
    state.repeatCount = 0;
    state.lastTitle = undefined;
    state.lastIdentity = undefined;
    state.repeatWarned = false;
    return;
  }
  let count = 1;
  for (let i = state.operations.length - 2; i >= 0; i--) {
    if (state.operations[i]?.identity !== last.identity) break;
    count += 1;
  }
  state.repeatCount = count;
  if (state.lastIdentity !== last.identity) {
    state.repeatWarned = false;
    state.lastIdentity = last.identity;
  }
  state.lastTitle = last.title;
  if (count < state.limits.stallRepeatCount) state.repeatWarned = false;
}

/** Starts or refines an operation; only a `tool_call` starts a new one. */
function recordTool(
  state: WatchState,
  update: AgentEventEnvelope["update"],
): void {
  if (state.limits.stallRepeatCount <= 0) return;
  /** The wire is free-form JSON: keep only a comparable prefix of each text. */
  const bounded = (value: unknown) =>
    typeof value === "string" ? value.slice(0, STABLE_TEXT) : "";
  if (update.sessionUpdate === "tool_call") {
    const operation: ToolOperation = {
      id: update.toolCallId,
      title: bounded(update.title),
      kind: bounded(update.kind ?? ""),
      input: stableInput(update.rawInput),
      identity: "",
    };
    const location = bounded(update.locations?.[0]?.path);
    if (location) operation.location = location;
    operation.identity = identityOf(operation);
    const known = state.byId.get(update.toolCallId);
    if (known) {
      known.title = operation.title;
      known.kind = operation.kind;
      Object.assign(known.input, operation.input);
      // pi-lens-ignore: deep-nesting
      if (operation.location) known.location = operation.location;
      known.identity = identityOf(known);
    } else {
      state.operations.push(operation);
      state.byId.set(update.toolCallId, operation);
    }
  } else if (update.sessionUpdate === "tool_call_update") {
    const operation = state.byId.get(update.toolCallId);
    if (!operation) return;
    if (update.title !== undefined) operation.title = bounded(update.title);
    if (update.kind !== undefined) operation.kind = bounded(update.kind);
    Object.assign(operation.input, stableInput(update.rawInput));
    const location = bounded(update.locations?.[0]?.path);
    if (location) operation.location = location;
    operation.identity = identityOf(operation);
  } else {
    return;
  }
  trimOperations(state);
  refreshRepeat(state);
}

// One timer, one map and the sweep's closures; the tool logic is in recordTool.
// pi-lens-ignore: high-complexity
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

    recordTool(state, event.update);
  };

  return {
    watch(taskId, limits) {
      const started = now();
      live.set(taskId, {
        limits,
        startedAt: started,
        lastEventAt: started,
        repeatCount: 0,
        operations: [],
        byId: new Map(),
        asking: 0,
        idleWarned: false,
        repeatWarned: false,
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
    !state.repeatWarned &&
    state.repeatCount >= stallRepeatCount
  ) {
    state.repeatWarned = true;
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
