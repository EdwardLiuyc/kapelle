/**
 * The daemon's boot (M12-7a), split from `daemon.ts`: the arguments, the
 * claim, the sweep, the restore, the signals and the listen, in that order.
 * Everything a request reaches is `createDaemonApp` in `daemon/app.ts`.
 * Importing this file starts nothing; `main()` does, and `daemon.ts` calls it.
 *
 * **The token is not optional, even on 127.0.0.1.** Every account on the
 * machine can reach the loopback address, and a run file is a command line —
 * `cmd`, or any harness under `auto`. It lives in
 * `$XDG_RUNTIME_DIR/kapelle/daemon.json`: outside every repository, so git
 * never sees it, in a `0700` directory only the operator can enter, and wiped
 * at logout. It stops being enough the moment the daemon binds anywhere else,
 * which is also the trigger that re-opens sandboxing.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, renameSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, promisify } from "node:util";
import {
  readEnvConfig,
  readUserConfig,
  warnUnknownConfigEnv,
} from "../core/config.ts";
import { readRepos, runtimeDir } from "../core/runtime.ts";
import { processIdentity, sweepBoot } from "../core/sweep.ts";
import { createDaemonApp, hallDir } from "./app.ts";
import { digest } from "./http.ts";
import {
  claim,
  readDaemonRecord,
  removeDaemonFiles,
  removeDaemonFilesIfMine,
} from "./record.ts";

const DEFAULT_PORT = 4719;

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
const execFileAsync = promisify(execFile);

/** Proof of an unrecorded Kapelle daemon, with its pid when the host's tools
 *  can identify it. `undefined` is another listener, or none that answered.
 *  No token is needed and the listener is never signalled here. */
async function unrecordedDaemon(
  port: number,
): Promise<{ pid?: number } | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status !== 401) {
      await response.body?.cancel();
      return undefined;
    }
    const body = (await response.json()) as {
      error?: { code?: unknown };
    } | null;
    if (body?.error?.code !== "unauthorized") return undefined;
  } catch {
    return undefined;
  }

  const ss = {
    command: "ss",
    args: ["-ltnpH", `src 127.0.0.1:${port}`],
    pattern: /\bpid=(\d+)\b/,
  };
  const lsof = {
    command: "lsof",
    args: ["-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-Fp"],
    pattern: /^p(\d+)$/m,
  };
  for (const probe of process.platform === "darwin" ? [lsof] : [ss, lsof]) {
    try {
      const { stdout } = await execFileAsync(probe.command, probe.args, {
        encoding: "utf8",
        timeout: 2_000,
      });
      const pid = Number(probe.pattern.exec(stdout)?.[1]);
      if (Number.isInteger(pid) && pid > 0) return { pid };
    } catch {
      // Try the other system tool; a diagnostic must not hide the bind error.
    }
  }
  return {};
}

/** A startup refusal is one line and exit 1, never a stack trace. */
function orExit<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    console.error(messageOf(err));
    process.exit(1);
  }
}

/**
 * The boot sweep's one question, on a TTY (#129).
 *
 * Its own readline, opened and closed per question, because this runs once
 * before `listen` and nothing else on this process owns stdin yet —
 * `core/policy.ts`'s asker is for a live run and holds its interface open.
 */
function askBoot(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return rl
    .question(`${question} [y/N] `)
    .then((answer) => /^y(es)?$/i.test(answer.trim()))
    .finally(() => rl.close());
}

const DEFAULT_PERMISSION_TIMEOUT_S = 120;

/** Boot a daemon: claim `daemon.json`, sweep, restore, and listen. Returns
 *  once the listen is asked for; the process then lives until a signal. */
