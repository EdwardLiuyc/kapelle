/**
 * M1b-2, issue #18.
 *
 * #429 adds the log-directory and worktree-release failure paths, including
 * the record handoff that makes merge refuse after unsafe teardown.
 *
 * Nothing here spawns a harness. The status table and the roll-up are pure
 * functions, and the pool is exercised through `runRun`'s injected executor —
 * which is the only way to *observe* "never more than N live", since counting
 * real subprocesses from outside would be slower, flakier, and still only a
 * proxy for the number this test reads directly.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  gitRepo,
  isolateStateHome,
  needs,
  tempDir,
} from "../../integration/helpers.ts";
import type { AgentEventEnvelope } from "../../protocol/agent.ts";
import { AGENTS, resolveAgent, warningsFor } from "../../protocol/registry.ts";
import type {
  ClientResultWarningEvent,
  StopReason,
  Usage,
} from "../../protocol/types.ts";
import { createEventBus } from "../events.ts";
import { mergeRun } from "../merge.ts";
import {
  runRun,
  runStatus,
  statusFor,
  type TaskExecutor,
  type TaskStatus,
  usageSemanticsFor,
} from "../run.ts";
import { type Run, validateRun } from "../runfile.ts";
import { stateDirFor } from "../runtime.ts";

isolateStateHome();

// --- the stop-reason table ---------------------------------------------------

const quiet = { cancelRequested: false, watchdogFired: false };

test("every stopReason maps to the status the table says", () => {
  const table: [StopReason, TaskStatus][] = [
    ["end_turn", "done"],
    ["max_tokens", "failed"],
    ["max_turn_requests", "failed"],
    ["refusal", "failed"],
    ["cancelled", "cancelled"],
  ];

  for (const [stopReason, expected] of table) {
    assert.equal(statusFor({ ...quiet, stopReason }), expected, stopReason);
  }
});

test("the supervisor's own record outranks stopReason", () => {
  // M0-4: copilot answers `end_turn` for a turn it cancelled, against a
  // control run proving the turn was cut short. If `stopReason` won, a
  // cancelled task and a timed-out one would both read as `done`.
  assert.equal(
    statusFor({
      stopReason: "end_turn",
      cancelRequested: true,
      watchdogFired: false,
    }),
    "cancelled",
  );
  assert.equal(
    statusFor({
      stopReason: "end_turn",
      cancelRequested: false,
      watchdogFired: true,
    }),
    "timed_out",
  );
  // The watchdog outranks a plain cancel: both are true when the watchdog
  // cancels the turn, and `timed_out` is the one that says why.
  assert.equal(
    statusFor({
      stopReason: "cancelled",
      cancelRequested: true,
      watchdogFired: true,
    }),
    "timed_out",
  );
});

test("a task that never ended a turn is failed, not done", () => {
  assert.equal(statusFor({ ...quiet, threw: true }), "failed");
  assert.equal(statusFor(quiet), "failed", "no stopReason at all");
  // Cancelling a run whose harness then dies is still an operator cancel:
  // the record we are sure of wins over the wreckage.
  assert.equal(
    statusFor({ cancelRequested: true, watchdogFired: false, threw: true }),
    "cancelled",
  );
});

// --- the roll-up -------------------------------------------------------------

const SEVERITY: TaskStatus[] = [
  "done",
  "warned",
  "cancelled",
  "skipped",
  "timed_out",
  "failed",
];

test("the run takes the worst status, at full width", () => {
  // Every adjacent pair, in both orders, so the order is asserted rung by
  // rung rather than by one lucky mixed example.
  for (let i = 0; i + 1 < SEVERITY.length; i++) {
    const [milder, worse] = [SEVERITY[i], SEVERITY[i + 1]] as TaskStatus[];
    assert.equal(runStatus([milder, worse]), worse, `${milder} < ${worse}`);
    assert.equal(runStatus([worse, milder]), worse, `${worse} > ${milder}`);
  }

  assert.equal(runStatus(["done", "done"]), "done");
  assert.equal(runStatus(SEVERITY), "failed");
  // `warned` and `skipped` have no producer until M1b-4 and M3-1, and the
  // ordering still has to place them — that is why they are here early.
  assert.equal(runStatus(["done", "warned"]), "warned");
  assert.equal(runStatus(["warned", "skipped"]), "skipped");
});

// --- the pool ----------------------------------------------------------------

/** A run of `n` tasks, all driving the offline mock. Built through
 *  `validateRun` so a schema change breaks this file too. */
function runOf(n: number, maxConcurrency: number): Run {
  return validateRun({
    maxConcurrency,
    cmd: "node mock-agent.mjs",
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      prompt: "hello",
    })),
  });
}

const options = () => ({ cwd: "/tmp/nowhere", bus: createEventBus() });

