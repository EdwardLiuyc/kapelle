/**
 * The daemon with a real harness: the two paths where a bug lets a harness
 * write when it must not.
 *
 * - **An `ask` run answered over HTTP.** Only claude and copilot ask us
 *   (`asksPermission: true`), so only they reach the daemon's queue (M2-3,
 *   M5-4). `tests/daemon.test.ts` proves the queue against `mock-agent.mjs`;
 *   this proves a real request reaches it, and that the answer is obeyed.
 * - **A room participant whose mode changes between turns** (M6-5, #149). The
 *   room sends `modeMap.safe` for `safe` and `modeMap.ask` for `auto`, before
 *   the first turn after the change. Never `modeMap.auto`: claude's is
 *   `bypassPermissions`, where it stops asking us.
 *
 * Every assertion is on our own record: the decisions on the event stream,
 * the run's status, the file on the task branch or in the participant's
 * checkout. The one thing taken from the harness is the kind of request
 * claude makes in plan mode (`switch_mode`), the same signal
 * `claude.itest.ts` reads for `safe`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  ParticipantDto,
  PendingDecision,
  RoomDto,
  RoomEventLine,
  RunDto,
} from "../client/contract.ts";
import { READ_ONLY_KINDS } from "../core/policy.ts";
import type { ClientPermissionEvent, ToolKind } from "../protocol/types.ts";
import {
  addRepo,
  bootDaemon,
  daemonApi,
  gitRepo,
  needs,
  WRITE_PROMPT,
} from "./helpers.ts";

/** Calls `check` until it returns a value, or fails after `ms`. A real
 *  harness takes far longer than the mock, so the suite's 20 s polls are
 *  too short here. */
async function poll<T>(
  what: string,
  check: () => Promise<T | undefined>,
  ms = 150_000,
): Promise<T> {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    const found = await check();
    if (found !== undefined) return found;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error(`${what}: timed out`);
}

/** Does `branch` carry `file`? False when the branch is gone, too. */
function onBranch(root: string, branch: string, file: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", `${branch}:${file}`], { cwd: root })
      .status === 0
  );
}

/** The task ran to its end. `warned` is still an end: the harness's own
 *  report did not match its changes, and that report is the model's prose. */
const finished = (status: string) => status === "done" || status === "warned";

/** A kind `safe` refuses. Not only `edit`: a harness may write through its
 *  shell (`execute`), and that request reaches the same queue. */
const mutating = (kind: string) => !READ_ONLY_KINDS.has(kind as ToolKind);

/** The suite's 180 s per-test cap is shorter than this file's waits: one
 *  start plus one 150 s poll can pass it, and the room test polls twice. A
 *  per-test cap this size lets `poll` report what timed out. */
const SLOW = { timeout: 400_000 } as const;

/**
 * Starts an `ask` run of one write task, answers every decision it queues
 * with `allow`, and returns the settled run and the kinds it was asked.
 */
async function answeredRun(t: TestContext, agent: string, allow: boolean) {
  const d = await bootDaemon(t);
  const cwd = await gitRepo(t);
  await addRepo(d, cwd);

  const posted = await daemonApi<RunDto>(d, "POST", "/runs", {
    cwd,
    run: { agent, mode: "ask", tasks: [{ id: "one", prompt: WRITE_PROMPT }] },
  });
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const runId = posted.body.id;

  const asked: string[] = [];
  const run = await poll("run settled", async () => {
    const pending = await daemonApi<PendingDecision[]>(
      d,
      "GET",
      "/permissions",
    );
    for (const p of pending.body) {
      if (!("runId" in p) || p.runId !== runId) continue;
      asked.push(p.kind);
      const r = await daemonApi(d, "POST", `/permissions/${p.id}`, { allow });
      // 409: the decision closed between the list and the answer.
      assert.ok(r.status === 200 || r.status === 409, `answer: ${r.status}`);
    }
    const r = await daemonApi<RunDto>(d, "GET", `/runs/${runId}`);
    return r.body.status === "running" ? undefined : r.body;
  });
  return { cwd, run, asked };
}

