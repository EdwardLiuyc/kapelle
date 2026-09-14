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
  // The whole point of one source: history and live tail are one loop, so a
  // reader that starts mid-write and catches up must hand over from the file
  // to the bell without losing or repeating a line. Lines are large and
  // multi-byte so reads cross 64 KiB chunks mid-character.
  const { log } = await logIn(t);
  const text = "é🙂".repeat(300);
  const TOTAL = 3000;
  const readers: ReturnType<typeof collect>[] = [];
  const cursors: number[] = [];

  for (let i = 1; i <= TOTAL; i++) {
    log.append(chunk(`${i}:${text}`, `t${i % 3}`));
    if (i % 500 === 0) {
      // Uncommitted writes are pending here, so this reader starts on the
      // file and must catch up to the bell while appends keep coming.
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

test("a caught-up reader gets new lines live, and an abort detaches it", async (t) => {
  const { log } = await logIn(t);
  log.append(chunk("a"));
  const stop = new AbortController();
  const r = collect(log, 0, stop.signal);

  for (let i = 0; i < 20 && r.seqs.length < 1; i++) await tick();
  log.append(chunk("b"));
  for (let i = 0; i < 20 && r.seqs.length < 2; i++) await tick();
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
