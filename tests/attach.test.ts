/**
 * The client side of a detached run: `kapelle run --detach` and
 * `kapelle attach` (M2-9), on a pipe and on a terminal through `script(1)`,
 * across a daemon kill and a restart. A real `daemon.ts` and
 * `mock-agent.mjs`; no harness.
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` **and `XDG_STATE_HOME`**, so no
 * test ever meets another test's `daemon.json` or `repos.json` — or the
 * developer's real ones — even while the other files run at the same time.
 * The helpers more than one of these files needs live in
 * `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { stateDirFor } from "../core/runtime.ts";
import {
  addRepo as added,
  api,
  askRun,
  bootDaemon as boot,
  type Daemon,
  useDaemonDirs as dirs,
  gitRepo,
  MOCK_AGENT,
  mockRun,
  type Pending,
  pendingOne,
  REPO,
  settled,
  spawnCli,
  tempDir,
  until,
} from "../integration/helpers.ts";

// --- across a restart (M2-6, #36) -------------------------------------------

/** A detached run whose one task stalls mid-turn, with `attach` following
 *  it. Resolves once the task's record reads `running`. */
async function attachedToStall(
  t: TestContext,
  d: Daemon,
  env: Record<string, string>,
) {
  const root = await realpath(await added(d, await gitRepo(t)));
  const posted = await api(d, "POST", "/runs", {
    cwd: root,
    run: mockRun([
      { id: "stuck", prompt: "hi", cmd: `node ${MOCK_AGENT} --scenario stall` },
    ]),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;
  const attached = spawnCli(t, ["attach", id], "cli.ts", env);
  await attached.waitFor(`attached to ${id}`);
  await until("the task to run", async () => {
    const r = await api(d, "GET", `/runs/${id}`);
    return r.body.tasks?.[0]?.status === "running";
  });
  return { id, attached };
}

test("attach rides out a kill -9 and a restart, and ends on the killed status", async (t) => {
  // M5-6 (#138): the new daemon has a new token and, with --port 0, a new
  // port, so attach must read daemon.json again on every try.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const { id, attached } = await attachedToStall(
    t,
    first,
    dirs(runtime, state),
  );

  process.kill(first.pid, "SIGKILL");
  await first.done;
  const second = await boot(t, runtime, [], state);

  const r = await attached.done;
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /lost the daemon .*reconnecting/);
  assert.match(r.stderr, new RegExp(`reconnected to ${id}`));
  assert.match(r.stdout, /killed — 1 task/);
  assert.equal(
    r.stdout.split(`attached to ${id}`).length,
    2,
    "one attach line",
  );

  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});

test("attach exits, and does not wait for a new daemon, after a clean stop", async (t) => {
  // M5-6 (#138): a clean stop removes daemon.json, which is how attach tells
  // it from a crash. The daemon exits as soon as its runs settle, so the
  // stream can end cleanly or be cut, and attach may read the run's status or
  // not. Either way it must exit, with the verdict or the hint.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const d = await boot(t, runtime, [], state);
  const { attached } = await attachedToStall(t, d, dirs(runtime, state));

  process.kill(d.pid, "SIGTERM");
  assert.equal((await d.done).code, 0);
  const r = await attached.done;
  assert.equal(r.code, 1, r.stderr);
  assert.match(`${r.stdout}${r.stderr}`, /cancelled — 1 task|attach again/);
});