test("a six-task run with maxConcurrency 2 never has three live at once", async () => {
  let live = 0;
  let peak = 0;

  const exec: TaskExecutor = async (_task, ctx) => {
    ctx.onTurn();
    live += 1;
    peak = Math.max(peak, live);
    // Two turns of the event loop, so an implementation that started
    // everything at once would be caught rather than accidentally serialised.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    live -= 1;
    return { stopReason: "end_turn" };
  };

  const report = await runRun(runOf(6, 2), options(), exec);

  assert.equal(peak, 2, "the pool ran wider than maxConcurrency");
  assert.equal(report.tasks.length, 6);
  assert.equal(report.turns, 6);
  assert.equal(report.status, "done");
});

test("onTasks hears every task as queued before runRun first awaits", async () => {
  const heard: { id: string; status: string }[][] = [];
  const started = runRun(
    runOf(2, 1),
    { ...options(), onTasks: (tasks) => heard.push(tasks) },
    async () => ({ stopReason: "end_turn" }),
  );
  // Nothing awaited yet: `daemon.ts` sends its 202 at this point, so a list
  // that arrived only after the preflight would leave a live run task-less.
  assert.deepEqual(heard, [
    [
      { id: "t0", status: "queued" },
      { id: "t1", status: "queued" },
    ],
  ]);
  await started;
  assert.deepEqual(
    heard.at(-1)?.map((t) => t.status),
    ["done", "done"],
  );
});

test("the pool never opens more workers than there are tasks", async () => {
  let peak = 0;
  let live = 0;
  const exec: TaskExecutor = async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setImmediate(r));
    live -= 1;
    return { stopReason: "end_turn" };
  };

  await runRun(runOf(2, 8), options(), exec);
  assert.equal(peak, 2);
});

test("one failed task fails the run, and the others still run", async () => {
  const exec: TaskExecutor = async (task) => {
    if (task.id === "t2") throw new Error("harness died");
    return { stopReason: "end_turn" };
  };

  const report = await runRun(runOf(4, 2), options(), exec);

  assert.equal(report.status, "failed");
  assert.equal(report.tasks.filter((t) => t.status === "done").length, 3);
  const failed = report.tasks.find((t) => t.id === "t2");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /harness died/);
});

test("a task that fails before its prompt is not a turn", async () => {
  const exec: TaskExecutor = async () => {
    throw new Error("spawn failed");
  };

  const report = await runRun(runOf(1, 1), options(), exec);

  assert.equal(report.turns, 0, "no prompt was sent");
  assert.equal(report.status, "failed");
});

test("a task that stops early because it was cancelled reads as cancelled", async () => {
  // What `runTask`'s pre-session abort guards produce: no `stopReason`,
  // because nothing ended a turn, and no `onTurn`, because no prompt went
  // out. Without the abort that shape is a failure; with it, the operator's
  // intent wins — which is the half of the guard the pool owns.
  const abort = new AbortController();
  abort.abort();

  const report = await runRun(
    runOf(1, 1),
    { ...options(), signal: abort.signal },
    async () => ({}),
  );

  assert.equal(report.tasks[0]?.status, "cancelled");
  assert.equal(report.turns, 0, "a cancelled task sends no prompt");
});

test("the same early stop without a cancel is a failure", async () => {
  const report = await runRun(runOf(1, 1), options(), async () => ({}));

  assert.equal(report.tasks[0]?.status, "failed", "no turn ever ended");
});

test("a task that sent its prompt before it threw counts one turn", async () => {
  const exec: TaskExecutor = async (_task, ctx) => {
    ctx.onTurn();
    throw new Error("died mid-turn");
  };

  const report = await runRun(runOf(1, 1), options(), exec);

  assert.equal(report.turns, 1);
  assert.equal(report.status, "failed");
});

test("cancelling the run cancels what is live and what is still queued", async () => {
  const abort = new AbortController();
  const started: string[] = [];

  const exec: TaskExecutor = async (task, ctx) => {
    started.push(task.id);
    // The live task had already sent its prompt when ^C landed; a queued
    // task never gets here and is not a turn.
    ctx.onTurn();
    if (task.id === "t0") abort.abort();
    await new Promise((r) => setImmediate(r));
    return { stopReason: "end_turn" };
  };

  const bus = createEventBus();
  let runEvent: { status?: string; turns?: number } = {};
  bus.addListener((event) => {
    if (event.update.sessionUpdate === "_client_run_finished") {
      runEvent = event.update;
    }
  });

  const report = await runRun(
    runOf(6, 1),
    { ...options(), signal: abort.signal, bus },
    exec,
  );

  assert.equal(report.status, "cancelled");
  // Only the task that was live when ^C landed ever ran. A queued task is
  // `cancelled` — never `skipped`, which means a *dependency* failed.
  assert.deepEqual(started, ["t0"]);
  assert.equal(report.turns, 1, "a task that never started is not a turn");
  assert.ok(report.tasks.every((t) => t.status === "cancelled"));
  // M5-5 (#137): the bracket test records only the event's name, so pin the
  // cancelled run's own verdict and turn count on the terminal event.
  assert.equal(runEvent.status, "cancelled");
  assert.equal(runEvent.turns, 1);
});

