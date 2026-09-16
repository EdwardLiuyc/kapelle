#!/usr/bin/env node
/**
 * The daemon — story M2-1, issue #31.
 *
 * **One daemon for all of the operator's repositories** (decided 2026-09-11,
 * #31). A repository is added once (`POST /repos`), and a run names the folder
 * it runs in (`POST /runs {cwd, run}`); a folder outside every added
 * repository is refused. One port, one token, and one place — M4's dashboard
 * — to watch every run. Run state still lives in each repository's
 * `.kapelle/`.
 *
 * **Transport over `core/`, and nothing more.** It calls `stateDirRoot`,
 * `checkStateDir`, `validateRun`, `openWorktrees`, `runRun` and the permission
 * queue; worktrees,
 * policy and harnesses stay behind them. If orchestration grew here, the scheduler would be
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
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { type EventLog, openEventLog } from "./core/eventlog.ts";
import { createEventBus } from "./core/events.ts";
import { newRunId } from "./core/ids.ts";
import { createPermissionQueue } from "./core/permissions.ts";
import { type RunReport, runRun, type TaskStatus } from "./core/run.ts";
import { type Run, validateRun } from "./core/runfile.ts";
import { readRepos, runtimeDir, writeRepos } from "./core/runtime.ts";
import {
  checkStateDir,
  openWorktrees,
  STATE_DIR,
  stateDirRoot,
} from "./core/worktree.ts";
import type { Warning } from "./protocol/registry.ts";

// ponytail: a fixed default port; M2-7's config is its home.
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

// ponytail: a daemon-wide flag; M2-7's user-level config is its home too.
const DEFAULT_PERMISSION_TIMEOUT_S = 120;

const { port, permissionTimeoutMs } = orExit(() => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      "permission-timeout": { type: "string" },
    },
  });
  const n = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(
      `--port must be a whole number 0-65535; got ${values.port}`,
    );
  }
  const raw = values["permission-timeout"];
  const seconds =
    raw === undefined ? DEFAULT_PERMISSION_TIMEOUT_S : Number(raw);
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
 */
