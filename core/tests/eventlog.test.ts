/**
 * M2-2, issue #32. The event log against a real file in a temp dir — the
 * subject is what reaches the disk and what a reader gets back from it, which
 * no pure function expresses.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentEventEnvelope } from "../../protocol/agent.ts";
import { createEventLog, type EventLog } from "../eventlog.ts";

async function logIn(t: TestContext): Promise<{ log: EventLog; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kapelle-eventlog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.jsonl");
  const log = createEventLog(path, (err) => {
    throw err;
  });
  return { log, path };
}

/** A chunk of `text`, the event a task sends thousands of. */
const chunk = (text: string, agent = "t0"): AgentEventEnvelope => ({
  agent,
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  },
});

const tick = () => new Promise((ok) => setImmediate(ok));

/** Waits up to `ms` for `ok`, yielding between checks. Counting event-loop
 *  turns is not a time bound — an fs write callback can land many turns later
 *  under load — which made the turn-counted waits flaky. */
async function waitFor(ok: () => boolean, what: string, ms = 5_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await tick();
  }
  assert.ok(ok(), `timed out waiting for ${what}`);
}

/** Everything `follow` sends, in order. */
function collect(log: EventLog, after: number, signal?: AbortSignal) {
  const seqs: number[] = [];
  const lines: string[] = [];
  const done = log.follow(
    after,
    (seq, line) => {
      seqs.push(seq);
      lines.push(line);
    },
    signal,
  );
  return { seqs, lines, done };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

test("every event lands unchanged, one line each, numbered from 1", async (t) => {
  const { log, path } = await logIn(t);
  const withMeta: AgentEventEnvelope = {
    agent: "t1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "b" },
      _meta: { "_claude/rateLimit": { remaining: 3 } },
    },
  };

  log.append(chunk("a"));
  log.append(withMeta);
  await log.close();

  const lines = (await readFile(path, "utf8")).split("\n");
  assert.equal(lines.pop(), "", "the file ends with a newline");
  assert.deepEqual(
    lines.map((l) => JSON.parse(l)),
    [
      { seq: 1, ...chunk("a") },
      { seq: 2, ...withMeta },
    ],
  );
  assert.equal(log.size, 2);
});

test("a reader after the run gets the lines after its cursor, then ends", async (t) => {
  const { log, path } = await logIn(t);
  for (const text of ["a", "b", "c", "d"]) log.append(chunk(text));
  await log.close();

  const all = collect(log, 0);
  await all.done;
  assert.deepEqual(all.seqs, [1, 2, 3, 4]);
  assert.equal(`${all.lines.join("\n")}\n`, await readFile(path, "utf8"));

  const tail = collect(log, 2);
  await tail.done;
  assert.deepEqual(tail.seqs, [3, 4]);

  const none = collect(log, 4);
  await none.done;
  assert.deepEqual(none.seqs, []);
});

test("readers attached while writes are in flight see no gap, duplicate or partial line", async (t) => {
  // The whole point of one source: every reader sees the same contiguous
  // stream. These readers attach at the committed tail, so their lines arrive
  // from the bell while writes are still in flight; lines are large and
  // multi-byte so the final full-replay reader crosses 64 KiB chunks
  // mid-character. The disk-to-bell handover is the next test.
  const { log } = await logIn(t);
  const text = "é🙂".repeat(300);
  const TOTAL = 3000;
  const readers: ReturnType<typeof collect>[] = [];
  const cursors: number[] = [];

  for (let i = 1; i <= TOTAL; i++) {
    log.append(chunk(`${i}:${text}`, `t${i % 3}`));
    if (i % 500 === 0) {
      // At the committed tail (`next = committed + 1`), so this reader is
      // bell-driven while later appends are still uncommitted.
      const after = log.size;
      cursors.push(after);
      readers.push(collect(log, after));
    }
    if (i % 7 === 0) await tick();
  }
  readers.push(collect(log, 0));
  cursors.push(0);
  await log.close();
  await Promise.all(readers.map((r) => r.done));

  readers.forEach((r, i) => {
    const after = cursors[i] as number;
    assert.deepEqual(r.seqs, range(after + 1, TOTAL), `reader after ${after}`);
    r.lines.forEach((line, j) => {
      const parsed = JSON.parse(line);
      assert.equal(parsed.seq, after + 1 + j);
      assert.equal(parsed.update.content.text, `${after + 1 + j}:${text}`);
    });
  });
});

