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

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AcpAgent, type Policy } from "../protocol/agent.ts";
import {
  resolveAgent,
  resolveEnv,
  type Warning,
  warningsFor,
} from "../protocol/registry.ts";
import type { StopReason, Usage } from "../protocol/types.ts";
import { createEventBus, type EventBus } from "./events.ts";
import { newRunId } from "./ids.ts";
import { negotiateSafeMode, policyFor } from "./policy.ts";
import {
  type AgentResult,
  crossCheck,
  extractResult,
  type ResultWarning,
  synthesiseSummary,
  withResultPreamble,
} from "./result.ts";
import type { Run, Task } from "./runfile.ts";
import {
  openWorktrees,
  STATE_DIR,
  type Worktrees,
  workingTreeStatus,
} from "./worktree.ts";

/**
 * Every terminal state a task can reach.
 *
 * Two have no producer in this module, deliberately and against the rule
 * `core/events.ts` follows for bus variants. `skipped` is minted by M3-1 when
 * a dependency fails. `warned` has its producer as of M1b-4: `runOne` promotes
 * a `done` task to it when the cross-check disagrees with the block the agent
 * sent. They are here because the *ordering* below is the thing being decided,
 * and a rung added to it later would rewrite the table and its test rather
 * than extend them.
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
  /**
   * The operator cancelled the run while this task was live.
   *
   * **Intent, not delivery.** An earlier draft of this said "we sent
   * `session/cancel`", which the code never measured and should not: a task
   * still queued when ^C lands, and a task aborted before it had a session,
   * both had no notification to send and are plainly `cancelled` rather than
   * `failed`. Keying on the send would label those wrongly, and it is the
   * operator's intent that M0-4 made authoritative over a `stopReason` the
   * harness may have lied about.
   *
   * One consequence is deliberate: a harness that fails to spawn *during* a
   * cancel reads as `cancelled`, not `failed`. The spawn error is not lost —
   * it stays on `TaskRun.error` and is printed either way.
   */
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
  /** The `<task-result>` block the agent sent, when it sent a valid one
   *  (M1b-4). This record *is* the story's `TaskResult`: the agent-reported
   *  half here, the observed half in the fields above. */
  result?: AgentResult;
  /** Absent when the agent and the working tree agreed about everything.
   *  Never fatal — a non-empty list promotes `done` to `warned`, and nothing
   *  below `done` is touched. */
  warnings?: ResultWarning[];
  /** The block's summary, or the tail of the prose when there was no block.
   *  M3-3 hands this to a successor, which is why the next field exists. */
  summary?: string;
  /** True when `summary` is our synthesis rather than the agent's own words.
   *  A successor's prompt must say so plainly rather than quote us as it. */
  summarySynthesised?: true;
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
  /** Where to keep this task's harness stderr, or absent when the directory
   *  could not be made. Resolved here rather than in the executor so that a
   *  test executor never writes one. */
  stderrLog?: string;
  /** Already resolved for this task: the run's `askPolicy` when this task asks
   *  and one was supplied, otherwise `policyFor(task.mode)`. Settled here so
   *  the executor never re-decides who may approve what. */
  policy: Policy;
  /** Containment and negotiation notices. **Not** on the bus: `--quiet`
   *  switches the bus's renderer off and #13 says the containment line is
   *  never silenced, so it takes a route `--quiet` cannot reach.
   *
   *  `kind` is carried, not decided: `printableWarnings` owns which kinds
   *  `--quiet` may drop, and it owns that rule because it has a test for it.
   *  A notice with no kind is unconditional. */
  onNotice: (text: string, kind?: Warning["kind"]) => void;
  /** Called by the real executor immediately before `session/prompt`, so the
   *  run's turn count counts prompts sent, not tasks attempted. A task whose
   *  harness cannot start sends no prompt and must not count as a turn. */
  onTurn: () => void;
}

