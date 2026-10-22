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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test, { type TestContext } from "node:test";
import {
  type Outcome,
  parseCommand,
  type RouteCommand,
  runCommand,
} from "../client/command.ts";
import {
  API_VERSION,
  type Diff,
  type HarnessEntry,
  type MessageAccepted,
  type ParticipantDto,
  type PermissionDecision,
  type RoomDto,
  type RoomEventLine,
  type RoomListEntry,
} from "../client/contract.ts";
import type { Named } from "../client/mention.ts";
import { stateDirFor } from "../core/runtime.ts";
import { processIdentity } from "../core/sweep.ts";
import { openWorktrees } from "../core/worktree.ts";
import {
  addRepo as added,
  bootDaemon as boot,
  type CliResult,
  type Daemon,
  daemonApi,
  useDaemonDirs as dirs,
  gitRepo,
  HOSTILE_AGENT,
  MOCK_AGENT,
  REPO,
  runCli,
  spawnCli,
  startDaemon as start,
  tempDir,
} from "../integration/helpers.ts";
import { AGENTS } from "../protocol/registry.ts";

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
async function api<T = Reply>(
  d: Daemon,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = d.token,
): Promise<{ status: number; body: T }> {
  return daemonApi<T>(d, method, path, body, token);
}

const mockRun = (
  tasks: Record<string, unknown>[],
  rest: Record<string, unknown> = {},
) => ({ cmd: `node ${MOCK_AGENT}`, mode: "auto", ...rest, tasks });

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
  const dir = join(stateDirFor(root), "runs", id);
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
  const identity = JSON.parse(await readFile(`${d.file}.identity`, "utf8")) as {
    pid?: unknown;
    startedAt?: unknown;
  };
  assert.equal(identity.pid, d.pid);
  assert.equal(typeof identity.startedAt, "string");
  assert.equal((await stat(`${d.file}.identity`)).mode & 0o777, 0o600);
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

test("a pid 0 record is replaced, not obeyed", async (t) => {
  // `process.kill(0, 0)` targets the process group and answers true, so a
  // 0 pid must be rejected before `alive` or it wedges every start.
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: 0, port: 1, token: "stale" }),
    { mode: 0o600 },
  );

  const d = await boot(t, runtime);
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
  assert.equal(posted.status, 202, posted.body.error?.message);
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
      // S14's shape: one file for runs and rooms, told apart by `kind`.
      assert.equal(child.kind, "run");
      assert.equal(child.ownerId, posted.body.id);
      assert.equal(child.unitId, "stuck");
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
      readFile(`${d.file}.identity`),
      "the identity is removed with daemon.json",
    );
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

test("kapelle daemon add prints the daemon's refusal message, not an object", async (t) => {
  const runtime = await tempDir(t);
  const env = dirs(runtime);

  const daemon = spawnCli(t, ["daemon", "start", "--port", "0"], "cli.ts", env);
  const died = daemon.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([daemon.waitFor("listening on "), died]);
  died.catch(() => {});

  // A missing path is refused by the daemon with a `{error:{code,message}}`
  // envelope; the CLI must print `error.message`, not stringify `error`
  // (M5-3, #135).
  const missing = join(await tempDir(t), "typo");
  const refused = await spawnCli(t, ["daemon", "add", missing], "cli.ts", env)
    .done;
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /does not exist/);
  assert.doesNotMatch(refused.stderr, /\[object Object\]/);
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

test("kapelle daemon stop sends SIGTERM, waits, and removes the record", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);

  const stop = await spawnCli(t, ["daemon", "stop"], "cli.ts", dirs(runtime))
    .done;
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(stop.stdout.trim(), `stopped the daemon (pid ${d.pid})`);
  assert.equal((await d.done).code, 0);
  await assert.rejects(readFile(d.file), "daemon.json is removed");
});

test("kapelle daemon stop with no daemon says so and exits 0", async (t) => {
  const runtime = await tempDir(t);

  const stop = await spawnCli(t, ["daemon", "stop"], "cli.ts", dirs(runtime))
    .done;

  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(stop.stdout.trim(), "no daemon is running");
});

test("kapelle daemon stop clears a stale record without claiming a stop", async (t) => {
  const runtime = await tempDir(t);
  const dir = join(runtime, "kapelle");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  assert.ok(dead !== undefined);
  const file = join(dir, "daemon.json");
  await writeFile(
    file,
    JSON.stringify({ pid: dead, port: 1, token: "stale" }),
    { mode: 0o600 },
  );

  const stop = await spawnCli(t, ["daemon", "stop"], "cli.ts", dirs(runtime))
    .done;

  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(stop.stdout.trim(), "no daemon is running");
  await assert.rejects(readFile(file), "the stale record is removed");
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

test("POST /repos refuses a relative or missing path, and registers none", async (t) => {
  const d = await boot(t);

  const relative = await api(d, "POST", "/repos", { path: "src/app" });
  assert.equal(relative.status, 400);
  assert.match(relative.body.error.message, /absolute/);

  const missing = await api(d, "POST", "/repos", {
    path: join(await tempDir(t), "typo"),
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error.message, /does not exist/);

  assert.deepEqual((await api(d, "GET", "/repos")).body, []);
});

// #129: `.kapelle/` used to have to be gitignored, on pain of a 409. It no
// longer holds any state the daemon writes, so both an untracked and a
// tracked `.kapelle/` are accepted.
test("POST /repos accepts a repository whose .kapelle/ is untracked", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  await mkdir(join(root, ".kapelle"), { recursive: true });
  // A file inside, so git can actually see the directory: an empty one is
  // invisible and would make this test's name a proxy.
  await writeFile(join(root, ".kapelle", "notes.txt"), "untracked\n");

  const res = await api(d, "POST", "/repos", { path: root });

  assert.equal(res.status, 200);
  assert.deepEqual((await api(d, "GET", "/repos")).body, [
    await realpath(root),
  ]);
});

test("POST /repos accepts a repository with a tracked .kapelle/config.json", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t, { files: { ".kapelle/config.json": "{}\n" } });

  const res = await api(d, "POST", "/repos", { path: root });

  assert.equal(res.status, 200);
  assert.deepEqual((await api(d, "GET", "/repos")).body, [
    await realpath(root),
  ]);
});

test("POST /runs in a folder never added is 403, and starts nothing", async (t) => {
  const d = await boot(t);
  const r = await api(d, "POST", "/runs", {
    cwd: await tempDir(t),
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "repo_not_added");
  assert.match(r.body.error.message, /POST \/repos/);
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

// Membership before validation: a never-added folder must not leak whether
// its run body would have passed the validator (#129 scoping — "both
// handlers' remaining refusal order is asserted").
test("POST /runs checks membership before the run body: 403, not 400", async (t) => {
  const d = await boot(t);
  const r = await api(d, "POST", "/runs", {
    cwd: await tempDir(t),
    run: { tasks: [] },
  });

  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /POST \/repos/);
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
  assert.equal(run.tasks[0]?.status, "done");
});

test("an invalid body is 400 in the validator's words, and creates no run", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));

  const noRun = await api(d, "POST", "/runs", { cwd });
  assert.equal(noRun.status, 400);

  const empty = await api(d, "POST", "/runs", { cwd, run: { tasks: [] } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, "invalid_run");
  assert.match(empty.body.error.message, /non-empty "tasks" array/);

  const garbled = await fetch(`${d.url}/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.token}`,
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(garbled.status, 400);
  assert.equal(((await garbled.json()) as Reply).error.code, "invalid_request");

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

// --- Idempotency-Key on POST /runs (M5-7, #139) ---------------------------------

/** `POST /runs` with an `Idempotency-Key`. */
async function postKeyed(
  d: Daemon,
  key: string,
  body: unknown,
  type = "application/json",
) {
  const res = await fetch(`${d.url}/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.token}`,
      "content-type": type,
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Reply };
}

test("one key and one body start one run; a different body is a conflict", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const body = { cwd, run: mockRun([{ id: "one", prompt: "hi" }]) };

  const first = await postKeyed(d, "key-1", body);
  assert.equal(first.status, 202);
  const again = await postKeyed(d, "key-1", body);
  assert.deepEqual(again, first);
  // The same fields in another order, at every depth, are the same body.
  const reordered = {
    run: {
      tasks: [{ prompt: "hi", id: "one" }],
      mode: "auto",
      cmd: body.run.cmd,
    },
    cwd,
  };
  assert.deepEqual(await postKeyed(d, "key-1", reordered), first);

  const other = { cwd, run: mockRun([{ id: "two", prompt: "hi" }]) };
  const conflict = await postKeyed(d, "key-1", other);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "idempotency_conflict");
  // A conflict leaves the key bound to its first run.
  assert.deepEqual(await postKeyed(d, "key-1", body), first);

  // The order of items in a list does matter: swapped tasks are another body.
  const two = [
    { id: "a", prompt: "hi" },
    { id: "b", prompt: "hi" },
  ];
  const pair = await postKeyed(d, "key-list", { cwd, run: mockRun(two) });
  assert.equal(pair.status, 202);
  const swapped = await postKeyed(d, "key-list", {
    cwd,
    run: mockRun(two.toReversed()),
  });
  assert.equal(swapped.status, 409);
  assert.equal(swapped.body.error.code, "idempotency_conflict");

  // No key: a second run, as before.
  assert.equal((await api(d, "POST", "/runs", body)).status, 202);
  const listed = await api<Reply[]>(d, "GET", "/runs");
  assert.equal(listed.body.length, 3);
  await settled(d, first.body.id);
  await settled(d, pair.body.id);
});

test("a refused request frees its key; a malformed key is 400", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));

  const refused = await postKeyed(d, "key-2", { cwd, run: { tasks: [] } });
  assert.equal(refused.body.error.code, "invalid_run");
  const fixed = await postKeyed(d, "key-2", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(fixed.status, 202);

  // "a, b" is what Node makes of a header sent twice; fetch cannot send one.
  for (const bad of ["has space", "x".repeat(256), "a, b"]) {
    const r = await postKeyed(d, bad, { cwd, run: mockRun([]) });
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error.code, "invalid_request");
  }
  await settled(d, fixed.body.id);
});

test("a retry while the first request has not answered is 409 in progress", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const body = JSON.stringify({
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  // The first request sends half its body and waits, so it holds the key.
  const { port } = new URL(d.url);
  let answer: (r: { status: number; body: string }) => void = () => {};
  const firstDone = new Promise<{ status: number; body: string }>((ok) => {
    answer = ok;
  });
  const first = request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/runs",
      headers: {
        authorization: `Bearer ${d.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "idempotency-key": "key-3",
      },
    },
    (res) => {
      let text = "";
      res.on("data", (c) => {
        text += c;
      });
      res.on("end", () => answer({ status: res.statusCode ?? 0, body: text }));
    },
  );
  first.write(body.slice(0, 10));
  await new Promise((ok) => first.once("socket", (s) => s.once("connect", ok)));

  // Poll until the daemon holds the first request's key. The poll is sent as
  // text/plain: a poll that arrives first is refused 415 before its body is
  // read, so it frees the key in the same turn of the event loop, and the
  // first request can never find it taken.
  let busy: Awaited<ReturnType<typeof postKeyed>> | undefined;
  for (const until = Date.now() + 5_000; Date.now() < until; ) {
    busy = await postKeyed(d, "key-3", {}, "text/plain");
    if (busy.status === 409) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(busy?.status, 409);
  assert.equal(busy?.body.error.code, "idempotency_in_progress");

  first.end(body.slice(10));
  const done = await firstDone;
  assert.equal(done.status, 202);
  const { id } = JSON.parse(done.body) as { id: string };
  assert.deepEqual(await postKeyed(d, "key-3", JSON.parse(body)), {
    status: 202,
    body: { id },
  });
  assert.equal((await api<Reply[]>(d, "GET", "/runs")).body.length, 1);
  await settled(d, id);
});

test("a dirty tree runs, and says so on the record (#129)", async (t) => {
  // It used to be a 409. The operator working alongside their own agents is
  // the normal case, and the daemon has no terminal to print a notice on, so
  // the advisory goes on the run record instead.
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  await writeFile(join(cwd, "wip.txt"), "uncommitted\n");

  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });

  assert.equal(posted.status, 202, posted.body.error?.message);
  const done = await settled(d, posted.body.id);
  assert.match(done.status, /^(done|warned)$/);
  assert.ok(
    (done.notices as { text: string }[]).some((n) =>
      /1 uncommitted file .* will not reach any task/.test(n.text),
    ),
    `no dirty-tree advisory in ${JSON.stringify(done.notices)}`,
  );
  // And the operator's own work is still there, untouched.
  assert.equal(await readFile(join(cwd, "wip.txt"), "utf8"), "uncommitted\n");
});

test("a subdirectory cwd runs inside its registered root, and the daemon writes nothing into the repo", async (t) => {
  // No ignore rule at all, so a file the daemon wrongly left in `pkg/` has
  // nowhere to hide (#129).
  const root = await gitRepo(t, {
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
  assert.equal(posted.status, 202, posted.body.error?.message);
  // A worktree runs the result cross-check, and mock-agent reports
  // `ACP_TEST.md` from inside `pkg/`, so the run may promote to `warned`.
  // What this test owns is that nothing the daemon wrote failed it.
  assert.match((await settled(d, posted.body.id)).status, /^(done|warned)$/);

  // The pre-run status above cannot see what the run wrote. Since #129 the
  // daemon writes nothing here at all, so a clean status is the whole claim.
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
    files: { "pkg/file.txt": "committed\n" },
  });
  const d = await boot(t);
  const cwd = await added(d, join(root, "pkg"));
  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const id = posted.body.id as string;
  assert.match((await settled(d, id)).status, /^(done|warned)$/);

  const events = (
    await readFile(join(stateDirFor(root), "runs", id, "events.jsonl"), "utf8")
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
    created.update.path.includes(`${sep}wt${sep}`),
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
  const again = await api(d, "DELETE", `/runs/${id}`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "run_ended");
  const gone = await api(d, "DELETE", "/runs/nope");
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, "run_not_found");
  assert.equal((await api(d, "GET", "/runs/nope")).status, 404);
});

test("GET /runs and kapelle ps list a live run's tasks, then its verdict", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", {
    cwd,
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
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;
  type Listed = { id: string; status: string; tasks: Reply["tasks"] }[];
  const tasksOf = async () =>
    (await api<Listed>(d, "GET", "/runs")).body.find((r) => r.id === id)?.tasks;

  // `runRun` hands over the queued list before the 202 is sent, so the first
  // listing already names both tasks. The ordering itself is pinned in
  // core/tests/run.test.ts; over HTTP the first persist usually wins anyway.
  assert.deepEqual(
    (await tasksOf())?.map((task) => task.id),
    ["stuck", "waiting"],
  );

  // Live: one task running, the other still queued behind it.
  const live = [
    { id: "stuck", status: "running" },
    { id: "waiting", status: "queued" },
  ];
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    if (JSON.stringify(await tasksOf()) === JSON.stringify(live)) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.deepEqual(await tasksOf(), live);

  const env = { XDG_RUNTIME_DIR: join(d.file, "..", "..") };
  const ps = await spawnCli(t, ["ps"], "cli.ts", env).done;
  assert.equal(ps.code, 0, ps.stderr);
  assert.match(ps.stdout, new RegExp(`^${id}  running  `, "m"));
  assert.match(ps.stdout, /^ {2}stuck {2}running$/m);
  assert.match(ps.stdout, /^ {2}waiting {2}queued$/m);

  // Finished: the run's status is its verdict, and every task has one.
  await api(d, "DELETE", `/runs/${id}`);
  assert.equal((await settled(d, id)).status, "cancelled");
  const after = await spawnCli(t, ["ps"], "cli.ts", env).done;
  assert.equal(after.code, 0, after.stderr);
  assert.match(after.stdout, new RegExp(`^${id}  cancelled  `, "m"));
  assert.match(after.stdout, /^ {2}stuck {2}cancelled$/m);
  assert.match(after.stdout, /^ {2}waiting {2}cancelled$/m);
});

test("kapelle ps with no daemon exits 1 and says so", async (t) => {
  const r = await spawnCli(t, ["ps"], "cli.ts", dirs(await tempDir(t))).done;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no daemon is listening/);
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
        // A `: ping` block (M5-6) has no data and is no event.
        if (data === undefined) continue;
        out.frames.push({ id: Number(id), data: JSON.parse(data) });
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
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;

  const first = await stream(d, id);
  assert.equal(first.status, 200);
  const has = (s: Stream, agent: string, kind: string) =>
    s.frames.some(
      (f) => f.data.agent === agent && f.data.update.sessionUpdate === kind,
    );
  // Mid-run for certain: `one` is over and `stuck` never answers its prompt.
  // Wait for the spawn, not the start: `_client_task_started` comes before the
  // harness is spawned, and a spawn line that lands after the tail cursor was
  // read reaches the caught-up stream below as a live event (CI, #172).
  await until(
    "the second task's harness to spawn",
    () =>
      has(first, "one", "_client_task_finished") &&
      has(first, "stuck", "_client_harness_spawned"),
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
    join(stateDirFor(cwd), "runs", id, "events.jsonl"),
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

test("a stream-only client learns the run is over and its status, live and after a restart", async (t) => {
  // M5-5 (#137): `_client_run_finished` is the last frame, and a `GET` sent
  // after it has arrived already agrees with it — never `running`.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const cwd = await added(first, await tempDir(t));
  const posted = await api(first, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;

  const live = await stream(first, id);
  const isEnd = (f: Stream["frames"][number]) =>
    f.data.update.sessionUpdate === "_client_run_finished";
  await until("the run's last event", () => live.frames.some(isEnd));
  const got = await api(first, "GET", `/runs/${id}`);
  await live.ended;
  const end = live.frames.at(-1);
  assert.ok(end && isEnd(end), "the run's event is the last frame");
  assert.equal(end.data.agent, "");
  assert.equal(got.body.status, end.data.update.status);
  assert.equal(got.body.turns, 1);
  assert.equal(live.frames.filter(isEnd).length, 1);
  for (const f of live.frames) {
    const at = (f.data as { at?: unknown }).at;
    assert.equal(typeof at, "string", "every frame has at");
    assert.equal(new Date(at as string).toISOString(), at);
  }

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = await boot(t, runtime, [], state);
  const replay = await stream(second, id);
  await replay.ended;
  assert.deepEqual(replay.frames, live.frames, "a replay ends the same way");
  // The restart half must prove the criterion at the source too: a GET after
  // the replayed event agrees with that event's status.
  const replayEnd = replay.frames.at(-1);
  assert.ok(replayEnd && isEnd(replayEnd), "the replayed run event is last");
  const replayed = await api(second, "GET", `/runs/${id}`);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.status, replayEnd?.data.update.status);
});

test("a run that fails before its log exists answers no_event_log, and GET still has the status", async (t) => {
  // M5-5 (#137): `openWorktrees` runs before the run's log is created
  // (core/run.ts:381, :426), so a pre-flight failure leaves no stream at all.
  // The events route answers `no_event_log` while `GET /runs/:id` settles
  // `failed` — the real fallback, not a stream that ends with the event.
  const d = await boot(t);
  const root = await gitRepo(t);
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  await writeFile(join(root, gitDir, "index"), "not an index\n");
  const cwd = await added(d, root);

  const posted = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  // The 202 is sent before the async failure lands, so the client is told the
  // run exists and must ask for its status.
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;

  const settledRun = await settled(d, id);
  assert.equal(settledRun.status, "failed");

  const events = await api(d, "GET", `/runs/${id}/events`);
  assert.equal(events.status, 404);
  assert.equal(events.body.error.code, "no_event_log");
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

  const nope = await api(d, "GET", "/runs/nope/events");
  assert.equal(nope.status, 404);
  assert.equal(nope.body.error.code, "run_not_found");
  assert.match(nope.body.error.message, /no run nope/, "the 404 names the run");
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
    const r = await fetch(`${d.url}/runs/${id}/events`, {
      headers: {
        authorization: `Bearer ${d.token}`,
        "last-event-id": String(bad),
      },
    });
    assert.equal(r.status, 400, `Last-Event-ID ${bad}`);
    const refused = (await r.json()) as Reply;
    assert.equal(refused.error.code, "invalid_request", `Last-Event-ID ${bad}`);
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

test("a restored run whose event log is gone answers no_event_log", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await realpath(await added(first, await gitRepo(t)));
  const posted = await api(first, "POST", "/runs", {
    cwd: root,
    run: mockRun([{ id: "a", prompt: "hi" }]),
  });
  const { id } = posted.body;
  await settled(first, id);

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // The record survives the restart, the log does not: the run exists, but
  // there is nothing to stream and the code must say so rather than 404 the
  // run itself.
  await rm(join(stateDirFor(root), "runs", id, "events.jsonl"));

  const second = await boot(t, runtime, [], state);
  const events = await api(second, "GET", `/runs/${id}/events`);
  assert.equal(events.status, 404);
  assert.equal(events.body.error.code, "no_event_log");
});

test("a non-refusal error is a 500 internal, never a leaked code", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  await writeFile(join(root, gitDir, "index"), "not an index\n");
  const cwd = await added(d, root);

  // `openWorktrees` runs `git status`, which now throws an execFile error
  // whose own numeric `code` must not reach the envelope (M5-3, #135).
  const r = await api(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}` }],
  });
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, "internal");
  assert.equal(typeof r.body.error.code, "string");
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
  const log = join(stateDirFor(cwd), "runs", id, "events.jsonl");
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
  assert.equal(posted.status, 202, posted.body.error?.message);
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
      join(stateDirFor(cwd), "runs", posted.body.id, "events.jsonl"),
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

  // M2-9: a replay carries every decision the run ever queued, and this run
  // settled both at the timeout. `attach` must not re-ask them: without the
  // `GET /permissions` guard this prints the wait line for both, and on a TTY
  // it would sit at a prompt for a decision the daemon settled long ago.
  const attached = await spawnCli(t, ["attach", posted.body.id], "cli.ts", {
    XDG_RUNTIME_DIR: join(d.file, "..", ".."),
  }).done;
  assert.equal(attached.code, 0, attached.stderr);
  assert.match(attached.stdout, /▸ one \(mock-agent\) done/);
  assert.doesNotMatch(attached.stderr, /waiting on/);
});

/** Boots with `env`, starts an ask run with no client, and returns it settled. */
async function unanswered(t: TestContext, env: Record<string, string>) {
  const d = await boot(t, await tempDir(t), [], undefined, env);
  const cwd = await added(d, await tempDir(t));
  const posted = await api(d, "POST", "/runs", askRun(cwd));
  assert.equal(posted.status, 202, posted.body.error?.message);
  await pendingOne(d);
  return { cwd, run: await settled(d, posted.body.id) };
}

test("a user-config permission timeout settles an unanswered decision", async (t) => {
  const config = await tempDir(t);
  await mkdir(join(config, "kapelle"), { recursive: true });
  // 0o644, not the umask's default: a group-writable config is refused
  // (core/config.ts), and umask 0002 would make one.
  await writeFile(
    join(config, "kapelle", "config.json"),
    JSON.stringify({ permissionTimeoutMs: 1500 }),
    { mode: 0o644 },
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
  assert.equal(posted.status, 202, posted.body.error?.message);

  const pending = await pendingOne(d);
  assert.equal(pending.runId, posted.body.id);
  assert.equal(pending.taskId, "one");
  assert.equal(pending.kind, "edit");

  const path = `/permissions/${pending.id}`;
  assert.equal((await api(d, "POST", path, { allow: "yes" })).status, 400);
  assert.equal((await api(d, "POST", path, { allow: true })).status, 200);
  const second = await api(d, "POST", path, { allow: false });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "already_decided");
  const unknown = await api(d, "POST", "/permissions/nope", { allow: true });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "permission_not_found");

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

// --- M5-4, #136: two clients agree on which question closed, and why ---------

/** The reasons one stream gave for the decisions it saw close, by id. */
function reasonsIn(s: Stream): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { data } of s.frames) {
    const u = data.update as {
      sessionUpdate: string;
      id?: string;
      reason?: string;
    };
    if (u.sessionUpdate === "_client_permission_answered") {
      out[u.id as string] = u.reason as string;
    }
  }
  return out;
}

