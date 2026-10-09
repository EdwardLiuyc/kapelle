/**
 * Shared plumbing for the real-harness integration suite.
 *
 * These tests drive the **actual CLI** as a subprocess against the **actual
 * harness binaries**, so they need credentials and they spend real tokens.
 * The `*.itest.ts` files stay out of CI: `node --test` does not discover the
 * suffix. The generic plumbing below (spawn helpers, temp dirs, `MOCK_AGENT`)
 * is shared with `tests/cli.test.ts`, which *does* run in CI — keep those parts
 * CI-safe. Run the opt-in files with `npm run test:harness`.
 *
 * **Assert on what we control, never on what the model says.** File on disk or
 * not, exit code, our own notice lines. A test that greps for the agent's prose
 * goes red on a model update and teaches everyone to ignore the suite.
 */

import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, type TestContext } from "node:test";
import { promisify } from "node:util";

import { AcpAgent } from "../protocol/agent.ts";
import { resolveAgent, resolveEnv } from "../protocol/registry.ts";

/** The repository root, and the cwd of every subprocess spawned here. */
export const REPO = join(import.meta.dirname, "..");

/**
 * Reason to skip, or `false` to run. Sync because `test(name, { skip })` is
 * decided when the file loads, not when the test runs. A machine missing one
 * harness skips its file and stays green — a partial install is not a failure.
 */
export function needs(bin: string): false | string {
  const found = spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
  return found ? false : `${bin} is not installed`;
}

/** A throwaway workspace the harness may write into. Removed with the test. */
export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acp-it-"));
  // Retry the recursive removal: harness extensions can still be writing into
  // the workspace for a moment after the CLI subprocess exits (pi-lens writes
  // `.pi-lens-probe-home/`), and a one-shot `rm` can fail on ENOTEMPTY.
  t.after(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  return dir;
}

/** A committed repository with **no `.gitignore`** — since #129 that is the
 *  shape a run must accept, so it is the shape the suites start from.
 *
 *  `ignore` writes one anyway, for a test that needs an ignore rule of its
 *  own; `files` are committed first so a test can build the monorepo shape. */
export async function gitRepo(
  t: TestContext,
  {
    ignore = "",
    files = {},
  }: { ignore?: string; files?: Record<string, string> } = {},
): Promise<string> {
  const cwd = await tempDir(t);
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd });
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Test");
  if (ignore !== "") await writeFile(join(cwd, ".gitignore"), ignore);
  // Something has to be committed: a run branches off a commit, and since
  // #129 the default repository has no `.gitignore` to be that something.
  await writeFile(join(cwd, "README.md"), "first\n");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    // 0o644, so a committed `.kapelle/config.json` is not refused as
    // group-writable under a umask of 0002 (core/config.ts).
    await writeFile(join(cwd, path), content, { mode: 0o644 });
  }
  await git("add", "-A");
  await git("commit", "-m", "first");
  return cwd;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * One throwaway `XDG_STATE_HOME` for every subprocess this file spawns.
 *
 * Since #129 a run's worktrees and records live under the state directory
 * rather than in the repository, so without this every CI run and every
 * developer's `npm test` would deposit branches and checkouts in their real
 * `~/.local/state/kapelle`. Forced rather than defaulted — inheriting the
 * developer's own is exactly the accident worth closing — and `env` still
 * wins, which is how `tests/daemon.test.ts` gives each daemon its own.
 */
const SPAWNED_STATE_HOME = mkdtempSync(
  join(tmpdir(), "kapelle-spawned-state-"),
);
process.on("exit", () =>
  rmSync(SPAWNED_STATE_HOME, { recursive: true, force: true }),
);
// The **test** process points at the same one, so a suite that spawns the CLI
// can call `stateDirFor` and get the directory its child actually wrote to.
// `isolateStateHome` overrides it per test for the in-process suites, which
// spawn nothing.
process.env.XDG_STATE_HOME = SPAWNED_STATE_HOME;

/**
 * Give every test in the calling file its own `XDG_STATE_HOME`.
 *
 * For the **in-process** suites — `core/tests/worktree.test.ts` and friends
 * call `stateDirFor` directly, so `process.env` is what they read. Call it
 * once at module top level. Safe as a module-level pair because `node --test`
 * runs the tests in one file serially.
 */