test("a task that finished before the cancel still reads as done", async () => {
  const abort = new AbortController();
  const exec: TaskExecutor = async (task) => {
    if (task.id === "t1") abort.abort();
    return { stopReason: "end_turn" };
  };

  const report = await runRun(
    runOf(2, 1),
    { ...options(), signal: abort.signal },
    exec,
  );

  assert.equal(report.tasks[0]?.status, "done", "t0 was over before the abort");
  assert.equal(report.tasks[1]?.status, "cancelled");
});

test("usage stays on its task, tagged with its semantics, and is never added up", async () => {
  const count: Usage = {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
  };
  const exec: TaskExecutor = async (task) => ({
    stopReason: "end_turn",
    usage: { ...count, _task: task.id },
    usageSemantics: "per-turn",
  });

  const report = await runRun(runOf(2, 2), options(), exec);

  // No total on the report: copilot counts cumulatively where opencode counts
  // per turn (M0-5), so a sum would be a number with no meaning.
  assert.ok(!("usage" in report), "the run must not carry a token total");
  assert.deepEqual(report.tasks[0]?.usage, { ...count, _task: "t0" });
  assert.equal(report.tasks[0]?.usageSemantics, "per-turn");
  assert.equal(report.tasks[0]?.agent, "mock-agent");
});

test("token semantics come from the registry, or read explicitly as unknown", () => {
  assert.equal(usageSemanticsFor(resolveAgent("opencode")), "per-turn");
  assert.equal(usageSemanticsFor(resolveAgent("copilot")), "cumulative");
  // A `--cmd` has no measured half, so its number must say so rather than
  // silently borrowing the semantics of whichever harness looks similar.
  assert.equal(
    usageSemanticsFor(resolveAgent("", "node mock-agent.mjs")),
    "unknown",
  );
  assert.ok(AGENTS.opencode?.measured, "the measured fixture exists");
});

// The never-asks line is a property of the harness, not a disagreement with
// one task's result. It stays on the never-silenced notice route (#13), but
// N tasks with the same registry entry are one warning, not N.
test("a harness that never asks emits its containment notice once per run", async () => {
  const spec = AGENTS.opencode;
  if (!spec?.measured) throw new Error("opencode has a measured fixture");
  const [notice] = warningsFor("opencode", spec, "auto");
  const onceKey = notice?.onceKey;
  if (!notice || !onceKey) throw new Error("never-asks notice fixture");

  const bus = createEventBus();
  const busWarnings: ClientResultWarningEvent[] = [];
  bus.addListener(({ update }) => {
    if (update.sessionUpdate === "_client_result_warning") {
      busWarnings.push(update);
    }
  });
  const notices: Array<{ taskId: string; text: string }> = [];

  const exec: TaskExecutor = async (_task, ctx) => {
    ctx.onNoticeOnce(onceKey, notice.text, notice.kind);
    return { stopReason: "end_turn" };
  };

  const report = await runRun(
    runOf(3, 1),
    {
      cwd: "/tmp/nowhere",
      bus,
      onNotice: (taskId, text) => notices.push({ taskId, text }),
    },
    exec,
  );

  const taskNotices = notices.filter((n) => n.taskId !== "run");
  assert.deepEqual(taskNotices, [{ taskId: "t0", text: notice.text }]);
  assert.deepEqual(
    report.tasks.map((task) => [task.status, task.warnings]),
    [
      ["done", undefined],
      ["done", undefined],
      ["done", undefined],
    ],
  );
  assert.deepEqual(busWarnings, []);
});

test("prose is buffered per task, not interleaved", async () => {
  const exec: TaskExecutor = async (task, ctx) => {
    for (const text of [`${task.id}-a`, `${task.id}-b`]) {
      ctx.bus.emit({
        agent: task.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    }
    return { stopReason: "end_turn" };
  };

  const report = await runRun(runOf(2, 2), options(), exec);

  assert.equal(report.tasks[0]?.transcript, "t0-at0-b");
  assert.equal(report.tasks[1]?.transcript, "t1-at1-b");
});

test("a task's events reach the run's bus, tagged with the task id", async () => {
  const bus = createEventBus();
  const seen: string[] = [];
  bus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "agent_thought_chunk") seen.push(agent);
  });

  const exec: TaskExecutor = async (task, ctx) => {
    ctx.bus.emit({
      agent: task.id,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "x" },
      },
    });
    return { stopReason: "end_turn" };
  };

  await runRun(runOf(2, 2), { cwd: "/tmp/nowhere", bus }, exec);
  assert.deepEqual(seen.sort(), ["t0", "t1"]);
});

