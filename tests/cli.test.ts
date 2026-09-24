/**
 * The CLI surface — `cli.ts`, one prompt or a run file — driven as a real
 * subprocess.
 *
 * **None of this needs a harness**, so unlike `integration/`, it runs in CI on
 * every push. Everything that needs a session uses `mock-agent.mjs`; the rest
 * fails before a subprocess is ever spawned.
 *
 * It exists because the manual test list found bugs no suite could catch. The
 * first test below is the regression guard for one of them: `--agent nope`
 * printed the right sentence wrapped in a raw Node stack banner, because
 * `resolveAgent` was the one validator called outside a `try`.
 *
 * The plumbing is shared with the real-harness suite (`integration/helpers.ts`)
 * rather than copied — `runCli` (which wraps `spawnCli`), `tempDir`, and
 * `MOCK_AGENT` are about our CLI, not about who answers it.
 */

import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const git = async (cwd: string, ...args: string[]) =>
  (await execFile("git", args, { cwd })).stdout.trim();

import { stateDirFor } from "../core/runtime.ts";
import {
  gitRepo,
  HOSTILE_AGENT,
  MOCK_AGENT,
  runCli,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";

const MOCK = ["--cmd", `node ${MOCK_AGENT}`];

// --- argv validation ---------------------------------------------------------

test("an unknown agent is one line, never a stack trace", async (t) => {
  const r = await runCli(t, ["hi", "--agent", "nope"]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown agent "nope"\. Known: opencode/);
  // The regression itself: the sentence used to arrive buried in frames.
  assert.doesNotMatch(r.stderr, /at resolveAgent|Node\.js v\d/);
});

test("an unknown mode names the modes that exist", async (t) => {
  const r = await runCli(t, ["hi", "--mode", "yolo"]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown mode "yolo"\. Known: safe, ask, auto\./);
  assert.doesNotMatch(r.stderr, /Node\.js v\d/);
});

test("a flag that is present but carries no value is a usage error", async (t) => {
  // `--cmd --mode auto` must not launch the default harness under a mode the
  // caller never meant to pair it with.
  const r = await runCli(t, ["hi", "--cmd", "--mode", "auto"]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /--cmd needs a value/);
});

test("no prompt is a usage error; --help is not", async (t) => {
  const bare = await runCli(t, []);
  assert.equal(bare.code, 1);
  assert.match(bare.stdout, /minimal Agent Client Protocol client/);
  assert.match(bare.stdout, /kapelle/);
  assert.doesNotMatch(bare.stdout, /acp-mvp/);

  const help = await runCli(t, ["hi", "--help"]);
  assert.equal(help.code, 0);
});

test("merge without a run id is a usage error, not a prompt", async (t) => {
  const r = await runCli(t, ["merge"]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /merge needs one run id/);
});

test("merge is recognized when --cwd precedes the subcommand", async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, ["--cwd", cwd, "merge", ...MOCK, "--mode", "auto"]);

  // It must dispatch to merge and fail on the missing run id, not launch the
  // single-agent prompt path with "merge" as prose.
  assert.equal(r.code, 1);
  assert.match(r.stderr, /merge needs one run id/);
  assert.deepEqual(await readdir(cwd), []);
});

test("--rebase is refused as M3-4 territory", async (t) => {
  const r = await runCli(t, ["merge", "20260909-120000-abcd", "--rebase"]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /--rebase lands in M3-4/);
});

// --- notices and --quiet -----------------------------------------------------

test("an unverified harness warns, and --quiet drops that line", async (t) => {
  const cwd = await tempDir(t);
  const loud = await runCli(t, [
    "self test",
    ...MOCK,
    "--mode",
    "auto",
    "--cwd",
    cwd,
  ]);
  assert.match(loud.stderr, /no measured labels for this harness/);

  const quiet = await runCli(t, [
    "self test",
    ...MOCK,
    "--mode",
    "auto",
    "--quiet",
    "--cwd",
    cwd,
  ]);
  assert.equal(quiet.stdout, "");
  assert.equal(
    quiet.stderr,
    "",
    "unverified is advisory, so --quiet may drop it",
  );
});

test("a dirty tree runs, and --quiet drops the uncommitted advisory (#129)", async (t) => {
  // The dirty-tree notice is advisory (issue #129 AC: "--quiet drops it"),
  // and no test pinned that end-to-end: mutating `cli.ts` to always print
  // any "uncommitted" notice would keep every other test in this file green.
  const cwd = await gitRepo(t);
  await writeFile(join(cwd, "wip.txt"), "uncommitted\n");
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));

  const loud = await runCli(t, ["run", "--file", file, "--cwd", cwd]);
  assert.match(loud.stderr, /1 uncommitted file in .* will not reach any task/);
  // The line names the root `git rev-parse --show-toplevel` resolved, not the
  // spelling `--cwd` was given, so the fixture path has to be realpath'd
  // before it can match (macOS: `/var` -> `/private/var`).
  const resolved = await realpath(cwd);
  assert.match(
    loud.stderr,
    new RegExp(resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd, "--quiet"]);
  assert.doesNotMatch(
    r.stderr,
    /uncommitted/,
    "the dirty-tree notice is advisory, so --quiet drops it",
  );
});

