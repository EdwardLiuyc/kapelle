/**
 * The daemon process — `daemon.ts`, M2-1 (#31) — driven as a real subprocess
 * over real HTTP: the token and the Host check, `daemon.json` and its lock,
 * start, stop and add, the config, the repositories, and the agents it finds
 * (M9-3) and installs (M9-3b). The other subjects have their own files: `daemon-runs`,
 * `daemon-rooms`, `attach` and the `chat-*` files (#340).
 *
 * **None of this needs a harness**, so it runs in CI like `tests/cli.test.ts`:
 * every run points at `mock-agent.mjs`, and every refusal fails before a
 * subprocess starts. Most tests point both directories at one temp dir; the
 * restart and fallback tests keep them apart, the way a reboot does in real
 * life.
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` **and `XDG_STATE_HOME`**, so no
 * test ever meets another test's `daemon.json` or `repos.json` — or the
 * developer's real ones — even while the other files run at the same time.
 * The helpers more than one of these files needs live in
 * `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  ErrorReply,
  HarnessesReply,
  InstallLine,
  InstallResult,
} from "../client/contract.ts";
import {
  addRepo as added,
  api,
  bootDaemon as boot,
  bootFinding,
  type Daemon,
  useDaemonDirs as dirs,
  exitOf,
  fakeNpm,
  fakePath,
  gitRepo,
  gone,
  MOCK_AGENT,
  mockRun,
  REPO,
  type RoomReply,
  spawnCli,
  startDaemon as start,
  tempDir,
} from "../integration/helpers.ts";
import { AGENTS } from "../protocol/registry.ts";

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

// --- across a restart (M2-6, #36) -------------------------------------------

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

// --- room commands (M4-5) -----------------------------------------------------

test("GET /harnesses lists every harness the daemon can launch, and which were measured", async (t) => {
  const d = await boot(t);
  const r = await api<HarnessesReply>(d, "GET", "/harnesses");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.harnesses.map(({ id, measured }) => ({ id, measured })),
    Object.entries(AGENTS).map(([id, a]) => ({
      id,
      measured: a.measured !== undefined,
    })),
  );
  // M9 D2: the registry keeps only measured harnesses.
  assert.ok(r.body.harnesses.every((h) => h.measured));
});

const stateOf = (r: HarnessesReply, id: string) =>
  r.harnesses.find((h) => h.id === id)?.state;

test("the daemon finds the agents on its own PATH, saves the find, and keeps done (M9-3)", async (t) => {
  const bin = await fakePath(t);
  const { d, runtime } = await bootFinding(t, bin);
  const r = await api<HarnessesReply>(d, "GET", "/harnesses");
  assert.equal(r.status, 200);
  assert.equal(r.body.done, false);
  assert.deepEqual(
    Object.fromEntries(r.body.harnesses.map((h) => [h.id, h.state])),
    {
      opencode: "ready",
      pi: "ready",
      claude: "main_only",
      copilot: "not_installed",
      codex: "not_installed",
      kimi: "ready",
    },
  );
  assert.match(
    r.body.harnesses.find((h) => h.id === "pi")?.warning ?? "",
    /pi-acp 0\.0\.33/,
  );
  assert.ok(existsSync(join(runtime, "kapelle", "harnesses.json")));

  const done = await api<HarnessesReply>(d, "POST", "/harnesses/done");
  assert.equal(done.status, 200);
  assert.equal(done.body.done, true);

  // The person installs claude's ACP program. A GET reads the saved find;
  // a POST finds again, and keeps "done".
  await writeFile(join(bin, "claude-agent-acp"), "#!/bin/sh\necho 0.89.1\n", {
    mode: 0o755,
  });
  const saved = await api<HarnessesReply>(d, "GET", "/harnesses");
  assert.equal(stateOf(saved.body, "claude"), "main_only");
  const again = await api<HarnessesReply>(d, "POST", "/harnesses");
  assert.equal(again.status, 200);
  assert.equal(stateOf(again.body, "claude"), "ready");
  assert.equal(again.body.done, true);
  assert.notEqual(again.body.checkedAt, r.body.checkedAt);

  // `kapelle setup` finds again and prints the list; it does not say done.
  await rm(join(bin, "claude-agent-acp"));
  const cli = await spawnCli(t, ["setup"], "cli.ts", {
    XDG_RUNTIME_DIR: runtime,
  }).done;
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(
    cli.stdout,
    /^claude +claude 2\.1\.307; needs claude-agent-acp: npm i -g @agentclientprotocol\/claude-agent-acp@0\.89\.1$/m,
  );
  assert.match(
    cli.stdout,
    /^codex +not installed: no codex on the daemon's PATH$/m,
  );
  assert.match(cli.stdout, /^! pi-acp 0\.0\.33 is not the build/m);
  const after = await api<HarnessesReply>(d, "GET", "/harnesses");
  assert.equal(stateOf(after.body, "claude"), "main_only");
  assert.equal(after.body.done, true);
});

test("a find keeps done when an incomplete saved file forces it (M9-3)", async (t) => {
  const bin = await fakePath(t);
  const { d, runtime } = await bootFinding(t, bin);
  const first = await api<HarnessesReply>(d, "GET", "/harnesses");
  assert.equal(first.status, 200);
  assert.equal(first.body.done, false);
  assert.equal(
    (await api<HarnessesReply>(d, "POST", "/harnesses/done")).body.done,
    true,
  );

  // A later registry has an agent the saved file does not: readSetup calls
  // the file incomplete and the next GET finds again. That must not reset
  // the person's "done".
  const file = join(runtime, "kapelle", "harnesses.json");
  const saved = JSON.parse(await readFile(file, "utf8")) as HarnessesReply & {
    found: Record<string, unknown>;
  };
  delete saved.found.kimi;
  await writeFile(file, JSON.stringify(saved));

  const again = await api<HarnessesReply>(d, "GET", "/harnesses");
  assert.equal(again.status, 200);
  assert.equal(again.body.done, true);
  assert.equal(stateOf(again.body, "kimi"), "ready");
  const rewritten = JSON.parse(await readFile(file, "utf8")) as {
    done: unknown;
  };
  assert.equal(rewritten.done, true);
});

/** `POST /harnesses/install` with `body`, every NDJSON line read. */
async function install(d: Daemon, body: unknown) {
  const res = await fetch(`${d.url}/harnesses/install`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      status: res.status,
      error: (JSON.parse(text) as ErrorReply).error,
    };
  }
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as InstallLine);
  const last = lines.at(-1) as InstallResult;
  const output = lines.map((l) => ("output" in l ? l.output : "")).join("");
  return { status: res.status, lines, last, output };
}

