/**
 * The reconnecting reader — `client/stream.ts`, story M5-6 (#138).
 *
 * `connect` is faked with bodies built here, so each kind of cut is one line
 * to stage: a body that errors, a body that goes quiet, a refused connect.
 * `tests/attach.test.ts` proves the same reader against a daemon that is
 * killed and started again.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { EventLine } from "../contract.ts";
import { type Connect, followEvents, StreamClosed } from "../stream.ts";

const frame = (seq: number) =>
  `id: ${seq}\ndata: ${JSON.stringify({
    seq,
    agent: "t0",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${seq}` },
    },
  })}\n\n`;

/** A body that sends `seqs`, then ends — or errors, or goes quiet. */
function body(seqs: number[], then: "end" | "error" | "quiet" = "end") {
  const bytes = new TextEncoder();
  let i = 0;
  // `pull`, not `start`: a stream that errors in `start` drops the chunks it
  // queued, and a real socket delivers its bytes before it fails.
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const seq = seqs[i++];
      if (seq !== undefined) c.enqueue(bytes.encode(frame(seq)));
      else if (then === "end") c.close();
      else if (then === "error") c.error(new Error("socket hang up"));
    },
  });
}

/** A `connect` that answers each try with the next of `replies`, and
 *  records the cursor each try sent. */
function script(replies: (() => Response | undefined)[]) {
  const afters: number[] = [];
  const connect: Connect = async (after) => {
    afters.push(after);
    const reply = replies.shift();
    if (!reply) throw new Error("no more replies");
    return reply();
  };
  return { connect, afters };
}

async function all(events: AsyncGenerator<EventLine>): Promise<number[]> {
  const seqs: number[] = [];
  for await (const event of events) seqs.push(event.seq);
  return seqs;
}

test("a cut body reconnects from the last seq and drops what it already passed on", async () => {
  const { connect, afters } = script([
    () => new Response(body([1, 2], "error")),
    // The daemon replays from after 2, but a repeat must still be dropped.
    () => new Response(body([2, 3])),
  ]);
  const retries: unknown[] = [];
  const seqs = await all(
    followEvents(connect, { onRetry: (err) => retries.push(err) }),
  );
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.deepEqual(afters, [0, 2]);
  assert.equal(retries.length, 1);
});

test("a connect that is accepted, then cut with no data, still backs off", async () => {
  // A daemon can answer 200 and then destroy the stream, for example when the
  // event file is gone. The wait must still grow, or the retry loop spins.
  const { connect } = script([
    () => new Response(body([], "error")),
    () => new Response(body([], "error")),
    () => new Response(body([], "error")),
    () => new Response(body([1])),
  ]);
  const started = Date.now();
  assert.deepEqual(await all(followEvents(connect)), [1]);
  // 250 + 500 + 1000 ms. Without the growth it is 3 × 250 ms.
  assert.ok(Date.now() - started >= 1_500, `took ${Date.now() - started} ms`);
});

test("a refused connect is tried again", async () => {
  const { connect, afters } = script([
    () => {
      throw new TypeError("fetch failed");
    },
    () => new Response(body([1])),
  ]);
  assert.deepEqual(await all(followEvents(connect)), [1]);
  assert.deepEqual(afters, [0, 0]);
});

test("a body with no bytes for silenceMs counts as cut", async () => {
  const { connect, afters } = script([
    () => new Response(body([1], "quiet")),
    () => new Response(body([2])),
  ]);
  const retries: unknown[] = [];
  const seqs = await all(
    followEvents(connect, {
      silenceMs: 50,
      onRetry: (err) => retries.push(err),
    }),
  );
  assert.deepEqual(seqs, [1, 2]);
  assert.deepEqual(afters, [0, 1]);
  assert.match(String(retries[0]), /no data for/);
});

test("no daemon to wait for, or a refusal, stops the reader for good", async () => {
  const gone = script([() => undefined]);
  await assert.rejects(all(followEvents(gone.connect)), StreamClosed);

  const refused = script([
    () =>
      Response.json(
        { error: { code: "run_not_found", message: "no run r1" } },
        { status: 404 },
      ),
  ]);
  await assert.rejects(all(followEvents(refused.connect)), (err: Error) => {
    assert.ok(err instanceof StreamClosed);
    assert.equal(err.message, "no run r1");
    return true;
  });
  assert.deepEqual(refused.afters, [0], "a refusal is not tried again");
});