export async function main(): Promise<void> {
  // M2-7: the user-level config is read once here, after the startup helpers
  // above and before the port is claimed. `KAPELLE_*` is also read here for the
  // daemon-wide knobs, then re-read for every run-default resolution and per
  // repository by the boot sweep. Unknown `KAPELLE_*` names warn and are
  // ignored (they may be secrets); a known name with a bad value refuses the
  // start like any flag.
  const userConfig = orExit(() => readUserConfig());
  warnUnknownConfigEnv();
  const configEnv = orExit(() => readEnvConfig());

  const { port, permissionTimeoutMs } = orExit(() => {
    const { values } = parseArgs({
      options: {
        port: { type: "string" },
        "permission-timeout": { type: "string" },
      },
    });
    const rawPort = values.port;
    const n =
      rawPort === undefined
        ? (configEnv.port ?? userConfig.port ?? DEFAULT_PORT)
        : Number(rawPort);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`--port must be a whole number 0-65535; got ${rawPort}`);
    }
    const raw = values["permission-timeout"];
    // The config values were validated where they were read (M2-7); the flag
    // is the one string path left.
    if (raw === undefined) {
      return {
        port: n,
        permissionTimeoutMs:
          configEnv.permissionTimeoutMs ??
          userConfig.permissionTimeoutMs ??
          DEFAULT_PERMISSION_TIMEOUT_S * 1000,
      };
    }
    const seconds = Number(raw);
    const permissionTimeoutMs = seconds * 1000;
    // No `0` meaning "wait forever": an unanswered decision must end (M2-3).
    // Node clamps a timer above 2^31-1 ms to 1 ms, so the ceiling is a refusal,
    // not a silent cap that would deny every decision at once.
    if (
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      permissionTimeoutMs > 2147483647
    ) {
      throw new Error(
        `--permission-timeout must be a number of seconds above 0 and at most ` +
          `2147483 (Node's 32-bit timer ceiling); got ${raw}`,
      );
    }
    return { port: n, permissionTimeoutMs };
  });

  const dir = orExit(runtimeDir);
  const file = join(dir, "daemon.json");
  const childrenFile = join(dir, "children.json");
  // Read before the claim, and through `orExit` like every other startup
  // refusal: a state directory somebody else owns stops the daemon with one
  // line rather than a stack, and stops it before `daemon.json` exists, so a
  // start that refused leaves nothing behind for the next one to clear.
  const addedRepos = orExit(readRepos);
  // Read before the claim: the sidecar is how a client tells this process from
  // a later one that reuses the pid.
  const daemonStartedAt = await processIdentity(process.pid);
  const fd = orExit(() => claim(file, daemonStartedAt));

  const token = randomBytes(32).toString("hex");

  // M2-5 (#35): reconcile the previous daemon's debris before anything is
  // restored or served. This rewrites a record left `running` to `killed` with
  // a fresh `endedAt`, so the scan below sees it as terminal; worktrees and runs
  // inside the retention window are left alone.
  // The real handlers are installed further down, once `server` and the run
  // registry exist. Until then a ^C through a slow sweep — git across several
  // repositories, half a second per surviving pid — would take the default kill
  // and leave the claim file that `claim()` has already written, the one state
  // M2-4 works to avoid. These two do that much and no more: there is no run to
  // cancel yet.
  const bailOut = () => {
    removeDaemonFiles(file);
    process.exit(0);
  };
  process.once("SIGTERM", bailOut);
  process.once("SIGINT", bailOut);

  await sweepBoot({
    repos: addedRepos,
    childrenFile,
    onNotice: (text) => console.error(text),
    // Only on a TTY — `kapelle daemon start` has one, a background daemon does
    // not, and a question nobody can answer would hang the boot. Without it
    // `sweepStranded` reports and keeps, which is the safe half (#129).
    ask: process.stdin.isTTY ? askBoot : undefined,
    // A hall agent's checkout is in a repository; its record is in the hall's.
    roomRoots: [hallDir()],
  });

  process.off("SIGTERM", bailOut);
  process.off("SIGINT", bailOut);

  const app = createDaemonApp({
    repos: addedRepos,
    expected: digest(token),
    daemonFile: file,
    childrenFile,
    permissionTimeoutMs,
  });
  const { server } = app;

  // Before the port opens: a request must never meet a half-restored list.
  // ponytail: synchronous and O(runs ever kept) — one `readdir` plus one
  // small `readFile` per run, on the boot path only. Move it behind `listen`
  // (or read the newest N) if a repository with thousands of kept runs makes
  // the daemon slow to answer.
  app.restoreRuns();

  let recordWatch: NodeJS.Timeout | undefined;
  let published: { port: number; token: string } | undefined;
  let stopping = false;

  /**
   * SIGTERM, SIGINT or a lost record: the server stops accepting, the app
   * cancels every run, pauses every room and waits for each to settle (`stop`
   * in `daemon/app.ts`), then `daemon.json` is removed and the process exits 0
   * (M2-4, #34). Record loss deliberately exits 0 too: this is a clean
   * shutdown, not a crash, and a later client can start a fresh daemon.
   */
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (recordWatch !== undefined) clearInterval(recordWatch);
    // Before the pause: a chat screen whose room stream ends must then find no
    // daemon, and wait for the next one (`readRoom` in `client/roomset.ts`).
    // The SSE response closes its own socket (`daemon/sse.ts`); close idle
    // pooled sockets too so the reconcile cannot ride one back in.
    server.close();
    server.closeIdleConnections();
    await app.stop(signal);
    removeDaemonFilesIfMine(file, published);
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Before the port opens, as `restoreRuns`: no request meets a half-restored
  // list. A signal during it pauses the rooms restored so far; the others are
  // already `paused` on disk, which is what the sweep left. ponytail: one
  // record read and one log scan per paused or active room, on the boot path,
  // in order; the repository's checks run once (#322), and a dismissed room is
  // only read (#451). Building the paused ones lazily too needs
  // `daemon/rooms.ts` to list their own statuses and a shutdown to wait for a
  // build in flight; do that if a repository keeps hundreds of them.
  await app.restoreRooms();

  server.on("error", (err) => {
    removeDaemonFiles(file);
    console.error(`cannot listen on 127.0.0.1:${port}: ${messageOf(err)}`);
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") process.exit(1);
    void unrecordedDaemon(port)
      .then((daemon) => {
        if (daemon === undefined) return;
        const { pid } = daemon;
        console.error(
          pid === undefined
            ? "the port is owned by an unrecorded Kapelle daemon; its pid " +
                "could not be identified"
            : `the port is owned by an unrecorded Kapelle daemon (pid ${pid}); ` +
                `stop it manually with: kill -TERM ${pid}`,
        );
      })
      .finally(() => process.exit(1));
  });

  // The token is published only once the port is open, so a client never reads
  // a token for a daemon that is not listening.
  server.listen(port, "127.0.0.1", () => {
    const { port: bound } = server.address() as AddressInfo;
    // Published atomically: `rename` never exposes a half-written record, and
    // the claim file it replaces already names this live pid, so a second
    // starter reads a live pid at either end of the swap. Truncating this file
    // in place left it empty for an instant — the state `claim` treats as stale
    // — and let a second daemon take over a running one (M2-4, #34).
    const tmp = `${file}.tmp`;
    // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
    // pi-lens-ignore: no-raw-json-store-write
    writeFileSync(
      tmp,
      JSON.stringify({ pid: process.pid, port: bound, token }),
      {
        mode: 0o600,
      },
    );
    renameSync(tmp, file);
    closeSync(fd);
    published = { port: bound, token };
    recordWatch = setInterval(() => {
      const current = readDaemonRecord(file);
      // EMFILE, EACCES and other read errors can be transient, and must not
      // cancel active runs and rooms. Only absence or a replaced record is loss.
      if (current.state === "unreadable") return;
      const record = current.state === "readable" ? current.record : undefined;
      if (
        record?.pid === process.pid &&
        record.port === bound &&
        record.token === token
      ) {
        return;
      }
      void shutdown("daemon.json lost");
    }, 2_000);
    recordWatch.unref();
    console.log(`listening on http://127.0.0.1:${bound} (token in ${file})`);
  });
}