/** Where `cmd` is: a fake program on a bare `PATH` names its tools in full. */
const absolute = (cmd: string) =>
  spawnSync("sh", ["-c", `command -v ${cmd}`], {
    encoding: "utf8",
  }).stdout.trim();

const CLAUDE_PIN = "npm i -g @agentclientprotocol/claude-agent-acp@0.89.1";

test("POST /harnesses/install runs the pinned npm command, streams its output, and finds again (M9-3b)", async (t) => {
  const bin = await fakePath(t);
  await fakeNpm(bin);
  const { d } = await bootFinding(t, bin);
  const before = await api<HarnessesReply>(d, "GET", "/harnesses");
  const claude = before.body.harnesses.find((h) => h.id === "claude");
  assert.equal(claude?.state, "main_only");
  // The list shows the very command the install runs.
  assert.equal(claude?.install, CLAUDE_PIN);

  const r = await install(d, { ids: ["claude", "claude"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.lines?.[0], { id: "claude", command: CLAUDE_PIN });
  assert.match(r.output ?? "", /added 1 package/);
  assert.deepEqual(r.last?.failed, []);
  assert.equal(stateOf(r.last?.setup as HarnessesReply, "claude"), "ready");
  assert.equal(
    r.last?.setup.harnesses.find((h) => h.id === "claude")?.warning,
    undefined,
  );
  // One npm, with the pin from the registry, and the duplicate id dropped.
  assert.equal(
    await readFile(join(bin, "npm.argv"), "utf8"),
    "i -g @agentclientprotocol/claude-agent-acp@0.89.1\n",
  );
});

test("POST /harnesses/install runs the checked agents one after the other (M9-3b)", async (t) => {
  const bin = await fakePath(t);
  await writeFile(join(bin, "codex"), "#!/bin/sh\necho 1.0.0\n", {
    mode: 0o755,
  });
  await rm(join(bin, "codex-acp"));
  const log = join(bin, "npm.log");
  const claudeAcp = join(bin, "claude-agent-acp");
  const codexAcp = join(bin, "codex-acp");
  const claude = "i -g @agentclientprotocol/claude-agent-acp@0.89.1";
  const codex = "i -g @agentclientprotocol/codex-acp@2.2.2";
  const installProgram = (file: string, version: string) =>
    `printf '#!/bin/sh\\necho ${version}\\n' > "${file}"\n` +
    `${absolute("chmod")} 755 "${file}"`;
  await writeFile(
    join(bin, "npm"),
    '#!/bin/sh\nargs="$*"\n' +
      `echo "start $args" >> "${log}"\n${absolute("sleep")} 0.1\n` +
      `if [ "$args" = "${claude}" ]; then\n${installProgram(claudeAcp, "0.89.1")}\n` +
      `elif [ "$args" = "${codex}" ]; then\n${installProgram(codexAcp, "2.2.2")}\nfi\n` +
      `echo "end $args" >> "${log}"\n`,
    { mode: 0o755 },
  );
  const { d } = await bootFinding(t, bin);
  const before = await api<HarnessesReply>(d, "GET", "/harnesses");
  assert.equal(stateOf(before.body, "claude"), "main_only");
  assert.equal(stateOf(before.body, "codex"), "main_only");

  const r = await install(d, { ids: ["claude", "codex"] });
  assert.deepEqual(r.last?.failed, []);
  assert.equal(stateOf(r.last?.setup as HarnessesReply, "claude"), "ready");
  assert.equal(stateOf(r.last?.setup as HarnessesReply, "codex"), "ready");
  assert.equal(
    await readFile(log, "utf8"),
    `start ${claude}\nend ${claude}\nstart ${codex}\nend ${codex}\n`,
  );
});

test("the install's find starts after npm, not with one already in flight (M9-3b)", async (t) => {
  const bin = await fakePath(t);
  await fakeNpm(bin, { hold: true });
  // opencode's version probe holds the find open across npm's install.
  const started = join(bin, "version-started");
  await writeFile(
    join(bin, "opencode"),
    `#!/bin/sh\n${absolute("touch")} "${started}"\n${absolute("sleep")} 1\n` +
      'echo "opencode v2.0.18"\n',
    { mode: 0o755 },
  );
  const { d } = await bootFinding(t, bin);
  const installing = install(d, { ids: ["claude"] });
  while (!existsSync(join(bin, "npm.argv"))) {
    await new Promise((ok) => setTimeout(ok, 20));
  }
  // This find snapshots PATH before npm writes claude-agent-acp.
  const before = api<HarnessesReply>(d, "POST", "/harnesses");
  while (!existsSync(started)) {
    await new Promise((ok) => setTimeout(ok, 20));
  }
  await writeFile(join(bin, "go"), "");
  const [r, stale] = await Promise.all([installing, before]);
  assert.equal(stale.status, 200);
  assert.equal(stateOf(stale.body, "claude"), "main_only");
  assert.equal(stateOf(r.last?.setup as HarnessesReply, "claude"), "ready");
});

test("the install stream reaches a chat before npm ends, and a chat that leaves does not stop npm (M9-3b)", async (t) => {
  const bin = await fakePath(t);
  await fakeNpm(bin, { hold: true });
  const { d } = await bootFinding(t, bin);
  const res = await fetch(`${d.url}/harnesses/install`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ids: ["claude"] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  const reader = res.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buffered = "";
  const readLine = async () => {
    for (;;) {
      const at = buffered.indexOf("\n");
      if (at >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        return line;
      }
      const { done, value } = await reader.read();
      assert.equal(done, false);
      buffered += decoder.decode(value, { stream: true });
    }
  };
  assert.deepEqual(JSON.parse(await readLine()), {
    id: "claude",
    command: CLAUDE_PIN,
  });
  const output = JSON.parse(await readLine()) as { output?: string };
  assert.match(output.output ?? "", /npm http fetch GET 200/);
  assert.equal(existsSync(join(bin, "go")), false, "npm still runs");

  // The chat leaves before npm exits. Its response body is cancelled, but
  // the daemon's install keeps going and writes the new find.
  await reader.cancel();
  await writeFile(join(bin, "go"), "");
  let found: HarnessesReply | undefined;
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    found = (await api<HarnessesReply>(d, "GET", "/harnesses")).body;
    if (stateOf(found, "claude") === "ready") break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(stateOf(found as HarnessesReply, "claude"), "ready");
});

test("an install error after its headers cuts the stream and leaves the daemon up (M9-3b)", async (t) => {
  const bin = await fakePath(t);
  await fakeNpm(bin, { hold: true });
  const { d, runtime } = await bootFinding(t, bin);
  const dir = join(runtime, "kapelle");
  const res = await fetch(`${d.url}/harnesses/install`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ids: ["claude"] }),
  });
  assert.equal(res.status, 200);
  const reader = res.body?.getReader();
  assert.ok(reader);
  await reader.read();
  // Let the stream start, then make the final find's write fail.
  await chmod(dir, 0o555);
  try {
    await writeFile(join(bin, "go"), "");
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch {
      // The daemon cuts a stream whose headers are already sent.
    }
    const after = await api<unknown>(d, "GET", "/version");
    assert.equal(after.status, 200);
  } finally {
    await chmod(dir, 0o755);
  }
});