test("safe says out loud that it could not negotiate", async (t) => {
  // A --cmd spec has no measured mode ids, so the negotiate half of `safe` is
  // skipped rather than guessed — and skipping is never silent.
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "self test",
    ...MOCK,
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.match(r.stderr, /safe mode was not negotiated/);
});

test("--cwd is the workspace root the write lands in", async (t) => {
  const cwd = await tempDir(t);
  await runCli(t, ["self test", ...MOCK, "--mode", "auto", "--cwd", cwd]);

  assert.deepEqual(await readdir(cwd), ["ACP_TEST.md"]);
});

test("safe refuses the write, and the workspace stays empty", async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "self test",
    ...MOCK,
    "--mode",
    "safe",
    "--cwd",
    cwd,
  ]);

  assert.deepEqual(await readdir(cwd), []);
  // A menu with no reject option must answer `cancelled`, never a guessed allow.
  assert.match(r.stdout, /"outcome":"cancelled"/);
});

test("ask without a TTY re-resolves as safe, and says so", async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "self test",
    ...MOCK,
    "--mode",
    "ask",
    "--cwd",
    cwd,
  ]);

  assert.match(r.stderr, /not a TTY — falling back to --mode safe/);
  assert.deepEqual(
    await readdir(cwd),
    [],
    "safe's rules apply to what actually ran",
  );
});

// --- run files: `cli.ts --file` (M1b-2, #18) ---------------------------------

/** A run file, written where `cli.ts` can read it. */
async function runFile(
  t: import("node:test").TestContext,
  run: Record<string, unknown>,
) {
  const dir = await tempDir(t);
  const path = join(dir, "demo.run.json");
  await writeFile(path, JSON.stringify(run), "utf8");
  return path;
}

const mockRun = (
  tasks: Record<string, unknown>[],
  rest: Record<string, unknown> = {},
) => ({
  cmd: `node ${MOCK_AGENT}`,
  mode: "auto",
  ...rest,
  tasks,
});

test("--file runs every task and reports each one", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun(
      [
        { id: "one", prompt: "task one" },
        { id: "two", prompt: "task two" },
        { id: "three", prompt: "task three" },
      ],
      { maxConcurrency: 2 },
    ),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.equal(r.code, 0);
  for (const id of ["one", "two", "three"]) {
    assert.match(r.stdout, new RegExp(`▸ ${id} \\(mock-agent\\) done`));
  }
  assert.match(r.stdout, /done — 3 tasks, 3 turns/);
});

test("--file runs write the same event log the daemon replays", async (t) => {
  // M2-2 acceptance: `core/run.ts` subscribes the log, so the run-file path
  // writes one too. The daemon half is covered in tests/daemon.test.ts.
  const cwd = await tempDir(t);
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);
  assert.equal(r.code, 0);

  const [runId] = await readdir(join(stateDirFor(cwd), "runs"));
  const events = (
    await readFile(
      join(stateDirFor(cwd), "runs", String(runId), "events.jsonl"),
      "utf8",
    )
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(
    events.map((e) => e.seq),
    Array.from({ length: events.length }, (_, i) => i + 1),
  );
  // Every event is the task's, except the run's own last one (M5-5).
  const last = events.pop();
  assert.equal(last.agent, "");
  assert.equal(last.update.sessionUpdate, "_client_run_finished");
  assert.equal(last.update.status, "done");
  for (const e of events) {
    assert.equal(e.agent, "one");
    assert.equal(typeof e.update.sessionUpdate, "string");
  }
  const kinds = events.map((e) => e.update.sessionUpdate);
  assert.ok(kinds.includes("_client_task_started"), "started is logged");
  assert.ok(kinds.includes("_client_task_finished"), "finished is logged");
  assert.ok(kinds.includes("agent_message_chunk"), "prose is logged raw");
});

test("every run-file task carries its own advisory notice, on stderr", async (t) => {
  // A `--cmd` spec is unmeasured, so the reachable offline notice is the
  // advisory "no measured labels" line. Every task starts its own harness,
  // so every task must report the harness it is about to trust.
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun([
      { id: "one", prompt: "task one" },
      { id: "two", prompt: "task two" },
    ]),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.equal(
    (r.stderr.match(/no measured labels for this harness/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(r.stdout, /no measured labels/);
});

test("prose is buffered per task, never braided together", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun([
      { id: "one", prompt: "task one" },
      { id: "two", prompt: "task two" },
    ]),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  // Each task's block is contiguous: its whole transcript sits between its
  // own header and the next one. Interleaving would split it.
  const [, first = ""] = r.stdout.split("▸ one (mock-agent)");
  const [block = ""] = first.split("▸ two (mock-agent)");
  assert.match(block, /Wrote ACP_TEST\.md\./);
  assert.equal((block.match(/Wrote ACP_TEST\.md\./g) ?? []).length, 1);
});

test("a run file's own agent and mode cannot be overridden from argv", async (t) => {
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));
  const cwd = await tempDir(t);

  for (const flag of [
    ["--mode", "safe"],
    ["--agent", "opencode"],
    ["--cmd", "true"],
  ]) {
    const r = await runCli(t, ["run", "--file", file, "--cwd", cwd, ...flag]);
    assert.equal(r.code, 1, flag[0]);
    assert.match(r.stderr, new RegExp(`${flag[0]} does not apply with --file`));
  }
});

