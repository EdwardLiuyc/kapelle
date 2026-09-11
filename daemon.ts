#!/usr/bin/env node
/**
 * The daemon — story M2-1, issue #31.
 *
 * **Transport over `core/`, and nothing more.** `POST /runs` validates and
 * hands the run to `runRun`, exactly as `cli.ts --file` does; worktrees,
 * policy and harnesses stay behind that call. If orchestration grew here, the
 * scheduler would be untestable without a server and the CLI would drift into
 * a second implementation (`docs/STORIES.md`, M2-1).
 *
 * **The token is not optional, even on 127.0.0.1** (decided 2026-09-11, #31).
 * Every account on the machine can reach the loopback address, and a run file
 * is a command line — `cmd`, or any harness under `auto`. The token file is
 * `0600`, so being able to read it is the same as being the operator. It stops
 * being enough the moment the daemon binds anywhere else, which is also the
 * trigger that re-opens sandboxing.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createEventBus } from "./core/events.ts";
import { newRunId } from "./core/ids.ts";
import { type RunReport, runRun, type TaskStatus } from "./core/run.ts";
import { type Run, validateRun } from "./core/runfile.ts";
import { openWorktrees, STATE_DIR } from "./core/worktree.ts";
import type { Warning } from "./protocol/registry.ts";

// ponytail: a fixed default port; M2-7's config is its home.
const DEFAULT_PORT = 4719;

let flags: { cwd?: string; port?: string };
try {
  flags = parseArgs({
    options: { cwd: { type: "string" }, port: { type: "string" } },
  }).values;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const cwd = resolve(flags.cwd ?? process.cwd());
const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`--port must be a whole number 0-65535; got ${flags.port}`);
  process.exit(1);
}

// A fresh token per start. Removed first and created exclusively, because
// `mode` applies only when a file is created: rewriting a stale file left
// `0644` would hand the new token to everyone who could read the old one.
const token = randomBytes(32).toString("hex");
const tokenFile = join(cwd, STATE_DIR, "daemon.token");
mkdirSync(join(cwd, STATE_DIR), { recursive: true });
rmSync(tokenFile, { force: true });
writeFileSync(tokenFile, token, { mode: 0o600, flag: "wx" });

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

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** One run as the API reports it. In memory only: M2-6 persists it. */
interface RunState {
  id: string;
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

async function postRun(req: IncomingMessage, res: ServerResponse) {
  let run: Run;
  try {
    let text = "";
    for await (const chunk of req) text += chunk;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new Error(`body is not JSON: ${messageOf(err)}`);
    }
    run = validateRun(body);
    refuseAsk(run);
  } catch (err) {
    send(res, 400, { error: messageOf(err) });
    return;
  }

  // The preflight answers before the 202 (decided 2026-09-11, #31), so a
  // caller is never handed an id for a run that could not start. It is
  // read-only until `acquire`, and `runRun` repeats it; a tree that turns
  // dirty in between still refuses there, as a `failed` run.
  const id = newRunId();
  try {
    await openWorktrees(cwd, id);
  } catch (err) {
    send(res, 409, { error: messageOf(err) });
    return;
  }

  const state: RunState = { id, status: "running", notices: [] };
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

  if (req.method === "POST" && pathname === "/runs") {
    await postRun(req, res);
  } else if (req.method === "GET" && pathname === "/runs") {
    send(
      res,
      200,
      [...runs.values()].map(({ id, status }) => ({ id, status })),
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
    send(res, 500, { error: messageOf(err) });
  });
});

server.listen(port, "127.0.0.1", () => {
  const { port: bound } = server.address() as AddressInfo;
  console.log(`listening on http://127.0.0.1:${bound} (token in ${tokenFile})`);
});
