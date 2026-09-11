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
 * **Transport over `core/`, and nothing more.** It calls `checkStateDir`,
 * `validateRun`, `openWorktrees` and `runRun`; worktrees, policy and harnesses
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
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { createEventBus } from "./core/events.ts";
import { newRunId } from "./core/ids.ts";
import { type RunReport, runRun, type TaskStatus } from "./core/run.ts";
import { type Run, validateRun } from "./core/runfile.ts";
import { checkStateDir, openWorktrees } from "./core/worktree.ts";
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

const port = orExit(() => {
  const { values } = parseArgs({ options: { port: { type: "string" } } });
  const n = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(
      `--port must be a whole number 0-65535; got ${values.port}`,
    );
  }
  return n;
});

/**
 * `$XDG_RUNTIME_DIR/kapelle`, or a per-user directory under the system temp
 * dir where that is unset (macOS). Either way it must be ours and closed to
 * everyone else: in a shared `/tmp`, another account could create the
 * directory first, and whoever owns it can read or replace the token.
 */
function runtimeDir(): string {
  const { uid } = userInfo();
  const base = process.env.XDG_RUNTIME_DIR;
  const dir = base ? join(base, "kapelle") : join(tmpdir(), `kapelle-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `lstat`, so a symlink planted where the directory should be is refused
  // rather than followed.
  const st = lstatSync(dir);
  const mode = st.mode & 0o777;
  if (!st.isDirectory() || st.uid !== uid || (mode & 0o077) !== 0) {
    throw new Error(
      `${dir} must be a directory owned by you with mode 0700; it is owned ` +
        `by uid ${st.uid} with mode ${mode.toString(8)}. Fix or remove it, ` +
        `then start the daemon again.`,
    );
  }
  return dir;
}

/** Is `pid` a live process? `EPERM` means it is, and is someone else's. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Opens `file` exclusively and writes this pid into it straight away. */
function create(file: string): number {
  const fd = openSync(file, "wx", 0o600);
  writeSync(fd, JSON.stringify({ pid: process.pid }));
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
  let holder: { pid?: unknown; port?: unknown } = {};
  try {
    holder = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Unreadable: nothing live is vouching for it, so it counts as stale.
  }
  if (typeof holder.pid === "number" && alive(holder.pid)) {
    throw new Error(
      `a daemon is already running: pid ${holder.pid}, port ${holder.port} ` +
        `(${file}).`,
    );
  }
  // ponytail: two daemons starting in the same instant can both reach this
  // line; M2-4's lifecycle work owns a strict lock.
  rmSync(file, { force: true });
  return create(file);
}

const file = orExit(() => join(runtimeDir(), "daemon.json"));
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

/** Every repository root added. In memory until M2-6 persists it. */
const repos = new Set<string>();

/** One run as the API reports it. In memory only: M2-6 persists it. */
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
}

const runs = new Map<string, RunState>();
/** Kept beside the record rather than on it, so a `GET` never serialises one. */
const cancels = new Map<string, AbortController>();

/**
 * `ask` is refused until M2-3 (decided 2026-09-11, #31).
 *
 * With no decider, `runRun` gives an `ask` task `safePolicy` — but the task
 * still says `ask`, so `negotiateSafeMode` skips it and `safe`'s forcing of
 * `allowReadOutsideRoot` never ran. On a harness that never asks, that is no
 * containment at all. `cli.ts` re-resolves such a task as `safe` and says so
 * on the terminal; the daemon has nobody watching, so it refuses instead of
 * running a mode the file did not name.
 */
function refuseAsk(run: Run): void {
  const asker = run.tasks.find((task) => task.mode === "ask");
  if (asker) {
    throw new Error(
      `task "${asker.id}": mode "ask" needs someone to answer permission ` +
        `prompts, and the daemon cannot ask until M2-3. Set "mode" to ` +
        `"safe" or "auto" — every agent defaults to "ask" when none is named.`,
    );
  }
}

async function postRepo(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  // Checked once here, so a repository whose `.kapelle/` would be committed
  // never gets as far as a run.
  const root = await rootOf(existingDir(body.path, "path"));
  repos.add(root);
  send(res, 200, { root });
}

async function postRun(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  const cwd = existingDir(body.cwd, "cwd");
  const root = await rootOf(cwd);
  if (!repos.has(root)) {
    throw refusal(
      403,
      `${root} has not been added to the daemon. POST /repos ` +
        `{"path": ${JSON.stringify(root)}} first.`,
    );
  }

  let run: Run;
  try {
    run = validateRun(body.run);
    refuseAsk(run);
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

  const state: RunState = { id, cwd, status: "running", notices: [] };
  const canceller = new AbortController();
  runs.set(id, state);
  cancels.set(id, canceller);
  runRun(run, {
    cwd,
    runId: id,
    bus: createEventBus(),
    signal: canceller.signal,
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
    .finally(() => cancels.delete(id));
  send(res, 202, { id });
}

async function route(req: IncomingMessage, res: ServerResponse) {
  if (!authorised(req)) {
    send(res, 401, { error: "missing or wrong token" });
    return;
  }
  const { pathname } = new URL(req.url ?? "/", "http://daemon");
  const one = /^\/runs\/([^/]+)$/.exec(pathname);

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
  } else if (req.method === "GET" && one) {
    const state = runs.get(one[1] as string);
    if (state) send(res, 200, state);
    else send(res, 404, { error: `no run ${one[1]}` });
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

server.on("error", (err) => {
  rmSync(file, { force: true });
  console.error(`cannot listen on 127.0.0.1:${port}: ${messageOf(err)}`);
  process.exit(1);
});

// The token is published only once the port is open, so a client never reads
// a token for a daemon that is not listening.
server.listen(port, "127.0.0.1", () => {
  const { port: bound } = server.address() as AddressInfo;
  ftruncateSync(fd, 0);
  writeSync(fd, JSON.stringify({ pid: process.pid, port: bound, token }), 0);
  closeSync(fd);
  console.log(`listening on http://127.0.0.1:${bound} (token in ${file})`);
});
