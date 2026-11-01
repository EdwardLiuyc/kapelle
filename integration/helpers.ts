/**
 * Shared plumbing for the suites that drive the real entry points.
 *
 * Two kinds of suite use it. The `*.itest.ts` files drive the **actual CLI**
 * against the **actual harness binaries**, so they need credentials and spend
 * real tokens; they stay out of CI because `node --test` does not discover the
 * suffix. Run them with `npm run test:harness`. Most of this file serves the
 * other kind, which **does** run in CI: `tests/cli.test.ts`, the contract
 * tests, and the daemon suites (`tests/daemon*.test.ts`, `tests/attach.test.ts`,
 * `tests/chat-*.test.ts`), whose own helpers are the last section. They use
 * `mock-agent.mjs`, so everything here except `twoTurns` must stay
 * credential-free.
 *
 * **Assert on what we control, never on what the model says.** File on disk or
 * not, exit code, our own notice lines. A test that greps for the agent's prose
 * goes red on a model update and teaches everyone to ignore the suite.
 */

import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, type TestContext } from "node:test";
import { promisify } from "node:util";

import type {
  ParticipantDto,
  RoomDto,
  RoomEventLine,
} from "../client/contract.ts";
import { stateDirFor } from "../core/runtime.ts";
import { AcpAgent } from "../protocol/agent.ts";
import { AGENTS, resolveAgent, resolveEnv } from "../protocol/registry.ts";

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
 * wins, which is how the daemon suites give each daemon its own.
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
export function childEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
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
 *  Shared by the daemon suites and `tests/contract/run-dto.test.ts`, so no
 *  suite copies the boot/HTTP plumbing (AGENTS.md: share, don't
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

/**
 * A saved find with every agent ready and "done" (M9-3), and a saved check
 * for each (M9-4), unless the test wrote its own. Without them, each test
 * daemon would run `--version` on this machine's agents, then start each one
 * for a check, and the chat screen would open the setup list over what a
 * test waits for.
 */
export function savedSetup(state: string): void {
  const dir = join(state, "kapelle");
  const file = join(dir, "harnesses.json");
  if (existsSync(file)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const found = Object.fromEntries(
    Object.entries(AGENTS).map(([id, a]) => {
      const version = a.measured?.measuredOn.version;
      return [id, { program: true, version, acp: true, acpVersion: version }];
    }),
  );
  const checks = Object.fromEntries(
    Object.entries(AGENTS).map(([id, a]) => [
      id,
      {
        checkedAt: "2026-10-22T00:00:00.000Z",
        version: a.measured?.measuredOn.version,
        login: "ok",
        models: [],
      },
    ]),
  );
  writeFileSync(join(dir, "checks.json"), JSON.stringify(checks), {
    mode: 0o600,
  });
  writeFileSync(
    file,
    JSON.stringify({
      checkedAt: "2026-10-22T00:00:00.000Z",
      done: true,
      found,
    }),
    { mode: 0o600 },
  );
}

/**
 * A folder to use as `PATH`, with fake agents (M9-3). Each one prints a
 * version line, as the real one does.
 *
 * - opencode `v2.0.18` and kimi `2.3.0`: ready, their own ACP program.
 * - pi `1.3.0`, and pi-acp as an npm bin link to a package at `0.0.33`:
 *   ready, with a version warning. pi-acp writes `pi-acp.ran` beside its
 *   package if anything runs it: its version must come from the file.
 * - claude only, with no claude-agent-acp: the ACP program is missing.
 * - codex-acp with no codex, and no copilot: not installed.
 */
export async function fakePath(t: TestContext): Promise<string> {
  const root = await tempDir(t);
  const bin = join(root, "bin");
  const pkg = join(root, "lib", "pi-acp");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await mkdir(bin);
  const script = async (file: string, body: string) =>
    writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await script(join(bin, "opencode"), 'echo "opencode v2.0.18"');
  await script(join(bin, "kimi"), "echo 2.3.0");
  await script(join(bin, "pi"), "echo 1.3.0");
  await script(join(bin, "claude"), 'echo "2.1.307 (Claude Code)"');
  await script(join(bin, "codex-acp"), "echo 2.2.2");
  await writeFile(join(pkg, "package.json"), '{"version":"0.0.33"}');
  await script(
    join(pkg, "dist", "index.js"),
    `touch ${join(pkg, "pi-acp.ran")}`,
  );
  await symlink(join(pkg, "dist", "index.js"), join(bin, "pi-acp"));
  return bin;
}

/** A fake `npm` in `bin` (M9-3b). It adds its argv as a line to
 *  `bin/npm.argv`, and puts the named ACP program on `bin`: claude 0.89.1 or
 *  codex 2.2.2. `fail` exits 243 with npm's EACCES line, as an install that
 *  needs `sudo` does. `hold` waits for a file `bin/go` first. `bin` may be
 *  the daemon's whole `PATH`, so the script names `chmod` and `sleep` by
 *  their paths. */
export async function fakeNpm(
  bin: string,
  { fail = false, hold = false } = {},
): Promise<void> {
  const where = (cmd: string) =>
    spawnSync("sh", ["-c", `command -v ${cmd}`], {
      encoding: "utf8",
    }).stdout.trim();
  const claude = join(bin, "claude-agent-acp");
  const codex = join(bin, "codex-acp");
  const body = [
    `echo "$*" >> "${join(bin, "npm.argv")}"`,
    'echo "npm http fetch GET 200 https://registry.npmjs.org/ 12ms"',
    ...(hold
      ? [`while [ ! -e "${join(bin, "go")}" ]; do ${where("sleep")} 0.05; done`]
      : []),
    ...(fail
      ? ['echo "npm error code EACCES" >&2', "exit 243"]
      : [
          'case "$*" in',
          `  *claude-agent-acp*) file="${claude}"; version=0.89.1 ;;`,
          `  *codex-acp*) file="${codex}"; version=2.2.2 ;;`,
          "  *) exit 0 ;;",
          "esac",
          `printf '#!/bin/sh\\necho %s\\n' "$version" > "$file"`,
          `${where("chmod")} 755 "$file"`,
          'echo "added 1 package in 1s"',
        ]),
  ];
  await writeFile(join(bin, "npm"), `#!/bin/sh\n${body.join("\n")}\n`, {
    mode: 0o755,
  });
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
  savedSetup(state);
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

// --- the daemon and chat suites (#340) ------------------------------------------
//
// `tests/daemon*.test.ts`, `tests/attach.test.ts` and `tests/chat-*.test.ts`
// were one file. What more than one of them needs is here.

/** The exit of a daemon expected to refuse, or `null` if it kept running. */
export async function exitOf(
  d: ReturnType<typeof startDaemon>,
): Promise<CliResult | null> {
  const late = new Promise<null>((ok) => setTimeout(() => ok(null), 5_000));
  return Promise.race([d.done, late]);
}

/** A run record, a repo, and the `{error}` every refusal sends, typed as the
 *  tests read them: each test asserts only the fields its reply carries. */
export interface Reply {
  id: string;
  status: string;
  cwd: string;
  root: string;
  source: "live" | "restored";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  turns?: number;
  error: { code: string; message: string };
  cancelRequested?: true;
  /** One shape live and restored: a field the record cannot fill is omitted. */
  tasks: {
    id: string;
    status: string;
    agent?: string;
    durationMs?: number;
    sessionId?: string;
    warnings?: { kind: string; text: string }[];
  }[];
  notices: { taskId: string; text: string }[];
}

/** The suite's default reply type; `daemonApi` itself is shared. */
export async function api<T = Reply>(
  d: Daemon,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = d.token,
): Promise<{ status: number; body: T }> {
  return daemonApi<T>(d, method, path, body, token);
}

export const mockRun = (
  tasks: Record<string, unknown>[],
  rest: Record<string, unknown> = {},
) => ({ cmd: `node ${MOCK_AGENT}`, mode: "auto", ...rest, tasks });

/** Polls `GET /runs/:id` until the run leaves `running`. */
export async function settled(d: Daemon, id: string): Promise<Reply> {
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const r = await api(d, "GET", `/runs/${id}`);
    assert.equal(r.status, 200);
    if (r.body.status !== "running") return r.body;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`run ${id} never settled`);
}

/** Does the repository have this exact local branch? */
export function hasBranch(root: string, branch: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: root,
    }).status === 0
  );
}