test("a bad run file is the validator's sentence, not a stack", async (t) => {
  // `needs` is the one that matters: it must not validate and then run in
  // parallel, which is a plausible wrong answer rather than an error.
  const file = await runFile(
    t,
    mockRun([{ id: "one", prompt: "hi", needs: ["two"] }]),
  );
  const cwd = await tempDir(t);

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /task dependencies land in M3/);
  assert.doesNotMatch(r.stderr, /Node\.js v\d/);
});

test("a bad project config refuses a run-file run, naming the key", async (t) => {
  const root = await gitRepo(t);
  await mkdir(join(root, ".kapelle"), { recursive: true });
  // 0o644, not the umask's default: a group-writable config is refused
  // (core/config.ts), and umask 0002 would make one.
  await writeFile(
    join(root, ".kapelle", "config.json"),
    JSON.stringify({ stallIdle: 1 }),
    { mode: 0o644 },
  );
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));

  const r = await runCli(t, ["run", "--file", file, "--cwd", root]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown key "stallIdle"/);
  assert.doesNotMatch(r.stderr, /Node\.js v\d/);
});

test("a missing run file is a clean exit, not a stack", async (t) => {
  const cwd = await tempDir(t);
  const r = await runCli(t, [
    "run",
    "--file",
    "/nope/none.run.json",
    "--cwd",
    cwd,
  ]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot read run file/);
  assert.doesNotMatch(r.stderr, /Node\.js v\d/);
});

test("run --detach against a stale daemon record is one line, not a stack", async (t) => {
  // A daemon killed with kill -9 leaves daemon.json behind naming a dead
  // port. `attach` and `merge` already caught that fetch; `--detach` used to
  // print the raw TypeError.
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: 999999, port: 1, token: "x" }),
  );
  const file = await runFile(t, mockRun([{ id: "a", prompt: "hi" }]));

  const r = await spawnCli(
    t,
    ["run", "--file", file, "--detach", "--cwd", runtime],
    "cli.ts",
    { XDG_RUNTIME_DIR: runtime },
  ).done;

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^error: /m);
  assert.doesNotMatch(r.stderr, /TypeError|triggerUncaughtException/);
});

test("one asking task with no TTY runs as safe, and says so", async (t) => {
  // A test runner has no TTY, which is also every CI and piped invocation.
  // The interactive half — one asker *with* a TTY keeps `ask` — cannot be
  // driven from here for the same reason `--mode ask` never could.
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun([{ id: "one", prompt: "try a write", mode: "ask" }], {
      mode: undefined,
    }),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.match(r.stderr, /\[one\] not a TTY — ask runs as safe/);
  // Nothing at all: since #129 even our own state — M1b-7's stderr log
  // is written for every task of a run, refused write or not.
  assert.deepEqual(await readdir(cwd), [], "safe refused the write");
});

test("two asking tasks are refused a prompt they would have to share", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun(
      [
        { id: "one", prompt: "try a write", mode: "ask" },
        { id: "two", prompt: "try a write", mode: "ask" },
      ],
      { mode: undefined },
    ),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  // The count is the point: one readline cannot attribute an answer between
  // two askers, so the limit is on askers, not on tasks. The notice must also
  // name the way past the limit (M2-9 amendment): --detach plus attach.
  assert.match(r.stderr, /2 tasks ask, and one prompt cannot serve two/);
  assert.match(r.stderr, /use --detach and answer them with kapelle attach/);
  assert.deepEqual(await readdir(cwd), [], "both ran as safe");
});

test("--file --quiet drops the advisory line, exactly as one prompt does", async (t) => {
  // This test used to assert the opposite, and the opposite was a regression:
  // `--file` forwarded every `warningsFor` result with its `kind` discarded,
  // so `--quiet` printed the advisory `unverified` line that the single-agent
  // path drops (#13, `printableWarnings`). A `--cmd` spec is unmeasured, so
  // the advisory line is the only one reachable offline — the containment
  // variant needs a measured registry entry, as the unverified-harness test
  // above notes.
  const cwd = await tempDir(t);
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));

  const loud = await runCli(t, ["run", "--file", file, "--cwd", cwd]);
  assert.match(loud.stderr, /no measured labels for this harness/);

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd, "--quiet"]);
  assert.equal(r.stdout, "");
  assert.doesNotMatch(
    r.stderr,
    /no measured labels for this harness/,
    "unverified is advisory, so --quiet drops it",
  );
  // What is left is M1b-3's isolation notice, and it is the containment
  // variant of the same rule: the temp cwd is not a repository, so the tasks
  // share one directory. A line saying a safety property is *absent* is never
  // silenced (#13) — the same reason `safe` keeps its caveat under `--quiet`.
  assert.match(r.stderr, /not a git repository/);
});

