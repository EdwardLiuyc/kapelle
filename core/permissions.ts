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
 * The queue hands `runRun` a plain `Policy` through `RunOptions.askPolicy`,
 * so neither the pool nor `protocol/` knows it exists. It knows no HTTP
 * either; `daemon.ts` maps its three answers to status codes.
 */

import { randomUUID } from "node:crypto";

import type { Policy } from "../protocol/agent.ts";
import type { ToolKind } from "../protocol/types.ts";
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

export type AnswerResult = "ok" | "settled" | "unknown";

export function createPermissionQueue(timeoutMs: number) {
  const pending = new Map<
    string,
    { decision: PendingDecision; settle: (allow: boolean) => void }
  >();
  // ponytail: every settled id is kept for the daemon's lifetime, so a late
  // answer reads 409 rather than 404; a few dozen bytes each. Drop them with
  // their run once M2-6 gives runs a lifetime.
  const settled = new Set<string>();

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
        return new Promise<boolean>((resolve) => {
          const settle = (allow: boolean) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", deny);
            pending.delete(id);
            settled.add(id);
            resolve(allow);
          };
          const deny = () => settle(false);
          const timer = setTimeout(deny, timeoutMs);
          signal.addEventListener("abort", deny, { once: true });
          pending.set(id, {
            decision: {
              id,
              runId,
              taskId: agent,
              kind: toolCall.kind,
              title: toolCall.title,
            },
            settle,
          });
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

    list(): PendingDecision[] {
      return [...pending.values()].map((p) => p.decision);
    },

    answer(id: string, allow: boolean): AnswerResult {
      const entry = pending.get(id);
      if (entry) {
        entry.settle(allow);
        return "ok";
      }
      return settled.has(id) ? "settled" : "unknown";
    },
  };
}
