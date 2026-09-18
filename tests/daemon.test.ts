/**
 * The daemon — `daemon.ts`, M2-1 (#31) — driven as a real subprocess over
 * real HTTP.
 *
 * **None of this needs a harness**, so it runs in CI like `tests/cli.test.ts`:
 * every run points at `mock-agent.mjs`, and every refusal fails before a
 * subprocess starts. Each daemon gets its own `XDG_RUNTIME_DIR` **and
 * `XDG_STATE_HOME`**, so no test ever meets another test's `daemon.json` or
 * `repos.json` — or the developer's real ones. Most tests point both at one
 * temp dir; the restart and fallback tests keep them apart, the way a reboot
 * does in real life.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { userInfo } from "node:os";
import { join, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { processIdentity } from "../core/sweep.ts";
import { openWorktrees } from "../core/worktree.ts";
import {
  type CliResult,
  gitRepo,
  MOCK_AGENT,
  REPO,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";

interface Daemon {
  url: string;
  token: string;
  /** What `daemon.json` says, next to what the test actually spawned. */
  pid: number;
  childPid: number | undefined;
  file: string;
  /** The daemon's exit, for the tests that stop it. */
  done: Promise<CliResult>;
}

/** Spawns `daemon.ts` with `runtime` as its runtime directory and `state` as
 *  its state directory (defaulting to `runtime`). `extraEnv` merges last, so a
 *  test can point `HOME`/`XDG_STATE_HOME` wherever it needs. */
function start(
  t: TestContext,
  runtime: string,
  args: string[] = [],
  state: string = runtime,
  extraEnv: Record<string, string> = {},
) {
  return spawnCli(t, ["--port", "0", ...args], "daemon.ts", {
    ...dirs(runtime, state),
    ...extraEnv,
  });
}

/** The user-level directories a daemon must not share with anyone. */
const dirs = (runtime: string, state: string = runtime) => ({
  XDG_RUNTIME_DIR: runtime,
  XDG_STATE_HOME: state,
  // M2-7's user config reads `$XDG_CONFIG_HOME/kapelle/config.json`; a path
  // under this test's own state dir keeps a developer's real file out.
  XDG_CONFIG_HOME: join(state, "config-home"),
});

/** Starts a daemon and reads back the record it wrote once listening. */
async function boot(
  t: TestContext,
  runtime?: string,
  args: string[] = [],
  state?: string,
  env: Record<string, string> = {},
): Promise<Daemon> {
  const dir = runtime ?? (await tempDir(t));
  const d = start(t, dir, args, state ?? dir, env);
  // A daemon that dies at startup must fail with its own words, not a timeout.
  const died = d.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([d.waitFor("listening on "), died]);
  died.catch(() => {});
  const file = join(dir, "kapelle", "daemon.json");
  const { port, token, pid } = JSON.parse(await readFile(file, "utf8"));
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    pid,
    childPid: d.child.pid,
    file,
    done: d.done,
  };
}

/** The exit of a daemon expected to refuse, or `null` if it kept running. */
async function exitOf(d: ReturnType<typeof start>): Promise<CliResult | null> {
  const late = new Promise<null>((ok) => setTimeout(() => ok(null), 5_000));
  return Promise.race([d.done, late]);
}

/** A run record, a repo, and the `{error}` every refusal sends, typed as the
 *  tests read them: each test asserts only the fields its reply carries. */
interface Reply {
  id: string;
  status: string;
  cwd: string;
  root: string;
  error: string;
  cancelRequested?: true;
  report: { tasks: { status: string }[] };
  /** A run restored from disk carries its record's tasks, not a report. */
  tasks?: { id: string; status: string; sessionId?: string }[];
  notices: { taskId: string; text: string }[];
}

async function api<T = Reply>(
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
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const mockRun = (
  tasks: Record<string, unknown>[],
  rest: Record<string, unknown> = {},
) => ({ cmd: `node ${MOCK_AGENT}`, mode: "auto", ...rest, tasks });

/** Registers `path` and returns it, so a test reads `cwd = await added(...)`. */
async function added(d: Daemon, path: string): Promise<string> {
  const r = await api(d, "POST", "/repos", { path });
  assert.equal(r.status, 200, r.body.error);
  return path;
}

/** Polls `GET /runs/:id` until the run leaves `running`. */
async function settled(d: Daemon, id: string): Promise<Reply> {
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const r = await api(d, "GET", `/runs/${id}`);
    assert.equal(r.status, 200);
    if (r.body.status !== "running") return r.body;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`run ${id} never settled`);
}

/** Does the repository have this exact local branch? */
function hasBranch(root: string, branch: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: root,
    }).status === 0
  );
}

/** A finished run written straight to disk with a real checkout and branch:
 *  the shape M2-5's boot sweep reaps, without going through `POST /runs`. */
async function directFinishedRun(
  root: string,
  id: string,
  endedAt: string,
): Promise<{ dir: string; worktree: string; branch: string }> {
  const { worktrees } = await openWorktrees(root, id);
  assert.ok(worktrees, "the fixture repository should carry worktrees");
  const worktree = await worktrees.acquire("a");
  const branch = `kapelle/${id}/a`;
  const dir = join(root, ".kapelle", "runs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      runId: id,
      root,
      cwd: root,
      status: "failed",
      startedAt: endedAt,
      endedAt,
      tasks: [{ id: "a", status: "failed", branch }],
    }),
  );
  await writeFile(join(dir, "events.jsonl"), "{}\n");
  return { dir, worktree, branch };
}

// --- the token and daemon.json --------------------------------------------------

test("a request without the right token is refused, and changes nothing", async (t) => {
  const d = await boot(t);
  const cwd = await tempDir(t);
  const run = { cwd, run: mockRun([{ id: "a", prompt: "hi" }]) };

  assert.equal(
    (await api(d, "POST", "/repos", { path: cwd }, null)).status,
    401,
  );
  assert.equal(
    (await api(d, "POST", "/runs", run, "0".repeat(64))).status,
    401,
  );
  assert.equal((await api(d, "GET", "/runs", undefined, "short")).status, 401);

  assert.deepEqual((await api(d, "GET", "/repos")).body, []);
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

/**
 * A raw request with a `Host` of our choosing. `fetch` cannot send one — the
 * spec makes `Host` a forbidden header name — and a browser cannot either,
 * which is the whole reason the check works.
 */
function rawGet(
  d: Daemon,
  host: string | null,
  { auth = true, path = "/runs", second = "" } = {},
): Promise<{ status: number; body: string }> {
  const { port } = new URL(d.url);
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        setHost: false,
        headers: {
          ...(auth ? { authorization: `Bearer ${d.token}` } : {}),
          ...(host === null ? {} : { host }),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: text }));
      },
    );
    // Node's options reject an array Host; setHeader is how two lines go out.
    if (second) req.setHeader("host", [host ?? "", second]);
    req.on("error", fail);
    req.end();
  });
}

test("a Host outside loopback is refused, token or no token", async (t) => {
  const d = await boot(t);

  // The rebinding shape: a real token would not help, and this one is real.
  const forged = await rawGet(d, "evil.example");
  assert.equal(forged.status, 403);
  assert.match(forged.body, /host not allowed/);

  // Host refusal precedes authentication, which would otherwise answer 401.
  assert.equal((await rawGet(d, "evil.example", { auth: false })).status, 403);
  assert.equal(
    (await rawGet(d, "evil.example", { path: "/runs/some-id/events" })).status,
    403,
  );

  // A Host-less request reaches the same guard, not Node's default 400 — on
  // HTTP/1.0 too, where `requireHostHeader` has no say at all.
  assert.equal((await rawGet(d, null)).status, 403);

  const { port } = new URL(d.url);

  // Two Host lines: Node reports only the first, so a loopback line in front
  // of a forged one would pass a guard that read `req.headers.host`.
  assert.equal(
    (await rawGet(d, "127.0.0.1", { second: "evil.example" })).status,
    403,
  );

  // An absolute-form target carries the authority that wins over Host, both
  // ways round: the forged one refused, the loopback one served.
  assert.equal(
    (await rawGet(d, `localhost:${port}`, { path: "http://evil.example/runs" }))
      .status,
    403,
  );
  assert.equal(
    (await rawGet(d, "evil.example", { path: `http://127.0.0.1:${port}/runs` }))
      .status,
    200,
  );

  // The names a local client actually sends still pass. `[::1]` is forged by
  // rawGet over an IPv4 socket: the daemon binds 127.0.0.1 only.
  for (const host of [
    `127.0.0.1:${port}`,
    "127.0.0.1",
    `localhost:${port}`,
    "localhost",
    `LOCALHOST:${port}`,
    `localhost.:${port}`,
    `[::1]:${port}`,
    "[::1]",
  ]) {
    assert.equal((await rawGet(d, host)).status, 200, host);
  }
});