test("each task is bracketed by started and finished events, a pre-start cancel included", async () => {
  // M2-2: a replay has no other way to tell where one task's events begin and
  // how it ended. A task cancelled before it started never starts, but must
  // still say it finished, or a log reader never learns it existed.
  const bus = createEventBus();
  const seen: string[] = [];
  bus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "_client_task_started") {
      seen.push(`${agent}:started:${update.harness}`);
    } else if (update.sessionUpdate === "_client_task_finished") {
      seen.push(`${agent}:finished:${update.status}`);
    } else {
      seen.push(`${agent}:${update.sessionUpdate}`);
    }
  });

  const cancel = new AbortController();
  const exec: TaskExecutor = async (task, ctx) => {
    ctx.bus.emit({
      agent: task.id,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "x" },
      },
    });
    cancel.abort();
    return { stopReason: "end_turn" };
  };

  await runRun(
    runOf(2, 1),
    { cwd: "/tmp/nowhere", bus, signal: cancel.signal },
    exec,
  );
  assert.deepEqual(seen, [
    `t0:started:${runOf(2, 1).tasks[0]?.agent}`,
    "t0:agent_thought_chunk",
    "t0:finished:cancelled",
    "t1:finished:cancelled",
    ":_client_run_finished",
  ]);
});

test("a successful task's finished event carries its verdict and duration", async () => {
  // The bracket test above forces cancellation, so a hardcoded
  // `status: "cancelled"` or `durationMs: 0` would survive it.
  const bus = createEventBus();
  const seen: AgentEventEnvelope[] = [];
  bus.addListener((event) => seen.push(event));

  const exec: TaskExecutor = async () => {
    // A measurable delay: `durationMs: 0` is the mutant this test exists to
    // kill, so the assertion needs a real clock floor to compare against.
    await new Promise((ok) => setTimeout(ok, 20));
    return { stopReason: "end_turn" };
  };
  await runRun(runOf(1, 1), { cwd: "/tmp/nowhere", bus }, exec);

  const finished = seen.find(
    (event) => event.update.sessionUpdate === "_client_task_finished",
  );
  assert.ok(finished, "the finished event reached the bus");
  assert.equal(finished.update.sessionUpdate, "_client_task_finished");
  if (finished.update.sessionUpdate === "_client_task_finished") {
    assert.equal(finished.update.status, "done");
    assert.ok(
      finished.update.durationMs >= 10,
      `durationMs is the task's own clock, got ${finished.update.durationMs}`,
    );
  }
});

test("started names the registry agent, or the --cmd label", async () => {
  const named = validateRun({
    maxConcurrency: 1,
    tasks: [{ id: "named", prompt: "hello", agent: "opencode" }],
  });
  const namedSeen: string[] = [];
  const namedBus = createEventBus();
  namedBus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "_client_task_started") {
      namedSeen.push(`${agent}:${update.harness}`);
    }
  });
  await runRun(named, { cwd: "/tmp/nowhere", bus: namedBus }, async () => ({
    stopReason: "end_turn",
  }));
  assert.deepEqual(namedSeen, ["named:opencode"]);

  const cmdSeen: string[] = [];
  const cmdBus = createEventBus();
  cmdBus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "_client_task_started") {
      cmdSeen.push(`${agent}:${update.harness}`);
    }
  });
  await runRun(runOf(1, 1), { cwd: "/tmp/nowhere", bus: cmdBus }, async () => ({
    stopReason: "end_turn",
  }));
  // A literal, not `runOf(...).tasks[0].agent`: the derived label is what this
  // pins (resolveAgent("", "node mock-agent.mjs") -> "mock-agent").
  assert.deepEqual(cmdSeen, ["t0:mock-agent"]);
});

test("askPolicy reaches the asking task and nothing else", async () => {
  // `cli.ts` decides *whether* one prompt can serve this run; the pool only
  // has to hand it to the task that asks. A policy leaking onto an `auto` or
  // `safe` task would silently change what that task may do.
  const askPolicy = async () => true;
  const seen = new Map<string, unknown>();

  const run = validateRun({
    cmd: "node mock-agent.mjs",
    tasks: [
      { id: "asker", prompt: "p", mode: "ask" },
      { id: "quiet", prompt: "p", mode: "safe" },
    ],
  });

  const exec: TaskExecutor = async (task, ctx) => {
    seen.set(task.id, ctx.policy);
    return { stopReason: "end_turn" };
  };

  await runRun(run, { ...options(), askPolicy }, exec);

  assert.equal(seen.get("asker"), askPolicy);
  assert.notEqual(seen.get("quiet"), askPolicy);
});

// The worktree seam M1b-3 filled in is covered by `core/tests/worktree.test.ts`,
// against a real `git init` — the pool's half of it is one `acquire` before
// the executor and one `release` after, and neither is observable from here.

// --- the cross-check's verdict, M1b-4 ----------------------------------------