test("attach trusts a killed run status over a log whose task_finished beat the record", async (t) => {
  // M5-5 (#137): a crash can land after `_client_task_finished
  // {status:"done"}` is emitted and before the task's record write, so the
  // sweep marks the run — and the still-`running` task — `killed` while the
  // log's only card reads done. `attach` must not call that run done.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const id = "crashed-lag";
  const dir = join(stateDirFor(root), "runs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    `${JSON.stringify({
      runId: id,
      root,
      cwd: root,
      status: "running",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      tasks: [{ id: "one", status: "running", agent: "mock-agent" }],
    })}\n`,
  );
  await writeFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({
      seq: 1,
      at: new Date().toISOString(),
      agent: "one",
      update: {
        sessionUpdate: "_client_task_finished",
        status: "done",
        durationMs: 1,
      },
    })}\n`,
  );

  const second = await boot(t, runtime, [], state);
  const restored = await api(second, "GET", `/runs/${id}`);
  assert.equal(restored.body.status, "killed");
  assert.deepEqual(
    restored.body.tasks.map((task) => [task.id, task.status]),
    [["one", "killed"]],
  );

  const attached = await spawnCli(
    t,
    ["attach", id],
    "cli.ts",
    dirs(runtime, state),
  ).done;
  assert.equal(attached.code, 1, attached.stderr);
  // The card comes from the log and reads done; the run verdict must not.
  assert.match(attached.stdout, /one \([^)]*\) done/);
  assert.match(attached.stdout, /killed — 1 task/);
  assert.doesNotMatch(attached.stdout, /done —/);

  // `--quiet` suppresses the summary, not the fact that the run failed. The
  // only card reads done, so the run-level `killed` verdict is the only thing
  // left to report; failing silently on exit 1 would break that contract.
  const quietAttach = await spawnCli(
    t,
    ["attach", id, "--quiet"],
    "cli.ts",
    dirs(runtime, state),
  ).done;
  assert.equal(quietAttach.code, 1, quietAttach.stderr);
  assert.equal(quietAttach.stdout, "");
  assert.match(quietAttach.stderr, new RegExp(`error: run ${id} killed`));

  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});

// --- kapelle run --detach and kapelle attach, M2-9 ------------------------------

/** `kapelle run --file <run> --detach` against `d`; returns the id it printed. */
async function detach(
  t: TestContext,
  env: Record<string, string>,
  cwd: string,
  run: unknown,
): Promise<string> {
  const file = join(await tempDir(t), "run.json");
  await writeFile(file, JSON.stringify(run));
  const r = await spawnCli(
    t,
    ["run", "--file", file, "--detach", "--cwd", cwd],
    "cli.ts",
    env,
  ).done;
  assert.equal(r.code, 0, r.stderr);
  const id = r.stdout.trim();
  assert.match(id, /^\S+$/, "stdout carries the run id and nothing else");
  assert.match(r.stderr, new RegExp(`kapelle attach ${id}\n`));
  // Every task id it can be attached to, and how.
  const ids = (run as { tasks: { id: string }[] }).tasks.map((task) => task.id);
  assert.match(r.stderr, new RegExp(`tasks: ${ids.join(", ")}\n`));
  assert.match(r.stderr, new RegExp(`kapelle attach ${id} --task <taskId>`));
  return id;
}

// `script` from util-linux gives `attach` a real TTY; BSD's takes other flags.
const noScript = spawnSync("script", ["--version"])
  .stdout?.toString()
  .includes("util-linux")
  ? false
  : "needs util-linux script for a TTY";

test("run --detach returns the id; attach on a TTY answers both asks and exits with the run", {
  skip: noScript,
}, async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  const d = await boot(t, runtime);
  const cwd = await added(d, await tempDir(t));
  const id = await detach(t, env, cwd, askRun(cwd).run);

  // The run goes on without the terminal that started it.
  assert.equal((await pendingOne(d)).runId, id);

  const child = spawn(
    "script",
    ["-qfec", `${process.execPath} cli.ts attach ${id}`, "/dev/null"],
    { cwd: REPO, env: { ...process.env, ...env } },
  );
  t.after(() => void child.kill("SIGKILL"));
  let out = "";
  const done = new Promise<number | null>((ok) => child.on("close", ok));
  // The mock asks twice: the edit (allowed here), then an allow-only delete.
  const answers = ["y\n", "n\n"];
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    out += text;
    const asked = out.split("allow? [y/N]").length - 1;
    while (answers.length > 2 - asked) child.stdin.write(answers.shift());
  });

  assert.equal(await done, 0, out);
  assert.match(out, /attached to /);
  assert.match(out, /wants to run \[edit\]/);
  assert.match(out, /▸ one \(mock-agent\) done/);
  assert.match(out, /done — 1 task/);
  await stat(join(cwd, "ACP_TEST.md"));
  assert.deepEqual((await api(d, "GET", "/permissions")).body, []);
});