for (const [agent, bin] of [
  ["claude", "claude-agent-acp"],
  ["copilot", "copilot"],
] as const) {
  const skip = needs(bin);

  test(`${agent}: an ask run denied over HTTP writes nothing`, {
    skip,
    ...SLOW,
  }, async (t) => {
    const { cwd, run, asked } = await answeredRun(t, agent, false);

    assert.ok(
      asked.some(mutating),
      `the harness asked the daemon to change something: ${JSON.stringify(asked)}`,
    );
    assert.ok(
      finished(run.status),
      `a denial ends the turn, not the run: ${run.status}`,
    );
    const [task] = run.tasks;
    assert.ok(task, "the run has its one task");
    assert.equal(
      task.branch !== undefined && onBranch(cwd, task.branch, "PROOF.md"),
      false,
      "no PROOF.md on the task branch",
    );
    assert.equal(existsSync(join(cwd, "PROOF.md")), false);
  });

  test(`${agent}: an ask run allowed over HTTP writes the file`, {
    skip,
    ...SLOW,
  }, async (t) => {
    const { cwd, run, asked } = await answeredRun(t, agent, true);

    assert.ok(
      asked.some(mutating),
      `the harness asked the daemon to change something: ${JSON.stringify(asked)}`,
    );
    assert.ok(finished(run.status), run.status);
    const [task] = run.tasks;
    assert.ok(task?.branch, "a task that wrote keeps its branch");
    assert.ok(
      onBranch(cwd, task.branch, "PROOF.md"),
      "PROOF.md is committed on the task branch",
    );
    // The run works in its own checkout, never in the operator's.
    assert.equal(existsSync(join(cwd, "PROOF.md")), false);
  });
}

type RoomReply = RoomDto & { error?: { message: string } };

test("claude: a room participant moved from safe to auto is told, and still asks", {
  skip: needs("claude-agent-acp"),
  ...SLOW,
}, async (t) => {
  const d = await bootDaemon(t);
  const cwd = await gitRepo(t);
  await addRepo(d, cwd);

  const open = await daemonApi<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ agent: "claude", name: "c", mode: "safe" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const roomId = open.body.id;
  const [p] = open.body.participants;
  assert.ok(p, "the room opened with its participant");
  const base = `/rooms/${roomId}/agents/${p.id}`;

  const turn = async () => {
    const sent = await daemonApi(d, "POST", `${base}/messages`, {
      text: WRITE_PROMPT,
    });
    assert.equal(sent.status, 202);
    const status = await poll("turn ended", async () => {
      const r = await daemonApi<ParticipantDto>(d, "GET", base);
      return r.body.status === "busy" ? undefined : r.body.status;
    });
    // `exited` is a dead harness, not a mode bug: say so here.
    assert.equal(status, "idle", "the turn ended with the harness alive");
  };

  await turn();
  // Plan mode is advisory, so turn 1 may have written anyway
  // (`claude.itest.ts`). Remove it, so the file below is turn 2's.
  const proof = join(p.worktree, "PROOF.md");
  rmSync(proof, { force: true });
  const patched = await daemonApi(d, "PATCH", base, { mode: "auto" });
  assert.equal(patched.status, 200);
  await turn();
  // Read before the dismissal, which may remove the checkout. Claude writes
  // with its own tool, not `fs/write_text_file`, so no `_client_wrote_file`.
  const wrote = existsSync(proof);

  const dismissed = await daemonApi(d, "POST", `/rooms/${roomId}/dismiss`);
  assert.equal(dismissed.status, 200);
  // The stream ends once the room's log closes, so read it after the dismissal.
  const res = await fetch(`${d.url}/rooms/${roomId}/agents/${p.id}/events`, {
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(res.status, 200, "the participant's stream opened");
  const text = await res.text();
  const lines: RoomEventLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.startsWith("data: ")) continue;
    try {
      lines.push(JSON.parse(raw.slice(6)) as RoomEventLine);
    } catch {
      assert.fail(`bad SSE line from the room: ${raw.slice(0, 120)}`);
    }
  }

  // Split the decisions by turn, at each user message.
  const turns: ClientPermissionEvent[][] = [];
  for (const { update } of lines) {
    if (update.sessionUpdate === "_client_user_message") turns.push([]);
    if (update.sessionUpdate === "_client_permission") {
      turns.at(-1)?.push(update);
    }
  }
  assert.equal(turns.length, 2);
  const [safe, auto] = turns as [
    ClientPermissionEvent[],
    ClientPermissionEvent[],
  ];

  // Turn 1, safe: plan mode was sent, so claude asks to leave it, and is refused.
  assert.ok(
    safe.some((u) => u.kind === "switch_mode" && u.allow === false),
    `safe refused a switch_mode: ${JSON.stringify(safe)}`,
  );
  assert.ok(
    safe.every((u) => u.allow === false || !mutating(u.kind)),
    `safe allowed nothing that changes a file: ${JSON.stringify(safe)}`,
  );

  // Turn 2, auto: `default` was sent, so claude is out of plan mode and does
  // not ask to leave it. It still asks us, which `bypassPermissions` would not.
  assert.ok(auto.length > 0, "auto: claude still asks the client");
  assert.ok(
    auto.every((u) => u.kind !== "switch_mode"),
    `auto: no switch_mode, so the mode change reached claude: ${JSON.stringify(auto)}`,
  );
  assert.ok(wrote, "turn 2 wrote PROOF.md in the participant's checkout");
});