test("a warning promotes a done task, and the run, to warned", async () => {
  const bus = createEventBus();
  const events: AgentEventEnvelope[] = [];
  let runEventStatus: string | undefined;
  bus.addListener((event) => {
    if (event.update.sessionUpdate === "_client_result_warning") {
      events.push(event);
    } else if (event.update.sessionUpdate === "_client_run_finished") {
      runEventStatus = event.update.status;
    }
  });

  const exec: TaskExecutor = async (task) => {
    if (task.id !== "t1") return { stopReason: "end_turn" };
    return {
      stopReason: "end_turn",
      warnings: [{ kind: "filesNotInDiff", text: "named ghost.md" }],
    };
  };

  const report = await runRun(runOf(3, 3), { cwd: "/tmp/nowhere", bus }, exec);

  const warned = report.tasks.find((t) => t.id === "t1");
  assert.equal(warned?.status, "warned");
  assert.deepEqual(
    warned?.warnings?.map((w) => w.kind),
    ["filesNotInDiff"],
  );
  assert.equal(report.tasks.filter((t) => t.status === "done").length, 2);
  assert.equal(report.status, "warned");
  // M5-5 (#137): the terminal event carries the run's verdict, not the two
  // done tasks'. A mutant emitting "done" here survives the report assertion
  // alone.
  assert.equal(runEventStatus, "warned");
  // The report is not the only publication: a bus subscriber — a quiet CLI,
  // M2's log, M4's stream — sees the disagreement tagged with the task.
  const warnings = events.filter(
    (e): e is AgentEventEnvelope & { update: ClientResultWarningEvent } =>
      e.update.sessionUpdate === "_client_result_warning",
  );
  assert.deepEqual(
    warnings.map((e) => [e.agent, e.update.kind, e.update.text]),
    [["t1", "filesNotInDiff", "named ghost.md"]],
  );
});

test("a warning never rescues a task that did not finish", async () => {
  // The promotion is `done` → `warned` and nothing else. A refusal that also
  // disagreed with the tree is still a failure, and reading `warned` there
  // would hide it behind a status the CLI exits 0 for.
  const exec: TaskExecutor = async () => ({
    stopReason: "refusal",
    warnings: [{ kind: "noResultBlock", text: "nothing reported" }],
  });

  const report = await runRun(runOf(1, 1), options(), exec);
  assert.equal(report.tasks[0]?.status, "failed");
  assert.equal(report.status, "failed");
});

test("the summary is the block's own words, or ours and flagged as ours", async () => {
  const reported: TaskExecutor = async () => ({
    stopReason: "end_turn",
    result: { status: "success", summary: "Agent said this.", details: "d" },
  });
  const [mine] = (await runRun(runOf(1, 1), options(), reported)).tasks;
  assert.equal(mine?.summary, "Agent said this.");
  assert.equal(mine?.summarySynthesised, undefined);

  // No block, so the summary is synthesised from whatever prose arrived on
  // the bus — and says so, because M3-3 must not quote us as the agent.
  const silent: TaskExecutor = async (_task, ctx) => {
    ctx.bus.emit({
      agent: "t0",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I did some work." },
      },
    });
    return { stopReason: "end_turn" };
  };
  const [ours] = (await runRun(runOf(1, 1), options(), silent)).tasks;
  assert.equal(ours?.summary, "I did some work.");
  assert.equal(ours?.summarySynthesised, true);
});

// --- the watchdog (M1c-1, #25) ---------------------------------------------

/** One stalling task and one quick sibling, both with tiny limits. The sweep
 *  floor is 1 s (`core/watchdog.ts`), so this test really does wait — which is
 *  why there is one of it rather than one per assertion. */
function stallRun(): Run {
  return validateRun({
    maxConcurrency: 2,
    cmd: "node mock-agent.mjs",
    stallIdleMs: 10,
    stallRepeatCount: 0,
    ttlMs: 10,
    tasks: [
      { id: "stall", prompt: "hang" },
      { id: "quick", prompt: "hello", stallIdleMs: 0, ttlMs: 0 },
    ],
  });
}

test("the TTL cancels the stalled task alone and marks it timed_out", {
  // Without a watchdog this test hangs rather than fails; the bound turns the
  // missing feature into a red test instead of a stuck suite.
  timeout: 15_000,
}, async () => {
  const exec: TaskExecutor = async (task, ctx) => {
    ctx.onTurn();
    if (task.id !== "stall") return { stopReason: "end_turn" };
    // Never ends by itself. Only the watchdog's cancel gets it out of here,
    // which is the whole point: the run-wide signal was never aborted.
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return {};
  };

  const bus = createEventBus();
  const stalls: string[] = [];
  let runEventStatus: string | undefined;
  bus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "_client_stall_warning") {
      stalls.push(`${agent}:${update.kind}`);
    } else if (update.sessionUpdate === "_client_run_finished") {
      runEventStatus = update.status;
    }
  });

  const report = await runRun(stallRun(), { cwd: "/tmp/nowhere", bus }, exec);

  const byId = Object.fromEntries(report.tasks.map((t) => [t.id, t.status]));
  assert.equal(byId.stall, "timed_out");
  assert.equal(byId.quick, "done", "a sibling must not be cancelled with it");
  assert.equal(report.status, "timed_out");
  // M5-5 (#137): the terminal event carries the run's worst-task verdict, so
  // the timeout reaches a stream-only client too.
  assert.equal(runEventStatus, "timed_out");
  assert.deepEqual(stalls, ["stall:idle"], "the idle warning reached the bus");
});

