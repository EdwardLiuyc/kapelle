/**
 * The daemon's runs (M12-7a): the live and restored records, their
 * cancellers and logs, and the run commands for the HTTP routes, split from
 * `daemon.ts` so their state-ordering rules can be tested without booting a
 * server.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStatus } from "../client/contract.ts";
import { type EventLog, openEventLog } from "../core/eventlog.ts";
import { stateDirFor } from "../core/runtime.ts";
import {
  type RunWriter,
  readRunRecord,
  verifiedRunWriter,
} from "../core/sweep.ts";
import { type RunState, toTaskDto } from "./dto.ts";
import { refusal } from "./http.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Cancel a live run and return the state for the 202 reply. The public
 *  status decides whether it ended; final cleanup may retain the controller.
 *  `RunStatus` has `running` as its only non-terminal value. */
export function cancelRun(
  id: string,
  state: RunState | undefined,
  canceller: AbortController | undefined,
): RunState {
  if (!state) {
    throw refusal(404, "run_not_found", `no run ${id}`);
  }
  if (state.status !== "running") {
    throw refusal(409, "run_ended", `run ${id} already ended: ${state.status}`);
  }
  if (!canceller) {
    throw refusal(409, "run_ended", `run ${id} is not cancellable`);
  }
  canceller.abort("cancel");
  state.cancelRequested = true;
  return state;
}

/** Every run this daemon knows, and what it needs to cancel, wait for and
 *  stream one. */
export function createRuns() {
  const runs = new Map<string, RunState>();
  /** Every run still in flight, so a shutdown can wait for them to settle. */
  const inFlight = new Set<Promise<void>>();
  /** Kept beside the record rather than on it, so a `GET` never serialises one. */
  const cancels = new Map<string, AbortController>();
  /** Settles once `runRun` hands over the log, or with `undefined` when the run
   *  ended without one — a state dir it could not make. A preflight that throws
   *  still has its log (#317). A `GET /events` that arrives first waits here
   *  rather than 404ing a run that exists. */
  const eventLogs = new Map<string, Promise<EventLog | undefined>>();
  /** `events.jsonl` on disk, by run id, for runs restored at boot. Held as a
   *  path rather than an open log: opening one scans the whole file, and most
   *  restored runs are never asked for. */
  const restoredLogs = new Map<string, string>();

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
   * process that is gone, or to a live writer outside this daemon. Neither is
   * listed: this daemon has no run state or canceller for it. The M2-5 sweep
   * ran just before this scan and rewrote dead writers to `killed`; the guard
   * below is for a record the sweep could not write or a live external run.
   */
  function restore(repos: Iterable<string>): void {
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
        // A run that threw before any task ran says why (#317).
        if (typeof record.error === "string") state.error = record.error;
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

  return { runs, inFlight, cancels, eventLogs, restore, restoredLog };
}

/**
 * The live writer of a run this daemon did not start, if there is one.
 *
 * `DELETE /runs/:id` uses this only to refuse with `409 run_not_owned`. The
 * run stays out of `GET /runs` and `kapelle ps`: its record is the live view.
 */
export async function externalLiveWriter(
  repos: Iterable<string>,
  id: string,
): Promise<RunWriter | undefined> {
  for (const root of repos) {
    const path = join(stateDirFor(root), "runs", id, "run.json");
    const record = readRunRecord(path, id);
    if (record?.status !== "running") continue;
    const writer = await verifiedRunWriter(record.writer);
    if (writer) return writer;
  }
  return undefined;
}