test("a prompt alongside --file is refused, not silently dropped", async (t) => {
  // The dangerous shape of the same conflict `--agent`/`--cmd`/`--mode` are
  // rejected for: this one reads as if the extra work was queued.
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));
  const cwd = await tempDir(t);

  const r = await runCli(t, [
    "run",
    "--file",
    file,
    "--cwd",
    cwd,
    "and also do this",
  ]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /a prompt does not apply with --file/);
  assert.match(r.stderr, /and also do this/);

  // `--detach` is a boolean flag, so the same prompt must stay positional.
  // It used to be swallowed as if it were `--detach`'s value, and the run
  // was submitted with the prompt silently dropped.
  const detach = await runCli(t, [
    "run",
    "--file",
    file,
    "--cwd",
    cwd,
    "--detach",
    "and also do this",
  ]);
  assert.equal(detach.code, 1);
  assert.match(detach.stderr, /a prompt does not apply with --file/);
  assert.match(detach.stderr, /and also do this/);
});

test("a task whose harness cannot start fails alone, and fails the run", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(t, {
    mode: "auto",
    tasks: [
      { id: "good", prompt: "hi", cmd: `node ${MOCK_AGENT}` },
      { id: "doomed", prompt: "hi", cmd: "node --badflag" },
    ],
  });

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.equal(r.code, 1, "one failed task fails the run");
  assert.match(r.stdout, /▸ good \(mock-agent\) done/);
  // The label comes from `resolveAgent`'s `--cmd` parsing, which reads
  // "node <first arg>" — a quirk of that function, not of this run.
  assert.match(r.stdout, /▸ doomed \(.*\) failed/);
  assert.match(r.stdout, /error: agent "doomed" exited/);
  // The doomed harness died before it ever sent a prompt, so only the good
  // task counts as a turn.
  assert.match(r.stdout, /failed — 2 tasks, 1 turn/);
});

test("a harness that dies leaves its own error in a per-task log", async (t) => {
  // The story's whole point (M1b-7): the terminal already gets this under
  // `--verbose`, and the rejection message carries it while the process
  // lives. Neither survives a daemon, so the file is the durable record —
  // written with no flag asked for, and for the task that worked too.
  const cwd = await tempDir(t);
  const file = await runFile(t, {
    mode: "auto",
    tasks: [
      { id: "good", prompt: "hi", cmd: `node ${MOCK_AGENT}` },
      // A `cmd` is split on whitespace and never through a shell
      // (`protocol/registry.ts:212`), so the death has to come from the
      // runtime itself rather than from a quoted script.
      { id: "doomed", prompt: "hi", cmd: "node --badflag" },
    ],
  });

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd, "--quiet"]);

  // Printed as `run <id>` on stdout, which `--quiet` silences — so the id is
  // read off the directory, which is also how an operator finds it.
  const [runId] = await readdir(join(stateDirFor(cwd), "runs"));
  const logs = join(stateDirFor(cwd), "runs", String(runId));

  assert.match(
    await readFile(join(logs, "doomed.stderr.log"), "utf8"),
    /--badflag/,
    "the harness's own reason, not our exit code",
  );
  // The task that started fine is logged too, empty: "the harness said
  // nothing" and "the task never got here" have to look different on disk.
  assert.equal(await readFile(join(logs, "good.stderr.log"), "utf8"), "");
  assert.equal(r.code, 1);
});

test("a spawn failure is written to the per-task log, not just printed", async (t) => {
  // `node --badflag` above is a harness that starts and then dies. This is
  // the other fail-to-start shape: the binary never exists, so there is no
  // harness stderr to capture — our own spawn error has to be the durable
  // record.
  const cwd = await tempDir(t);
  const file = await runFile(t, {
    mode: "auto",
    tasks: [{ id: "ghost", prompt: "hi", cmd: "definitely-not-a-real-binary" }],
  });

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd, "--quiet"]);

  assert.equal(r.code, 1);
  const [runId] = await readdir(join(stateDirFor(cwd), "runs"));
  assert.match(
    await readFile(
      join(stateDirFor(cwd), "runs", String(runId), "ghost.stderr.log"),
      "utf8",
    ),
    /failed to spawn "definitely-not-a-real-binary"/,
  );
});

test("a missing --cwd is not created by the stderr log directory", async (t) => {
  // M1b-7's log directory is `mkdir -p`-shaped, which must not turn a typo'd
  // workspace root into an empty real one. Before the log landed, each task
  // simply failed at spawn with ENOENT — and so it must still.
  const cwd = await tempDir(t);
  const missing = join(cwd, "typo");
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));

  const r = await runCli(t, [
    "run",
    "--file",
    file,
    "--cwd",
    missing,
    "--quiet",
  ]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /failed to spawn/);
  // The other half of the same rule: a log we cannot write is a notice, never
  // a refusal to run and never a status.
  assert.match(
    r.stderr,
    /cannot write harness stderr logs to .*does not exist/,
  );
  await assert.rejects(readdir(missing), /ENOENT/);
});