/** Is `pid` a live process right now? */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True once `pid` is gone, false if it is still alive after 10s. */
export async function gone(pid: number): Promise<boolean> {
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return false;
}

export async function until(
  what: string,
  /** Awaited, so a check that has to ask the daemon is written inline. */
  check: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export interface Pending {
  id: string;
  runId: string;
  taskId: string;
  kind: string;
  title: string;
}

/** A run file naming no mode: every registry entry defaults to `ask`, so this
 *  is the file people actually write. */
export const askRun = (cwd: string) => ({
  cwd,
  run: { cmd: `node ${MOCK_AGENT}`, tasks: [{ id: "one", prompt: "hi" }] },
});

/** Polls `GET /permissions` until one decision is pending, and returns it. */
export async function pendingOne(d: Daemon): Promise<Pending> {
  for (const end = Date.now() + 20_000; Date.now() < end; ) {
    const r = await api<Pending[]>(d, "GET", "/permissions");
    assert.equal(r.status, 200);
    const [found] = r.body;
    if (found) return found;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("no permission ever became pending");
}

export const REMEMBER = `node ${MOCK_AGENT} --scenario remember`;

export interface RoomReply extends RoomDto {
  error: { code: string; message: string };
}

/** A `POST /rooms` body with one orchestrator running `cmd`. */
export const withAgent = (cwd: string, cmd: string) => ({
  cwd,
  agents: [{ cmd, role: "orchestrator" }],
});

/** The room's one participant. */
export const only = (room: RoomDto): ParticipantDto => {
  assert.equal(room.participants.length, 1);
  return room.participants[0] as ParticipantDto;
};

/** Polls `GET /rooms/:id` until its participant is no longer `busy`. */
export async function roomIdle(d: Daemon, id: string): Promise<RoomReply> {
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const r = await api<RoomReply>(d, "GET", `/rooms/${id}`);
    assert.equal(r.status, 200);
    if (only(r.body).status !== "busy") return r.body;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`room ${id} never went idle`);
}

/** Commits one file in a participant's checkout, as the agent itself would
 *  (R37: the supervisor never commits). */
export async function commitAt(worktree: string, file: string) {
  await writeFile(join(worktree, file), `${file}\n`);
  for (const args of [
    ["add", file],
    ["commit", "-qm", file],
  ]) {
    const r = spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
}

/** A checkout's HEAD sha. */
export const headAt = (worktree: string) =>
  spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  }).stdout.trim();