test("a reader behind the tail drains the file, then hands over to the bell", async (t) => {
  // The keystone of the one-source design, made deterministic: a reader that
  // starts behind the committed tail reads those lines from the file, then
  // takes the rest from the writer's notification. The in-flight test above
  // attaches at the tail, so this crossing is the one it cannot reach.
  const { log } = await logIn(t);
  for (const text of ["1", "2", "3"]) log.append(chunk(text));
  await waitFor(() => log.size >= 3, "the prefix to commit");

  const r = collect(log, 2); // next = 3, so the first line must come from disk
  await waitFor(() => r.seqs.length >= 1, "the disk prefix");
  assert.deepEqual(r.seqs, [3], "the committed prefix arrived from the file");

  log.append(chunk("4"));
  await waitFor(() => r.seqs.length >= 2, "the first live line");
  log.append(chunk("5"));
  await log.close();
  await r.done;

  assert.deepEqual(
    r.seqs,
    [3, 4, 5],
    "no gap and no duplicate at the handover",
  );
  r.lines.forEach((line, i) => {
    assert.equal(JSON.parse(line).update.content.text, String(3 + i));
  });
});

test("an abort mid-drain stops the sends, including the rest of the chunk", async (t) => {
  // All three lines are committed before the reader starts, so they arrive in
  // one 64 KiB read. The abort lands in the first `send`; the two lines still
  // buffered in that chunk must not follow it out.
  const { log } = await logIn(t);
  for (const text of ["a", "b", "c"]) log.append(chunk(text));
  await waitFor(() => log.size >= 3, "the lines to commit");

  const stop = new AbortController();
  const seqs: number[] = [];
  const done = log.follow(
    0,
    (seq) => {
      seqs.push(seq);
      stop.abort();
    },
    stop.signal,
  );
  await log.close();
  await done;
  assert.deepEqual(seqs, [1], "nothing is sent after the abort");
});

test("an abort in the bell stops lines committed in the same batch", async (t) => {
  // Appends made in one go are flushed as one write, and their callbacks ring
  // the bell back to back in a single tick — before the reader's own teardown
  // can remove it. Abort on line 3, and lines 4 and 5 of that batch must stay
  // behind (measured 2026-09-14: without the check they were sent).
  const { log } = await logIn(t);
  log.append(chunk("a"));
  const stop = new AbortController();
  const seqs: number[] = [];
  const done = log.follow(
    0,
    (seq) => {
      seqs.push(seq);
      if (seq === 3) stop.abort();
    },
    stop.signal,
  );
  await waitFor(() => seqs.length >= 1, "the first line");

  for (const text of ["b", "c", "d", "e"]) log.append(chunk(text));
  await done;
  await log.close();
  assert.deepEqual(seqs, [1, 2, 3], "nothing is sent after the abort");
});

test("a caught-up reader gets new lines live, and an abort detaches it", async (t) => {
  const { log } = await logIn(t);
  log.append(chunk("a"));
  const stop = new AbortController();
  const r = collect(log, 0, stop.signal);

  await waitFor(() => r.seqs.length >= 1, "the first live line");
  log.append(chunk("b"));
  await waitFor(() => r.seqs.length >= 2, "the second live line");
  assert.deepEqual(r.seqs, [1, 2], "live line arrived before the log closed");

  stop.abort();
  await r.done;
  log.append(chunk("c"));
  await log.close();
  assert.deepEqual(r.seqs, [1, 2], "nothing reaches a reader after its abort");
});

test("a cursor ahead of the log waits for that line, never skipping to fill the gap", async (t) => {
  // `daemon.ts` refuses such a `Last-Event-ID`, but the log must not answer
  // one by sending whatever arrives next under the wrong number.
  const { log } = await logIn(t);
  log.append(chunk("a"));
  const r = collect(log, 3);
  for (const text of ["b", "c", "d", "e"]) log.append(chunk(text));
  await log.close();
  await r.done;
  assert.deepEqual(r.seqs, [4, 5]);
});

test("a log that cannot be written reports once, keeps the run going, and ends readers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kapelle-eventlog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const errors: string[] = [];
  const log = createEventLog(join(dir, "missing", "events.jsonl"), (err) =>
    errors.push(err.message),
  );

  const r = collect(log, 0);
  log.append(chunk("a"));
  await r.done;
  log.append(chunk("b"));
  await log.close();

  assert.equal(errors.length, 1);
  assert.match(errors[0] as string, /ENOENT/);
  assert.deepEqual(r.seqs, []);
  assert.equal(log.size, 0);
});