test("--cwd in a subdirectory logs at the repository root", async (t) => {
  // Worktrees run each task at the same subdirectory inside its checkout,
  // but the log is repository-level state. It has to follow the root
  // `openWorktrees` chose, not the subdirectory the task actually ran in.
  const root = await tempDir(t);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "user.name", "Test");
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "keep.txt"), "x\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "first");

  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));
  const r = await runCli(t, [
    "run",
    "--file",
    file,
    "--cwd",
    join(root, "sub"),
    "--quiet",
  ]);

  assert.equal(r.code, 0);
  const [runId] = await readdir(join(stateDirFor(root), "runs"));
  assert.equal(
    await readFile(
      join(stateDirFor(root), "runs", String(runId), "one.stderr.log"),
      "utf8",
    ),
    "",
  );
});

test("--quiet still reports a task failure, on stderr", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(t, {
    mode: "auto",
    tasks: [{ id: "doomed", prompt: "hi", cmd: "node --badflag" }],
  });

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd, "--quiet"]);

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /error: \[doomed\] agent "doomed" exited/);
});

test("--quiet reports a task that failed without ever throwing", async (t) => {
  // The gap the first `--quiet` fix left. `refusal` returns normally and
  // carries no error text, so keying the quiet report on `task.error` sent
  // this case out with exit 1 and an empty stderr — the exact failure the
  // fix was written to remove.
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun([
      {
        id: "picky",
        prompt: "hi",
        cmd: `node ${MOCK_AGENT} --scenario refuse`,
      },
    ]),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd, "--quiet"]);

  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /error: \[picky\] failed/);
});

test("a refusal is a failed task, and it is not a silent one", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun([
      {
        id: "picky",
        prompt: "hi",
        cmd: `node ${MOCK_AGENT} --scenario refuse`,
      },
    ]),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.equal(r.code, 1);
  assert.match(r.stdout, /▸ picky \(mock-agent\) failed/);
  // One task, one prompt — and the summary now says so in English.
  assert.match(r.stdout, /failed — 1 task, 1 turn,/);
});

test("a first run in a fresh repository needs no .gitignore (#129)", async (t) => {
  // This used to be the preflight refusal: `.kapelle/` neither ignored nor
  // tracked was two error lines and a commit before anything ran. Nothing is
  // written into the repository any more, so there is nothing to ignore.
  const cwd = await gitRepo(t);
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /gitignore/);
  // The repository is exactly as it was found: one committed file, no state.
  assert.deepEqual(await readdir(cwd), [".git", "README.md"]);
  assert.equal(await git(cwd, "status", "--porcelain", "-uall"), "");
});

// --- M1b-5: the non-compliant fixtures -------------------------------------

test("each cross-check fixture trips its own warning, and only its own", async (t) => {
  // The four kinds in `core/result.ts`, driven over the real wire rather
  // than through an injected executor (`core/tests/run.test.ts` owns that
  // half). Each task gets its own worktree, which is the only condition under
  // which the tree-shaped checks read anything at all. `read-only` is mixed
  // in as the no-warning control; the loop below asserts exactly one `!` line
  // for each of the other six fixtures.
  const cwd = await gitRepo(t);
  const scenario = (id: string) => ({
    id,
    prompt: "hi",
    cmd: `node ${MOCK_AGENT} --scenario ${id}`,
  });
  const file = await runFile(
    t,
    mockRun(
      [
        scenario("no-result"),
        scenario("malformed-result"),
        scenario("read-only"),
        scenario("files-not-in-diff"),
        scenario("files-unclaimed"),
        scenario("eof-write"),
        scenario("unasked-write"),
      ],
      { maxConcurrency: 7 },
    ),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  // A disagreement is something to read, never a failure: `warned` exits 0.
  assert.equal(r.code, 0);
  const card = (id: string) =>
    r.stdout.split(`▸ ${id} (mock-agent) warned`)[1]?.split("\n▸ ")[0] ?? "";
  for (const id of [
    "no-result",
    "malformed-result",
    "files-not-in-diff",
    "files-unclaimed",
    "eof-write",
    "unasked-write",
  ]) {
    assert.ok(
      r.stdout.includes(`▸ ${id} (mock-agent) warned`),
      `${id} did not finish as warned`,
    );
    assert.equal(
      (card(id).match(/^ {2}! /gm) ?? []).length,
      1,
      `${id} warned about more than the one thing it is a fixture for`,
    );
  }
  // A missing block and a malformed one are the same verdict: nothing was
  // reported, so the summary below the card is ours.
  assert.match(card("no-result"), /no <task-result> block; the summary/);
  assert.match(card("malformed-result"), /no <task-result> block; the summary/);
  // Success, no <files>, no change: the claim and the tree agree (#119).
  assert.ok(
    r.stdout.includes("▸ read-only (mock-agent) done"),
    "a read-only success was not done",
  );
  assert.match(card("files-not-in-diff"), /<files> names ghost\.md/);
  assert.match(card("files-unclaimed"), /also shows unclaimed\.txt/);
  // #110: the tree read follows the harness exit, so a write made on end of
  // file is reported like any other unclaimed path.
  assert.match(card("eof-write"), /also shows late\.txt/);
  assert.match(card("unasked-write"), /without ever asking permission/);
});

test("unasked-write trips only policyNeverFired from a repository subdirectory", async (t) => {
  // The fixture must remain a one-warning story when the task runs inside a
  // subdirectory of the repo too. In that shape git reports changed paths
  // relative to the repository root (e.g. `sub/sneaky.txt`), so advertising a
  // cwd-relative `<files>sneaky.txt</files>` would also trip filesNotInDiff.
  const root = await gitRepo(t);
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "keep.txt"), "x\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "add sub");

  const file = await runFile(
    t,
    mockRun([
      {
        id: "unasked-write",
        prompt: "hi",
        cmd: `node ${MOCK_AGENT} --scenario unasked-write`,
      },
    ]),
  );
  const r = await runCli(t, [
    "run",
    "--file",
    file,
    "--cwd",
    join(root, "sub"),
  ]);

  assert.equal(r.code, 0);
  assert.match(r.stdout, /▸ unasked-write \(mock-agent\) warned/);
  const card = r.stdout.split("▸ unasked-write (mock-agent) warned")[1] ?? "";
  assert.equal(
    (card.match(/^ {2}! /gm) ?? []).length,
    1,
    "expected only the policyNeverFired cross-check",
  );
  assert.match(card, /without ever asking permission/);
  assert.doesNotMatch(card, /<files> names/);
});

