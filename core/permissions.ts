/**
 * The pending-decision queue — story M2-3, issue #33.
 *
 * `ask` with nobody at a terminal. Each mutating permission request becomes
 * one pending entry that an API client answers, and **a decision nobody
 * answers is denied at the timeout**, so an unattended run never wedges.
 *
 * **First writer wins** (the story's decision): `answer` settles an entry
 * once, and every later answer — a second client, or one that lost to the
 * timer or a cancel — is told `settled` rather than overwriting anything.
 *
 * A cancel denies what it reaches: the run's signal covers the whole run, and
 * `denyTask` covers one task the watchdog's TTL cut while its siblings run —
 * `daemon.ts` calls it when that task ends, because the per-task abort lives
 * inside `core/run.ts` and never leaves it.
 *
 * Every settle path emits `_client_permission_answered` with the entry's id
 * and why it closed (M5-4, #136), and the entry stays readable through `get`.
 * The run's signal names the reason for its abort — `"cancel"` or
 * `"run_end"`, passed to `abort()` by `daemon.ts` — and anything else reads
 * as `cancel`.
 *
 * The queue hands `runRun` a plain `Policy` through `RunOptions.askPolicy`,
 * so neither the pool nor `protocol/` knows it exists. It knows no HTTP
 * either; `daemon.ts` maps its three answers to status codes.
 */

import { randomUUID } from "node:crypto";

import type { Policy } from "../protocol/agent.ts";
import type { PermissionReason, ToolKind } from "../protocol/types.ts";
import type { EventBus } from "./events.ts";
import { READ_ONLY_KINDS } from "./policy.ts";

/** One decision waiting for an answer, as `GET /permissions` lists it. */
export interface PendingDecision {
  id: string;
  runId: string;
  taskId: string;
  kind: ToolKind;
  title: string;
}

/** A decision that has closed, as `GET /permissions/:id` returns it. */
export interface SettledDecision extends PendingDecision {
  allow: boolean;
  reason: PermissionReason;
}

export type AnswerResult = "ok" | "settled" | "unknown";

/** The run signal's reason, when it is one the queue knows. */
const abortReason = (signal: AbortSignal): PermissionReason =>
  signal.reason === "run_end" ? "run_end" : "cancel";

export function createPermissionQueue(timeoutMs: number) {
  const pending = new Map<
    string,
    {
      decision: PendingDecision;
      settle: (allow: boolean, reason: PermissionReason) => void;
    }
  >();
  // ponytail: every settled decision is kept for the daemon's lifetime, so a
  // late answer reads 409 rather than 404 and `get` can still say how it
  // closed. The growth term is `title`: it comes from the harness's
  // `tool_call`, bounded only by `MAX_LINE_LENGTH` (32 MiB), so "a couple
  // of hundred bytes" is the typical entry, not the bound, and a harness that
  // loops on requests grows the map. `daemon.ts` never drops a run from
  // memory either, so both live equally long. Drop them with their run once
  // the daemon evicts runs, or truncate `title` here if a loop shows up.
  const settled = new Map<string, SettledDecision>();

  return {
    /**
     * The `ask` decider for one run. Read-only kinds are approved without a
     * question, exactly as `makeAskPolicy` does. `signal` is the run's cancel:
     * aborting it denies every decision this run still has open, so a
     * cancelled run settles instead of waiting out the timer.
     */
    policyFor(runId: string, bus: EventBus, signal: AbortSignal): Policy {
      return ({ agent, toolCall }) => {
        if (READ_ONLY_KINDS.has(toolCall.kind)) return true;
        if (signal.aborted) return false;
        const id = randomUUID();
        const decision: PendingDecision = {
          id,
          runId,
          taskId: agent,
          kind: toolCall.kind,
          title: toolCall.title,
        };
        return new Promise<boolean>((resolve) => {
          const settle = (allow: boolean, reason: PermissionReason) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            pending.delete(id);
            settled.set(id, { ...decision, allow, reason });
            // ponytail: a `run_end` deny comes after `core/run.ts` has closed
            // the event log, so only `get` records it; unreachable today,
            // since `denyTask` runs at every task's end. M5-5's run-finished
            // event is the hook that would put it in the log.
            bus.emit({
              agent,
              update: {
                sessionUpdate: "_client_permission_answered",
                id,
                allow,
                reason,
              },
            });
            resolve(allow);
          };
          const onAbort = () => settle(false, abortReason(signal));
          const timer = setTimeout(() => settle(false, "timeout"), timeoutMs);
          signal.addEventListener("abort", onAbort, { once: true });
          pending.set(id, { decision, settle });
          // After the entry exists, so a client reacting to the event finds it.
          bus.emit({
            agent,
            update: {
              sessionUpdate: "_client_permission_queued",
              id,
              kind: toolCall.kind,
              title: toolCall.title,
            },
          });
        });
      };
    },

    /** Deny everything one task left open, once that task has ended. */
    denyTask(runId: string, taskId: string): void {
      for (const { decision, settle } of [...pending.values()]) {
        if (decision.runId === runId && decision.taskId === taskId) {
          settle(false, "task_end");
        }
      }
    },

    list(): PendingDecision[] {
      return [...pending.values()].map((p) => p.decision);
    },

    /** One decision, open or closed; `undefined` for an id never issued. */
    get(id: string): PendingDecision | SettledDecision | undefined {
      return pending.get(id)?.decision ?? settled.get(id);
    },

    answer(id: string, allow: boolean): AnswerResult {
      const entry = pending.get(id);
      if (entry) {
        entry.settle(allow, "client");
        return "ok";
      }
      return settled.has(id) ? "settled" : "unknown";
    },
  };
}
