#!/usr/bin/env node
/**
 * The daemon — story M2-1, issue #31.
 *
 * **One daemon for all of the operator's repositories** (decided 2026-09-11,
 * #31). A repository is added once (`POST /repos`), and a run names the folder
 * it runs in (`POST /runs {cwd, run}`); a folder outside every added
 * repository is refused. One port, one token, and one place — M4's dashboard
 * — to watch every run. Run state lives in each repository's own workspace
 * under `stateDirFor(root)`, outside the repository.
 *
 * **Transport over `core/`, and nothing more.** It calls `stateDirRoot`,
 * `stateDirFor`, `validateRun`, `sweepBoot`, `runRun`,
 * `processIdentity` and the permission queue, and for chat rooms
 * `roomAgents` and `openRoom`; worktrees, policy and harnesses
 * stay behind them. If orchestration grew here, the scheduler would be
 * untestable without a server and the CLI would drift into a second
 * implementation (`docs/STORIES.md`, M2-1).
 *
 * **The token is not optional, even on 127.0.0.1.** Every account on the
 * machine can reach the loopback address, and a run file is a command line —
 * `cmd`, or any harness under `auto`. It lives in
 * `$XDG_RUNTIME_DIR/kapelle/daemon.json`: outside every repository, so git
 * never sees it, in a `0700` directory only the operator can enter, and wiped
 * at logout. It stops being enough the moment the daemon binds anywhere else,
 * which is also the trigger that re-opens sandboxing.
 *
 * **A `Host` outside loopback is refused before the token is read** (M2-8,
 * #38), which closes DNS rebinding — an attacker page gaining same-origin
 * access to this loopback daemon. The browser half, `?token=` on the SSE
 * endpoint, is retired with the browser dashboard (A3): no story serves a page.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  API_VERSION,
  CAPABILITIES,
  type ErrorReply,
  type MessageAccepted,
  type ParticipantDto,
  type PendingDecision,
  type PermissionAnswered,
  type PermissionDecision,
  type RepoAdded,
  type RepoRoots,
  type RoomDto,
  type RoomListEntry,
  type RunAccepted,
  type RunDto,
  type RunListEntry,
  type RunStatus,
  type VersionReply,
} from "./client/contract.ts";
import {
  readEnvConfig,
  readProjectConfig,
  readUserConfig,
  resolveRunDefaults,
  warnUnknownConfigEnv,
} from "./core/config.ts";
import { type EventLog, openEventLog } from "./core/eventlog.ts";
import { createEventBus } from "./core/events.ts";
import { newRoomId, newRunId } from "./core/ids.ts";
import { createPermissionQueue } from "./core/permissions.ts";
import {
  AGENT_FIELDS,
  openRoom,
  participantChanges,
  type Room,
  RoomRefusal,
  roomAgent,
  roomAgents,
} from "./core/room.ts";
import { runRun } from "./core/run.ts";
import { type Run, validateRun } from "./core/runfile.ts";
import {
  readRepos,
  runtimeDir,
  stateDirFor,
  writeRepos,
} from "./core/runtime.ts";
import { processIdentity, sweepBoot } from "./core/sweep.ts";
import { WATCHDOG_DEFAULTS, type WatchdogLimits } from "./core/watchdog.ts";
import { openWorktrees, stateDirRoot } from "./core/worktree.ts";
import {
  type RoomState,
  type RunState,
  toParticipantDto,
  toRoomDto,
  toRoomListEntry,
  toRunDto,
  toRunListEntry,
  toTaskDto,
} from "./daemon/dto.ts";
import {
  authorised,
  digest,
  existingDir,
  hostAllowed,
  Refusal,
  readBody,
  refusal,
  send,
} from "./daemon/http.ts";
import { streamLog } from "./daemon/sse.ts";
import { AGENTS } from "./protocol/registry.ts";

// M2-7: the user-level config is read once here, after the startup helpers
// below and before the port is claimed. `KAPELLE_*` is also read here for the
// daemon-wide knobs, then re-read for every run-default resolution and per
// repository by the boot sweep. Unknown `KAPELLE_*` names warn and are
// ignored (they may be secrets); a known name with a bad value refuses the
// start like any flag.
const DEFAULT_PORT = 4719;

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** A startup refusal is one line and exit 1, never a stack trace. */
function orExit<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    console.error(messageOf(err));
    process.exit(1);
  }
}

const userConfig = orExit(() => readUserConfig());
warnUnknownConfigEnv();
const configEnv = orExit(() => readEnvConfig());

const DEFAULT_PERMISSION_TIMEOUT_S = 120;

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

/** Is `pid` a live process? `EPERM` means it is, and is someone else's. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Creates `file` holding this pid, or throws `EEXIST`.
 *
 * Written to a private name first and then linked in, because `link` never
 * replaces and the file it publishes already has the pid in it. An exclusive
 * `open` published an empty file for an instant, and a second daemon reading
 * it then took it for stale.
 *
 * `replace` swaps a stale file out with `rename` instead, for `claim` under
 * its lock. The file then exists at every instant: removing it first left a
 * gap in which a reconnecting `attach` read "no file", which means a clean
 * stop, and gave up for good (M5-6, #172).
 */
