/**
 * The daemon's life, from a client (M9-2): start it when none answers, and
 * stop it on request.
 *
 * **Starting is a detached spawn, not `daemon start`.** `kapelle daemon
 * start` imports `daemon.ts` into this process and stays in the foreground;
 * bare `kapelle` needs the daemon to outlive the terminal, so it spawns the
 * same file in its own session (`detached` does `setsid`). Its stdin is
 * `/dev/null`, and stdout and stderr go to one log file in the user state
 * folder. `daemon.log` is this start's; the previous one is renamed to
 * `daemon.log.1` first, so one last log is kept beside it.
 *
 * **A start lock rotates the log once.** Two `kapelle` starting together
 * both see no daemon; one takes `${daemon.json}.starting`, rotates the log
 * and spawns. The other waits for that start instead of rotating the new log
 * over the previous one. The daemon's own lock still settles a race with
 * `kapelle daemon start` or another copy of this module.
 *
 * **`daemon.json` is the readiness signal.** It is written with only `pid`
 * at the claim and with `pid`, `port` and `token` once the port is open. A
 * record that already names a complete address is probed with `GET
 * /version`: an answer means reuse it, silence means it was left by a dead
 * daemon and a start is needed. After a start, the record must be new (a
 * different token), because the stale record is still readable for the few
 * milliseconds before the new daemon claims the file.
 *
 * **A pid is not an identity.** `daemon.ts` writes `${daemon.json}.identity`
 * with its `ps` start time. Before treating a live pid as a daemon, this
 * module compares that time. A recycled pid is then stale: it is never
 * signalled by `daemon stop`, and it does not block a fresh start. A missing
 * identity falls back to a verified `/version` answer at the address, and
 * then to the old behaviour of waiting for a live pid, so an older daemon
 * still works.
 *
 * **A stop is SIGTERM and a wait.** `daemon.ts` cancels its runs and pauses
 * its rooms on SIGTERM, then removes `daemon.json` and exits. This waits for
 * the pid to go, then removes a record the daemon did not remove itself —
 * only while it still names that pid, so a daemon that took over in the
 * meantime keeps its file.
 */

import {
  type ChildProcess,
  execFile as execFileCb,
  spawn,
} from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { VersionReply } from "./contract.ts";
import {
  call,
  type DaemonAddress,
  readDaemonRecord,
  request,
} from "./daemon.ts";

/** How often a start or stop looks at the daemon again. */
const POLL_MS = 50;
/** A live daemon answers `GET /version` in a moment; one that cannot is gone. */
const PROBE_MS = 2_000;
/** How long a start may take before it is reported as stuck. */
const START_WAIT_MS = 15_000;
/** A stop waits for runs and rooms to settle, so it gets longer. */
const STOP_WAIT_MS = 30_000;
/** A lock file with no pid is given this long to be filled in. */
const START_LOCK_GRACE_MS = 500;

interface StartOptions {
  /** `daemon.json`. */
  file: string;
  /** This start's log; the previous one is kept at `${log}.1`. */
  log: string;
  /** `daemon.ts`, run with this Node. */
  script: string;
  /** The daemon's working directory. */
  cwd: string;
  /** What the daemon inherits. `process.env` by default. */
  env?: NodeJS.ProcessEnv;
  /** Override for the start wait; tests use a short one. */
  waitMs?: number;
}

interface RecordLike {
  pid?: number;
  address?: DaemonAddress;
}

interface DaemonIdentity {
  pid: number;
  startedAt: string;
}

/** Start locks this process holds, so a second call does not take ours for stale. */
const heldStarts = new Set<string>();

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const execFile = promisify(execFileCb);
const identityPath = (file: string) => `${file}.identity`;
const startLockPath = (file: string) => `${file}.starting`;

/** Is `pid` a live process? `EPERM` means it is, and is someone else's. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when anything answers at the address, even a 401. This is enough to
 *  reuse a daemon for a chat, where the version check and its message come
 *  next; it is not proof that a pid is the daemon, so a stop never signals on
 *  it alone. */
