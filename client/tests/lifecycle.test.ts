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
import { execFile as execFileCb, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { processIdentity as coreIdentity } from "../../core/sweep.ts";
import { REPO } from "../../integration/helpers.ts";
import { checkVersion } from "../daemon.ts";
import {
  processIdentity as clientIdentity,
  ensureDaemon,
  stopDaemon,
} from "../lifecycle.ts";

const execFile = promisify(execFileCb);

interface Dirs {
  runtime: string;
  state: string;
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Poll a condition for a test that must observe a process mid-flight. */
async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail(message);
}

/** Two user-level folders, as `kapelle` would have them. The state folder is
 *  created here because `stateDir()` belongs to the CLI, not this module.
 *
 *  One teardown owns both folders and the daemon between them. It reads the
 *  pid before removing anything, so a failed assertion cannot delete the
 *  record a later cleanup needs, and it kills directly rather than waiting
 *  for a test-timeout. */
async function dirs(t: TestContext): Promise<Dirs> {
  const runtime = await mkdtemp(join(tmpdir(), "acp-it-runtime-"));
  const state = await mkdtemp(join(tmpdir(), "acp-it-state-"));
  await mkdir(join(state, "kapelle"), { recursive: true, mode: 0o700 });
  t.after(async () => {
    let pid: number | undefined;
    try {
      const record = JSON.parse(
        await readFile(join(runtime, "kapelle", "daemon.json"), "utf8"),
      ) as { pid?: unknown };
      if (
        typeof record.pid === "number" &&
        Number.isInteger(record.pid) &&
        record.pid > 0 &&
        record.pid !== process.pid
      ) {
        pid = record.pid;
      }
    } catch {
      // No record, unreadable record, or the daemon already stopped.
    }
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      for (
        const deadline = Date.now() + 2_000;
        alive(pid) && Date.now() < deadline;
      ) {
        await sleep(20);
      }
    }
    await rm(runtime, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
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

test("no daemon: starts one in its own session, logs it and answers", {
  skip: process.platform === "win32",
}, async (t) => {
  const d = await dirs(t);
  const opts = options(d);

  await ensureDaemon(opts);

  const record = await readRecord(opts.file);
  assert.equal(alive(record.pid), true);
  assert.equal(
    await checkVersion({ port: record.port, token: record.token }),
    undefined,
  );
  const identity = JSON.parse(
    await readFile(`${opts.file}.identity`, "utf8"),
  ) as { pid?: unknown; startedAt?: unknown };
  assert.equal(identity.pid, record.pid);
  assert.equal(typeof identity.startedAt, "string");
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

test("two starts at once keep the previous log", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await writeFile(opts.log, "the previous start\n", { mode: 0o600 });

  await Promise.all([ensureDaemon(opts), ensureDaemon(opts)]);

  assert.equal(await readFile(`${opts.log}.1`, "utf8"), "the previous start\n");
  assert.match(await readFile(opts.log, "utf8"), /listening on /);
});

test("a start lock left by a dead process does not block a start", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  assert.ok(dead !== undefined);
  await writeFile(`${opts.file}.starting`, String(dead), { mode: 0o600 });

  await ensureDaemon(opts);

  const record = await readRecord(opts.file);
  assert.equal(alive(record.pid), true);
});

test("an empty current log does not overwrite the last one", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await writeFile(opts.log, "", { mode: 0o600 });
  await writeFile(`${opts.log}.1`, "the last useful start\n", {
    mode: 0o600,
  });

  await ensureDaemon(opts);

  assert.equal(
    await readFile(`${opts.log}.1`, "utf8"),
    "the last useful start\n",
  );
  assert.match(await readFile(opts.log, "utf8"), /listening on /);
});

test("a stale live pid with a mismatched identity is replaced", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const stranger = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => {
    try {
      stranger.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  assert.ok(stranger.pid !== undefined);
  await writeFile(
    opts.file,
    JSON.stringify({ pid: stranger.pid, port: 1, token: "stale" }),
    { mode: 0o600 },
  );
  await writeFile(
    `${opts.file}.identity`,
    JSON.stringify({ pid: stranger.pid, startedAt: "not its start time" }),
    { mode: 0o600 },
  );

  await ensureDaemon(opts);

  const record = await readRecord(opts.file);
  assert.notEqual(record.pid, stranger.pid);
  assert.equal(alive(record.pid), true);
});

test("a fresh token is enough when the new daemon reports the stale pid", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const stranger = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => {
    try {
      stranger.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  assert.ok(stranger.pid !== undefined);
  await writeFile(
    opts.file,
    JSON.stringify({ pid: stranger.pid, port: 1, token: "stale" }),
    { mode: 0o600 },
  );

  // The live pid has no identity, so it stays as the stale record. The fake
  // daemon publishes a fresh token under the same pid; only the token proves
  // a new start, because the OS may have handed the pid on.
  const script = join(d.state, "reused-pid-daemon.mjs");
  await writeFile(
    script,
    `
import { writeFileSync } from "node:fs";
writeFileSync(
  ${JSON.stringify(opts.file)},
  JSON.stringify({ pid: ${JSON.stringify(stranger.pid)}, port: 1, token: "fresh" }),
  { mode: 0o600 },
);
process.exit(0);
`,
    { mode: 0o600 },
  );

  await ensureDaemon({ ...opts, script, waitMs: 1_000 });

  const record = await readRecord(opts.file);
  assert.equal(record.pid, stranger.pid);
  assert.equal(record.token, "fresh");
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

  await ensureDaemon(opts);

  const record = await readRecord(opts.file);
  assert.notEqual(record.pid, dead);
  assert.notEqual(record.token, "stale");
  assert.equal(alive(record.pid), true);
});

test("a lock-refused start waits for the starter that holds the lock", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  assert.ok(dead !== undefined);
  await writeFile(
    opts.file,
    JSON.stringify({ pid: dead, port: 1, token: "old" }),
    { mode: 0o600 },
  );
  const lock = `${opts.file}.lock`;
  await mkdir(lock);

  const attempt = join(d.state, "lock-refused-attempt");
  const script = join(d.state, "lock-refused-daemon.mjs");
  await writeFile(
    script,
    `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(attempt)}, "attempt");
process.exit(1);
`,
    { mode: 0o600 },
  );
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => {
    try {
      dummy.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  assert.ok(dummy.pid !== undefined);

  let settled = false;
  const starting = ensureDaemon({ ...opts, script, waitMs: 5_000 })
    .then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    )
    .finally(() => {
      settled = true;
    });
  await until(
    () =>
      readFile(attempt, "utf8").then(
        () => true,
        () => false,
      ),
    "the fake starter did not exit like a lock-refused daemon",
  );

  // The lock holder is still claiming the record. A client must wait for it,
  // not turn its own child's refusal into a startup failure.
  await sleep(300);
  assert.equal(settled, false, "ensureDaemon failed while the lock was held");
  assert.equal(alive(dummy.pid), true);
  await writeFile(
    opts.file,
    JSON.stringify({ pid: dummy.pid, port: 1, token: "fresh" }),
    { mode: 0o600 },
  );
  await rm(lock, { recursive: true, force: true });

  const result = await starting;
  assert.equal(
    result.ok,
    true,
    result.ok ? undefined : `unexpected failure: ${String(result.err)}`,
  );
  const record = await readRecord(opts.file);
  assert.equal(record.pid, dummy.pid);
  assert.equal(record.token, "fresh");
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
  await ensureDaemon(opts);
  const record = await readRecord(opts.file);

  assert.equal(await stopDaemon(opts.file, 10_000), record.pid);

  assert.equal(alive(record.pid), false);
  await assert.rejects(readFile(opts.file), "the record is gone");
  assert.equal(await stopDaemon(opts.file), undefined, "nothing left to stop");
});

test("stopDaemon leaves a live pid with no answering daemon alone", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const stranger = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => {
    try {
      stranger.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  assert.ok(stranger.pid !== undefined);
  await writeFile(
    opts.file,
    JSON.stringify({ pid: stranger.pid, port: 1, token: "stale" }),
    { mode: 0o600 },
  );

  assert.equal(await stopDaemon(opts.file, 2_000), undefined);
  assert.equal(alive(stranger.pid), true, "the stranger was not signalled");
  await assert.rejects(readFile(opts.file), "the stale record is gone");
});

test("stopDaemon does not trust a foreign answer on the recorded port", async (t) => {
  // A 401 is another daemon's token; a non-JSON 200 is another server. Neither
  // proves the recorded pid is the daemon, so neither may be signalled.
  for (const reply of [
    { status: 401, body: '{"error":{"code":"unauthorized"}}' },
    { status: 200, body: "<html>not a daemon</html>" },
  ]) {
    const d = await dirs(t);
    const opts = options(d);
    await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
    const stranger = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    t.after(() => {
      try {
        stranger.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    });
    assert.ok(stranger.pid !== undefined);
    const server = createHttpServer((_req, res) => {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body);
    });
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", ok);
    });
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await writeFile(
      opts.file,
      JSON.stringify({
        pid: stranger.pid,
        port: address.port,
        token: "stale",
      }),
      { mode: 0o600 },
    );

    assert.equal(await stopDaemon(opts.file, 2_000), undefined);
    assert.equal(
      alive(stranger.pid),
      true,
      `a ${reply.status} answer on the port signalled the stranger`,
    );
    await assert.rejects(readFile(opts.file), "the stale record is gone");
  }
});

test("a start retries once when the stale live pid disappears", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const first = join(d.state, "first-attempt");
  const early = join(d.state, "early-attempt");
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => {
    try {
      dummy.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  assert.ok(dummy.pid !== undefined);
  const script = join(d.state, "retrying-daemon.mjs");
  await writeFile(
    script,
    `
import { existsSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(opts.file)};
const first = ${JSON.stringify(first)};
const early = ${JSON.stringify(early)};
const dummyPid = ${JSON.stringify(dummy.pid)};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
if (!existsSync(first)) {
  writeFileSync(first, "first");
  process.exit(1);
}
if (alive(dummyPid)) {
  writeFileSync(early, "early");
  process.exit(1);
}
writeFileSync(file, JSON.stringify({
  pid: process.pid,
  port: 1,
  token: "fresh",
}), { mode: 0o600 });
setInterval(() => {}, 1000);
`,
    { mode: 0o600 },
  );
  const exiting = new Promise<void>((ok) => dummy.once("exit", () => ok()));
  await writeFile(opts.log, "the previous start\n", { mode: 0o600 });
  await writeFile(
    opts.file,
    JSON.stringify({ pid: dummy.pid, port: 1, token: "stale" }),
    { mode: 0o600 },
  );

  const starting = ensureDaemon({ ...opts, script, waitMs: 5_000 }).then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  await until(
    () =>
      readFile(first, "utf8").then(
        () => true,
        () => false,
      ),
    "the first attempt did not exit",
  );

  // A retry now would run while the stale pid is still alive. Give an
  // unconditional retry enough time to betray itself.
  await sleep(300);
  assert.equal(alive(dummy.pid), true);
  await assert.rejects(
    readFile(early, "utf8"),
    "the retry ran while the stale pid was alive",
  );

  dummy.kill("SIGKILL");
  await exiting;
  const result = await starting;
  assert.equal(
    result.ok,
    true,
    result.ok ? undefined : `unexpected failure: ${String(result.err)}`,
  );
  await assert.rejects(
    readFile(early, "utf8"),
    "the retry found the stale pid alive",
  );
  // The retry is the same start: it must not push the last start's log out.
  assert.equal(await readFile(`${opts.log}.1`, "utf8"), "the previous start\n");

  const record = await readRecord(opts.file);
  assert.notEqual(record.pid, dummy.pid);
  assert.equal(record.token, "fresh");
  assert.equal(alive(record.pid), true);
});

test("a daemon start that cannot listen fails promptly and names the log", {
  skip: process.platform === "win32",
}, async (t) => {
  const d = await dirs(t);
  const base = options(d);
  const occupied = createServer();
  await new Promise<void>((ok, fail) => {
    occupied.once("error", fail);
    occupied.listen(0, "127.0.0.1", ok);
  });
  t.after(() => occupied.close());
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const opts = {
    ...base,
    env: { ...base.env, KAPELLE_PORT: String(address.port) },
    waitMs: 15_000,
  };

  const started = Date.now();
  await assert.rejects(ensureDaemon(opts), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /exited before it was ready \(exit code 1\)/);
    assert.ok(err.message.includes(opts.log), "the failure names the log");
    return true;
  });
  assert.ok(
    Date.now() - started < 5_000,
    "a child that exits must not wait out the start timeout",
  );
  assert.match(
    await readFile(opts.log, "utf8"),
    /cannot listen on 127\.0\.0\.1/,
  );
  await assert.rejects(readFile(opts.file), "the refused start left no record");
});

test("stopDaemon waits for SIGTERM and process exit before reporting", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const marker = join(d.state, "term-received");
  const release = join(d.state, "release");
  const ready = join(d.state, "ready");
  const script = join(d.state, "delayed-daemon.mjs");
  await writeFile(
    script,
    `
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [record, marker, release, ready] = process.argv.slice(2);
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ apiVersion: { major: 1, minor: 0 } }));
});
process.on("SIGTERM", () => writeFileSync(marker, "SIGTERM"));
server.listen(0, "127.0.0.1", () => {
  writeFileSync(
    record,
    JSON.stringify({ pid: process.pid, port: server.address().port, token: "fake" }),
    { mode: 0o600 },
  );
  writeFileSync(ready, "ready");
});
const timer = setInterval(() => {
  if (!existsSync(release)) return;
  clearInterval(timer);
  rmSync(record, { force: true });
  server.close();
  process.exit(0);
}, 10);
`,
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [script, opts.file, marker, release, ready],
    { cwd: REPO, stdio: "ignore" },
  );
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  await until(
    () =>
      readFile(ready, "utf8").then(
        () => true,
        () => false,
      ),
    "the fake daemon did not become ready",
  );
  assert.ok(child.pid !== undefined);

  let returned = false;
  const stopping = stopDaemon(opts.file, 5_000).then((pid) => {
    returned = true;
    return pid;
  });
  await until(
    () =>
      readFile(marker, "utf8").then(
        () => true,
        () => false,
      ),
    "the fake daemon did not receive SIGTERM",
  );
  assert.equal(returned, false, "stopDaemon returned before the daemon exited");
  assert.equal(alive(child.pid), true);

  // Keep it alive across more than one poll interval. A stop that sends
  // SIGTERM and returns without checking process exit returns here.
  await sleep(300);
  assert.equal(returned, false, "stopDaemon returned while the daemon lived");
  assert.equal(alive(child.pid), true);

  await writeFile(release, "release");
  assert.equal(await stopping, child.pid);
  assert.equal(alive(child.pid), false);
  await assert.rejects(readFile(opts.file), "the record is gone");
});

test("stopDaemon waits for a pid-only record to publish its address", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const script = join(d.state, "slow-record.mjs");
  await writeFile(
    script,
    `
import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [record] = process.argv.slice(2);
const writeRecord = (body) => {
  const tmp = \`\${record}.\${process.pid}\`;
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  renameSync(tmp, record);
};
writeRecord({ pid: process.pid });
setTimeout(() => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ apiVersion: { major: 1, minor: 0 } }));
  });
  server.listen(0, "127.0.0.1", () => {
    writeRecord({
      pid: process.pid,
      port: server.address().port,
      token: "slow",
    });
  });
}, 150);
`,
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [script, opts.file], {
    cwd: REPO,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  assert.ok(child.pid !== undefined);
  await until(
    () =>
      readFile(opts.file, "utf8").then(
        () => true,
        () => false,
      ),
    "the fake daemon did not write its pid",
  );

  assert.equal(await stopDaemon(opts.file, 5_000), child.pid);
  assert.equal(alive(child.pid), false);
  await assert.rejects(readFile(opts.file), "the record is gone");
});

test("stopDaemon reports a daemon that ignores SIGTERM", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const script = join(d.state, "stubborn-daemon.mjs");
  await writeFile(
    script,
    `
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [record] = process.argv.slice(2);
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ apiVersion: { major: 1, minor: 0 } }));
});
process.on("SIGTERM", () => {});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(
    record,
    JSON.stringify({ pid: process.pid, port: server.address().port, token: "stubborn" }),
    { mode: 0o600 },
  );
});
`,
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [script, opts.file], {
    cwd: REPO,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  assert.ok(child.pid !== undefined);
  await until(
    () =>
      readFile(opts.file, "utf8").then(
        () => true,
        () => false,
      ),
    "the stubborn daemon did not write its record",
  );

  await assert.rejects(stopDaemon(opts.file, 250), /did not stop within 1 s/);
  assert.equal(alive(child.pid), true);
  await readFile(opts.file, "utf8");
});

test("stopDaemon removes the record a daemon left when SIGTERM killed it", async (t) => {
  const d = await dirs(t);
  const opts = options(d);
  await mkdir(join(d.runtime, "kapelle"), { recursive: true, mode: 0o700 });
  const script = join(d.state, "left-daemon.mjs");
  await writeFile(
    script,
    `
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [record] = process.argv.slice(2);
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ apiVersion: { major: 1, minor: 0 } }));
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(
    record,
    JSON.stringify({ pid: process.pid, port: server.address().port, token: "left" }),
    { mode: 0o600 },
  );
});
`,
    { mode: 0o600 },
  );
  // A process with no SIGTERM handler dies at once and removes nothing.
  const child = spawn(process.execPath, [script, opts.file], {
    cwd: REPO,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  assert.ok(child.pid !== undefined);
  await until(
    () =>
      readFile(opts.file, "utf8").then(
        () => true,
        () => false,
      ),
    "the fake daemon did not write its record",
  );

  assert.equal(await stopDaemon(opts.file, 5_000), child.pid);

  assert.equal(alive(child.pid), false);
  await assert.rejects(readFile(opts.file), "the left record is removed");
});

test("the two process identity readers agree", {
  skip: process.platform === "win32",
}, async () => {
  // `client/lifecycle.ts` cannot import `core/sweep.ts`; a drift in the `ps`
  // flags or locale env would make every identity read as stale.
  const [client, core] = await Promise.all([
    clientIdentity(process.pid),
    coreIdentity(process.pid),
  ]);
  assert.equal(client, core);
  assert.ok(client, "ps could not read this process's start time");
});
