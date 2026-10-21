/**
 * The daemon's life from a client — `client/lifecycle.ts`, story M9-2 (#297).
 *
 * Real daemons, real signals: each test spawns `daemon.ts` the way bare
 * `kapelle` does, then reads `daemon.json` and the log, or stops it. No
 * harness starts, so this runs in CI like the rest of `npm test`.
 *
 * The environment is passed in, never read from this process: the daemon
 * inherits the object `ensureDaemon` receives, so `XDG_RUNTIME_DIR`,
 * `XDG_STATE_HOME` and `KAPELLE_PORT=0` reach it without touching the test
 * runner's own environment. `KAPELLE_PORT=0` keeps a developer's real daemon
 * on 4719 out of the way.
 */

import assert from "node:assert/strict";
import { execFile as execFileCb, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { REPO, tempDir } from "../../integration/helpers.ts";
import { checkVersion } from "../daemon.ts";
import { ensureDaemon, stopDaemon } from "../lifecycle.ts";

const execFile = promisify(execFileCb);

interface Dirs {
  runtime: string;
  state: string;
}

/** Two user-level folders, as `kapelle` would have them. The state folder is
 *  created here because `stateDir()` belongs to the CLI, not this module. */
async function dirs(t: TestContext): Promise<Dirs> {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  await mkdir(join(state, "kapelle"), { recursive: true, mode: 0o700 });
  return { runtime, state };
}

/** The paths and environment one start needs. `KAPELLE_*` is stripped first,
 *  so an exported knob cannot change what this suite measures. */
function options({ runtime, state }: Dirs) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("KAPELLE_")) delete env[name];
  }
  Object.assign(env, {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(state, "config-home"),
    KAPELLE_PORT: "0",
  });
  return {
    file: join(runtime, "kapelle", "daemon.json"),
    log: join(state, "kapelle", "daemon.log"),
    script: join(REPO, "daemon.ts"),
    cwd: REPO,
    env,
  };
}

async function readRecord(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as {
    pid: number;
    port: number;
    token: string;
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Belt and braces: a failing assertion must not strand a daemon. */
function reap(t: TestContext, file: string) {
  t.after(async () => {
    try {
      const { pid } = await readRecord(file);
      process.kill(pid, "SIGKILL");
    } catch {
      // No record, or already stopped.
    }
  });
}

test("no daemon: starts one in its own session, logs it and answers", {
  skip: process.platform === "win32",
}, async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  reap(t, opts.file);

  await ensureDaemon(opts);

  const record = await readRecord(opts.file);
  assert.equal(alive(record.pid), true);
  assert.equal(
    await checkVersion({ port: record.port, token: record.token }),
    undefined,
  );
  assert.match(
    await readFile(opts.log, "utf8"),
    /listening on http:\/\/127\.0\.0\.1:/,
  );
  // `detached` makes this process a session leader; its sid is its pid.
  const sid = (
    await execFile("ps", ["-o", "sid=", "-p", String(record.pid)])
  ).stdout.trim();
  assert.equal(sid, String(record.pid), "the daemon is its own session leader");
});

test("a daemon that answers is reused, and no log is written", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  reap(t, opts.file);
  await ensureDaemon(opts);
  const first = await readRecord(opts.file);
  await rm(opts.log);

  await ensureDaemon(opts);

  assert.equal((await readRecord(opts.file)).pid, first.pid);
  await assert.rejects(readFile(opts.log), "the second call did not start one");
});

test("two ensures at once leave one daemon", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  reap(t, opts.file);

  await Promise.all([ensureDaemon(opts), ensureDaemon(opts)]);

  const record = await readRecord(opts.file);
  assert.equal(alive(record.pid), true);
  // Whichever spawn won, only one daemon ever logged that it listened.
  const logs = await Promise.all(
    [opts.log, `${opts.log}.1`].map((path) =>
      readFile(path, "utf8").catch(() => ""),
    ),
  );
  assert.equal(logs.join("").match(/listening on /g)?.length, 1);
});

test("a stale complete record is replaced, not obeyed", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  assert.ok(dead !== undefined);
  await writeFile(
    opts.file,
    JSON.stringify({ pid: dead, port: 1, token: "stale" }),
    { mode: 0o600 },
  );
  reap(t, opts.file);

  await ensureDaemon(opts);

  const record = await readRecord(opts.file);
  assert.notEqual(record.pid, dead);
  assert.notEqual(record.token, "stale");
  assert.equal(alive(record.pid), true);
});

test("an unready record with a live pid is waited on, not duplicated", async (t) => {
  const d = await dirs(t);
  const opts = { ...options(d), waitMs: 300 };
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  await writeFile(opts.file, JSON.stringify({ pid: process.pid }), {
    mode: 0o600,
  });

  await assert.rejects(ensureDaemon(opts), /did not start within 1 s/);
  await assert.rejects(readFile(opts.log), "it did not start a second daemon");
});

test("the previous log is kept beside the new one", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  reap(t, opts.file);

  await ensureDaemon(opts);
  assert.match(await readFile(opts.log, "utf8"), /listening on /);
  assert.equal(typeof (await stopDaemon(opts.file, 10_000)), "number");
  // Read after the stop: shutdown's own line belongs to the first log too.
  const first = await readFile(opts.log, "utf8");

  await ensureDaemon(opts);

  assert.equal(await readFile(`${opts.log}.1`, "utf8"), first);
  assert.match(await readFile(opts.log, "utf8"), /listening on /);
});

test("stopDaemon sends SIGTERM, waits for the pid and removes the record", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  reap(t, opts.file);
  await ensureDaemon(opts);
  const record = await readRecord(opts.file);

  assert.equal(await stopDaemon(opts.file, 10_000), record.pid);

  assert.equal(alive(record.pid), false);
  await assert.rejects(readFile(opts.file), "the record is gone");
  assert.equal(await stopDaemon(opts.file), undefined, "nothing left to stop");
});