test("daemon.json holds port, pid and a random token, and only the owner can read it", async (t) => {
  const d = await boot(t);
  const other = await boot(t);

  assert.match(d.token, /^[0-9a-f]{64}$/);
  assert.notEqual(d.token, other.token);
  assert.equal(d.pid, d.childPid);
  assert.equal((await stat(d.file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(d.file, ".."))).mode & 0o777, 0o700);
});

test("a second daemon refuses to start, and leaves the first one's token alone", async (t) => {
  const runtime = await tempDir(t);
  const first = await boot(t, runtime);
  const before = await readFile(first.file, "utf8");

  const second = await exitOf(start(t, runtime));
  assert.ok(second, "the second daemon kept running");
  assert.equal(second.code, 1);
  assert.match(second.stderr, new RegExp(`already running: pid ${first.pid}`));

  assert.equal(await readFile(first.file, "utf8"), before);
  assert.equal((await api(first, "GET", "/runs")).status, 200);
});

test("a daemon.json left by a daemon that died is replaced, not obeyed", async (t) => {
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: dead, port: 1, token: "stale" }),
    { mode: 0o600 },
  );

  const d = await boot(t, runtime);
  assert.notEqual(d.token, "stale");
  assert.equal(d.pid, d.childPid);
});

test("a runtime directory other users can enter is refused", async (t) => {
  const runtime = await tempDir(t);
  const dir = join(runtime, "kapelle");
  await mkdir(dir);
  await chmod(dir, 0o755);

  const r = await exitOf(start(t, runtime));
  assert.ok(r, "the daemon started anyway");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /0700/);
  await assert.rejects(readFile(join(dir, "daemon.json")));
});

test("a state directory other users can enter is refused", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const dir = join(state, "kapelle");
  await mkdir(dir);
  await chmod(dir, 0o755);

  // Two separate directories on purpose: the runtime one is fine, so the
  // refusal below is the state directory's own guard and not `runtimeDir`'s.
  // `repos.json` names the folders the daemon will start harnesses in.
  const r = await exitOf(
    spawnCli(t, ["--port", "0"], "daemon.ts", dirs(runtime, state)),
  );
  assert.ok(r, "the daemon started anyway");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /0700/);
  await assert.rejects(readFile(join(runtime, "kapelle", "daemon.json")));
});

for (const stale of ["null", "[]", "42"]) {
  test(`a daemon.json holding ${stale} is replaced, like any dead daemon's`, async (t) => {
    const runtime = await tempDir(t);
    const dir = join(runtime, "kapelle");
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, "daemon.json"), stale, { mode: 0o600 });

    const d = await boot(t, runtime);
    assert.equal(typeof d.pid, "number");
    process.kill(d.pid, "SIGTERM");
    assert.equal((await d.done).code, 0);
  });
}

// --- lifecycle (M2-4) --------------------------------------------------------------

/** Is `pid` a live process right now? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True once `pid` is gone, false if it is still alive after 10s. */
async function gone(pid: number): Promise<boolean> {
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

/** Starts a run whose harness never ends its turn, and returns the pid the
 *  daemon recorded for it in `children.json`. */
async function stalledHarness(t: TestContext, d: Daemon): Promise<number> {
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([
      { id: "stuck", prompt: "hi", cmd: `node ${MOCK_AGENT} --scenario stall` },
    ]),
  });
  assert.equal(posted.status, 202, posted.body.error);
  const children = join(d.file, "..", "children.json");
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    const record = await readFile(children, "utf8").catch(() => null);
    if (record) {
      const [child] = JSON.parse(record).children;
      // Registered before the assertions: a failing assertion must not skip
      // the reap and leave the harness behind.
      t.after(() => {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already gone: nothing left to kill.
        }
      });
      assert.equal(child.runId, posted.body.id);
      assert.equal(child.taskId, "stuck");
      return child.pid;
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("children.json never named the harness");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} cancels every run, stops its harness, removes daemon.json and exits 0`, async (t) => {
    const d = await boot(t);
    const harness = await stalledHarness(t, d);

    process.kill(d.pid, signal);
    const exit = await d.done;
    assert.equal(exit.code, 0, exit.stderr);
    assert.equal(await gone(harness), true, "the harness outlived the daemon");
    await assert.rejects(readFile(d.file), "daemon.json is removed");
    await assert.rejects(
      readFile(join(d.file, "..", "children.json")),
      "children.json is removed once no harness is live",
    );
  });
}

test("kill -9 of the daemon mid-turn leaves no harness alive, and the pid on record", async (t) => {
  const d = await boot(t);
  const harness = await stalledHarness(t, d);

  process.kill(d.pid, "SIGKILL");
  await d.done;
  // Nothing in the daemon ran: the harness saw its stdin close and exited.
  assert.equal(await gone(harness), true, "the harness outlived the daemon");
  const record = await readFile(join(d.file, "..", "children.json"), "utf8");
  assert.equal(JSON.parse(record).children[0].pid, harness);
});

test("daemons started together on a stale daemon.json: exactly one listens", async (t) => {
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: dead, port: 1, token: "stale" }),
    { mode: 0o600 },
  );

  const daemons = Array.from({ length: 6 }, () => start(t, runtime));
  const outcomes = await Promise.all(
    daemons.map((d) =>
      Promise.race([
        d.waitFor("listening on ").then(() => "listening"),
        d.done.then((r) => `exited ${r.code}`),
      ]),
    ),
  );
  assert.equal(
    outcomes.filter((o) => o === "listening").length,
    1,
    outcomes.join(", "),
  );
  assert.deepEqual(
    outcomes.filter((o) => o !== "listening"),
    Array(5).fill("exited 1"),
  );
});

test("the strict lock refuses a start while held, and is gone once a start succeeds", async (t) => {
  const runtime = await tempDir(t);
  const dir = join(runtime, "kapelle");
  await mkdir(dir, { mode: 0o700 });
  // A stale daemon.json makes a newcomer take the lock path at all; the held
  // lock is another starter mid-replace, so this one must refuse rather than
  // wait (M2-4).
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  await writeFile(
    join(dir, "daemon.json"),
    JSON.stringify({ pid: dead, port: 1, token: "stale" }),
    { mode: 0o600 },
  );
  const lock = join(dir, "daemon.json.lock");
  await mkdir(lock);

  const refused = await exitOf(start(t, runtime));
  assert.ok(refused, "a held lock refuses, it does not listen");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /another daemon is starting/);
  await stat(lock); // the loser does not remove a lock it did not take
  await rm(lock, { recursive: true, force: true });
  // A start that takes the lock releases it again, so the next one works.
  const first = await boot(t, runtime);
  await assert.rejects(stat(lock), "the winner removed its own lock");
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await boot(t, runtime);
  assert.equal(typeof second.pid, "number");
  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});

test("kapelle daemon start listens, and kapelle daemon add registers a repository", async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  const repo = await tempDir(t);

  const none = await spawnCli(t, ["daemon", "add", repo], "cli.ts", env).done;
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no daemon is listening/);

  const daemon = spawnCli(t, ["daemon", "start", "--port", "0"], "cli.ts", env);
  const died = daemon.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([daemon.waitFor("listening on "), died]);
  died.catch(() => {});

  const add = await spawnCli(t, ["daemon", "add", repo], "cli.ts", env).done;
  assert.equal(add.code, 0, add.stderr);
  assert.equal(add.stdout.trim(), `added ${await realpath(repo)}`);

  const file = join(runtime, "kapelle", "daemon.json");
  const { port, token, pid } = JSON.parse(await readFile(file, "utf8"));
  const d = { url: `http://127.0.0.1:${port}`, token, pid } as Daemon;
  assert.deepEqual((await api<string[]>(d, "GET", "/repos")).body, [
    await realpath(repo),
  ]);
});