/** `script` from util-linux gives a child a real pseudo-terminal. Its flags
 *  differ on macOS, so the TTY test is Linux-only; it skips elsewhere. */
export const noPty =
  process.platform !== "linux" ||
  spawnSync("script", ["--version"]).status !== 0
    ? "needs util-linux script(1) for a pseudo-terminal"
    : false;

/**
 * A command on a pseudo-terminal, once `until` is on screen. Pipes never
 * reach this path: only a TTY gets the pi-tui screen. A pty made by `script`
 * from a pipe has no size, so the command sets one.
 *
 * `press` writes keys and waits for `text` in what is drawn after them,
 * because a string that was already on screen proves nothing about a key.
 */
export async function ptyScreen(
  t: TestContext,
  command: string,
  env: Record<string, string>,
  until = "enter to send",
) {
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
  });
  t.after(() => void child.kill("SIGKILL"));

  let out = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => {
    out += c;
  });
  const seen = (text: string, ms = 20_000) =>
    new Promise<void>((ok, fail) => {
      const bail = setTimeout(
        () => fail(new Error(`never saw ${text}: ${out}`)),
        ms,
      );
      const check = () => {
        if (!out.includes(text)) return;
        clearTimeout(bail);
        child.stdout.off("data", check);
        ok();
      };
      child.stdout.on("data", check);
      check();
    });
  const press = async (keys: string, text: string) => {
    const from = out.length;
    child.stdin.write(keys);
    for (const until = Date.now() + 20_000; ; ) {
      if (out.slice(from).includes(text)) return;
      assert.ok(Date.now() < until, `${JSON.stringify(keys)}: ${out}`);
      await new Promise((ok) => setTimeout(ok, 50));
    }
  };
  const exited = new Promise<number | null>((ok) =>
    child.on("close", (code) => ok(code)),
  );

  await seen(until);
  return { child, seen, press, exited, out: () => out };
}