test("attach replays a finished run, and refuses an unknown id or a missing daemon", async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);

  const none = await spawnCli(t, ["attach", "x"], "cli.ts", env).done;
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no daemon is listening/);

  const d = await boot(t, runtime);
  const cwd = await added(d, await tempDir(t));
  const id = await detach(
    t,
    env,
    cwd,
    mockRun([
      { id: "a", prompt: "hi" },
      { id: "b", prompt: "hi" },
    ]),
  );
  await settled(d, id);

  const r = await spawnCli(t, ["attach", id], "cli.ts", env).done;
  assert.equal(r.code, 0, r.stderr);
  // Both cards and the verdict, built from the stream alone.
  assert.match(r.stdout, /▸ a \(mock-agent\) done/);
  assert.match(r.stdout, /▸ b \(mock-agent\) done/);
  assert.match(r.stdout, /done — 2 tasks/);

  const unknown = await spawnCli(t, ["attach", "nope"], "cli.ts", env).done;
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stderr.trim(), "error: no run nope");
});

test("attach --task draws that one task in full, and refuses a task the run lacks", async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  const d = await boot(t, runtime);
  const cwd = await added(d, await tempDir(t));
  const id = await detach(
    t,
    env,
    cwd,
    mockRun([
      // A failed sibling: `--task b` must still answer for b alone (#170).
      { id: "a", prompt: "hi", cmd: `node ${MOCK_AGENT} --scenario refuse` },
      { id: "b", prompt: "hi" },
    ]),
  );
  assert.equal((await settled(d, id)).status, "failed");

  const r = await spawnCli(t, ["attach", id, "--task", "b"], "cli.ts", env)
    .done;
  assert.equal(r.code, 0, r.stderr);
  // Drawn by `render.ts`, tagged by task: b's tool calls and prose, none of a's.
  assert.match(r.stdout, /\[b\].*Read package\.json/);
  assert.match(r.stdout, /Reading package\.json via the client/);
  assert.doesNotMatch(r.stdout, /\[a\]|▸ a /);
  // Notices are filtered the same way: a's advisory line must not survive
  // into b's view (M2-9 amendment, "with only its asks").
  assert.doesNotMatch(r.stderr, /\[a\]/);
  assert.match(r.stdout, /▸ b \(mock-agent\) done/);
  assert.match(r.stdout, /done — 1 task/);
  // The prose is drawn once, live, not again on the card.
  assert.equal(r.stdout.split("Reading package.json via").length - 1, 1);

  const none = await spawnCli(t, ["attach", id, "--task", "zz"], "cli.ts", env)
    .done;
  assert.equal(none.code, 1);
  // The run-level notice still prints first: it concerns every task, and the
  // other task's notices are filtered out with its events.
  assert.match(none.stderr, /not a git repository/);
  assert.ok(
    none.stderr.trimEnd().endsWith(`error: run ${id} has no task zz`),
    none.stderr,
  );
});