test("kapelle --quiet daemon start starts the daemon, global flags included", async (t) => {
  const runtime = await tempDir(t);
  const daemon = spawnCli(
    t,
    ["--quiet", "daemon", "start", "--port", "0"],
    "cli.ts",
    dirs(runtime),
  );
  const died = daemon.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([daemon.waitFor("listening on "), died]);
  died.catch(() => {});

  const file = join(runtime, "kapelle", "daemon.json");
  assert.equal(typeof JSON.parse(await readFile(file, "utf8")).pid, "number");
});

test("kapelle daemon add treats a non-object daemon.json as no daemon", async (t) => {
  const runtime = await tempDir(t);
  const dir = join(runtime, "kapelle");
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, "daemon.json"), "null", { mode: 0o600 });

  const r = await spawnCli(
    t,
    ["daemon", "add", "/tmp"],
    "cli.ts",
    dirs(runtime),
  ).done;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no daemon is listening/);
});

// --- repos ----------------------------------------------------------------------

test("POST /repos registers the repository root, once, and GET /repos lists it", async (t) => {
  const root = await gitRepo(t, { files: { "pkg/file.txt": "x\n" } });
  const d = await boot(t);

  const sub = await api(d, "POST", "/repos", { path: join(root, "pkg") });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.root, await realpath(root));
  assert.equal((await api(d, "POST", "/repos", { path: root })).status, 200);

  assert.deepEqual((await api(d, "GET", "/repos")).body, [
    await realpath(root),
  ]);
});

test("POST /repos refuses a relative, missing or unignored path, and registers none", async (t) => {
  const d = await boot(t);

  const relative = await api(d, "POST", "/repos", { path: "src/app" });
  assert.equal(relative.status, 400);
  assert.match(relative.body.error, /absolute/);

  const missing = await api(d, "POST", "/repos", {
    path: join(await tempDir(t), "typo"),
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /does not exist/);

  const unignored = await api(d, "POST", "/repos", {
    path: await gitRepo(t, { ignore: "" }),
  });
  assert.equal(unignored.status, 409);
  assert.match(unignored.body.error, /is not ignored by git/);

  assert.deepEqual((await api(d, "GET", "/repos")).body, []);
});

test("POST /runs in a folder never added is 403, and starts nothing", async (t) => {
  const d = await boot(t);
  const r = await api(d, "POST", "/runs", {
    cwd: await tempDir(t),
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  assert.equal(r.status, 403);
  assert.match(r.body.error, /POST \/repos/);
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("an unadded repo with an unsafe .kapelle/ is still 403, by membership first", async (t) => {
  // The state-dir refusal is a 409 for repositories we own; for one never
  // added it must not pre-empt the 403 the story promises.
  const d = await boot(t);
  const cwd = await gitRepo(t, { ignore: "" });

  const r = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  assert.equal(r.status, 403);
  assert.match(r.body.error, /POST \/repos/);
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("an added repo that becomes unsafe is a 409 before the 202", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  await writeFile(join(cwd, ".gitignore"), "");
  assert.equal(spawnSync("git", ["add", "-A"], { cwd }).status, 0);
  assert.equal(
    spawnSync("git", ["commit", "-m", "drop the ignore"], { cwd }).status,
    0,
  );

  const r = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  assert.equal(r.status, 409);
  assert.match(r.body.error, /is not ignored by git/);
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

// --- POST /runs and GET ---------------------------------------------------------

test("POST /runs accepts a run, lists it with its folder, and reports it done", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));

  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202);

  const listed = await api<{ id: string; cwd: string }[]>(d, "GET", "/runs");
  assert.deepEqual(
    listed.body.map((r) => [r.id, r.cwd]),
    [[posted.body.id, await realpath(cwd)]],
  );

  const run = await settled(d, posted.body.id);
  assert.equal(run.status, "done");
  assert.equal(run.report.tasks[0]?.status, "done");
});

test("an invalid body is 400 in the validator's words, and creates no run", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));

  const noRun = await api(d, "POST", "/runs", { cwd });
  assert.equal(noRun.status, 400);

  const empty = await api(d, "POST", "/runs", { cwd, run: { tasks: [] } });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /non-empty "tasks" array/);

  const garbled = await fetch(`${d.url}/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${d.token}` },
    body: "{",
  });
  assert.equal(garbled.status, 400);

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("a dirty tree is 409 in the preflight's words, and creates no run", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  await writeFile(join(cwd, "wip.txt"), "uncommitted\n");

  const r = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /uncommitted changes/);
  assert.match(r.body.error, /wip\.txt/);

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("a subdirectory cwd runs inside its registered root, and the daemon writes nothing into the repo", async (t) => {
  // A root-anchored ignore: an unanchored `.kapelle/` would hide a file the
  // daemon wrongly left in `pkg/`, and let exactly that bug pass.
  const root = await gitRepo(t, {
    ignore: "/.kapelle/\n",
    files: { "pkg/file.txt": "committed\n" },
  });
  const d = await boot(t);
  const cwd = await added(d, join(root, "pkg"));

  const status = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--ignored"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(status.stdout, "");

  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error);
  // A worktree runs the result cross-check, and mock-agent reports
  // `ACP_TEST.md` from inside `pkg/`, so the run may promote to `warned`.
  // What this test owns is that nothing the daemon wrote failed it.
  assert.match((await settled(d, posted.body.id)).status, /^(done|warned)$/);

  // The pre-run status above cannot see what the run wrote. Without
  // `--ignored`, the daemon's own `.kapelle/` is allowed while an unanchored
  // `pkg/.kapelle/` would surface — which is the claim in the test name.
  const after = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(after.stdout, "");
});

test("a subdirectory run logs the workspace path it actually ran in", async (t) => {
  // M2-2's `_client_worktree_created.path` is the task's workspace, not the
  // checkout root: `Worktrees.info` must not leak its `Held.path` into the
  // event. `--cwd <root>/pkg` is the case where the two differ, and where the
  // silent spread used to overwrite `path: cwd`.
  const root = await gitRepo(t, {
    ignore: "/.kapelle/\n",
    files: { "pkg/file.txt": "committed\n" },
  });
  const d = await boot(t);
  const cwd = await added(d, join(root, "pkg"));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error);
  const id = posted.body.id as string;
  assert.match((await settled(d, id)).status, /^(done|warned)$/);

  const events = (
    await readFile(
      join(await realpath(root), ".kapelle", "runs", id, "events.jsonl"),
      "utf8",
    )
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const created = events.find(
    (e) => e.update.sessionUpdate === "_client_worktree_created",
  );
  assert.ok(created, "the worktree event landed in the log");
  assert.ok(
    created.update.path.endsWith(`${sep}one${sep}pkg`),
    `path is the workspace inside the checkout, got ${created.update.path}`,
  );
  assert.ok(
    created.update.path.includes(`${sep}.kapelle${sep}wt${sep}`),
    `path is inside the run's worktree, got ${created.update.path}`,
  );
  assert.equal(
    created.update.branch,
    `kapelle/${id}/one`,
    "the branch names the run and the task",
  );
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  assert.equal(created.update.baseSha, head, "the base sha is the clone point");
  const kinds = events.map((e) => e.update.sessionUpdate);
  const started = kinds.indexOf("_client_task_started");
  const worktree = kinds.indexOf("_client_worktree_created");
  const finished = kinds.indexOf("_client_task_finished");
  assert.ok(
    started !== -1 &&
      worktree !== -1 &&
      finished !== -1 &&
      started < worktree &&
      worktree < finished,
    `task boundaries are ordered started < worktree < finished: ${kinds.join(", ")}`,
  );
});

// --- DELETE /runs/:id, and what the record carries ------------------------------

test("DELETE cancels a live run, and refuses a settled or unknown one", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([
      { id: "stuck", prompt: "hi", cmd: `node ${MOCK_AGENT} --scenario stall` },
    ]),
  });
  const { id } = posted.body;

  // Cancel is cooperative, so the answer is an acknowledgement, not a verdict.
  const cancel = await api(d, "DELETE", `/runs/${id}`);
  assert.equal(cancel.status, 202);
  assert.equal(cancel.body.status, "running");
  assert.equal(cancel.body.cancelRequested, true);

  assert.equal((await settled(d, id)).status, "cancelled");
  assert.equal((await api(d, "DELETE", `/runs/${id}`)).status, 409);
  assert.equal((await api(d, "DELETE", "/runs/nope")).status, 404);
  assert.equal((await api(d, "GET", "/runs/nope")).status, 404);
});

