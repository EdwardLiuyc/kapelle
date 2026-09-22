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
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcpAgent, type Policy } from "../protocol/agent.ts";
import {
  type ResolvedAgent,
  resolveAgent,
  resolveEnv,
  type Warning,
  warningsFor,
} from "../protocol/registry.ts";
import type { StopReason, Usage } from "../protocol/types.ts";
import { createEventLog, type EventLog } from "./eventlog.ts";
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
import { stateDirFor } from "./runtime.ts";
import { createWatchdog, sweepIntervalMs, type Watchdog } from "./watchdog.ts";
import { changedPaths, openWorktrees, type Worktrees } from "./worktree.ts";

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
/**
 * Which statuses hand the worktree back as a commit (R37, moved here from
 * `core/worktree.ts`).
 *
 * `done` and `warned` are the two the CLI exits 0 for (`cli.ts:475`), and
 * teardown agrees with that rather than with a narrower reading of success.
 * Everything below them keeps its worktree so partial work stays inspectable.
 * It lives beside `TaskStatus` because it is a claim about task vocabulary;
 * `release` itself now takes a plain `ReleaseAction`, so a room — which has
 * no verdict — never has to borrow one of these words.
 */
export const RELEASES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "done",
  "warned",
]);

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
  /** The watchdog cut it off. Produced by M1c-1's TTL rung. */
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
export type UsageSemantics = "per-turn" | "cumulative" | "unknown";

export interface TaskRun {
  id: string;
  agent: string;
  cwd: string;
  /** The task branch and its base SHA when the task acquired a worktree.
   *  Used to write the run record M1c-3's merge reads. */
  branch?: string;
  baseSha?: string;
  /** The harness session this task ran in (M2-6, #36). One field on the run
   *  record, so the backlog's `session/load` item can be picked up without a
   *  migration; reattachment itself stays out of scope and capability-gated.
   *
   *  Set once `session/new` has answered, on every settle path from there:
   *  the success return, a cancel before the prompt, and a throw out of the
   *  harness. A task killed before it settles is still the `running` record
   *  from task start — that window is #35's sweep, which owns crashed runs. */
  sessionId?: string;
  status: TaskStatus;
  stopReason?: StopReason;
  usage?: Usage;
  /** Which counting rules produced `usage`. `unknown` is explicit for an
   *  unmeasured `--cmd` agent; a task that produced no count has neither. */
  usageSemantics?: UsageSemantics;
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
   *  throws during a live turn), so this counts the tasks that got far enough
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
  /** Aborted when the operator cancels the run or this task's watchdog TTL fires. */
  signal: AbortSignal;
  verbose: boolean;
  /** Where to keep this task's harness stderr, or absent when the directory
   *  could not be made. Resolved here rather than in the executor so that a
   *  test executor never writes one. */
  stderrLog?: string;
  /** True when `cwd` is this task's own worktree, and false when the run fell
   *  back to a shared one. **Only an isolated checkout can attribute a change
   *  to this task** — in the fallback, one task's files are in every other
   *  task's `git status`, so a task that touched nothing was told it had
   *  changed the tree without asking (measured 2026-09-08, #88). The executor
   *  reads the tree only when this is true. */
  isolated: boolean;
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
   *  A notice with no kind is unconditional.
   *
   *  `onNoticeOnce` is the same route, but a key names a property of the run
   *  rather than one task. It exists for the harness-level containment line;
   *  it must not become a general way to hide repeated task evidence. */
  onNotice: (text: string, kind?: Warning["kind"]) => void;
  onNoticeOnce: (key: string, text: string, kind?: Warning["kind"]) => void;
  /** Called by the real executor immediately before `session/prompt`, so the
   *  run's turn count counts prompts sent, not tasks attempted. A task whose
   *  harness cannot start sends no prompt and must not count as a turn. */
  onTurn: () => void;
}

