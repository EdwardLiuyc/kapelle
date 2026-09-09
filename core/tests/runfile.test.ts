import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AgentEntry } from "../../protocol/registry.ts";
import {
  RUN_KEYS,
  type Run,
  type RunInput,
  TASK_KEYS,
  type Task,
  type TaskInput,
  validateRun,
} from "../runfile.ts";

/** Two entries, because the ceiling is untestable against the real registry:
 *  every shipped agent is `maxMode: "auto"` (`protocol/registry.ts`). Injected
 *  rather than poked into `AGENTS`, which every other suite shares. */
const AGENTS: Record<string, AgentEntry> = {
  demo: { launch: { command: "demo", args: [] }, maxMode: "auto" },
  capped: {
    launch: { command: "capped", args: [] },
    defaultMode: "safe",
    maxMode: "ask",
  },
};

const run = (input: unknown) => validateRun(input, AGENTS);
const throwsWith = (input: unknown, re: RegExp) =>
  assert.throws(() => run(input), re);

const lint: TaskInput = { id: "lint", prompt: "fix warnings" };
const minimal: RunInput = { agent: "demo", tasks: [lint] };

test("fills the defaults and returns the resolved shape", () => {
  // Typed as `Task`, so a defaulted field that goes back to optional fails
  // to compile rather than quietly reappearing as `?? "ask"` downstream.
  const resolved: Task = {
    id: "lint",
    prompt: "fix warnings",
    agent: "demo",
    mode: "ask",
    allowReadOutsideRoot: false,
    stallIdleMs: 300_000,
    stallRepeatCount: 8,
    ttlMs: 3_600_000,
  };
  const expected: Run = { maxConcurrency: 4, tasks: [resolved] };
  assert.deepEqual(run(minimal), expected);
});

test("a JSON file and the same run as a POST body validate to one object", () => {
  const text = JSON.stringify(minimal);
  assert.deepEqual(run(JSON.parse(text)), run(structuredClone(minimal)));
});

test("invalid run-level defaults are refused even when every task overrides them", () => {
  throwsWith(
    {
      agent: "demo",
      mode: "bogus",
      tasks: [{ id: "a", prompt: "p", mode: "safe" }],
    },
    /run file: unknown mode "bogus"/,
  );
  throwsWith(
    {
      agent: "demo",
      worktree: "inherit",
      tasks: [{ id: "a", prompt: "p", worktree: "HEAD" }],
    },
    /run file: worktree inheritance lands in M3/,
  );
  throwsWith(
    { agent: "nope", tasks: [{ id: "a", prompt: "p", agent: "demo" }] },
    /run file: unknown agent "nope"/,
  );
  throwsWith(
    {
      cmd: " ",
      agent: "demo",
      tasks: [{ id: "a", prompt: "p", cmd: "node mock-agent.mjs" }],
    },
    /run file: "cmd" must be a non-empty string/,
  );
});

test("valid run-level defaults still pass the eager checks and inherit", () => {
  const out = run({
    agent: "demo",
    mode: "safe",
    worktree: "HEAD",
    tasks: [{ id: "a", prompt: "p" }],
  });
  assert.equal(out.tasks[0]?.agent, "demo");
  assert.equal(out.tasks[0]?.mode, "safe");
  assert.equal(out.tasks[0]?.worktree, "HEAD");
});

test("run-level defaults reach a task, and a task value wins", () => {
  const out = run({
    agent: "demo",
    mode: "safe",
    worktree: "origin/master",
    tasks: [
      { id: "a", prompt: "p" },
      { id: "b", prompt: "p", mode: "auto", worktree: "HEAD" },
    ],
  });
  assert.equal(out.tasks[0]?.mode, "safe");
  assert.equal(out.tasks[0]?.worktree, "origin/master");
  assert.equal(out.tasks[1]?.mode, "auto");
  assert.equal(out.tasks[1]?.worktree, "HEAD");
});

test("safe forces allowReadOutsideRoot false, however it was asked for", () => {
  const out = run({
    agent: "demo",
    mode: "safe",
    allowReadOutsideRoot: true,
    tasks: [{ id: "a", prompt: "p" }],
  });
  assert.equal(out.tasks[0]?.allowReadOutsideRoot, false);
});