test("the prompt response's usage is captured, not just usage_update", async (t) => {
  // M0-5's pin: `usage` on the `session/prompt` reply is the only per-task
  // token count all three harnesses send, and the mock never sent it.
  const cwd = await tempDir(t);
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.match(r.stdout, /tokens: 1234 total \(1200 in, 34 out; unknown\)/);
});

test("an unknown --scenario is a loud exit in both fixtures", async (t) => {
  // The fixture selector's own guard: a typo that quietly ran the compliant
  // path would make one of the tests above pass for the wrong reason. Names
  // inherited from Object.prototype are also unknown: a plain-object map with
  // `in` used to treat `constructor` and `toString` as real fixtures.
  //
  // Both fake agents, not just the mock. #90 fixed this in `mock-agent.mjs`
  // and the sibling copy in `hostile-agent.mjs` survived it (M1c-6): a
  // `--scenario constructor` there exited 0 and ran no attack at all, which
  // is a containment test passing without containing anything.
  for (const [script, known] of [
    ["mock-agent.mjs", "refuse"],
    ["hostile-agent.mjs", "path-escape"],
  ] as const) {
    for (const name of [
      "no-such-thing",
      "constructor",
      "toString",
      "__proto__",
    ]) {
      const where = `${script} --scenario ${name}`;
      const r = await runCli(t, ["--scenario", name], script);

      assert.equal(r.code, 2, where);
      assert.match(r.stderr, new RegExp(`Known: ${known}`), where);
    }
  }
});

// --- M1b end-to-end: full CLI flows that span run files, git, and hostile ---

