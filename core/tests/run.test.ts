/**
 * M1b-2, issue #18.
 *
 * Nothing here spawns a harness. The status table and the roll-up are pure
 * functions, and the pool is exercised through `runRun`'s injected executor —
 * which is the only way to *observe* "never more than N live", since counting
 * real subprocesses from outside would be slower, flakier, and still only a
 * proxy for the number this test reads directly.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEventEnvelope } from "../../protocol/agent.ts";
import { AGENTS, resolveAgent, warningsFor } from "../../protocol/registry.ts";
import type {
  ClientResultWarningEvent,
  StopReason,
  Usage,
} from "../../protocol/types.ts";
import { createEventBus } from "../events.ts";
import {
  runRun,
  runStatus,
  statusFor,
  type TaskExecutor,
  type TaskStatus,
  usageSemanticsFor,
} from "../run.ts";
import { type Run, validateRun } from "../runfile.ts";

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

  const report = await runRun(
    runOf(6, 1),
    { ...options(), signal: abort.signal },
    exec,
  );

  assert.equal(report.status, "cancelled");
  // Only the task that was live when ^C landed ever ran. A queued task is
  // `cancelled` — never `skipped`, which means a *dependency* failed.
  assert.deepEqual(started, ["t0"]);
  assert.equal(report.turns, 1, "a task that never started is not a turn");
  assert.ok(report.tasks.every((t) => t.status === "cancelled"));
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
  bus.addListener(({ agent }) => seen.push(agent));

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

test("askPolicy reaches the asking task and nothing else", async () => {
  // `run.ts` decides *whether* one prompt can serve this run; the pool only
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
  bus.addListener((event) => {
    if (event.update.sessionUpdate === "_client_result_warning") {
      events.push(event);
    }
  });

  const exec: TaskExecutor = async (task) => {
    if (task.id !== "t1") return { stopReason: "end_turn" };
    return {
      stopReason: "end_turn",
      warnings: [{ kind: "claimedSuccessNoDiff", text: "said success" }],
    };
  };

  const report = await runRun(runOf(3, 3), { cwd: "/tmp/nowhere", bus }, exec);

  const warned = report.tasks.find((t) => t.id === "t1");
  assert.equal(warned?.status, "warned");
  assert.deepEqual(
    warned?.warnings?.map((w) => w.kind),
    ["claimedSuccessNoDiff"],
  );
  assert.equal(report.tasks.filter((t) => t.status === "done").length, 2);
  assert.equal(report.status, "warned");
  // The report is not the only publication: a bus subscriber — a quiet CLI,
  // M2's log, M4's stream — sees the disagreement tagged with the task.
  const warnings = events.filter(
    (e): e is AgentEventEnvelope & { update: ClientResultWarningEvent } =>
      e.update.sessionUpdate === "_client_result_warning",
  );
  assert.deepEqual(
    warnings.map((e) => [e.agent, e.update.kind, e.update.text]),
    [["t1", "claimedSuccessNoDiff", "said success"]],
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
