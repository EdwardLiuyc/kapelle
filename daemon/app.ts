/**
 * The daemon's app (M12-7a): every route and the state behind them, made by
 * `createDaemonApp(deps)`. Importing this file starts nothing: no server
 * listens, no flag is read and no signal is caught. `daemon/main.ts` boots a
 * daemon around it, and a test can serve it on port 0 in its own process.
 *
 * **One daemon for all of the operator's repositories** (decided 2026-09-11,
 * #31). A repository is added once (`POST /repos`), and a run names the folder
 * it runs in (`POST /runs {cwd, run}`); a folder outside every added
 * repository is refused. One port, one token, and one place — M4's dashboard
 * — to watch every run. Run state lives in each repository's own workspace
 * under `stateDirFor(root)`, outside the repository.
 *
 * **Transport over `core/`, and nothing more.** It calls `stateDirRoot`,
 * `stateDirFor`, `validateRun`, `runRun`, the permission queue, `findAgents`
 * and the login checks for the installed agents, and for chat rooms
 * `roomAgents` and `openRoom`; worktrees, policy and the harness subprocesses
 * stay behind them. If orchestration grew here, the scheduler would be
 * untestable without a server and the CLI would drift into a second
 * implementation (`docs/STORIES.md`, M2-1).
 *
 * **One route table** (M12-7b): each row is `{ method, pattern, handler }`
 * (`Route` in `daemon/http.ts`). The rows and their handlers live in
 * `daemon/routes/`: `repos.ts`, `runs.ts`, `rooms.ts` and `harnesses.ts`.
 * Only `GET /version` is here, as it has no state. No two rows match the same
 * request, so their order does not matter. No row matching the method and
 * path is `404 no_route`, a wrong method too.
 *
 * **Its state sits in small owners**, each with one job: runs
 * (`daemon/run.ts`), child processes (`daemon/children.ts`), the permission
 * queue, and rooms with their scratch lock (`daemon/rooms.ts`, made by the
 * room routes). A daemon-wide cap on live harnesses, if one is ever wanted
 * (R40), goes here.
 *
 * **The token is not optional, even on 127.0.0.1.** Every account on the
 * machine can reach the loopback address, and a run file is a command line —
 * `cmd`, or any harness under `auto`. `daemon/main.ts` makes it and publishes
 * it; this file only checks its digest.
 *
 * **A `Host` outside loopback is refused before the token is read** (M2-8,
 * #38), which closes DNS rebinding — an attacker page gaining same-origin
 * access to this loopback daemon. The browser half, `?token=` on the SSE
 * endpoint, is retired with the browser dashboard (A3): no story serves a page.
 * Both checks run once, in `route`, before any row is looked at; no row
 * checks either itself.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  API_VERSION,
  CAPABILITIES,
  type ErrorReply,
  type VersionReply,
} from "../client/contract.ts";
import { createPermissionQueue } from "../core/permissions.ts";
import { createChildren } from "./children.ts";
import {
  authorised,
  hostAllowed,
  Refusal,
  type Route,
  refusal,
  send,
} from "./http.ts";
import { harnessRoutes } from "./routes/harnesses.ts";
import { repoRoutes } from "./routes/repos.ts";
import { roomRoutes } from "./routes/rooms.ts";
import { runRoutes } from "./routes/runs.ts";
import { createRuns } from "./run.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** A parse base for `req.url`, which is a path, not a URL. Never fetched;
 *  named as a constant so it is not mistaken for a configurable endpoint. */
const REQUEST_URL_BASE = "http://daemon";

/** What the boot hands the app. */
export interface DaemonDeps {
  /** Every repository root added, restored from `repos.json` (M2-6, #36).
   *  Not re-checked here: a repository that has since moved is refused by
   *  `POST /runs`, which checks membership on use. */
  repos: Iterable<string>;
  /** The token's digest (`digest` in `daemon/http.ts`). */
  expected: Buffer;
  /** `daemon.json`, read before `children.json` is rewritten. */
  daemonFile: string;
  /** Where the live harness pids are recorded for the next boot's sweep. */
  childrenFile: string;
  /** How long an `ask` decision waits before it is denied (M2-3). */
  permissionTimeoutMs: number;
}

/** The app. `server` is made, not listening; `restoreRuns` and
 *  `restoreRooms` run once, before the port opens; `stop` ends it. `routes`
 *  is the live table, for a test that walks it and swaps its handlers for
 *  spies: `route` reads each row at every request. */