test("a --file run in git leaves task branches and per-task stderr logs", async (t) => {
  const cwd = await gitRepo(t);
  const file = await runFile(
    t,
    mockRun(
      [
        { id: "one", prompt: "one" },
        { id: "two", prompt: "two" },
      ],
      { maxConcurrency: 2 },
    ),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);
  assert.equal(r.code, 0, r.stderr);

  const runId = r.stdout.match(/run ([a-z0-9_-]+)/)?.[1];
  assert.ok(runId, "run id should be printed");

  const wt = await git(cwd, "worktree", "list");
  assert.doesNotMatch(wt, /\/wt\//, "worktrees should be cleaned");

  const branches = await git(cwd, "branch", "--list", "kapelle/*");
  assert.match(branches, /kapelle\/.*\/one/);
  assert.match(branches, /kapelle\/.*\/two/);

  const logs = join(stateDirFor(cwd), "runs", String(runId));
  assert.equal(await readFile(join(logs, "one.stderr.log"), "utf8"), "");
  assert.equal(await readFile(join(logs, "two.stderr.log"), "utf8"), "");
  await assert.rejects(access(join(cwd, "ACP_TEST.md")), /ENOENT/);
});

test("a failed --file task that changed files keeps its worktree", async (t) => {
  const cwd = await gitRepo(t);
  const meta = await tempDir(t);
  const agent = join(meta, "fail-agent.mjs");
  await writeFile(
    agent,
    `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "fail-agent", version: "1" }, authMethods: [] } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
  if (msg.method === "session/prompt") {
    writeFileSync("partial.txt", "work in progress\\n");
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "refusal" } });
  }
});
`,
  );
  const file = await runFile(
    t,
    mockRun([
      { id: "fail", prompt: "make work then fail", cmd: `node ${agent}` },
    ]),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);
  assert.equal(r.code, 1, r.stderr);

  const runId = r.stdout.match(/run ([a-z0-9_-]+)/)?.[1];
  assert.ok(runId);

  const wt = await git(cwd, "worktree", "list");
  const retained = wt
    .split("\n")
    .find((line) => line.includes("/wt/") && line.includes(String(runId)));
  assert.ok(retained, wt);
  const path = retained?.split(/\s+/)[0];
  assert.ok(path, retained);
  assert.match(
    await readFile(join(path, "partial.txt"), "utf8"),
    /work in progress/,
  );
});

test("hostile path escapes are refused and the turn continues via the CLI", async (t) => {
  const cwd = await tempDir(t);
  for (const scenario of ["path-escape", "absolute-path", "symlink-escape"]) {
    const r = await runCli(t, [
      "do your worst",
      "--cmd",
      `node ${HOSTILE_AGENT} --scenario ${scenario}`,
      "--mode",
      "auto",
      "--cwd",
      cwd,
    ]);

    assert.equal(r.code, 0, `${scenario}: ${r.stderr}`);
    assert.match(r.stdout, /OUTCOME=refused/, scenario);
    assert.match(r.stdout, /end_turn/, scenario);
  }
});

test("hostile write-no-ask is refused under safe and allowed under auto", async (t) => {
  const cwd = await tempDir(t);
  const args = (mode: string) => [
    "do your worst",
    "--cmd",
    `node ${HOSTILE_AGENT} --scenario write-no-ask`,
    "--mode",
    mode,
    "--cwd",
    cwd,
  ];

  const safe = await runCli(t, args("safe"));
  assert.equal(safe.code, 0, safe.stderr);
  assert.match(safe.stdout + safe.stderr, /write refused by policy/);
  await assert.rejects(access(join(cwd, "SNEAKY.md")), /ENOENT/);

  const auto = await runCli(t, args("auto"));
  assert.equal(auto.code, 0, auto.stderr);
  assert.equal(
    await readFile(join(cwd, "SNEAKY.md"), "utf8"),
    "written without asking\n",
  );
});

test("hostile malformed JSON and unknown methods do not kill the turn", async (t) => {
  const cwd = await tempDir(t);
  for (const scenario of ["malformed-json", "unknown-method"]) {
    const r = await runCli(t, [
      "do your worst",
      "--cmd",
      `node ${HOSTILE_AGENT} --scenario ${scenario}`,
      "--mode",
      "auto",
      "--cwd",
      cwd,
    ]);

    assert.equal(r.code, 0, `${scenario}: ${r.stderr}`);
    assert.match(r.stdout, /end_turn/, scenario);
  }
});

test("three slow run-file tasks honor maxConcurrency 2", async (t) => {
  const cwd = await tempDir(t);
  const meta = await tempDir(t);
  const agent = join(meta, "slow-agent.mjs");
  await writeFile(
    agent,
    `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "slow", version: "1" }, authMethods: [] } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s" + msg.id } });
  if (msg.method === "session/prompt") {
    appendFileSync("activity.log", "start " + Date.now() + "\\n");
    await sleep(600);
    appendFileSync("activity.log", "end " + Date.now() + "\\n");
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "<task-result>\\n<status>success</status>\\n<summary>slow done</summary>\\n<details>none</details>\\n</task-result>" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`,
  );
  const file = await runFile(
    t,
    mockRun(
      [1, 2, 3].map((n) => ({
        id: `slow${n}`,
        prompt: `slow ${n}`,
        cmd: `node ${agent}`,
      })),
      { maxConcurrency: 2 },
    ),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);
  assert.equal(r.code, 0, r.stderr);

  const activity = await readFile(join(cwd, "activity.log"), "utf8");
  const starts = activity.match(/^start/gm) ?? [];
  assert.equal(starts.length, 3, activity);

  let active = 0;
  let maxActive = 0;
  for (const line of activity.trim().split("\n")) {
    if (line.startsWith("start")) active += 1;
    if (line.startsWith("end")) active -= 1;
    if (active > maxActive) maxActive = active;
  }
  assert.equal(maxActive, 2, activity);
});

test("a TTL force-kills a harness that ignores session/cancel", async (t) => {
  const cwd = await tempDir(t);
  const meta = await tempDir(t);
  const agent = join(meta, "stubborn-agent.mjs");
  await writeFile(
    agent,
    `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "stubborn", version: "1" }, authMethods: [] } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
  if (msg.method === "session/prompt") return; // never answers and ignores session/cancel
});
`,
  );
  const file = await runFile(
    t,
    mockRun([{ id: "stubborn", prompt: "never ends", cmd: `node ${agent}` }], {
      stallIdleMs: 0,
      stallRepeatCount: 0,
      ttlMs: 50,
    }),
  );

  const { child, done } = spawnCli(t, ["run", "--file", file, "--cwd", cwd]);
  const r = await Promise.race([
    done,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("TTL force-kill did not fire; run hung"));
      }, 10_000);
      child.once("close", () => clearTimeout(timer));
    }),
  ]);

  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /▸ stubborn \(stubborn-agent\) timed_out/);
});

/** The sole run's persisted events, for tests that assert what the log kept. */
async function soleEventLog(cwd: string) {
  const [runId] = await readdir(join(stateDirFor(cwd), "runs"));
  return (
    await readFile(
      join(stateDirFor(cwd), "runs", String(runId), "events.jsonl"),
      "utf8",
    )
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("a warned task and a failed task roll up to a failed run", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun([
      {
        id: "warned",
        prompt: "warn",
        cmd: `node ${MOCK_AGENT} --scenario no-result`,
      },
      {
        id: "failed",
        prompt: "fail",
        cmd: `node ${MOCK_AGENT} --scenario refuse`,
      },
    ]),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /▸ warned \(mock-agent\) warned/);
  assert.match(r.stdout, /▸ failed \(mock-agent\) failed/);
  assert.match(r.stdout, /\nfailed — 2 tasks, 2 turns,/);

  const finished = (await soleEventLog(cwd)).filter(
    (e) => e.update.sessionUpdate === "_client_task_finished",
  );
  assert.deepEqual(
    finished.map((e) => `${e.agent}:${e.update.status}`).sort(),
    ["failed:failed", "warned:warned"],
    "the log keeps each task's real verdict",
  );
});

