/**
 * Runs — story M1b-2, issue #18.
 *
 * A Run owns N Tasks; a Task owns one agent, one worktree, one policy, one
 * result. This module is the pool that starts them and the arithmetic that
 * turns what came back into a status.
 *
 * **The roll-up is duration and turn count, and nothing else.** Those are the
 * only units that mean the same thing on every harness. Token figures stay on
 * the task that produced them, verbatim, tagged with the agent name — copilot
 * reports `usage` cumulatively where opencode and claude-agent-acp report it
 * per turn (M0-5), so a sum would be a number with no meaning. There is
 * deliberately no function here that adds two `Usage` objects together.
 *
 * **Status keys on the triple, not on `stopReason`.** M0-4 measured copilot
 * answering `end_turn` for a turn it had itself cancelled, against a control
 * run proving the turn was cut short — contrary to ACP's MUST. So the
 * supervisor's own record (did we send a cancel, did the watchdog fire) is
 * authoritative, and `stopReason` is consulted only where the two agree.
 *
 * The `exec` parameter of `runRun` is a seam, not an abstraction layer: the
 * concurrency invariant — never more than `maxConcurrency` subprocesses live —
 * cannot be observed from outside a real spawn, and a test that counted real
 * harnesses would be the slowest and flakiest thing in the suite. Same shape
 * as `validateRun`'s injected agent map: one defaulted parameter, one caller.
 */

import { AcpAgent, type Policy } from "../protocol/agent.ts";
import { resolveAgent, resolveEnv, warningsFor } from "../protocol/registry.ts";
import type { StopReason, Usage } from "../protocol/types.ts";
import { createEventBus, type EventBus } from "./events.ts";
import { negotiateSafeMode, policyFor } from "./policy.ts";
import type { Run, Task } from "./runfile.ts";

/**
 * Every terminal state a task can reach.
 *
 * Two have no producer in this module, deliberately and against the rule
 * `core/events.ts` follows for bus variants. `skipped` is minted by M3-1 when
 * a dependency fails; `warned` by M1b-4 when the result block and the diff
 * disagree. They are here because the *ordering* below is the thing being
 * decided, and a rung added to it later would rewrite M1b-4's table and its
 * test rather than extend them.
 */
export type TaskStatus =
  | "done"
  | "warned"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "failed";

/**
 * Mildest first. The run's status is the worst any task reached.
 *
 * The two middle rungs are placed by how much they should alarm someone
 * reading a summary: `cancelled` is operator-intended, so it is the mildest of
 * the bad states; `timed_out` means the supervisor cut a task off mid-tool-call
 * and left a half-written file on disk, so it ranks just below outright
 * failure (`docs/STORIES.md`, M1b-2 Gap 2 amendment).
 */
const BY_SEVERITY: readonly TaskStatus[] = [
  "done",
  "warned",
  "cancelled",
  "skipped",
  "timed_out",
  "failed",
];

/** What the supervisor knows about how a task ended. */
export interface StopRecord {
  /** Absent when the harness died before any turn ended. */
  stopReason?: StopReason;
  /** We sent `session/cancel` while this task was live. */
  cancelRequested: boolean;
  /** The watchdog cut it off. M1c-1 becomes the producer; today always false. */
  watchdogFired: boolean;
  /** The harness threw — failed to spawn, died mid-turn, refused the handshake. */
  threw?: boolean;
}

/**
 * The stop-reason table (`docs/STORIES.md`, M1b-2 Gap 1), keyed on the triple.
 *
 * Order matters: our own record is checked first and `stopReason` last,
 * because a harness that lies about the reason still cannot lie about whether
 * we pressed the button.
 */
export function statusFor(record: StopRecord): TaskStatus {
  if (record.watchdogFired) return "timed_out";
  if (record.cancelRequested) return "cancelled";
  if (record.threw || record.stopReason === undefined) return "failed";

  switch (record.stopReason) {
    case "end_turn":
      return "done";
    // Truncated mid-turn, possibly mid-edit. Indistinguishable from success
    // without this table, which is the whole reason the table exists.
    case "max_tokens":
      return "failed";
    case "max_turn_requests":
      return "failed";
    // The agent declined. `summary` carries its text once M1b-4 extracts one.
    case "refusal":
      return "failed";
    // Nobody on our side asked, so the harness cancelled its own turn. Still
    // a turn that was cut short, and still not a success.
    case "cancelled":
      return "cancelled";
  }
}

/** The worst status any task reached. An empty run cannot happen —
 *  `validateRun` rejects a run file with no tasks. */
export function runStatus(statuses: readonly TaskStatus[]): TaskStatus {
  let worst: TaskStatus = "done";
  for (const status of statuses) {
    if (BY_SEVERITY.indexOf(status) > BY_SEVERITY.indexOf(worst)) {
      worst = status;
    }
  }
  return worst;
}