export function isolateStateHome(): void {
  let home: string;
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.XDG_STATE_HOME;
    home = mkdtempSync(join(tmpdir(), "kapelle-state-"));
    process.env.XDG_STATE_HOME = home;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = before;
    rmSync(home, { recursive: true, force: true });
  });
}

/**
 * The child environment, with the ambient config namespace removed. M2-7's
 * config reads `KAPELLE_*` from the process, so an exported knob would change
 * what these tests measure; a caller that means to set one passes it in
 * `env`, which still wins.
 */
function childEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(base)) {
    if (name.startsWith("KAPELLE_")) delete base[name];
  }
  base.XDG_STATE_HOME = SPAWNED_STATE_HOME;
  return env ? { ...base, ...env } : base;
}

/**
 * Run `cli.ts` as a real subprocess and collect everything it printed.
 *
 * No TTY is attached, so `--mode ask` resolves to `safe` here exactly as it
 * does in CI or a pipe. The kill in `t.after` matters: when the test runner's
 * timeout fires it does not reap our children, and a stranded harness holds a
 * session open.
 */
export function spawnCli(
  t: TestContext,
  args: string[],
  script = "cli.ts",
  /** Merged over this process's environment, never replacing it. */
  env?: Record<string, string>,
) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: REPO,
    env: childEnv(env),
  });
  t.after(() => void child.kill("SIGKILL"));

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d) => {
    stdout += d;
  });
  child.stderr.setEncoding("utf8").on("data", (d) => {
    stderr += d;
  });

  const done = new Promise<CliResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  /** Resolves once `stdout` contains `text`. For tests that signal mid-turn. */
  const waitFor = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const bail = setTimeout(
        () => reject(new Error(`never saw ${JSON.stringify(text)}`)),
        60_000,
      );
      // A child that exits instead of printing must not hold the test file
      // open for the rest of the minute.
      bail.unref();
      const check = () => {
        if (!stdout.includes(text)) return;
        clearTimeout(bail);
        child.stdout.off("data", check);
        resolve();
      };
      child.stdout.on("data", check);
      check();
    });

  return { child, done, waitFor };
}

export function runCli(
  t: TestContext,
  args: string[],
  script?: string,
): Promise<CliResult> {
  return spawnCli(t, args, script).done;
}

/** A daemon under test: its address, its token, and how to read its exit.
 *
 *  Shared by `tests/daemon.test.ts` and `tests/contract/run-dto.test.ts`, so
 *  neither suite copies the boot/HTTP plumbing (AGENTS.md: share, don't
 *  copy). */
export interface Daemon {
  url: string;
  token: string;
  /** What `daemon.json` says, next to what the test actually spawned. */
  pid: number;
  childPid: number | undefined;
  file: string;
  /** The daemon's exit, for the tests that stop it. */
  done: Promise<CliResult>;
}

/** The user-level directories a daemon must not share with anyone.
 *
 *  Despite the `use` prefix it returns the env object; it also points **this
 *  process** at the same state home, because since #129 a run's worktrees and
 *  records live there: a fixture built here with `openWorktrees` or read back
 *  with `stateDirFor` has to agree with the daemon that owns them. */
export function useDaemonDirs(runtime: string, state: string = runtime) {
  process.env.XDG_STATE_HOME = state;
  return {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: state,
    // M2-7's user config reads `$XDG_CONFIG_HOME/kapelle/config.json`; a path
    // under this test's own state dir keeps a developer's real file out.
    XDG_CONFIG_HOME: join(state, "config-home"),
  };
}

/** Spawns `daemon.ts` with `runtime` as its runtime directory and `state` as
 *  its state directory (defaulting to `runtime`). `extraEnv` merges last, so a
 *  test can point `HOME`/`XDG_STATE_HOME` wherever it needs. */
export function startDaemon(
  t: TestContext,
  runtime: string,
  args: string[] = [],
  state: string = runtime,
  extraEnv: Record<string, string> = {},
) {
  return spawnCli(t, ["--port", "0", ...args], "daemon.ts", {
    ...useDaemonDirs(runtime, state),
    ...extraEnv,
  });
}