for (const [how, args, close] of [
  ["the timeout", ["--permission-timeout", "2"], async () => {}],
  [
    "a DELETE",
    [],
    async (d: Daemon, id: string) => {
      assert.equal((await api(d, "DELETE", `/runs/${id}`)).status, 202);
    },
  ],
] as const) {
  const reason = how === "the timeout" ? "timeout" : "cancel";
  test(`two stream readers attribute ${how} to the same id and reason, and GET /permissions/:id agrees`, async (t) => {
    const d = await boot(t, undefined, [...args]);
    const cwd = await added(d, await tempDir(t));
    const posted = await api(d, "POST", "/runs", askRun(cwd));
    assert.equal(posted.status, 202, posted.body.error?.message);
    const pending = await pendingOne(d);

    const open = await api(d, "GET", `/permissions/${pending.id}`);
    assert.equal(open.status, 200);
    assert.deepEqual(open.body, pending, "open: exactly as the list shows it");

    const [a, b] = [
      await stream(d, posted.body.id),
      await stream(d, posted.body.id),
    ];
    await close(d, posted.body.id);
    await settled(d, posted.body.id);
    await Promise.all([a.ended, b.ended]);

    const seen = reasonsIn(a);
    assert.equal(seen[pending.id], reason);
    assert.deepEqual(reasonsIn(b), seen, "both clients saw the same closes");

    const done = await api(d, "GET", `/permissions/${pending.id}`);
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { ...pending, allow: false, reason });
    const unknown = await api(d, "GET", "/permissions/nope");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "permission_not_found");
  });
}

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
  assert.equal(posted.status, 202, posted.body.error?.message);

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
  assert.equal(posted.status, 202, posted.body.error?.message);
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
  const listed = (await api<Reply[]>(second, "GET", "/runs")).body;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, id);
  assert.equal(listed[0]?.cwd, root);
  assert.equal(listed[0]?.root, root);
  assert.equal(listed[0]?.status, "done");
  assert.equal(listed[0]?.source, "restored");
  // The record fills these (M5-2); the list keeps its tasks slim.
  assert.equal(typeof listed[0]?.startedAt, "string");
  assert.equal(typeof listed[0]?.endedAt, "string");
  assert.deepEqual(
    listed[0]?.tasks.map((task) => [task.id, task.status]),
    [["a", "done"]],
  );

  const one = await api(second, "GET", `/runs/${id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(
    one.body.tasks.map((task) => [task.id, task.status]),
    [["a", "done"]],
  );
  // The fields the extended record carries (M5-2, D2): the card's header
  // and elapsed time survive the restart.
  assert.equal(typeof one.body.tasks[0]?.agent, "string");
  assert.equal(typeof one.body.tasks[0]?.durationMs, "number");
  // The field M2-6 exists to carry: one session id, so `session/load` can be
  // picked up later without a migration. `String(undefined)` is `"undefined"`,
  // which matches a non-empty regex — assert the type, not its printout.
  const restoredSession = one.body.tasks[0]?.sessionId;
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
  // A second repository that never runs: no run directory is ever made
  // under its workspace, which must boot quietly — nothing was skipped.
  const quiet = await realpath(await added(first, await gitRepo(t)));
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // One record truncated mid-write, one written by something else.
  const runs = join(stateDirFor(root), "runs");
  await mkdir(join(runs, "truncated"), { recursive: true });
  await writeFile(join(runs, "truncated", "run.json"), '{"runId": "trun');
  await mkdir(join(runs, "foreign"));
  await writeFile(
    join(runs, "foreign", "run.json"),
    JSON.stringify({ runId: "not-this-one", status: "done", tasks: [] }),
  );
  // A record still saying `running` is a crash: M2-5's sweep rewrites it to
  // `killed` before this daemon restores, so it is served, not skipped.
  await mkdir(join(runs, "live"));
  await writeFile(
    join(runs, "live", "run.json"),
    JSON.stringify({ runId: "live", status: "running", tasks: [] }),
  );
  // A trusted record whose `tasks` array holds junk: the run is served with
  // the bad element dropped, because the route destructures every element and
  // one `[null]` would otherwise 500 the whole list.
  await mkdir(join(runs, "corrupt-tasks"));
  await writeFile(
    join(runs, "corrupt-tasks", "run.json"),
    JSON.stringify({
      runId: "corrupt-tasks",
      status: "done",
      tasks: [
        null,
        { foo: "bar" },
        // A key the contract does not name must not reach the wire (#160),
        // and nor does a named key with the wrong type: `"warnings": 5`
        // crashed `attach`'s `printTask`, and a malformed `usage` is rebuilt
        // from the contract's keys or dropped (M5-2).
        {
          id: "ok",
          status: "done",
          note: "hand-edited",
          agent: 7,
          durationMs: "3",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            _task: "ok",
            evil: true,
          },
          usageSemantics: "sometimes",
          summarySynthesised: "yes",
          warnings: [null, 5, { kind: "k", text: "t", extra: 1 }],
        },
        {
          id: "bad-usage",
          status: "done",
          usage: { inputTokens: "many", outputTokens: 2, totalTokens: 3 },
        },
        { id: "bad-warnings", status: "done", warnings: 5 },
        // Every entry is junk: the field stays omitted rather than serving `[]`.
        { id: "junk-warnings", status: "done", warnings: [null, 5] },
      ],
    }),
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
  // `live` was left `running` and the sweep rewrote it terminal: it reads
  // `killed` (M5-5). `corrupt-tasks` is trusted for its runId/status, so it is
  // served too, with the junk element dropped. Sorted: restore order is
  // readdir order, which is not part of the contract.
  const rows = [...list.body].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    rows.map((row) => [row.id, row.cwd, row.root, row.status, row.source]),
    [
      ["corrupt-tasks", root, root, "done", "restored"],
      ["live", root, root, "killed", "restored"],
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.tasks),
    [
      [
        { id: "ok", status: "done" },
        { id: "bad-usage", status: "done" },
        { id: "bad-warnings", status: "done" },
        { id: "junk-warnings", status: "done" },
      ],
      [],
    ],
  );
  // The sweep rewrote `live`, so it carries the `endedAt` it wrote (M2-5);
  // the hand-made record has neither timestamp, so both are omitted.
  assert.equal(typeof rows[1]?.endedAt, "string");
  assert.equal(rows[0]?.startedAt, undefined);
  const live = await api(second, "GET", "/runs/live");
  assert.equal(live.status, 200);
  assert.equal(live.body.status, "killed");
  const corrupt = await api(second, "GET", "/runs/corrupt-tasks");
  assert.deepEqual(corrupt.body.tasks, [
    {
      id: "ok",
      status: "done",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      warnings: [{ kind: "k", text: "t" }],
    },
    { id: "bad-usage", status: "done" },
    { id: "bad-warnings", status: "done" },
    { id: "junk-warnings", status: "done" },
  ]);

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
  assert.equal(posted.status, 202, posted.body.error?.message);
  const { id } = posted.body;

  // The harness is live once children.json names it with its recorded start
  // time, and the first task's record already reads `running`, so the kill
  // lands mid-turn with `waiting` still queued behind it.
  const childrenFile = join(runtime, "kapelle", "children.json");
  const recordPath = join(stateDirFor(root), "runs", id, "run.json");
  let harness = 0;
  let recordedStartedAt = "";
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    const children = await readFile(childrenFile, "utf8").catch(() => null);
    const record = await readFile(recordPath, "utf8").catch(() => null);
    if (children && record) {
      const [child] = JSON.parse(children).children;
      const tasks = JSON.parse(record).tasks;
      if (
        child?.unitId === "stuck" &&
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

  const worktree = join(stateDirFor(root), "wt", id, "stuck");
  assert.equal(existsSync(worktree), true, "the run should own a worktree");

  process.kill(first.pid, "SIGKILL");
  await first.done;

  // Same runtime and state, a new process: everything below is the sweep's.
  const second = await boot(t, runtime, [], state);
  const restored = await api(second, "GET", `/runs/${id}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.status, "killed");
  assert.deepEqual(
    restored.body.tasks.map((task) => [task.id, task.status]),
    [
      ["stuck", "killed"],
      ["waiting", "queued"],
    ],
  );
  const record = JSON.parse(
    await readFile(join(stateDirFor(root), "runs", id, "run.json"), "utf8"),
  );
  assert.equal(typeof record.endedAt, "string");
  // M5-5: the sweep writes no `_client_run_finished` the run never wrote.
  const replay = await stream(second, id);
  await replay.ended;
  assert.ok(replay.frames.length > 0, "the log still replays");
  assert.ok(
    !replay.frames.some(
      (f) => f.data.update.sessionUpdate === "_client_run_finished",
    ),
  );
  assert.equal(existsSync(worktree), true, "a worktree inside retention stays");
  assert.equal(await gone(harness), true, "the harness outlived the restart");
  assert.equal(existsSync(childrenFile), false);

  // M2-9: the partial log carries no `_client_task_finished`, so `attach`
  // must reconcile with the record `restoreRuns` built. The regression: it
  // printed only `stuck` and said `done — 1 task`, exit 0, for a crashed run.
  const attachEnv = dirs(runtime, state);
  const attached = await spawnCli(t, ["attach", id], "cli.ts", attachEnv).done;
  assert.equal(attached.code, 1, attached.stderr);
  assert.match(attached.stdout, /stuck \([^)]*\) killed/);
  assert.match(attached.stdout, /waiting \([^)]*\) queued/);
  assert.doesNotMatch(attached.stdout, /\bdone\b/);
  assert.match(attached.stdout, /killed — 2 tasks/);
  // `--quiet` keeps the run's verdict even when card lines were printed: a
  // `killed` card and a `queued` one do not say the run itself was killed.
  const quiet = await spawnCli(
    t,
    ["attach", id, "--quiet"],
    "cli.ts",
    attachEnv,
  ).done;
  assert.equal(quiet.code, 1, quiet.stderr);
  assert.match(quiet.stderr, /error: \[stuck\] killed/);
  assert.match(quiet.stderr, new RegExp(`error: run ${id} killed`));

  const oneTask = await spawnCli(
    t,
    ["attach", id, "--task", "waiting"],
    "cli.ts",
    attachEnv,
  ).done;
  assert.equal(oneTask.code, 1, oneTask.stderr);
  assert.match(oneTask.stdout, /waiting \([^)]*\) queued/);
  // `--task` keeps the card's own word in the summary, never `failed` (#170).
  assert.match(oneTask.stdout, /queued — 1 task/);
  const stuckTask = await spawnCli(
    t,
    ["attach", id, "--task", "stuck"],
    "cli.ts",
    attachEnv,
  ).done;
  assert.equal(stuckTask.code, 1, stuckTask.stderr);
  assert.match(stuckTask.stdout, /stuck \([^)]*\) killed/);
  assert.match(stuckTask.stdout, /killed — 1 task/);

  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
});

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
  assert.equal(posted.status, 202, posted.body.error?.message);
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
      if (child?.unitId === "stuck" && typeof child.startedAt === "string") {
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
      join(stateDirFor(root), "runs", id, "stuck.stderr.log"),
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
  assert.equal(restored.body.status, "killed");

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
  // where a checkout could commit a stray `rel/`.
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
    { mode: 0o644 },
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
    { mode: 0o644 },
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
    { mode: 0o644 },
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
    { mode: 0o644 },
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
    { mode: 0o644 },
  );

  const refused = await api(d, "POST", "/repos", { path: root });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "invalid_config");
  assert.match(refused.body.error.message, /unknown key "stallIdle"/);

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
    { mode: 0o644 },
  );

  const refused = await api(d, "POST", "/runs", {
    cwd: root,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(refused.status, 400);
  // The config's code, not the run file's: the fix is in the repository.
  assert.equal(refused.body.error.code, "invalid_config");
  assert.match(refused.body.error.message, /"ttlMs" must be a whole number/);
});

test("a tracked linkPaths entry is refused at add, naming the entry", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t, {
    files: {
      ".kapelle/config.json": `${JSON.stringify({ linkPaths: ["README.md"] })}\n`,
    },
  });

  const refused = await api(d, "POST", "/repos", { path: root });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "invalid_config");
  assert.match(
    refused.body.error.message,
    /"linkPaths\[0\]" is tracked by git/,
  );
  assert.match(
    refused.body.error.message,
    new RegExp(join(root, ".kapelle", "config.json")),
  );
});

test("a linkPaths entry tracked after add refuses the run's 400", async (t) => {
  const d = await boot(t);
  const root = await added(d, await gitRepo(t));
  await mkdir(join(root, ".kapelle"), { recursive: true });
  await writeFile(
    join(root, ".kapelle", "config.json"),
    JSON.stringify({ linkPaths: ["README.md"] }),
    { mode: 0o644 },
  );

  const refused = await api(d, "POST", "/runs", {
    cwd: root,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "invalid_config");
  assert.match(refused.body.error.message, /tracked by git/);
});

test("a bad run body is invalid_run before a bad linkPaths is invalid_config", async (t) => {
  const d = await boot(t);
  const root = await added(d, await gitRepo(t));
  await mkdir(join(root, ".kapelle"), { recursive: true });
  await writeFile(
    join(root, ".kapelle", "config.json"),
    JSON.stringify({ linkPaths: ["README.md"] }),
    { mode: 0o644 },
  );

  const refused = await api(d, "POST", "/runs", { cwd: root, run: {} });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "invalid_run");
});

test("a linkPaths entry tracked after add refuses a room's open", async (t) => {
  const d = await boot(t);
  const root = await added(d, await gitRepo(t));
  await mkdir(join(root, ".kapelle"), { recursive: true });
  await writeFile(
    join(root, ".kapelle", "config.json"),
    JSON.stringify({ linkPaths: ["README.md"] }),
    { mode: 0o644 },
  );

  const refused = await api(d, "POST", "/rooms", { cwd: root });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "invalid_config");
  assert.match(refused.body.error.message, /tracked by git/);
});

test("a room opened over HTTP gets the configured links", async (t) => {
  const d = await boot(t);
  const root = await added(
    d,
    await gitRepo(t, {
      ignore: "node_modules/\n",
      files: {
        ".kapelle/config.json": `${JSON.stringify({ linkPaths: ["node_modules"] })}\n`,
      },
    }),
  );
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "module\n");

  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd: root,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "alice" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const alice = open.body.participants[0];
  assert.ok(alice);
  assert.equal(
    (await lstat(join(alice.worktree, "node_modules"))).isDirectory(),
    true,
  );
  assert.equal(
    (await lstat(join(alice.worktree, "node_modules", "pkg"))).isSymbolicLink(),
    true,
  );
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

// --- chat rooms (chat MVP) ------------------------------------------------------

const REMEMBER = `node ${MOCK_AGENT} --scenario remember`;

interface RoomReply extends RoomDto {
  error: { code: string; message: string };
}

/** A `POST /rooms` body with one orchestrator running `cmd`. */
const withAgent = (cwd: string, cmd: string) => ({
  cwd,
  agents: [{ cmd, role: "orchestrator" }],
});

/** The room's one participant. */
const only = (room: RoomDto): ParticipantDto => {
  assert.equal(room.participants.length, 1);
  return room.participants[0] as ParticipantDto;
};

/** Polls `GET /rooms/:id` until its participant is no longer `busy`. */
async function roomIdle(d: Daemon, id: string): Promise<RoomReply> {
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
async function commitAt(worktree: string, file: string) {
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
const headAt = (worktree: string) =>
  spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  }).stdout.trim();

/** Every event of a room, read from its SSE stream, or of one participant
 *  when `agentId` is given. Only call once the room is dismissed: the stream
 *  ends only when its log closes. */
async function roomEvents(
  d: Daemon,
  id: string,
  agentId?: string,
): Promise<
  (Omit<RoomEventLine, "update"> & { update: Record<string, unknown> })[]
> {
  const path = agentId ? `agents/${agentId}/events` : "events";
  const res = await fetch(`${d.url}/rooms/${id}/${path}`, {
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(res.status, 200);
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

test("a room keeps one harness and its context across messages, until it is dismissed", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));

  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  assert.equal(open.body.status, "active");
  assert.equal(only(open.body).status, "idle");
  const { id } = open.body;
  const { worktree } = only(open.body);
  // The participant's own checkout, named by the room id (S9) and its own id
  // (M6-6a), in the repository's workspace under `stateDirFor(root)` rather
  // than inside the repository itself (#129).
  assert.match(
    worktree,
    /\/wt\/room-\d{8}-\d{6}-[0-9a-z]{4}\/p-[0-9a-z]{8}$/,
    "the participant has its own checkout",
  );
  assert.ok(
    !worktree.startsWith(cwd),
    `the checkout is outside the repository, got ${worktree}`,
  );

  for (const text of ["alpha", "beta"]) {
    const r = await api<RoomReply>(d, "POST", `/rooms/${id}/messages`, {
      text,
    });
    assert.equal(r.status, 202, r.body.error?.message);
    await roomIdle(d, id);
  }

  const gone = await api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`);
  assert.equal(gone.status, 200, gone.body.error?.message);
  assert.equal(gone.body.status, "dismissed");
  assert.equal(only(gone.body).status, "dismissed");

  const events = await roomEvents(d, id);
  // M5-5 (#137): a room's log carries `at` too, but no run terminal event —
  // rooms get the timestamp and no `_client_run_finished` (C6).
  for (const e of events) {
    assert.equal(typeof e.at, "string", "every room event has at");
    assert.equal(new Date(e.at as string).toISOString(), e.at);
    assert.notEqual(e.update.sessionUpdate, "_client_run_finished");
  }
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.deepEqual(
    of("_client_user_message").map((e) => e.update.text),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    of("agent_message_chunk").map(
      (e) => (e.update.content as { text: string }).text,
    ),
    ["previous: (none)", "previous: alpha"],
    "the second turn saw the first: one session, context kept",
  );
  assert.deepEqual(
    of("_client_turn_ended").map((e) => e.update.stopReason),
    ["end_turn", "end_turn"],
  );
  assert.equal(
    of("_client_harness_spawned").length,
    1,
    "one harness for both turns",
  );
  assert.equal(of("_client_harness_exited").length, 1, "dismiss stopped it");

  const late = await api<RoomReply>(d, "POST", `/rooms/${id}/messages`, {
    text: "gamma",
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "room_dismissed");
  const again = await api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "room_dismissed");
});

test("dismissing a room commits nothing and leaves the checkout (R37)", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);

  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const { worktree: workspace, id: participantId } = only(open.body);
  const base = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();

  // Stand in for a participant that worked and did not commit. R37 says the
  // supervisor never commits for it — not at close, not ever.
  await writeFile(join(workspace, "draft.txt"), "half a thought\n");

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);

  // The checkout is still there, with the work still uncommitted in it, and
  // the branch has not moved. The spike released as `done`, which committed
  // `draft.txt` under our name and deleted the directory it was in.
  assert.ok(
    existsSync(join(workspace, "draft.txt")),
    "the work is still there",
  );
  assert.equal(
    spawnSync(
      "git",
      ["rev-parse", `refs/heads/kapelle/${id}/${participantId}`],
      { cwd: root, encoding: "utf8" },
    ).stdout.trim(),
    base,
    "the participant's branch is still at the base commit",
  );
});

test("two dismissals racing both wait for the one teardown, and both get 200", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));

  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;

  // S6(a): a dismissal answers only once the harness has stopped and the
  // checkout is released. `status()` reads `dismissed` the instant a
  // dismiss begins, so keying the 409 on it told the second caller the room was
  // already dismissed while the harness was still alive.
  const [first, second] = await Promise.all([
    api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`),
    api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`),
  ]);
  assert.equal(first.status, 200, first.body.error?.message);
  assert.equal(second.status, 200, second.body.error?.message);

  // Both waited for the same teardown, so the harness is gone by now.
  const events = await roomEvents(d, id);
  assert.equal(
    events.filter((e) => e.update.sessionUpdate === "_client_harness_exited")
      .length,
    1,
    "one harness, stopped once",
  );

  // A dismissal that arrives after the teardown has settled is a 409.
  assert.equal(
    (await api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`)).status,
    409,
  );
});

test("a release that fails is reported and the room is still dismissed, not a 500 (R37)", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);

  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const workspace = only(open.body).worktree;

  // A locked worktree makes `git worktree remove --force` fail — the sweep
  // suite relies on the same trick — so `release` throws on this untouched
  // checkout. The room still has to be dismissed, the failure has to be visible, and
  // the daemon must not be left unable to shut down.
  assert.equal(
    spawnSync("git", ["worktree", "lock", workspace], { cwd: root }).status,
    0,
  );
  t.after(() => {
    spawnSync("git", ["worktree", "unlock", workspace], { cwd: root });
  });

  const gone = await api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`);
  assert.equal(gone.status, 200, gone.body.error?.message);
  assert.equal(gone.body.status, "dismissed");
  assert.equal(only(gone.body).status, "dismissed");
  assert.ok(
    only(gone.body).notices.some((n) =>
      /could not release the participant's checkout/.test(n.text),
    ),
    `release failure not reported: ${JSON.stringify(only(gone.body).notices)}`,
  );

  // A rejected teardown used to escape `shutdown()`'s `Promise.all`, leaving
  // `daemon.json` behind and skipping `process.exit(0)`.
  process.kill(d.pid, "SIGTERM");
  const r = await d.done;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(d.file), false, "daemon.json is removed on shutdown");
});

test("chat.ts reports a daemon that went away instead of a dismissal, and exits non-zero", {
  // The screen waits 30 s for the daemon to come back (M6-7d).
  timeout: 60_000,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));

  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  await c.waitFor("type a message");

  // A daemon that goes away ends the SSE stream, the same wire shape a
  // dismissal has. The client must reconcile with `GET /rooms/:id` instead of
  // reporting a dismissal that never happened.
  process.kill(d.pid, "SIGKILL");
  const r = await c.done;

  assert.notEqual(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /the room was dismissed/);
  assert.match(r.stderr, /lost the daemon|lost the room stream/);
});

test("chat.ts new prints the daemon's refusal message, not an object", async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const unadded = await tempDir(t);

  // The daemon refuses an unadded cwd with `{error:{code,message}}`; the chat
  // front end must show `error.message`, not stringify the object (M5-3,
  // #135).
  const refused = await spawnCli(
    t,
    ["new", "--cmd", REMEMBER, "--cwd", unadded],
    "chat.ts",
    { XDG_RUNTIME_DIR: runtime },
  ).done;
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /has not been added to the daemon/);
  assert.doesNotMatch(refused.stderr, /\[object Object\]/);
});

test("chat.ts in a removed folder says so, and still lists rooms", async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  // A child cannot start in a removed folder, so `sh` goes in, removes it,
  // then runs chat.ts there.
  const run = async (...args: string[]) =>
    spawnSync(
      "sh",
      [
        "-c",
        'cd "$1" && rmdir "$1" && shift && exec "$@"',
        "sh",
        await tempDir(t),
        process.execPath,
        join(REPO, "chat.ts"),
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env, XDG_RUNTIME_DIR: runtime } },
    );

  const made = await run("new", "--cmd", REMEMBER);
  assert.equal(made.status, 1, made.stderr);
  assert.match(made.stderr, /the current folder was removed/);
  assert.doesNotMatch(made.stderr, /uv_cwd/);

  const listed = await run("list");
  assert.equal(listed.status, 0, listed.stderr);
});

test("chat.ts names the status for a refusal with no JSON envelope", async (t) => {
  // Node's own 408 has an empty body, and a body of `null` is JSON with no
  // `error`: both used to print "error: undefined" or "not JSON".
  for (const body of ["", "null"]) {
    // `GET /version` is answered, so the refusal under test is the room's.
    const fake = createServer((req, res) => {
      if (req.url === "/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ apiVersion: API_VERSION }));
        return;
      }
      res.writeHead(408, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
    t.after(() => fake.close());
    const runtime = await tempDir(t);
    await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
    const { port } = fake.address() as AddressInfo;
    await writeFile(
      join(runtime, "kapelle", "daemon.json"),
      JSON.stringify({ pid: process.pid, port, token: "t" }),
      { mode: 0o600 },
    );
    const r = await spawnCli(t, ["attach", "room-x"], "chat.ts", {
      XDG_RUNTIME_DIR: runtime,
    }).done;
    assert.equal(r.code, 1, r.stderr);
    assert.equal(
      r.stderr.trim(),
      "error: HTTP 408",
      `body ${JSON.stringify(body)}`,
    );
  }
});

/** A reply to a message, or its refusal. */
type MessageReply = MessageAccepted & RoomReply;

test("a busy participant queues 16 messages, refuses the seventeenth with 429, and a cancel drops them", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario stall`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const to = `/rooms/${id}/agents/${only(open.body).id}`;
  const say = (text: string) =>
    api<MessageReply>(d, "POST", `${to}/messages`, { text });

  const live = await say("live");
  assert.equal(live.status, 202, live.body.error?.message);
  assert.equal(live.body.queued, 0);
  for (let i = 1; i <= 16; i++) {
    const r = await say(`wait ${i}`);
    assert.equal(r.status, 202, r.body.error?.message);
    assert.equal(r.body.queued, i, "the live turn and the ones before");
  }
  const full = await say("one too many");
  assert.equal(full.status, 429);
  assert.equal(full.body.error.code, "queue_full");

  const cancel = await api<RoomReply>(d, "POST", `${to}/turns/current/cancel`);
  assert.equal(cancel.status, 202, cancel.body.error?.message);
  await roomIdle(d, id);
  const none = await api<RoomReply>(d, "POST", `${to}/turns/current/cancel`);
  assert.equal(none.status, 409);
  assert.equal(none.body.error.code, "no_turn");
  assert.equal(
    (await api<RoomReply>(d, "GET", `/rooms/${id}`)).body.status,
    "active",
    "a cancel is not a dismiss",
  );
  // The session stays: the same harness takes the next message.
  assert.equal((await say("next")).body.queued, 0);

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const events = await roomEvents(d, id);
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.equal(of("_client_message_queued").length, 16);
  assert.deepEqual(
    of("_client_queue_cleared").map((e) => e.update.count),
    [16],
  );
  assert.deepEqual(
    of("_client_user_message").map((e) => e.update.text),
    ["live", "next"],
  );
  assert.equal(of("_client_turn_ended").length, 2, "dismiss ended the second");
  assert.equal(of("_client_harness_spawned").length, 1);
});

