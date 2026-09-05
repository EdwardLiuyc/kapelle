/**
 * Run files — story M1b-1, issue #17.
 *
 * A run file describes one job: N tasks, plus the defaults they share. It is
 * **data**, never a module. `.ts`/`.mjs` run files were dropped on 2026-09-05
 * (`docs/STORIES.md`, M1b-1 amendment): `await import()` executes the file
 * inside this process, where it reaches `READ_ONLY_KINDS` and the
 * `AGENT_TEAM_*` secret, and the loop it bought is available from a generator
 * script that emits JSON. So both entry paths — a `.json` file the CLI reads,
 * a POST body the daemon receives — arrive here as a plain object, and
 * nothing in this module imports anything at runtime.
 *
 * **The validator is where a run file stops being trusted input.** It settles
 * mode and `allowReadOutsideRoot` through `resolvePolicy`, so a mode above an
 * agent's ceiling is an error here rather than at spawn time, and it returns
 * the *resolved* shape: every defaulted field is filled, so no consumer
 * re-invents `?? "ask"` in a second place.
 *
 * The agent map is a defaulted parameter rather than a direct read of
 * `AGENTS`, because every shipped entry is `maxMode: "auto"` and the ceiling
 * rejection would otherwise be untestable. A test injects an entry; nothing
 * mutates the shared registry to arrange a case.
 */

import {
  AGENTS,
  type AgentEntry,
  type ClientMode,
  resolveAgent,
} from "../protocol/registry.ts";
import { assertTaskId } from "./ids.ts";
import { type HarnessLayer, resolvePolicy } from "./policy.ts";

/** Suggested by the ratified decision (`docs/STORIES.md`, M1b-1 Gap 2). M2-7
 *  config overrides it; nothing here reads config, which does not exist yet. */
const DEFAULT_MAX_CONCURRENCY = 4;

/** One task, resolved. No optional defaults: if a field has a default, it is
 *  filled in by the time anyone sees this. `cmd` and `worktree` are optional
 *  because *absent* is a meaning of its own — no custom command, and "branch
 *  off the current commit". */
export interface Task {
  id: string;
  prompt: string;
  agent: string;
  mode: ClientMode;
  allowReadOutsideRoot: boolean;
  cmd?: string;
  worktree?: string;
  note?: string;
}

/** One run, resolved. `runId` is absent on purpose: it is minted by
 *  `newRunId` when the run starts and may never be supplied by a run file,
 *  or a re-run would rebuild branch names that already exist. */
export interface Run {
  maxConcurrency: number;
  tasks: Task[];
  note?: string;
}

/** What a person writes. Follows `Task` automatically, so a field added
 *  above cannot be forgotten here. */
export type TaskInput = Partial<Task> & { id: string; prompt: string };

/** What a person writes, at the top of the file. The five run-level defaults
 *  are copied into any task that omits them; a task value always wins. */
export interface RunInput {
  tasks: TaskInput[];
  maxConcurrency?: number;
  note?: string;
  agent?: string;
  mode?: ClientMode;
  allowReadOutsideRoot?: boolean;
  cmd?: string;
  worktree?: string;
}

const RUN_KEYS = new Set([
  "tasks",
  "maxConcurrency",
  "note",
  "agent",
  "mode",
  "allowReadOutsideRoot",
  "cmd",
  "worktree",
]);

/** `needs` is listed so a dependency gets the M3 message rather than the
 *  unknown-key one. The schema stays stable; only the behaviour refuses. */
const TASK_KEYS = new Set([
  "id",
  "prompt",
  "agent",
  "mode",
  "allowReadOutsideRoot",
  "cmd",
  "worktree",
  "note",
  "needs",
]);

/**
 * Check a run file and return it resolved, or throw naming what is wrong.
 *
 * `input` is `unknown` because it arrives from `JSON.parse` or an HTTP body:
 * a TypeScript type would erase and check nothing.
 */
export function validateRun(
  input: unknown,
  agents: Record<string, AgentEntry> = AGENTS,
): Run {
  const run = asObject(input, "run file");
  rejectUnknownKeys(run, RUN_KEYS, "run file");

  if (!Array.isArray(run.tasks) || run.tasks.length === 0) {
    throw new Error('run file needs a non-empty "tasks" array.');
  }

  const maxConcurrency = run.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1) {
    throw new Error(
      `run file: "maxConcurrency" must be a whole number 1 or greater; ` +
        `got ${JSON.stringify(run.maxConcurrency)}.`,
    );
  }

  // Run-level defaults are validated here, eagerly. A task value wins via
  // `t.x ?? run.x`, so without this a task override would hide an invalid
  // default, and a run file carrying a bad value would pass whenever no task
  // happened to use it. The mode ceiling is not checked here: each task may
  // name a different agent, so resolvePolicy still applies the ceiling
  // per task below.
  if (run.mode !== undefined) {
    rethrowWith("run file", () =>
      resolvePolicy({ run: { mode: run.mode as ClientMode | undefined } }),
    );
  }
  if (optionalString(run.worktree, "run file", "worktree") === "inherit") {
    throw new Error(
      `run file: worktree inheritance lands in M3 — "worktree" is a base ref ` +
        `to branch from, not a task to inherit a checkout from.`,
    );
  }
  void optionalString(run.cmd, "run file", "cmd");
  const runAgent = optionalString(run.agent, "run file", "agent");
  if (runAgent !== undefined) {
    requireKnownAgent(runAgent, "run file", agents);
  }

  const seen = new Set<string>();
  const tasks = run.tasks.map((raw, i) =>
    validateTask(raw, i, run, agents, seen),
  );

  const note = optionalString(run.note, "run file", "note");
  const resolved: Run = { maxConcurrency: maxConcurrency as number, tasks };
  if (note !== undefined) resolved.note = note;
  return resolved;
}