test("containment notices reach the run record, where nothing drops them", async (t) => {
  // #13: these lines are never suppressed. A daemon has no terminal, so the
  // record is the only place a caller can still read them.
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }], { mode: "safe" }),
  });

  const { notices } = await settled(d, posted.body.id);
  const find = (re: RegExp) => notices.find((n) => re.test(n.text));
  assert.equal(find(/safe mode was not negotiated/)?.taskId, "one");
  assert.equal(find(/is not a git repository/)?.taskId, "run");
});

// --- GET /runs/:id/events, M2-2 -------------------------------------------------

interface Stream {
  status: number;
  frames: {
    id: number;
    data: {
      seq: number;
      agent: string;
      update: { sessionUpdate: string; status?: string };
    };
  }[];
  /** Resolves when the daemon ends the stream. */
  ended: Promise<void>;
}

/** Opens the SSE stream and parses frames as they arrive. */
async function stream(
  d: Daemon,
  id: string,
  lastEventId?: number | string,
): Promise<Stream> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${d.token}`,
  };
  if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
  const res = await fetch(`${d.url}/runs/${id}/events`, { headers });
  const out: Stream = {
    status: res.status,
    frames: [],
    ended: Promise.resolve(),
  };
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    return out;
  }
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const body = res.body.pipeThrough(new TextDecoderStream());
  out.ended = (async () => {
    let buffer = "";
    for await (const text of body) {
      buffer += text;
      for (
        let end = buffer.indexOf("\n\n");
        end !== -1;
        end = buffer.indexOf("\n\n")
      ) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const id = /^id: (\d+)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        out.frames.push({ id: Number(id), data: JSON.parse(data as string) });
      }
    }
  })();
  return out;
}

async function until(
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

test("a stream attached mid-run gets the history then the live tail, contiguously, as the log file has it", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun(
      [
        { id: "one", prompt: "hi" },
        {
          id: "stuck",
          prompt: "hi",
          cmd: `node ${MOCK_AGENT} --scenario stall`,
        },
      ],
      { maxConcurrency: 1 },
    ),
  });
  assert.equal(posted.status, 202, posted.body.error);
  const { id } = posted.body;

  const first = await stream(d, id);
  assert.equal(first.status, 200);
  const has = (s: Stream, agent: string, kind: string) =>
    s.frames.some(
      (f) => f.data.agent === agent && f.data.update.sessionUpdate === kind,
    );
  // Mid-run for certain: `one` is over and `stuck` never answers its prompt.
  await until(
    "the second task to start",
    () =>
      has(first, "one", "_client_task_finished") &&
      has(first, "stuck", "_client_task_started"),
  );
  const finished = first.frames.find(
    (f) =>
      f.data.agent === "one" &&
      f.data.update.sessionUpdate === "_client_task_finished",
  );
  assert.ok(finished, "the first task's verdict is logged");
  assert.ok(
    finished.data.update.status === "done" ||
      finished.data.update.status === "warned",
    `a non-cancelled task finished with ${String(finished.data.update.status)}`,
  );

  // A reconnect whose cursor is already the tail has no history to write, so
  // the 200 has to flush on its own. Without `flushHeaders` this fetch would
  // never resolve until the next event — and `stuck` never sends one. The
  // cursor is the last seq the first stream received, never the log file's
  // line count: bytes can be on disk before the write callback advances
  // `committed`, and a cursor past `log.size` is a 400.
  const tailStream = stream(d, id, first.frames.at(-1)?.id ?? 0);
  // If the timeout below wins, this still settles later; nothing may reject
  // unhandled just because the assertion already failed.
  void tailStream.then((s) => void s.ended.catch(() => {})).catch(() => {});
  let slow: ReturnType<typeof setTimeout> | undefined;
  const caught = await Promise.race([
    tailStream,
    new Promise<never>((_, fail) => {
      slow = setTimeout(
        () => fail(new Error("a caught-up stream never received its headers")),
        5_000,
      );
    }),
  ]).finally(() => clearTimeout(slow));
  assert.equal(caught.status, 200, "headers arrive before any event does");
  assert.deepEqual(caught.frames, [], "no history is replayed past the tail");

  const late = await stream(d, id);
  const resumed = await stream(d, id, 2);
  await until(
    "the late stream to catch up",
    () => late.frames.length >= first.frames.length,
  );
  assert.equal((await api(d, "DELETE", `/runs/${id}`)).status, 202);
  await Promise.all([first.ended, late.ended, resumed.ended, caught.ended]);

  const seqs = (s: Stream) => s.frames.map((f) => f.id);
  const n = first.frames.length;
  assert.deepEqual(
    seqs(first),
    Array.from({ length: n }, (_, i) => i + 1),
  );
  assert.deepEqual(late.frames, first.frames);
  assert.deepEqual(resumed.frames, first.frames.slice(2));
  assert.ok(
    has(first, "stuck", "_client_task_finished"),
    "the tail reached the end",
  );

  const file = await readFile(
    join(cwd, ".kapelle", "runs", id, "events.jsonl"),
    "utf8",
  );
  assert.deepEqual(
    file
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l)),
    first.frames.map((f) => f.data),
  );
});

test("events for an unknown run are 404, a bad Last-Event-ID is 400, and the token is required", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  const { id } = posted.body;
  await settled(d, id);

  const nope = await api<{ error: string }>(d, "GET", "/runs/nope/events");
  assert.equal(nope.status, 404);
  assert.match(nope.body.error, /no run nope/, "the 404 names the run");
  assert.equal(
    (await api(d, "GET", `/runs/${id}/events`, undefined, null)).status,
    401,
  );
  assert.equal(
    (await api(d, "GET", `/runs/${id}/events`, undefined, "0".repeat(64)))
      .status,
    401,
    "a wrong token is 401 on the events route too",
  );
  for (const bad of ["x", -1, 1.5, 100_000]) {
    assert.equal(
      (await stream(d, id, bad)).status,
      400,
      `Last-Event-ID ${bad}`,
    );
  }

  const done = await stream(d, id);
  await done.ended;
  assert.ok(done.frames.length > 0, "a settled run still replays, then ends");

  const fromZero = await stream(d, id, 0);
  await fromZero.ended;
  assert.deepEqual(
    fromZero.frames,
    done.frames,
    "Last-Event-ID: 0 is the full replay",
  );
});

test("a client that disconnects mid-run leaves no reader holding the log open", {
  skip: process.platform !== "linux" && "reads /proc/<pid>/fd",
}, async (t) => {
  // A reader is invisible over HTTP, but a reader that has touched the file
  // keeps it open until it detaches. With the writer that is two handles; a
  // reader left attached after its client left would keep the second until
  // the run ends — and this run never ends on its own.
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([
      { id: "stuck", prompt: "hi", cmd: `node ${MOCK_AGENT} --scenario stall` },
    ]),
  });
  const { id } = posted.body;
  const log = join(await realpath(cwd), ".kapelle", "runs", id, "events.jsonl");
  const handles = () => {
    const fds = join("/proc", String(d.pid), "fd");
    return readdirSync(fds).filter((fd) => {
      try {
        return readlinkSync(join(fds, fd)) === log;
      } catch {
        return false; // closed between the listing and the read
      }
    }).length;
  };
  await until("the writer to open the log", () => handles() === 1);

  // A reader opens the file only when the daemon already counts a committed
  // line. The bytes can be visible before the write callback advances
  // `committed`, so do not gate on the file: a stream that arrives at the tail
  // stays bell-driven, never opens the file, and `handles() === 2` never
  // arrives. Retry with fresh streams until one opens the file, cancelling
  // each abandoned stream so it leaves no reader behind.
  let client: AbortController | undefined;
  let res: Awaited<ReturnType<typeof fetch>> | undefined;
  for (let attempt = 0; attempt < 20 && handles() !== 2; attempt++) {
    client = new AbortController();
    res = await fetch(`${d.url}/runs/${id}/events`, {
      headers: { authorization: `Bearer ${d.token}` },
      signal: client.signal,
    });
    assert.equal(res.status, 200);
    await until("the reader to open the log", () => handles() === 2, 250).catch(
      () => {},
    );
    if (handles() === 2) break;
    client.abort();
    await res.body?.cancel().catch(() => {});
    await until("the reader to let go", () => handles() === 1, 5_000);
    client = undefined;
    res = undefined;
  }
  assert.ok(client, "a reader attached");
  assert.ok(res, "a reader attached and opened the log");
  await until("the reader to open the log", () => handles() === 2);

  client.abort();
  await res.body?.cancel().catch(() => {});
  await until("the reader to let go", () => handles() === 1);
  assert.equal((await api(d, "GET", `/runs/${id}`)).body.status, "running");

  await api(d, "DELETE", `/runs/${id}`);
  await settled(d, id);
});

// --- permissions over the API, M2-3 ---------------------------------------------

interface Pending {
  id: string;
  runId: string;
  taskId: string;
  kind: string;
  title: string;
}

/** A run file naming no mode: every registry entry defaults to `ask`, so this
 *  is the file people actually write. */
const askRun = (cwd: string) => ({
  cwd,
  run: { cmd: `node ${MOCK_AGENT}`, tasks: [{ id: "one", prompt: "hi" }] },
});

/** Polls `GET /permissions` until one decision is pending, and returns it. */
async function pendingOne(d: Daemon): Promise<Pending> {
  for (const end = Date.now() + 20_000; Date.now() < end; ) {
    const r = await api<Pending[]>(d, "GET", "/permissions");
    assert.equal(r.status, 200);
    const [found] = r.body;
    if (found) return found;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("no permission ever became pending");
}

test("an ask run with no client attached is denied at the timeout, and completes", async (t) => {
  const d = await boot(t, undefined, ["--permission-timeout", "2"]);
  const cwd = await added(d, await tempDir(t));

  const posted = await api(d, "POST", "/runs", askRun(cwd));
  assert.equal(posted.status, 202, posted.body.error);
  // Capture the first decision while it is still pending: with the 2 s timeout
  // it is still listed, and a late answer after the run must read as settled.
  const pending = await pendingOne(d);
  assert.equal(pending.runId, posted.body.id);
  assert.equal(pending.kind, "edit");

  const run = await settled(d, posted.body.id);
  assert.equal(run.status, "done");

  // The criterion names the file, not the stream: read events.jsonl directly.
  const events = (
    await readFile(
      join(
        await realpath(cwd),
        ".kapelle",
        "runs",
        posted.body.id,
        "events.jsonl",
      ),
      "utf8",
    )
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  // Only the queue emits `_client_permission_queued`, so this cannot pass on
  // the `safePolicy` fallback an unwired `askPolicy` would leave behind.
  assert.ok(
    events.some((e) => e.update.sessionUpdate === "_client_permission_queued"),
    "the queue announced the pending decision on the run bus",
  );
  const decisions = events
    .map((e) => e.update as { sessionUpdate: string; allow?: boolean })
    .filter((u) => u.sessionUpdate === "_client_permission");
  // The mock asks twice — the edit, then a delete with an allow-only menu.
  assert.deepEqual(
    decisions.map((u) => u.allow),
    [false, false],
  );

  // A timed-out decision is settled, not unknown: a late allow is 409.
  assert.equal(
    (await api(d, "POST", `/permissions/${pending.id}`, { allow: true }))
      .status,
    409,
  );
  await assert.rejects(stat(join(cwd, "ACP_TEST.md")));
  assert.deepEqual((await api(d, "GET", "/permissions")).body, []);
});

/** Boots with `env`, starts an ask run with no client, and returns it settled. */
async function unanswered(t: TestContext, env: Record<string, string>) {
  const d = await boot(t, await tempDir(t), [], undefined, env);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", askRun(cwd));
  assert.equal(posted.status, 202, posted.body.error);
  await pendingOne(d);
  return { cwd, run: await settled(d, posted.body.id) };
}

test("a user-config permission timeout settles an unanswered decision", async (t) => {
  const config = await tempDir(t);
  await mkdir(join(config, "kapelle"), { recursive: true });
  await writeFile(
    join(config, "kapelle", "config.json"),
    JSON.stringify({ permissionTimeoutMs: 1500 }),
  );

  // The default is 120 s; settling inside the 20 s poll can only mean the
  // user file's 1.5 s window was applied.
  const { cwd, run } = await unanswered(t, { XDG_CONFIG_HOME: config });
  assert.equal(run.status, "done");
  await assert.rejects(stat(join(cwd, "ACP_TEST.md")));
});

test("KAPELLE_PERMISSION_TIMEOUT_MS settles an unanswered decision", async (t) => {
  const { run } = await unanswered(t, {
    KAPELLE_PERMISSION_TIMEOUT_MS: "1500",
  });
  assert.equal(run.status, "done");
});

test("an answer lets the write happen; a second answer is 409, an unknown id 404, a bad body 400", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", askRun(cwd));
  assert.equal(posted.status, 202, posted.body.error);

  const pending = await pendingOne(d);
  assert.equal(pending.runId, posted.body.id);
  assert.equal(pending.taskId, "one");
  assert.equal(pending.kind, "edit");

  const path = `/permissions/${pending.id}`;
  assert.equal((await api(d, "POST", path, { allow: "yes" })).status, 400);
  assert.equal((await api(d, "POST", path, { allow: true })).status, 200);
  assert.equal((await api(d, "POST", path, { allow: false })).status, 409);
  assert.equal(
    (await api(d, "POST", "/permissions/nope", { allow: true })).status,
    404,
  );

  // The mock's second request, the allow-only delete; the queue is not
  // answered by the first decision's id.
  const next = await pendingOne(d);
  assert.notEqual(next.id, pending.id);
  assert.equal(next.kind, "delete");
  assert.equal(
    (await api(d, "POST", `/permissions/${next.id}`, { allow: false })).status,
    200,
  );

  assert.equal((await settled(d, posted.body.id)).status, "done");
  await stat(join(cwd, "ACP_TEST.md"));
});

test("cancelling a run denies its pending decision at once, not at the timeout", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", askRun(cwd));
  const pending = await pendingOne(d);

  assert.equal((await api(d, "DELETE", `/runs/${posted.body.id}`)).status, 202);
  // The default timeout is 120 s; `settled` gives up after 20.
  assert.equal((await settled(d, posted.body.id)).status, "cancelled");
  assert.deepEqual((await api(d, "GET", "/permissions")).body, []);
  assert.equal(
    (await api(d, "POST", `/permissions/${pending.id}`, { allow: true }))
      .status,
    409,
  );
});

test("a --permission-timeout that is not above 0 refuses to start", async (t) => {
  const r = await exitOf(
    start(t, await tempDir(t), ["--permission-timeout", "0"]),
  );
  assert.ok(r, "the daemon started anyway");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--permission-timeout/);
});

test("a --permission-timeout above Node's timer ceiling refuses to start", async (t) => {
  const over = await exitOf(
    start(t, await tempDir(t), ["--permission-timeout", "2147484"]),
  );
  assert.ok(over, "the daemon started anyway");
  assert.equal(over.code, 1);
  assert.match(over.stderr, /--permission-timeout/);

  // The last whole second below Node's 2^31-1 ms ceiling still boots.
  const d = await boot(t, undefined, ["--permission-timeout", "2147483"]);
  assert.ok(d.token);
});

test("a task the watchdog cuts drops its pending decision at once, while its siblings run", async (t) => {
  // The run-wide signal never fires here: the TTL cuts one task, the other
  // keeps the run alive. Without the per-task deny the entry would sit in
  // `GET /permissions` for the whole 120 s timeout.
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: {
      cmd: `node ${MOCK_AGENT}`,
      maxConcurrency: 2,
      tasks: [
        { id: "asker", prompt: "hi", ttlMs: 2_000 },
        {
          id: "busy",
          prompt: "hi",
          mode: "auto",
          cmd: `node ${MOCK_AGENT} --scenario stall`,
        },
      ],
    },
  });
  assert.equal(posted.status, 202, posted.body.error);

  const pending = await pendingOne(d);
  assert.equal(pending.taskId, "asker");
  await until("the cut task's decision to be denied", async () => {
    const r = await api<Pending[]>(d, "GET", "/permissions");
    return r.body.length === 0;
  });
  // Still running: this was the task's own TTL, not the run's cancel.
  assert.equal(
    (await api(d, "GET", `/runs/${posted.body.id}`)).body.status,
    "running",
  );
  assert.equal(
    (await api(d, "POST", `/permissions/${pending.id}`, { allow: true }))
      .status,
    409,
  );

  await api(d, "DELETE", `/runs/${posted.body.id}`);
  await settled(d, posted.body.id);
});

// --- across a restart (M2-6, #36) -------------------------------------------

test("a restarted daemon keeps its repositories and serves the runs from before", async (t) => {
  const runtime = await tempDir(t);
  // State outlives the runtime dir (a reboot), so keep them distinct: the
  // list must land in the state dir, not beside `daemon.json`.
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  const posted = await api(first, "POST", "/runs", {
    cwd: root,
    run: mockRun([{ id: "a", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error);
  const { id } = posted.body;
  assert.equal((await settled(first, id)).status, "done");

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // Same user-level directories, a new process: everything below comes off
  // the disk, since this daemon ran none of it.
  const second = await boot(t, runtime, [], state);
  assert.deepEqual((await api<string[]>(second, "GET", "/repos")).body, [root]);
  // Owner-only, same as daemon.json: the list names every repository the
  // daemon will run in.
  assert.equal(
    (await stat(join(state, "kapelle", "repos.json"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    existsSync(join(runtime, "kapelle", "repos.json")),
    false,
    "the list must not sit in the runtime dir",
  );
  assert.deepEqual((await api<Reply[]>(second, "GET", "/runs")).body, [
    { id, cwd: root, status: "done" },
  ]);

  const one = await api(second, "GET", `/runs/${id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(
    one.body.tasks?.map((task) => [task.id, task.status]),
    [["a", "done"]],
  );
  // The field M2-6 exists to carry: one session id, so `session/load` can be
  // picked up later without a migration. `String(undefined)` is `"undefined"`,
  // which matches a non-empty regex — assert the type, not its printout.
  const restoredSession = one.body.tasks?.[0]?.sessionId;
  assert.equal(typeof restoredSession, "string");
  assert.equal(restoredSession, "sess_mock_1");

  // And the log replays, although nothing is writing it: `createEventLog`
  // opens `flags: "w"`, so this has to come from the read-only open.
  const replay = await stream(second, id);
  assert.equal(replay.status, 200);
  await replay.ended;
  assert.ok(
    replay.frames.some(
      (f) => f.data.update.sessionUpdate === "_client_task_finished",
    ),
    "the restored stream should carry the task's end",
  );
  assert.deepEqual(
    replay.frames.map((f) => f.id),
    replay.frames.map((_, i) => i + 1),
  );

  // A cursor into the restored log resumes after it, and one past the end
  // gets the same 400 a live log gives.
  const resumed = await stream(second, id, 1);
  assert.equal(resumed.status, 200);
  await resumed.ended;
  assert.deepEqual(
    resumed.frames.map((f) => f.id),
    replay.frames.map((f) => f.id).filter((n) => n > 1),
  );
  const pastEnd = await stream(second, id, replay.frames.length + 1);
  assert.equal(pastEnd.status, 400);
});