function create(file: string): number {
  const tmp = `${file}.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid }));
    linkSync(tmp, file);
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
    rmSync(file, { force: true });
    return create(file);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const dir = orExit(runtimeDir);
const file = join(dir, "daemon.json");
const fd = orExit(() => claim(file));

const token = randomBytes(32).toString("hex");
// Compared as digests: `timingSafeEqual` needs equal lengths, and hashing
// both sides gives that without a length check that answers early.
const digest = (s: string) => createHash("sha256").update(s).digest();
const expected = digest(token);

function authorised(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(given), expected);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** An error that carries its HTTP status. Anything thrown without one is 500. */
function refusal(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw refusal(400, `body is not JSON: ${messageOf(err)}`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw refusal(400, "body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** `value` as the real path of a folder that exists, or a 400 naming `field`. */
function existingDir(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw refusal(
      400,
      `"${field}" must be an absolute path; got ${JSON.stringify(value)}`,
    );
  }
  if (!statSync(value, { throwIfNoEntry: false })?.isDirectory()) {
    throw refusal(400, `"${field}": ${value} does not exist as a folder`);
  }
  return realpathSync(value);
}

/** The repository root of `dir`, or a 409 when its `.kapelle/` is unsafe. */
async function rootOf(dir: string): Promise<string> {
  try {
    return (await checkStateDir(dir)).root;
  } catch (err) {
    throw refusal(409, messageOf(err));
  }
}

/** Every repository root added, restored from `repos.json` (M2-6, #36).
 *  Not re-checked here: a repository that has moved or whose `.kapelle/` has
 *  since been committed is refused by `POST /runs`, which checks on use. */
const repos = new Set<string>(readRepos());

/** One run as the API reports it. Live runs are built here; finished ones
 *  are read back from their `run.json` at boot (M2-6, #36). */
interface RunState {
  id: string;
  /** The folder the run was started in: a repository root or a folder in one. */
  cwd: string;
  status: "running" | TaskStatus;
  report?: RunReport;
  /** Set when `runRun` itself threw, which means no task record exists. */
  error?: string;
  /** Our own record that a cancel was asked for, the way `core/run.ts`
   *  keeps one: the status stays `running` until the run settles. */
  cancelRequested?: true;
  /** Every notice, containment lines included. #13 says those are never
   *  suppressed, and with no terminal this record is where they survive. */
  notices: { taskId: string; text: string; kind?: Warning["kind"] }[];
  /** A run read back from disk after a restart, and the tasks its record
   *  names. `report` belongs to the run that happened in *this* process, so a
   *  restored run has the record's task list instead of a synthesised one. */
  restored?: true;
  tasks?: RecordTask[];
}

/** A task as `run.json` carries it — `core/run.ts` writes this shape. */
interface RecordTask {
  id: string;
  status: string;
  branch?: string;
  baseSha?: string;
  sessionId?: string;
}

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

/**
 * Read every added repository's finished runs back into memory (M2-6, #36).
 *
 * Run state lives in each repository's `.kapelle/runs/<id>/`, so the scan
 * follows the repository list rather than a second index. Anything unreadable
 * is skipped in silence: a run whose record is missing, truncated by a crash
 * or not ours is exactly what M2-5's sweep exists to reconcile, and a daemon
 * that refused to boot over one could not be reached by the request that
 * fixes it.
 *
 * **Only terminal runs.** A record still saying `running` belongs to a
 * process that is gone; calling it live here would list a run nothing is
 * running and hand `DELETE` a canceller that does not exist. Marking those
 * `errored` is #35's job, and this story gives it the record to do it with.
 */
function restoreRuns(): void {
  for (const root of repos) {
    const dir = join(root, STATE_DIR, "runs");
    let ids: string[];
    try {
      ids = readdirSync(dir);
    } catch {
      continue;
    }
    for (const id of ids) {
      const logDir = join(dir, id);
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(readFileSync(join(logDir, "run.json"), "utf8"));
      } catch {
        continue;
      }
      if (record?.runId !== id) continue;
      const status = record.status;
      if (typeof status !== "string" || status === "running") continue;
      const state: RunState = {
        id,
        cwd: typeof record.cwd === "string" ? record.cwd : root,
        // The record is one we wrote, so its status is a `TaskStatus`. A
        // hand-edited one reaches the API unaltered rather than failing a boot.
        status: status as TaskStatus,
        notices: [],
        restored: true,
      };
      if (Array.isArray(record.tasks)) {
        state.tasks = record.tasks as RecordTask[];
      }
      runs.set(id, state);
      restoredLogs.set(id, join(logDir, "events.jsonl"));
    }
  }
}

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
const children = new Map<
  number,
  { pid: number; runId: string; taskId: string }
>();
const childrenFile = join(dir, "children.json");

// ponytail: a pid alone can be reused by an unrelated process before M2-5
// reads it; record a start time when the sweep needs to tell them apart.
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

async function postRepo(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  // Checked once here, so a repository whose `.kapelle/` would be committed
  // never gets as far as a run.
  const root = await rootOf(existingDir(body.path, "path"));
  repos.add(root);
  // Persisted before the 200: a caller told its repository was added must not
  // find it gone after a restart.
  writeRepos([...repos]);
  send(res, 200, { root });
}

async function postRun(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  const cwd = existingDir(body.cwd, "cwd");

  // Membership answers before the state check: a folder outside every added
  // repository is a 403 whatever its `.kapelle/` looks like, so the root has
  // to be resolved unchecked. Otherwise an unadded repo with an unsafe state
  // dir would answer 409 and the client would be told to fix the wrong thing.
  const { root } = await stateDirRoot(cwd);
  if (!repos.has(root)) {
    throw refusal(
      403,
      `${root} has not been added to the daemon. POST /repos ` +
        `{"path": ${JSON.stringify(root)}} first.`,
    );
  }

  // It is one of ours, so the state-dir refusal now applies — the same 409
  // `POST /repos` would have given, before the body is validated.
  // ponytail: the state-dir check runs three times per run — here, in the
  // `openWorktrees` below, and again inside `runRun` (about ten git spawns,
  // measured on #107). Deleting this call would let a bad body's 400 answer
  // before an unsafe `.kapelle/`'s 409. Hand the handler's `openWorktrees`
  // result to `runRun` if request latency ever matters.
  await rootOf(cwd);

  let run: Run;
  try {
    run = validateRun(body.run);
  } catch (err) {
    throw refusal(400, messageOf(err));
  }

  // The preflight answers before the 202, so a caller is never handed an id
  // for a run that could not start. It is read-only until `acquire`, and
  // `runRun` repeats it; a tree that turns dirty in between still refuses
  // there, as a `failed` run.
  const id = newRunId();
  try {
    await openWorktrees(cwd, id);
  } catch (err) {
    throw refusal(409, messageOf(err));
  }

  // After the last await, so no run can start once a shutdown has begun.
  if (stopping) throw refusal(503, "the daemon is shutting down");

  const state: RunState = { id, cwd, status: "running", notices: [] };
  const bus = createEventBus();
  bus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "_client_harness_spawned") {
      children.set(update.pid, { pid: update.pid, runId: id, taskId: agent });
      recordChildren();
    } else if (update.sessionUpdate === "_client_harness_exited") {
      children.delete(update.pid);
      recordChildren();
    } else if (update.sessionUpdate === "_client_task_finished") {
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
    onNotice: (taskId, text, kind) => {
      state.notices.push(kind ? { taskId, text, kind } : { taskId, text });
    },
  })
    .then(
      (report) => {
        state.status = report.status;
        state.report = report;
      },
      (err) => {
        state.status = "failed";
        state.error = messageOf(err);
      },
    )
    .finally(() => {
      // A task the watchdog cut can leave a decision behind; the run is over,
      // so deny it now rather than list it until the timer.
      canceller.abort();
      cancels.delete(id);
      inFlight.delete(done);
      settleLog(undefined);
    });
  inFlight.add(done);
  send(res, 202, { id });
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
  if (!pending) throw refusal(404, `no run ${id}`);
  const log = await pending;
  if (!log) throw refusal(404, `run ${id} has no event log`);

  const header = req.headers["last-event-id"];
  const after = header === undefined ? 0 : Number(header);
  if (!Number.isInteger(after) || after < 0 || after > log.size) {
    throw refusal(
      400,
      `Last-Event-ID must be a whole number from 0 to ${log.size}; got ${header}`,
    );
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  // Headers go out now, not on the first write: a reconnecting client whose
  // `Last-Event-ID` is already the tail has no history to replay, and without
  // this it would sit in "connecting" until the next event.
  res.flushHeaders();
  try {
    await log.follow(
      after,
      (seq, line) => res.write(`id: ${seq}\ndata: ${line}\n\n`),
      gone.signal,
    );
  } catch {
    // Headers are sent, so no error body can follow. A cut stream is what
    // tells an SSE client to reconnect with its `Last-Event-ID`.
    res.destroy();
    return;
  }
  res.end();
}

/** `POST /permissions/:id {"allow": boolean}` — the first answer wins. */
async function postPermission(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const { allow } = await readBody(req);
  if (typeof allow !== "boolean") {
    throw refusal(400, `"allow" must be true or false; got ${allow}`);
  }
  const result = permissions.answer(id, allow);
  if (result === "unknown") throw refusal(404, `no permission ${id}`);
  // A defined error, not an overwrite: someone else's answer, the timeout or
  // a cancel already decided it, and the harness has been told.
  if (result === "settled") {
    throw refusal(409, `permission ${id} was already decided`);
  }
  send(res, 200, { id, allow });
}

async function route(req: IncomingMessage, res: ServerResponse) {
  if (!authorised(req)) {
    send(res, 401, { error: "missing or wrong token" });
    return;
  }
  const { pathname } = new URL(req.url ?? "/", "http://daemon");
  const one = /^\/runs\/([^/]+)$/.exec(pathname);
  const events = /^\/runs\/([^/]+)\/events$/.exec(pathname);
  const decision = /^\/permissions\/([^/]+)$/.exec(pathname);

  if (req.method === "POST" && pathname === "/repos") {
    await postRepo(req, res);
  } else if (req.method === "GET" && pathname === "/repos") {
    send(res, 200, [...repos]);
  } else if (req.method === "POST" && pathname === "/runs") {
    await postRun(req, res);
  } else if (req.method === "GET" && pathname === "/runs") {
    send(
      res,
      200,
      [...runs.values()].map(({ id, cwd, status }) => ({ id, cwd, status })),
    );
  } else if (req.method === "GET" && events) {
    await getEvents(events[1] as string, req, res);
  } else if (req.method === "GET" && one) {
    const state = runs.get(one[1] as string);
    if (state) send(res, 200, state);
    else send(res, 404, { error: `no run ${one[1]}` });
  } else if (req.method === "GET" && pathname === "/permissions") {
    send(res, 200, permissions.list());
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
      send(res, 404, { error: `no run ${id}` });
    } else if (!canceller) {
      send(res, 409, { error: `run ${id} already ended: ${state.status}` });
    } else {
      canceller.abort();
      state.cancelRequested = true;
      send(res, 202, state);
    }
  } else {
    send(res, 404, { error: `no route for ${req.method} ${pathname}` });
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    send(res, (err as { status?: number }).status ?? 500, {
      error: messageOf(err),
    });
  });
});

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
  for (const canceller of cancels.values()) canceller.abort();
  await Promise.all(inFlight);
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
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, port: bound, token }), {
    mode: 0o600,
  });
  renameSync(tmp, file);
  closeSync(fd);
  console.log(`listening on http://127.0.0.1:${bound} (token in ${file})`);
});