test("a task with every limit at 0 is never touched by the watchdog", async () => {
  const run = validateRun({
    cmd: "node mock-agent.mjs",
    stallIdleMs: 0,
    stallRepeatCount: 0,
    ttlMs: 0,
    tasks: [{ id: "t0", prompt: "hello" }],
  });
  const exec: TaskExecutor = async (_task, ctx) => {
    ctx.onTurn();
    // Longer than the 1 s sweep floor, so a watchdog that ignored `0` would
    // have cancelled this before it returned.
    await new Promise((r) => setTimeout(r, 1_200));
    return { stopReason: "end_turn" };
  };

  const report = await runRun(run, options(), exec);
  assert.equal(report.status, "done");
});

test("an operator cancel outranks a TTL that fires in the same window", async () => {
  // `statusFor` puts `watchdogFired` above `cancelRequested`, so without the
  // guard in `onTimeout` a task the operator had already ^C'd would be
  // relabelled `timed_out` by the next sweep — blaming the harness for a stop
  // the operator asked for.
  const canceller = new AbortController();
  const run = validateRun({
    cmd: "node mock-agent.mjs",
    stallIdleMs: 0,
    stallRepeatCount: 0,
    ttlMs: 10,
    tasks: [{ id: "t0", prompt: "hello" }],
  });

  const exec: TaskExecutor = async (_task, ctx) => {
    ctx.onTurn();
    canceller.abort();
    // Outlives the 1 s sweep floor, so the TTL really is checked while the
    // run signal is already aborted. Deliberately not waiting on
    // `ctx.signal`: a task that exits the instant it is cancelled never
    // reaches the sweep, and would pass this test either way.
    await new Promise((r) => setTimeout(r, 1_400));
    return {};
  };

  const report = await runRun(
    run,
    { cwd: "/tmp/nowhere", bus: createEventBus(), signal: canceller.signal },
    exec,
  );
  assert.equal(report.tasks[0]?.status, "cancelled");
});

// --- the run record (M2-6, #36) ---------------------------------------------

/** What the run record says right now — outside the repository since #129. */
async function recordIn(root: string, runId: string) {
  const path = join(stateDirFor(root), "runs", runId, "run.json");
  return JSON.parse(await readFile(path, "utf8"));
}

const RECORD_RUN = "20260916-120000-abcd";