test("a boot skips a record it cannot trust with a notice, and answers anyway", async (t) => {
  const runtime = await tempDir(t);
  const first = await boot(t, runtime);
  const root = await realpath(await added(first, await gitRepo(t)));
  // A second repository that never runs: no `.kapelle/runs/` is ever made
  // for it, which must boot quietly — nothing was skipped.
  const quiet = await realpath(await added(first, await gitRepo(t)));
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // One record truncated mid-write, one written by something else.
  const runs = join(root, ".kapelle", "runs");
  await mkdir(join(runs, "truncated"), { recursive: true });
  await writeFile(join(runs, "truncated", "run.json"), '{"runId": "trun');
  await mkdir(join(runs, "foreign"));
  await writeFile(
    join(runs, "foreign", "run.json"),
    JSON.stringify({ runId: "not-this-one", status: "done", tasks: [] }),
  );
  // A record still saying `running` is a crash: M2-5's sweep rewrites it to
  // `failed` before this daemon restores, so it is served, not skipped.
  await mkdir(join(runs, "live"));
  await writeFile(
    join(runs, "live", "run.json"),
    JSON.stringify({ runId: "live", status: "running", tasks: [] }),
  );
  // A run directory with no record at all, and a record with no status: both
  // are skipped with a notice.
  await mkdir(join(runs, "no-record"));
  await mkdir(join(runs, "no-status"));
  await writeFile(
    join(runs, "no-status", "run.json"),
    JSON.stringify({ runId: "no-status", tasks: [] }),
  );

  const second = await boot(t, runtime);
  const list = await api<Reply[]>(second, "GET", "/runs");
  assert.equal(list.status, 200);
  // `live` was left `running` and the sweep rewrote it terminal: the one run
  // served is the crashed one, and it reads `failed`.
  assert.deepEqual(list.body, [{ id: "live", cwd: root, status: "failed" }]);
  const live = await api(second, "GET", "/runs/live");
  assert.equal(live.status, 200);
  assert.equal(live.body.status, "failed");

  process.kill(second.pid, "SIGTERM");
  const out = await second.done;
  assert.equal(out.code, 0);
  assert.match(out.stderr, /skipping .*truncated.*run\.json/);
  assert.match(out.stderr, /skipping .*foreign.*run\.json/);
  assert.match(out.stderr, /skipping .*no-record.*run\.json/);
  assert.match(out.stderr, /skipping .*no-status.*run\.json/);
  assert.equal(
    out.stderr.includes(join(runs, "live")),
    false,
    "rewriting a crashed record is silent, not a notice",
  );
  assert.equal(
    out.stderr.includes(`skipping runs under ${quiet}`),
    false,
    "a repository that never ran has no records to skip",
  );
});