function create(file: string, replace = false): number {
  const tmp = `${file}.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid }));
    if (replace) renameSync(tmp, file);
    else linkSync(tmp, file);
  } catch (err) {
    closeSync(fd);
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  return fd;
}

/**
 * Takes `daemon.json` for this process, or throws naming the daemon that has it.
 *
 * The file is the single-instance lock as well as the token's home. A second
 * daemon finds a live pid in it and refuses, rather than overwriting the token
 * every client of the first one is using. A pid that is dead was left by a
 * daemon that crashed or was stopped, and its file is replaced.
 */
function claim(file: string): number {
  try {
    return create(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Replacing a stale file is check-then-act, so two daemons starting in the
  // same instant could both see it stale and both replace it. `mkdir` is
  // atomic, so exactly one gets past here; the other refuses rather than
  // waits, because the winner's pid is about to be live (M2-4).
  const lock = `${file}.lock`;
  try {
    mkdirSync(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new Error(
      `another daemon is starting (${lock} exists). If none is, remove ` +
        `that directory and start again.`,
    );
  }
  try {
    let holder: { pid?: unknown; port?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      // A non-object (`null`, `[]`, `42`) names no pid either; it counts as
      // stale exactly like an unreadable file, and must not throw here.
      if (typeof parsed === "object" && parsed !== null) {
        holder = parsed as { pid?: unknown; port?: unknown };
      }
    } catch {
      // Unreadable: nothing live is vouching for it, so it counts as stale.
    }
    if (typeof holder.pid === "number" && alive(holder.pid)) {
      throw new Error(
        `a daemon is already running: pid ${holder.pid}, port ${holder.port} ` +
          `(${file}).`,
      );
    }
    return create(file, true);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const dir = orExit(runtimeDir);
const file = join(dir, "daemon.json");
// Read before the claim, and through `orExit` like every other startup
// refusal: a state directory somebody else owns stops the daemon with one
// line rather than a stack, and stops it before `daemon.json` exists, so a
// start that refused leaves nothing behind for the next one to clear.
const addedRepos = orExit(readRepos);
const fd = orExit(() => claim(file));

const token = randomBytes(32).toString("hex");
const expected = digest(token);

/** Every repository root added, restored from `repos.json` (M2-6, #36).
 *  Not re-checked here: a repository that has since moved is refused by
 *  `POST /runs`, which checks membership on use. */
const repos = new Set<string>(addedRepos);

const runs = new Map<string, RunState>();
/** Every run still in flight, so a shutdown can wait for them to settle. */
const inFlight = new Set<Promise<void>>();
/** Kept beside the record rather than on it, so a `GET` never serialises one. */
const cancels = new Map<string, AbortController>();
/** Settles once `runRun` hands over the log, or with `undefined` when the run
 *  ended without one — a preflight that threw, or a state dir it could not
 *  make. A `GET /events` that arrives first waits here rather than 404ing a
 *  run that exists. */
const eventLogs = new Map<string, Promise<EventLog | undefined>>();
/** `events.jsonl` on disk, by run id, for runs restored at boot. Held as a
 *  path rather than an open log: opening one scans the whole file, and most
 *  restored runs are never asked for. */
const restoredLogs = new Map<string, string>();
/** `Idempotency-Key` → the body's digest and the run it started (M5-7,
 *  #139), or `null` while that request has not answered. One map for every
 *  repository (G3): `cwd` is in the body, so a key reused in another
 *  repository is a conflict. Kept for the daemon's life, like `runs` (G4);
 *  a restart forgets every key. */
const idempotencyKeys = new Map<string, { hash: Buffer; id: string } | null>();

/**
 * Read every added repository's finished runs back into memory (M2-6, #36).
 *
 * Run state lives in each repository's own workspace under
 * `stateDirFor(root)`, so the scan follows the repository list rather than a
 * second index. Anything unreadable is skipped with a notice naming the path
 * and the reason: a run whose
 * record is missing, truncated by a crash or not ours is exactly what M2-5's
 * sweep exists to reconcile, and a daemon that refused to boot over one
 * could not be reached by the request that fixes it. A repository whose
 * runs directory does not exist yet gets no notice — nothing was skipped.
 *
 * **Only terminal runs.** A record still saying `running` belongs to a
 * process that is gone; calling it live here would list a run nothing is
 * running and hand `DELETE` a canceller that does not exist. The M2-5 sweep
 * ran just before this scan and rewrote those to `killed`; the guard below is
 * for a record the sweep could not write.
 */
function restoreRuns(): void {
  for (const root of repos) {
    const dir = join(stateDirFor(root), "runs");
    let ids: string[];
    try {
      ids = readdirSync(dir);
    } catch (err) {
      // ENOENT is a runs directory that is simply not there (the repository
      // never ran, or the directory was removed): no records exist to skip,
      // so it stays quiet. Anything else (permission, not-a-directory) is a
      // real skip and gets the notice.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`skipping runs under ${dir}: ${messageOf(err)}`);
      }
      continue;
    }
    for (const id of ids) {
      const logDir = join(dir, id);
      const recordPath = join(logDir, "run.json");
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(readFileSync(recordPath, "utf8"));
      } catch (err) {
        console.error(`skipping ${recordPath}: ${messageOf(err)}`);
        continue;
      }
      if (record?.runId !== id) {
        console.error(`skipping ${recordPath}: runId is not ${id}`);
        continue;
      }
      const status = record.status;
      if (typeof status !== "string") {
        console.error(`skipping ${recordPath}: no status in the record`);
        continue;
      }
      // The sweep rewrote these to `killed` before this scan, so one left
      // here is a record it could not write; expected after a crash, silent.
      if (status === "running") continue;
      const state: RunState = {
        id,
        cwd: typeof record.cwd === "string" ? record.cwd : root,
        root: typeof record.root === "string" ? record.root : root,
        // The record is one we wrote, so its status is a `RunStatus`. A
        // hand-edited one reaches the API unaltered rather than failing a boot.
        status: status as RunStatus,
        source: "restored",
        notices: [],
        tasks: [],
      };
      if (
        typeof record.startedAt === "string" &&
        Number.isFinite(Date.parse(record.startedAt))
      ) {
        state.startedAt = record.startedAt;
      }
      if (
        typeof record.endedAt === "string" &&
        Number.isFinite(Date.parse(record.endedAt))
      ) {
        state.endedAt = record.endedAt;
      }
      if (Array.isArray(record.tasks)) {
        // Trusted for its runId and status, but a hand-edited `tasks` can
        // still hold junk, and the route destructures every element: one
        // `[null]` would 500 the whole list, and `{foo: "bar"}` would print
        // as `undefined undefined` in `kapelle ps`. Keep the run, drop any
        // element without a string id and status (M2-6: a boot answers anyway).
        state.tasks = record.tasks.flatMap((t) =>
          typeof t?.id === "string" && typeof t?.status === "string"
            ? [toTaskDto(t)]
            : [],
        );
      }
      runs.set(id, state);
      restoredLogs.set(id, join(logDir, "events.jsonl"));
    }
  }
}

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
  rmSync(file, { force: true });
  process.exit(0);
};
process.once("SIGTERM", bailOut);
process.once("SIGINT", bailOut);

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

await sweepBoot({
  repos: addedRepos,
  childrenFile: join(dir, "children.json"),
  onNotice: (text) => console.error(text),
  // Only on a TTY — `kapelle daemon start` has one, a background daemon does
  // not, and a question nobody can answer would hang the boot. Without it
  // `sweepStranded` reports and keeps, which is the safe half (#129).
  ask: process.stdin.isTTY ? askBoot : undefined,
});

process.off("SIGTERM", bailOut);
process.off("SIGINT", bailOut);

// At import, before the port opens: a request must never meet a half-restored
// list. ponytail: synchronous and O(runs ever kept) — one `readdir` plus one
// small `readFile` per run, on the boot path only. Move it behind `listen` (or
// read the newest N) if a repository with thousands of kept runs makes the
// daemon slow to answer.
restoreRuns();

/** The log of a run that ended before this daemon started, opened on first
 *  ask and cached with the live ones. */
function restoredLog(id: string): Promise<EventLog | undefined> | undefined {
  const path = restoredLogs.get(id);
  if (path === undefined) return undefined;
  // A log that cannot be opened — never written, or removed since — settles
  // as `undefined`, which `getEvents` already answers as a 404.
  const opened = openEventLog(path).catch(() => undefined);
  eventLogs.set(id, opened);
  return opened;
}

/**
 * Every live harness, by pid (M2-4, #34), mirrored to `children.json` beside
 * `daemon.json` for M2-5's sweep to read after a crash.
 *
 * A crash is covered without it: every measured harness exits when its stdin
 * closes, and the kernel closes that pipe when the daemon dies. The file is
 * the record for a harness build that does not. Removed once nothing is live,
 * so a file that is there after a daemon died names only what was running.
 */
interface Child {
  pid: number;
  /** Which kind of owner spawned it: a run's task, or a room's participant.
   *  S14 renamed the two id fields so one file serves both; the sweep reads a
   *  legacy `{pid, runId, taskId}` entry as a run. */
  kind: "run" | "room";
  ownerId: string;
  unitId: string;
  /** `ps`'s start time, filled in once it answers; see the spawn listener. */
  startedAt?: string;
}

const children = new Map<number, Child>();
const childrenFile = join(dir, "children.json");

// Each entry carries the process's start time (M2-5): the sweep signals a pid
// only when `ps` still reports the same start, so a reused pid is left alone.
function recordChildren(): void {
  try {
    if (children.size === 0) {
      rmSync(childrenFile, { force: true });
      return;
    }
    const tmp = `${childrenFile}.tmp`;
    // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
    // pi-lens-ignore: no-raw-json-store-write
    writeFileSync(
      tmp,
      JSON.stringify({ pid: process.pid, children: [...children.values()] }),
      { mode: 0o600 },
    );
    renameSync(tmp, childrenFile);
  } catch (err) {
    console.error(
      `cannot record harness pids in ${childrenFile}: ${messageOf(err)}`,
    );
  }
}

/**
 * Every `ask` decision the daemon is waiting on, across all runs (M2-3, #33).
 * An unanswered one is denied after `--permission-timeout`, so an `ask` run
 * with nobody attached completes instead of hanging.
 */
const permissions = createPermissionQueue(permissionTimeoutMs);

/**
 * Mirrors a bus's harness pids into `children.json` for the next boot's sweep
 * (M2-4, #34). One listener for both owners: `kind` tells a run from a room,
 * `ownerId` is the run or room id and `unitId` the task or participant (S14).
 */
function trackChildren(
  bus: ReturnType<typeof createEventBus>,
  kind: Child["kind"],
  ownerId: string,
) {
  bus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "_client_harness_spawned") {
      // The start time is the sweep's proof that a surviving pid is still
      // this harness and not a recycled pid (M2-5). `undefined` when `ps`
      // cannot answer before the harness exits: the sweep then leaves the pid
      // alone rather than signal a stranger.
      const entry: Child = { pid: update.pid, kind, ownerId, unitId: agent };
      children.set(update.pid, entry);
      recordChildren();
      // Filled in after the fact, never inline: `processIdentity` shells out
      // to `ps`, and doing that synchronously here would stall every other
      // run's SSE writes and permission answers on each harness spawn. The
      // entry is filled in after the fact, so a crash inside that window is
      // the known no-identity outcome: the next boot cannot safely signal the
      // pid and can only name it in a notice, leaving it alive. Conservative,
      // not a free window; `_client_harness_exited` still drops the entry
      // when the harness exits normally.
      void processIdentity(update.pid).then((startedAt) => {
        if (startedAt === null || children.get(update.pid) !== entry) return;
        entry.startedAt = startedAt;
        recordChildren();
      });
    } else if (update.sessionUpdate === "_client_harness_exited") {
      children.delete(update.pid);
      recordChildren();
    }
  });
}

async function postRepo(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req, ["path"]);
  // Since #129 a repository cannot be in a state that refuses a run, so this
  // only resolves the root. The 409 that used to live here — a tracked or
  // unignored `.kapelle/` — is gone with the state that caused it.
  const { root } = await stateDirRoot(existingDir(body.path, "path"));
  // M2-7: a config that does not load is refused at add time, naming the file
  // and key, rather than at the repository's first run.
  try {
    readProjectConfig(root);
  } catch (err) {
    throw refusal(400, "invalid_config", messageOf(err));
  }
  // Persisted before the 200 and before the in-memory add: a caller told its
  // repository was added must not find it gone after a restart, and a failed
  // write must not leave memory ahead of disk. Hence the copy — it is what
  // lets the write happen first, and it dedups a repository added twice.
  const next = new Set(repos).add(root);
  writeRepos([...next]);
  repos.add(root);
  send(res, 200, { root } satisfies RepoAdded);
}

/**
 * The repository root `cwd` belongs to, or a 403 for a folder outside every
 * added one. `stateDirRoot` never throws, so an unadded folder is told to add
 * itself rather than to fix something else. Shared by `POST /runs` and
 * `POST /rooms`, which refuse in the same order.
 */
async function refuseUnadded(cwd: string): Promise<string> {
  const { root } = await stateDirRoot(cwd);
  if (!repos.has(root)) {
    throw refusal(
      403,
      "repo_not_added",
      `${root} has not been added to the daemon. POST /repos ` +
        `{"path": ${JSON.stringify(root)}} first.`,
    );
  }
  return root;
}

/** The `Idempotency-Key` header, `undefined` when absent, or a 400. Visible
 *  ASCII with no space, so a duplicated header, which Node joins with ", ",
 *  is refused rather than read as one key. */
function idempotencyKey(req: IncomingMessage): string | undefined {
  const key = req.headers["idempotency-key"];
  if (key === undefined) return undefined;
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,255}$/.test(key)) {
    throw refusal(
      400,
      "invalid_request",
      "Idempotency-Key must be 1 to 255 visible ASCII characters, with no space",
    );
  }
  return key;
}

/** The digest of a parsed body with every object's keys sorted, so a retry
 *  that sends the same fields in another order is the same body. Arrays keep
 *  their order: task order means something. */
function bodyDigest(body: Record<string, unknown>): Buffer {
  return digest(
    JSON.stringify(body, (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
          )
        : value,
    ),
  );
}

/**
 * `POST /runs`, with an optional `Idempotency-Key` (M5-7, #139). The key is
 * reserved before the body is read, so a retry that arrives while the first
 * request has not answered gets `idempotency_in_progress` rather than a second
 * run. Only a `202` is kept: a refused request frees its key, so the client
 * can fix it and send it again with the same key.
 */
async function postRun(req: IncomingMessage, res: ServerResponse) {
  const key = idempotencyKey(req);
  if (key === undefined) {
    const id = await startRun(await readBody(req, ["cwd", "run"]));
    send(res, 202, { id } satisfies RunAccepted);
    return;
  }
  const seen = idempotencyKeys.get(key);
  if (seen === null) {
    throw refusal(
      409,
      "idempotency_in_progress",
      `a request with Idempotency-Key ${key} has not answered yet`,
    );
  }
  if (seen) {
    const body = await readBody(req, ["cwd", "run"]);
    if (!bodyDigest(body).equals(seen.hash)) {
      throw refusal(
        409,
        "idempotency_conflict",
        `Idempotency-Key ${key} was used with a different body`,
      );
    }
    send(res, 202, { id: seen.id } satisfies RunAccepted);
    return;
  }
  idempotencyKeys.set(key, null);
  let id: string;
  try {
    const body = await readBody(req, ["cwd", "run"]);
    id = await startRun(body);
    idempotencyKeys.set(key, { hash: bodyDigest(body), id });
  } catch (err) {
    // Only when no run started: a key freed after that would let a retry
    // start a second run.
    idempotencyKeys.delete(key);
    throw err;
  }
  send(res, 202, { id } satisfies RunAccepted);
}

/** Validate a `POST /runs` body, start the run, and return its id. */
async function startRun(body: Record<string, unknown>): Promise<string> {
  const cwd = existingDir(body.cwd, "cwd");
  const root = await refuseUnadded(cwd);

  // M2-7: project config and `KAPELLE_*` supply the run-file defaults. Two
  // codes for two 400s, because the fix is in a different file: the
  // repository's config, or the run file the client sent.
  let defaults: ReturnType<typeof resolveRunDefaults>;
  try {
    defaults = resolveRunDefaults(root);
  } catch (err) {
    throw refusal(400, "invalid_config", messageOf(err));
  }
  let run: Run;
  try {
    run = validateRun(body.run, AGENTS, defaults);
  } catch (err) {
    throw refusal(400, "invalid_run", messageOf(err));
  }

  // No preflight before the 202 any more (#129). It existed to answer the two
  // 409s — an unsafe `.kapelle/`, a dirty tree — that this daemon no longer
  // has, and it cost about ten git spawns per run to repeat what `runRun`
  // does anyway (measured on #107).
  const id = newRunId();

  // After the last await, so no run can start once a shutdown has begun.
  if (stopping) {
    throw refusal(503, "shutting_down", "the daemon is shutting down");
  }

  const state: RunState = {
    id,
    cwd,
    root,
    status: "running",
    source: "live",
    startedAt: new Date().toISOString(),
    notices: [],
    tasks: [],
  };
  const bus = createEventBus();
  trackChildren(bus, "run", id);
  bus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "_client_task_finished") {
      // A task the watchdog's TTL cut leaves decisions nobody can act on: its
      // harness is gone and the run-wide signal has not fired, because the
      // siblings are still running. The task's own end is the sturdy hook —
      // a cancelled harness asks again on its way out (measured against
      // `mock-agent.mjs`: a second request arrives after `session/cancel`),
      // so denying at the cancel would leave that one listed until the timeout.
      permissions.denyTask(id, agent);
    }
  });
  const canceller = new AbortController();
  runs.set(id, state);
  cancels.set(id, canceller);
  let settleLog: (log?: EventLog) => void = () => {};
  eventLogs.set(
    id,
    new Promise((ok) => {
      settleLog = ok;
    }),
  );
  const done = runRun(run, {
    cwd,
    runId: id,
    bus,
    signal: canceller.signal,
    onEventLog: settleLog,
    askPolicy: permissions.policyFor(id, bus, canceller.signal),
    onTasks: (tasks) => {
      state.tasks = tasks.map(toTaskDto);
    },
    onNotice: (taskId, text, kind) => {
      state.notices.push(kind ? { taskId, text, kind } : { taskId, text });
    },
    // Before `_client_run_finished` is appended (M5-5), so a client that
    // reads it and then asks `GET /runs/:id` sees this status, and the same
    // `endedAt` the record carries.
    onFinished: (report, endedAt) => {
      state.status = report.status;
      state.report = report;
      state.endedAt = endedAt;
    },
  })
    .then(
      // `onFinished` settled a run that ended; only a throw is left here.
      () => {},
      (err) => {
        state.status = "failed";
        state.error = messageOf(err);
        state.endedAt = new Date().toISOString();
      },
    )
    .finally(() => {
      // A task the watchdog cut can leave a decision behind; the run is over,
      // so deny it now rather than list it until the timer. The reason is
      // what the queue reports as the decision's `reason` (M5-4).
      canceller.abort("run_end");
      cancels.delete(id);
      inFlight.delete(done);
      settleLog(undefined);
    });
  inFlight.add(done);
  return id;
}

/**
 * `GET /runs/:id/events` — every event of the run, then the live tail, as SSE
 * (M2-2, #32). Each event's `id:` is its `seq`, so a reconnecting client's
 * `Last-Event-ID` resumes at the next one. The stream ends when the run does.
 */
async function getEvents(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  // Before any await: a client that leaves while the log is still pending
  // must not leave a reader behind for the rest of the run.
  const gone = new AbortController();
  res.on("close", () => gone.abort());

  const pending = eventLogs.get(id) ?? restoredLog(id);
  if (!pending) throw refusal(404, "run_not_found", `no run ${id}`);
  const log = await pending;
  if (!log) {
    throw refusal(404, "no_event_log", `run ${id} has no event log`);
  }
  await streamLog(log, req, res, gone.signal);
}

const rooms = new Map<
  string,
  /** `dismissed` is set only once a dismiss has *finished* tearing the room
   *  down, so it tells a settled dismiss from one still in flight. */
  { room: Room; state: RoomState; dismissed?: boolean }
>();

/** A room's own refusal as the daemon answers it, or undefined when `err`
 *  is a failure rather than a refusal. */
function roomRefused(err: unknown) {
  if (!(err instanceof RoomRefusal)) return undefined;
  const status =
    err.code === "invalid_request"
      ? 400
      : err.code === "participant_not_found"
        ? 404
        : err.code === "queue_full"
          ? 429
          : 409;
  return refusal(status, err.code, err.message);
}

/**
 * `POST /rooms {cwd, title?, agents?: [agent]}` — a room, empty or with
 * agents added in order, kept until it is dismissed (M6-2). An agent is what
 * `POST /rooms/:id/agents` takes. The
 * refusals keep `POST /runs`'s order — not added (403), then a bad request
 * (400) — and the answer waits for every harness's session, so a harness
 * that cannot start is this request's error, not a dead participant (S13).
 * Always `auto`: nobody answers a room's permission prompts yet (M6-5).
 */
async function postRoom(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req, ["cwd", "title", "agents"]);
  const cwd = existingDir(body.cwd, "cwd");
  await refuseUnadded(cwd);

  // No length cap beyond the 4 MiB body limit, the same as a message.
  if (
    body.title !== undefined &&
    (typeof body.title !== "string" || !body.title.trim())
  ) {
    throw refusal(400, "invalid_request", '"title" must be a non-empty string');
  }
  let agents: ReturnType<typeof roomAgents>;
  try {
    agents = roomAgents(body.agents);
  } catch (err) {
    throw roomRefused(err) ?? refusal(400, "invalid_request", messageOf(err));
  }

  const id = newRoomId();
  // No 409 wrapper (#129): since the state directory moved out of the
  // repository, `openWorktrees` throws for nothing a repository can be in.
  const setup = await openWorktrees(cwd, id);
  // The watchdog's warn limits, from the same layers as a run's (R38).
  let limits: WatchdogLimits;
  try {
    limits = { ...WATCHDOG_DEFAULTS, ...resolveRunDefaults(setup.root) };
  } catch (err) {
    throw refusal(400, "invalid_config", messageOf(err));
  }
  if (stopping) {
    throw refusal(503, "shutting_down", "the daemon is shutting down");
  }

  const bus = createEventBus();
  // A room's bus names each event by participant id, so that is the
  // `unitId` the sweep records.
  trackChildren(bus, "room", id);
  let room: Room;
  try {
    room = await openRoom({
      roomId: id,
      cwd,
      agents,
      setup,
      bus,
      limits,
    });
  } catch (err) {
    throw roomRefused(err) ?? refusal(500, "room_open_failed", messageOf(err));
  }
  // A shutdown that began while the harness was starting has already
  // dismissed every room it knew of; this one must not outlive the daemon.
  if (stopping) {
    await room.dismiss();
    throw refusal(503, "shutting_down", "the daemon is shutting down");
  }
  const now = new Date().toISOString();
  const state: RoomState = { id, cwd, createdAt: now, updatedAt: now };
  if (typeof body.title === "string") state.title = body.title.trim();
  rooms.set(id, { room, state });
  send(res, 201, toRoomDto(state, room) satisfies RoomDto);
}

/** The room `id` names, or a 404. */
function roomEntry(id: string) {
  const entry = rooms.get(id);
  if (!entry) throw refusal(404, "room_not_found", `no room ${id}`);
  return entry;
}

/**
 * `POST /rooms/:id/agents {agent | cmd, name?, role?, mode?, base?,
 * settings?}` — one more participant (M6-3). 201 once its harness has a
 * session, as for `POST /rooms` (S13).
 */
async function postAgent(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const entry = roomEntry(id);
  const body = await readBody(req, AGENT_FIELDS);
  let request: ReturnType<typeof roomAgent>;
  try {
    request = roomAgent(body);
  } catch (err) {
    throw roomRefused(err) ?? refusal(400, "invalid_request", messageOf(err));
  }
  const shuttingDown = () =>
    refusal(503, "shutting_down", "the daemon is shutting down");
  if (stopping) throw shuttingDown();
  let participant: Awaited<ReturnType<Room["add"]>>;
  try {
    participant = await entry.room.add(request);
  } catch (err) {
    // A shutdown dismisses the room under the add, which then reads as
    // dismissed; the daemon's own reason is the true one.
    if (stopping) throw shuttingDown();
    throw roomRefused(err) ?? refusal(500, "room_open_failed", messageOf(err));
  }
  entry.state.updatedAt = new Date().toISOString();
  send(res, 201, toParticipantDto(participant) satisfies ParticipantDto);
}

/** `PATCH /rooms/:id/agents/:agentId {name?, mode?, role?}` — the one route
 *  that changes a participant (R10, R44). `role: null` clears the role. */
async function patchAgent(
  id: string,
  agentId: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const entry = roomEntry(id);
  const body = await readBody(req, ["name", "mode", "role"]);
  let changes: ReturnType<typeof participantChanges>;
  try {
    changes = participantChanges(body);
  } catch (err) {
    throw refusal(400, "invalid_request", messageOf(err));
  }
  let participant: ReturnType<Room["update"]>;
  try {
    participant = entry.room.update(agentId, changes);
  } catch (err) {
    throw roomRefused(err) ?? err;
  }
  entry.state.updatedAt = new Date().toISOString();
  send(res, 200, toParticipantDto(participant) satisfies ParticipantDto);
}

/** `DELETE /rooms/:id/agents/:agentId` — cancels the participant's turn,
 *  stops its harness and keeps its work, as a dismiss does (R37). Answers
 *  the room, without it. */
async function deleteAgent(id: string, agentId: string, res: ServerResponse) {
  const entry = roomEntry(id);
  try {
    await entry.room.remove(agentId);
  } catch (err) {
    throw roomRefused(err) ?? err;
  }
  entry.state.updatedAt = new Date().toISOString();
  send(res, 200, toRoomDto(entry.state, entry.room) satisfies RoomDto);
}

/** The participant `agentId` names in room `id`, or a 404. */
function participantEntry(id: string, agentId: string) {
  const found = roomEntry(id).room.participants.find((p) => p.id === agentId);
  if (!found) {
    throw refusal(404, "participant_not_found", `no participant ${agentId}`);
  }
  return found;
}

/**
 * `POST /rooms/:id/agents/:agentId/messages {text}` — one message to the
 * participant it names; `POST /rooms/:id/messages {text}` (no `agentId`) —
 * one to the room's orchestrator (R7a). The daemon never reads the text: a
 * client turns `@name` into the id (R43). 202 once the message is on the
 * room's log, as a turn that started or as one queued behind the live turn
 * (R32a); a full queue is `429` (R41). `seq` is the log's size before the
 * message, and `queued` is how many turns come first, so a client knows
 * which `_client_turn_ended` is its answer.
 */
async function postMessage(
  id: string,
  agentId: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const entry = roomEntry(id);
  const { text } = await readBody(req, ["text"]);
  if (typeof text !== "string" || !text.trim()) {
    throw refusal(400, "invalid_request", '"text" must be a non-empty string');
  }
  if (entry.room.status() === "dismissed") {
    throw refusal(409, "room_dismissed", `room ${id} is dismissed`);
  }
  const target =
    agentId === undefined
      ? entry.room.participants.find((p) => p.role === "orchestrator")
      : participantEntry(id, agentId);
  if (!target) {
    throw refusal(
      409,
      "no_orchestrator",
      `room ${id} has no participant with the orchestrator role`,
    );
  }
  const seq = entry.room.eventLog?.size ?? 0;
  const queued = target.status() === "busy" ? target.queued + 1 : 0;
  let turn: Promise<void>;
  try {
    turn = target.send(text);
  } catch (err) {
    throw roomRefused(err) ?? err;
  }
  entry.state.updatedAt = new Date().toISOString();
  // Settles with the turn; a failed turn is already on the log as an event.
  turn.catch(() => {});
  send(res, 202, { seq, queued } satisfies MessageAccepted);
}

/**
 * `POST /rooms/:id/agents/:agentId/turns/current/cancel` — drops the
 * participant's queue and asks its harness to end the live turn. The
 * session and the room stay (S5a). 202, as a run's cancel: the turn ends on
 * the stream with `_client_turn_ended`.
 */
function cancelTurn(id: string, agentId: string, res: ServerResponse) {
  const entry = roomEntry(id);
  if (entry.room.status() === "dismissed") {
    throw refusal(409, "room_dismissed", `room ${id} is dismissed`);
  }
  const p = participantEntry(id, agentId);
  if (!p.cancel()) {
    throw refusal(409, "no_turn", `${p.name} has no turn to cancel`);
  }
  send(res, 202, toParticipantDto(p) satisfies ParticipantDto);
}

/** `GET /rooms/:id/events`, the room timeline, or with `agentId`
 *  `GET /rooms/:id/agents/:agentId/events`: the same log, only that
 *  participant's lines (R8c). `seq` and `Last-Event-ID` are the room's. */
async function roomEvents(
  id: string,
  agentId: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const log = roomEntry(id).room.eventLog;
  if (agentId !== undefined) participantEntry(id, agentId);
  if (!log) {
    throw refusal(404, "no_event_log", `room ${id} has no event log`);
  }
  const gone = new AbortController();
  res.on("close", () => gone.abort());
  const keep =
    agentId === undefined
      ? undefined
      : (line: string) => JSON.parse(line).participantId === agentId;
  await streamLog(log, req, res, gone.signal, { keep });
}

/**
 * `POST /rooms/:id/dismiss` — a person ends the room. Synchronous, unlike a
 * run's cancel: it waits for the harness to stop and the checkout to be
 * released — kept, never committed (R37) — which `stop()` bounds at 5 s.
 */
async function dismissRoom(id: string, res: ServerResponse) {
  const entry = roomEntry(id);
  if (entry.dismissed) {
    throw refusal(409, "room_dismissed", `room ${id} is already dismissed`);
  }
  // **Not `status() === "dismissed"`**, which reads so the instant a dismiss
  // begins: a second request arriving mid-teardown would then be told the
  // room was already dismissed while its harness was still alive and its
  // checkout unreleased, which is exactly what S6(a) promises does not
  // happen. `dismiss()` hands every caller the same promise, so two racing
  // dismissals both wait for the one teardown and both get their 200.
  // `dismissed` is set after the await, so only a request that arrives once
  // the dismiss has settled is refused.
  await entry.room.dismiss();
  if (!entry.dismissed) {
    entry.dismissed = true;
    entry.state.updatedAt = new Date().toISOString();
  }
  send(res, 200, toRoomDto(entry.state, entry.room) satisfies RoomDto);
}

/** `POST /permissions/:id {"allow": boolean}` — the first answer wins. */
async function postPermission(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const { allow } = await readBody(req, ["allow"]);
  if (typeof allow !== "boolean") {
    throw refusal(
      400,
      "invalid_request",
      `"allow" must be true or false; got ${allow}`,
    );
  }
  const result = permissions.answer(id, allow);
  if (result === "unknown") {
    throw refusal(404, "permission_not_found", `no permission ${id}`);
  }
  // A defined error, not an overwrite: someone else's answer, the timeout or
  // a cancel already decided it, and the harness has been told.
  if (result === "settled") {
    throw refusal(
      409,
      "already_decided",
      `permission ${id} was already decided`,
    );
  }
  send(res, 200, { id, allow } satisfies PermissionAnswered);
}

/** A parse base for `req.url`, which is a path, not a URL. Never fetched;
 *  named as a constant so it is not mistaken for a configurable endpoint. */
const REQUEST_URL_BASE = "http://daemon";

async function route(req: IncomingMessage, res: ServerResponse) {
  // Before the token and every route: a forged, duplicated or missing Host is
  // refused here. requireHostHeader: false lets this guard handle the last.
  if (!hostAllowed(req)) {
    throw refusal(403, "host_not_allowed", "host not allowed");
  }
  if (!authorised(req, expected)) {
    throw refusal(401, "unauthorized", "missing or wrong token");
  }
  const { pathname } = new URL(req.url ?? "/", REQUEST_URL_BASE);
  const one = /^\/runs\/([^/]+)$/.exec(pathname);
  const events = /^\/runs\/([^/]+)\/events$/.exec(pathname);
  const decision = /^\/permissions\/([^/]+)$/.exec(pathname);
  const room = /^\/rooms\/([^/]+)$/.exec(pathname);
  const roomSub = /^\/rooms\/([^/]+)\/(events|messages|dismiss|agents)$/.exec(
    pathname,
  );
  const agentOne = /^\/rooms\/([^/]+)\/agents\/([^/]+)$/.exec(pathname);
  const agentSub =
    /^\/rooms\/([^/]+)\/agents\/([^/]+)\/(messages|events|turns\/current\/cancel)$/.exec(
      pathname,
    );

  if (req.method === "GET" && pathname === "/version") {
    send(res, 200, {
      apiVersion: API_VERSION,
      capabilities: [...CAPABILITIES],
    } satisfies VersionReply);
  } else if (req.method === "POST" && pathname === "/repos") {
    await postRepo(req, res);
  } else if (req.method === "GET" && pathname === "/repos") {
    send(res, 200, [...repos] satisfies RepoRoots);
  } else if (req.method === "POST" && pathname === "/runs") {
    await postRun(req, res);
  } else if (req.method === "GET" && pathname === "/runs") {
    send(
      res,
      200,
      [...runs.values()].map(toRunListEntry) satisfies RunListEntry[],
    );
  } else if (req.method === "POST" && pathname === "/rooms") {
    await postRoom(req, res);
  } else if (req.method === "GET" && pathname === "/rooms") {
    send(
      res,
      200,
      [...rooms.values()].map(({ state, room }) =>
        toRoomListEntry(state, room),
      ) satisfies RoomListEntry[],
    );
  } else if (req.method === "GET" && room) {
    const { state, room: live } = roomEntry(room[1] as string);
    send(res, 200, toRoomDto(state, live) satisfies RoomDto);
  } else if (req.method === "POST" && roomSub?.[2] === "messages") {
    await postMessage(roomSub[1] as string, undefined, req, res);
  } else if (req.method === "POST" && agentSub?.[3] === "messages") {
    await postMessage(agentSub[1] as string, agentSub[2], req, res);
  } else if (req.method === "GET" && agentSub?.[3] === "events") {
    await roomEvents(agentSub[1] as string, agentSub[2], req, res);
  } else if (
    req.method === "POST" &&
    agentSub?.[3] === "turns/current/cancel"
  ) {
    cancelTurn(agentSub[1] as string, agentSub[2] as string, res);
  } else if (req.method === "POST" && roomSub?.[2] === "agents") {
    await postAgent(roomSub[1] as string, req, res);
  } else if (req.method === "GET" && roomSub?.[2] === "agents") {
    send(
      res,
      200,
      roomEntry(roomSub[1] as string).room.participants.map(
        toParticipantDto,
      ) satisfies ParticipantDto[],
    );
  } else if (req.method === "GET" && agentOne) {
    const p = participantEntry(agentOne[1] as string, agentOne[2] as string);
    send(res, 200, toParticipantDto(p) satisfies ParticipantDto);
  } else if (req.method === "PATCH" && agentOne) {
    await patchAgent(agentOne[1] as string, agentOne[2] as string, req, res);
  } else if (req.method === "DELETE" && agentOne) {
    await deleteAgent(agentOne[1] as string, agentOne[2] as string, res);
  } else if (req.method === "POST" && roomSub?.[2] === "dismiss") {
    await dismissRoom(roomSub[1] as string, res);
  } else if (req.method === "GET" && roomSub?.[2] === "events") {
    await roomEvents(roomSub[1] as string, undefined, req, res);
  } else if (req.method === "GET" && events) {
    await getEvents(events[1] as string, req, res);
  } else if (req.method === "GET" && one) {
    const state = runs.get(one[1] as string);
    if (!state) throw refusal(404, "run_not_found", `no run ${one[1]}`);
    send(res, 200, toRunDto(state) satisfies RunDto);
  } else if (req.method === "GET" && pathname === "/permissions") {
    send(res, 200, permissions.list() satisfies PendingDecision[]);
  } else if (req.method === "GET" && decision) {
    const found = permissions.get(decision[1] as string);
    if (!found) {
      throw refusal(
        404,
        "permission_not_found",
        `no permission ${decision[1]}`,
      );
    }
    send(res, 200, found satisfies PermissionDecision);
  } else if (req.method === "POST" && decision) {
    await postPermission(decision[1] as string, req, res);
  } else if (req.method === "DELETE" && one) {
    // Asynchronous on purpose: cancel is cooperative, so the answer is an
    // acknowledgement and `GET` reports the verdict. `core/run.ts` stops a
    // harness 2 s after the abort, so no timer is needed here.
    const id = one[1] as string;
    const state = runs.get(id);
    const canceller = cancels.get(id);
    if (!state) {
      throw refusal(404, "run_not_found", `no run ${id}`);
    } else if (!canceller) {
      throw refusal(
        409,
        "run_ended",
        `run ${id} already ended: ${state.status}`,
      );
    } else {
      canceller.abort("cancel");
      state.cancelRequested = true;
      send(res, 202, toRunDto(state) satisfies RunDto);
    }
  } else {
    throw refusal(404, "no_route", `no route for ${req.method} ${pathname}`);
  }
}

/**
 * J3: a request not fully received in 30 s gets Node's own `408 Request
 * Timeout`, with an empty body, and its connection is closed. Node sends it,
 * not `route`, so it is the one exception to the envelope, with Node's reply
 * to malformed HTTP. It covers receiving the request only: a slow reply and an
 * SSE stream are never cut (measured 2026-09-23). Node checks every 30 s, so
 * the 408 lands between 30 and 60 s.
 */
const server = createServer(
  { requireHostHeader: false, requestTimeout: 30_000 },
  (req, res) => {
    route(req, res).catch((err) => {
      const { status, code } =
        err instanceof Refusal
          ? err
          : ({ status: 500, code: "internal" } as const);
      // A refusal sent before the body was read (a 413, a 415, a 404 on a
      // write) leaves the rest to Node, which reads and discards it, bounded
      // by `requestTimeout`. Never `connection: close`: the client is often
      // still uploading, and a close then reaches it as EPIPE instead of this
      // reply (measured 2026-09-23, 4 runs in 10 on one core).
      send(res, status, {
        error: { code, message: messageOf(err) },
      } satisfies ErrorReply);
    });
  },
);

let stopping = false;

/**
 * SIGTERM or SIGINT: cancel every run, wait for each to settle, then remove
 * `daemon.json` and exit 0 (M2-4, #34).
 *
 * No kill loop of its own. A cancelled task stops its harness through
 * `core/run.ts` (2 s after the abort), and `AcpAgent.stop()` closes stdin
 * before it ever signals — the only stop that also ends the shell commands a
 * harness started. Waiting on the runs is what waits on their harnesses, and
 * it is also what lets each worktree be released.
 */
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: cancelling ${inFlight.size} run(s), then exiting`);
  server.close();
  for (const canceller of cancels.values()) canceller.abort("cancel");
  await Promise.all([
    ...inFlight,
    ...[...rooms.values()].map(({ room }) => room.dismiss()),
  ]);
  rmSync(file, { force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

server.on("error", (err) => {
  rmSync(file, { force: true });
  console.error(`cannot listen on 127.0.0.1:${port}: ${messageOf(err)}`);
  process.exit(1);
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
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, port: bound, token }), {
    mode: 0o600,
  });
  renameSync(tmp, file);
  closeSync(fd);
  console.log(`listening on http://127.0.0.1:${bound} (token in ${file})`);
});