test("attach asks one permission at a time when two tasks wait", {
  skip: noScript,
}, async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const id = await detach(t, env, cwd, {
    cmd: `node ${MOCK_AGENT}`,
    maxConcurrency: 2,
    tasks: [
      { id: "one", prompt: "hi" },
      { id: "two", prompt: "hi" },
    ],
  });

  const child = spawn(
    "script",
    ["-qfec", `${process.execPath} cli.ts attach ${id}`, "/dev/null"],
    { cwd: REPO, env: { ...process.env, ...env } },
  );
  t.after(() => void child.kill("SIGKILL"));
  let out = "";
  let answered = 0;
  const asked = () => out.split("allow? [y/N]").length - 1;
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    out += text;
  });

  // Both tasks reach their first ask, so the daemon holds two decisions while
  // the client has printed one question: the `answering` chain holds the rest.
  for (const until = Date.now() + 10_000; asked() < 1; ) {
    if (Date.now() > until) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.ok(asked() >= 1, out);
  for (const until = Date.now() + 10_000; ; ) {
    if ((await api<Pending[]>(d, "GET", "/permissions")).body.length >= 2) {
      break;
    }
    if (Date.now() > until) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.ok(
    (await api<Pending[]>(d, "GET", "/permissions")).body.length >= 2,
    "both tasks should have a pending decision",
  );
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(asked(), 1, out);

  // Answer the rest as they appear; the mock's delete offers no reject, so
  // the topic named in the latest prompt is the decision to make.
  const answerShown = () => {
    while (answered < asked()) {
      const prompt = out.slice(out.lastIndexOf("wants to run"));
      child.stdin.write(prompt.includes("[delete]") ? "n\n" : "y\n");
      answered++;
    }
  };
  const closed = new Promise<number | null>((ok) => child.on("close", ok));
  for (const until = Date.now() + 15_000; ; ) {
    answerShown();
    if (child.exitCode !== null || Date.now() > until) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  answerShown();
  assert.equal(
    await Promise.race([
      closed,
      new Promise<string>((ok) => setTimeout(() => ok("hung"), 15_000).unref()),
    ]),
    0,
    out,
  );
  assert.equal(asked(), 4, out);
  assert.match(out, /▸ one \(mock-agent\) done/);
  assert.match(out, /▸ two \(mock-agent\) done/);
  assert.match(out, /done — 2 tasks/);
});

test("attach --task asks only that task, never its sibling", {
  skip: noScript,
}, async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  // The sibling's unanswered asks deny at the timeout, so the run ends;
  // the selected task's asks are answered at once.
  const d = await boot(t, runtime, ["--permission-timeout", "2"]);
  const cwd = await added(d, await gitRepo(t));
  const id = await detach(t, env, cwd, {
    cmd: `node ${MOCK_AGENT}`,
    maxConcurrency: 2,
    tasks: [
      { id: "one", prompt: "hi" },
      { id: "two", prompt: "hi" },
    ],
  });

  const child = spawn(
    "script",
    [
      "-qfec",
      `${process.execPath} cli.ts attach ${id} --task one`,
      "/dev/null",
    ],
    { cwd: REPO, env: { ...process.env, ...env } },
  );
  t.after(() => void child.kill("SIGKILL"));
  let out = "";
  let answered = 0;
  const asked = () => out.split("allow? [y/N]").length - 1;
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    out += text;
    while (answered < asked()) {
      const prompt = out.slice(out.lastIndexOf("wants to run"));
      child.stdin.write(prompt.includes("[delete]") ? "n\n" : "y\n");
      answered++;
    }
  });

  const code = await Promise.race([
    new Promise<number | null>((ok) => child.on("close", ok)),
    new Promise<string>((ok) => setTimeout(() => ok("hung"), 20_000).unref()),
  ]);
  assert.equal(code, 0, out);
  // One's two asks only: `two` was filtered out entirely, asks included.
  assert.equal(asked(), 2, out);
  assert.match(out, /one wants to run \[edit\]/);
  assert.doesNotMatch(out, /two wants to run/);
  assert.match(out, /▸ one \(mock-agent\) done/);
  assert.match(out, /done — 1 task/);
});

test("attach without a TTY names the pending ask, and ^C leaves the run running", async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  const d = await boot(t, runtime);
  const cwd = await added(d, await tempDir(t));
  const id = await detach(t, env, cwd, askRun(cwd).run);
  await pendingOne(d);

  const a = spawnCli(t, ["attach", id], "cli.ts", env);
  // The wait line is on stderr, which `waitFor` does not watch.
  const waiting = new Promise<void>((ok) => {
    let err = "";
    a.child.stderr.on("data", (text: string) => {
      err += text;
      if (err.includes("waiting on [edit]")) ok();
    });
  });
  await Promise.race([
    waiting,
    a.done.then((r) => {
      throw new Error(`attach exited ${r.code}: ${r.stderr}`);
    }),
  ]);
  a.child.kill("SIGINT");
  assert.equal((await a.done).code, 130);
  assert.equal((await api(d, "GET", `/runs/${id}`)).body.status, "running");
});