test("a mode above the agent's ceiling names both values", () => {
  throwsWith(
    { agent: "capped", mode: "auto", tasks: [{ id: "a", prompt: "p" }] },
    /task "a".*"auto" exceeds the ceiling for "capped": maxMode is "ask"/s,
  );
});

test("a non-empty needs is refused, and names M3", () => {
  throwsWith(
    { agent: "demo", tasks: [{ id: "a", prompt: "p", needs: ["plan"] }] },
    /task dependencies land in M3/,
  );
  // The field itself stays legal, so M3-1 lifts a rejection, not a schema.
  assert.equal(
    run({ agent: "demo", tasks: [{ id: "a", prompt: "p", needs: [] }] }).tasks
      .length,
    1,
  );
});

test("an inheritance-implying worktree is refused, a base ref is kept", () => {
  throwsWith(
    { agent: "demo", tasks: [{ id: "a", prompt: "p", worktree: "inherit" }] },
    /worktree inheritance lands in M3/,
  );
  throwsWith(
    { agent: "demo", tasks: [{ id: "a", prompt: "p", worktree: { of: "b" } }] },
    /"worktree" must be a non-empty string/,
  );
});

test("an unknown key is refused rather than ignored, at both levels", () => {
  throwsWith({ ...minimal, maxConcurency: 2 }, /unknown key "maxConcurency"/);
  throwsWith(
    { agent: "demo", tasks: [{ id: "a", prompt: "p", cwd: "/tmp" }] },
    /unknown key "cwd"/,
  );
});

test("duplicate task ids are refused", () => {
  throwsWith(
    {
      agent: "demo",
      tasks: [
        { id: "a", prompt: "p" },
        { id: "a", prompt: "q" },
      ],
    },
    /duplicate task id "a"/,
  );
});

test("an illegal task id throws rather than being sanitised", () => {
  throwsWith(
    { agent: "demo", tasks: [{ id: "build.lock", prompt: "p" }] },
    /invalid task id "build\.lock"/,
  );
});

test("an agent is required, and must be one the registry knows", () => {
  throwsWith({ tasks: [{ id: "a", prompt: "p" }] }, /no "agent"/);
  throwsWith(
    { agent: "nope", tasks: [{ id: "a", prompt: "p" }] },
    /unknown agent "nope"/,
  );
});

test("a cmd task needs no agent, and takes the command's label", () => {
  const out = run({
    cmd: "node mock-agent.mjs",
    tasks: [{ id: "a", prompt: "p" }],
  });
  assert.equal(out.tasks[0]?.agent, "mock-agent");
  assert.equal(out.tasks[0]?.cmd, "node mock-agent.mjs");
});

test("an unknown task agent is refused even when a cmd wins", () => {
  throwsWith(
    {
      agent: "demo",
      tasks: [
        { id: "a", prompt: "p", agent: "bogus", cmd: "node mock-agent.mjs" },
      ],
    },
    /task "a": unknown agent "bogus"/,
  );
  throwsWith(
    {
      cmd: "node mock-agent.mjs",
      tasks: [{ id: "a", prompt: "p", agent: "bogus" }],
    },
    /task "a": unknown agent "bogus"/,
  );
});

test("a known task agent still loses to cmd, as resolveAgent does", () => {
  const out = run({
    cmd: "node mock-agent.mjs",
    tasks: [
      { id: "a", prompt: "p", agent: "capped", cmd: "node mock-agent.mjs" },
    ],
  });
  assert.equal(out.tasks[0]?.agent, "mock-agent");
  assert.equal(out.tasks[0]?.cmd, "node mock-agent.mjs");
});

test("a padded cmd is stored trimmed, so the Task matches what is spawned", () => {
  const out = run({
    cmd: "  node mock-agent.mjs  ",
    tasks: [{ id: "a", prompt: "p" }],
  });
  assert.equal(out.tasks[0]?.cmd, "node mock-agent.mjs");
  assert.equal(out.tasks[0]?.agent, "mock-agent");
});

