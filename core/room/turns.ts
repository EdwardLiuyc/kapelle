/**
 * One participant's turns (M12-8b): the live turn, the queue behind it, and
 * the fast-forward hold. The turn itself, its prompt and its answer, is the
 * participant's (`core/room/participant.ts`); this file only decides when
 * one starts.
 *
 * A prompt *during* a live turn is still refused, here as `busy` and below
 * as `AcpAgent`'s in-flight guard (`protocol/agent.ts`, #62 R5).
 *
 * **A message names its participant, and a busy one queues it** (M6-4).
 * `send` starts a turn, or puts the message in a FIFO queue behind the live
 * one (R32a); `QUEUE_BOUND` messages wait at most, and the next is refused
 * `queue_full` (R41).
 * The queue is in memory only, so a daemon restart loses it. `cancel` drops
 * the queue, then cancels the live turn; the session stays (S5a). A dropped
 * message is never sent, and `_client_queue_cleared` says how many. A
 * message may name the participant that sent it (M8-1); the harness then
 * reads `[from <name>]` first, and the log records the sender's id.
 *
 * **A fast-forward counts as busy** (M6-11a), so a message sent during it
 * queues behind it.
 */

import type { MessageKind } from "../../protocol/types.ts";
import type { EventBus } from "../events.ts";
import { QUEUE_BOUND, RoomRefusal, type Sender } from "./types.ts";

/** A message as a turn takes it. */
export interface Message {
  text: string;
  from?: Sender;
  kind?: MessageKind;
}

/** The turns of one participant. */
export interface Turns {
  /** The live turn, from its start to its end, checkout read included. */
  readonly live: Promise<void> | undefined;
  /** A live turn or a fast-forward: a message waits behind it. */
  busy(): boolean;
  readonly queued: number;
  /** Starts the message's turn, or queues it behind the live one. */
  send(message: Message): Promise<void>;
  /** Drops every waiting message. Each one's `send` resolves. */
  drop(): void;
  /** Marks `work` as busy until it settles. The caller has checked the
   *  participant is idle, with no await since. */
  hold<T>(work: Promise<T>): Promise<T>;
  /** Resolves once the live turn, then a hold, have ended. */
  settled(): Promise<void>;
}

export function createTurns({
  id,
  bus,
  begin,
  closed,
}: {
  id: string;
  bus: EventBus;
  /** Starts one turn. Its last step calls `ended`, so the next one can
   *  start. */
  begin: (message: Message, ended: () => void) => Promise<void>;
  /** True when no queued message may start: the harness is gone, or the
   *  participant or its room is stopping. */
  closed: () => boolean;
}): Turns {
  let live: Promise<void> | undefined;
  /** A fast-forward of this checkout (M6-11a). It counts as busy, so a
   *  message queues behind it rather than start a turn on moving files. */
  let held: Promise<unknown> | undefined;
  const waiting: (Message & { done: () => void })[] = [];

  const start = (message: Message) => {
    const turn = begin(message, () => {
      live = undefined;
      next();
    });
    live = turn;
    return turn;
  };

  // Never sent, so each waiting `send` resolves here.
  const drop = () => {
    if (waiting.length === 0) return;
    const dropped = waiting.splice(0);
    bus.emit({
      agent: id,
      update: { sessionUpdate: "_client_queue_cleared", count: dropped.length },
    });
    for (const { done } of dropped) done();
  };

  // A harness that is gone takes its queue with it. The harness reports its
  // exit before the prompt fails (`protocol/agent.ts`). The next message
  // revives it; a queued one does not, on purpose: it was written before
  // the stop, and the revive may be fresh, with none of that context, or a
  // load that remembers less than the files show (§M0-9). The person who
  // sends it again knows which. `_client_queue_cleared` tells them to.
  const next = () => {
    if (closed()) return drop();
    const queued = waiting.shift();
    if (queued) {
      const { done, ...message } = queued;
      void start(message).then(done);
    }
  };

  const busy = () => live !== undefined || held !== undefined;

  return {
    get live() {
      return live;
    },
    busy,
    get queued() {
      return waiting.length;
    },
    send(message) {
      if (!busy()) return start(message);
      // A reply or a copy is never refused (M8-2): a dropped one would leave
      // the loop waiting on nothing. Each comes from one finished turn.
      const { text, from, kind } = message;
      if (!kind && waiting.length >= QUEUE_BOUND) {
        throw new RoomRefusal(
          "queue_full",
          `${QUEUE_BOUND} messages already wait for this agent; ` +
            "wait for them to run, or cancel its live prompt to drop them",
        );
      }
      bus.emit({
        agent: id,
        update: {
          sessionUpdate: "_client_message_queued",
          text,
          ...(from && { from: from.id }),
          ...(kind && { kind }),
        },
      });
      return new Promise<void>((done) =>
        waiting.push({ text, from, kind, done }),
      );
    },
    drop,
    // The caller gets the work's own result; `held` only marks the time.
    hold(work) {
      const release = () => {
        held = undefined;
        next();
      };
      held = work.then(release, release);
      return work;
    },
    async settled() {
      await live;
      await held;
    },
  };
}
