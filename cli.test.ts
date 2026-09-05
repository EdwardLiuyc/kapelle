/**
 * The CLI surface — `run.ts` and `fanout.mjs` — driven as real subprocesses.
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
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MOCK_AGENT, runCli, tempDir } from "./integration/helpers.ts";

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

  const help = await runCli(t, ["hi", "--help"]);
  assert.equal(help.code, 0);
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

// --- fanout ------------------------------------------------------------------

/** Writes a task file and returns its path. Every task gets its own workspace. */
async function taskFile(t: import("node:test").TestContext, tasks: object[]) {
  const dir = await tempDir(t);
  const path = join(dir, "tasks.json");
  await writeFile(path, JSON.stringify(tasks), "utf8");
  return path;
}

test("fanout runs every task and reports each one", async (t) => {
  const a = await tempDir(t);
  const b = await tempDir(t);
  const file = await taskFile(t, [
    { cmd: `node ${MOCK_AGENT}`, prompt: "task one", mode: "auto", cwd: a },
    { cmd: `node ${MOCK_AGENT}`, prompt: "task two", mode: "auto", cwd: b },
  ]);

  const r = await runCli(t, [file], "fanout.mjs");

  assert.equal(r.code, 0);
  assert.equal((r.stdout.match(/end_turn/g) ?? []).length, 2);
  assert.deepEqual(await readdir(a), ["ACP_TEST.md"]);
  assert.deepEqual(await readdir(b), ["ACP_TEST.md"]);
});

test("every fanout task carries its own advisory notice, on stderr", async (t) => {
  // fanout is the second entry point that can start a harness under `safe`,
  // and its notices are never silenced — so they cannot be a run.ts-only
  // feature. A `--cmd` spec is unmeasured, so the reachable offline notice is
  // the advisory "no measured labels" line; the containment variant needs a
  // measured registry entry and is not reachable from this suite.
  const file = await taskFile(t, [
    {
      cmd: `node ${MOCK_AGENT}`,
      prompt: "one",
      mode: "auto",
      cwd: await tempDir(t),
    },
    {
      cmd: `node ${MOCK_AGENT}`,
      prompt: "two",
      mode: "auto",
      cwd: await tempDir(t),
    },
  ]);

  const r = await runCli(t, [file], "fanout.mjs");

  assert.equal((r.stderr.match(/no measured labels/g) ?? []).length, 2);
  assert.doesNotMatch(r.stdout, /no measured labels/);
});

test("a fanout task asking for ask runs as safe, since no task has a TTY", async (t) => {
  const cwd = await tempDir(t);
  const file = await taskFile(t, [
    { cmd: `node ${MOCK_AGENT}`, prompt: "try a write", mode: "ask", cwd },
  ]);

  const r = await runCli(t, [file], "fanout.mjs");

  assert.match(r.stderr, /! no TTY — ask runs as safe/);
  assert.doesNotMatch(r.stdout, /no TTY/);
  assert.deepEqual(await readdir(cwd), []);
});

test("one failing task does not take the others down", async (t) => {
  const cwd = await tempDir(t);
  const file = await taskFile(t, [
    { cmd: `node ${MOCK_AGENT}`, prompt: "good", mode: "auto", cwd },
    {
      cmd: "node --badflag",
      prompt: "doomed",
      mode: "auto",
      cwd: await tempDir(t),
    },
  ]);

  const r = await runCli(t, [file], "fanout.mjs");

  assert.match(r.stdout, /end_turn/);
  assert.match(r.stdout, /FAILED/);
  assert.deepEqual(
    await readdir(cwd),
    ["ACP_TEST.md"],
    "the good task still ran",
  );
});

test("a missing task file is a clean exit, not a stack", async (t) => {
  const r = await runCli(t, ["/nope/does-not-exist.json"], "fanout.mjs");

  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot read/);
});

// --- run files: `run.ts --file` (M1b-2, #18) ---------------------------------

/** A run file, written where `run.ts` can read it. Separate from `taskFile`
 *  above: fanout's schema is a bare array, a run file is an object. */
async function runFile(t: import("node:test").TestContext, run: object) {
  const dir = await tempDir(t);
  const path = join(dir, "demo.run.json");
  await writeFile(path, JSON.stringify(run), "utf8");
  return path;
}

const mockRun = (tasks: object[], rest: object = {}) => ({
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

  const r = await runCli(t, ["--file", file, "--cwd", cwd]);

  assert.equal(r.code, 0);
  for (const id of ["one", "two", "three"]) {
    assert.match(r.stdout, new RegExp(`▸ ${id} \\(mock-agent\\) done`));
  }
  assert.match(r.stdout, /done — 3 tasks, 3 turns/);
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

  const r = await runCli(t, ["--file", file, "--cwd", cwd]);

  // Each task's block is contiguous: its whole transcript sits between its
  // own header and the next one. Interleaving would split it.
  const [, first = ""] = r.stdout.split("▸ one (mock-agent)");
  const [block = ""] = first.split("▸ two (mock-agent)");
  assert.match(block, /Wrote ACP_TEST\.md\./);
  assert.equal((block.match(/Wrote ACP_TEST\.md\./g) ?? []).length, 1);
});

test("a run file's own agent and mode cannot be overridden from argv", async (t) => {
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));

  for (const flag of [
    ["--mode", "safe"],
    ["--agent", "opencode"],
    ["--cmd", "true"],
  ]) {
    const r = await runCli(t, ["--file", file, ...flag]);
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

  const r = await runCli(t, ["--file", file]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /task dependencies land in M3/);
  assert.doesNotMatch(r.stderr, /Node\.js v\d/);
});

test("a missing run file is a clean exit, not a stack", async (t) => {
  const r = await runCli(t, ["--file", "/nope/none.run.json"]);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot read run file/);
  assert.doesNotMatch(r.stderr, /Node\.js v\d/);
});

test("ask in a run file runs as safe, and says so", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(
    t,
    mockRun([{ id: "one", prompt: "try a write", mode: "ask" }], {
      mode: undefined,
    }),
  );

  const r = await runCli(t, ["--file", file, "--cwd", cwd]);

  assert.match(r.stderr, /\[one\] ask cannot prompt inside a run file/);
  assert.deepEqual(await readdir(cwd), [], "safe refused the write");
});

test("--quiet drops the run summary but never the containment notice", async (t) => {
  const cwd = await tempDir(t);
  const file = await runFile(t, mockRun([{ id: "one", prompt: "hi" }]));

  const r = await runCli(t, ["--file", file, "--cwd", cwd, "--quiet"]);

  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no measured labels for this harness/);
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

  const r = await runCli(t, ["--file", file, "--cwd", cwd]);

  assert.equal(r.code, 1, "one failed task fails the run");
  assert.match(r.stdout, /▸ good \(mock-agent\) done/);
  // The label comes from `resolveAgent`'s `--cmd` parsing, which reads
  // "node <first arg>" — a quirk of that function, not of this run.
  assert.match(r.stdout, /▸ doomed \(.*\) failed/);
  assert.match(r.stdout, /error: agent "doomed" exited/);
  assert.match(r.stdout, /failed — 2 tasks/);
});