test("kill -9 then restart rewrites the run, keeps queued tasks queued, and keeps its worktree", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  const posted = await api(first, "POST", "/runs", {
    cwd: root,
    run: mockRun(
      [
        {
          id: "stuck",
          prompt: "hi",
          cmd: `node ${MOCK_AGENT} --scenario stall`,
        },
        { id: "waiting", prompt: "hi" },
      ],
      { maxConcurrency: 1 },
    ),
  });
  assert.equal(posted.status, 202, posted.body.error);
  const { id } = posted.body;

  // The harness is live once children.json names it with its recorded start
  // time, and the first task's record already reads `running`, so the kill
  // lands mid-turn with `waiting` still queued behind it.
  const childrenFile = join(runtime, "kapelle", "children.json");
  const recordPath = join(root, ".kapelle", "runs", id, "run.json");
  let harness = 0;
  let recordedStartedAt = "";
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    const children = await readFile(childrenFile, "utf8").catch(() => null);
    const record = await readFile(recordPath, "utf8").catch(() => null);
    if (children && record) {
      const [child] = JSON.parse(children).children;
      const tasks = JSON.parse(record).tasks;
      if (
        child?.taskId === "stuck" &&
        typeof child.startedAt === "string" &&
        tasks?.[0]?.status === "running"
      ) {
        harness = child.pid;
        recordedStartedAt = child.startedAt;
        break;
      }
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.ok(
    harness > 0,
    "children.json never named the harness with its identity",
  );
  t.after(() => {
    try {
      process.kill(harness, "SIGKILL");
    } catch {
      // Already gone: nothing left to kill.
    }
  });
  // Pins the daemon-side identity write: the kill test would still pass if
  // `daemon.ts` never recorded `startedAt`, since the harness dies on EOF.
  assert.equal(await processIdentity(harness), recordedStartedAt);

  const worktree = join(root, ".kapelle", "wt", id, "stuck");
  assert.equal(existsSync(worktree), true, "the run should own a worktree");

  process.kill(first.pid, "SIGKILL");
  await first.done;

  // Same runtime and state, a new process: everything below is the sweep's.
  const second = await boot(t, runtime, [], state);
  const restored = await api(second, "GET", `/runs/${id}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, "failed");
  assert.deepEqual(
    restored.body.tasks?.map((task) => [task.id, task.status]),
    [
      ["stuck", "failed"],
      ["waiting", "queued"],
    ],
  );
  const record = JSON.parse(
    await readFile(join(root, ".kapelle", "runs", id, "run.json"), "utf8"),
  );
  assert.equal(typeof record.endedAt, "string");
  assert.equal(existsSync(worktree), true, "a worktree inside retention stays");
  assert.equal(await gone(harness), true, "the harness outlived the restart");
  assert.equal(existsSync(childrenFile), false);

  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});

test("kill -9 with a harness that ignores stdin and SIGTERM: the next boot kills it", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  const posted = await api(first, "POST", "/runs", {
    cwd: root,
    run: mockRun([
      {
        id: "stuck",
        prompt: "hi",
        cmd: `node ${MOCK_AGENT} --scenario stubborn`,
      },
    ]),
  });
  assert.equal(posted.status, 202, posted.body.error);
  const { id } = posted.body;

  const childrenFile = join(runtime, "kapelle", "children.json");
  let harness = 0;
  t.after(() => {
    if (harness <= 0) return;
    try {
      process.kill(harness, "SIGKILL");
    } catch {
      // Already gone: nothing left to kill.
    }
  });
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    const record = await readFile(childrenFile, "utf8").catch(() => null);
    if (record) {
      const [child] = JSON.parse(record).children;
      if (child?.taskId === "stuck" && typeof child.startedAt === "string") {
        harness = child.pid;
        break;
      }
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.ok(harness > 0, "children.json never named the stubborn harness");
  assert.equal(alive(harness), true, "the harness should be alive");

  process.kill(first.pid, "SIGKILL");
  await first.done;
  // SIGKILL closes the daemon's end of the harness pipes. `stubborn` has a
  // live timer, so EOF alone must not end it.
  await new Promise((ok) => setTimeout(ok, 300));
  const harnessStderr = async (): Promise<string> =>
    (await readFile(
      join(root, ".kapelle", "runs", id, "stuck.stderr.log"),
      "utf8",
    ).catch(() => "")) || "(no stderr)";
  assert.equal(
    alive(harness),
    true,
    `stdin EOF alone must not end it; harness stderr: ${await harnessStderr()}`,
  );

  const second = await boot(t, runtime, [], state);
  assert.equal(
    await gone(harness),
    true,
    `the next boot must kill it; harness stderr: ${await harnessStderr()}`,
  );
  assert.equal(existsSync(childrenFile), false);
  const restored = await api(second, "GET", `/runs/${id}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, "failed");

  process.kill(second.pid, "SIGTERM");
  const out = await second.done;
  assert.equal(out.code, 0);
  assert.match(out.stderr, new RegExp(`killed harness pid ${harness}`));
});