// --- the watchdog's two signals, end to end (M1c-2, #26) ---------------------
//
// `core/tests/watchdog.test.ts` owns the arithmetic; these two drive the whole
// path — mock fixture, sweep, bus, printed line, task status, branch — which is
// the only place the rungs are visible as behaviour rather than as a number.
//
// Both are seconds-scale on purpose: `sweepIntervalMs` never ticks faster than
// once a second, so limits below that do not make the test quicker.

test("a stalled task warns, times out at the TTL, and keeps its branch", async (t) => {
  const cwd = await gitRepo(t);
  const file = await runFile(
    t,
    mockRun(
      [
        {
          id: "stall",
          prompt: "go quiet",
          cmd: `node ${MOCK_AGENT} --scenario stall`,
        },
      ],
      // The idle rung warns at the first sweep (1 s), the TTL cuts at the
      // second. Repeat is off: this fixture emits no tool calls at all.
      { stallIdleMs: 200, stallRepeatCount: 0, ttlMs: 1500 },
    ),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.equal(r.code, 1, r.stdout);
  // The bell in front is M1c-4: the same line, once, with the attention
  // signal attached — and `once` is what a second subscriber would break.
  assert.ok(
    r.stderr.includes("\x07! [stall] no activity for "),
    "the bell is in front of the stall line",
  );
  assert.equal(
    r.stderr.match(/no activity for/g)?.length,
    1,
    "one owner of the stall line, not two",
  );
  assert.match(r.stdout, /▸ stall \(mock-agent\) timed_out/);

  // The point of the fixture writing before it went quiet: a timed-out task
  // keeps its work for reading, so both the branch and the checkout survive.
  const branches = await git(cwd, "branch", "--list", "kapelle/*");
  assert.match(branches, /kapelle\/.*\/stall/);
  const wt = await git(cwd, "worktree", "list");
  assert.match(wt, /\/wt\//);

  const timedOut = (await soleEventLog(cwd)).find(
    (e) =>
      e.agent === "stall" && e.update.sessionUpdate === "_client_task_finished",
  );
  assert.equal(timedOut?.update.status, "timed_out");
});

test("a repeated tool title warns, and the task is never cancelled", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun(
      [
        {
          id: "loop",
          prompt: "loop",
          cmd: `node ${MOCK_AGENT} --scenario repeat`,
        },
      ],
      // `stallIdleMs` is set for the sweep, not to fire: the interval is a
      // quarter of the finest time limit, so this is what buys a 1 s tick
      // inside a ~1.8 s turn. The fixture emits every 150 ms, so 4 s of idle
      // never accumulates.
      { stallIdleMs: 4_000, stallRepeatCount: 5, ttlMs: 0 },
    ),
  );

  const r = await runCli(t, ["run", "--file", file, "--cwd", cwd]);

  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stderr,
    /! \[loop\] \d+× "Search for the same thing again" in a row/,
  );
  assert.match(r.stdout, /▸ loop \(mock-agent\) done/);
  assert.doesNotMatch(r.stdout, /timed_out|cancelled/);
});

// --- kapelle workspace (#129) ------------------------------------------------

test("workspace prints where a repository's state lives", async (t) => {
  // State left the repository, so "where is my stuff" became a question the
  // operator cannot answer by looking. This is the answer, and the thing the
  // stranded notice's repair command is built from.
  const cwd = await gitRepo(t);

  const r = await runCli(t, ["workspace", "--cwd", cwd]);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), stateDirFor(cwd));
});

test("workspace move carries a renamed repository's state, repaired", async (t) => {
  // The whole point: `mv` alone leaves every checkout `prunable`, and the
  // next `git worktree prune` deletes the work. One verb cannot be half-run.
  const from = await gitRepo(t);
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));
  assert.equal(
    (await runCli(t, ["run", "--file", file, "--cwd", from, "--quiet"])).code,
    0,
  );
  const to = join(await tempDir(t), "renamed");
  await execFile("mv", [from, to]);

  const r = await runCli(t, ["workspace", "move", from, to]);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), stateDirFor(to));
  assert.equal(existsSync(stateDirFor(from)), false);
  assert.doesNotMatch(await git(to, "worktree", "list"), /prunable/);
});

test("workspace move needs both paths, and says which is missing", async (t) => {
  const r = await runCli(t, ["workspace", "move", await gitRepo(t)]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /workspace move needs two paths/);
  assert.doesNotMatch(r.stderr, /node:internal/);
});

test("workspace move reports a refusal as one line, not a stack", async (t) => {
  const r = await runCli(t, [
    "workspace",
    "move",
    await gitRepo(t),
    await tempDir(t),
  ]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);
  assert.doesNotMatch(r.stderr, /\bat .*worktree\.ts/);
});