test("messages to a busy participant are answered in order, and a cancel keeps its memory", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario slow`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const to = `/rooms/${id}/agents/${only(open.body).id}`;
  const say = async (text: string) =>
    (await api<MessageReply>(d, "POST", `${to}/messages`, { text })).body;

  // Each `slow` turn lasts a second, so b and c arrive while a runs.
  const queued = [];
  for (const text of ["a", "b", "c"]) queued.push((await say(text)).queued);
  assert.deepEqual(queued, [0, 1, 2]);
  await roomIdle(d, id);
  await say("d");
  assert.equal(
    (await api(d, "POST", `${to}/turns/current/cancel`)).status,
    202,
  );
  await roomIdle(d, id);
  await say("e");
  await roomIdle(d, id);

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const events = await roomEvents(d, id);
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.deepEqual(
    of("_client_user_message").map((e) => e.update.text),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(
    of("agent_message_chunk").map(
      (e) => (e.update.content as { text: string }).text,
    ),
    ["previous: (none)", "previous: a", "previous: b", "previous: d"],
    "in order, on one session, and the cancelled turn is remembered",
  );
  assert.deepEqual(
    of("_client_turn_ended").map((e) => e.update.stopReason),
    ["end_turn", "end_turn", "end_turn", "cancelled", "end_turn"],
  );
});

test("a message from the orchestrator names it: on the log, and as the harness's first line", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "po", role: "orchestrator" },
      { cmd: `node ${MOCK_AGENT} --scenario slow`, name: "dev" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const [po, dev] = open.body.participants.map((p) => p.id) as [string, string];
  const say = (to: string, text: string, from?: string) =>
    api<MessageReply>(d, "POST", `/rooms/${id}/agents/${to}/messages`, {
      text,
      ...(from && { from }),
    });

  for (const [to, from] of [
    [po, dev],
    [dev, dev],
    [dev, "p-nobody"],
    [po, po],
  ] as const) {
    const r = await say(to, "no", from);
    assert.equal(r.status, 400, `${from} → ${to}`);
    assert.equal(r.body.error.code, "invalid_sender");
  }
  const wide = await api<RoomReply>(d, "POST", `/rooms/${id}/messages`, {
    text: "no",
    from: po,
  });
  assert.equal(wide.status, 400);
  assert.equal(wide.body.error.code, "invalid_request");
  assert.match(wide.body.error.message, /unknown field "from"/);
  const typed = await api<MessageReply>(
    d,
    "POST",
    `/rooms/${id}/agents/${dev}/messages`,
    { text: "no", from: 5 },
  );
  assert.equal(typed.status, 400);
  assert.equal(typed.body.error.code, "invalid_request");

  // Each `slow` turn lasts a second, so b and c queue behind a.
  const queued = [];
  for (const [text, from] of [
    ["a", po],
    ["b", undefined],
    ["c", po],
  ] as const) {
    const r = await say(dev, text, from);
    assert.equal(r.status, 202, r.body.error?.message);
    queued.push(r.body.queued);
  }
  assert.deepEqual(queued, [0, 1, 2]);
  // c waits; a rename now does not change the name its harness reads.
  const renamed = await api(d, "PATCH", `/rooms/${id}/agents/${po}`, {
    name: "lead",
  });
  assert.equal(renamed.status, 200);
  const idle = async () => {
    for (const until = Date.now() + 20_000; ; ) {
      const r = await api<RoomReply>(d, "GET", `/rooms/${id}`);
      if (r.body.participants.every((p) => p.status !== "busy")) return;
      assert.ok(Date.now() < until, "dev never went idle");
      await new Promise((ok) => setTimeout(ok, 25));
    }
  };
  await idle();
  assert.equal((await say(dev, "d")).status, 202);
  await idle();

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const events = await roomEvents(d, id, dev);
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.deepEqual(
    of("_client_user_message").map((e) => [e.update.text, e.update.from]),
    [
      ["a", po],
      ["b", undefined],
      ["c", po],
      ["d", undefined],
    ],
    "the log keeps the text without the line, and the sender's id",
  );
  assert.deepEqual(
    of("_client_message_queued").map((e) => [e.update.text, e.update.from]),
    [
      ["b", undefined],
      ["c", po],
    ],
  );
  assert.deepEqual(
    of("agent_message_chunk").map(
      (e) => (e.update.content as { text: string }).text,
    ),
    [
      "previous: (none)",
      "previous: [from po]\na",
      "previous: b",
      "previous: [from po]\nc",
    ],
    "the harness read the line only on the orchestrator's messages",
  );
});

test("one room log names each line's room and participant, and a participant's stream is its own lines", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", { cwd });
  const { id } = open.body;
  // One harness for both, so only the participant id tells them apart.
  const alice = await addAgent(d, id, {
    cmd: REMEMBER,
    name: "alice",
    role: "orchestrator",
  });
  const bob = await addAgent(d, id, { cmd: REMEMBER, name: "bob" });

  const toAlice = await api(d, "POST", `/rooms/${id}/messages`, {
    text: "to alice",
  });
  assert.equal(toAlice.status, 202);
  const toBob = await api(d, "POST", `/rooms/${id}/agents/${bob.id}/messages`, {
    text: "to bob",
  });
  assert.equal(toBob.status, 202);
  // Bob's turn sends alice a copy (M8-2), so she is idle only after him.
  await agentIdle(d, id, bob.id);
  await agentIdle(d, id, alice.id);
  const nobody = `/rooms/${id}/agents/p-nobody`;
  for (const [method, path, body] of [
    ["POST", `${nobody}/messages`, { text: "hi" }],
    ["GET", `${nobody}/events`, undefined],
    ["POST", `${nobody}/turns/current/cancel`, undefined],
  ] as const) {
    const r = await api(d, method, path, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.body.error.code, "participant_not_found");
  }
  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);

  const all = await roomEvents(d, id);
  for (const line of all) {
    assert.equal(line.roomId, id);
    assert.ok([alice.id, bob.id].includes(line.participantId));
    assert.ok(!("agent" in line), "a room line has no agent (S10)");
  }
  const bobs = await roomEvents(d, id, bob.id);
  assert.deepEqual(
    bobs,
    all.filter((e) => e.participantId === bob.id),
    "the same lines, with the room's seq",
  );
  const said = (lines: typeof all) =>
    lines
      .filter((e) => e.update.sessionUpdate === "_client_user_message")
      .map((e) => e.update.text);
  assert.deepEqual(said(bobs), ["to bob"]);
  assert.deepEqual(said(await roomEvents(d, id, alice.id)), [
    "to alice",
    "[copy] you → bob · end_turn, 0 tool calls\nto bob\n\n[answer]\nprevious: (none)",
  ]);
});

test("POST /rooms refuses an unadded folder, a missing or unknown harness, and a bad message", async (t) => {
  const d = await boot(t);
  const repo = await gitRepo(t);

  const unadded = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(repo, REMEMBER),
  );
  assert.equal(unadded.status, 403);
  assert.equal(unadded.body.error.code, "repo_not_added");

  const cwd = await added(d, repo);
  const refused: [unknown, RegExp][] = [
    [[{}], /"agent" or "cmd"/],
    [[{ agent: "nope" }], /unknown agent "nope"/],
    [[{ agent: 7, cmd: REMEMBER }], /"agent" must be a non-empty string/],
    [[{ agent: "opencode", cmd: null }], /"cmd" must be a non-empty string/],
    [{ cmd: REMEMBER }, /"agents" must be a list/],
    [[{ cmd: REMEMBER, name: "no spaces" }], /invalid agent name/],
    [[{ cmd: REMEMBER, name: "a".repeat(33) }], /invalid agent name/],
    [[{ cmd: REMEMBER, name: null }], /invalid agent name null/],
    // A default name that breaks R22 asks for one rather than mangling it.
    [[{ cmd: "/bin/true" }], /give the agent a "name"/],
    [[{ cmd: REMEMBER, role: "boss" }], /invalid role "boss"/],
    [[{ cmd: REMEMBER, mode: "turbo" }], /invalid mode "turbo"/],
    [[{ cmd: REMEMBER, turbo: true }], /unknown agent field "turbo"/],
    [[{ cmd: REMEMBER, name: "c", base: "no-such-ref" }], /does not resolve/],
  ];
  for (const [agents, message] of refused) {
    const r = await api<RoomReply>(d, "POST", "/rooms", { cwd, agents });
    assert.equal(r.status, 400, JSON.stringify(agents));
    assert.equal(r.body.error.code, "invalid_request");
    assert.match(r.body.error.message, message);
  }
  const clashes: [unknown, string][] = [
    [
      [
        { cmd: REMEMBER, name: "a" },
        { cmd: REMEMBER, name: "A" },
      ],
      "name_taken",
    ],
    [
      [
        { cmd: REMEMBER, name: "a", role: "orchestrator" },
        { cmd: REMEMBER, name: "b", role: "orchestrator" },
      ],
      "orchestrator_exists",
    ],
  ];
  for (const [agents, code] of clashes) {
    const r = await api<RoomReply>(d, "POST", "/rooms", { cwd, agents });
    assert.equal(r.status, 409, JSON.stringify(agents));
    assert.equal(r.body.error.code, code);
  }
  for (const title of [7, "", "  "]) {
    const r = await api<RoomReply>(d, "POST", "/rooms", { cwd, title });
    assert.equal(r.status, 400, JSON.stringify(title));
    assert.match(r.body.error.message, /"title" must be a non-empty string/);
  }

  const missing = await api(d, "POST", "/rooms/missing/messages", {
    text: "x",
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "room_not_found");
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  const empty = await api(d, "POST", `/rooms/${open.body.id}/messages`, {
    text: " ",
  });
  assert.equal(empty.status, 400);
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("every room route answers room_not_found for an unknown id", async (t) => {
  const d = await boot(t);
  const routes: [string, string, unknown][] = [
    ["GET", "/rooms/nope", undefined],
    ["POST", "/rooms/nope/dismiss", undefined],
    ["POST", "/rooms/nope/messages", { text: "hi" }],
    ["GET", "/rooms/nope/events", undefined],
    ["POST", "/rooms/nope/agents/p-x/messages", { text: "hi" }],
    ["GET", "/rooms/nope/agents/p-x/events", undefined],
    ["POST", "/rooms/nope/agents/p-x/turns/current/cancel", undefined],
    ["POST", "/rooms/nope/agents", { cmd: REMEMBER }],
    ["GET", "/rooms/nope/agents", undefined],
    ["GET", "/rooms/nope/agents/p-x", undefined],
    ["PATCH", "/rooms/nope/agents/p-x", { name: "a" }],
    ["DELETE", "/rooms/nope/agents/p-x", undefined],
    ["DELETE", "/rooms/nope", undefined],
  ];
  for (const [method, path, body] of routes) {
    const r = await api(d, method, path, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.body.error.code, "room_not_found", `${method} ${path}`);
  }
});

/** `POST /rooms/:id/agents` with `fields`, asserted 201. */
async function addAgent(
  d: Daemon,
  id: string,
  fields: Record<string, unknown>,
): Promise<ParticipantDto> {
  const r = await api<ParticipantDto & RoomReply>(
    d,
    "POST",
    `/rooms/${id}/agents`,
    fields,
  );
  assert.equal(r.status, 201, r.body.error?.message);
  return r.body;
}

/** Polls one participant until it is no longer `busy`. */
async function agentIdle(d: Daemon, id: string, agentId: string) {
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const r = await api<ParticipantDto>(
      d,
      "GET",
      `/rooms/${id}/agents/${agentId}`,
    );
    assert.equal(r.status, 200);
    if (r.body.status !== "busy") return r.body;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`participant ${agentId} never went idle`);
}

test("participants are added, listed, changed and removed through the routes", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", { cwd });
  const { id } = open.body;
  const base = `/rooms/${id}/agents`;

  const alice = await addAgent(d, id, {
    cmd: REMEMBER,
    name: "alice",
    role: "orchestrator",
  });
  const bob = await addAgent(d, id, {
    cmd: REMEMBER,
    name: "bob",
    mode: "auto",
    settings: { allowReadOutsideRoot: true },
  });
  assert.equal(alice.mode, "auto");
  assert.deepEqual(alice.settings, { allowReadOutsideRoot: false });
  assert.deepEqual(bob.settings, { allowReadOutsideRoot: true });
  assert.notEqual(alice.worktree, bob.worktree);
  assert.notEqual(alice.branch, bob.branch);

  const list = await api<ParticipantDto[]>(d, "GET", base);
  assert.deepEqual(
    list.body.map((p) => p.name),
    ["alice", "bob"],
  );
  const one = await api<ParticipantDto>(d, "GET", `${base}/${bob.id}`);
  assert.equal(one.body.name, "bob");

  const renamed = await api<ParticipantDto>(d, "PATCH", `${base}/${bob.id}`, {
    name: "Bobby",
    mode: "auto",
    role: "tester",
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, "Bobby");
  assert.equal(renamed.body.role, "tester");
  assert.equal(renamed.body.id, bob.id, "a rename never moves the id");
  assert.equal(renamed.body.branch, bob.branch, "nor the branch");
  const cleared = await api<ParticipantDto>(d, "PATCH", `${base}/${bob.id}`, {
    role: null,
  });
  assert.equal(cleared.body.role, undefined);

  const refused: [string, string, unknown, number, string][] = [
    ["POST", base, { cmd: REMEMBER, name: "ALICE" }, 409, "name_taken"],
    [
      "POST",
      base,
      { cmd: REMEMBER, name: "carol", role: "orchestrator" },
      409,
      "orchestrator_exists",
    ],
    [
      "POST",
      base,
      { cmd: REMEMBER, name: "c", mode: null },
      400,
      "invalid_request",
    ],
    [
      "POST",
      base,
      { cmd: REMEMBER, name: "c", base: "nope" },
      400,
      "invalid_request",
    ],
    ["PATCH", `${base}/${bob.id}`, { name: "Alice" }, 409, "name_taken"],
    [
      "PATCH",
      `${base}/${bob.id}`,
      { role: "orchestrator" },
      409,
      "orchestrator_exists",
    ],
    ["PATCH", `${base}/${bob.id}`, { mode: "turbo" }, 400, "invalid_request"],
    ["PATCH", `${base}/${bob.id}`, {}, 400, "invalid_request"],
    ["PATCH", `${base}/${bob.id}`, { harness: "x" }, 400, "invalid_request"],
    ["GET", `${base}/p-nope`, undefined, 404, "participant_not_found"],
    ["PATCH", `${base}/p-nope`, { name: "x" }, 404, "participant_not_found"],
    ["DELETE", `${base}/p-nope`, undefined, 404, "participant_not_found"],
  ];
  for (const [method, path, body, status, code] of refused) {
    const r = await api(d, method, path, body);
    const label = `${method} ${path} ${JSON.stringify(body)}`;
    assert.equal(r.status, status, label);
    assert.equal(r.body.error.code, code, label);
  }
  assert.equal(
    (await api<ParticipantDto[]>(d, "GET", base)).body.length,
    2,
    "no refused add joined",
  );

  const gone = await api<RoomReply>(d, "DELETE", `${base}/${bob.id}`);
  assert.equal(gone.status, 200, gone.body.error?.message);
  assert.deepEqual(
    gone.body.participants.map((p) => p.id),
    [alice.id],
  );
  const listed = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.deepEqual(
    listed.body[0]?.participants.map((p) => p.name),
    ["alice"],
  );

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  for (const [method, path, body] of [
    ["POST", base, { cmd: REMEMBER, name: "carol" }],
    ["PATCH", `${base}/${alice.id}`, { name: "a" }],
    ["DELETE", `${base}/${alice.id}`, undefined],
  ] as const) {
    const r = await api(d, method, path, body);
    assert.equal(r.status, 409, `${method} ${path}`);
    assert.equal(r.body.error.code, "room_dismissed", `${method} ${path}`);
  }
});

test("PATCH /rooms/:id renames the room, saves it, and refuses a bad title", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", { cwd, title: "a" });
  const { id } = open.body;

  const renamed = await api<RoomReply>(d, "PATCH", `/rooms/${id}`, {
    title: "  login bug ",
  });
  assert.equal(renamed.status, 200, renamed.body.error?.message);
  assert.equal(renamed.body.id, id, "a rename never moves the id");
  assert.equal(renamed.body.title, "login bug");
  assert.equal(renamed.body.seq, open.body.seq, "a rename writes no line");
  const listed = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.equal(listed.body[0]?.title, "login bug");
  const record = join(stateDirFor(cwd), "rooms", id, "room.json");
  assert.equal(JSON.parse(await readFile(record, "utf8")).title, "login bug");

  for (const [path, body, status, code] of [
    [`/rooms/${id}`, {}, 400, "invalid_request"],
    [`/rooms/${id}`, { title: " " }, 400, "invalid_request"],
    [`/rooms/${id}`, { title: 7 }, 400, "invalid_request"],
    [`/rooms/${id}`, { title: "x", cwd }, 400, "invalid_request"],
    ["/rooms/nope", { title: "x" }, 404, "room_not_found"],
  ] as const) {
    const r = await api(d, "PATCH", path, body);
    const label = `${path} ${JSON.stringify(body)}`;
    assert.equal(r.status, status, label);
    assert.equal(r.body.error.code, code, label);
  }

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const late = await api(d, "PATCH", `/rooms/${id}`, { title: "x" });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "room_dismissed");
});

test("two participants work in parallel in their own checkouts, and a third starts from one's branch", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario stall`,
        name: "stuck",
        role: "orchestrator",
      },
      { cmd: `node ${MOCK_AGENT}`, name: "writer" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const [stuck, writer] = open.body.participants as [
    ParticipantDto,
    ParticipantDto,
  ];
  const agent = (p: ParticipantDto) => `/rooms/${id}/agents/${p.id}`;
  const message = (text: string) =>
    api(d, "POST", `/rooms/${id}/messages`, { text });

  // Until M6-4 a message reaches only the orchestrator, so the role moves
  // from the stuck participant to the writer while the stuck one is busy.
  assert.equal((await message("hang")).status, 202);
  const cleared = await api(d, "PATCH", agent(stuck), { role: null });
  assert.equal(cleared.status, 200, cleared.body.error?.message);
  const moved = await api(d, "PATCH", agent(writer), { role: "orchestrator" });
  assert.equal(moved.status, 200, moved.body.error?.message);
  assert.equal((await message("write")).status, 202);
  await agentIdle(d, id, writer.id);
  const still = await api<ParticipantDto>(d, "GET", agent(stuck));
  assert.equal(still.body.status, "busy", "the two turns overlapped");

  assert.ok(existsSync(join(stuck.worktree, "stalled.txt")));
  assert.ok(!existsSync(join(stuck.worktree, "ACP_TEST.md")));
  assert.ok(existsSync(join(writer.worktree, "ACP_TEST.md")));
  assert.ok(!existsSync(join(writer.worktree, "stalled.txt")));

  // The stuck participant commits its own work (R37), and a third starts
  // from that branch through the route.
  for (const args of [
    ["add", "stalled.txt"],
    ["commit", "-m", "stuck: stalled.txt"],
  ]) {
    const r = spawnSync("git", args, { cwd: stuck.worktree });
    assert.equal(r.status, 0, String(r.stderr));
  }
  const head = spawnSync("git", ["rev-parse", stuck.branch as string], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();
  const reviewer = await addAgent(d, id, {
    cmd: REMEMBER,
    name: "reviewer",
    base: stuck.branch,
  });
  assert.equal(reviewer.baseSha, head);
  assert.ok(existsSync(join(reviewer.worktree, "stalled.txt")));

  // Removing the busy one ends its turn and leaves the others as they were.
  const gone = await api<RoomReply>(d, "DELETE", agent(stuck));
  assert.equal(gone.status, 200, gone.body.error?.message);
  assert.deepEqual(
    gone.body.participants.map((p) => [p.name, p.status]),
    [
      ["writer", "idle"],
      ["reviewer", "idle"],
    ],
  );
  const kept = spawnSync(
    "git",
    ["rev-parse", "--verify", stuck.branch as string],
    { cwd },
  );
  assert.equal(kept.status, 0, "the removed participant's branch is kept");
  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const ended = (await roomEvents(d, id)).filter(
    (e) => e.update.sessionUpdate === "_client_turn_ended",
  );
  assert.equal(ended.length, 2, "the removed participant's turn ended too");
});

test("an explicit empty agents list, a 32-character name and every role open a room", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));

  const empty = await api<RoomReply>(d, "POST", "/rooms", { cwd, agents: [] });
  assert.equal(empty.status, 201, empty.body.error?.message);
  assert.deepEqual(empty.body.participants, []);
  await api(d, "POST", `/rooms/${empty.body.id}/dismiss`);

  const agents: { cmd: string; name?: string; role?: string }[] = [
    { cmd: REMEMBER, name: "a".repeat(32) },
    ...["developer", "tester", "architect"].map((role) => ({
      cmd: REMEMBER,
      role,
    })),
  ];
  for (const agent of agents) {
    const open = await api<RoomReply>(d, "POST", "/rooms", {
      cwd,
      agents: [agent],
    });
    assert.equal(open.status, 201, open.body.error?.message);
    const got = await api<RoomReply>(d, "GET", `/rooms/${open.body.id}`);
    assert.equal(only(got.body).name, agent.name ?? "mock-agent");
    assert.equal(only(got.body).role, agent.role);
    await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
  }
});

test("a harness that dies leaves its participant exited, the room active, and a message revives it", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;

  // The harness pid is on the room's log; the SSE stream would not end
  // while the room lives, so the file is read directly.
  const log = join(stateDirFor(root), "rooms", id, "events.jsonl");
  let pid: number | undefined;
  for (const until = Date.now() + 10_000; !pid && Date.now() < until; ) {
    const lines = (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    pid = lines.find(
      (e) => e.update.sessionUpdate === "_client_harness_spawned",
    )?.update.pid;
    if (!pid) await new Promise((ok) => setTimeout(ok, 25));
  }
  assert.ok(pid, "the harness pid is on the log");
  process.kill(pid, "SIGKILL");

  let room: RoomReply | undefined;
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    room = (await api<RoomReply>(d, "GET", `/rooms/${id}`)).body;
    if (only(room).status === "exited") break;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  assert.equal(room && only(room).status, "exited");
  assert.equal(room?.status, "active", "the room outlives its harness (R33)");

  // M6-7a: the next message starts a new harness with a fresh session.
  const r = await api(d, "POST", `/rooms/${id}/messages`, { text: "hi" });
  assert.equal(r.status, 202, r.body.error?.message);
  const back = only(await roomIdle(d, id));
  assert.equal(back.status, "idle");
  assert.equal(back.resumed, "fresh");
  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
});

test("a message needs an orchestrator: an empty room and a room without one refuse it", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const empty = await api<RoomReply>(d, "POST", "/rooms", { cwd });
  const plain = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER }],
  });
  assert.equal(plain.status, 201, plain.body.error?.message);
  assert.equal(only(plain.body).role, undefined, "no role is given by default");
  for (const room of [empty.body, plain.body]) {
    const r = await api(d, "POST", `/rooms/${room.id}/messages`, {
      text: "hi",
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "no_orchestrator");
    await api(d, "POST", `/rooms/${room.id}/dismiss`);
  }
});

test("a room whose harness cannot start is a 500 room_open_failed", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  // The harness binary is absent, so `openRoom` fails after the checkout is
  // ready; that failure has its own code, not `internal` (M5-3, #135).
  const r = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, "definitely-not-a-command"),
  );
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, "room_open_failed");
});

test("chat.ts new --name names an agent whose harness label is not a valid name", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const env = { XDG_RUNTIME_DIR: runtime };
  // A full path is the label, and a path breaks R22's name rule.
  const cmd = `${process.execPath} ${MOCK_AGENT}`;

  const unnamed = await spawnCli(
    t,
    ["new", "--cmd", cmd, "--cwd", cwd],
    "chat.ts",
    env,
  ).done;
  assert.equal(unnamed.code, 1);
  assert.match(unnamed.stderr, /give the agent a "name"/);

  const named = spawnCli(
    t,
    ["new", "--cmd", cmd, "--name", "bob", "--cwd", cwd],
    "chat.ts",
    env,
  );
  named.child.stdin.end("/dismiss\n");
  const r = await named.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /· bob \(/);
});

test("chat.ts talks to a room end to end: messages in, answers out, /dismiss stops it", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));

  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("alpha\nbeta\n/dismiss\n");
  const r = await c.done;

  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /you → mock-agent: alpha\nmock-agent: previous: \(none\)\n/,
  );
  assert.match(
    r.stdout,
    /you → mock-agent: beta\nmock-agent: previous: alpha\n/,
  );
  assert.match(r.stdout, /the room was dismissed/);
  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  assert.deepEqual(
    rooms.body.map((room) => room.status),
    ["dismissed"],
  );
});

test("piped chat.ts prints an agent's tool calls under its name, and names it once per answer", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // The default mock turn: text, a tool call, text, a tool call, text.
  const c = spawnCli(
    t,
    ["new", "--cmd", `node ${MOCK_AGENT}`, "--cwd", cwd],
    "chat.ts",
    { XDG_RUNTIME_DIR: runtime },
  );
  c.child.stdin.end("go\n/dismiss\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /you → mock-agent: go\nmock-agent: Reading package\.json via the client… *\n {2}· Read package\.json\ngot \d+ chars\.\n {2}· Write ACP_TEST\.md\nWrote ACP_TEST\.md\./,
  );
  assert.equal(r.stdout.match(/^mock-agent:/gm)?.length, 1, r.stdout);
});

test("chat.ts prints an answer that comes in two chunks once", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));

  const c = spawnCli(
    t,
    ["new", "--cmd", `node ${MOCK_AGENT} --scenario split`, "--cwd", cwd],
    "chat.ts",
    { XDG_RUNTIME_DIR: runtime },
  );
  c.child.stdin.end("alpha\nbeta\n/dismiss\n");
  const r = await c.done;

  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /you → mock-agent: alpha\nmock-agent: previous: \(none\)\n/,
  );
  assert.match(
    r.stdout,
    /you → mock-agent: beta\nmock-agent: previous: alpha\n/,
  );
});

test("chat.ts and chat/ reach the daemon over HTTP only: client/, pi-tui and core/runtime.ts", async () => {
  // S8, widened by M4-1: chat.ts imports `client/`, pi-tui and
  // `core/runtime.ts` (the `daemon.json` path), type imports included.
  // M4-13 adds `@xterm/headless`, in `chat/tui/term.ts` alone.
  // Since M4-7 every file in chat/ holds the same rule, and the walk goes
  // into every subfolder, such as chat/tui/ (M4-12). They may import each
  // other, but never chat.ts: the arrow is chat.ts → chat/, and chat.ts
  // runs `main()` when it loads. A tests/ folder is not read: a test may
  // import anything. `client/` is then followed file by file, so a
  // `client/` file that reached `core/` or `protocol/` at runtime fails here
  // too. A type-only import there is allowed: it is erased before the code
  // runs.
  const root = join(import.meta.dirname, "..");
  const importsOf = async (file: string) => {
    const source = await readFile(join(root, file), "utf8");
    // `export … from` and a bare `import "x"` load a module too. A literal
    // `import("x")` loads one when it runs, so it gets the same check.
    const staticImports = [
      ...source.matchAll(
        /^(?:(?:import|export)( type)?[^;]*?from|import) "([^"]+)";/gms,
      ),
    ].map((m) => ({ spec: m[2] ?? "", typeOnly: Boolean(m[1]) }));
    const dynamicImports = [
      ...source.matchAll(/\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g),
    ].map((m) => ({ spec: m[2], typeOnly: false }));
    return [...staticImports, ...dynamicImports];
  };
  const screens = ["chat.ts"];
  for (const entry of await readdir(join(root, "chat"), {
    withFileTypes: true,
    recursive: true,
  })) {
    const file = relative(root, join(entry.parentPath, entry.name));
    if (file.split(sep).includes("tests")) continue;
    if (entry.isFile() && entry.name.endsWith(".ts")) screens.push(file);
  }
  const queue: string[] = [];
  for (const file of screens) {
    for (const { spec } of await importsOf(file)) {
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) {
        // One file of pi-tui by name: `decodePrintableKey` is not in its
        // main exports (M7-4). Another deep import is a new decision.
        // M4-13: the shell's screen, in the shell's file only.
        const term =
          spec === "@xterm/headless" && file === join("chat", "tui", "term.ts");
        assert.ok(
          spec === "@earendil-works/pi-tui" ||
            spec === "@earendil-works/pi-tui/dist/keys.js" ||
            term,
          `${file} imports ${spec}`,
        );
        continue;
      }
      const target = join(dirname(file), spec);
      if (target.startsWith(`client${sep}`)) queue.push(target);
      else {
        assert.ok(
          target === join("core", "runtime.ts") ||
            (target !== "chat.ts" && screens.includes(target)),
          `${file} imports ${spec}`,
        );
      }
    }
  }
  assert.ok(queue.length > 0, "chat.ts imports client/");
  // Every file directly in client/ too, not only what chat.ts imports: one
  // that nothing imports yet is under the same S8 boundary. client/tests/
  // is not swept: a test may import anything.
  for (const entry of await readdir(join(root, "client"), {
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      queue.push(`client/${entry.name}`);
    }
  }
  const seen = new Set<string>();
  for (const file of queue) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec, typeOnly } of await importsOf(file)) {
      if (typeOnly || spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("."), `${file} imports the package ${spec}`);
      const target = join(dirname(file), spec);
      assert.ok(
        target.startsWith(`client${sep}`),
        `${file} reaches ${spec} at runtime`,
      );
      queue.push(target);
    }
  }
});