test("a boot reaps expired runs in every added repository and serves the in-window one", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const rootA = await realpath(await added(first, await gitRepo(t)));
  const rootB = await realpath(await added(first, await gitRepo(t)));
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const OLD = "20260801-000000-olda";
  const OLD2 = "20260801-000001-oldb";
  const RECENT = "20260915-000000-recn";
  const since = Date.now();
  const expired = new Date(since - 40 * 24 * 60 * 60 * 1000).toISOString();
  const inWindow = new Date(since - 60_000).toISOString();
  const old = await directFinishedRun(rootA, OLD, expired);
  const recent = await directFinishedRun(rootA, RECENT, inWindow);
  const old2 = await directFinishedRun(rootB, OLD2, expired);

  const second = await boot(t, runtime, [], state);

  assert.equal(existsSync(old.worktree), false);
  assert.equal(existsSync(old.dir), false);
  assert.equal(hasBranch(rootA, old.branch), false);
  assert.equal(existsSync(old2.worktree), false);
  assert.equal(existsSync(old2.dir), false);
  assert.equal(hasBranch(rootB, old2.branch), false);
  assert.equal(existsSync(recent.worktree), true);
  assert.equal(existsSync(recent.dir), true);
  assert.equal(hasBranch(rootA, recent.branch), true);

  const list = await api<Reply[]>(second, "GET", "/runs");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((run) => run.id).sort(), [RECENT]);
  assert.equal((await api(second, "GET", `/runs/${OLD}`)).status, 404);
  const served = await api(second, "GET", `/runs/${RECENT}`);
  assert.equal(served.status, 200);
  assert.equal(served.body.status, "failed");

  process.kill(second.pid, "SIGTERM");
  const out = await second.done;
  assert.equal(out.code, 0);
  assert.ok(out.stderr.includes(`reaped run ${OLD}`));
  assert.ok(out.stderr.includes(`reaped run ${OLD2}`));
  assert.equal(out.stderr.includes(`reaped run ${RECENT}`), false);
});

test("boot reconciles record-less worktrees: clean removed, dirty kept and noticed", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const CLEAN = "20260915-000000-clna";
  const DIRTY = "20260915-000001-drtb";
  const { worktrees: cleanWt } = await openWorktrees(root, CLEAN);
  assert.ok(cleanWt, "the fixture repository should carry worktrees");
  const cleanPath = await cleanWt.acquire("a");
  const { worktrees: dirtyWt } = await openWorktrees(root, DIRTY);
  assert.ok(dirtyWt, "the fixture repository should carry worktrees");
  const dirtyPath = await dirtyWt.acquire("a");
  await writeFile(join(dirtyPath, "partial.txt"), "work\n");

  const second = await boot(t, runtime, [], state);

  assert.equal(existsSync(cleanPath), false, "the clean orphan is removed");
  assert.equal(hasBranch(root, `kapelle/${CLEAN}/a`), true);
  assert.equal(existsSync(dirtyPath), true, "the dirty orphan is kept");
  assert.equal(existsSync(join(dirtyPath, "partial.txt")), true);
  assert.deepEqual((await api(second, "GET", "/runs")).body, []);

  process.kill(second.pid, "SIGTERM");
  const out = await second.done;
  assert.equal(out.code, 0);
  assert.match(out.stderr, /removed orphan worktree/);
  assert.match(out.stderr, /uncommitted changes/);
});

test("a relative XDG_RUNTIME_DIR falls back to the temp dir, never the cwd", async (t) => {
  const tmp = await tempDir(t);
  const state = await tempDir(t);
  // `TMPDIR` so the fallback lands here and not in the developer's real
  // per-user directory, where it would meet their running daemon's lock.
  // A relative value used to be taken at face value, which put the **token**
  // under the daemon's cwd — this repository, for `kapelle daemon start`,
  // where `.gitignore` covers `.kapelle/` and not a stray `rel/`.
  const d = start(t, "rel/rt", [], state, { TMPDIR: tmp });
  const died = d.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([d.waitFor("listening on "), died]);
  died.catch(() => {});

  const fallback = join(tmp, `kapelle-${userInfo().uid}`, "daemon.json");
  assert.equal((await stat(fallback)).mode & 0o777, 0o600);
  assert.equal(
    existsSync(join(REPO, "rel")),
    false,
    "a relative runtime dir must not be taken at face value",
  );
});

test("an empty XDG_STATE_HOME falls back to ~/.local/state", async (t) => {
  const runtime = await tempDir(t);
  const home = await tempDir(t);
  // `XDG_STATE_HOME=""` is unset per the XDG spec. A nullish check would
  // instead resolve to a relative `./kapelle` beside the daemon's cwd.
  const d = await boot(t, runtime, [], runtime, {
    XDG_STATE_HOME: "",
    HOME: home,
  });
  const root = await realpath(await added(d, await gitRepo(t)));
  assert.deepEqual((await api<string[]>(d, "GET", "/repos")).body, [root]);

  const fallback = join(home, ".local", "state", "kapelle", "repos.json");
  assert.equal(
    (await stat(fallback)).mode & 0o777,
    0o600,
    "the repo list should land under $HOME/.local/state",
  );
  process.kill(d.pid, "SIGTERM");
  assert.equal((await d.done).code, 0);
});