test("run --detach in a folder never added is the daemon's 403, and kapelle --file is refused", async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  await boot(t, runtime);
  const file = join(await tempDir(t), "run.json");
  await writeFile(file, JSON.stringify(mockRun([{ id: "a", prompt: "hi" }])));

  const r = await spawnCli(
    t,
    ["run", "--file", file, "--detach", "--cwd", await tempDir(t)],
    "cli.ts",
    env,
  ).done;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: .* has not been added to the daemon/);
  assert.equal(r.stdout, "");

  const bare = await spawnCli(t, ["--file", file], "cli.ts", env).done;
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /kapelle run --file <run.json>/);

  const noFile = await spawnCli(t, ["run"], "cli.ts", env).done;
  assert.equal(noFile.code, 1);
  assert.match(noFile.stderr, /run needs a run file/);
});

test("^C at attach's y/N prompt exits 130 and leaves the run running", {
  skip: noScript,
}, async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  const d = await boot(t, runtime);
  const cwd = await added(d, await tempDir(t));
  const id = await detach(t, env, cwd, askRun(cwd).run);

  // `script -e` returns the child's exit status, so 130 is attach's own.
  const child = spawn(
    "script",
    ["-qfec", `${process.execPath} cli.ts attach ${id}`, "/dev/null"],
    { cwd: REPO, env: { ...process.env, ...env } },
  );
  t.after(() => void child.kill("SIGKILL"));
  let out = "";
  let sent = false;
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    out += text;
    if (!sent && out.includes("allow? [y/N]")) {
      sent = true;
      child.stdin.write("\x03");
    }
  });
  const code = await Promise.race([
    new Promise<number | null>((ok) => child.on("close", ok)),
    new Promise<string>((ok) => setTimeout(() => ok("hung"), 10_000)),
  ]);
  assert.equal(code, 130, out);
  assert.equal((await api(d, "GET", `/runs/${id}`)).body.status, "running");
});

test("an answer typed after the timeout decided is the daemon's 409, printed, and attach carries on", {
  skip: noScript,
  // One scenario drives the daemon, PTY and permission API together.
  // pi-lens-ignore: high-fan-out
}, async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  // Leave enough room for the PTY and attach to open a prompt on a loaded
  // suite. The late answer still waits for the recorded timeout below.
  const d = await boot(t, runtime, ["--permission-timeout", "10"]);
  const cwd = await added(d, await tempDir(t));
  const id = await detach(t, env, cwd, askRun(cwd).run);
  const permission = await pendingOne(d);

  const child = spawn(
    "script",
    ["-qfec", `${process.execPath} cli.ts attach ${id}`, "/dev/null"],
    { cwd: REPO, env: { ...process.env, ...env } },
  );
  t.after(() => void child.kill("SIGKILL"));
  const closed = new Promise<number | null>((ok) => child.on("close", ok));
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    out += text;
  });

  await until("the edit prompt", () => out.includes("wants to run [edit]"));
  // A slow daemon can settle its timer after a fixed-delay answer. Wait for
  // the recorded timeout so the late answer must get the daemon's 409.
  await until("the edit permission to time out", async () => {
    const r = await api<{ reason?: string }>(
      d,
      "GET",
      `/permissions/${permission.id}`,
    );
    return r.body.reason === "timeout";
  });
  child.stdin.write("y\n");
  const next = await pendingOne(d);
  await until("the delete prompt", () => out.includes("wants to run [delete]"));
  child.stdin.write("n\n");
  await until("the delete permission to be answered", async () => {
    const decision = await api<{ allow?: boolean; reason?: string }>(
      d,
      "GET",
      `/permissions/${next.id}`,
    );
    if (decision.body.reason === undefined) return false;
    assert.equal(decision.body.allow, false);
    assert.equal(decision.body.reason, "client");
    return true;
  });

  assert.equal(await closed, 0, out);
  assert.match(out, /error: permission \S+ was already decided/);
  assert.match(out, /done — 1 task/);
  // The timeout's deny stands: the late "y" wrote nothing.
  await assert.rejects(stat(join(cwd, "ACP_TEST.md")));
});