async function answers(d: DaemonAddress): Promise<boolean> {
  try {
    const res = await request(d, "/version", {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    // Drain the body so the socket is not left half-read.
    await res.text();
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when the address answers `/version` as a daemon: a successful
 * reply with a readable API version. A 401, a 404, or a non-JSON body is
 * another listener on the port, not proof that the recorded pid is the
 * daemon. The version itself is not compared, because `daemon stop` has to
 * work against a daemon this client refuses (M9-2).
 */
async function verifiedDaemon(d: DaemonAddress): Promise<boolean> {
  try {
    const r = await call<Partial<VersionReply>>(d, "/version", {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    if (!r.ok) return false;
    const v = r.body?.apiVersion;
    if (typeof v !== "object" || v === null) return false;
    return Number.isInteger(v.major) && Number.isInteger(v.minor);
  } catch {
    return false;
  }
}

/** A process's start time, as `ps` prints it, or null when it cannot be read.
 *  `client/` may not import `core/sweep.ts`, where the daemon's own copy of
 *  this check lives; the comparison is identical and is what tells a reused
 *  pid from the process that wrote the record. Exported so a test can check
 *  that the two copies still agree. */
export async function processIdentity(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        timeout: 2_000,
        env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      },
    );
    const identity = stdout.trim();
    return identity === "" ? null : identity;
  } catch {
    return null;
  }
}

/** The identity beside `daemon.json`, when it is readable and well formed. */
async function readIdentity(file: string): Promise<DaemonIdentity | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(identityPath(file), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { pid, startedAt } = parsed as {
      pid?: unknown;
      startedAt?: unknown;
    };
    if (
      typeof pid === "number" &&
      Number.isInteger(pid) &&
      pid > 0 &&
      typeof startedAt === "string" &&
      startedAt !== ""
    ) {
      return { pid, startedAt };
    }
  } catch {
    // Missing, unreadable or malformed: the address is the fallback.
  }
  return undefined;
}

/**
 * What `record.pid` names now: `"live"` when its start time matches the
 * identity, `"stale"` when it is gone or differs, and `"unknown"` when there
 * is no identity or `ps` cannot answer. Unknown is never treated as stale by
 * itself.
 */
async function ownerState(
  file: string,
  record: RecordLike,
): Promise<"live" | "stale" | "unknown"> {
  const { pid } = record;
  if (pid === undefined) return "unknown";
  if (!alive(pid)) return "stale";
  const identity = await readIdentity(file);
  if (identity === undefined) return "unknown";
  if (identity.pid !== pid) {
    return record.address === undefined ? "unknown" : "stale";
  }
  const actual = await processIdentity(pid);
  if (actual === identity.startedAt) return "live";
  if (actual === null) return alive(pid) ? "unknown" : "stale";
  return "stale";
}

/** The pid in a start lock, when it wrote one. */
function startLockPid(lock: string): number | undefined {
  try {
    const pid = Number(readFileSync(lock, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Is another process, or another call here, still starting the daemon? */
function startLockHeld(lock: string): boolean {
  const pid = startLockPid(lock);
  if (pid === process.pid) return heldStarts.has(lock);
  if (pid !== undefined) return alive(pid);
  try {
    return Date.now() - lstatSync(lock).mtimeMs < START_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Take the start lock, or answer undefined when another starter holds it.
 *
 * A lock left by a dead process is removed. A lock with no pid is trusted for
 * a moment, because the winner opens it and writes the pid in two steps.
 */
function acquireStartLock(file: string): (() => void) | undefined {
  const lock = startLockPath(file);
  // `cli.ts` calls `runtimeDir()` first; a test or a library caller may not
  // have made the folder yet. `daemon.ts` still guards it before it listens.
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      heldStarts.add(lock);
      return () => {
        heldStarts.delete(lock);
        try {
          if (readFileSync(lock, "utf8").trim() !== String(process.pid)) return;
          rmSync(lock, { force: true });
        } catch {
          // Already removed, or replaced by a starter we must not touch.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (startLockHeld(lock)) return undefined;
    rmSync(lock, { force: true });
  }
  return undefined;
}

/** Wait for the process holding `${daemon.json}.starting`, or for its record. */
async function waitForOtherStart(
  opts: StartOptions,
  staleToken: string | undefined,
  waitMs: number,
): Promise<boolean> {
  const lock = startLockPath(opts.file);
  const until = Date.now() + waitMs;
  for (;;) {
    const record = await readDaemonRecord(opts.file);
    if (
      record !== "missing" &&
      record.address !== undefined &&
      (staleToken === undefined || record.address.token !== staleToken)
    ) {
      return true;
    }
    if (!startLockHeld(lock)) return false;
    if (Date.now() >= until) {
      throw new Error(
        `another kapelle is starting the daemon; see ${opts.log}.`,
      );
    }
    await sleep(POLL_MS);
  }
}

/** Remove `expected`, but only while the file still describes the same
 *  record. */
async function removeRecordIfUnchanged(
  file: string,
  expected: RecordLike,
): Promise<boolean> {
  const now = await readDaemonRecord(file);
  if (now === "missing") {
    if (expected.pid !== undefined) {
      const identity = await readIdentity(file);
      if (identity?.pid === expected.pid) {
        rmSync(identityPath(file), { force: true });
      }
    }
    return true;
  }
  if (now.pid !== expected.pid) return false;
  if ((now.address === undefined) !== (expected.address === undefined)) {
    return false;
  }
  if (
    now.address !== undefined &&
    expected.address !== undefined &&
    (now.address.port !== expected.address.port ||
      now.address.token !== expected.address.token)
  ) {
    return false;
  }
  rmSync(file, { force: true });
  if (expected.pid !== undefined) {
    const identity = await readIdentity(file);
    if (identity === undefined || identity.pid === expected.pid) {
      rmSync(identityPath(file), { force: true });
    }
  }
  return true;
}

/** Rename the last log aside and open the new one, appended so a retry can
 *  keep writing into the same start's log. */
function rotate(log: string): number {
  try {
    // An empty current log is a start that has not written yet. Rotating it
    // would push the last useful log out of `${log}.1`, exactly the loss a
    // second starter or a crash between rotate and spawn can cause.
    if (statSync(log).size > 0) renameSync(log, `${log}.1`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return openSync(log, "a", 0o600);
}

/**
 * Wait until `daemon.json` has a complete address.
 *
 * `stale` is the record that was there before a start: when it is set, the
 * new daemon's token has to differ, or the old file would be read as ready.
 * Only the token is compared: a recycled pid can name the new daemon too.
 * A spawn error is fatal at once. A child that exits is also fatal unless
 * another live PID owns the record, which is what a lock-race loser leaves
 * behind, or the daemon's lock says another starter is still claiming it. If
 * that stale PID disappears after the child exits, the caller may make one
 * bounded retry.
 */
async function waitForRecord(
  opts: StartOptions,
  stale: { pid?: number; token: string } | undefined,
  waitMs: number,
  child?: ChildProcess,
  retryAllowed = false,
): Promise<"ready" | "retry"> {
  let spawnError: Error | undefined;
  let childExit:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  if (child) {
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("exit", (code, signal) => {
      childExit = { code, signal };
    });
  }

  const until = Date.now() + waitMs;
  for (;;) {
    if (spawnError) {
      throw new Error(`cannot start the daemon: ${spawnError.message}`);
    }
    const record = await readDaemonRecord(opts.file);
    if (
      record !== "missing" &&
      record.address !== undefined &&
      (stale === undefined || record.address.token !== stale.token)
    ) {
      return "ready";
    }
    if (childExit) {
      const recordPid = record === "missing" ? undefined : record.pid;
      const otherLive =
        (recordPid !== undefined &&
          recordPid !== child?.pid &&
          alive(recordPid)) ||
        (stale?.pid !== undefined &&
          stale.pid !== child?.pid &&
          alive(stale.pid));
      // A concurrent starter can still hold the strict lock while the record
      // shows a dead pid. This child was refused by that lock, so wait for
      // the holder to publish instead of treating the exit as final.
      if (!otherLive && !existsSync(`${opts.file}.lock`)) {
        if (retryAllowed && stale?.pid !== undefined && !alive(stale.pid)) {
          return "retry";
        }
        const reason =
          childExit.signal !== null
            ? `signal ${childExit.signal}`
            : `exit code ${childExit.code ?? "unknown"}`;
        throw new Error(
          `the daemon exited before it was ready (${reason}); see ${opts.log}.`,
        );
      }
    }
    if (Date.now() >= until) {
      const seconds = Math.ceil(waitMs / 1000);
      const running =
        record !== "missing" && record.pid !== undefined && alive(record.pid)
          ? " A daemon is running but did not answer; stop it with: " +
            "kapelle daemon stop."
          : "";
      throw new Error(
        `the daemon did not start within ${seconds} s; see ${opts.log}.` +
          running,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Make a daemon answer, starting one if none does.
 *
 * A complete record that answers is reused. A record with only a live pid is
 * another `kapelle` mid-start, so this waits for it. Everything else starts
 * a daemon: no record, a dead pid, or a complete record whose port refuses.
 */
export async function ensureDaemon(opts: StartOptions): Promise<void> {
  const waitMs = opts.waitMs ?? START_WAIT_MS;
  const until = Date.now() + waitMs;
  /** One deadline for the whole start: a `continue` cannot restart it. */
  const remaining = (): number => {
    const left = until - Date.now();
    if (left <= 0) {
      throw new Error(
        `the daemon did not start within ${Math.ceil(waitMs / 1000)} s; ` +
          `see ${opts.log}.`,
      );
    }
    return left;
  };
  for (;;) {
    const budget = remaining();
    const record = await readDaemonRecord(opts.file);
    if (
      record !== "missing" &&
      record.address !== undefined &&
      (await answers(record.address))
    ) {
      return;
    }

    const release = acquireStartLock(opts.file);
    if (!release) {
      const staleToken =
        record === "missing" ? undefined : record.address?.token;
      if (await waitForOtherStart(opts, staleToken, budget)) return;
      // The lock can be released without a record; do not spin through
      // another acquire-and-lose immediately.
      await sleep(POLL_MS);
      continue;
    }

    try {
      const current = await readDaemonRecord(opts.file);
      let stale: { pid?: number; token: string } | undefined;
      if (current !== "missing") {
        if (current.address !== undefined && (await answers(current.address))) {
          return;
        }
        const owner = await ownerState(opts.file, current);
        if (owner === "live") {
          if (current.address !== undefined) {
            throw new Error(
              `the daemon (pid ${current.pid}) did not answer; stop it with: ` +
                "kapelle daemon stop.",
            );
          }
          await waitForRecord(opts, undefined, budget);
          return;
        }
        if (
          owner === "unknown" &&
          current.pid !== undefined &&
          alive(current.pid)
        ) {
          if (current.address === undefined) {
            await waitForRecord(opts, undefined, budget);
            return;
          }
          // No identity to prove the pid is stale. Keep the old behaviour:
          // let the daemon's claim refuse while that pid lives, then retry
          // once it is gone.
          stale = { pid: current.pid, token: current.address.token };
        } else if (!(await removeRecordIfUnchanged(opts.file, current))) {
          await sleep(POLL_MS);
          continue;
        }
      }

      // One rotation per start: a retry appends to this start's log, so it
      // cannot push the last start's log out of `${log}.1`.
      const log = rotate(opts.log);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const attemptBudget = remaining();
          const child = spawn(process.execPath, [opts.script], {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            // Its own session, so closing the terminal does not send it SIGHUP.
            detached: true,
            // It must not hold this CLI's terminal or pipes open.
            stdio: ["ignore", log, log],
          });
          child.unref();

          const outcome = await waitForRecord(
            opts,
            stale,
            attemptBudget,
            child,
            attempt === 0,
          );
          if (outcome === "ready") return;
        }
        // `retryAllowed` is true only on the first attempt, so the second
        // cannot answer "retry"; falling out means the bound changed.
        throw new Error("the daemon start retry is bounded to one retry");
      } finally {
        closeSync(log);
      }
    } finally {
      release();
    }
  }
}

/** Is the record that verified `target` still the one at `file`? */
async function targetStillCurrent(
  file: string,
  target: RecordLike & { pid: number },
): Promise<boolean> {
  const now = await readDaemonRecord(file);
  if (now === "missing" || now.pid !== target.pid) return false;
  if (target.address === undefined) return true;
  return (
    now.address !== undefined &&
    now.address.port === target.address.port &&
    now.address.token === target.address.token
  );
}

/**
 * Stop the daemon named in `file`, and wait for its pid to go.
 *
 * Answers the pid it stopped, or `undefined` when the file names none: no
 * daemon, a malformed record, a record between claim and listen with no pid,
 * or a stale record whose pid is already gone. The stale record is removed,
 * but no daemon is reported as stopped.
 *
 * A live pid is not enough to signal. When the identity says it is a reused
 * pid, or a complete record does not verify as a daemon at its address, the
 * record is cleared instead. A record with only a pid is waited on until it
 * publishes an address.
 */
export async function stopDaemon(
  file: string,
  waitMs = STOP_WAIT_MS,
): Promise<number | undefined> {
  let target: (RecordLike & { pid: number }) | undefined;
  const readyBy = Date.now() + Math.min(waitMs, START_WAIT_MS);
  while (target === undefined) {
    const record = await readDaemonRecord(file);
    if (record === "missing" || record.pid === undefined) {
      return undefined;
    }
    const { pid } = record;
    if (pid === process.pid) {
      throw new Error(
        `${file} names this process (pid ${pid}); not stopping it`,
      );
    }
    const owner = await ownerState(file, record);
    if (owner === "stale") {
      await removeRecordIfUnchanged(file, record);
      return undefined;
    }
    if (owner === "live") {
      target = { pid, address: record.address };
      break;
    }
    if (record.address !== undefined) {
      if (await verifiedDaemon(record.address)) {
        target = { pid, address: record.address };
        break;
      }
      await removeRecordIfUnchanged(file, record);
      return undefined;
    }
    if (!alive(pid)) {
      await removeRecordIfUnchanged(file, record);
      return undefined;
    }
    if (Date.now() >= readyBy) {
      throw new Error(
        `the daemon (pid ${pid}) has not written its address; cannot verify ` +
          "it. Try again.",
      );
    }
    await sleep(POLL_MS);
  }

  const { pid } = target;
  // The file can change while the identity check runs. Do not signal a pid
  // whose record has moved on; a new daemon keeps its own file.
  if (!(await targetStillCurrent(file, target))) return undefined;
  const identity = await readIdentity(file);
  if (
    identity?.pid === pid &&
    (await processIdentity(pid)) !== identity.startedAt
  ) {
    return undefined;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // Already gone: the record is all that is left, and it goes below.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    await removeRecordIfUnchanged(file, target);
    return undefined;
  }

  const until = Date.now() + waitMs;
  while (alive(pid)) {
    if (Date.now() >= until) {
      throw new Error(
        `the daemon (pid ${pid}) did not stop within ${Math.ceil(waitMs / 1000)} s`,
      );
    }
    await sleep(POLL_MS);
  }

  // The daemon removes its own file on shutdown. A process that died without
  // that leaves it; remove it only while it still names this pid.
  await removeRecordIfUnchanged(file, target);
  return pid;
}
