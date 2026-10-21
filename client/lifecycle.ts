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
 * **The daemon's own lock settles a race.** Two `kapelle` starting together
 * may both spawn a daemon. `claim` in `daemon.ts` lets exactly one listen;
 * the loser exits, and its reason is only in the log. This module watches
 * the child's exit, but keeps waiting when another starter holds the lock or
 * another live PID owns the record, so the second CLI opens the chat on the
 * winner rather than failing on the lock.
 *
 * **`daemon.json` is the readiness signal.** It is written with only `pid`
 * at the claim and with `pid`, `port` and `token` once the port is open. A
 * record that already names a complete address is probed with `GET
 * /version`: an answer means reuse it, silence means it was left by a dead
 * daemon and a start is needed. After a start, the record must be new (a
 * different token), because the stale record is still readable for the few
 * milliseconds before the new daemon claims the file.
 *
 * **A stop is SIGTERM and a wait.** `daemon.ts` cancels its runs and pauses
 * its rooms on SIGTERM, then removes `daemon.json` and exits. This waits for
 * the pid to go, then removes a record the daemon did not remove itself —
 * only while it still names that pid, so a daemon that took over in the
 * meantime keeps its file.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, renameSync, rmSync } from "node:fs";

import { type DaemonAddress, readDaemonRecord, request } from "./daemon.ts";

/** How often a start or stop looks at the daemon again. */
const POLL_MS = 50;
/** A live daemon answers `GET /version` in a moment; one that cannot is gone. */
const PROBE_MS = 2_000;
/** How long a start may take before it is reported as stuck. */
const START_WAIT_MS = 15_000;
/** A stop waits for runs and rooms to settle, so it gets longer. */
const STOP_WAIT_MS = 30_000;

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

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Is `pid` a live process? `EPERM` means it is, and is someone else's. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the daemon behind `d` answers at all; the version is not read
 *  here, because `chat.ts` and the verbs compare it and print its warning. */
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

/** Rename the last log aside and open the new one, appended so two starters
 *  that race can write into the same file without truncating each other. */
function rotate(log: string): number {
  try {
    renameSync(log, `${log}.1`);
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
      (stale === undefined ||
        (record.address.token !== stale.token && record.pid !== stale.pid))
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
  const record = await readDaemonRecord(opts.file);
  if (record !== "missing") {
    if (record.address) {
      if (await answers(record.address)) return;
    } else if (record.pid !== undefined && alive(record.pid)) {
      await waitForRecord(opts, undefined, opts.waitMs ?? START_WAIT_MS);
      return;
    }
  }
  const stale =
    record !== "missing" && record.address
      ? { pid: record.pid, token: record.address.token }
      : undefined;

  // One rotation per start: a retry appends to this start's log, so it
  // cannot push the last start's log out of `${log}.1`.
  const log = rotate(opts.log);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
        opts.waitMs ?? START_WAIT_MS,
        child,
        attempt === 0,
      );
      if (outcome === "ready") return;
    }
  } finally {
    closeSync(log);
  }
}

/**
 * Stop the daemon named in `file`, and wait for its pid to go.
 *
 * Answers the pid it stopped, or `undefined` when the file names none: no
 * daemon, a malformed record, a record between claim and listen with no pid,
 * or a stale record whose pid is already gone. The stale record is removed,
 * but no daemon is reported as stopped.
 */
export async function stopDaemon(
  file: string,
  waitMs = STOP_WAIT_MS,
): Promise<number | undefined> {
  const record = await readDaemonRecord(file);
  if (record === "missing" || record.pid === undefined) return undefined;
  const { pid } = record;
  if (pid === process.pid) {
    throw new Error(`${file} names this process (pid ${pid}); not stopping it`);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // Already gone: the record is all that is left, and it goes below.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    const left = await readDaemonRecord(file);
    if (left !== "missing" && left.pid === pid) rmSync(file, { force: true });
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
  const left = await readDaemonRecord(file);
  if (left !== "missing" && left.pid === pid) rmSync(file, { force: true });
  return pid;
}