interface TaskOutcome {
  stopReason?: StopReason;
  usage?: Usage;
  /** M1b-4, and produced by the *executor* rather than by `runOne`: only
   *  something that really ran a harness has a working tree to compare a
   *  block against. An injected test executor reports neither, and its tasks
   *  are never promoted to `warned` for prose it was never asked to write. */
  result?: AgentResult;
  warnings?: ResultWarning[];
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
  /** The run's working directory. Each task's worktree hangs off it. */
  cwd: string;
  /** Names the run's worktrees and branches. Minted here when absent, but a
   *  caller that has to print the id — `run.ts` does — mints it itself: a run
   *  file may never supply one, or a re-run would rebuild branch names that
   *  already exist (`core/runfile.ts:53`). */
  runId?: string;
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
  onNotice?: (taskId: string, text: string, kind?: Warning["kind"]) => void;
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
  const runId = options.runId ?? newRunId();

  // Preflight once for the run, not once per task: every refusal it raises is
  // a property of the repository, so N tasks would raise the same one N times
  // — and the first worktree would already exist by then.
  const { worktrees, notice, root } = await openWorktrees(options.cwd, runId);
  if (notice) options.onNotice?.("run", notice);

  // Beside the worktrees, under the same root, and made once for the run
  // (M1b-7). A directory we cannot create is a notice and nothing more: the
  // run still has a terminal and a rejection message, and losing the durable
  // copy is not a reason to refuse to work.
  const logDir = join(root, STATE_DIR, "runs", runId);
  let logs = true;
  try {
    // A missing root is the non-repo fallback for a typo'd `--cwd`. The
    // log directory must not create the workspace it was asked to log —
    // tasks then fail at spawn with the same ENOENT they always had, and
    // the run still works, just without the durable copy.
    if (!existsSync(root)) {
      logs = false;
      options.onNotice?.(
        "run",
        `cannot write harness stderr logs to ${logDir}: ${root} does not exist`,
      );
    } else {
      mkdirSync(logDir, { recursive: true });
    }
  } catch (err) {
    logs = false;
    options.onNotice?.(
      "run",
      `cannot write harness stderr logs to ${logDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

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
          cwd: options.cwd,
          status: "cancelled",
          durationMs: 0,
          transcript: "",
        };
        continue;
      }

      results[index] = await runOne(
        task,
        exec,
        signal,
        options,
        onTurn,
        worktrees,
        logs ? join(logDir, `${task.id}.stderr.log`) : undefined,
      );
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
  worktrees: Worktrees | null,
  stderrLog: string | undefined,
): Promise<TaskRun> {
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

  // Acquired inside the `try`: a base ref that does not resolve is this task's
  // failure and nobody else's, and it has to read as `failed` rather than
  // taking the whole run down from the pool loop.
  let cwd = options.cwd;
  let settled: TaskRun;
  try {
    if (worktrees) cwd = await worktrees.acquire(task.id, task.worktree);
    const outcome = await exec(task, {
      cwd,
      bus,
      signal,
      verbose: options.verbose ?? false,
      stderrLog,
      policy:
        task.mode === "ask" && options.askPolicy
          ? options.askPolicy
          : policyFor(task.mode),
      onNotice: (text, kind) => options.onNotice?.(task.id, text, kind),
      onTurn,
    });
    record();
    const status = statusFor({
      stopReason: outcome.stopReason,
      cancelRequested,
      watchdogFired: false,
    });
    const warnings = outcome.warnings ?? [];
    const result: TaskRun = {
      id: task.id,
      agent: task.agent,
      cwd,
      transcript,
      // A disagreement colours a task that otherwise finished; it never
      // rescues one that did not. `warned` exits 0 and releases its worktree
      // exactly as `done` does, so this is a thing to read, not a failure.
      status: status === "done" && warnings.length ? "warned" : status,
      durationMs: Date.now() - started,
    };
    if (outcome.stopReason !== undefined)
      result.stopReason = outcome.stopReason;
    if (outcome.usage !== undefined) result.usage = outcome.usage;
    if (outcome.result) result.result = outcome.result;
    if (warnings.length) result.warnings = warnings;
    // The block's own words when there are any, our synthesis otherwise —
    // and never silently: M3-3 tells a successor which of the two it got.
    const summary = outcome.result?.summary ?? synthesiseSummary(transcript);
    if (summary) {
      result.summary = summary;
      if (!outcome.result) result.summarySynthesised = true;
    }
    settled = result;
  } catch (err) {
    record();
    settled = {
      id: task.id,
      agent: task.agent,
      cwd,
      transcript,
      status: statusFor({ cancelRequested, watchdogFired: false, threw: true }),
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Teardown never changes the verdict. A worktree that cannot be committed or
  // removed is a mess to report, not a reason to relabel a task that finished:
  // the failure modes here — a lock left by a killed harness, a filesystem
  // that refuses the delete — say nothing about whether the work succeeded.
  try {
    // A warning, not a throw: retention that declined to act — a checkout the
    // harness left on another branch — is a thing to tell the operator about,
    // and the work is still on disk either way.
    const kept = await worktrees?.release(task.id, settled.status);
    if (kept) options.onNotice?.(task.id, kept);
  } catch (err) {
    options.onNotice?.(
      task.id,
      `worktree cleanup failed, so it is still on disk: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return settled;
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

  // Observed on the way past, not reconstructed afterwards. `runOne` keeps its
  // own copy of the prose for printing; this one exists because the executor
  // is what has to read the block back out, and a permission count has no
  // other witness at all.
  let prose = "";
  let permissionCount = 0;
  const onEvent: typeof ctx.bus.emit = (event) => {
    const u = event.update;
    if (u.sessionUpdate === "agent_message_chunk") {
      if (u.content?.type === "text") prose += u.content.text;
    } else if (u.sessionUpdate === "_client_permission") {
      permissionCount += 1;
    }
    ctx.bus.emit(event);
  };

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
    stderrLog: ctx.stderrLog,
    onEvent,
  });

