/**
 * The event bus — story M1a-6, issue #14.
 *
 * One shared line. `AcpAgent` drops events on it, consumers subscribe. The
 * point is not the fan-out itself (there is one consumer today); it is that
 * adding the next one — `core/notify.ts` (M1c-4), M2's persisted log, M4's
 * SSE stream — is an `addListener` call and no edit to `protocol/agent.ts`.
 * That is the invariant the story calls "what makes M4 purely additive".
 *
 * **Carries the wire object, `_meta` and all** (#62 B4, `docs/STORIES.md`
 * M1a-6). Consumers render *from* the event; nothing renders *into* it. A
 * persisted log can only replay what it recorded, and `session/load` needs a
 * faithful record to replay from.
 *
 * **Supervisor variants widen as their producers land.** The story lists six
 * (task started, worktree created, permission pending, stall warning, task
 * finished, containment warning). Most have no producer in the tree yet; the
 * containment warning stays on stderr at `cli.ts` — moving it onto the bus
 * would route it through a sink `--quiet` switches off, and #13 says that
 * line is never silenced. M1b-4 is the first producer on this side of the
 * client: `core/run.ts` emits `_client_result_warning` for cross-check
 * disagreements, and M1c-1 added `_client_stall_warning`.
 *
 * **M1c-4 was the first story with a real subscriber and it still did not
 * widen the union** — `core/notify.ts` consumes the two `_client_` events
 * above and none of the three supervisor variants. M2-2's persisted log
 * (`core/eventlog.ts`) is the consumer that reads all three, and it widened
 * the union once: `_client_task_started`, `_client_worktree_created` and
 * `_client_task_finished`. M5-5 put `_client_run_finished` on that same log,
 * so it is in the union too.
 *
 * Not `node:events`: `EventEmitter.emit` propagates a listener's throw and
 * skips the listeners behind it, so a broken renderer would take the run down
 * with it. Wrapping every handler to prevent that costs more code than the
 * Set below.
 */

import type { AgentEventEnvelope } from "../protocol/agent.ts";

/** Not exported until something imports it — same rule that kept
 *  `AgentEventEnvelope` internal until this file needed it. */
type BusListener = (event: AgentEventEnvelope) => void;

export interface EventBus {
  addListener(listener: BusListener): void;
  /** Closure-bound, so it can be handed straight to `AcpAgent`'s `onEvent`. */
  emit: BusListener;
}

export function createEventBus(): EventBus {
  const listeners = new Set<BusListener>();

  return {
    // ponytail: no removeListener — nothing detaches today. Return
    // `() => listeners.delete(listener)` when M4's SSE stream subscribes per
    // connection, or each dropped client leaks a listener.
    addListener(listener) {
      listeners.add(listener);
    },

    emit(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          // A consumer that throws is a bug in that consumer, never a reason
          // to lose the run or the events behind it. The error object rather
          // than its message: a listener bug is worth a stack trace.
          // Reason: listener exceptions must be visible; this is the intended reporting point.
          console.error("! event listener threw:", err); // pi-lens-ignore: console-statement
        }
      }
    },
  };
}