test("chat.ts /leave keeps the room alive, and attach replays the conversation before the next turn", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const env = { XDG_RUNTIME_DIR: runtime };

  const first = spawnCli(
    t,
    ["new", "--cmd", REMEMBER, "--cwd", cwd],
    "chat.ts",
    env,
  );
  first.child.stdin.end("alpha\n/leave\n");
  assert.equal((await first.done).code, 0);

  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  assert.deepEqual(
    rooms.body.map((room) => room.status),
    ["active"],
    "leaving kept it",
  );
  const id = rooms.body[0]?.id as string;

  const again = spawnCli(t, ["attach", id], "chat.ts", env);
  again.child.stdin.end("beta\n/dismiss\n");
  const r = await again.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /you → mock-agent: alpha\nmock-agent: previous: \(none\)\n[\s\S]*you → mock-agent: beta\nmock-agent: previous: alpha\n/,
    "history first, then the new turn — on the same harness",
  );
});

/** `script` from util-linux gives a child a real pseudo-terminal. Its flags
 *  differ on macOS, so the TTY test is Linux-only; it skips elsewhere. */
const noPty =
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
async function ptyScreen(
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
  const seen = (text: string) =>
    new Promise<void>((ok, fail) => {
      const bail = setTimeout(
        () => fail(new Error(`never saw ${text}: ${out}`)),
        20_000,
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
async function chatOnPty(t: TestContext, agent = REMEMBER) {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const cmd = `stty cols 100 rows 30; node chat.ts new --cmd '${agent}' --cwd '${cwd}'`;
  const screen = await ptyScreen(t, cmd, { XDG_RUNTIME_DIR: runtime });
  return { ...screen, d, cwd };
}

test("kapelle alone starts a daemon, opens the chat, and /leave leaves it running", {
  skip: noPty,
}, async (t) => {
  // M9-2: a terminal with no daemon gets one in the background, then the
  // screen. The daemon is in its own session, so the chat's exit is not its.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  // A standalone `kapelle` must not fall through to the single-prompt path,
  // which would start the default harness (pi) beside the chat.
  const bin = await tempDir(t);
  const marker = join(state, "pi-started");
  const fake = join(bin, "pi-acp");
  await writeFile(fake, '#!/bin/sh\nprintf spawned > "$PI_MARKER"\nexit 1\n', {
    mode: 0o755,
  });
  await chmod(fake, 0o755);
  const screen = await ptyScreen(t, "node cli.ts", {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(state, "config-home"),
    KAPELLE_PORT: "0",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    PI_MARKER: marker,
  });
  await new Promise((ok) => setTimeout(ok, 300));
  await assert.rejects(readFile(marker), "bare kapelle started a harness");
  const file = join(runtime, "kapelle", "daemon.json");
  const { pid, port, token } = JSON.parse(await readFile(file, "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  });
  assert.equal(alive(pid), true);
  assert.match(
    await readFile(join(state, "kapelle", "daemon.log"), "utf8"),
    /listening on /,
  );
  // `detached` made the daemon a session leader: the terminal's session is
  // not its own, so closing the terminal cannot hang it up.
  const sid = execFileSync("ps", ["-o", "sid=", "-p", String(pid)])
    .toString()
    .trim();
  assert.equal(sid, String(pid));

  screen.child.stdin.write("/leave\r");
  await screen.seen("left the chat");
  assert.equal(await screen.exited, 0, screen.out());

  // Only the chat ended.
  assert.equal(alive(pid), true);
  const answer = await fetch(`http://127.0.0.1:${port}/version`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(answer.status, 200);
});

test("two kapelle at once leave one daemon, and either key ends only the chat", {
  skip: noPty,
}, async (t) => {
  // The daemon's own lock picks the winner. Both CLIs wait for its record
  // instead of surfacing `another daemon is starting`, and both get a screen.
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const env = {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(state, "config-home"),
    KAPELLE_PORT: "0",
  };
  await mkdir(join(state, "kapelle"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(state, "kapelle", "daemon.log"),
    "the previous start\n",
    {
      mode: 0o600,
    },
  );
  const [a, b] = await Promise.all([
    ptyScreen(t, "node cli.ts", env),
    ptyScreen(t, "node cli.ts", env),
  ]);
  const file = join(runtime, "kapelle", "daemon.json");
  const { pid, port, token } = JSON.parse(await readFile(file, "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  });
  assert.equal(alive(pid), true);
  // Only one daemon ever listened. The loser's refusal is in the same log,
  // or in the one rotation moved aside, and never reached a CLI.
  const logs = await Promise.all(
    [
      join(state, "kapelle", "daemon.log"),
      join(state, "kapelle", "daemon.log.1"),
    ].map((path) => readFile(path, "utf8").catch(() => "")),
  );
  assert.equal(logs.join("").match(/listening on /g)?.length, 1);
  assert.equal(
    await readFile(join(state, "kapelle", "daemon.log.1"), "utf8"),
    "the previous start\n",
    "two starters rotated the log once",
  );

  a.child.stdin.write("/leave\r");
  await a.seen("left the chat");
  assert.equal(await a.exited, 0, a.out());
  // Raw mode turns ^C into a key: only the screen's listener sees it.
  b.child.stdin.write("\x03");
  await b.seen("left the chat");
  assert.equal(await b.exited, 0, b.out());

  // One daemon served both chats, and it is still there.
  assert.equal(alive(pid), true);
  const answer = await fetch(`http://127.0.0.1:${port}/version`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(answer.status, 200);
});

/** CSI, OSC and APC sequences; pi-tui writes all three. */
const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
  /\x1b(\[[0-9;?<>]*[A-Za-z~]|\][^\x07\x1b]*(\x07|\x1b\\)|_[^\x1b]*\x1b\\)/g;

/** Terminal output as text: no escapes, no carriage returns. */
const plainText = (out: string) => out.replace(ESCAPES, "").replace(/\r/g, "");

/** The screen now, by row. pi-tui writes a row as CSI row;1H, CSI 2K, so
 *  the last text written to each row is what it shows. */
function screenRows(out: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the subject.
  const parts = out.split(/\x1b\[(\d+);1H\x1b\[2K/);
  const rows = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) {
    rows.set(Number(parts[i]), plainText(parts[i + 1] ?? ""));
  }
  return rows;
}

/** The pop-up's pick list as it is drawn now, one entry a row. `→` marks
 *  the cursor. */
const pickList = (out: string) =>
  [...screenRows(out).values()].flatMap(
    (row) => row.match(/┃ [→ ] (\S+)\s*┃/)?.[1] ?? [],
  );

/** The first row on screen whose text matches. 0 for none. */
const rowOf = (out: string, re: RegExp) =>
  [...screenRows(out)].find(([, text]) => re.test(text))?.[0] ?? 0;

/** What stays on the normal screen once the alternate one is left. */
const scrollback = (out: string) =>
  plainText(out.slice(out.lastIndexOf("\x1b[?1049l")));

test("chat.ts on a real terminal is the full-screen chat, and leaves the conversation in scrollback", {
  skip: noPty,
}, async (t) => {
  const { child, seen, exited, out: screen } = await chatOnPty(t);
  child.stdin.write("alpha\r");
  await seen("previous: (none)");
  child.stdin.write("/leave\r");
  await seen("rejoin with");
  const code = await exited;
  const out = screen();
  assert.equal(code, 0, out);

  const raw = scrollback(out);
  const text = raw.replace(/[ \t]+$/gm, "");
  assert.match(
    text,
    /▎ you → mock-agent\n▎ alpha\n[\s\S]*▎ mock-agent · mock-agent · orchestrator · \d\d:\d\d\n▎ previous: \(none\)\n[\s\S]*left room \S+; rejoin with/,
    "the typed message, the answer, then the exit line",
  );
  // A line as wide as the terminal gets an empty line after it where the
  // terminal wraps at the last column at once: Windows ConPTY, and some
  // multiplexers. The pty is 100 columns wide.
  for (const line of raw.split("\n")) {
    assert.ok(line.length < 100, `a full-width line: ${JSON.stringify(line)}`);
  }
  assert.doesNotMatch(text, /enter to send/, "the status line is not chat");
});

for (const [how, keys] of [
  ["^C", "\x03"],
  ["/leave", "/leave\r"],
] as const) {
  test(`chat.ts on a real terminal: ${how} leaves the chat with exit 0`, {
    skip: noPty,
  }, async (t) => {
    // Raw mode turns ^C into a key, not a SIGINT: only the screen's own
    // listener gets the operator out.
    const { child, seen, exited, out } = await chatOnPty(t);
    child.stdin.write(keys);
    await seen("rejoin with");
    assert.equal(await exited, 0, out());
    assert.match(out(), /left room \S+; rejoin with/);
  });
}

test("chat.ts on a real terminal: /term runs a shell in the room's folder that resizes, takes vim, Esc and ^C, and ends with the chat", {
  skip: noPty,
}, async (t) => {
  // M4-13. The pty is 100 columns: the pane takes the timeline's place,
  // beside the 32-column sidebar. sh, so no rc file draws the prompt.
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // The chat's own pty path, so the test can resize its screen.
  const outer = join(runtime, "chat.tty");
  const cmd = `tty > '${outer}'; stty cols 100 rows 30; node chat.ts new --cmd '${REMEMBER}' --cwd '${cwd}'`;
  const { child, press, seen, exited, out } = await ptyScreen(t, cmd, {
    XDG_RUNTIME_DIR: runtime,
    SHELL: "/bin/sh",
  });
  /** The first match of `re` in what is drawn after `from`. */
  const drawn = async (from: number, re: RegExp) => {
    for (const until = Date.now() + 20_000; ; ) {
      const m = plainText(out().slice(from)).match(re);
      if (m) return m;
      assert.ok(Date.now() < until, `never saw ${re}: ${out()}`);
      await new Promise((ok) => setTimeout(ok, 50));
    }
  };
  /** Types `line` into the shell, and reads `re` from what it draws. */
  const run = (line: string, re: RegExp) => {
    const from = out().length;
    child.stdin.write(`${line}\r`);
    return drawn(from, re);
  };
  const size = async () => {
    const m = await run('echo "size=$(stty size)"', /size=(\d+) (\d+)/);
    return { rows: Number(m[1]), cols: Number(m[2]) };
  };

  await press("/term\r", "ctrl+] keys back");
  await run(`[ "$(pwd)" = '${cwd}' ] && echo "here=$((1))"`, /here=1/);
  await run('echo $$ > shell.pid; echo "saved=$((1))"', /saved=1/);
  const before = await size();
  // ctrl+] gives the keys back; ctrl+t hides the sidebar, so the pane widens.
  await press("\x1d", "ctrl+] keys here");
  child.stdin.write("\x14");
  await press("\x1d", "ctrl+] keys back");
  const after = await size();
  assert.equal(after.rows, before.rows);
  assert.equal(
    after.cols,
    before.cols + 30,
    "the sidebar's 32 less the strip's 2",
  );
  // A shorter screen gives the shell fewer rows. The resize reaches the
  // shell after a redraw, so ask until it shows.
  const tty = (await readFile(outer, "utf8")).trim();
  spawnSync("stty", ["-F", tty, "rows", "24", "cols", "100"]);
  for (const until = Date.now() + 20_000; ; ) {
    const s = await size();
    if (s.rows < after.rows) break;
    assert.ok(Date.now() < until, `the shell kept ${s.rows} rows`);
  }

  // ctrl+o, ctrl+r and ctrl+x are the shell's too: read raw, they arrive.
  {
    const from = out().length;
    await run(
      'stty raw -echo; echo "raw=$((1))"; k=$(dd bs=1 count=3 2>/dev/null | od -An -tx1); stty sane; echo "k=$k."',
      /raw=1/,
    );
    child.stdin.write("\x0f\x12\x18");
    await drawn(from, /k= 0f 12 18\./);
  }

  // ^C stops the command, not the chat.
  child.stdin.write("sleep 30\r");
  await new Promise((ok) => setTimeout(ok, 300));
  child.stdin.write("\x03");
  await run('echo "after=$((1+1))"', /after=2/);

  // Esc reaches vim: insert mode ends, and :wq writes the file.
  if (spawnSync("vim", ["--version"]).status === 0) {
    await run("vim -u NONE -N note.txt", /note\.txt/);
    child.stdin.write("ihello from vim");
    await new Promise((ok) => setTimeout(ok, 200));
    child.stdin.write("\x1b");
    await new Promise((ok) => setTimeout(ok, 200));
    // The main screen comes back with the line that started vim: keys
    // typed before that would go to vim.
    await run(":wq", /\$ vim -u NONE -N note\.txt/);
    await run("tr a-z A-Z < note.txt", /HELLO FROM VIM/);
  }

  // Hidden and shown again, it is the same shell, with its screen.
  await run('echo "kept=$((5))"', /kept=5/);
  await press("\x1d", "ctrl+] keys here");
  await press("\x18", "ctrl+x view");
  {
    const from = out().length;
    await press("/term\r", "ctrl+] keys back");
    await drawn(from, /kept=5/);
  }
  await run('[ $$ = "$(cat shell.pid)" ] && echo "same=$((1))"', /same=1/);

  // A failed exit leaves the view, to read why; the next /term starts a
  // new shell.
  await press("exit 3\r", "exited (code 3) · /term starts a new one");
  // An exited shell takes no keys: ctrl+] gives the view its own, and Esc
  // gives them back (PR #286).
  await press("\x1d", "esc keys back");
  await press("\x1b", "ctrl+] view");
  // /term is in the composer's history: ↑ brings it back (PR #286).
  {
    const from = out().length;
    child.stdin.write("\x1b[A");
    await drawn(from, /^ \/term\s*$/m);
  }
  await press("\r", "ctrl+] keys back");
  await run('echo "again=$((2+2))"', /again=4/);
  const pid = Number((await readFile(join(cwd, "shell.pid"), "utf8")).trim());
  await run('echo $$ > shell.pid; echo "saved=$((2))"', /saved=2/);
  const second = Number(
    (await readFile(join(cwd, "shell.pid"), "utf8")).trim(),
  );
  assert.notEqual(second, pid);
  assert.throws(() => process.kill(pid, 0), "the first shell is gone");

  // A clean exit hides the view, as a terminal closes, and the composer
  // has the keys.
  await press("exit\r", "ctrl+x view");
  child.stdin.write("/leave\r");
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
  // The shell ends with the chat.
  for (const until = Date.now() + 5_000; ; ) {
    try {
      process.kill(second, 0);
    } catch {
      break;
    }
    assert.ok(Date.now() < until, "the shell outlived the chat");
    await new Promise((ok) => setTimeout(ok, 50));
  }
});

test("chat.ts on a real terminal: a question that came while the shell had the keys opens when they come back", {
  skip: noPty,
}, async (t) => {
  // PR #286. A question box never opens over a view that has the keys, so
  // giving the keys back must offer it.
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const asking = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  assert.equal(asking.status, 201, asking.body.error?.message);
  // A room with no orchestrator names none on the status line, so the
  // screen is up once the agent's row is.
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime, SHELL: "/bin/sh" },
    "asker",
  );
  await screen.press("/term\r", "ctrl+] keys back");
  const sent = await api(
    d,
    "POST",
    `/rooms/${asking.body.id}/agents/${only(asking.body).id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  // The shell has the keys: the question waits in the sidebar.
  await screen.seen("? asker");
  assert.doesNotMatch(screen.out(), / 1 of 1 ━┓/);
  await screen.press("\x1d", " 1 of 1 ━┓");
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});
test("chat.ts on a real terminal keeps the typing box's bottom border, then the where bar on the last row", {
  skip: noPty,
}, async (t) => {
  // The editor used to be allowed to shrink, and pi-tui's shrink takes at
  // least one row from every entry that may: with the sidebar drawn full
  // height, or a long conversation, the box lost its bottom border.
  const { child, exited, out, seen } = await chatOnPty(t);
  // The pty is 30 rows; pi-tui writes a row as CSI row;1H, CSI 2K, text.
  // The pty is 30 rows. pi-tui writes a row as CSI row;1H, CSI 2K, then
  // its text, and ends a frame with CSI ?2026l.
  const rowAt = (n: number) => {
    const last = out().split(`\x1b[${n};1H\x1b[2K`).slice(1).at(-1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
    const end = last?.search(/\x1b\[(\d+;\d+H|\?2026l)/) ?? -1;
    return last && end !== -1 ? last.slice(0, end) : undefined;
  };
  for (const until = Date.now() + 10_000; rowAt(30) === undefined; ) {
    assert.ok(Date.now() < until, `row 30 never drawn: ${out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // Row 30 is the where bar; the timeline view shows the room's cwd.
  assert.match(
    plainText(rowAt(30) ?? ""),
    /\/tmp\//,
    `row 30: ${JSON.stringify(rowAt(30))}`,
  );
  assert.match(rowAt(29) ?? "", /─/, `row 29: ${JSON.stringify(rowAt(29))}`);
  // The box is rows 27-29 and the status line row 26; the row above it
  // stays empty, a gap between the conversation and the hint.
  assert.match(plainText(rowAt(26) ?? ""), /enter to send/);
  const gap = plainText(rowAt(25) ?? "?");
  assert.equal(gap.trim(), "", `row 25: ${JSON.stringify(rowAt(25))}`);
  // The status line names the target once the roster arrives, not its id.
  await seen("→ mock-agent");
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal previews a fast-forward and moves on Enter", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out, d } = await chatOnPty(t);
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.ok(room);
  const full = await api<RoomReply>(d, "GET", `/rooms/${room.id}`);
  assert.equal(full.status, 200, JSON.stringify(full.body));
  const dev = only(full.body);
  await commitAt(dev.worktree, "dev.txt");

  const addedRev = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room.id}/agents`,
    { cmd: REMEMBER, name: "reviewer", base: dev.branch },
  );
  assert.equal(addedRev.status, 201, JSON.stringify(addedRev.body));
  const reviewer = addedRev.body;
  await commitAt(reviewer.worktree, "review.txt");
  const revHead = headAt(reviewer.worktree);

  await seen("○ reviewer");
  child.stdin.write("@mock-agent /ff --from @reviewer\r");
  await seen("mock-agent ← reviewer · fast-forward");
  await seen("review.txt");
  await press("\r", "moved mock-agent up to reviewer's commit");
  assert.equal(headAt(dev.worktree), revHead);
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
});

test("the target's ctrl+o menu previews a fast-forward from another participant", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out, d } = await chatOnPty(t);
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.ok(room);
  const full = await api<RoomReply>(d, "GET", `/rooms/${room.id}`);
  assert.equal(full.status, 200, JSON.stringify(full.body));
  const dev = only(full.body);
  await commitAt(dev.worktree, "dev.txt");

  const addedRev = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room.id}/agents`,
    { cmd: REMEMBER, name: "reviewer", base: dev.branch },
  );
  assert.equal(addedRev.status, 201, JSON.stringify(addedRev.body));
  await commitAt(addedRev.body.worktree, "review.txt");
  const revHead = headAt(addedRev.body.worktree);
  await seen("○ reviewer");

  // Room menu → mock-agent → its menu → fast-forward from … → reviewer.
  await press("\x0f", "agent …");
  await press("\r", "pick an agent");
  await press("\r", "mock-agent · mock-agent");
  await press(`${DOWN.repeat(5)}\r`, "fast-forward mock-agent from");
  await press("\r", "mock-agent ← reviewer · fast-forward");
  await press("\r", "moved mock-agent up to reviewer's commit");
  assert.equal(headAt(dev.worktree), revHead);
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal draws an agent's tool calls under its name, and names it once per answer", {
  skip: noPty,
}, async (t) => {
  // The default mock turn: text, a tool call, text, a tool call, text.
  const { child, exited, out } = await chatOnPty(t, `node ${MOCK_AGENT}`);
  child.stdin.write("go\r");
  // The turn's last text; colour codes can split it in the raw output.
  for (const until = Date.now() + 20_000; ; ) {
    if (plainText(out()).includes("</task-result>")) break;
    assert.ok(Date.now() < until, `the turn never finished: ${out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
  const lines = scrollback(out())
    .split("\n")
    .map((l) => l.trim());
  // Each of an agent's lines has its bar, and its heading its harness,
  // role and time (M7-1).
  const isHeading = (l: string) => l.startsWith("▎ mock-agent · ");
  const you = lines.indexOf("▎ you → mock-agent");
  const heading = lines.findIndex(isHeading);
  // The next text folds the call into its run's line (M7-2).
  const tool = lines.indexOf("▎ ▸ 1 tool call · 1 read");
  assert.ok(you !== -1 && you < heading && heading < tool, lines.join("\n"));
  assert.equal(lines.filter(isHeading).length, 1, lines.join("\n"));
});

test("chat.ts on a real terminal follows a second room off screen, switches to its thread, and @name pre-filled reaches it", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out, d, cwd } = await chatOnPty(t);
  const b = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "bob" }],
  });
  assert.equal(b.status, 201, b.body.error?.message);
  // The sidebar polls `GET /rooms` every 5 s.
  await seen("○ bob");
  const bob = b.body.participants[0]?.id as string;
  const sent = await api(
    d,
    "POST",
    `/rooms/${b.body.id}/agents/${bob}/messages`,
    {
      text: "hello-b",
    },
  );
  assert.equal(sent.status, 202);
  // Answered while the first room is on screen: its row marks it, and the
  // count is the answer and the turn end nobody has seen.
  for (const until = Date.now() + 20_000; ; ) {
    const row = plainText(out())
      .split("\n")
      .find((l) => /● bob .*\s2 │/.test(l));
    if (row) break;
    assert.ok(Date.now() < until, `bob's unread row never came: ${out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // Rows: room A, its agent, room B, bob. `alt+down` and two `ctrl+n`s open
  // bob's thread.
  await press("\x1b[1;3B\x0e\x0e", "→ bob");
  await seen("previous: (none)");
  // The where bar follows the view: bob's thread names its branch too. The
  // 100-column pty cuts it after the branch's first letter.
  await seen(" · k");
  // The composer holds "@bob "; no orchestrator is needed for it.
  child.stdin.write("again\r");
  await seen("previous: hello-b");
  // After a send, the thread's @name is back: "more" reaches bob too, though
  // room B has no orchestrator to take a message with no mention.
  child.stdin.write("more\r");
  await seen("previous: again");
  // Deleted by hand, it comes back as well: the restore is synchronous, so
  // `last` can follow the deletes without waiting for a frame.
  child.stdin.write(`${"\x7f".repeat(5)}last\r`);
  await seen("previous: more");
  // An untouched pre-fill follows the view. `alt+up` and `ctrl+p` go back to
  // room A's agent, so the target is it, not bob.
  await press("\x1b[1;3A\x10", "→ mock-agent");
  // A left click on the first row (SGR mouse, 1-based) opens room A's
  // timeline, whose header names the room.
  await press("\x1b[<0;4;2M\x1b[<0;4;2m", "room room-");
  // ctrl+t hides the sidebar; the strip that stands in for it is drawn.
  await press("\x14", "»");
  child.stdin.write("/leave\r");
  await seen("left room");
  assert.equal(await exited, 0, out());
});

test("chat.ts attributes an answer to the roster name, not the harness label", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const c = spawnCli(
    t,
    ["new", "--cmd", REMEMBER, "--name", "alice", "--cwd", cwd],
    "chat.ts",
    { XDG_RUNTIME_DIR: runtime },
  );
  c.child.stdin.end("alpha\n/dismiss\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /alice: previous: \(none\)/);
  assert.doesNotMatch(r.stdout, /mock-agent: previous/);
});

test("piped chat.ts refuses a message with no mention in a room with no orchestrator, and @name reaches the participant", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // Built through the API, so no participant has the orchestrator role.
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "bob" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const c = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("hi\n@Bob, hi\n/dismiss\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /no orchestrator: start with @name/);
  assert.match(r.stdout, /you → bob: hi\nbob: previous: \(none\)/);
});

test("piped chat.ts sends a message with no mention to the orchestrator, and @name to that participant", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "alice", role: "orchestrator" },
      { cmd: REMEMBER, name: "bob" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const c = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("one\n@bob two\nthree\n@alice @bob four\n@bob\n/dismiss\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  // Each answers with its own previous prompt: two memories, one room.
  assert.match(r.stdout, /you → alice: one\nalice: previous: \(none\)/);
  assert.match(r.stdout, /you → bob: two\nbob: previous: \(none\)/);
  // Bob's answer reached alice as a copy (M8-2) before "three" was sent.
  assert.match(r.stdout, /bob → alice: \[copy\] you → bob · end_turn/);
  assert.match(
    r.stdout,
    /you → alice: three\nalice: previous: \[copy\] you → bob/,
  );
  assert.match(r.stderr, /name one participant/);
  assert.match(r.stderr, /nothing to send/);
});

test("chat.ts on a real terminal colours an off-screen stall and question", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime, [], undefined, {
    KAPELLE_STALL_IDLE_MS: "100",
  });
  const cwd = await added(d, await gitRepo(t));
  const first = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  const stalled = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT} --scenario stall`, name: "stuck" }],
  });
  const asking = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  for (const room of [first, stalled, asking]) {
    assert.equal(room.status, 201, room.body.error?.message);
  }
  // The first room is the landing view; the other two stay off screen.
  const screen = await ptyScreen(t, "stty cols 100 rows 30; node cli.ts chat", {
    XDG_RUNTIME_DIR: runtime,
  });
  for (const room of [stalled, asking]) {
    const sent = await api(
      d,
      "POST",
      `/rooms/${room.body.id}/agents/${only(room.body).id}/messages`,
      { text: "go" },
    );
    assert.equal(sent.status, 202, sent.body.error?.message);
  }
  // The question opens its box, and the screen behind it loses its
  // colours: the sidebar row is dim, with no other code up to its border.
  // The row is drawn before the box's title, in the same frame. Esc puts
  // the question aside.
  await screen.seen(" 1 of 1 ━┓");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  assert.match(screen.out(), /\x1b\[2m {4}\? asker [^\x1b]*│/);
  await screen.press("\x1b", "? 1 question · ctrl+o");
  // Yellow is a stall, magenta a question: the mark and the name are one
  // painted piece (M7-3), and a busy row shows its timer at the right.
  await screen.seen("\x1b[33m! stuck");
  await screen.seen("\x1b[35m? asker");
  assert.match(plainText(screen.out()), /! stuck +\d+[sm]/);
  assert.match(plainText(screen.out()), /\? asker +\d+[sm]/);
  // The harness is on the agent's second row, dim, under the name (#332).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  assert.match(screen.out(), / {6}\x1b\[2mmock-agent\x1b\[22m/);
  // Hidden, the sidebar leaves a count of the rooms that need the person.
  await screen.press("\x14", "● 2 rooms");
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal draws a stall warning", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  // The room's watchdog reads the same defaults as a run; 100 ms makes the
  // warning arrive on its 1 s sweep without waiting the usual five minutes.
  const d = await boot(t, runtime, [], undefined, {
    KAPELLE_STALL_IDLE_MS: "100",
  });
  const cwd = await added(d, await gitRepo(t));
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts new --cmd 'node ${MOCK_AGENT} --scenario stall' --name stuck --cwd '${cwd}'`,
    { XDG_RUNTIME_DIR: runtime },
  );
  screen.child.stdin.write("go\r");
  await screen.seen("! stuck: no activity for");
  // The stalled harness never ends its turn, so ^C is the way out.
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal shows a question off screen in the banner, rings the bell once, and a click on the row opens it", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const first = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  const asking = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  for (const room of [first, asking]) {
    assert.equal(room.status, 201, room.body.error?.message);
  }
  // The first room is the landing view; the asker's room is off screen.
  const screen = await ptyScreen(t, "stty cols 100 rows 30; node cli.ts chat", {
    XDG_RUNTIME_DIR: runtime,
  });
  // Typed text keeps the question box shut, so the banner is the signal.
  await screen.press("zzq", "zzq");
  const sent = await api(
    d,
    "POST",
    `/rooms/${asking.body.id}/agents/${only(asking.body).id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("\x1b[35m▌? asker (");
  assert.match(
    plainText(screen.out()),
    /▌\? asker \(\S+\) asks: Write ACP_TEST\.md/,
  );
  // pi-tui ends its links with a BEL too; `plainText` takes those away.
  const bells = () => plainText(screen.out()).split("\x07").length - 1;
  for (const until = Date.now() + 10_000; bells() === 0; ) {
    assert.ok(Date.now() < until, `no bell: ${screen.out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // The banner sits under the timeline row, full width (#242).
  const bannerRow = () => rowOf(screen.out(), /▌\? asker/);
  assert.ok(bannerRow() > 1, `under the timeline: ${screen.out()}`);
  // Below 120 columns the side view takes the timeline's place; the banner
  // still shows under it.
  await screen.press("\x18", "side view");
  assert.ok(bannerRow() > 1, `under the side view: ${screen.out()}`);
  // At 100 columns the question count leaves room for three hints only:
  // `ctrl+t rooms` and `ctrl+x view` drop (M7-1). `ctrl+o menu` shows only
  // with the side view hidden.
  await screen.press("\x18", "enter to send · ctrl+o menu");
  const row = bannerRow();
  await screen.press(`\x1b[<0;40;${row}M\x1b[<0;40;${row}m`, " 1 of 1 ━┓");
  await screen.seen("→ asker");
  assert.equal(bells(), 1, "one bell for one participant that waits");
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal lists the person's messages on ctrl+r, lights the row under the mouse, and a pick jumps", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // 130 columns: the side view sits beside the timeline, from column 79.
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts new --cmd '${REMEMBER}' --cwd '${cwd}'`,
    { XDG_RUNTIME_DIR: runtime },
  );
  screen.child.stdin.write("alpha\r");
  await screen.seen("previous: (none)");
  screen.child.stdin.write("beta\r");
  await screen.seen("previous: alpha");
  await screen.press("\x12", "history · 1 of 2");
  await screen.seen("→ mock-agent: alpha");
  await screen.press("\x1b[B", "history · 2 of 2");
  // A move with no button over the first row lights it.
  await screen.press("\x1b[<35;90;2M", "history · 1 of 2");
  await screen.press("\x1b[<0;90;3M\x1b[<0;90;3m", "history · 2 of 2");
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

/**
 * A room with 15 messages sent, attached on a pseudo-terminal 16 rows high,
 * so the history list shows fewer rows than it has. At 120 columns and more
 * the side view sits beside the timeline; below, it takes its place.
 */
async function fifteenSent(t: TestContext, cols: number) {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols ${cols} rows 16; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  const path = `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`;
  const send = async (text: string) => {
    const sent = await api(d, "POST", path, { text });
    assert.equal(sent.status, 202, sent.body.error?.message);
  };
  for (let i = 1; i <= 15; i++) await send(`m${i}`);
  await screen.seen("previous: m14");
  return { ...screen, send };
}

/**
 * Writes `keys`, and waits for the history title to name a row other than
 * `was` in what is drawn after them. Checks that the lit row is the one the
 * title names, and returns it.
 */
async function lightMoves(
  screen: Awaited<ReturnType<typeof ptyScreen>>,
  keys: string,
  of: number,
  was: number,
): Promise<number> {
  const from = screen.out().length;
  screen.child.stdin.write(keys);
  // Every title drawn, not the first: a repaint at a turn's end can draw
  // the title with `was` before the keys act.
  const title = new RegExp(`history · (\\d+) of ${of}`, "g");
  for (const until = Date.now() + 10_000; ; ) {
    const drawn = screen.out().slice(from);
    const at = [...plainText(drawn).matchAll(title)]
      .map((m) => Number(m[1]))
      .find((n) => n !== was);
    if (at !== undefined) {
      assert.match(drawn, new RegExp(`\\x1b\\[7m→ mock-agent: m${at} `));
      return at;
    }
    assert.ok(Date.now() < until, drawn);
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

test("chat.ts on a real terminal maps the mouse to the right row of a history list that scrolled", {
  skip: noPty,
}, async (t) => {
  const screen = await fifteenSent(t, 130);
  await screen.press("\x12", "history · 1 of 15");
  // A key's release is not a second press. A terminal with the kitty
  // keyboard protocol sends both.
  await screen.press("\x1b[6;1:3~\x1b[B", "history · 2 of 15");
  // To the end: the list scrolls. Page Down reaches the list, not only
  // the timeline (#228).
  await screen.press("\x1b[6~".repeat(14), "history · 15 of 15");
  // The mouse on the list's top row, row 2 of the screen, is not message 1.
  const n = await lightMoves(screen, "\x1b[<35;90;2M", 15, 15);
  assert.ok(n > 1, `the top row is message ${n}`);
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal keeps the wheel over the side view out of the timeline, and the page keys with the composer", {
  skip: noPty,
}, async (t) => {
  const { send, ...screen } = await fifteenSent(t, 130);
  // Ten wheel turns up over the side view, at column 90.
  const wheelUp = "\x1b[<64;90;5M".repeat(10);
  // An empty view, then a list at its top: the wheel stops there. A
  // timeline it moved would stop following, and draw no new answer.
  await screen.press("\x18", "nothing here yet");
  screen.child.stdin.write(wheelUp);
  await send("m16");
  await screen.seen("previous: m15");
  await screen.press("\x12", "history · 1 of 16");
  screen.child.stdin.write(wheelUp);
  await send("m17");
  await screen.seen("previous: m16");
  // The wheel down scrolls the list, and the light stays on a row in view.
  await lightMoves(screen, "\x1b[<65;90;5M".repeat(10), 17, 1);
  // With the keys at the composer, the page keys scroll the timeline: up
  // to the notice on its first lines, and down to its end, where it
  // follows again.
  await screen.press("\x1d", "ctrl+] keys here");
  await screen.press("\x1b[5~".repeat(20), "no measured labels");
  await screen.press("\x1b[6~".repeat(20), "previous: m16");
  await send("m18");
  await screen.seen("previous: m17");
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a narrow real terminal sends the page keys with the composer to the side view in the timeline's place", {
  skip: noPty,
}, async (t) => {
  const screen = await fifteenSent(t, 100);
  await screen.press("\x12", "history · 1 of 15");
  await screen.press("\x1d", "ctrl+] keys here");
  // A page is the view's height less one row. That height moves with the
  // rows under the composer, so the test asks only that the light left row 1.
  await lightMoves(screen, "\x1b[6~", 15, 1);
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal completes a leading @ to a participant's name", {
  skip: noPty,
}, async (t) => {
  const { child, seen, press, exited, out } = await chatOnPty(t);
  await press("@", "@mock-agent");
  // Tab takes the name; the message then reaches that participant.
  await press("\t", "→ mock-agent");
  child.stdin.write("hi\r");
  await seen("previous: (none)");
  child.stdin.write("/leave\r");
  await seen("left room");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal answers a question in its pop-up, and a piped observer sees the same decision", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT}`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  // The CLI observer (M4-3): a piped attach on the same room.
  const observer = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  let watched = "";
  observer.child.stdout.on("data", (c: string) => {
    watched += c;
  });
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);

  // The box opens by itself, with who wants what in its title (M7-4) and
  // the tool's input, and deny comes first.
  await screen.seen("\x1b[7m\x1b[33m asker wants to edit ");
  await screen.seen("edit · Write ACP_TEST.md");
  await screen.seen("path: ACP_TEST.md");
  const write = await pendingOne(d);
  // `y` only moves the cursor to allow (M7-4): nothing is sent yet.
  await screen.press("y", "2 allow");
  const decided = async (id: string) =>
    (await api<PermissionDecision>(d, "GET", `/permissions/${id}`)).body;
  assert.equal((await decided(write.id)).allow, undefined);
  // Enter answers. The next question opens in its place.
  await screen.press("\r", "Delete something");
  const del = await pendingOne(d);
  assert.notEqual(del.id, write.id);
  // A sentence typed into the box ends on deny (decided 2026-10-13), even
  // from allow, and a stray Enter says no.
  await screen.press("2", "→ 2 allow");
  await screen.press("try it", "→ 1 deny");
  // Shift+1 as xterm and tmux send it under modifyOtherKeys is typed text
  // too, so `okay!⏎` ends on deny.
  await screen.press("2", "→ 2 allow");
  await screen.press("\x1b[27;2;33~", "→ 1 deny");
  screen.child.stdin.write("\r");
  for (const until = Date.now() + 20_000; ; ) {
    if (watched.includes("asker: denied (client)")) break;
    assert.ok(Date.now() < until, watched);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.deepEqual(
    [(await decided(write.id)).allow, (await decided(write.id)).reason],
    [true, "client"],
  );
  assert.deepEqual(
    [(await decided(del.id)).allow, (await decided(del.id)).reason],
    [false, "client"],
  );
  assert.match(
    watched,
    /\? asker asks: Write ACP_TEST\.md\n {2}asker: allowed \(client\)\n/,
  );
  assert.match(
    watched,
    /\? asker asks: Delete something[^\n]*\n {2}asker: denied \(client\)\n/,
  );
  observer.child.stdin.end("/leave\n");
  assert.equal((await observer.done).code, 0);
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal keeps a question waiting while the person types, and closes its box when another client answers", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
    // The warning is long: the key hints drop (M7-1).
    "no orchestrator",
  );
  // Text in the composer: the box must not take the next keys.
  await screen.press("@asker hel", "→ asker");
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("? 1 question · ctrl+o");
  assert.doesNotMatch(plainText(screen.out()), / 1 of 1 ━┓/);
  // The menu lists it first; Enter opens its box.
  await screen.press("\x0f", "? asker asks: Write ACP_TEST.md");
  await screen.press("\r", " 1 of 1 ━┓");
  const write = await pendingOne(d);
  const other = await api(d, "POST", `/permissions/${write.id}`, {
    allow: true,
  });
  assert.equal(other.status, 200, other.body.error?.message);
  await screen.seen("asker's question closed: allowed (client)");
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal opens over a thread's @name pre-fill, and Esc puts the question aside", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT}`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.seen("○ asker");
  // alt+down opens the thread, so the composer holds exactly `@asker `.
  // That pre-fill is not typed text: the question must open by itself.
  await screen.press("\x1b[1;3B", "@asker");
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("edit · Write ACP_TEST.md");
  // Esc puts it aside: the box goes and the status line counts it. `press`
  // reads only what is drawn after the key, and waits out pi-tui's alt-key
  // window for a bare Esc.
  await screen.press("\x1b", "? 1 question · ctrl+o");
  // A decision from elsewhere closes it, and Esc already stopped it from
  // reopening.
  const q = await pendingOne(d);
  const other = await api(d, "POST", `/permissions/${q.id}`, { allow: true });
  assert.equal(other.status, 200, other.body.error?.message);
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal says why a lost answer lost, keeps the box's count true, and refuses a closed question from the menu", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const roomId = "room-fake";
  const room = {
    id: roomId,
    cwd: process.cwd(),
    status: "active",
    title: "fake room",
    updatedAt: new Date().toISOString(),
    participants: [
      {
        id: "p1",
        name: "asker",
        harness: "mock-agent",
        role: "orchestrator",
        mode: "ask",
        status: "busy",
        notices: [],
      },
    ],
  };
  // A second room, not the one on screen, to be dismissed with its
  // question's box open.
  const other = {
    ...room,
    id: "room-other",
    title: "other room",
    participants: [{ ...room.participants[0], id: "p2", name: "shipper" }],
  };
  let answered = false;
  const posted: string[] = [];
  // Each room's event stream, so the test can send more lines.
  let stream: ServerResponse | undefined;
  let otherStream: ServerResponse | undefined;
  const event = (
    seq: number,
    update: object,
    where = { roomId, participantId: "p1" },
  ) => `id: ${seq}\ndata: ${JSON.stringify({ seq, ...where, update })}\n\n`;
  const fake = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ apiVersion: API_VERSION }));
      return;
    }
    if (path === "/harnesses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (path === "/rooms") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([room, other]));
      return;
    }
    if (path === `/rooms/${roomId}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(room));
      return;
    }
    if (path === `/rooms/${other.id}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(other));
      return;
    }
    if (path === `/rooms/${other.id}/events`) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      otherStream = res;
      const where = { roomId: other.id, participantId: "p2" };
      res.write(
        event(
          1,
          {
            sessionUpdate: "_client_participant_added",
            name: "shipper",
            harness: "mock-agent",
            mode: "ask",
          },
          where,
        ),
      );
      return;
    }
    if (path === `/rooms/${roomId}/events`) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      stream = res;
      res.write(
        event(1, {
          sessionUpdate: "_client_participant_added",
          name: "asker",
          harness: "mock-agent",
          role: "orchestrator",
          mode: "ask",
        }),
      );
      res.write(
        event(2, {
          sessionUpdate: "_client_permission_queued",
          id: "q1",
          kind: "edit",
          title: "Write ACP_TEST.md",
          input: { path: "ACP_TEST.md" },
        }),
      );
      return;
    }
    if (req.method === "POST") posted.push(path);
    if (req.method === "POST" && path === "/permissions/q1") {
      answered = true;
      res.writeHead(409, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "already_decided",
            message: "permission q1 was already decided",
          },
        }),
      );
      return;
    }
    if (req.method === "GET" && path === "/permissions/q1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "q1",
          roomId,
          participantId: "p1",
          turn: 1,
          kind: "edit",
          title: "Write ACP_TEST.md",
          input: { path: "ACP_TEST.md" },
          allow: false,
          reason: "timeout",
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: { code: "no_route", message: `no ${path}` } }),
    );
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  t.after(() => fake.close());
  const { port } = fake.address() as AddressInfo;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: process.pid, port, token: "t" }),
    { mode: 0o600 },
  );
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${roomId}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.seen("edit · Write ACP_TEST.md");
  // A second question while the box is open: its count follows.
  stream?.write(
    event(3, {
      sessionUpdate: "_client_permission_queued",
      id: "q2",
      kind: "delete",
      title: "Delete something",
      // Longer than the box: its end must wrap into view, not be cut.
      // A path has no space: only a wrap that breaks inside a word shows
      // its last 80 characters, the Z's, at all.
      input: {
        command: `rm -rf build/${"x".repeat(100)} END-OF-COMMAND`,
        path: `/${"y".repeat(220)}${"Z".repeat(80)}`,
      },
    }),
  );
  await screen.seen(" 1 of 2 ━┓");
  // Esc means away: the next question waits too, and both are counted.
  await screen.press("\x1b", "? 2 questions · ctrl+o");
  await screen.press("\x0f", "? asker asks: Delete something");
  await screen.press("\r", " 1 of 2 ━┓");
  await screen.press("\r", "already closed: timeout");
  assert.ok(answered, "the TUI posted the answer");
  // q1 never closed on this stream, so q2 opens as the second of two. Its
  // close comes now: q2 is the only one left.
  await screen.seen(" 2 of 2 ━┓");
  await screen.seen("END-OF-COMMAND");
  await screen.seen("Z".repeat(20));
  stream?.write(
    event(4, {
      sessionUpdate: "_client_permission_answered",
      id: "q1",
      allow: false,
      reason: "timeout",
    }),
  );
  await screen.press("", " 1 of 1 ━┓");
  // Put q2 aside, list it, then it closes while the menu is open: picking
  // it says so and closes the menu.
  await screen.press("\x1b", "? 1 question · ctrl+o");
  await screen.press("\x0f", "? asker asks: Delete something");
  stream?.write(
    event(5, {
      sessionUpdate: "_client_permission_answered",
      id: "q2",
      allow: false,
      reason: "cancel",
    }),
  );
  await screen.seen("denied (cancel)");
  await screen.press("\r", "that question already closed");
  // A question in the other room opens its box. Its title is far taller
  // than the box: the answer rows and their hint must still be drawn. That
  // room is then dismissed with no close line: the box must go with it.
  const before = screen.out().length;
  otherStream?.write(
    event(
      2,
      {
        sessionUpdate: "_client_permission_queued",
        id: "q3",
        kind: "execute",
        title: `Ship it ${"now ".repeat(1000)}`,
      },
      { roomId: other.id, participantId: "p2" },
    ),
  );
  await screen.seen("execute · Ship it");
  for (const until = Date.now() + 20_000; ; ) {
    if (screen.out().slice(before).includes("enter answer")) break;
    assert.ok(Date.now() < until, "the answer rows were pushed out of the box");
    await new Promise((ok) => setTimeout(ok, 50));
  }
  other.status = "dismissed";
  otherStream?.end();
  await screen.seen("other room was dismissed");
  screen.child.stdin.write("\r");
  await new Promise((ok) => setTimeout(ok, 500));
  assert.ok(!posted.includes("/permissions/q3"), posted.join(" "));
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