interface TaskOutcome {
  stopReason?: StopReason;
  /** The harness's own session id, for the run record (M2-6). */
  sessionId?: string;
  usage?: Usage;
  usageSemantics?: UsageSemantics;
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
   *  caller that has to print the id — `cli.ts` does — mints it itself: a run
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
   * **One prompt cannot serve two askers**, so `cli.ts` supplies its terminal
   * decider only when at most one task in the run asks *and* a TTY exists, and
   * re-resolves the rest as `safe`. `daemon.ts` supplies M2-3's pending-decision
   * queue (`core/permissions.ts`), which serves N askers at once. Absent, an
   * `ask` task falls back to `policyFor("ask")`.
   */
  askPolicy?: Policy;
  /** Notices a run must print even under `--quiet` (#13). */
  onNotice?: (taskId: string, text: string, kind?: Warning["kind"]) => void;
  /** Handed the run's event log once it exists, before any task starts —
   *  `daemon.ts` serves `GET /runs/:id/events` from it (M2-2). Never called
   *  when the log directory could not be made. */
  onEventLog?: (log: EventLog) => void;
  /** Handed the task list at every transition, the list `run.json` carries —
   *  `daemon.ts` lists a live run's tasks from it (M2-10). Called whether or
   *  not the record could be written. */
  onTasks?: (tasks: RecordTask[]) => void;
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

  // Every task's state, for the record and for `onTasks`. A task absent from
  // `entries` has not left the queue.
  const entries = new Map<string, RecordTask>();
  const snapshot = () =>
    run.tasks.map(
      (t): RecordTask => entries.get(t.id) ?? { id: t.id, status: "queued" },
    );
  // Before the first await, so a caller that has just started the run can
  // list its tasks at once — `daemon.ts` answers its 202 right after this
  // call returns, and the first `persist` is a preflight away (M2-10).
  options.onTasks?.(snapshot());

  // Preflight once for the run, not once per task: every refusal it raises is
  // a property of the repository, so N tasks would raise the same one N times
  // — and the first worktree would already exist by then.
  const { worktrees, notice, advisory, root } = await openWorktrees(
    options.cwd,
    runId,
  );
  // Two kinds, one route. The fallback notice says isolation is absent, which
  // #13 makes unsuppressible; the dirty-tree line (#129) is a courtesy the
  // operator can silence.
  if (notice) options.onNotice?.("run", notice, "containment");
  if (advisory) options.onNotice?.("run", advisory, "advisory");

  // Beside the worktrees, in the same per-repository state directory, and
  // made once for the run (M1b-7). Since #129 that is outside the repository:
  // a run leaves the working tree exactly as it found it. A log directory we
  // cannot create or write to below is a notice and nothing more: the
  // run still has a terminal and a rejection message, and losing the durable
  // copy is not a reason to refuse to work.
  const logDir = join(stateDirFor(root), "runs", runId);
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

  // Subscribed before any task can emit, so `seq` 1 is the run's first event.
  let eventLog: EventLog | undefined;
  if (logs) {
    eventLog = createEventLog(join(logDir, "events.jsonl"), (err) =>
      options.onNotice?.("run", `cannot write event log: ${err.message}`),
    );
    options.bus.addListener(eventLog.append);
    options.onEventLog?.(eventLog);
  }