export function createDaemonApp(deps: DaemonDeps) {
  const repos = new Set<string>(deps.repos);
  const runs = createRuns();
  const children = createChildren(deps.daemonFile, deps.childrenFile);

  /**
   * Every `ask` decision the daemon is waiting on, across all runs (M2-3, #33).
   * An unanswered one is denied after `--permission-timeout`, so an `ask` run
   * with nobody attached completes instead of hanging.
   */
  const permissions = createPermissionQueue(deps.permissionTimeoutMs);

  /** Set once SIGTERM/SIGINT has begun: no new run, room, check or install
   *  may start. */
  let stopping = false;
  /** Shared live, not copied. `repos` is written only by `POST /repos`
   *  (`daemon/routes/repos.ts`); the other route files take it read-only. */
  const shared = {
    repos,
    children,
    permissions,
    stopping: () => stopping,
  };
  const roomApp = roomRoutes(shared);
  const { rooms } = roomApp;
  const harnessApp = harnessRoutes(shared.stopping);

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/version$/,
      handler: ({ res }) =>
        send(res, 200, {
          apiVersion: API_VERSION,
          capabilities: [...CAPABILITIES],
        } satisfies VersionReply),
    },
    ...repoRoutes(repos),
    ...runRoutes({ ...shared, runs }),
    ...roomApp.routes,
    ...harnessApp.routes,
  ];

  async function route(req: IncomingMessage, res: ServerResponse) {
    // Before the token and every route: a forged, duplicated or missing Host is
    // refused here. requireHostHeader: false lets this guard handle the last.
    if (!hostAllowed(req)) {
      throw refusal(403, "host_not_allowed", "host not allowed");
    }
    if (!authorised(req, deps.expected)) {
      throw refusal(401, "unauthorized", "missing or wrong token");
    }
    const { pathname, searchParams } = new URL(
      req.url ?? "/",
      REQUEST_URL_BASE,
    );
    for (const { method, pattern, handler } of routes) {
      const match = req.method === method && pattern.exec(pathname);
      if (match) {
        return handler({
          req,
          res,
          params: match.slice(1),
          query: searchParams,
        });
      }
    }
    throw refusal(404, "no_route", `no route for ${req.method} ${pathname}`);
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
        // A stream already started (an SSE log, an install): no JSON refusal
        // can follow its headers, and a second `writeHead` would throw here,
        // outside any catch. Cut it, so the client sees the end.
        if (res.headersSent) {
          console.error(`${req.method} ${req.url}: ${messageOf(err)}`);
          res.destroy();
          return;
        }
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

  /**
   * The app's half of a shutdown (M2-4, #34): cancel every run, pause every
   * room, and wait for each to settle. The caller closes the server, removes
   * `daemon.json` and exits (`daemon/main.ts`). An install's npm is killed
   * rather than waited for, and a check's harness is stopped and its
   * temporary folder cleaned up, so a stop leaves neither running. A second
   * call answers at once.
   *
   * **A room is paused, not dismissed** (M6-7a, R42c): its live turns are
   * cancelled, its harnesses stopped and its checkouts kept, and the next boot
   * brings it back. A turn still live after the 2 s grace reads `killed`.
   * A room create or delete still unanswered is waited for too (#316): the
   * create then dismisses its room, and the delete ends with its 204.
   *
   * No kill loop of its own. A cancelled task stops its harness through
   * `core/run.ts` (2 s after the abort), and `AcpAgent.stop()` closes stdin
   * before it ever signals — the only stop that also ends the shell commands a
   * harness started. Waiting on the runs is what waits on their harnesses, and
   * it is also what lets each worktree be released.
   */
  async function stop(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(
      `${signal}: cancelling ${runs.inFlight.size} run(s), then exiting`,
    );
    const harnessesStopped = harnessApp.stop();
    for (const canceller of runs.cancels.values()) canceller.abort("cancel");
    await Promise.all([
      ...runs.inFlight,
      ...rooms.changes(),
      ...rooms.built().map(({ room }) => room.pause()),
      harnessesStopped,
    ]);
  }

  return {
    server,
    /** Read every added repository's finished runs back (M2-6). */
    restoreRuns: () => runs.restore(repos),
    /** The hall, then every added repository's rooms (M6-7a, M11-1). */
    restoreRooms: roomApp.restore,
    stop,
    routes,
  };
}
