/**
 * Every live harness, by pid (M2-4, #34), mirrored to `children.json` beside
 * `daemon.json` for M2-5's sweep to read after a crash. Split from
 * `daemon.ts` (M12-7a), so the app owns the map and the boot owns nothing.
 *
 * A crash is covered without it: every measured harness exits when its stdin
 * closes, and the kernel closes that pipe when the daemon dies. The file is
 * the record for a harness build that does not. Removed once nothing is live,
 * so a file that is there after a daemon died names only what was running.
 *
 * Each entry carries the process's start time (M2-5): the sweep signals a pid
 * only when `ps` still reports the same start, so a reused pid is left alone.
 *
 * A replacement daemon can claim the runtime while this one shuts down. Once
 * either record names another process, leave both files alone: they are the
 * replacement's recovery state, not this daemon's to rewrite or delete. This
 * can leave our old children file behind; the boot sweep checks each pid's
 * start time before signalling, so a dead or recycled pid is left alone.
 */

import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { createEventBus } from "../core/events.ts";
import { processIdentity } from "../core/sweep.ts";
import { readDaemonRecord } from "./record.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

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

/** `daemonFile` is `daemon.json`, read to tell whether this process still
 *  owns the runtime; `childrenFile` is the record this owner writes. */
export function createChildren(daemonFile: string, childrenFile: string) {
  const children = new Map<number, Child>();

  function recordChildren(): void {
    try {
      const daemonRecord = readDaemonRecord(daemonFile);
      if (
        daemonRecord.state === "readable" &&
        daemonRecord.record.pid !== process.pid
      ) {
        return;
      }
      const childrenRecord = readDaemonRecord(childrenFile);
      if (
        childrenRecord.state === "readable" &&
        childrenRecord.record.pid !== process.pid
      ) {
        return;
      }
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
   * Mirrors a bus's harness pids into `children.json` for the next boot's
   * sweep (M2-4, #34). One listener for both owners: `kind` tells a run from
   * a room, `ownerId` is the run or room id and `unitId` the task or
   * participant (S14).
   */
  function track(
    bus: ReturnType<typeof createEventBus>,
    kind: Child["kind"],
    ownerId: string,
  ) {
    bus.addListener(({ agent, update }) => {
      if (update.sessionUpdate === "_client_harness_spawned") {
        // The start time is the sweep's proof that a surviving pid is still
        // this harness and not a recycled pid (M2-5). `undefined` when `ps`
        // cannot answer before the harness exits: the sweep then leaves the
        // pid alone rather than signal a stranger.
        const entry: Child = { pid: update.pid, kind, ownerId, unitId: agent };
        children.set(update.pid, entry);
        recordChildren();
        // Filled in after the fact, never inline: `processIdentity` shells
        // out to `ps`, and doing that synchronously here would stall every
        // other run's SSE writes and permission answers on each harness
        // spawn. The entry is filled in after the fact, so a crash inside
        // that window is the known no-identity outcome: the next boot cannot
        // safely signal the pid and can only name it in a notice, leaving it
        // alive. Conservative, not a free window; `_client_harness_exited`
        // still drops the entry when the harness exits normally.
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

  return { track };
}