  // **Not `{ once: true }`.** `AcpAgent.cancel()` returns immediately when
  // there is no session yet, so a `once` listener consumed by an abort during
  // spawn or the handshake would be gone by the time a session exists —
  // leaving a cancelled task with nothing left to cancel it.
  const onAbort = () => agent.cancel();
  ctx.signal.addEventListener("abort", onAbort);

  // The listener alone is not enough for the same reason: a cancel that
  // arrives before the session cannot be *sent*, so startup has to stop by
  // itself. Checked at each boundary, because a task that reaches
  // `session/prompt` after the operator pressed ^C starts mutating a
  // workspace they already told us to leave alone. No `stopReason`: nothing
  // ended a turn, and `statusFor` reads the abort as `cancelled`.
  const cancelled = () => ctx.signal.aborted;

  try {
    if (cancelled()) return {};
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
      // The `kind` travels with the text. Dropping it here made `--quiet`
      // print the advisory `unverified` and `version` lines that
      // `printableWarnings` exists to filter — the caller cannot re-derive a
      // category from a sentence, and #13's rule must stay in the one place
      // that has a test for it.
      ctx.onNotice(w.text, w.kind);
    }

    if (cancelled()) return {};
    await agent.newSession();
    // No kind: the not-negotiated line is not a `warningsFor` warning and is
    // never suppressible (#13), so it takes the unconditional route.
    const notNegotiated = await negotiateSafeMode(agent, spec, task.mode);
    if (notNegotiated) ctx.onNotice(notNegotiated);

    // Count at the prompt boundary, not at spawn: a task that fails to start
    // sends no prompt, and a task cancelled before this line sends none either.
    if (cancelled()) return {};
    ctx.onTurn();
    // The preamble rides the one prompt this task gets. There is no second
    // one to ask again with (M0-4, `protocol/agent.ts:446`), which is exactly
    // why it is here and not held back for a follow-up.
    const { stopReason, usage } = await agent.prompt(
      withResultPreamble(task.prompt),
    );

    const result = extractResult(prose);
    const outcome: TaskOutcome = { stopReason };
    if (usage !== undefined) outcome.usage = usage;
    if (result) outcome.result = result;
    const warnings = crossCheck({
      result,
      // Unknown, not empty: outside a repository there is nothing to compare
      // against, and every tree-shaped check skips itself rather than guess.
      diff: await tryWorkingTree(ctx.cwd),
      permissionCount,
      ...(spec.measured
        ? { asksPermission: spec.measured.asksPermission }
        : {}),
    });
    if (warnings.length) outcome.warnings = warnings;
    return outcome;
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    agent.stop();
  }
}

/** The working tree, or `undefined` when there is no repository to read one
 *  from — the `--cwd` fallback `openWorktrees` already prints a notice for.
 *  Never a reason to fail a task that has already finished. */
async function tryWorkingTree(cwd: string): Promise<string | undefined> {
  try {
    return await workingTreeStatus(cwd);
  } catch {
    return undefined;
  }
}