test("the run's last event is _client_run_finished, after the record and onFinished", async (t) => {
  // M5-5 (#137): a client that reads the event and then asks `GET /runs/:id`
  // must get the same status, so the terminal record and the caller are
  // settled before the line exists.
  const root = await gitRepo(t);
  const run = validateRun({
    tasks: [
      { id: "a", prompt: "x", agent: "opencode" },
      { id: "b", prompt: "x", agent: "opencode" },
    ],
  });
  const exec: TaskExecutor = async (task, ctx) => {
    ctx.onTurn();
    return task.id === "a"
      ? { stopReason: "end_turn" }
      : { stopReason: "refusal" };
  };

  const order: string[] = [];
  const bus = createEventBus();
  bus.addListener(({ update }) => {
    if (update.sessionUpdate !== "_client_run_finished") return;
    const path = join(stateDirFor(root), "runs", RECORD_RUN, "run.json");
    order.push(
      `event, record ${JSON.parse(readFileSync(path, "utf8")).status}`,
    );
  });
  const report = await runRun(
    run,
    {
      cwd: root,
      runId: RECORD_RUN,
      bus,
      onFinished: (r, endedAt) =>
        order.push(`onFinished ${r.status} ${endedAt}`),
    },
    exec,
  );
  const record = await recordIn(root, RECORD_RUN);
  assert.deepEqual(order, [
    `onFinished ${report.status} ${record.endedAt}`,
    `event, record ${report.status}`,
  ]);

  const lines = (
    await readFile(
      join(stateDirFor(root), "runs", RECORD_RUN, "events.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const last = lines.at(-1);
  assert.equal(last.agent, "");
  assert.equal(typeof last.at, "string");
  assert.deepEqual(last.update, {
    sessionUpdate: "_client_run_finished",
    status: report.status,
    durationMs: report.durationMs,
    turns: 2,
  });
  assert.equal(
    lines.filter((l) => l.update.sessionUpdate === "_client_run_finished")
      .length,
    1,
  );
  const lastTask = lines.findLastIndex(
    (l) => l.update.sessionUpdate === "_client_task_finished",
  );
  assert.ok(lastTask >= 0, "a task-finished line exists");
  assert.ok(lastTask < lines.length - 1, "the run event follows it");
});

test("the record names a running task and a queued one, before the run ends", async (t) => {
  const root = await gitRepo(t);
  // One at a time, so the second task is still queued while the first runs.
  const run = validateRun({
    maxConcurrency: 1,
    tasks: [
      { id: "a", prompt: "x", agent: "opencode" },
      { id: "b", prompt: "x", agent: "opencode" },
    ],
  });

  let midRun:
    | { status: string; tasks: { id: string; status: string }[] }
    | undefined;
  const exec: TaskExecutor = async (task) => {
    if (task.id === "a") midRun = await recordIn(root, RECORD_RUN);
    return { stopReason: "end_turn" };
  };
  const report = await runRun(
    run,
    { cwd: root, runId: RECORD_RUN, bus: createEventBus() },
    exec,
  );

  // The whole point: a `kill -9` here leaves this on disk for M2-5 to read.
  // Before M2-6 the file did not exist until the run was over.
  assert.ok(midRun, "no record on disk while the first task was running");
  assert.equal(midRun.status, "running");
  assert.deepEqual(
    midRun.tasks.map((task) => [task.id, task.status]),
    [
      ["a", "running"],
      ["b", "queued"],
    ],
  );

  const ended = await recordIn(root, RECORD_RUN);
  assert.equal(ended.status, report.status);
  assert.equal(typeof ended.startedAt, "string");
  assert.equal(typeof ended.endedAt, "string");
  assert.equal(ended.cwd, root);
  assert.deepEqual(
    ended.tasks.map((task: { status: string }) => task.status),
    ["done", "done"],
  );
  // M5-2, D2: the record carries what a client card needs after a restart.
  assert.deepEqual(
    ended.tasks.map((task: { agent?: string }) => task.agent),
    ["opencode", "opencode"],
  );
  assert.ok(
    ended.tasks.every(
      (task: { durationMs?: number }) => typeof task.durationMs === "number",
    ),
  );
});

test("the record carries the session id the executor reported", async (t) => {
  const root = await gitRepo(t);
  const exec: TaskExecutor = async () => ({
    stopReason: "end_turn",
    sessionId: "sess-42",
  });
  await runRun(
    runOf(1, 1),
    { cwd: root, runId: RECORD_RUN, bus: createEventBus() },
    exec,
  );

  // One field, so the backlog's `session/load` needs no migration (#36).
  assert.equal(
    (await recordIn(root, RECORD_RUN)).tasks[0].sessionId,
    "sess-42",
  );
});

/** Answers the handshake, then dies on the prompt: a session existed and the
 *  task did not return from it. */
const DIE_ON_PROMPT_HARNESS = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize")
    return send({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "die-on-prompt", version: "1" },
      authMethods: [],
    } });
  if (m.method === "session/new")
    return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess_die_1" } });
  if (m.method === "session/prompt") process.exit(7);
});
`;

test("the record keeps the session id when the harness dies mid-prompt", async (t) => {
  const root = await gitRepo(t);
  const harness = join(await tempDir(t), "die-on-prompt.mjs");
  await writeFile(harness, DIE_ON_PROMPT_HARNESS);

  // No injected executor: the real `runTask` spawns this fake harness, which
  // answers `session/new` and then exits on the prompt. The session existed,
  // so the record must carry its id even though the task settles failed
  // (M2-6, #36). Against the pre-fix source this fails with `undefined`.
  const run = validateRun({
    cmd: `node ${harness}`,
    tasks: [{ id: "dies", prompt: "x" }],
  });
  const report = await runRun(run, {
    cwd: root,
    runId: RECORD_RUN,
    bus: createEventBus(),
  });

  assert.equal(report.tasks[0]?.status, "failed");
  assert.equal(report.tasks[0]?.sessionId, "sess_die_1");
  assert.equal(
    (await recordIn(root, RECORD_RUN)).tasks[0].sessionId,
    "sess_die_1",
  );
});

test("a run with no worktrees still writes a record", async (t) => {
  // Not a repository, so `openWorktrees` falls back to the shared cwd. The
  // record used to be skipped here, and `kapelle merge` answered "no run
  // record" where it can now name the task that has no branch.
  const root = await tempDir(t);
  const report = await runRun(
    runOf(1, 1),
    { cwd: root, runId: RECORD_RUN, bus: createEventBus() },
    async () => ({ stopReason: "end_turn" }),
  );

  const record = await recordIn(root, RECORD_RUN);
  assert.equal(record.status, report.status);
  // M5-2, D2: the card fields ride the record too; the stub left no branch or
  // session, and `warnings` is omitted rather than written empty.
  assert.deepEqual(
    record.tasks.map((task: { id: string; status: string; agent?: string }) => [
      task.id,
      task.status,
      task.agent,
    ]),
    [["t0", "done", "mock-agent"]],
  );
  assert.equal(typeof record.tasks[0].durationMs, "number");
});

test("a log directory that cannot be made is one notice, and the run continues (#429)", async (t) => {
  const root = await gitRepo(t);
  const state = stateDirFor(root);
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "runs"), "not a directory\n");

  const notices: { taskId: string; text: string }[] = [];
  let eventLogCalled = false;
  let stderrLog: string | undefined;
  let ran = false;
  const report = await runRun(
    runOf(1, 1),
    {
      cwd: root,
      runId: RECORD_RUN,
      bus: createEventBus(),
      onNotice: (taskId, text) => notices.push({ taskId, text }),
      onEventLog: () => {
        eventLogCalled = true;
      },
    },
    async (_task, ctx) => {
      ran = true;
      stderrLog = ctx.stderrLog;
      return { stopReason: "end_turn" };
    },
  );

  assert.equal(ran, true);
  assert.equal(report.status, "done");
  assert.equal(stderrLog, undefined);
  assert.equal(eventLogCalled, false);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.taskId, "run");
  assert.match(
    notices[0]?.text ?? "",
    /^cannot write harness stderr logs to .*\/runs\/20260916-120000-abcd: /,
  );
  assert.equal(
    existsSync(join(state, "runs", RECORD_RUN, "events.jsonl")),
    false,
  );
});

test("a worktree-release failure keeps the verdict and clears merge metadata (#429)", {
  skip: needs("sh"),
}, async (t) => {
  const root = await gitRepo(t);
  const bin = await tempDir(t);
  const realGit = spawnSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).stdout.trim();
  assert.ok(realGit, "git is not on PATH");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = join(bin, "git");
  await writeFile(
    wrapper,
    `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
  echo ${quote("simulated worktree remove failure")} >&2
  exit 1