test("a user-level config supplies the port when no flag does", async (t) => {
  const runtime = await tempDir(t);
  const config = await tempDir(t);
  await mkdir(join(config, "kapelle"), { recursive: true });
  await writeFile(
    join(config, "kapelle", "config.json"),
    JSON.stringify({ port: 0 }),
  );

  const d = spawnCli(t, [], "daemon.ts", {
    ...dirs(runtime),
    XDG_CONFIG_HOME: config,
  });
  await d.waitFor("listening on ");
  const { port } = JSON.parse(
    await readFile(join(runtime, "kapelle", "daemon.json"), "utf8"),
  );
  assert.ok(port > 0, "port 0 from the config should have bound an ephemeral");
  // daemon.ts's DEFAULT_PORT is 4719; a different port proves the file, not
  // the built-in default, supplied the value.
  assert.notEqual(port, 4719, "the config's port 0 must beat the 4719 default");
  d.child.kill("SIGTERM");
  assert.equal((await d.done).code, 0);
});

test("a --port flag still wins over the user config", async (t) => {
  const runtime = await tempDir(t);
  const config = await tempDir(t);
  await mkdir(join(config, "kapelle"), { recursive: true });
  // Port 1 would fail for a non-root process and succeed for root, so the
  // assertion is `not 1`: the flag's ephemeral bind is the only way either
  // process reaches a listening state without landing on the config's port.
  await writeFile(
    join(config, "kapelle", "config.json"),
    JSON.stringify({ port: 1 }),
  );
  const d = spawnCli(t, ["--port", "0"], "daemon.ts", {
    ...dirs(runtime),
    XDG_CONFIG_HOME: config,
  });
  await d.waitFor("listening on ");
  const { port } = JSON.parse(
    await readFile(join(runtime, "kapelle", "daemon.json"), "utf8"),
  );
  assert.notEqual(port, 1);
  d.child.kill("SIGTERM");
  assert.equal((await d.done).code, 0);
});

test("KAPELLE_PORT wins over the user config", async (t) => {
  const runtime = await tempDir(t);
  const config = await tempDir(t);
  await mkdir(join(config, "kapelle"), { recursive: true });
  // Port 1 fails for a non-root process; `not 1` also catches a root process
  // actually binding the user file's value instead of the env's ephemeral 0.
  await writeFile(
    join(config, "kapelle", "config.json"),
    JSON.stringify({ port: 1 }),
  );
  const d = spawnCli(t, [], "daemon.ts", {
    ...dirs(runtime),
    XDG_CONFIG_HOME: config,
    KAPELLE_PORT: "0",
  });
  await d.waitFor("listening on ");
  const { port } = JSON.parse(
    await readFile(join(runtime, "kapelle", "daemon.json"), "utf8"),
  );
  assert.notEqual(port, 1, "the env's port 0 must beat the user file's 1");
  d.child.kill("SIGTERM");
  assert.equal((await d.done).code, 0);
});

test("a --port flag wins over KAPELLE_PORT", async (t) => {
  const runtime = await tempDir(t);
  const d = spawnCli(t, ["--port", "0"], "daemon.ts", {
    ...dirs(runtime),
    KAPELLE_PORT: "1",
  });
  await d.waitFor("listening on ");
  const { port } = JSON.parse(
    await readFile(join(runtime, "kapelle", "daemon.json"), "utf8"),
  );
  assert.notEqual(port, 1, "the flag's port 0 must beat the env's 1");
  d.child.kill("SIGTERM");
  assert.equal((await d.done).code, 0);
});

test("a bad user config refuses the start, naming the key", async (t) => {
  const runtime = await tempDir(t);
  const config = await tempDir(t);
  await mkdir(join(config, "kapelle"), { recursive: true });
  await writeFile(
    join(config, "kapelle", "config.json"),
    JSON.stringify({ port: "soon" }),
  );
  const d = spawnCli(t, [], "daemon.ts", {
    ...dirs(runtime),
    XDG_CONFIG_HOME: config,
  });
  const exit = await exitOf(d);
  assert.ok(exit, "the daemon should have refused to start");
  assert.equal(exit.code, 1);
  assert.match(exit.stderr, /"port" must be a whole number/);
});

test("a bad KAPELLE_* value refuses the start", async (t) => {
  const runtime = await tempDir(t);
  const d = spawnCli(t, ["--port", "0"], "daemon.ts", {
    ...dirs(runtime),
    KAPELLE_TTL_MS: "soon",
  });
  const exit = await exitOf(d);
  assert.ok(exit, "the daemon should have refused to start");
  assert.equal(exit.code, 1);
  assert.match(exit.stderr, /KAPELLE_TTL_MS must be a number/);
});

test("an unknown KAPELLE_* name warns but does not stop the start", async (t) => {
  const runtime = await tempDir(t);
  const d = spawnCli(t, ["--port", "0"], "daemon.ts", {
    ...dirs(runtime),
    KAPELLE_NOT_A_KNOB: "1",
  });
  await d.waitFor("listening on ");
  d.child.kill("SIGTERM");
  const result = await d.done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /KAPELLE_NOT_A_KNOB/);
});

test("a bad project config is refused at add, and the daemon keeps serving", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  await mkdir(join(root, ".kapelle"), { recursive: true });
  await writeFile(
    join(root, ".kapelle", "config.json"),
    JSON.stringify({ stallIdle: 1 }),
  );

  const refused = await api(d, "POST", "/repos", { path: root });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /unknown key "stallIdle"/);

  const list = await api<unknown[]>(d, "GET", "/repos");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
});

test("a project config is re-read per run, and its error is the run's 400", async (t) => {
  const d = await boot(t);
  const root = await added(d, await gitRepo(t));
  await mkdir(join(root, ".kapelle"), { recursive: true });
  await writeFile(
    join(root, ".kapelle", "config.json"),
    JSON.stringify({ ttlMs: "soon" }),
  );

  const refused = await api(d, "POST", "/runs", {
    cwd: root,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /"ttlMs" must be a whole number/);
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
      { id: "a", prompt: "hi" },
      { id: "b", prompt: "hi" },
    ]),
  );
  await settled(d, id);

  const r = await spawnCli(t, ["attach", id, "--task", "b"], "cli.ts", env)
    .done;
  assert.equal(r.code, 0, r.stderr);
  // Drawn by `render.ts`, tagged by task: b's tool calls and prose, none of a's.
  assert.match(r.stdout, /\[b\].*Read package\.json/);
  assert.match(r.stdout, /Reading package\.json via the client/);
  assert.doesNotMatch(r.stdout, /\[a\]|▸ a /);
  assert.match(r.stdout, /▸ b \(mock-agent\) done/);
  assert.match(r.stdout, /done — 1 task/);
  // The prose is drawn once, live, not again on the card.
  assert.equal(r.stdout.split("Reading package.json via").length - 1, 1);

  const none = await spawnCli(t, ["attach", id, "--task", "zz"], "cli.ts", env)
    .done;
  assert.equal(none.code, 1);
  // The run-level notice still prints first: it concerns every task.
  assert.match(none.stderr, new RegExp(`error: run ${id} has no task zz\n$`));
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
}, async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);
  const d = await boot(t, runtime, ["--permission-timeout", "3"]);
  const cwd = await added(d, await tempDir(t));
  const id = await detach(t, env, cwd, askRun(cwd).run);

  const child = spawn(
    "script",
    ["-qfec", `${process.execPath} cli.ts attach ${id}`, "/dev/null"],
    { cwd: REPO, env: { ...process.env, ...env } },
  );
  t.after(() => void child.kill("SIGKILL"));
  let out = "";
  let asked = 0;
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    out += text;
    const now = out.split("allow? [y/N]").length - 1;
    // The edit is answered 4 s after it is asked: past its 3 s timeout, and
    // inside the delete's, which is queued only once the edit is denied. So
    // the run is still live when the late answer lands, and the delete is
    // answered at once.
    for (; asked < now; asked++) {
      const late = asked === 0;
      setTimeout(
        () => child.stdin.write(late ? "y\n" : "n\n"),
        late ? 4000 : 0,
      );
    }
  });

  assert.equal(await new Promise((ok) => child.on("close", ok)), 0, out);
  assert.match(out, /error: permission \S+ was already decided/);
  assert.match(out, /done — 1 task/);
  // The timeout's deny stands: the late "y" wrote nothing.
  await assert.rejects(stat(join(cwd, "ACP_TEST.md")));
});