/**
 * `chat.ts new` on a pseudo-terminal, against a fresh daemon, once the
 * screen is up.
 */
/** The keys that leave the chat screen: ctrl+c twice. pi-tui splits the
 *  chunk into two keys, as it does for a terminal that sends them at once. */
export const LEAVE = "\x03\x03";

export async function chatOnPty(t: TestContext, agent = REMEMBER) {
  const runtime = await tempDir(t);
  const d = await bootDaemon(t, runtime);
  const cwd = await addRepo(d, await gitRepo(t));
  const cmd = `stty cols 100 rows 30; node chat.ts new --cmd '${agent}' --cwd '${cwd}'`;
  const screen = await ptyScreen(t, cmd, { XDG_RUNTIME_DIR: runtime });
  return { ...screen, d, cwd };
}

/** CSI, OSC and APC sequences; pi-tui writes all three. */
const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
  /\x1b(\[[0-9;?<>]*[A-Za-z~]|\][^\x07\x1b]*(\x07|\x1b\\)|_[^\x1b]*\x1b\\)/g;

/** Terminal output as text: no escapes, no carriage returns. */
export const plainText = (out: string) =>
  out.replace(ESCAPES, "").replace(/\r/g, "");

/** The screen now, by row. pi-tui writes a row as CSI row;1H, CSI 2K, so
 *  the last text written to each row is what it shows. */
export function screenRows(out: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the subject.
  const parts = out.split(/\x1b\[(\d+);1H\x1b\[2K/);
  const rows = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) {
    rows.set(Number(parts[i]), plainText(parts[i + 1] ?? ""));
  }
  return rows;
}

/** The first row on screen whose text matches. 0 for none. */
export const rowOf = (out: string, re: RegExp) =>
  [...screenRows(out)].find(([, text]) => re.test(text))?.[0] ?? 0;

/** What stays on the normal screen once the alternate one is left. */
export const scrollback = (out: string) =>
  plainText(out.slice(out.lastIndexOf("\x1b[?1049l")));

/** A daemon whose `PATH` is `path`, with no saved find, so the first ask
 *  finds (M9-3). */
export async function bootFinding(t: TestContext, path: string) {
  const runtime = await tempDir(t);
  const d = await bootDaemon(t, runtime, [], runtime, { PATH: path });
  await rm(join(runtime, "kapelle", "harnesses.json"));
  return { d, runtime };
}

/** Every line of a room's log, read from disk. */
export async function roomLog(
  root: string,
  id: string,
): Promise<
  (Omit<RoomEventLine, "update"> & { update: Record<string, unknown> })[]
> {
  const text = await readFile(
    join(stateDirFor(root), "rooms", id, "events.jsonl"),
    "utf8",
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The answers in `lines`, in order. */
export const answersIn = (lines: { update: Record<string, unknown> }[]) =>
  lines
    .filter((l) => l.update.sessionUpdate === "agent_message_chunk")
    .map((l) => (l.update.content as { text: string }).text);

/** A room with one `cmd` participant on a first daemon, and what a second
 *  daemon on the same directories needs. */
export async function roomToRestart(t: TestContext, cmd: string) {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await bootDaemon(t, runtime, [], state);
  const cwd = await realpath(await addRepo(first, await gitRepo(t)));
  const open = await api<RoomReply>(first, "POST", "/rooms", {
    ...withAgent(cwd, cmd),
    title: "kept",
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const again = () => bootDaemon(t, runtime, [], state);
  return {
    first,
    cwd,
    id: open.body.id,
    alice: only(open.body),
    again,
    runtime,
  };
}