function validateTask(
  raw: unknown,
  index: number,
  run: Record<string, unknown>,
  agents: Record<string, AgentEntry>,
  seen: Set<string>,
): Task {
  const t = asObject(raw, `tasks[${index}]`);
  rejectUnknownKeys(t, TASK_KEYS, `tasks[${index}]`);

  // `assertTaskId` throws naming the rule, and never sanitises (M1a-8).
  const id = assertTaskId(requireString(t.id, `tasks[${index}]`, "id"));
  const where = `task "${id}"`;
  if (seen.has(id)) {
    throw new Error(
      `duplicate task id ${JSON.stringify(id)}: an id names a branch, ` +
        `so two tasks cannot share one.`,
    );
  }
  seen.add(id);

  const prompt = requireString(t.prompt, where, "prompt");

  // Both halves of the M1 refusal (`docs/STORIES.md`, M1b-1 Gap 1). The
  // fields stay in the schema so M3-1 lifts a rejection rather than adding
  // a field; today they are the one thing that must not silently pass.
  if (t.needs !== undefined) {
    if (!Array.isArray(t.needs)) {
      throw new Error(`${where}: "needs" must be an array.`);
    }
    if (t.needs.length > 0) {
      throw new Error(
        `${where}: task dependencies land in M3 — "needs" must be empty. ` +
          `M1 runs independent tasks only.`,
      );
    }
  }

  const worktree = optionalString(
    t.worktree ?? run.worktree,
    where,
    "worktree",
  );
  if (worktree === "inherit") {
    throw new Error(
      `${where}: worktree inheritance lands in M3 — "worktree" is a base ref ` +
        `to branch from, not a task to inherit a checkout from.`,
    );
  }

  const cmd = optionalString(t.cmd ?? run.cmd, where, "cmd");
  const named = optionalString(t.agent ?? run.agent, where, "agent");
  // An explicitly supplied agent is always validated, even when `cmd` wins:
  // a typo must not be silently dropped on the floor.
  const namedEntry =
    named === undefined ? undefined : requireKnownAgent(named, where, agents);

  // A `cmd` carries its own launch recipe, so it needs no registry entry —
  // and has no ceiling to check, exactly as `resolveAgent` treats `--cmd`.
  let agent: string;
  let harness: HarnessLayer | undefined;
  if (cmd !== undefined) {
    agent = resolveAgent("", cmd).name;
  } else {
    // Only the first half is a real case: `namedEntry` is undefined exactly
    // when `named` is, because `requireKnownAgent` threw otherwise. The
    // second half is narrowing for tsc, not a second way to reach this error.
    if (named === undefined || namedEntry === undefined) {
      throw new Error(
        `${where}: no "agent". Name one on the task or at run level, or ` +
          `give a "cmd". Known: ${Object.keys(agents).join(", ")}.`,
      );
    }
    agent = named;
    harness = {
      name: named,
      mode: namedEntry.defaultMode,
      maxMode: namedEntry.maxMode,
    };
  }

  // `resolvePolicy` owns mode precedence and the ceiling. Its message names
  // the mode and the ceiling but not the task, which is the one thing a
  // twelve-task run file needs, so the task is added on the way out.
  const { mode, allowReadOutsideRoot } = rethrowWith(where, () =>
    resolvePolicy({
      task: {
        mode: t.mode as ClientMode | undefined,
        allowReadOutsideRoot: optionalBool(
          t.allowReadOutsideRoot,
          where,
          "allowReadOutsideRoot",
        ),
      },
      run: {
        mode: run.mode as ClientMode | undefined,
        allowReadOutsideRoot: optionalBool(
          run.allowReadOutsideRoot,
          "run file",
          "allowReadOutsideRoot",
        ),
      },
      harness,
    }),
  );

  const task: Task = { id, prompt, agent, mode, allowReadOutsideRoot };
  if (cmd !== undefined) task.cmd = cmd;
  if (worktree !== undefined) task.worktree = worktree;
  const note = optionalString(t.note, where, "note");
  if (note !== undefined) task.note = note;
  return task;
}

// --- shape helpers -----------------------------------------------------------

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  object: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${where}: unknown key ${JSON.stringify(key)}. ` +
          `Known: ${[...allowed].join(", ")}.`,
      );
    }
  }
}

function requireString(value: unknown, where: string, key: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: "${key}" must be a non-empty string.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  where: string,
  key: string,
): string | undefined {
  return value === undefined ? undefined : requireString(value, where, key);
}

function requireKnownAgent(
  value: string,
  where: string,
  agents: Record<string, AgentEntry>,
): AgentEntry {
  const entry = agents[value];
  if (!entry) {
    throw new Error(
      `${where}: unknown agent ${JSON.stringify(value)}. ` +
        `Known: ${Object.keys(agents).join(", ")}.`,
    );
  }
  return entry;
}

function optionalBool(
  value: unknown,
  where: string,
  key: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${where}: "${key}" must be true or false.`);
  }
  return value;
}

function rethrowWith<T>(where: string, f: () => T): T {
  try {
    return f();
  } catch (err) {
    throw new Error(`${where}: ${err instanceof Error ? err.message : err}`);
  }
}