test("POST /harnesses/install takes agent ids only, and only main-only ones (M9-3b)", async (t) => {
  const bin = await fakePath(t);
  await fakeNpm(bin);
  const { d } = await bootFinding(t, bin);
  for (const body of [
    { command: "npm i -g evil" },
    { ids: ["claude"], command: "npm i -g evil" },
    { ids: "claude" },
    { ids: [] },
    { ids: [1] },
    { ids: ["npm i -g evil"] },
    { ids: ["nope"] },
    { ids: ["__proto__"] },
    // Ready: no box (1A). opencode is its own ACP program; codex has no main.
    { ids: ["pi"] },
    { ids: ["opencode"] },
    { ids: ["codex"] },
    // One bad id refuses the whole list, before npm runs.
    { ids: ["claude", "nope"] },
  ]) {
    const r = await install(d, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.error?.code, "invalid_request", JSON.stringify(body));
  }
  assert.equal(existsSync(join(bin, "npm.argv")), false);
});

test("a failed install names the error and the command, and the agent stays main-only (M9-3b)", async (t) => {
  const bin = await fakePath(t);
  await fakeNpm(bin, { fail: true });
  const { d } = await bootFinding(t, bin);
  const r = await install(d, { ids: ["claude"] });
  assert.equal(r.status, 200);
  assert.match(r.output ?? "", /EACCES/);
  assert.deepEqual(r.last?.failed, [
    { id: "claude", command: CLAUDE_PIN, error: "npm exited with code 243" },
  ]);
  assert.equal(stateOf(r.last?.setup as HarnessesReply, "claude"), "main_only");
});

test("a second install while one runs is refused (M9-3b)", async (t) => {
  const bin = await fakePath(t);
  await fakeNpm(bin, { hold: true });
  const { d } = await bootFinding(t, bin);
  const first = install(d, { ids: ["claude"] });
  // The first one holds npm until bin/go exists.
  while (!existsSync(join(bin, "npm.argv"))) {
    await new Promise((ok) => setTimeout(ok, 20));
  }
  const second = await install(d, { ids: ["claude"] });
  assert.equal(second.status, 409);
  assert.equal(second.error?.code, "install_running");
  await writeFile(join(bin, "go"), "");
  const r = await first;
  assert.deepEqual(r.last?.failed, []);
  // The guard is released: the next one runs (claude is ready now, so 400).
  assert.equal((await install(d, { ids: ["claude"] })).status, 400);
});