/** Starts a daemon and reads back the record it wrote once listening. */
export async function bootDaemon(
  t: TestContext,
  runtime?: string,
  args: string[] = [],
  state?: string,
  env: Record<string, string> = {},
): Promise<Daemon> {
  const dir = runtime ?? (await tempDir(t));
  const d = startDaemon(t, dir, args, state ?? dir, env);
  // A daemon that dies at startup must fail with its own words, not a timeout.
  const died = d.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([d.waitFor("listening on "), died]);
  died.catch(() => {});
  const file = join(dir, "kapelle", "daemon.json");
  let record: { port: number; token: string; pid: number };
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(
      `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { port, token, pid } = record;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    pid,
    childPid: d.child.pid,
    file,
    done: d.done,
  };
}

/** One request to a running daemon, with its token already on it. */
export async function daemonApi<T>(
  d: Daemon,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = d.token,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(d.url + path, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (text === "") {
    // SAFETY: every route answers JSON but `DELETE /rooms/:id`'s `204`, so
    // an empty body is that, or a broken daemon; the old helper returned
    // `undefined` here and the caller fails on the missing fields anyway.
    return { status: res.status, body: undefined as unknown as T };
  }
  try {
    return { status: res.status, body: JSON.parse(text) as T };
  } catch (err) {
    throw new Error(
      `${method} ${path} did not answer JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Registers `path` with the daemon and returns it, so a test reads
 *  `cwd = await addRepo(d, ...)`. */
export async function addRepo(d: Daemon, path: string): Promise<string> {
  const r = await daemonApi<{ error?: { message: string } }>(
    d,
    "POST",
    "/repos",
    { path },
  );
  assert.equal(r.status, 200, r.body?.error?.message);
  return path;
}

/**
 * Absolute path to the offline harness.
 *
 * Absolute because `AcpAgent` spawns the harness **in the workspace root**
 * (`protocol/agent.ts`), not in the repo — so a relative `mock-agent.mjs`
 * vanishes the moment a test passes its own `--cwd`.
 */
export const MOCK_AGENT = join(REPO, "mock-agent.mjs");

/** Its opposite: the harness that attacks the client (M1b-6). Absolute for the same reason. */
export const HOSTILE_AGENT = join(REPO, "hostile-agent.mjs");

/** The prompt every write test uses. One file, one word, nothing to interpret. */
export const WRITE_PROMPT =
  "create a file called PROOF.md containing the single word hello";

/** What `twoTurns` saw. Every field is ours to observe, none is the model's prose. */
export interface TwoTurns {
  first: string;
  second: string;
  sessionBefore: string;
  sessionAfter: string | null;
  spawns: number;
}

/**
 * Two prompts on one session, the second sent only after the first ended.
 *
 * The one integration helper that drives `AcpAgent` rather than `cli.ts`: the
 * CLI sends one prompt per session, so no argv reaches a second turn. #62 R5
 * refuses a prompt *during* a live turn; this is the other case, measured on
 * all four harnesses on 2026-09-15 (`docs/FINDINGS.md` §Multi-turn). The
 * prompts carry a codeword so a human reading a failure can see whether context
 * held, but the caller asserts only stop reasons, the session id and the spawn
 * count. `policy: () => false` because nothing here needs a tool.
 */
export async function twoTurns(t: TestContext, id: string): Promise<TwoTurns> {
  const spec = resolveAgent(id);
  const cwd = await tempDir(t);
  let spawns = 0;
  const agent = new AcpAgent({
    name: id,
    command: spec.launch.command,
    args: spec.launch.args,
    env: resolveEnv(spec.launch.env),
    cwd,
    policy: () => false,
    onEvent: (e) => {
      if (e.update.sessionUpdate === "_client_harness_spawned") spawns++;
    },
  });
  t.after(() => agent.stop());

  await agent.start();
  const sessionBefore = await agent.newSession();
  const first = await agent.prompt(
    "Remember this codeword: ZEBRA-4417. Do not use any tools. Reply with only the word OK.",
  );
  const second = await agent.prompt(
    "What codeword did I give you in my previous message? Do not use any tools. Reply with only the codeword.",
  );
  return {
    first: first.stopReason,
    second: second.stopReason,
    sessionBefore,
    sessionAfter: agent.sessionId,
    spawns,
  };
}