/**
 * Where a task runs. **This is the seam M1b-3 (#19) fills in.**
 *
 * Today every task runs in the run's own working directory, which is only
 * safe because M1 runs a run file whose tasks were given non-colliding work —
 * exactly the caveat `fanout.mjs` carries today. #19 replaces the body with
 * `git worktree add` off `task.worktree` (a base ref, never a path) into
 * `.agent-team/wt/<runId>/<task.id>`, and nothing else in this file moves.
 *
 * ponytail: a getter with no matching release. #19 needs teardown too — keep
 * the worktree on failure, remove it on success — and owns designing that
 * pair; inventing half of it here would be scaffolding for a story that has
 * not been written yet.
 */
export function taskCwd(_task: Task, runCwd: string): string {
  return runCwd;
}

/** One task's record. `usage` is per task and never summed; `agent` is the
 *  tag that says whose counting rules produced it. */
export interface TaskRun {
  id: string;
  agent: string;
  cwd: string;
  status: TaskStatus;
  stopReason?: StopReason;
  usage?: Usage;
  durationMs: number;
  /** The agent's prose, buffered. Interleaving N token streams is unreadable,
   *  so nothing prints it until the task is over. */
  transcript: string;
  /** Present only when the task threw. The message, not the stack: this is
   *  printed, and M1b-7 keeps the real stderr on disk. */
  error?: string;
}

export interface RunReport {
  status: TaskStatus;
  durationMs: number;
  /** One prompt per session per task (M0-4: never a nudge, and `prompt()`
   *  throws on a second call), so this counts the tasks that got far enough
   *  to send one. It stops being trivially `tasks.length` the moment a spawn
   *  fails or the operator cancels the queue. */
  turns: number;
  tasks: TaskRun[];
}

/** Not exported: `TaskExecutor` below carries the shape structurally, so an
 *  executor is written without naming either half. Same rule `core/events.ts`
 *  applies to `BusListener` — exported when something imports it. */
interface TaskContext {
  cwd: string;
  /** This task's own bus. Already wired to forward to the run's bus, so an
   *  executor neither filters by task nor knows the run exists. */
  bus: EventBus;
  /** Aborted when the operator cancels the run. */
  signal: AbortSignal;
  verbose: boolean;
  /** Already resolved for this task: the run's `askPolicy` when this task asks
   *  and one was supplied, otherwise `policyFor(task.mode)`. Settled here so
   *  the executor never re-decides who may approve what. */
  policy: Policy;
  /** Containment and negotiation notices. **Not** on the bus: `--quiet`
   *  switches the bus's renderer off and #13 says these lines are never
   *  silenced, so they take a route `--quiet` cannot reach. */
  onNotice: (text: string) => void;
  /** Called by the real executor immediately before `session/prompt`, so the
   *  run's turn count counts prompts sent, not tasks attempted. A task whose
   *  harness cannot start sends no prompt and must not count as a turn. */
  onTurn: () => void;
}

interface TaskOutcome {
  stopReason?: StopReason;
  usage?: Usage;
}

/**
 * Executes one task. The real implementation is `runTask`; tests inject this
 * seam to observe the pool without spawning harnesses.
 *
 * An executor must call `ctx.onTurn()` immediately before it sends the task's
 * prompt — the run's turn count counts prompts sent, not tasks attempted.
 */
export type TaskExecutor = (
  task: Task,
  ctx: TaskContext,
) => Promise<TaskOutcome>;

export interface RunOptions {
  /** The run's working directory. `taskCwd` derives each task's from it. */
  cwd: string;
  /** Every task's events, tagged with the task id in `agent`. */
  bus: EventBus;
  signal?: AbortSignal;
  verbose?: boolean;
  /**
   * An interactive decider for `ask` tasks.
   *
   * **One prompt cannot serve two askers**, so the caller supplies this only
   * when it has checked that at most one task in the run asks *and* that a TTY
   * exists — `run.ts` does both, and re-resolves the rest as `safe`. Absent,
   * an `ask` task falls back to `policyFor("ask")`. M2-3 replaces this with a
   * pending-decision queue over the API, which is what makes `ask` work for N
   * tasks at once.
   */
  askPolicy?: Policy;
  /** Notices a run must print even under `--quiet` (#13). */
  onNotice?: (taskId: string, text: string) => void;
}

/**
 * Run every task, at most `maxConcurrency` at a time.
 *
 * A fixed pool of workers pulling from one shared queue, rather than a
 * chunked `Promise.all` per batch: a batch runs at the speed of its slowest
 * member and leaves the pool half idle, and the difference is free here.
 */
