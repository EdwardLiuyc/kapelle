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
 * **A room asks through the same queue** (M6-5, S12a). `roomPolicy` hands a
 * participant's turn a `Policy`, and its entries name the room, the
 * participant and the turn instead of a run and a task. A room closes an open
 * decision through the turn's signal, so a room path that is not an answer,
 * the timeout or a mode change reads `cancel`: cancel-turn, removal, a harness
 * that exits and a dismiss (decided 2026-09-28, #149). A mode that leaves
 * `ask` answers what waits as `mode_change` (`answerParticipant`).
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

/** Who asked: a run's task, or a room participant's turn. `turn` counts
 *  the participant's turns from 1, as `_client_user_message` does. */
type Asker =
  | { runId: string; taskId: string }
  | { roomId: string; participantId: string; turn: number };

/** One decision waiting for an answer, as `GET /permissions` lists it. */
export type PendingDecision = Asker & {
  id: string;
  kind: ToolKind;
  title: string;
  input?: Record<string, string>;
};

/** A decision that has closed, as `GET /permissions/:id` returns it. */
export type SettledDecision = PendingDecision & {
  allow: boolean;
  reason: PermissionReason;
};

export type AnswerResult = "ok" | "settled" | "unknown";

/** How much of a tool's input a question carries (M4-3): 8 fields of 64 +
 *  400 characters, and the serialized object at most 4 KB. A harness can send
 *  a whole file as one value, and every question is kept for the daemon's
 *  life. */
const INPUT_FIELDS = 8;
const INPUT_KEY = 64;
const INPUT_VALUE = 400;
const INPUT_JSON_BYTES = 4096;

const cut = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * The tool's input for a person to judge: each value as text, cut. The
 * fields past the eighth are dropped, and a later field is dropped too when
 * its JSON escapes would push the object past 4 KB. `undefined` when there
 * is nothing to show. The text is as the harness sent it; a screen removes
 * control characters before it draws (`client/room.ts`).
 */
export function capInput(
  // The protocol's own shape for raw tool input (`protocol/agent.ts`).
  // pi-lens-ignore: no-unsafe-dictionary-unknown
  raw: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const used = new Set<string>();
  const fields: [string, string][] = Object.entries(raw)
    .filter(([, v]) => v !== undefined)
    .slice(0, INPUT_FIELDS)
    .map(([k, v], i) => {
      // Two long keys can cut to one: the later one gets its place, so no
      // field hides another.
      let key = cut(k, INPUT_KEY);
      if (used.has(key)) key = `${cut(k, INPUT_KEY - 4)}#${i}`;
      used.add(key);
      return [
        key,
        cut(typeof v === "string" ? v : JSON.stringify(v), INPUT_VALUE),
      ];
    });
  // A quote or a control character becomes two or six bytes in JSON, so the
  // character caps alone can still leave a larger object. Drop fields from
  // the end until it fits; the first field always does.
  while (
    fields.length > 0 &&
    Buffer.byteLength(JSON.stringify(Object.fromEntries(fields)), "utf8") >
      INPUT_JSON_BYTES
  ) {
    fields.pop();
  }
  // `fromEntries`, not assignment: a `__proto__` key stays a plain field.
  return fields.length > 0 ? Object.fromEntries(fields) : undefined;
}

/** The run signal's reason, when it is one the queue knows. */
const abortReason = (signal: AbortSignal): PermissionReason =>
  signal.reason === "run_end" ? "run_end" : "cancel";

export type PermissionQueue = ReturnType<typeof createPermissionQueue>;

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
  // closed. The growth term is `title` (`input` is cut): it comes from the harness's
  // `tool_call`, bounded only by `MAX_LINE_LENGTH` (32 MiB), so "a couple
  // of hundred bytes" is the typical entry, not the bound, and a harness that
  // loops on requests grows the map. `daemon.ts` never drops a run or a room
  // from memory either, so all three live equally long; an `ask` room that
  // lives for days is the longest. Drop them with their run or room once the
  // daemon evicts those, or truncate `title` here if a loop shows up.
  const settled = new Map<string, SettledDecision>();

  /**
   * Queues one decision and resolves with the answer. Read-only kinds are
   * approved without a question, exactly as `makeAskPolicy` does. `signal`
   * is the owner's cancel: aborting it denies every decision it still has
   * open, so a cancel settles instead of waiting out the timer. `agent` is
   * the bus's name for the asker: the task id, or the participant id.
   */
  const ask = (
    asker: Asker,
    agent: string,
    bus: EventBus,
    signal: AbortSignal,
    toolCall: {
      kind: ToolKind;
      title: string;
      // pi-lens-ignore: no-unsafe-dictionary-unknown
      rawInput?: Record<string, unknown>;
    },
  ): boolean | Promise<boolean> => {
    if (READ_ONLY_KINDS.has(toolCall.kind)) return true;
    if (signal.aborted) return false;
    const id = randomUUID();
    const input = capInput(toolCall.rawInput);
    const decision: PendingDecision = {
      id,
      ...asker,
      kind: toolCall.kind,
      title: toolCall.title,
      ...(input && { input }),
    };
    return new Promise<boolean>((resolve) => {
      const settle = (allow: boolean, reason: PermissionReason) => {
        // Once only, whoever calls: an answer, the timer, an abort, the end
        // of a task or a mode change.
        if (!pending.has(id)) return;
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
          ...(input && { input }),
        },
      });
    });
  };

  return {
    /** The `ask` decider for one run. `signal` is the run's cancel. */
    policyFor(runId: string, bus: EventBus, signal: AbortSignal): Policy {
      return ({ agent, toolCall }) =>
        ask({ runId, taskId: agent }, agent, bus, signal, toolCall);
    },

    /** The `ask` decider for one participant's turn. `signal` is the turn's:
     *  the room aborts it when the turn ends for any reason. */
    roomPolicy(
      asker: { roomId: string; participantId: string; turn: number },
      bus: EventBus,
      signal: AbortSignal,
    ): Policy {
      return ({ toolCall }) =>
        ask(asker, asker.participantId, bus, signal, toolCall);
    },

    /** Deny everything one task left open, once that task has ended. */
    denyTask(runId: string, taskId: string): void {
      for (const { decision, settle } of [...pending.values()]) {
        if (
          "runId" in decision &&
          decision.runId === runId &&
          decision.taskId === taskId
        ) {
          settle(false, "task_end");
        }
      }
    },

    /** Answers everything one room participant has open: its mode left
     *  `ask`, so `auto` allows and `safe` denies (decided 2026-09-29, #194). */
    answerParticipant(
      roomId: string,
      participantId: string,
      allow: boolean,
    ): void {
      for (const { decision, settle } of [...pending.values()]) {
        if (
          "roomId" in decision &&
          decision.roomId === roomId &&
          decision.participantId === participantId
        ) {
          settle(allow, "mode_change");
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
