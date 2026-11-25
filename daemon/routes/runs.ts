/**
 * The run routes (M12-7b): `POST` and `GET /runs`, one run, its events and
 * its cancel, and the `ask` decisions of `/permissions`. Only a run puts a
 * decision on that queue (`askPolicy` below); a room takes the queue to
 * answer its own harnesses, and has no route of its own here.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  PendingDecision,
  PermissionAnswered,
  PermissionDecision,
  RunAccepted,
  RunDto,
  RunListEntry,
} from "../../client/contract.ts";
import { readProjectLinkPaths, resolveRunDefaults } from "../../core/config.ts";
import type { EventLog } from "../../core/eventlog.ts";
import { createEventBus } from "../../core/events.ts";
import { newRunId } from "../../core/ids.ts";
import type { createPermissionQueue } from "../../core/permissions.ts";
import { runRun } from "../../core/run.ts";
import { type Run, validateRun } from "../../core/runfile.ts";
import { LinkPathError, validateWorktreeLinks } from "../../core/worktree.ts";
import { AGENTS } from "../../protocol/registry.ts";
import type { createChildren } from "../children.ts";
import { type RunState, toRunDto, toRunListEntry, toTaskDto } from "../dto.ts";
import { existingDir, type Route, readBody, refusal, send } from "../http.ts";
import { createIdempotencyKeys } from "../idempotency.ts";
import { cancelRun, type createRuns, externalLiveWriter } from "../run.ts";
import { streamLog } from "../sse.ts";
import { refuseUnadded } from "./repos.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** What the run routes share with the rest of the app. */
interface RunRouteDeps {
  repos: ReadonlySet<string>;
  runs: ReturnType<typeof createRuns>;
  children: ReturnType<typeof createChildren>;
  permissions: ReturnType<typeof createPermissionQueue>;
  /** True once a shutdown has begun: no new run may start. */
  stopping: () => boolean;
}

export function runRoutes({
  repos,
  runs: { runs, inFlight, cancels, eventLogs, restoredLog },
  children,
  permissions,
  stopping,
}: RunRouteDeps): Route[] {
  const idempotency = createIdempotencyKeys();

  /**
   * `POST /runs`, with an optional `Idempotency-Key` (M5-7, #139): see
   * `daemon/idempotency.ts`.
   */
  async function postRun(req: IncomingMessage, res: ServerResponse) {
    const id = await idempotency.once(
      req,
      () => readBody(req, ["cwd", "run"]),
      startRun,
    );
    send(res, 202, { id } satisfies RunAccepted);
  }

  /** Validate a `POST /runs` body, start the run, and return its id. */
  async function startRun(body: Record<string, unknown>): Promise<string> {
    const cwd = existingDir(body.cwd, "cwd");
    const root = await refuseUnadded(repos, cwd);

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
    let linkPaths: string[];
    try {
      linkPaths = readProjectLinkPaths(root);
    } catch (err) {
      throw refusal(400, "invalid_config", messageOf(err));
    }
    try {
      await validateWorktreeLinks(root, linkPaths);
    } catch (err) {
      if (err instanceof LinkPathError) {
        throw refusal(400, "invalid_config", messageOf(err));
      }
      throw err;
    }

    // No preflight before the 202 any more (#129). It existed to answer the two
    // 409s — an unsafe `.kapelle/`, a dirty tree — that this daemon no longer
    // has, and it cost about ten git spawns per run to repeat what `runRun`
    // does anyway (measured on #107).
    const id = newRunId();

    // After the last await, so no run can start once a shutdown has begun.
    if (stopping()) {
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
    children.track(bus, "run", id);
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
      linkPaths,
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
      // `endedAt` the record carries. `DELETE` relies on this publication
      // preceding final cleanup.
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

  return [
    {
      method: "POST",
      pattern: /^\/runs$/,
      handler: ({ req, res }) => postRun(req, res),
    },
    {
      method: "GET",
      pattern: /^\/runs$/,
      handler: ({ res }) =>
        send(
          res,
          200,
          [...runs.values()].map(toRunListEntry) satisfies RunListEntry[],
        ),
    },
    {
      method: "GET",
      pattern: /^\/runs\/([^/]+)$/,
      handler: ({ res, params: [id] }) => {
        const state = runs.get(id);
        if (!state) throw refusal(404, "run_not_found", `no run ${id}`);
        send(res, 200, toRunDto(state) satisfies RunDto);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/runs\/([^/]+)$/,
      // Asynchronous on purpose: cancel is cooperative, so the answer is an
      // acknowledgement and `GET` reports the verdict. `core/run.ts` stops a
      // harness 2 s after the abort, so no timer is needed here.
      handler: async ({ res, params: [id] }) => {
        const owned = runs.get(id);
        if (!owned) {
          const writer = await externalLiveWriter(repos, id);
          if (writer) {
            throw refusal(
              409,
              "run_not_owned",
              `run ${id} is owned by live process pid ${writer.pid}; stop it ` +
                "where it was started",
            );
          }
        }
        const state = cancelRun(id, owned, cancels.get(id));
        send(res, 202, toRunDto(state) satisfies RunDto);
      },
    },
    {
      method: "GET",
      pattern: /^\/runs\/([^/]+)\/events$/,
      handler: ({ req, res, params: [id] }) => getEvents(id, req, res),
    },
    {
      method: "GET",
      pattern: /^\/permissions$/,
      handler: ({ res }) =>
        send(res, 200, permissions.list() satisfies PendingDecision[]),
    },
    {
      method: "GET",
      pattern: /^\/permissions\/([^/]+)$/,
      handler: ({ res, params: [id] }) => {
        const found = permissions.get(id);
        if (!found) {
          throw refusal(404, "permission_not_found", `no permission ${id}`);
        }
        send(res, 200, found satisfies PermissionDecision);
      },
    },
    {
      method: "POST",
      pattern: /^\/permissions\/([^/]+)$/,
      handler: ({ req, res, params: [id] }) => postPermission(id, req, res),
    },
  ];
}