  // The record is written on every task transition, not once at the end
  // (M2-6, #36). A daemon that dies mid-run used to leave nothing at all —
  // the file landed after `Promise.all` — so the sweep that reconciles a
  // crash (M2-5) had no record to reconcile, and a restart could not tell a
  // task that was running from one that never left the queue.
  //
  // Written for any run with a log directory, including the shared-cwd
  // fallback that has no branches: `core/merge.ts` already refuses a task
  // with no branch by name, which is a better answer than "no run record".
  let recordFailed = false;
  let writing: Promise<void> = Promise.resolve();
  const persist = (
    status: TaskStatus | "running",
    endedAt?: string,
  ): Promise<void> => {
    const tasks = snapshot();
    options.onTasks?.(tasks);
    if (!logs) return writing;
    // Chained, never concurrent: two workers renaming one temp file at the
    // same instant is the one way an atomic write stops being atomic.
    writing = writing
      .then(() =>
        writeRunRecord({
          runId,
          root,
          cwd: options.cwd,
          status,
          startedAt: new Date(started).toISOString(),
          ...(endedAt ? { endedAt } : {}),
          logDir,
          tasks,
        }),
      )
      .catch((err) => {
        // Once per run: a filesystem that refuses this write refuses every
        // later one too, and the run itself is still happening.
        if (recordFailed) return;
        recordFailed = true;
        options.onNotice?.(
          "run",
          `cannot write run record: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    return writing;
  };
  // Before any task starts, so a run that dies during its first spawn still
  // has a record naming every task it was going to run.
  await persist("running");

  const results = new Array<TaskRun>(run.tasks.length);
  const queue = run.tasks.map((task, index) => ({ task, index }));

  // One sweep for the whole run, each task judged by its own limits (M1c-1).
  // The controls map is how the sweep reaches a single task: `signal` here is
  // run-wide, so aborting it to cut one stalled task would cancel the others.
  const controls = new Map<string, TaskControl>();
  const watchdog = createWatchdog({
    onWarn: (taskId, kind, text) => {
      // On the bus, not through `onNotice`: M1c-4's notifier and M4's toast
      // subscribe to this same event, and unlike the containment line a stall
      // warning is ordinary run output that `--quiet` may drop.
      options.bus.emit({
        agent: taskId,
        update: { sessionUpdate: "_client_stall_warning", kind, text },
      });
    },
    onTimeout: (taskId) => {
      const control = controls.get(taskId);
      if (!control) return;
      // An operator cancel that landed first stays authoritative: a task already
      // being torn down after ^C must not be relabelled `timed_out` by a sweep.
      if (signal.aborted) return;
      // The flag before the cancel: `statusFor` reads our own record, and a
      // task that settled between the two would otherwise read `cancelled`.
      control.fired = true;
      control.cancel();
    },
  });
  const sweep = setInterval(() => watchdog.sweep(), sweepIntervalMs(run.tasks));
  // `unref`: the sweep watches a run that is already keeping the loop alive.
  // It must never be the reason a finished process lingers.
  sweep.unref();
  let turns = 0;
  const onTurn = () => {
    turns += 1;
  };
  // Shared by the pool, so an N-task run prints a harness-level notice once.
  // A Set is safe here even concurrently: checking and adding are synchronous.
  const onceNotices = new Set<string>();

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
        // No `_client_task_started` came first: a replay still needs to learn
        // the task existed and how it ended.
        options.bus.emit({
          agent: task.id,
          update: {
            sessionUpdate: "_client_task_finished",
            status: "cancelled",
            durationMs: 0,
          },
        });
        entries.set(task.id, recordTask(results[index] as TaskRun));
        await persist("running");
        continue;
      }

      entries.set(task.id, { id: task.id, status: "running" });
      // Awaited, so the record is on disk before the harness is spawned: a
      // `kill -9` during the spawn is exactly the case the sweep reads it for.
      await persist("running");

      results[index] = await runOne(
        task,
        exec,
        signal,
        options,
        onTurn,
        worktrees,
        logs ? join(logDir, `${task.id}.stderr.log`) : undefined,
        onceNotices,
        watchdog,
        controls,
      );
      entries.set(task.id, recordTask(results[index] as TaskRun));
      await persist("running");
    }
  };

  const width = Math.min(run.maxConcurrency, run.tasks.length);
  try {
    await Promise.all(Array.from({ length: width }, worker));
  } finally {
    clearInterval(sweep);
    // Every task has emitted its last event by now, so readers can end.
    await eventLog?.close();
  }

  // The last write is the terminal one: it is what M1c-3's merge reads, and
  // what tells a restart that this run is over rather than abandoned.
  const status = runStatus(results.map((r) => r.status));
  await persist(status, new Date().toISOString());

  return {
    status,
    durationMs: Date.now() - started,
    turns,
    tasks: results,
  };
}

/** How the run-wide sweep reaches one task. `fired` is the supervisor's own
 *  record that the TTL cut this task off — never `stopReason`, which M0-4
 *  measured copilot lying about. */
interface TaskControl {
  cancel: () => void;
  fired: boolean;
}

/**
 * One task as the run record carries it (M2-6, #36).
 *
 * `status` widens `TaskStatus` with the two states a task can be *caught* in
 * by a crash. Neither is a verdict, which is why neither is a `TaskStatus`:
 * nothing in this module can settle on them, and `core/merge.ts` refuses both
 * as unfinished along with every other non-`done`/`warned` value.
 *
 * **M5-2 (#134):** the record also carries what a client card needs after a
 * restart — `agent`, `durationMs` and `warnings`. `usage`, `error` and the
 * summaries stay live-only; the DTO omits them rather than inventing values.
 */
interface RecordTask {
  id: string;
  status: TaskStatus | "queued" | "running";
  branch?: string;
  baseSha?: string;
  sessionId?: string;
  agent?: string;
  durationMs?: number;
  warnings?: ResultWarning[];
}

interface RunRecordInput {
  runId: string;
  root: string;
  cwd: string;
  status: TaskStatus | "running";
  startedAt: string;
  endedAt?: string;
  logDir: string;
  tasks: RecordTask[];
}

/** A finished task, as the record carries it. */
function recordTask(task: TaskRun): RecordTask {
  const entry: RecordTask = {
    id: task.id,
    status: task.status,
    agent: task.agent,
    durationMs: task.durationMs,
  };
  if (task.branch !== undefined) entry.branch = task.branch;
  if (task.baseSha !== undefined) entry.baseSha = task.baseSha;
  if (task.sessionId !== undefined) entry.sessionId = task.sessionId;
  if (task.warnings !== undefined) entry.warnings = task.warnings;
  return entry;
}

/**
 * Write the record, atomically.
 *
 * Temp file plus `rename`, the shape `daemon.ts` already uses for
 * `children.json`: this is now written while the run is live, so a crash
 * between two writes must leave the previous record whole rather than half a
 * one for `core/merge.ts` and M2-5 to parse.
 *
 * Asserted by inspection, not by a test: a reader racing the write sees the
 * old record or the new one whichever way this is written, so a test of it
 * would pass on a plain `writeFile` too. The consequence that *is* tested is
 * the other side — `daemon.ts` skips a truncated record with a notice.
 */
async function writeRunRecord(input: RunRecordInput): Promise<void> {
  const record = {
    runId: input.runId,
    root: input.root,
    cwd: input.cwd,
    status: input.status,
    startedAt: input.startedAt,
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    tasks: input.tasks,
  };
  const path = join(input.logDir, "run.json");
  // Suffixed with the pid: `core/sweep.ts` rewrites this same file on a daemon
  // boot, so a fixed `run.json.tmp` would let two processes write one temp
  // path and rename halves of each other's record into place.
  const tmp = `${path}.${process.pid}.tmp`;
  // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
  // pi-lens-ignore: no-raw-json-store-write
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function runOne(
  task: Task,
  exec: TaskExecutor,
  signal: AbortSignal,
  options: RunOptions,
  onTurn: () => void,
  worktrees: Worktrees | null,
  stderrLog: string | undefined,
  onceNotices: Set<string>,
  watchdog: Watchdog,
  controls: Map<string, TaskControl>,
): Promise<TaskRun> {
  const started = Date.now();
  options.bus.emit({
    agent: task.id,
    update: { sessionUpdate: "_client_task_started", harness: task.agent },
  });

  // This task's own abort, chained to the run's. The executor sees only this
  // one, so a TTL cuts one task where ^C still cuts them all.
  const control = new AbortController();
  const onRunAbort = () => control.abort();
  signal.addEventListener("abort", onRunAbort);
  if (signal.aborted) control.abort();
  const self: TaskControl = { cancel: () => control.abort(), fired: false };
  controls.set(task.id, self);

  // `Task` carries the three limits structurally, so there is nothing to map.
  const watch = watchdog.watch(task.id, task);

  // One label-and-filter route for both task notices and run-level notices,
  // so the CLI's `--quiet` rules cannot fork by accident.
  const onNotice = (text: string, kind?: Warning["kind"]) =>
    options.onNotice?.(task.id, text, kind);
  const onNoticeOnce = (key: string, text: string, kind?: Warning["kind"]) => {
    if (onceNotices.has(key)) return;
    onceNotices.add(key);
    onNotice(text, kind);
  };

  // Its own bus, forwarding to the run's. One `addListener` rather than the
  // executor filtering the shared stream by task id — `core/events.ts` has no
  // removeListener, so a per-task listener on the shared bus would pile up.
  const bus = createEventBus();
  bus.addListener(options.bus.emit);
  bus.addListener(watch.note);
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
  let branchMeta: { branch: string; baseSha: string } | undefined;
  let settled: TaskRun;
  try {
    if (worktrees) {
      cwd = await worktrees.acquire(task.id, task.worktree);
      branchMeta = worktrees.info(task.id);
      if (branchMeta) {
        options.bus.emit({
          agent: task.id,
          update: {
            sessionUpdate: "_client_worktree_created",
            // The workspace the task runs in — the checkout root, or the
            // `--cwd` subdirectory inside it — never `info`'s checkout root.
            // Listed explicitly so a wider `info` cannot shadow it.
            path: cwd,
            branch: branchMeta.branch,
            baseSha: branchMeta.baseSha,
          },
        });
      }
    }
    const outcome = await exec(task, {
      cwd,
      bus,
      signal: control.signal,
      verbose: options.verbose ?? false,
      stderrLog,
      isolated: worktrees !== null,
      policy:
        task.mode === "ask" && options.askPolicy
          ? options.askPolicy
          : policyFor(task.mode),
      onNotice,
      onNoticeOnce,
      onTurn,
    });
    record();
    const status = statusFor({
      stopReason: outcome.stopReason,
      cancelRequested,
      watchdogFired: self.fired,
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
    if (outcome.sessionId !== undefined) result.sessionId = outcome.sessionId;
    if (outcome.usage !== undefined) {
      result.usage = outcome.usage;
      result.usageSemantics = outcome.usageSemantics;
    }
    if (outcome.result) result.result = outcome.result;
    if (warnings.length) {
      result.warnings = warnings;
      // The block's disagreement is a first-class event, not just a field on
      // the final report: `--quiet` can drop the summary without dropping the
      // subscriber below, and M2's log has the same replay need.
      for (const w of warnings) {
        options.bus.emit({
          agent: task.id,
          update: {
            sessionUpdate: "_client_result_warning",
            kind: w.kind,
            text: w.text,
          },
        });
      }
    }
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
    // `runTask` carries a session id out on its thrown error (M2-6, #36): the
    // turn ended badly, but the session it ran in did exist. A task that never
    // reached `session/new` has none, and neither has a non-object throw.
    const sessionId =
      err !== null && typeof err === "object"
        ? (err as { sessionId?: unknown }).sessionId
        : undefined;
    settled = {
      id: task.id,
      agent: task.agent,
      cwd,
      transcript,
      status: statusFor({
        cancelRequested,
        watchdogFired: self.fired,
        threw: true,
      }),
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
    if (typeof sessionId === "string") settled.sessionId = sessionId;
  }

  if (branchMeta) {
    settled.branch = branchMeta.branch;
    settled.baseSha = branchMeta.baseSha;
  }

  signal.removeEventListener("abort", onRunAbort);
  controls.delete(task.id);
  // Before the worktree work below, which is slow enough for a tight
  // `stallIdleMs` to warn about a task that has already finished.
  watch.close();

  // Teardown never changes the verdict. A worktree that cannot be committed or
  // removed is a mess to report, not a reason to relabel a task that finished:
  // the failure modes here — a lock left by a killed harness, a filesystem
  // that refuses the delete — say nothing about whether the work succeeded.
  try {
    // A warning, not a throw: retention that declined to act — a checkout the
    // harness left on another branch — is a thing to tell the operator about,
    // and the work is still on disk either way.
    const kept = await worktrees?.release(
      task.id,
      RELEASES.has(settled.status) ? "commit" : "keep",
    );
    if (kept) {
      onNotice(kept);
      // The checkout was kept because it was not on the advertised branch, so
      // that branch does not carry this task's work. Drop it from the record
      // rather than letting merge silently land nothing.
      settled.branch = undefined;
      settled.baseSha = undefined;
    }
  } catch (err) {
    onNotice(
      `worktree cleanup failed, so it is still on disk: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // We cannot prove the advertised branch now carries the task's work (a
    // release failure can happen before the commit lands). Drop the metadata
    // so merge refuses instead of silently landing an empty branch.
    settled.branch = undefined;
    settled.baseSha = undefined;
  }
  // After teardown, which never changes the verdict but can take long enough
  // that a reader would otherwise see the next task start first.
  options.bus.emit({
    agent: task.id,
    update: {
      sessionUpdate: "_client_task_finished",
      status: settled.status,
      durationMs: settled.durationMs,
    },
  });
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
  //
  // M0-4 measured every harness ending its turn within 64 ms of
  // `session/cancel`, so a 2 s grace before `agent.stop()` is a safety net, not
  // a normal path (`docs/M0-FINDINGS.md` §M0-4). Without it, a harness that
  // ignores the cancel would leave `session/prompt` pending forever.
  const CANCEL_GRACE_MS = 2_000;
  let cancelGrace: NodeJS.Timeout | undefined;
  const onAbort = () => {
    agent.cancel();
    if (cancelGrace) return;
    cancelGrace = setTimeout(() => void agent.stop(), CANCEL_GRACE_MS);
    // `unref`: the grace timer is a safety net. If the run has already settled
    // it must not keep the process alive on its own.
    cancelGrace.unref();
  };
  ctx.signal.addEventListener("abort", onAbort);

  // The listener alone is not enough for the same reason: a cancel that
  // arrives before the session cannot be *sent*, so startup has to stop by
  // itself. Checked at each boundary, because a task that reaches
  // `session/prompt` after the operator pressed ^C starts mutating a
  // workspace they already told us to leave alone. No `stopReason`: nothing
  // ended a turn, and `statusFor` reads the abort as `cancelled`.
  const cancelled = () => ctx.signal.aborted;

  // Set once `session/new` answers, so a throw or a late cancel can still hand
  // the id to the record (M2-6, #36). Nothing reads it before that point.
  let sessionId: string | undefined;
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
      // that has a test for it. The `onceKey` marks a harness property, so it
      // is deduped per run rather than repeated by every task.
      if (w.onceKey) {
        ctx.onNoticeOnce(w.onceKey, w.text, w.kind);
      } else {
        ctx.onNotice(w.text, w.kind);
      }
    }

    if (cancelled()) return {};
    sessionId = await agent.newSession();
    // No kind: the not-negotiated line is not a `warningsFor` warning and is
    // never suppressible (#13), so it takes the unconditional route.
    const notNegotiated = await negotiateSafeMode(agent, spec, task.mode);
    if (notNegotiated) ctx.onNotice(notNegotiated);

    // Count at the prompt boundary, not at spawn: a task that fails to start
    // sends no prompt, and a task cancelled before this line sends none either.
    // The session exists by now, so the record keeps its id even here.
    if (cancelled()) return { sessionId };
    ctx.onTurn();
    // The preamble rides the one prompt this task gets. There is no second
    // one to ask again with (M0-4, `protocol/agent.ts:446`), which is exactly
    // why it is here and not held back for a follow-up.
    const { stopReason, usage } = await agent.prompt(
      withResultPreamble(task.prompt),
    );

    // The tree read below must happen after the harness is gone (#110):
    // `release()` commits after this function returns, and a write that lands
    // during shutdown would otherwise be committed but never cross-checked.
    // `stop()` is idempotent, so the `finally` below still covers every path
    // that throws before this line.
    await agent.stop();

    const result = extractResult(prose);
    const outcome: TaskOutcome = { stopReason, sessionId };
    if (usage !== undefined) {
      outcome.usage = usage;
      outcome.usageSemantics = usageSemanticsFor(spec);
    }
    if (result) outcome.result = result;
    const warnings = crossCheck({
      result,
      // Unknown, not empty: without a worktree of its own there is nothing
      // that can attribute a change to this task, so every tree-shaped check
      // skips itself rather than guess.
      changed: ctx.isolated ? await tryChangedPaths(ctx.cwd) : undefined,
      permissionCount,
      ...(spec.measured
        ? { asksPermission: spec.measured.asksPermission }
        : {}),
    });
    if (warnings.length) outcome.warnings = warnings;
    return outcome;
  } catch (err) {
    // The turn ended badly, but the session it ran in did exist. A narrow
    // property on the thrown error is the one channel to `runOne`'s record
    // (M2-6, #36); nothing else sets or reads it.
    if (sessionId !== undefined && err !== null && typeof err === "object") {
      (err as { sessionId?: string }).sessionId ??= sessionId;
    }
    throw err;
  } finally {
    if (cancelGrace) clearTimeout(cancelGrace);
    ctx.signal.removeEventListener("abort", onAbort);
    // Awaited (M2-4): a task is not over while its harness can still write,
    // and a daemon shutting down waits on the run to wait on the harness.
    await agent.stop();
  }
}

/** The task's changed paths, or `undefined` when git could not answer.
 *  Never a reason to fail a task that has already finished. */
async function tryChangedPaths(cwd: string): Promise<string[] | undefined> {
  try {
    return await changedPaths(cwd);
  } catch {
    return undefined;
  }
}

/** Registry labels describe `usage_update.used`; the prompt response's count
 *  shares their per-turn/cumulative distinction. A harness with no measured
 *  labels gets an explicit `unknown`, never a number readers must guess at. */
export function usageSemanticsFor(spec: ResolvedAgent): UsageSemantics {
  const measured = spec.measured?.usage;
  return measured === "per-turn" || measured === "cumulative"
    ? measured
    : "unknown";
}