test("maxConcurrency must be a whole number of one or more", () => {
  for (const bad of [0, -1, 2.5, "4"]) {
    throwsWith({ ...minimal, maxConcurrency: bad }, /"maxConcurrency"/);
  }
  assert.equal(run({ ...minimal, maxConcurrency: 1 }).maxConcurrency, 1);
});

test("a note survives on the run and on a task", () => {
  const out = run({
    agent: "demo",
    note: "nightly lint",
    tasks: [{ id: "a", prompt: "p", note: "owns core/" }],
  });
  assert.equal(out.note, "nightly lint");
  assert.equal(out.tasks[0]?.note, "owns core/");
});

test("the run itself must be an object with tasks", () => {
  throwsWith([], /must be a JSON object/);
  throwsWith({ agent: "demo" }, /non-empty "tasks" array/);
  throwsWith({ agent: "demo", tasks: [] }, /non-empty "tasks" array/);
});

// --- the JSON Schema is an authoring aid, and must not drift (M1b-2, #18) ----

test("the run-file schema lists exactly the keys the validator knows", async () => {
  // The one real cost of shipping a schema is that it becomes a second copy
  // of the field list. This is the guard: the validator stays the single
  // source of truth, and the schema is asserted equal to it.
  const path = new URL("../../schema/run.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(path, "utf8"));

  assert.deepEqual(Object.keys(schema.properties).sort(), [...RUN_KEYS].sort());
  assert.deepEqual(
    Object.keys(schema.$defs.task.properties).sort(),
    [...TASK_KEYS].sort(),
  );
});

// --- watchdog limits (M1c-1, #25) ------------------------------------------

test("watchdog limits default when nobody sets them", () => {
  const [task] = run(minimal).tasks;
  assert.equal(task?.stallIdleMs, 300_000);
  assert.equal(task?.stallRepeatCount, 8);
  assert.equal(task?.ttlMs, 3_600_000);
});

test("a run-level watchdog limit reaches every task", () => {
  const resolved = run({
    agent: "demo",
    ttlMs: 60_000,
    tasks: [lint, { id: "docs", prompt: "write docs" }],
  });
  assert.deepEqual(
    resolved.tasks.map((t) => t.ttlMs),
    [60_000, 60_000],
  );
});

test("a task's watchdog limit wins over the run's", () => {
  const resolved = run({
    agent: "demo",
    stallIdleMs: 10_000,
    tasks: [lint, { id: "slow", prompt: "think", stallIdleMs: 900_000 }],
  });
  assert.deepEqual(
    resolved.tasks.map((t) => t.stallIdleMs),
    [10_000, 900_000],
  );
});

test("0 is a legal watchdog limit — it is how a signal is disabled", () => {
  const [task] = run({
    agent: "demo",
    tasks: [{ ...lint, stallIdleMs: 0, stallRepeatCount: 0, ttlMs: 0 }],
  }).tasks;
  assert.equal(task?.stallIdleMs, 0);
  assert.equal(task?.stallRepeatCount, 0);
  assert.equal(task?.ttlMs, 0);
});

test("a negative or fractional watchdog limit is rejected, naming the key", () => {
  throwsWith(
    { agent: "demo", tasks: [{ ...lint, ttlMs: -1 }] },
    /"ttlMs" must be a whole number 0 or greater/,
  );
  throwsWith(
    { agent: "demo", tasks: [{ ...lint, stallIdleMs: 1.5 }] },
    /"stallIdleMs" must be a whole number 0 or greater/,
  );
  throwsWith(
    { agent: "demo", tasks: [{ ...lint, stallRepeatCount: "8" }] },
    /"stallRepeatCount" must be a whole number 0 or greater/,
  );
});

test("a bad run-level watchdog limit is rejected even when no task uses it", () => {
  // Same rule the mode default follows: a task override must not be able to
  // hide an invalid run-level value.
  throwsWith(
    { agent: "demo", ttlMs: -5, tasks: [{ ...lint, ttlMs: 1_000 }] },
    /run file: "ttlMs" must be a whole number 0 or greater/,
  );
});