export async function runRun(
  run: Run,
  options: RunOptions,
  exec: TaskExecutor = runTask,
): Promise<RunReport> {
  const started = Date.now();
  const signal = options.signal ?? new AbortController().signal;
  const results = new Array<TaskRun>(run.tasks.length);
  const queue = run.tasks.map((task, index) => ({ task, index }));
  let turns = 0;
  const onTurn = () => {
    turns += 1;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const { task, index } = next;

      // A task the operator cancelled before it started is `cancelled`, not
      // `skipped` — `skipped` means a *dependency* failed, and M1 has none.
      if (signal.aborted) {
        results[index] = {
          id: task.id,
          agent: task.agent,
          cwd: taskCwd(task, options.cwd),
          status: "cancelled",
          durationMs: 0,
          transcript: "",
        };
        continue;
      }

      results[index] = await runOne(task, exec, signal, options, onTurn);
    }
  };

  const width = Math.min(run.maxConcurrency, run.tasks.length);
  await Promise.all(Array.from({ length: width }, worker));

  return {
    status: runStatus(results.map((r) => r.status)),
    durationMs: Date.now() - started,
    turns,
    tasks: results,
  };
}

async function runOne(
  task: Task,
  exec: TaskExecutor,
  signal: AbortSignal,
  options: RunOptions,
  onTurn: () => void,
): Promise<TaskRun> {
  const cwd = taskCwd(task, options.cwd);
  const started = Date.now();

  // Its own bus, forwarding to the run's. One `addListener` rather than the
  // executor filtering the shared stream by task id — `core/events.ts` has no
  // removeListener, so a per-task listener on the shared bus would pile up.
  const bus = createEventBus();
  bus.addListener(options.bus.emit);
  let transcript = "";
  bus.addListener(({ update }) => {
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content?.type === "text") transcript += update.content.text;
    }
  });

  // Read at settle time, not after: a run cancelled a tick after this task
  // finished cleanly must still read as `done`.
  let cancelRequested = false;
  const record = () => {
    cancelRequested = signal.aborted;
  };

  const base = {
    id: task.id,
    agent: task.agent,
    cwd,
    transcript: "",
  };

  try {
    const outcome = await exec(task, {
      cwd,
      bus,
      signal,
      verbose: options.verbose ?? false,
      policy:
        task.mode === "ask" && options.askPolicy
          ? options.askPolicy
          : policyFor(task.mode),
      onNotice: (text) => options.onNotice?.(task.id, text),
      onTurn,
    });
    record();
    const result: TaskRun = {
      ...base,
      transcript,
      status: statusFor({
        stopReason: outcome.stopReason,
        cancelRequested,
        watchdogFired: false,
      }),
      durationMs: Date.now() - started,
    };
    if (outcome.stopReason !== undefined)
      result.stopReason = outcome.stopReason;
    if (outcome.usage !== undefined) result.usage = outcome.usage;
    return result;
  } catch (err) {
    record();
    return {
      ...base,
      transcript,
      status: statusFor({ cancelRequested, watchdogFired: false, threw: true }),
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The real executor: one harness subprocess, one session, one prompt.
 *
 * Everything policy-shaped was already settled by `validateRun` — mode, the
 * harness ceiling, `allowReadOutsideRoot`. This function resolves none of it
 * again; it only spends what it was given.
 */
async function runTask(task: Task, ctx: TaskContext): Promise<TaskOutcome> {
  const spec = resolveAgent(task.agent, task.cmd);

  const agent = new AcpAgent({
    // The task id, not the agent id: two tasks may name the same harness, and
    // the id is what a reader needs to tell their events apart.
    name: task.id,
    command: spec.launch.command,
    args: spec.launch.args,
    env: resolveEnv(spec.launch.env),
    cwd: ctx.cwd,
    policy: ctx.policy,
    allowReadOutsideRoot: task.allowReadOutsideRoot,
    verbose: ctx.verbose,
    onEvent: ctx.bus.emit,
  });

  const onAbort = () => agent.cancel();
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const init = await agent.start();

    // The containment notice is never silenced (#13). Handed to the caller
    // rather than printed here, because a run has N of them and only the
    // caller knows how to label a line with the task it came from.
    for (const w of warningsFor(
      spec.name,
      spec,
      task.mode,
      init.agentInfo?.version,
    )) {
      ctx.onNotice(w.text);
    }

    await agent.newSession();
    const notNegotiated = await negotiateSafeMode(agent, spec, task.mode);
    if (notNegotiated) ctx.onNotice(notNegotiated);

    // Count at the prompt boundary, not at spawn: a task that fails to start
    // sends no prompt, and a task cancelled before this line sends none either.
    ctx.onTurn();
    const { stopReason, usage } = await agent.prompt(task.prompt);
    return usage === undefined ? { stopReason } : { stopReason, usage };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    agent.stop();
  }
}