/** One changed file, for the M7-3 fake-daemon tests. */
const CHANGES_TEXT = [
  "diff --git a/cli.ts b/cli.ts",
  "@@ -1 +1,2 @@",
  "-old",
  "+new",
  "+more",
].join("\n");

/** Two changed files, so a click on the second proves the jump (M7-3). */
const TWO_CHANGES_TEXT = [
  ...CHANGES_TEXT.split("\n"),
  "diff --git a/other.ts b/other.ts",
  "new file mode 100644",
  "@@ -0,0 +1 @@",
  "+x",
].join("\n");

/**
 * A fake daemon with one room `room-changes` and one participant `p1`
 * (M7-3): the diff route counts its calls, and the test can write more
 * event lines into the one stream. `files` is the route's count, `failAt`
 * refuses that call, `holdAt` holds that call's reply until `release()`,
 * and `later` is what calls after the first answer with.
 */
async function fakeChangesRoom(
  t: TestContext,
  text: string,
  {
    files = 1,
    failAt,
    holdAt,
    later,
  }: {
    files?: number;
    failAt?: number;
    holdAt?: number;
    later?: { text: string; files: number };
  } = {},
) {
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const roomId = "room-changes";
  const room = {
    id: roomId,
    cwd: process.cwd(),
    status: "active",
    title: "change room",
    updatedAt: new Date().toISOString(),
    participants: [
      {
        id: "p1",
        name: "ann",
        harness: "mock-agent",
        role: "orchestrator",
        mode: "ask",
        status: "busy",
        notices: [],
      },
    ],
  };
  let stream: ServerResponse | undefined;
  const diffs: string[] = [];
  const held: (() => void)[] = [];
  const event = (seq: number, update: object) =>
    `id: ${seq}\ndata: ${JSON.stringify({ seq, roomId, participantId: "p1", update })}\n\n`;
  const fake = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ apiVersion: API_VERSION }));
      return;
    }
    if (path === "/harnesses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (path === "/rooms") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([room]));
      return;
    }
    if (path === `/rooms/${roomId}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(room));
      return;
    }
    if (path === `/rooms/${roomId}/events`) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      stream = res;
      res.write(
        event(1, {
          sessionUpdate: "_client_participant_added",
          name: "ann",
          harness: "mock-agent",
          role: "orchestrator",
          mode: "ask",
        }),
      );
      return;
    }
    if (path.startsWith(`/rooms/${roomId}/agents/p1/diff`)) {
      diffs.push(path);
      const call = diffs.length;
      if (call === failAt) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "no_diff", message: "no branch to compare with" },
          }),
        );
        return;
      }
      const body =
        call > 1 && call !== holdAt && later ? later : { text, files };
      const answer = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...body, added: 2, removed: 1 }));
      };
      if (call === holdAt) {
        held.push(answer);
        return;
      }
      answer();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: { code: "no_route", message: `no ${path}` } }),
    );
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  t.after(() => fake.close());
  const { port } = fake.address() as AddressInfo;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: process.pid, port, token: "t" }),
    { mode: 0o600 },
  );
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${roomId}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  return {
    screen,
    diffs,
    event,
    write: (line: string) => stream?.write(line),
    release: () => {
      for (const answer of held.splice(0)) answer();
    },
  };
}

test("chat.ts on a real terminal loads the changed files once per turn end or exit, never per chunk", {
  skip: noPty,
}, async (t) => {
  const { screen, diffs, event, write } = await fakeChangesRoom(
    t,
    CHANGES_TEXT,
  );
  // The room's timeline opens first; alt+down opens ann's thread, which
  // loads the files once.
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  await screen.seen("changed files");
  assert.equal(diffs.length, 1, diffs.join("\n"));
  assert.match(diffs[0] ?? "", /against=base/);
  // A chunk is not a turn end: two of them load nothing.
  write(
    event(2, { sessionUpdate: "_client_user_message", text: "go", turn: 1 }),
  );
  write(
    event(3, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "one" },
    }),
  );
  write(
    event(4, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " two" },
    }),
  );
  await screen.seen("one two");
  assert.equal(diffs.length, 1, "a chunk loaded the files");
  write(
    event(5, { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" }),
  );
  for (const until = Date.now() + 20_000; diffs.length < 2; ) {
    assert.ok(
      Date.now() < until,
      `no diff call on the turn end: ${diffs.join("\n")}`,
    );
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.match(diffs[1] ?? "", /against=base/);
  // An exit ends the work too: one more call, not a second per turn end.
  write(event(6, { sessionUpdate: "_client_harness_exited", pid: 1 }));
  for (const until = Date.now() + 20_000; diffs.length < 3; ) {
    assert.ok(
      Date.now() < until,
      `no diff call on the exit: ${diffs.join("\n")}`,
    );
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.match(diffs[2] ?? "", /against=base/);
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts keeps the newest changed files when a crash's two loads land out of order", {
  skip: noPty,
}, async (t) => {
  const { screen, diffs, event, write, release } = await fakeChangesRoom(
    t,
    CHANGES_TEXT,
    { holdAt: 2, later: { text: TWO_CHANGES_TEXT, files: 2 } },
  );
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  await screen.seen("changed files");
  assert.equal(diffs.length, 1, diffs.join("\n"));
  // A crash reports its exit before the turn it broke ends. Send the exit,
  // wait for its held request, then send the turn end: the older request
  // arrives before the newer one, so the guard sees a known order.
  write(event(2, { sessionUpdate: "_client_harness_exited", pid: 1 }));
  for (const until = Date.now() + 20_000; diffs.length < 2; ) {
    assert.ok(Date.now() < until, `no held diff call: ${diffs.join("\n")}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  write(event(3, { sessionUpdate: "_client_turn_ended", stopReason: "error" }));
  for (const until = Date.now() + 20_000; diffs.length < 3; ) {
    assert.ok(Date.now() < until, `no third diff call: ${diffs.join("\n")}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  await screen.seen("A other.ts");
  // The held, older reply lands last and must not replace the newer block.
  release();
  await new Promise((ok) => setTimeout(ok, 500));
  const shown = () => [...screenRows(screen.out()).values()].join("\n");
  assert.match(
    shown(),
    /A other\.ts/,
    "the older reply replaced the newer one",
  );
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal opens a clicked changed file in the side view", {
  skip: noPty,
}, async (t) => {
  const { screen } = await fakeChangesRoom(t, TWO_CHANGES_TEXT, { files: 2 });
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  await screen.seen("changed files");
  const row = rowOf(screen.out(), /A other\.ts/);
  assert.ok(row > 0, screen.out());
  // A click on the second file's row opens the side pane there, not the top.
  await screen.press(
    `\x1b[<0;6;${row}M\x1b[<0;6;${row}m`,
    "whole branch · other.ts (new) (2 of 2)",
  );
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal drops the changed-files block when the diff route refuses", {
  skip: noPty,
}, async (t) => {
  const { screen, diffs, event, write } = await fakeChangesRoom(
    t,
    CHANGES_TEXT,
    { failAt: 2 },
  );
  await screen.seen("○ ann");
  await screen.press("\x1b[1;3B", "@ann");
  await screen.seen("changed files");
  assert.equal(diffs.length, 1, diffs.join("\n"));
  // The reload after the turn ends gets a 409 no_diff: no block, no stale one.
  write(
    event(2, { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" }),
  );
  for (const until = Date.now() + 20_000; diffs.length < 2; ) {
    assert.ok(Date.now() < until, `no diff call: ${diffs.join("\n")}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  // The current screen, not the frames the block was drawn in.
  const shown = () => [...screenRows(screen.out()).values()].join("\n");
  for (const until = Date.now() + 20_000; shown().includes("M cli.ts"); ) {
    assert.ok(Date.now() < until, `the block survived a refusal: ${shown()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.doesNotMatch(shown(), /changed files/);
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a short terminal keeps the question's action in its box", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  // 12 rows leave the box room for one line of what is asked: it must be
  // the action, not a `…` in its place.
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 12; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
    // The warning is long: the key hints drop (M7-1).
    "no orchestrator",
  );
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("edit · Write ACP_TEST.md");
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts attach on a real terminal opens the room it names, not the first", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const ids: string[] = [];
  for (const _ of [1, 2]) {
    const r = await api<RoomReply>(
      d,
      "POST",
      "/rooms",
      withAgent(cwd, REMEMBER),
    );
    assert.equal(r.status, 201, r.body.error?.message);
    ids.push(r.body.id);
  }
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${ids[1]}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.seen(`room ${ids[1]} ·`);
  screen.child.stdin.write("/leave\r");
  await screen.seen(`left room ${ids[1]}`);
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal moves an untouched thread @name to a new name", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("\x1b[1;3B", "@mock-agent");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const agent = room?.participants[0]?.id as string;
  const renamed = await api(d, "PATCH", `/rooms/${room?.id}/agents/${agent}`, {
    name: "bob",
  });
  assert.equal(renamed.status, 200, renamed.body.error?.message);
  await seen("→ bob");
  child.stdin.write("hi\r");
  await seen("previous: (none)");
  child.stdin.write("\x03");
  assert.equal(await exited, 0, out());
});

test("kapelle chat runs chat.ts", async (t) => {
  const r = await runCli(t, ["chat", "--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /node chat\.ts new --agent/);
});

test("kapelle chat takes a flag whose value is also a verb", async (t) => {
  // The dispatcher must remove the verb's own argv word, not the first
  // literal "chat", which here is `--name`'s value.
  const r = await runCli(t, [
    "--name",
    "chat",
    "--cwd",
    "/tmp",
    "chat",
    "--help",
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /node chat\.ts new --agent/);
});

test("kapelle chat opens the first room, and below 76 columns the sidebar starts hidden", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);

  const screen = await ptyScreen(t, "stty cols 60 rows 30; node cli.ts chat", {
    XDG_RUNTIME_DIR: runtime,
  });
  // Without a verb, the first active room's timeline is the landing view.
  await screen.seen(`room ${open.body.id}`);
  // Below 76 columns there is no sidebar, only the strip that opens it.
  assert.ok(screen.out().includes("»"), "the strip is hidden");
  assert.ok(!screen.out().includes("«"), "the sidebar header is hidden");
  // ctrl+t shows it, with the roster; ctrl+t hides it again.
  await screen.press("\x14", "«");
  await screen.seen("○ mock-agent");
  await screen.press("\x14", "»");
  // The timeline's composer is empty, so /leave is a command.
  screen.child.stdin.write("/leave\r");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("kapelle chat with no rooms opens the screen, and says how to open one", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  screen.child.stdin.write("\x03");
  await screen.seen("left the chat");
  assert.equal(await screen.exited, 0, screen.out());
});

test("kapelle chat with no rooms refuses /add on the status line, and leave in the menu ends the chat", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await screen.press("/add\r", "no room: open one first");
  // The menu's last row is leave; up from the first one wraps to it. The
  // keys reach the screen in order, so Enter picks the row up moved to.
  await screen.press("\x0f", "leave");
  await screen.press("\x1b[A", "leave");
  screen.child.stdin.write("\r");
  await screen.seen("left the chat");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal hides the sidebar with a click on «, and shows it with a click on »", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  // SGR mouse, 1-based: the « sits at the end of the sidebar's first row.
  await press("\x1b[<0;30;1M\x1b[<0;30;1m", "»");
  await press("\x1b[<0;1;1M\x1b[<0;1;1m", "rooms");
  child.stdin.write("\x03");
  await seen("left room");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal opens a question that came behind the menu once the menu closes", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "asker", mode: "ask" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const asker = only(open.body);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
    // The warning is long: the key hints drop (M7-1).
    "no orchestrator",
  );
  // The menu; its key hints dropped beside the long warning.
  await screen.press("\x0f", "new room …");
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${asker.id}/messages`,
    { text: "go" },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  // It never opens over another pop-up: it waits on the status line, which
  // wraps here, so the "? " can sit on the row above.
  await screen.seen("1 question · ctrl+o");
  assert.doesNotMatch(plainText(screen.out()), / 1 of 1 ━┓/);
  await screen.press("\x1b", " 1 of 1 ━┓");
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("an ask participant asks through /permissions, and nobody answering denies it at the timeout", async (t) => {
  const d = await boot(t, undefined, ["--permission-timeout", "2"]);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const { id } = (await api<RoomReply>(d, "POST", "/rooms", { cwd })).body;
  const alice = await addAgent(d, id, {
    cmd: `node ${MOCK_AGENT}`,
    name: "alice",
    role: "orchestrator",
    mode: "ask",
  });
  assert.equal(alice.mode, "ask");

  const sent = await api(d, "POST", `/rooms/${id}/messages`, { text: "go" });
  assert.equal(sent.status, 202, sent.body.error?.message);
  const first = (await pendingOne(d)) as unknown as Record<string, unknown>;
  assert.deepEqual(
    { ...first, id: undefined },
    {
      id: undefined,
      roomId: id,
      participantId: alice.id,
      turn: 1,
      kind: "edit",
      title: "Write ACP_TEST.md",
      input: { path: "ACP_TEST.md" },
    },
  );
  const allowed = await api(d, "POST", `/permissions/${first.id}`, {
    allow: true,
  });
  assert.equal(allowed.status, 200, allowed.body.error?.message);
  assert.equal(
    (await api(d, "POST", `/permissions/${first.id}`, { allow: false })).status,
    409,
  );

  // The second question (the delete) waits for nobody: the 2 s timeout.
  const second = await pendingOne(d);
  assert.notEqual(second.id, first.id);
  let closed: PermissionDecision | undefined;
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    closed = (
      await api<PermissionDecision>(d, "GET", `/permissions/${second.id}`)
    ).body;
    if (closed.reason) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.deepEqual([closed?.allow, closed?.reason], [false, "timeout"]);

  const log = (
    await readFile(join(stateDirFor(root), "rooms", id, "events.jsonl"), "utf8")
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  // Both permission events are in the room log, under the participant.
  assert.deepEqual(
    log
      .filter((e) => e.update.sessionUpdate === "_client_permission_queued")
      .map((e) => [e.participantId, e.update.id]),
    [
      [alice.id, first.id],
      [alice.id, second.id],
    ],
  );
  const answered = log.filter(
    (e) => e.update.sessionUpdate === "_client_permission_answered",
  );
  assert.deepEqual(
    answered.map((e) => [e.participantId, e.update.reason]),
    [
      [alice.id, "client"],
      [alice.id, "timeout"],
    ],
  );
  assert.equal(
    log.find((e) => e.update.sessionUpdate === "_client_user_message")?.update
      .turn,
    1,
  );

  const changed = await api<ParticipantDto & RoomReply>(
    d,
    "PATCH",
    `/rooms/${id}/agents/${alice.id}`,
    { mode: "safe" },
  );
  assert.equal(changed.status, 200, changed.body.error?.message);
  assert.equal(changed.body.mode, "safe");
});

test("chat.ts on a real terminal keeps a thread's @name whole after Enter on it alone", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("\x1b[1;3B", "@mock-agent");
  await press("\r", "nothing to send");
  // The editor trims what it submits. Giving back "@mock-agent" with no
  // space would make this "@mock-agentx", a name nobody has.
  await press("x\r", "previous: (none)");
  child.stdin.write("\x03");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal gives a bare @name back with its space on the timeline too", {
  skip: noPty,
}, async (t) => {
  const { child, press, exited, out } = await chatOnPty(t);
  // The timeline pre-fills nothing: the person typed this mention.
  await press("@mock-agent \r", "nothing to send");
  // The editor trims what it submits; without the space back, this would
  // be "@mock-agentx".
  await press("x\r", "previous: (none)");
  child.stdin.write("\x03");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal takes /dismiss after a thread's @name", {
  skip: noPty,
}, async (t) => {
  // In a thread the composer always holds `@name `, so a command typed there
  // is `@name /dismiss`. It must act, not reach the agent as a prompt.
  const { press, seen, exited, out } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("\x1b[1;3B", "@mock-agent");
  // The last room gone, the screen stays, empty, until ^C (M4-5).
  await press("/dismiss\r", "ctrl+o → new room");
  await press("\x03", "left the chat");
  assert.equal(await exited, 0, out());
  assert.doesNotMatch(plainText(out()), /you → mock-agent/);
});

test("piped chat.ts takes /leave after an @name, as the screen does", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("@mock-agent /leave\nnever sent\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /you → /);
});

test("chat.ts on a real terminal falls back to the timeline when the open thread's participant is removed", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const bob = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room?.id}/agents`,
    {
      cmd: REMEMBER,
      name: "bob",
    },
  );
  assert.equal(bob.status, 201);
  await seen("○ bob");
  // Rows: the room, mock-agent, bob. Two steps down open bob's thread.
  await press("\x1b[1;3B\x1b[1;3B", "@bob");
  // Looked for from before the DELETE: the screen may switch before the
  // daemon's reply arrives.
  const from = out().length;
  const gone = await api(
    d,
    "DELETE",
    `/rooms/${room?.id}/agents/${bob.body.id}`,
  );
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  // The timeline's header names the room, and its target is the orchestrator.
  for (const until = Date.now() + 20_000; ; ) {
    if (out().slice(from).includes("room room-")) break;
    assert.ok(Date.now() < until, `still in bob's thread: ${out()}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  await press("hi\r", "previous: (none)");
  child.stdin.write("\x03");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a real terminal shows the checkout of a participant added after it started", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const carol = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room?.id}/agents`,
    { cmd: REMEMBER, name: "carol" },
  );
  assert.equal(carol.status, 201);
  await seen("○ carol");
  // The thread header names the checkout, from `GET /rooms/:id`; the path
  // itself wraps, so the " · " before it is what shows it was read.
  await press("\x1b[1;3B\x1b[1;3B", "carol (mock-agent) · ");
  child.stdin.write("\x03");
  assert.equal(await exited, 0, out());
});

test("chat.ts on a terminal under 8 columns shows the sidebar without failing", {
  skip: noPty,
}, async (t) => {
  // pi-tui measures each part at the full width first, so the sidebar is
  // drawn at 7 columns once, though its own width is 32.
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const screen = await ptyScreen(
    t,
    `stty cols 7 rows 30; node chat.ts new --cmd '${REMEMBER}' --cwd '${cwd}'`,
    { XDG_RUNTIME_DIR: runtime },
    "»",
  );
  // Only the sidebar's first 7 columns fit: `── room` of its header, the
  // title cyan.
  await screen.press("\x14", "\x1b[36mroom");
  screen.child.stdin.write("\x03");
  assert.equal(await screen.exited, 0, screen.out());
  assert.doesNotMatch(screen.out(), /screen failed/);
});

test("kapelle chat takes the global --quiet and --verbose", async (t) => {
  const r = await runCli(t, ["chat", "--quiet", "--verbose", "--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /node chat\.ts new --agent/);
});

test("chat.ts on a real terminal drops a removed participant's notices from the timeline", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const bob = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${room?.id}/agents`,
    {
      cmd: REMEMBER,
      name: "bob",
    },
  );
  assert.equal(bob.status, 201);
  await seen("○ bob");
  const gone = await api(
    d,
    "DELETE",
    `/rooms/${room?.id}/agents/${bob.body.id}`,
  );
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  // Away and back redraws the timeline, header and notices included.
  await press("\x1b[1;3B", "@mock-agent");
  await press("\x1b[1;3A", "room room-");
  child.stdin.write("/leave\r");
  assert.equal(await exited, 0, out());
  // Each mock participant has one "no measured labels" notice; the
  // transcript left in scrollback is the timeline's.
  const notices = scrollback(out()).match(/no measured labels/g) ?? [];
  assert.equal(notices.length, 1, scrollback(out()));
});

test("a room fast-forwards a target to a source, previews it, and logs the move", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "dev", role: "orchestrator" }],
  });
  assert.equal(open.status, 201, JSON.stringify(open.body));
  const roomId = open.body.id;
  const dev = only(open.body);
  await commitAt(dev.worktree, "dev.txt");

  const addedRev = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${roomId}/agents`,
    { cmd: REMEMBER, name: "reviewer", base: dev.branch },
  );
  assert.equal(addedRev.status, 201, JSON.stringify(addedRev.body));
  const reviewer = addedRev.body;
  await commitAt(reviewer.worktree, "review.txt");
  const revHead = headAt(reviewer.worktree);

  const preview = await api<Diff>(
    d,
    "GET",
    `/rooms/${roomId}/agents/${dev.id}/fast-forward?from=${reviewer.id}`,
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.files, 1, JSON.stringify(preview.body));
  assert.match(preview.body.text, /review\.txt/);

  const moved = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
    { from: reviewer.id },
  );
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.branch, dev.branch);
  assert.equal(headAt(dev.worktree), revHead);
  assert.equal(headAt(reviewer.worktree), revHead, "the source is untouched");
  assert.ok(existsSync(join(dev.worktree, "review.txt")));

  await api(d, "POST", `/rooms/${roomId}/dismiss`);
  const events = await roomEvents(d, roomId);
  const forwarded = events.filter(
    (e) => e.update.sessionUpdate === "_client_participant_fast_forwarded",
  );
  assert.deepEqual(
    forwarded.map((e) => e.update),
    [
      {
        sessionUpdate: "_client_participant_fast_forwarded",
        from: reviewer.id,
        branch: dev.branch,
        sha: revHead,
      },
    ],
  );
});

test("a fast-forward refuses a busy or dirty target and a diverged one, with codes", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  type Refusal = { error: { code: string; message: string } };

  const pair = async (devCmd = REMEMBER) => {
    const open = await api<RoomReply>(d, "POST", "/rooms", {
      cwd,
      agents: [{ cmd: devCmd, name: "dev", role: "orchestrator" }],
    });
    assert.equal(open.status, 201, JSON.stringify(open.body));
    const dev = only(open.body);
    const addedRev = await api<ParticipantDto>(
      d,
      "POST",
      `/rooms/${open.body.id}/agents`,
      { cmd: REMEMBER, name: "reviewer", base: dev.branch },
    );
    assert.equal(addedRev.status, 201, JSON.stringify(addedRev.body));
    return { roomId: open.body.id, dev, reviewer: addedRev.body };
  };

  // A busy target is refused before anything else.
  {
    const { roomId, dev, reviewer } = await pair(
      `node ${MOCK_AGENT} --scenario slow`,
    );
    const sent = await api(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/messages`,
      {
        text: "hold",
      },
    );
    assert.equal(sent.status, 202);
    const refused = await api<Refusal>(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
      { from: reviewer.id },
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "agent_busy");
    await api(d, "POST", `/rooms/${roomId}/dismiss`);
  }

  // Tracked dirt refuses; an untracked file does not, once the dirt is gone.
  {
    const { roomId, dev, reviewer } = await pair();
    await commitAt(reviewer.worktree, "review.txt");
    const before = headAt(dev.worktree);
    await writeFile(join(dev.worktree, "README.md"), "dirty\n");

    const refused = await api<Refusal>(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
      { from: reviewer.id },
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "dirty_worktree");
    assert.equal(headAt(dev.worktree), before);

    const clean = spawnSync("git", ["checkout", "--", "README.md"], {
      cwd: dev.worktree,
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stderr);
    await writeFile(join(dev.worktree, "scratch.txt"), "untracked\n");
    const moved = await api<ParticipantDto>(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
      { from: reviewer.id },
    );
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.ok(existsSync(join(dev.worktree, "scratch.txt")));
    await api(d, "POST", `/rooms/${roomId}/dismiss`);
  }

  // A target commit since the fork makes this a merge, not a fast-forward.
  {
    const { roomId, dev, reviewer } = await pair();
    await commitAt(dev.worktree, "late.txt");
    await commitAt(reviewer.worktree, "review.txt");
    const before = headAt(dev.worktree);
    const refused = await api<Refusal>(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
      { from: reviewer.id },
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "not_fast_forward");
    assert.equal(headAt(dev.worktree), before);
    await api(d, "POST", `/rooms/${roomId}/dismiss`);
  }
});

// --- room commands (M4-5) -----------------------------------------------------

/** The address `client/` takes, from a test daemon. */
const addressOf = (d: Daemon) => ({
  port: Number(new URL(d.url).port),
  token: d.token,
});

/** Parses a typed line and sends it; the line must be a route command. */
async function typed(
  d: Daemon,
  roomId: string | undefined,
  line: string,
  roster: readonly Named[] = [],
): Promise<Outcome> {
  const c = parseCommand(line, roster);
  assert.ok(c && "verb" in c, `not a command: ${line} → ${JSON.stringify(c)}`);
  assert.ok(c.verb !== "leave" && c.verb !== "help" && c.verb !== "form", line);
  if (c.verb === "ff") {
    // The screen turns the parsed command into its route call (M6-11a).
    return runCommand(addressOf(d), roomId, {
      verb: "forward",
      id: c.id,
      name: c.name,
      fromId: c.from.id,
      fromName: c.from.name,
    });
  }
  return runCommand(addressOf(d), roomId, c as RouteCommand);
}

test("every typed room command reaches its route", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const opened = await typed(
    d,
    undefined,
    `/new --cmd "${REMEMBER}" --name alice --title fix --cwd ${cwd}`,
  );
  assert.ok(opened.ok && opened.room, JSON.stringify(opened));
  assert.equal(opened.line, "opened room fix");
  const roomId = opened.room.id;
  const alice = only(opened.room);
  assert.equal(alice.role, "orchestrator");

  // A commit on alice's branch, so `--base @alice` is not the room's HEAD.
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", alice.worktree, ...args], { encoding: "utf8" });
  assert.equal(git("commit", "--allow-empty", "-qm", "alice's").status, 0);
  const aliceHead = git("rev-parse", "HEAD").stdout.trim();

  const roster = () =>
    api<RoomReply>(d, "GET", `/rooms/${roomId}`).then(
      (r) => r.body.participants,
    );
  const addBob = await typed(
    d,
    roomId,
    `/add --cmd "node ${MOCK_AGENT} --scenario stall" --name bob --role tester --mode ask --base @Alice`,
    await roster(),
  );
  assert.ok(addBob.ok, JSON.stringify(addBob));
  assert.equal(addBob.line, "added bob (mock-agent, tester, ask)");
  let bob = (await roster()).find((p) => p.name === "bob");
  assert.equal(bob?.baseSha, aliceHead, "bob starts from alice's branch");

  for (const [line, want] of [
    ["@bob /rename carol", "renamed bob to carol"],
    ["@carol /role developer", "carol is now developer"],
    ["@carol /role none", "carol has no role"],
    ["@carol /mode safe", "carol is now in safe mode"],
  ] as const) {
    const r = await typed(d, roomId, line, await roster());
    assert.ok(r.ok, `${line}: ${JSON.stringify(r)}`);
    assert.equal(r.line, want);
  }
  bob = (await roster()).find((p) => p.id === bob?.id);
  assert.equal(bob?.name, "carol");
  assert.equal(bob?.role, undefined);
  assert.equal(bob?.mode, "safe");

  const beforeTitle = await api<RoomReply>(d, "GET", `/rooms/${roomId}`);
  const retitled = await typed(d, roomId, "/title login bug", await roster());
  assert.ok(retitled.ok, JSON.stringify(retitled));
  assert.equal(retitled.line, "renamed the room to login bug");
  assert.equal(retitled.room?.title, "login bug");
  assert.equal(
    retitled.room?.seq,
    beforeTitle.body.seq,
    "a rename writes no room line",
  );

  const said = await api(
    d,
    "POST",
    `/rooms/${roomId}/agents/${bob?.id}/messages`,
    { text: "hang" },
  );
  assert.equal(said.status, 202);
  const cancel = await typed(d, roomId, "@carol /cancel", await roster());
  assert.ok(cancel.ok, JSON.stringify(cancel));
  assert.equal(cancel.line, "cancelling carol's turn");

  const forward = await typed(
    d,
    roomId,
    "@alice /ff --from @carol",
    await roster(),
  );
  assert.ok(forward.ok, JSON.stringify(forward));
  assert.equal(forward.line, "moved alice up to carol's commit");

  const removed = await typed(d, roomId, "@carol /remove", await roster());
  assert.ok(removed.ok, JSON.stringify(removed));
  assert.deepEqual(
    (await roster()).map((p) => p.name),
    ["alice"],
  );

  const gone = await typed(d, roomId, "/dismiss");
  assert.ok(gone.ok, JSON.stringify(gone));
  assert.equal(gone.room?.status, "dismissed");
});

test("each room command shows the daemon's own message for each refusal its route documents", async (t) => {
  const d = await boot(t);
  const repo = await gitRepo(t);
  const cwd = await added(d, repo);
  const outside = await gitRepo(t);
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "alice", role: "orchestrator" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const roomId = open.body.id;
  const alice = only(open.body);
  const ghost = [{ id: "p-nobody", name: "ghost" }];
  const roster: Named[] = [
    { id: alice.id, name: "alice", role: "orchestrator" },
  ];

  const refusals: [string, string | undefined, string, typeof roster][] = [
    // POST /rooms
    [
      `/new --cmd "${REMEMBER}" --cwd ${outside}`,
      undefined,
      "repo_not_added",
      [],
    ],
    [
      `/new --cmd "${REMEMBER}" --cwd ${join(repo, "missing")}`,
      undefined,
      "invalid_request",
      [],
    ],
    [
      `/new --cmd "${REMEMBER}" --name "a b" --cwd ${cwd}`,
      undefined,
      "invalid_request",
      [],
    ],
    [
      `/new --cmd /no/such/harness --name x --cwd ${cwd}`,
      undefined,
      "room_open_failed",
      [],
    ],
    // POST /rooms/:id/agents
    [`/add --cmd "${REMEMBER}" --name dan`, "room-nope", "room_not_found", []],
    [
      `/add --cmd "${REMEMBER}" --name dan --mode loud`,
      roomId,
      "invalid_request",
      [],
    ],
    [
      `/add --cmd "${REMEMBER}" --name dan --base no-such-ref`,
      roomId,
      "invalid_request",
      [],
    ],
    [`/add --cmd "${REMEMBER}" --name alice`, roomId, "name_taken", []],
    [
      `/add --cmd "${REMEMBER}" --name dan --role orchestrator`,
      roomId,
      "orchestrator_exists",
      [],
    ],
    [`/add --cmd /no/such/harness --name dan`, roomId, "room_open_failed", []],
    // PATCH /rooms/:id/agents/:agentId
    ["@alice /mode ask", "room-nope", "room_not_found", roster],
    ["@ghost /mode ask", roomId, "participant_not_found", ghost],
    ["@alice /mode loud", roomId, "invalid_request", roster],
    // DELETE /rooms/:id/agents/:agentId
    ["@alice /remove", "room-nope", "room_not_found", roster],
    ["@ghost /remove", roomId, "participant_not_found", ghost],
    // POST /rooms/:id/agents/:agentId/turns/current/cancel
    ["@alice /cancel", "room-nope", "room_not_found", roster],
    ["@ghost /cancel", roomId, "participant_not_found", ghost],
    ["@alice /cancel", roomId, "no_turn", roster],
    // PATCH /rooms/:id
    ["/title x", "room-nope", "room_not_found", []],
    // POST /rooms/:id/dismiss
    ["/dismiss", "room-nope", "room_not_found", []],
  ];
  // A second participant, so a rename and a role change can clash.
  const bob = await api<ParticipantDto>(d, "POST", `/rooms/${roomId}/agents`, {
    cmd: REMEMBER,
    name: "bob",
  });
  assert.equal(bob.status, 201);
  const both = [...roster, { id: bob.body.id, name: "bob" }];
  refusals.push(
    ["@bob /rename alice", roomId, "name_taken", both],
    ["@bob /role orchestrator", roomId, "orchestrator_exists", both],
  );

  const check = async (
    line: string,
    room: string | undefined,
    code: string,
    names: typeof roster,
  ) => {
    const r = await typed(d, room, line, names);
    assert.ok(!r.ok, `${line}: expected ${code}, got ${JSON.stringify(r)}`);
    assert.equal(r.code, code, `${line}: ${r.message}`);
    // The daemon's sentence, passed through: never a bare status.
    assert.ok(r.message && !/^HTTP \d+$/.test(r.message), r.message);
  };
  for (const [line, room, code, names] of refusals) {
    await check(line, room, code, names);
  }

  // A `--base @name` the room lacks is refused before the POST.
  const nobody = await typed(d, roomId, "/add pi --base @nobody", both);
  assert.deepEqual(nobody, {
    ok: false,
    code: "",
    message: "no participant named @nobody",
  });

  // A project config gone bad after the add: the room reads it at open.
  await mkdir(join(repo, ".kapelle"), { recursive: true });
  await writeFile(join(repo, ".kapelle", "config.json"), "{ nope");
  await check(
    `/new --cmd "${REMEMBER}" --cwd ${cwd}`,
    undefined,
    "invalid_config",
    [],
  );

  // Every route on a dismissed room.
  const dismissed = await api(d, "POST", `/rooms/${roomId}/dismiss`);
  assert.equal(dismissed.status, 200);
  for (const line of [
    "/dismiss",
    `/add --cmd "${REMEMBER}" --name carol`,
    "@alice /mode ask",
    "@alice /remove",
    "@alice /cancel",
    "/title x",
  ]) {
    await check(line, roomId, "room_dismissed", roster);
  }
});

const DOWN = "\x1b[B";

test("ctrl+o in a thread opens that agent's menu over the timeline, and a mode pick reaches its route", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("\x1b[1;3B", "@mock-agent");
  await press("\x0f", "cancel turn");
  // cancel turn, mode: Enter opens the pick list, on the current mode.
  await press(`${DOWN}\r`, "mock-agent · mode");
  await press(`${DOWN}\r`, "mock-agent is now in ask mode");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  const full = await api<RoomReply>(d, "GET", `/rooms/${room?.id}`);
  assert.equal(only(full.body).mode, "ask");
  // The menu names the new mode, and Esc closes it.
  // Esc alone, or it and the next key read as alt+key.
  await press("\x0f", "mode · ask");
  child.stdin.write("\x1b");
  await new Promise((ok) => setTimeout(ok, 300));
  await press("x", "@mock-agent x");
  await press("\x03", "rejoin with");
  assert.equal(await exited, 0, out());
  // The status line said it; the transcript never did.
  assert.doesNotMatch(scrollback(out()), /is now in ask mode/);
});

test("Esc in a second-level pop-up goes back to the menu", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  await seen("○ mock-agent");
  // Room menu → agent list → agent menu.
  await press("\x0f", "agent …");
  await press("\r", "pick an agent");
  await press("\r", "mock-agent · mock-agent");
  // Each second-level list returns to the agent's menu on Esc.
  await press(`${DOWN}\r`, "mock-agent · mode");
  await press("\x1b", "role · orchestrator");
  await press(`${DOWN.repeat(2)}\r`, "mock-agent · role");
  await press("\x1b", "rename …");
  await press(`${DOWN.repeat(3)}\r`, "rename mock-agent");
  await press("\x1b", "mode · auto");
  // The agent's menu came from `pick an agent`, so Esc returns to the room menu.
  await press("\x1b", "add agent …");
  // Enter proves it is the room menu: its first row opens `pick an agent`.
  await press("\r", "pick an agent");
  // That list's Esc comes back to the room menu.
  await press("\x1b", "add agent …");
  // The room's menu is first-level: Esc closes the pop-up.
  await press("\x1b", "enter to send");
  // The add-agent form returns to the room's menu too.
  await press("\x0f", "agent …");
  await press(`${DOWN}\r`, "harness");
  await press("\x1b", "agent …");
  await press("\x1b", "enter to send");
  child.stdin.write("\x03");
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
});

test("/add alone opens its form; a refusal stays in the form, and a fix adds the agent", {
  skip: noPty,
}, async (t) => {
  const { press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("/add\r", "add agent");
  // command, then name: each Enter opens a text box, and Enter keeps it.
  await press(`${DOWN}\r`, "> ");
  await press(`${REMEMBER}\r`, "Enter/Space");
  await press(`${DOWN}\rmock-agent\r`, "mock-agent");
  // Down to the last row, `add`: the name is taken.
  await press(`${DOWN.repeat(4)}\r`, "is taken");
  // Up to the name, clear it, and send again.
  await press(`${"\x1b[A".repeat(4)}\r\x15bob\r`, "bob");
  await press(`${DOWN.repeat(4)}\r`, "added bob (mock-agent, auto)");
  await seen("○ bob");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.deepEqual(
    room?.participants.map((p) => p.name),
    ["mock-agent", "bob"],
  );
  await press("\x03", "rejoin with");
  assert.equal(await exited, 0, out());
});

test("a double Enter on the new-room form opens one room", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const { press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  await press(`\r\x15${cwd}\r`, cwd);
  // Down to `open`, and Enter twice before the first answer.
  await press(`${DOWN.repeat(5)}\r\r`, "opened room");
  // No event says a second request was not sent: give it time to land.
  await new Promise((ok) => setTimeout(ok, 1500));
  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  assert.equal(rooms.body.length, 1, JSON.stringify(rooms.body));
  await press("\x03", "rejoin with");
  assert.equal(await exited, 0, out());
});

test("kapelle chat with no rooms opens one with /new, and shows its timeline", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await screen.press(
    `/new --cmd "${REMEMBER}" --title fix --cwd ${cwd}\r`,
    "opened room fix",
  );
  await screen.press("hello\r", "previous: (none)");
  await screen.press("\x03", "rejoin with");
  assert.equal(await screen.exited, 0, screen.out());
});

test("the menu opens over the timeline with the sidebar hidden; a typed agent command with no @name is refused on the status line", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(t, "stty cols 60 rows 30; node cli.ts chat", {
    XDG_RUNTIME_DIR: runtime,
  });
  await screen.seen(`room ${open.body.id}`);
  assert.ok(!screen.out().includes("«"), "the sidebar starts hidden");
  // The timeline's menu: the agent list first, then the room's commands.
  // It opens over the timeline, so the sidebar stays hidden.
  await screen.press("\x0f", "agent …");
  assert.ok(!screen.out().includes("«"), "the sidebar stays hidden");
  // ctrl+o again closes it, and the composer has the keys again.
  screen.child.stdin.write("\x0f");
  await new Promise((ok) => setTimeout(ok, 300));
  await screen.press("/remove\r", "! name the agent: @name /remove");
  // Refused before any request: the agent is still there.
  const room = await api<RoomReply>(d, "GET", `/rooms/${open.body.id}`);
  assert.equal(room.body.participants.length, 1);
  await screen.press("\x03", "rejoin with");
  assert.equal(await screen.exited, 0, screen.out());
});

test("after the last agent is removed, the status line names no one and a message is refused before any request", {
  skip: noPty,
}, async (t) => {
  const { press, seen, exited, out, d } = await chatOnPty(t);
  // The roster the daemon sent at the start named mock-agent; it must not
  // stand in for the empty one now. The reply's status line and the
  // stream's roster line race, so wait for each, in either order.
  await press("@mock-agent /remove\r", "removed mock-agent");
  await seen("! no agents: ctrl+o → add agent");
  const from = out().length;
  await press("hi\r", "! no agents: ctrl+o → add agent");
  assert.doesNotMatch(out().slice(from), /→ mock-agent|you → /);
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.deepEqual(room?.participants, []);
  await press("\x03", "rejoin with");
  assert.equal(await exited, 0, out());
});

test("GET /harnesses lists every harness the daemon can launch, and which were measured", async (t) => {
  const d = await boot(t);
  const r = await api<HarnessEntry[]>(d, "GET", "/harnesses");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body,
    Object.entries(AGENTS).map(([id, a]) => ({
      id,
      measured: a.measured !== undefined,
    })),
  );
  // M9 D2: the registry keeps only measured harnesses.
  assert.ok(r.body.every((h) => h.measured));
});

test("the new-room form completes a folder with Tab, lists the measured harnesses, and adds an unadded folder on yes", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const repo = await gitRepo(t); // never added
  const tmp = await tempDir(t);
  await mkdir(join(tmp, "alpha-1"));
  await mkdir(join(tmp, "alpha-2"));
  const { child, press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  // folder: Tab lists the two folders that match.
  await press(`\r\x15${tmp}/al\t`, "alpha-1/  alpha-2/");
  await press(`\x15${repo}\r`, "Enter/Space");
  // harness: a pick list of the measured ones. Esc keeps the row as it was.
  await press(`${DOWN}${DOWN}\r`, "claude");
  // Every registry entry is measured (M9 D2), so each one is offered.
  assert.deepEqual(pickList(out()), [
    "–",
    ...Object.keys(AGENTS).sort((a, b) => a.localeCompare(b)),
    "other…",
  ]);
  child.stdin.write("\x1b");
  await new Promise((ok) => setTimeout(ok, 300));
  // command, then open: the folder is not added, so the form asks.
  // Only the rows that change are drawn again, so wait for the value. The
  // row cuts a long one, so wait for its start: a checkout with a long path
  // never shows `mock-agent.mjs`.
  await press(`${DOWN}\r${REMEMBER}\r`, REMEMBER.slice(0, 40));
  await press(
    `${DOWN}${DOWN}\r`,
    "is not added to the daemon. Add its repository?",
  );
  await press("\r", "opened room");
  const repos = await api<string[]>(d, "GET", "/repos");
  assert.deepEqual(repos.body, [await realpath(repo)]);
  await press("\x03", "rejoin with");
  assert.equal(await exited, 0, out());
});

test("the new-room form leaves out a harness the daemon says is not measured", {
  skip: noPty,
}, async (t) => {
  // The registry has no unmeasured entry today (M9 D2), so a fake daemon
  // sends one: the filter is the only thing that keeps it out.
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const fake = createServer((req, res) => {
    const body =
      req.url === "/version"
        ? { apiVersion: API_VERSION }
        : req.url === "/harnesses"
          ? [
              { id: "lab-ok", measured: true },
              { id: "lab-none", measured: false },
            ]
          : req.url === "/rooms"
            ? []
            : undefined;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: { code: "no_route" } }));
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  t.after(() => fake.close());
  const { port } = fake.address() as AddressInfo;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: process.pid, port, token: "t" }),
    { mode: 0o600 },
  );
  const { press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node chat.ts",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  // folder, title, harness: the harness row's pick list.
  await press(`${DOWN}${DOWN}\r`, "other…");
  assert.deepEqual(pickList(out()), ["–", "lab-ok", "other…"]);
  await press("\x1b\x1b\x03", "ctrl+c");
  assert.equal(await exited, 0, out());
});

test("chat in a removed folder: bare stops, attach opens and its /new form survives", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const room = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(room.status, 201, room.body.error?.message);
  const inGone = async (verb: string, until?: string) => {
    const gone = await tempDir(t);
    const cmd =
      `stty cols 120 rows 40; cd '${gone}' && rmdir '${gone}' && ` +
      `exec node '${join(REPO, "chat.ts")}'${verb}`;
    return ptyScreen(t, cmd, { XDG_RUNTIME_DIR: runtime }, until);
  };

  // Bare `kapelle chat` stops before the screen opens.
  const bare = await inGone("", "the current folder was removed");
  assert.equal(await bare.exited, 1, bare.out());

  // `attach` needs no folder, so the screen opens.
  const { child, seen, exited, out } = await inGone(
    ` attach '${room.body.id}'`,
  );
  child.stdin.write("/new\r");
  await seen("new room");
  // A relative folder in a removed cwd is refused in the form, not a crash.
  child.stdin.write(`\rsub\r${DOWN.repeat(5)}\r`);
  await seen("the current folder was removed");
  // Esc closes the form, so /leave still reaches the composer.
  child.stdin.write("\x1b");
  await new Promise((ok) => setTimeout(ok, 300));
  child.stdin.write("/leave\r");
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
});

test("piped chat.ts says how to add a folder that /new is refused for", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const other = await gitRepo(t);
  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end(`/new --cmd "${REMEMBER}" --cwd ${other}\n/leave\n`);
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /has not been added to the daemon/);
  assert.ok(
    r.stderr.includes(`add it first: kapelle daemon add ${other}`),
    r.stderr,
  );
});

test("piped chat.ts refuses a bare /new or /add, and /term: each needs a terminal", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("/new\n/add\n/term\n/leave\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /! a form needs a terminal: \/new/);
  assert.match(r.stderr, /! a form needs a terminal: \/add </);
  assert.match(r.stderr, /! a shell needs the full-screen chat/);
});

test("piped chat.ts takes the room commands, and names the room /new opened", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // Both participants are in the room the pipe reads at the start, so each
  // `@name` resolves without waiting for the stream to replay.
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "alice", role: "orchestrator" },
      { cmd: REMEMBER, name: "bob" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const c = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end(
    `/add --cmd "${REMEMBER}" --name carol\n` +
      "@bob /role tester\n" +
      "@bob /mode safe\n" +
      "@bob /remove\n" +
      `/new --cmd "${REMEMBER}" --title second --cwd ${cwd}\n` +
      "/dismiss\n",
  );
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  for (const line of [
    "added carol (mock-agent, auto)",
    "bob is now tester",
    "bob is now in safe mode",
    "removed bob",
    "opened room second",
    "the room was dismissed",
  ]) {
    assert.ok(
      `${r.stdout}${r.stderr}`.includes(line),
      `${line} not in:\n${r.stdout}\n${r.stderr}`,
    );
  }
  // The pipe stays in the room it read; the new room is reached by attach.
  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  const second = rooms.body.find((room) => room.title === "second");
  assert.ok(second, JSON.stringify(rooms.body));
  assert.ok(
    r.stdout.includes(`attach with: kapelle chat attach ${second.id}`),
    r.stdout,
  );
});

test("the room view's menu picks an agent, and a rename reaches its route", {
  skip: noPty,
}, async (t) => {
  const { press, seen, exited, out, d } = await chatOnPty(t);
  await seen("○ mock-agent");
  // The room's menu lists the agents first; the agent's menu then holds its
  // own commands. Rename is the fourth: cancel, mode, role, rename.
  await press("\x0f", "agent …");
  await press("\r", "pick an agent");
  await press("\r", "mock-agent · mock-agent");
  await press(`${DOWN.repeat(3)}\r`, "rename mock-agent");
  await press("\x15bob\r", "renamed mock-agent to bob");
  await seen("○ bob");
  const [room] = await api<RoomReply[]>(d, "GET", "/rooms").then((r) => r.body);
  assert.deepEqual(
    room?.participants.map((p) => p.name),
    ["bob"],
  );
  await press("\x03", "rejoin with");
  assert.equal(await exited, 0, out());
});

test("the row keys do nothing while a pop-up is open, so a form keeps what was typed", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  await seen("○ mock-agent");
  await press("/add\r", "add agent");
  // The command row's text box: type, press both row-key sets, type on.
  await press(`${DOWN}\r`, "> ");
  await press("abc", "abc");
  // Nothing changes, so nothing is drawn: wait, then prove the box is there.
  child.stdin.write("\x0e\x10\x1b[1;3B\x1b[1;3A");
  await new Promise((ok) => setTimeout(ok, 300));
  await press("d\r", "abcd");
  await press("\x03", "rejoin with");
  assert.equal(await exited, 0, out());
});

test("the status line swaps its key hint while a pop-up is open", {
  skip: noPty,
}, async (t) => {
  const { child, press, seen, exited, out } = await chatOnPty(t);
  // The box's own footer is `↑↓ Enter · Esc back`; the status line must not
  // still promise the row keys the pop-up took.
  await press("\x0f", "esc back · ctrl+o close");
  // Closing it puts the composer's hint back.
  await press(
    "\x0f",
    "enter to send · ctrl+o menu · alt+↑↓ rows · ctrl+t rooms",
  );
  child.stdin.write("\x03");
  await seen("rejoin with");
  assert.equal(await exited, 0, out());
});

test("with no room open, the screen exits when the daemon is gone, and says how to start again", {
  skip: noPty,
  // The screen waits 30 s for the daemon to come back (M6-7d).
  timeout: 60_000,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const screen = await ptyScreen(
    t,
    "stty cols 100 rows 30; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  process.kill(d.pid, "SIGKILL");
  // The room list is read every 5 s; one that fails 30 s after the first
  // failure ends it (M6-7d). `seen` gives up after 20 s, so wait for the exit.
  assert.equal(await screen.exited, 1, screen.out());
  assert.match(plainText(screen.out()), /the daemon stopped/);
  assert.match(plainText(screen.out()), /kapelle daemon start/);
});

test("the menu's help row shows the commands", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const { press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  // With no room, the menu is: new room …, help, leave.
  await press("\x0f", "new room …");
  await press(`${DOWN}\r`, "@name /mode <ask|safe|auto>");
  // Help is a second-level pop-up: Esc returns to the menu.
  await press("\x1b", "new room …");
  await press("\x1b", "enter to send");
  await press("\x03", "left the chat");
  assert.equal(await exited, 0, out());
});

test("Esc in a form opened from the menu goes back to the menu", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const { press, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  // Esc returns to the menu; a second Esc still closes it.
  await press("\x1b", "new room …");
  await press("\x1b", "enter to send");
  await press("\x03", "left the chat");
  assert.equal(await exited, 0, out());
});

test("Esc in the folder-not-added prompt goes back to the new-room form", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const repo = await gitRepo(t); // never added
  const { child, press, seen, exited, out } = await ptyScreen(
    t,
    "stty cols 120 rows 40; node cli.ts chat",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  await press("\x0f", "new room …");
  await press("\r", "folder");
  await press(`\r\x15${repo}`, repo);
  await press("\r", "Enter/Space");
  // Open on an unadded folder: the daemon asks to add the repo.
  await press(
    `${DOWN.repeat(5)}\r`,
    "is not added to the daemon. Add its repository?",
  );
  // Esc returns to the form, with the folder still there.
  const from = out().length;
  await press("\x1b", "Enter/Space to change");
  assert.ok(
    plainText(out().slice(from)).includes(repo),
    plainText(out().slice(from)),
  );
  child.stdin.write("\x03");
  await seen("left the chat");
  assert.equal(await exited, 0, out());
});

test("GET /rooms/:id/agents/:agentId/diff shows what an agent did not commit, new files too, and with base its commits", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  const route = `/rooms/${open.body.id}/agents/${p.id}/diff`;
  type DiffReply = Diff & { error: { code: string } };

  const clean = await api<DiffReply>(d, "GET", route);
  assert.equal(clean.status, 200);
  assert.deepEqual(clean.body, { text: "", files: 0, added: 0, removed: 0 });

  // In `auto` the agent asks nothing; the person still sees what it did.
  await writeFile(join(p.worktree, "README.md"), "changed\n");
  await writeFile(join(p.worktree, "new.txt"), "fresh\n");
  const head = await api<DiffReply>(d, "GET", `${route}?against=head`);
  assert.equal(head.status, 200);
  assert.deepEqual(
    [head.body.files, head.body.added, head.body.removed],
    [2, 2, 1],
  );
  assert.match(
    head.body.text,
    /diff --git a\/new\.txt b\/new\.txt\nnew file mode/,
  );

  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: p.worktree });
  assert.equal(git("commit", "-qam", "agent work").status, 0);
  const after = await api<DiffReply>(d, "GET", route);
  assert.equal(after.body.files, 1, "the commit left only the new file");
  const base = await api<DiffReply>(d, "GET", `${route}?against=base`);
  assert.equal(base.body.files, 2, "the whole branch has the commit too");
  assert.match(base.body.text, /-first\n\+changed/);

  const bad = await api<DiffReply>(d, "GET", `${route}?against=main`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_request");
  const nobody = await api<DiffReply>(
    d,
    "GET",
    `/rooms/${open.body.id}/agents/nobody/diff`,
  );
  assert.equal(nobody.status, 404);

  // A checkout that is gone has no diff, and says so.
  await rm(p.worktree, { recursive: true, force: true });
  const gone = await api<DiffReply>(d, "GET", route);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.error.code, "no_diff");
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("a branch renamed and rebased in a turn reaches the room reply, room.json and the base diff", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario read-only`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  const renamed = "renamed-topic";
  const branch = spawnSync("git", ["branch", "-m", renamed], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(branch.status, 0, branch.stderr);

  // The agent commits, the base moves, and the agent rebases onto it.
  await commitAt(p.worktree, "agent.txt");
  await commitAt(cwd, "base.txt");
  const newer = headAt(cwd);
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(rebase.status, 0, rebase.stderr);

  const sent = await api<RoomReply>(
    d,
    "POST",
    `/rooms/${open.body.id}/messages`,
    {
      text: "go",
    },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  const roomNow = await roomIdle(d, open.body.id);
  assert.equal(only(roomNow).branch, renamed);
  assert.equal(only(roomNow).baseSha, newer);

  type DiffReply = Diff & { error: { code: string } };
  const diff = await api<DiffReply>(
    d,
    "GET",
    `/rooms/${open.body.id}/agents/${p.id}/diff?against=base`,
  );
  assert.equal(diff.status, 200);
  assert.match(diff.body.text, /diff --git a\/agent\.txt b\/agent\.txt/);
  assert.doesNotMatch(
    diff.body.text,
    /base\.txt/,
    "the new base's own file is not the agent's work",
  );

  // `room.json` is written after the turn's sync; poll for the save.
  const file = join(stateDirFor(cwd), "rooms", open.body.id, "room.json");
  for (const end = Date.now() + 5_000; ; ) {
    const record = JSON.parse(await readFile(file, "utf8")) as {
      participants: { branch?: string; baseSha?: string }[];
    };
    if (
      record.participants[0]?.branch === renamed &&
      record.participants[0]?.baseSha === newer
    ) {
      break;
    }
    if (Date.now() > end) assert.fail("room.json never showed the rename");
    await new Promise((ok) => setTimeout(ok, 25));
  }
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

for (const scenario of ["diff-first", "file-text"]) {
  test(`an ask question about an edit carries its diff in GET /permissions: ${scenario}`, async (t) => {
    const d = await boot(t);
    const cwd = await added(d, await gitRepo(t));
    const open = await api<RoomReply>(d, "POST", "/rooms", {
      cwd,
      agents: [
        {
          cmd: `node ${MOCK_AGENT} --scenario ${scenario}`,
          role: "orchestrator",
          mode: "ask",
        },
      ],
    });
    assert.equal(open.status, 201, open.body.error?.message);
    const p = only(open.body);
    await api(d, "POST", `/rooms/${open.body.id}/agents/${p.id}/messages`, {
      text: "go",
    });
    const q = (await pendingOne(d)) as Pending & { diff?: Diff };
    assert.equal(q.title, "Write ACP_TEST.md");
    assert.deepEqual(
      q.diff && [q.diff.files, q.diff.added, q.diff.removed],
      [1, 1, 0],
    );
    assert.match(
      q.diff?.text ?? "",
      /^diff --git a\/ACP_TEST\.md b\/ACP_TEST\.md\nnew file mode[\s\S]*\n\+written by the mock agent through the client$/,
    );
    await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
  });
}

test("a direct fs/write_text_file ask carries its built diff", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${HOSTILE_AGENT} --scenario write-no-ask`,
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  await api(d, "POST", `/rooms/${open.body.id}/agents/${p.id}/messages`, {
    text: "go",
  });
  const q = (await pendingOne(d)) as Pending & { diff?: Diff };
  assert.equal(q.kind, "edit");
  assert.equal(q.title, `fs/write_text_file ${join(p.worktree, "SNEAKY.md")}`);
  assert.deepEqual(
    q.diff && [q.diff.files, q.diff.added, q.diff.removed],
    [1, 1, 0],
  );
  assert.match(
    q.diff?.text ?? "",
    /^diff --git a\/SNEAKY\.md b\/SNEAKY\.md\nnew file mode[\s\S]*\n\+written without asking$/,
  );
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("chat.ts on a real terminal shows a question's diff beside the timeline, goes back to the box, and answers from the pane", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`,
    {
      text: "go",
    },
  );

  // One line and one row in the box; deny is still first.
  await screen.seen("± ACP_TEST.md (new) +1 −0");
  await screen.seen("view diff");
  const write = await pendingOne(d);
  await screen.press("\x1b[B\x1b[B\r", "question 1 of 1 · ACP_TEST.md (new)");
  await screen.seen("+written by the mock agent through the client");
  await screen.seen("y allow · n deny · ctrl+] type");
  // Esc brings the box back; the pane opens again from it.
  await screen.press("\x1b", "↑↓ pick · enter answer · esc later");
  await screen.press("\x1b[B\x1b[B\r", "y allow · n deny");
  await screen.press("y", "question 1 of 1 · allowed (client)");
  // The next question opens over the pane; Esc puts it aside and shows the
  // pane content that stayed. The transcript's own "allowed (client)" line
  // would not prove this.
  await screen.seen("delete · Delete something");
  await screen.press("\x1b", "? 1 question");
  await screen.press("\x1d", "ctrl+] type");
  await screen.press("\x18", "ctrl+x view");
  const shownAgain = screen.out().length;
  await screen.press("\x18", "question 1 of 1 · allowed (client)");
  const answerFrame = screen.out().slice(shownAgain);
  assert.match(answerFrame, /question 1 of 1 · allowed \(client\)/);
  assert.match(answerFrame, /\+written by the mock agent through the client/);
  const decided = await api<PermissionDecision>(
    d,
    "GET",
    `/permissions/${write.id}`,
  );
  assert.deepEqual([decided.body.allow, decided.body.reason], [true, "client"]);
  screen.child.stdin.write("\x03");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal answers a question from the pane with n", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`,
    { text: "go" },
  );
  await screen.seen("view diff");
  const write = await pendingOne(d);
  await screen.press("\x1b[B\x1b[B\r", "y allow · n deny · ctrl+] type");
  await screen.press("n", "question 1 of 1 · denied (client)");
  const decided = await api<PermissionDecision>(
    d,
    "GET",
    `/permissions/${write.id}`,
  );
  assert.deepEqual(
    [decided.body.allow, decided.body.reason],
    [false, "client"],
  );
  screen.child.stdin.write("\x03");
  assert.equal(await screen.exited, 0, screen.out());
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("chat.ts on a real terminal keeps a waiting question's keys when view changes opens it", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "alice",
        role: "orchestrator",
        mode: "ask",
      },
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "bob",
        role: "developer",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const alice = open.body.participants.find((p) => p.name === "alice");
  const bob = open.body.participants.find((p) => p.name === "bob");
  assert.ok(alice && bob);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );

  // Alice asks; her box opens. Bob asks while it is open, so his question
  // waits behind hers.
  await api(d, "POST", `/rooms/${open.body.id}/agents/${alice.id}/messages`, {
    text: "go",
  });
  await screen.seen("deny");
  await api(d, "POST", `/rooms/${open.body.id}/agents/${bob.id}/messages`, {
    text: "go",
  });
  await screen.seen(" 1 of 2 ━┓");
  await new Promise((ok) => setTimeout(ok, 1_000));

  // ctrl+o closes Alice's box (puts her question aside); ctrl+o opens the
  // menu; choose agent … -> bob -> view changes. Bob's box opens as the menu
  // closes, and the pane must not take its keys.
  await screen.press("\x0f", "? 2 questions");
  await screen.press("\x0f", "agent …");
  await screen.press("\x1b[B\x1b[B\r", "pick an agent");
  await screen.press("\x1b[B\r", "view changes");
  await screen.press(`${"\x1b[B".repeat(6)}\r`, "↑↓ pick");
  await screen.seen("bob · uncommitted");

  const before = screen.out().length;
  screen.child.stdin.write("b");
  await new Promise((ok) => setTimeout(ok, 300));
  assert.doesNotMatch(screen.out().slice(before), /bob · whole branch/);
  // Closing the box hands the keys to the composer, not to the view that
  // gave them up (#225 review): typed text reaches the composer.
  await screen.press("\x1b", "ctrl+] view");
  await screen.press("hello", "hello");
  screen.child.stdin.write("\x03");
  assert.equal(await screen.exited, 0, screen.out());
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("chat.ts on a real terminal under 120 columns puts the question's diff where the timeline was", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`,
    {
      text: "go",
    },
  );
  await screen.seen("view diff");
  const beforeOpen = screen.out().length;
  // The counts survive only in a pane that took the timeline's place: beside
  // it the pane is half the width, and the head is cut before them. The
  // timeline's own text must also be gone, not merely cut from this row.
  await screen.press("\x1b[B\x1b[B\r", "ACP_TEST.md (new) · +1 −0");
  assert.doesNotMatch(screen.out().slice(beforeOpen), /you → asker/);
  screen.child.stdin.write("\x03");
  assert.equal(await screen.exited, 0, screen.out());
});

test("the diff route says no branch when the participant has none", async (t) => {
  const d = await boot(t);
  // Not a git repository, so there are no worktrees and no branch to name.
  const cwd = await added(d, await tempDir(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, role: "orchestrator" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  type DiffReply = Diff & { error: { code: string; message: string } };
  const route = `/rooms/${open.body.id}/agents/${p.id}/diff`;
  const base = await api<DiffReply>(d, "GET", `${route}?against=base`);
  assert.equal(base.status, 409);
  assert.equal(base.body.error.code, "no_diff");
  assert.match(base.body.error.message, /no branch to compare with/);
  const head = await api<DiffReply>(d, "GET", route);
  assert.equal(head.status, 409);
  assert.equal(head.body.error.code, "no_diff");
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("chat.ts on a real terminal shows what an auto agent changed, from /diff and from its menu, file by file and against its base", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "bob", role: "orchestrator" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  await writeFile(join(p.worktree, "README.md"), "changed\n");
  await writeFile(join(p.worktree, "new.txt"), "fresh\n");
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );

  // ctrl+x wakes the side view; before anything is in it, it says how to
  // fill it. ctrl+x again hides it.
  await screen.press("\x18", "nothing here yet");
  await screen.press("\x18", "ctrl+x view");
  await screen.press("@bob /diff\r", "bob · uncommitted · README.md (1 of 2)");
  await screen.press("]", "new.txt (new) (2 of 2)");
  await screen.press("[", "README.md (1 of 2)");
  // ctrl+] gives the keys to the composer: a message goes out while the
  // view stays, and its letters reach no view key. ctrl+] takes the keys
  // back.
  await screen.press("\x1d", "ctrl+] view");
  await screen.press("bravo\r", "previous: (none)");
  await screen.press("\x1d", "ctrl+] type");
  await screen.press("b", "bob · whole branch");
  // The pane is a snapshot: `r` asks again and finds the third file.
  await writeFile(join(p.worktree, "more.txt"), "more\n");
  await screen.press("r", "README.md (1 of 3)");
  // Esc gives the keys back; the view stays.
  await screen.press("\x1b", "ctrl+] view");
  // The menu: ctrl+o, `agent …`, bob, then `view changes`.
  await screen.press("\x0f", "agent …");
  await screen.press("\r", "pick an agent");
  await screen.press("\r", "view changes");
  // Below cancel, mode, role and rename; above remove.
  await screen.press(`${"\x1b[B".repeat(4)}\r`, "bob · uncommitted");
  // ctrl+x hides the view and keeps what it shows.
  await screen.press("\x18", "ctrl+x view");
  await screen.press("\x18", "bob · uncommitted · README.md (1 of 3)");
  screen.child.stdin.write("\x03");
  assert.equal(await screen.exited, 0, screen.out());
});

test("chat.ts on a real terminal gives a refused /diff its line back", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  // Not a git repository: the agent's changes cannot be shown.
  const cwd = await added(d, await tempDir(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "bob", role: "orchestrator" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await screen.press("@bob /diff\r", "no diff for bob");
  // As every refused command does (#225 review): the text comes back to fix.
  await screen.press("x", "@bob /diff x");
  screen.child.stdin.write("\x03");
  assert.equal(await screen.exited, 0, screen.out());
});

// --- a room across a restart (M6-7a, #151) ----------------------------------

const SLOW = `node ${MOCK_AGENT} --scenario slow`;

/** Every line of a room's log, read from disk. */
async function roomLog(
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
const answersIn = (lines: { update: Record<string, unknown> }[]) =>
  lines
    .filter((l) => l.update.sessionUpdate === "agent_message_chunk")
    .map((l) => (l.update.content as { text: string }).text);

/** A room with one `cmd` participant on a first daemon, and what a second
 *  daemon on the same directories needs. */
async function roomToRestart(t: TestContext, cmd: string) {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const cwd = await realpath(await added(first, await gitRepo(t)));
  const open = await api<RoomReply>(first, "POST", "/rooms", {
    ...withAgent(cwd, cmd),
    title: "kept",
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const again = () => boot(t, runtime, [], state);
  return {
    first,
    cwd,
    id: open.body.id,
    alice: only(open.body),
    again,
    runtime,
  };
}

// The test drives the whole restart flow end to end: its call count is the test.
// pi-lens-ignore: high-fan-out
test("a restart lists the room paused, replays it, and a message revives the participant fresh", async (t) => {
  const { first, cwd, id, alice, again } = await roomToRestart(t, REMEMBER);
  const sent = await api<RoomReply>(first, "POST", `/rooms/${id}/messages`, {
    text: "alpha",
  });
  assert.equal(sent.status, 202, sent.body.error?.message);
  await roomIdle(first, id);
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await again();
  const list = await api<RoomListEntry[]>(second, "GET", "/rooms");
  const entry = list.body.find((r) => r.id === id);
  assert.equal(entry?.status, "paused");
  assert.deepEqual(
    entry?.participants.map((p) => p.status),
    ["paused"],
  );
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.status, "paused");
  assert.equal(got.body.title, "kept");
  const back = only(got.body);
  assert.equal(back.id, alice.id);
  assert.equal(back.worktree, alice.worktree, "the same checkout");
  assert.equal(back.branch, alice.branch);
  assert.equal(back.status, "paused");
  assert.equal(back.resumed, undefined);
  const before = await roomLog(cwd, id);
  assert.deepEqual(answersIn(before), ["previous: (none)"]);

  // Its history replays on the stream of the new daemon.
  const res = await fetch(`${second.url}/rooms/${id}/events`, {
    headers: { authorization: `Bearer ${second.token}` },
  });
  assert.equal(res.status, 200);
  const reader = (res.body as ReadableStream<Uint8Array>)
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let text = "";
  while ((text.match(/^data: /gm) ?? []).length < before.length) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  await reader.cancel();
  assert.equal((text.match(/^data: /gm) ?? []).length, before.length);

  const revive = await api<RoomReply>(second, "POST", `/rooms/${id}/messages`, {
    text: "beta",
  });
  assert.equal(revive.status, 202, revive.body.error?.message);
  const after = only(await roomIdle(second, id));
  assert.equal(after.status, "idle");
  assert.equal(after.resumed, "fresh");
  const room = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(room.body.status, "active", "a revive makes the room active");

  const lines = await roomLog(cwd, id);
  assert.deepEqual(
    lines.map((l) => l.seq),
    lines.map((_, i) => i + 1),
    "one log, with seq carried on",
  );
  assert.deepEqual(
    answersIn(lines),
    ["previous: (none)", "previous: (none)"],
    "a fresh session does not remember alpha",
  );
  assert.ok(
    lines
      .slice(before.length)
      .some((l) => l.update.sessionUpdate === "_client_participant_revived"),
  );
});

test("a shutdown during a turn ends it in the log, and the participant is paused after the restart", async (t) => {
  const { first, cwd, id, again } = await roomToRestart(t, SLOW);
  await api(first, "POST", `/rooms/${id}/messages`, { text: "hi" });
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const kinds = (await roomLog(cwd, id)).map((l) => l.update.sessionUpdate);
  const asked = kinds.indexOf("_client_user_message");
  assert.ok(asked >= 0);
  assert.ok(
    kinds.indexOf("_client_turn_ended") > asked,
    "the cancelled turn ended in the log",
  );

  const second = await again();
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(only(got.body).status, "paused");
});

test("kill -9 during a turn leaves the participant killed after the next boot, and a message revives it", async (t) => {
  const { first, cwd, id, again } = await roomToRestart(t, SLOW);
  const record = join(stateDirFor(cwd), "rooms", id, "room.json");
  await api(first, "POST", `/rooms/${id}/messages`, { text: "hi" });
  await until(
    "room.json shows the turn",
    async () =>
      JSON.parse(await readFile(record, "utf8")).participants[0]?.status ===
      "busy",
  );
  process.kill(first.pid, "SIGKILL");
  await first.done;
  const left = (await roomLog(cwd, id)).length;

  const second = await again();
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.body.status, "paused");
  assert.equal(only(got.body).status, "killed");
  assert.equal(
    (await roomLog(cwd, id)).length,
    left,
    "the boot adds no line to the log",
  );

  const revive = await api<RoomReply>(second, "POST", `/rooms/${id}/messages`, {
    text: "again",
  });
  assert.equal(revive.status, 202, revive.body.error?.message);
  const after = only(await roomIdle(second, id));
  assert.equal(after.status, "idle");
  assert.equal(after.resumed, "fresh");
  assert.deepEqual(answersIn(await roomLog(cwd, id)), ["previous: (none)"]);
});

test("chat.ts on a pipe rides out a restart: the participant reads paused, and a message is answered", async (t) => {
  const { first, cwd, id, again, runtime } = await roomToRestart(t, REMEMBER);
  const c = spawnCli(t, ["attach", id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  await c.waitFor("type a message");
  c.child.stdin.write("alpha\n");
  await c.waitFor("previous: (none)");

  // A clean stop pauses the room, ends its stream and removes `daemon.json`
  // (M6-7d): the screen waits for the next daemon instead of ending.
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = await again();
  await c.waitFor("is paused; a message revives it");

  c.child.stdin.write("beta\n");
  await c.waitFor("is back with a fresh session");
  await roomIdle(second, id);
  c.child.stdin.end();
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /the daemon restarted/);
  assert.equal(r.stdout.match(/previous: \(none\)/g)?.length, 2, r.stdout);
  assert.deepEqual(answersIn(await roomLog(cwd, id)), [
    "previous: (none)",
    "previous: (none)",
  ]);
});

test("the TUI rides out a restart: it says so, marks the participant paused, and a message is answered", {
  skip: noPty,
}, async (t) => {
  const { first, id, again, runtime, alice } = await roomToRestart(t, REMEMBER);
  // The sidebar is narrow: a short name leaves room for its `paused`.
  const renamed = await api(first, "PATCH", `/rooms/${id}/agents/${alice.id}`, {
    name: "al",
  });
  assert.equal(renamed.status, 200);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${id}`,
    { XDG_RUNTIME_DIR: runtime },
    "○ al",
  );
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = await again();
  await screen.seen("the daemon restarted");
  await screen.seen("⏸ al");
  await screen.press("hi\r", "previous: (none)");
  await roomIdle(second, id);
  await screen.press("\x03", "rejoin with");
  assert.equal(await screen.exited, 0, plainText(screen.out()));
});

test("a dismissed room comes back dismissed after a restart, and a message is refused", async (t) => {
  const { first, id, again } = await roomToRestart(t, REMEMBER);
  const gone = await api<RoomReply>(first, "POST", `/rooms/${id}/dismiss`);
  assert.equal(gone.status, 200);
  process.kill(first.pid, "SIGTERM");
  await first.done;

  const second = await again();
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.status, "dismissed");
  assert.equal(only(got.body).status, "dismissed");
  const late = await api<RoomReply>(second, "POST", `/rooms/${id}/messages`, {
    text: "hi",
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "room_dismissed");
  const twice = await api<RoomReply>(second, "POST", `/rooms/${id}/dismiss`);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error.code, "room_dismissed");
});

// The test drives the whole room-lifecycle flow: its call count is the test.
// pi-lens-ignore: high-fan-out
test("DELETE refuses an active room and uncommitted work, then removes a dismissed room whole (#235)", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const { worktree, branch } = only(open.body);
  const live = await api(d, "DELETE", `/rooms/${id}`);
  assert.equal(live.status, 409);
  assert.equal(live.body.error.code, "room_active");

  // A dismiss keeps a checkout with work in it, and so does a refused delete.
  await writeFile(join(worktree, "draft.txt"), "half a thought\n");
  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const dirty = await api(d, "DELETE", `/rooms/${id}`);
  assert.equal(dirty.status, 409);
  assert.equal(dirty.body.error.code, "uncommitted_work");
  assert.match(dirty.body.error.message, /draft\.txt/);
  assert.equal((await api(d, "GET", `/rooms/${id}`)).status, 200);
  assert.ok(existsSync(join(worktree, "draft.txt")), "nothing was removed");

  await rm(join(worktree, "draft.txt"));
  const deleted = await fetch(`${d.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");
  assert.equal(existsSync(worktree), false, "the checkout is gone");
  assert.equal(existsSync(join(stateDirFor(root), "rooms", id)), false);
  const ref = spawnSync(
    "git",
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    {
      cwd: root,
    },
  );
  assert.notEqual(ref.status, 0, "the branch is gone");
  assert.equal((await api(d, "GET", `/rooms/${id}`)).status, 404);
  const list = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.equal(
    list.body.some((r) => r.id === id),
    false,
  );
});

test("DELETE removes a branch the harness renamed into", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario read-only`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const p = only(open.body);
  const renamed = "renamed-topic";
  const rename = spawnSync("git", ["branch", "-m", renamed], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(rename.status, 0, rename.stderr);
  await commitAt(p.worktree, "agent.txt");
  const sent = await api(d, "POST", `/rooms/${id}/messages`, { text: "go" });
  assert.equal(sent.status, 202, sent.body.error?.message);
  await roomIdle(d, id);
  assert.equal(
    only((await api<RoomReply>(d, "GET", `/rooms/${id}`)).body).branch,
    renamed,
  );

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  assert.equal(hasBranch(root, renamed), true, "the committed branch stays");
  const deleted = await fetch(`${d.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(deleted.status, 204);
  assert.equal(
    hasBranch(root, renamed),
    false,
    "the renamed branch goes with the room",
  );
});

test("DELETE leaves a branch the harness switched to, not one it created", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario read-only`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const p = only(open.body);
  const original = p.branch as string;
  const foreign = "user-topic";
  const made = spawnSync("git", ["branch", foreign, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(made.status, 0, made.stderr);
  const switched = spawnSync("git", ["switch", "-q", foreign], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(
    (await api(d, "POST", `/rooms/${id}/messages`, { text: "go" })).status,
    202,
  );
  await roomIdle(d, id);
  assert.equal(
    only((await api<RoomReply>(d, "GET", `/rooms/${id}`)).body).branch,
    foreign,
  );

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const deleted = await fetch(`${d.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(deleted.status, 204);
  assert.equal(hasBranch(root, foreign), true, "the foreign branch is left");
  assert.equal(hasBranch(root, original), false, "the room's own branch goes");
});

test("DELETE keeps a foreign branch after the room's own ref is gone", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario read-only`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const p = only(open.body);
  const original = p.branch as string;
  // The harness renames the room's branch away, then switches to a branch
  // that already existed. The original ref is now gone; the foreign one is
  // still not the room's to delete.
  const away = "wip-away";
  const renamed = spawnSync("git", ["branch", "-m", away], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(renamed.status, 0, renamed.stderr);
  const foreign = "user-topic";
  const made = spawnSync("git", ["branch", foreign, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(made.status, 0, made.stderr);
  const switched = spawnSync("git", ["switch", "-q", foreign], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(
    (await api(d, "POST", `/rooms/${id}/messages`, { text: "go" })).status,
    202,
  );
  await roomIdle(d, id);
  assert.equal(
    only((await api<RoomReply>(d, "GET", `/rooms/${id}`)).body).branch,
    foreign,
  );

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const deleted = await fetch(`${d.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(deleted.status, 204);
  assert.equal(
    hasBranch(root, foreign),
    true,
    "the pre-existing branch survives the room's gone ref",
  );
  assert.equal(hasBranch(root, original), false);
  assert.equal(
    hasBranch(root, away),
    true,
    "the name the room renamed through is left too",
  );
});

test("a paused room is deleted without a revive, and its open stream ends (#235)", async (t) => {
  const { first, cwd, id, alice, again } = await roomToRestart(t, REMEMBER);
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await again();
  const res = await fetch(`${second.url}/rooms/${id}/events`, {
    headers: { authorization: `Bearer ${second.token}` },
  });
  assert.equal(res.status, 200);
  const drained = res.text();
  const deleted = await api(second, "DELETE", `/rooms/${id}`);
  assert.equal(deleted.status, 204, deleted.body?.error?.message);
  await drained;
  assert.equal(existsSync(alice.worktree), false);
  assert.equal(existsSync(join(stateDirFor(cwd), "rooms", id)), false);
  assert.equal((await api(second, "GET", `/rooms/${id}`)).status, 404);
});

// The test drives the shutdown flow: its call count is the test.
// pi-lens-ignore: high-fan-out
test("a room opened while the daemon shuts down does not come back (#316)", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const cwd = await realpath(await added(first, await gitRepo(t)));

  // A harness that answers ACP after a delay, so the request is inside
  // `openRoom` when the signal lands. No other room holds the shutdown
  // open: it must wait for this request by itself.
  const slowInit = join(cwd, "slow-init.mjs");
  const pidFile = join(cwd, "slow-init.pid");
  await writeFile(
    slowInit,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `await new Promise((ok) => setTimeout(ok, 500));\n` +
      `await import(${JSON.stringify(MOCK_AGENT)});\n`,
  );
  const opening = fetch(`${first.url}/rooms`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${first.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(withAgent(cwd, `node ${slowInit}`)),
  });
  // The harness has started: past the `stopping` check, inside `openRoom`.
  for (const until = Date.now() + 5_000; !existsSync(pidFile); ) {
    if (Date.now() > until) {
      throw new Error("the opening request never reached openRoom");
    }
    await new Promise((ok) => setTimeout(ok, 10));
  }
  const harness = Number(await readFile(pidFile, "utf8"));
  process.kill(first.pid, "SIGTERM");

  const refused = await opening;
  assert.equal(refused.status, 503);
  assert.equal(
    ((await refused.json()) as RoomReply).error.code,
    "shutting_down",
  );
  assert.equal((await first.done).code, 0);
  assert.throws(
    () => process.kill(harness, 0),
    "the harness does not outlive the daemon",
  );

  // Nothing of it is left on disk: no record, no log, no stderr log.
  const roomsDir = join(stateDirFor(cwd), "rooms");
  assert.deepEqual(
    readdirSync(roomsDir),
    [],
    "the refused room's folder is gone",
  );

  const second = await boot(t, runtime, [], state);
  const list = await api<RoomListEntry[]>(second, "GET", "/rooms");
  assert.deepEqual(
    list.body,
    [],
    "the room the client never got must not come back",
  );
});

test("a shutdown still waits for a room create whose client has gone (#316)", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const cwd = await realpath(await added(first, await gitRepo(t)));

  // The same slow harness: the request is inside `openRoom` when its
  // client goes and the signal lands.
  const slowInit = join(cwd, "slow-init.mjs");
  const pidFile = join(cwd, "slow-init.pid");
  await writeFile(
    slowInit,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `await new Promise((ok) => setTimeout(ok, 500));\n` +
      `await import(${JSON.stringify(MOCK_AGENT)});\n`,
  );
  const gone = new AbortController();
  const opening = fetch(`${first.url}/rooms`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${first.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(withAgent(cwd, `node ${slowInit}`)),
    signal: gone.signal,
  });
  for (const until = Date.now() + 5_000; !existsSync(pidFile); ) {
    if (Date.now() > until) {
      throw new Error("the opening request never reached openRoom");
    }
    await new Promise((ok) => setTimeout(ok, 10));
  }
  const harness = Number(await readFile(pidFile, "utf8"));
  gone.abort();
  await assert.rejects(opening);
  process.kill(first.pid, "SIGTERM");

  assert.equal((await first.done).code, 0);
  assert.throws(
    () => process.kill(harness, 0),
    "the harness does not outlive the daemon",
  );
  assert.deepEqual(
    readdirSync(join(stateDirFor(cwd), "rooms")),
    [],
    "the room's folder is gone",
  );
});

test("a shutdown waits for a room delete in flight, which answers 204 (#316)", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  // A `git` that sleeps before each `worktree prune`, so the delete is
  // inside `removeRoom` when the signal lands.
  const bin = await tempDir(t);
  const marker = join(bin, "removing");
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\n` +
      `if [ "$1" = worktree ] && [ "$2" = prune ]; then\n` +
      `  : > ${JSON.stringify(marker)}; sleep 1\n` +
      `fi\n` +
      `exec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  const first = await boot(t, runtime, [], state, {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  });
  const cwd = await added(first, await gitRepo(t));
  const open = await api<RoomReply>(
    first,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const alice = open.body.participants[0] as ParticipantDto;
  // A commit keeps the checkout and its branch past the dismiss, so the
  // delete has both to remove.
  execFileSync("git", [
    "-C",
    alice.worktree as string,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--allow-empty",
    "-qm",
    "work",
  ]);
  assert.equal((await api(first, "POST", `/rooms/${id}/dismiss`)).status, 200);
  assert.equal(hasBranch(cwd, alice.branch as string), true);
  // The boot sweep prunes too; only the delete may set the marker now.
  await rm(marker, { force: true });

  const deleting = fetch(`${first.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${first.token}` },
  });
  for (const until = Date.now() + 5_000; !existsSync(marker); ) {
    if (Date.now() > until) throw new Error("the delete never reached git");
    await new Promise((ok) => setTimeout(ok, 10));
  }
  process.kill(first.pid, "SIGTERM");

  assert.equal((await deleting).status, 204);
  assert.equal((await first.done).code, 0);
  assert.equal(existsSync(join(stateDirFor(cwd), "rooms", id)), false);
  // Before the next boot, whose sweep would remove a branch left behind.
  assert.equal(existsSync(alice.worktree as string), false);
  assert.equal(hasBranch(cwd, alice.branch as string), false);

  const second = await boot(t, runtime, [], state);
  assert.equal((await api(second, "GET", `/rooms/${id}`)).status, 404);
});

/** Starts a request now and sends its JSON body only after `later` ran, so
 *  the route reads it after whatever `later` did. */
async function bodyAfter(
  d: Daemon,
  method: string,
  path: string,
  body: unknown,
  later: () => Promise<void>,
): Promise<{ status: number; body: RoomReply }> {
  const text = JSON.stringify(body);
  const url = new URL(path, d.url);
  const reply = new Promise<{ status: number; body: RoomReply }>((ok, fail) => {
    const req = request(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${d.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () =>
          ok({ status: res.statusCode ?? 0, body: JSON.parse(data) }),
        );
      },
    );
    req.on("error", fail);
    req.flushHeaders();
    // The headers must be in before `later` runs: a shutdown refuses a new
    // connection, never one it already took.
    req.on("socket", (socket) =>
      socket.once("connect", () =>
        setTimeout(() => void later().then(() => req.end(text), fail), 50),
      ),
    );
  });
  return reply;
}

test("a shutdown answers PATCH and fast-forward with 503, not room_dismissed", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // A deaf turn holds the shutdown open for its 2 s grace.
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario deaf`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const p = only(open.body).id;
  await api(d, "POST", `/rooms/${id}/messages`, { text: "busy" });

  const stop = async () => {
    process.kill(d.pid, "SIGTERM");
    await new Promise((ok) => setTimeout(ok, 300));
  };
  const [patched, forwarded] = await Promise.all([
    bodyAfter(d, "PATCH", `/rooms/${id}/agents/${p}`, { name: "x" }, stop),
    bodyAfter(
      d,
      "POST",
      `/rooms/${id}/agents/${p}/fast-forward`,
      { from: p },
      () => new Promise((ok) => setTimeout(ok, 300)),
    ),
  ]);
  for (const r of [patched, forwarded]) {
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error.code, "shutting_down");
  }
  assert.equal((await d.done).code, 0);
});

test("chat.ts on a pipe: a diff while the daemon is away says so, and the screen stays", async (t) => {
  const { first, id, again, runtime, alice } = await roomToRestart(t, REMEMBER);
  const c = spawnCli(t, ["attach", id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  await c.waitFor("type a message");
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  // A screen that ends fails here at once, not on the test's timeout.
  const ended = c.done.then((r) => {
    throw new Error(`the screen ended with ${r.code}: ${r.stderr}`);
  });
  ended.catch(() => {});
  c.child.stdin.write(`@${alice.name} /diff\n`);
  await again();
  await Promise.race([c.waitFor("is paused; a message revives it"), ended]);
  c.child.stdin.end();
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /the daemon did not answer/);
});

test("adding a folder's repository while the daemon is away says so, and the screen stays", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const repo = await gitRepo(t); // never added
  const screen = await ptyScreen(
    t,
    "stty cols 130 rows 30; node chat.ts",
    { XDG_RUNTIME_DIR: runtime },
    "ctrl+o → new room",
  );
  // The add fails before any harness starts, so the command is never run.
  await screen.press(
    `/new --cmd mock --cwd ${repo}\r`,
    "is not added to the daemon",
  );
  process.kill(d.pid, "SIGKILL");
  await d.done;
  // Enter picks "add and open", the first row (M6-7d: the screen waits).
  await screen.press("\r", "the daemon did not answer");
  const r = await Promise.race([
    screen.exited,
    new Promise((ok) => setTimeout(() => ok("open"), 500)),
  ]);
  assert.equal(r, "open", plainText(screen.out()));
});

test("an answer while the daemon is away says so, and the screen stays", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario diff-first`,
        name: "asker",
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const screen = await ptyScreen(
    t,
    `stty cols 130 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${only(open.body).id}/messages`,
    { text: "go" },
  );
  await screen.seen("view diff");
  await pendingOne(d);
  process.kill(d.pid, "SIGKILL");
  // Enter answers deny, the first row (M6-7d: the screen waits).
  await screen.press("\r", "the daemon did not answer");
  const r = await Promise.race([
    screen.exited,
    new Promise((ok) => setTimeout(() => ok("open"), 500)),
  ]);
  assert.equal(r, "open", plainText(screen.out()));
});

// The test drives a whole pty session: its call count is the test.
// pi-lens-ignore: high-fan-out
test("chat.ts on a real terminal folds a tool run at the next note without moving the rows in view, and a click opens and folds it (M7-2)", {
  skip: noPty,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario runs`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const ann = only(open.body);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; node chat.ts attach ${open.body.id}`,
    { XDG_RUNTIME_DIR: runtime },
  );
  const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  // The note, then the live run: open, and waiting for runs.go.
  await screen.press("go\r", "Edit f5.ts");
  // A long message waits behind the turn: rows below the run.
  const lines = Array.from({ length: 40 }, (_, i) => `q${i + 10}`);
  const sent = await api(
    d,
    "POST",
    `/rooms/${open.body.id}/agents/${ann.id}/messages`,
    { text: lines.join("\n") },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  await screen.seen("q49");
  // The person scrolls up a little, to read the message. The run is above.
  await screen.press("\x1b[<64;50;10M", "q3");
  await wait(300);
  const before = rowOf(screen.out(), /│ q30\s*$/);
  assert.ok(before > 0, `q30 in view: ${screen.out()}`);
  assert.equal(rowOf(screen.out(), /Read f0\.ts/), 0, "the run is above");
  // The next note folds the run, above the view.
  await writeFile(join(ann.worktree, "runs.go"), "");
  await roomIdle(d, open.body.id);
  await wait(300);
  assert.equal(
    rowOf(screen.out(), /│ q30\s*$/),
    before,
    "the row in view did not move",
  );
  // Up to the top: the run is one line. A click opens it, a second folds it.
  for (let i = 0; i < 20; i++) screen.child.stdin.write("\x1b[<64;50;10M");
  for (const until = Date.now() + 10_000; ; ) {
    if (rowOf(screen.out(), /▸ 6 tool calls · 5 read · 1 edit/)) break;
    assert.ok(Date.now() < until, `no folded run: ${screen.out()}`);
    await wait(50);
  }
  const row = rowOf(screen.out(), /▸ 6 tool calls/);
  await screen.press(`\x1b[<0;50;${row}M\x1b[<0;50;${row}m`, "Read f0.ts");
  assert.equal(rowOf(screen.out(), /▾ 6 tool calls/), row);
  // Past pi-tui's 500 ms: a second click sooner is a double click, which
  // selects a word.
  await wait(600);
  await screen.press(`\x1b[<0;50;${row}M\x1b[<0;50;${row}m`, "▸ 6 tool calls");
  assert.equal(rowOf(screen.out(), /Read f0\.ts/), 0, "folded again");
  screen.child.stdin.write("\x03");
  await screen.seen("left room");
  assert.equal(await screen.exited, 0, screen.out());
});

test("a restart opens a room without links when its linkPaths went bad (#274)", async (t) => {
  const { first, cwd, id, again } = await roomToRestart(t, REMEMBER);
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  await mkdir(join(cwd, ".kapelle"), { recursive: true });
  await writeFile(
    join(cwd, ".kapelle", "config.json"),
    JSON.stringify({ linkPaths: ["README.md"] }),
    { mode: 0o644 },
  );

  const second = await again();
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.status, 200, got.body.error?.message);
  assert.equal(got.body.status, "paused");
  const notices = got.body.participants
    .flatMap((p) => p.notices)
    .map((n) => n.text)
    .join("\n");
  assert.match(notices, /the room opened without its links/);
});

test("a linkPaths entry git would see refuses a room's open as a 400", async (t) => {
  const d = await boot(t);
  const root = await added(
    d,
    await gitRepo(t, {
      files: {
        ".kapelle/config.json": `${JSON.stringify({ linkPaths: ["vendor.txt"] })}\n`,
      },
    }),
  );
  // Untracked and not ignored, so the link would dirty the checkout.
  await writeFile(join(root, "vendor.txt"), "vendor\n");

  const refused = await api(d, "POST", "/rooms", {
    cwd: root,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "alice" }],
  });
  assert.equal(refused.status, 400, refused.body.error?.message);
  assert.equal(refused.body.error.code, "invalid_config");
  assert.match(refused.body.error.message, /is not ignored in a new checkout/);
});