fi
exec ${quote(realGit)} "$@"
`,
  );
  await chmod(wrapper, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  const restorePath = () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  };
  t.after(restorePath);

  const notices: { taskId: string; text: string }[] = [];
  const report = await runRun(
    runOf(1, 1),
    {
      cwd: root,
      runId: RECORD_RUN,
      bus: createEventBus(),
      onNotice: (taskId, text) => notices.push({ taskId, text }),
    },
    async (_task, ctx) => {
      await writeFile(join(ctx.cwd, "work.txt"), "work\n");
      return { stopReason: "end_turn" };
    },
  );
  restorePath();

  const task = report.tasks[0];
  assert.equal(report.status, "done");
  assert.equal(task?.status, "done");
  assert.equal(task?.branch, undefined);
  assert.equal(task?.baseSha, undefined);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.taskId, "t0");
  assert.match(
    notices[0]?.text ?? "",
    /^worktree cleanup failed, so it is still on disk:/,
  );
  assert.match(notices[0]?.text ?? "", /simulated worktree remove failure\s*$/);

  const record = await recordIn(root, RECORD_RUN);
  assert.equal(record.tasks[0].status, "done");
  assert.equal(record.tasks[0].branch, undefined);
  assert.equal(record.tasks[0].baseSha, undefined);
  await assert.rejects(mergeRun(RECORD_RUN, root), /missing branch\/base/);
});

test("a preflight that throws leaves a failed record with its error, and an empty log (#317)", async (t) => {
  // A corrupt index: `git rev-parse` still finds the root, and the preflight's
  // `git status` throws. The record and the log came first, so both survive.
  const root = await gitRepo(t);
  await writeFile(join(root, ".git", "index"), "not an index\n");
  let ran = false;
  await assert.rejects(
    runRun(
      runOf(1, 1),
      { cwd: root, runId: RECORD_RUN, bus: createEventBus() },
      async () => {
        ran = true;
        return { stopReason: "end_turn" };
      },
    ),
  );
  assert.equal(ran, false, "no task runs after a failed preflight");

  const record = await recordIn(root, RECORD_RUN);
  assert.equal(record.status, "failed");
  assert.equal(typeof record.error, "string");
  assert.equal(typeof record.endedAt, "string");
  assert.deepEqual(record.tasks, [{ id: "t0", status: "queued" }]);
  const log = join(stateDirFor(root), "runs", RECORD_RUN, "events.jsonl");
  assert.equal(await readFile(log, "utf8"), "");
});

test("the running record and log exist before the worktree preflight (#317)", {
  skip: needs("sh"),
}, async (t) => {
  // A git wrapper copies the record and the log when the preflight's first
  // `git status` starts, once. A regression that writes them after the
  // preflight leaves nothing to copy, and a daemon crash in this window loses
  // the run.
  const root = await gitRepo(t);
  const bin = await tempDir(t);
  const copies = await tempDir(t);
  const runDir = join(stateDirFor(root), "runs", RECORD_RUN);
  const realGit = spawnSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).stdout.trim();
  assert.ok(realGit, "git is not on PATH");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const once = quote(join(copies, ".copied"));
  const wrapper = join(bin, "git");
  await writeFile(
    wrapper,
    `#!/bin/sh
if [ "$1" = "status" ] && [ ! -e ${once} ]; then
  touch ${once}
  cp ${quote(join(runDir, "run.json"))} ${quote(join(runDir, "events.jsonl"))} ${quote(copies)}
fi
exec ${quote(realGit)} "$@"
`,
  );
  await chmod(wrapper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  await runRun(
    runOf(1, 1),
    { cwd: root, runId: RECORD_RUN, bus: createEventBus() },
    async () => ({ stopReason: "end_turn" }),
  );
  const record = JSON.parse(await readFile(join(copies, "run.json"), "utf8"));
  assert.equal(record.status, "running");
  assert.deepEqual(record.tasks, [{ id: "t0", status: "queued" }]);
  assert.equal(await readFile(join(copies, "events.jsonl"), "utf8"), "");
});
