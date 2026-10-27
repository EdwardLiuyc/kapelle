/**
 * M2-2, issue #32. The event log against a real file in a temp dir — the
 * subject is what reaches the disk and what a reader gets back from it, which
 * no pure function expresses.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { crc32 } from "node:zlib";
import type { AgentEventEnvelope } from "../../protocol/agent.ts";
import {
  createEventLog,
  type EventLog,
  openEventLog,
  reopenEventLog,
} from "../eventlog.ts";

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

const indexPath = (path: string) => path.replace(/\.jsonl$/, ".idx");
const INDEX_VERSION = 3;
const INDEX_HEADER_BYTES = 16;
const INDEX_END_BYTES = 8;
const INDEX_CHUNK_HEADER_BYTES = 8;
const INDEX_CHUNK_CRC_BYTES = 4;
const INDEX_CHUNK_OVERHEAD_BYTES =
  INDEX_CHUNK_HEADER_BYTES + INDEX_CHUNK_CRC_BYTES;
const INDEX_CHUNK_ENTRIES = 256;
const indexSize = (lines: number) =>
  INDEX_HEADER_BYTES +
  lines * INDEX_END_BYTES +
  Math.ceil(lines / INDEX_CHUNK_ENTRIES) * INDEX_CHUNK_OVERHEAD_BYTES;

function v3Header(): Buffer {
  const header = Buffer.alloc(INDEX_HEADER_BYTES);
  header.write("KIDX", 0, "ascii");
  header.writeUInt16LE(INDEX_VERSION, 4);
  header.writeUInt16LE(INDEX_HEADER_BYTES, 6);
  header.writeUInt32LE(INDEX_CHUNK_ENTRIES, 8);
  return header;
}

function v3Chunk(ends: number[], from: number, to: number): Buffer {
  const count = to - from;
  const checksumAt = INDEX_CHUNK_HEADER_BYTES + count * INDEX_END_BYTES;
  const chunk = Buffer.alloc(checksumAt + INDEX_CHUNK_CRC_BYTES);
  chunk.write("KCHK", 0, "ascii");
  chunk.writeUInt32LE(count, 4);
  for (let i = 0; i < count; i++) {
    chunk.writeDoubleLE(ends[from + i] as number, 8 + i * INDEX_END_BYTES);
  }
  chunk.writeUInt32LE(crc32(chunk.subarray(0, checksumAt)), checksumAt);
  return chunk;
}

/** Builds a structurally valid v3 sidecar, even when `ends` claims the wrong
 *  line boundaries. */
function v3Index(ends: number[]): Buffer {
  const chunks = [v3Header()];
  for (let from = 0; from < ends.length; from += INDEX_CHUNK_ENTRIES) {
    chunks.push(
      v3Chunk(ends, from, Math.min(from + INDEX_CHUNK_ENTRIES, ends.length)),
    );
  }
  return Buffer.concat(chunks);
}

/** Parses every whole v3 chunk and returns the count it indexes. */
function v3LineCount(data: Buffer): number {
  assert.equal(data.subarray(0, 4).toString("ascii"), "KIDX");
  assert.equal(data.readUInt16LE(4), INDEX_VERSION);
  let count = 0;
  for (
    let pos = INDEX_HEADER_BYTES;
    pos + INDEX_CHUNK_OVERHEAD_BYTES <= data.length;
  ) {
    assert.equal(data.subarray(pos, pos + 4).toString("ascii"), "KCHK");
    const chunkCount = data.readUInt32LE(pos + 4);
    const checksumAt =
      pos + INDEX_CHUNK_HEADER_BYTES + chunkCount * INDEX_END_BYTES;
    assert.equal(
      crc32(data.subarray(pos, checksumAt)),
      data.readUInt32LE(checksumAt),
    );
    count += chunkCount;
    pos = checksumAt + INDEX_CHUNK_CRC_BYTES;
  }
  return count;
}

/** Every complete v3 end offset, in order. */
function v3Ends(data: Buffer): number[] {
  assert.equal(data.subarray(0, 4).toString("ascii"), "KIDX");
  assert.equal(data.readUInt16LE(4), INDEX_VERSION);
  const ends: number[] = [];
  for (
    let pos = INDEX_HEADER_BYTES;
    pos + INDEX_CHUNK_OVERHEAD_BYTES <= data.length;
  ) {
    assert.equal(data.subarray(pos, pos + 4).toString("ascii"), "KCHK");
    const count = data.readUInt32LE(pos + 4);
    const checksumAt = pos + INDEX_CHUNK_HEADER_BYTES + count * INDEX_END_BYTES;
    assert.equal(
      crc32(data.subarray(pos, checksumAt)),
      data.readUInt32LE(checksumAt),
    );
    for (let i = 0; i < count; i++) {
      ends.push(
        data.readDoubleLE(pos + INDEX_CHUNK_HEADER_BYTES + i * INDEX_END_BYTES),
      );
    }
    pos = checksumAt + INDEX_CHUNK_CRC_BYTES;
  }
  return ends;
}

/** A complete v2 sidecar from the previous format. */
function v2Index(ends: number[]): Buffer {
  const trailerOffset = INDEX_HEADER_BYTES + ends.length * INDEX_END_BYTES;
  const trailerFixed = 24;
  const checksumBytes = 32;
  const data = Buffer.alloc(trailerOffset + trailerFixed + checksumBytes);
  data.write("KIDX", 0, "ascii");
  data.writeUInt16LE(2, 4);
  data.writeUInt16LE(INDEX_HEADER_BYTES, 6);
  data.writeUInt32LE(ends.length, 8);
  ends.forEach((end, i) => {
    data.writeDoubleLE(end, INDEX_HEADER_BYTES + i * INDEX_END_BYTES);
  });
  // The old format's trailer magic is intentional, not a typo.
  // pi-lens-ignore: typos:unknown
  data.write("KEND", trailerOffset, "ascii");
  data.writeUInt32LE(ends.length, trailerOffset + 4);
  data.writeDoubleLE(ends[0] ?? 0, trailerOffset + 8);
  data.writeDoubleLE(
    ends.length > 1 ? (ends[ends.length - 2] as number) : 0,
    trailerOffset + 16,
  );
  // The v2 trailer carried SHA-256, so this is a genuinely valid old file.
  // A v3 reader must reject it by version before it looks at the trailer.
  createHash("sha256")
    .update(data.subarray(0, trailerOffset + trailerFixed))
    .digest()
    .copy(data, trailerOffset + trailerFixed);
  return data;
}

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

async function waitForAsync(
  ok: () => Promise<boolean>,
  what: string,
  ms = 5_000,
) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await ok()) return;
    await tick();
  }
  assert.ok(await ok(), `timed out waiting for ${what}`);
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

  const before = Date.now();
  log.append(chunk("a"));
  log.append(withMeta);
  const after = Date.now();
  await log.close();

  const lines = (await readFile(path, "utf8")).split("\n");
  assert.equal(lines.pop(), "", "the file ends with a newline");
  const parsed = lines.map((l) => JSON.parse(l));
  // M5-5 (C6): `at` is the ISO time the line was appended. The window proves
  // it is a write clock — a pinned `new Date(0)` passes the ISO round-trip but
  // fails this — without pinning serialization key order, which the contract
  // does not require.
  for (const line of parsed) {
    assert.equal(new Date(line.at).toISOString(), line.at);
    assert.ok(
      before <= Date.parse(line.at) && Date.parse(line.at) <= after,
      `at ${line.at} is inside the append window`,
    );
    delete line.at;
  }
  assert.deepEqual(parsed, [
    { seq: 1, ...chunk("a") },
    { seq: 2, ...withMeta },
  ]);
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

test("size counts committed lines, not appended ones", async (t) => {
  // daemon.ts bounds Last-Event-ID by log.size, so a size that counted
  // `appended` would let a client resume past lines that are not replayable
  // yet and skip them silently.
  const { log } = await logIn(t);
  log.append(chunk("a"));
  log.append(chunk("b"));
  assert.equal(log.size, 0, "no write callback has run yet");
  await waitFor(() => log.size >= 2, "both lines to commit");
  assert.equal(log.size, 2);
});

test("close is idempotent, and an append after close changes nothing", async (t) => {
  const { log, path } = await logIn(t);
  log.append(chunk("a"));
  log.append(chunk("b"));
  await log.close();
  await log.close(); // no throw, no second flush
  log.append(chunk("c"));

  assert.equal(log.size, 2);
  const texts = (await readFile(path, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line).update.content.text);
  assert.deepEqual(texts, ["a", "b"]);
});

test("a reader joining while close flushes still sees every line once", async (t) => {
  // `close()` sets `accepting` false before `out.end()`, so a reader that
  // arrives during the flush cannot rely on the `while (next <= committed)`
  // loop alone: the flush's write callbacks are what ring it.
  const { log } = await logIn(t);
  const TOTAL = 20;
  for (let i = 1; i <= TOTAL; i++) log.append(chunk(String(i)));

  const closing = log.close();
  const r = collect(log, 0);
  await closing;
  await r.done;
  assert.deepEqual(r.seqs, range(1, TOTAL));
});

test("a non-zero cursor resumes on the byte offset after multi-byte lines", async (t) => {
  // `starts` is byte offsets; a character-count regression would start the
  // disk read inside a previous line and duplicate or corrupt seq 2.
  const { log } = await logIn(t);
  const texts = ["é🙂 first", "é🙂 second", "é🙂 third"];
  for (const text of texts) log.append(chunk(text));
  await waitFor(() => log.size >= 3, "the multi-byte lines to commit");

  const r = collect(log, 1);
  await log.close();
  await r.done;
  assert.deepEqual(r.seqs, [2, 3]);
  assert.deepEqual(
    r.lines.map((line) => JSON.parse(line).update.content.text),
    texts.slice(1),
  );
});

test("a line larger than one 64 KiB chunk survives a mid-read commit", async (t) => {
  // Line 1 is short and line 2 is huge, so line 1 is dispatched while line 2
  // is still being read from disk. The third line appended from inside line
  // 1's `send` therefore commits while the reader is behind: `next` is 2, the
  // bell must ignore seq 3, and the disk must hand it over exactly once later.
  const { log } = await logIn(t);
  const big = "é🙂".repeat(200_000); // ~1.2 MB, several 64 KiB reads
  log.append(chunk("first"));
  log.append(chunk(big));
  await waitFor(() => log.size >= 2, "the two-line prefix to commit");

  const seqs: number[] = [];
  const lines: string[] = [];
  const done = log.follow(0, (seq, line) => {
    seqs.push(seq);
    lines.push(line);
    if (seq === 1) log.append(chunk("after"));
  });
  await waitFor(() => seqs.length >= 3, "the appended line");
  await log.close();
  await done;

  assert.deepEqual(seqs, [1, 2, 3]);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).update.content.text),
    ["first", big, "after"],
  );
});

// --- a full reader pauses (M5-6, #138) --------------------------------------

/** A reader that reports "full" after every send while `blocked`, the way a
 *  socket does once `write` returns false. `open()` is its `drain`. */
function slowReader(log: EventLog, after: number) {
  const seqs: number[] = [];
  let blocked = true;
  let drain = () => {};
  const done = log.follow(after, (seq) => {
    seqs.push(seq);
    if (!blocked) return undefined;
    return new Promise<void>((ok) => {
      drain = ok;
    });
  });
  const open = () => {
    blocked = false;
    drain();
  };
  return { seqs, done, open };
}

test("a full reader gets nothing more, the rest of its chunk included, until it drains", async (t) => {
  const { log } = await logIn(t);
  for (const text of ["a", "b", "c"]) log.append(chunk(text));
  await waitFor(() => log.size >= 3, "the lines to commit");

  const r = slowReader(log, 0);
  await waitFor(() => r.seqs.length >= 1, "the first line");
  // Live lines too: the bell must stay quiet for a full reader.
  for (const text of ["d", "e"]) log.append(chunk(text));
  await waitFor(() => log.size >= 5, "the live lines to commit");
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(r.seqs, [1], "one send, then the reader waits");

  r.open();
  log.append(chunk("f"));
  await log.close();
  await r.done;
  assert.deepEqual(r.seqs, range(1, 6), "no gap and no repeat after the pause");
});

test("a caught-up reader that fills on a live line catches up from the file", async (t) => {
  const { log } = await logIn(t);
  log.append(chunk("a"));
  await waitFor(() => log.size >= 1, "the first line to commit");
  const r = slowReader(log, 1); // caught up: the next line comes from the bell
  log.append(chunk("b"));
  await waitFor(() => r.seqs.length >= 1, "the live line");
  for (const text of ["c", "d"]) log.append(chunk(text));
  await waitFor(() => log.size >= 4, "the missed lines to commit");
  assert.deepEqual(r.seqs, [2]);

  r.open();
  await waitFor(() => r.seqs.length >= 3, "the missed lines, from the file");
  await log.close();
  await r.done;
  assert.deepEqual(r.seqs, [2, 3, 4]);
});

test("an abort ends a reader that waits on a full socket", async (t) => {
  const { log } = await logIn(t);
  log.append(chunk("a"));
  const stop = new AbortController();
  const done = log.follow(0, () => new Promise<void>(() => {}), stop.signal);
  await waitFor(() => log.size >= 1, "the line to commit");
  stop.abort();
  await done;
  await log.close();
});

test("a settled live pause leaves no abort listener behind", async (t) => {
  const { log } = await logIn(t);
  log.append(chunk("a"));
  await waitFor(() => log.size >= 1, "the first line to commit");

  const stop = new AbortController();
  let release = () => {};
  const seqs: number[] = [];
  const done = log.follow(
    0,
    (seq) => {
      seqs.push(seq);
      return new Promise<void>((ok) => {
        release = ok;
      });
    },
    stop.signal,
  );

  // Each round lets one send through and fills the reader again. A listener
  // that outlives its wait is the leak this pins: the count must not grow
  // with the number of settled pauses.
  for (let round = 1; round <= 20; round++) {
    await waitFor(() => seqs.length >= round, `send ${round}`);
    assert.ok(
      getEventListeners(stop.signal, "abort").length <= 1,
      `one outstanding wait at most, after ${round - 1} settled pauses`,
    );
    release();
    log.append(chunk(`x${round}`));
  }

  // The last send is still parked; the abort must end it and leave nothing.
  stop.abort();
  await done;
  assert.equal(getEventListeners(stop.signal, "abort").length, 0);
  await log.close();
});

test("a reader parked again after many pauses still ends when the log closes", async (t) => {
  // The park waits on `wake` alone, never on `ended`, so `close` must wake it.
  // Each park makes a new `wake`; `close` must reach the latest one.
  const { log } = await logIn(t);
  let release = () => {};
  const seqs: number[] = [];
  const done = log.follow(0, (seq) => {
    seqs.push(seq);
    return new Promise<void>((ok) => {
      release = ok;
    });
  });
  for (let round = 1; round <= 20; round++) {
    log.append(chunk(`x${round}`));
    await waitFor(() => seqs.length >= round, `send ${round}`);
    release();
  }
  await log.close();
  await done;
  assert.deepEqual(seqs, range(1, 20));
});

test("a settled replay pause leaves no abort listener behind", async (t) => {
  const { log, path } = await logIn(t);
  for (const text of ["a", "b", "c", "d"]) log.append(chunk(text));
  await log.close();

  const replay = await openEventLog(path);
  const stop = new AbortController();
  let release = () => {};
  const seqs: number[] = [];
  const done = replay.follow(
    0,
    (seq) => {
      seqs.push(seq);
      return new Promise<void>((ok) => {
        release = ok;
      });
    },
    stop.signal,
  );

  for (let round = 1; round <= 4; round++) {
    await waitFor(() => seqs.length >= round, `replay send ${round}`);
    assert.ok(
      getEventListeners(stop.signal, "abort").length <= 1,
      `one outstanding wait at most, after ${round - 1} settled replay pauses`,
    );
    release();
  }
  await done;
  assert.equal(getEventListeners(stop.signal, "abort").length, 0);
  stop.abort();
});

// --- replay after a restart (M2-6, #36) -------------------------------------

test("a log on disk replays without a writer, and the file survives it", async (t) => {
  const { log, path } = await logIn(t);
  log.append(chunk("first"));
  log.append(chunk("second"));
  log.append(chunk("third"));
  await log.close();
  const onDisk = await readFile(path, "utf8");

  const replay = await openEventLog(path);
  assert.equal(replay.size, 3);
  const { seqs, lines, done } = collect(replay, 1);
  // No park at the end: a finished run's reader is caught up for good, so
  // this resolves on its own rather than waiting for a close that never comes.
  await done;
  assert.deepEqual(seqs, [2, 3]);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).update.content.text),
    ["second", "third"],
  );

  // The whole point of the read-only open: a new `createEventLog` uses
  // `flags: "w"`, which would have emptied the file this just replayed.
  assert.equal(await readFile(path, "utf8"), onDisk);
});

test("a half-written last line is not replayed, the way it was never committed", async (t) => {
  const { log, path } = await logIn(t);
  log.append(chunk("whole"));
  await log.close();
  // What a `kill -9` mid-write leaves behind.
  await writeFile(path, `${await readFile(path, "utf8")}{"seq":2,"agen`);

  const replay = await openEventLog(path);
  assert.equal(replay.size, 1);
  const { seqs, done } = collect(replay, 0);
  await done;
  assert.deepEqual(seqs, [1]);
});

test("a pre-M5-5 line without at replays unchanged", async (t) => {
  // The contract says older lines have no `at` (CLIENT-API.md, M5-5), so a
  // reader passes the shape through rather than synthesizing one. A future
  // reader that assumed `at` exists is the regression this pins.
  const { log, path } = await logIn(t);
  await log.close();
  const old = JSON.stringify({
    seq: 1,
    agent: "t0",
    update: chunk("old").update,
  });
  await writeFile(path, `${old}\n`);

  const replay = await openEventLog(path);
  const { seqs, lines, done } = collect(replay, 0);
  await done;
  assert.deepEqual(seqs, [1]);
  assert.equal(JSON.parse(lines[0] as string).at, undefined);
});

test("a replay pauses for a full reader and resumes where it stopped", async (t) => {
  const { log, path } = await logIn(t);
  for (const text of ["a", "b", "c"]) log.append(chunk(text));
  await log.close();

  const r = slowReader(await openEventLog(path), 0);
  await waitFor(() => r.seqs.length >= 1, "the first line");
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(r.seqs, [1]);
  r.open();
  await r.done;
  assert.deepEqual(r.seqs, [1, 2, 3]);
});

// --- a room's log after a restart (M6-7a) ---------------------------------

test("a reopened log keeps its lines, cuts a half-written one, and goes on with seq", async (t) => {
  const { log, path } = await logIn(t);
  log.append(chunk("one"));
  log.append(chunk("two"));
  await log.close();
  // What a `kill -9` mid-write leaves behind.
  await writeFile(path, `${await readFile(path, "utf8")}{"seq":3,"agen`);

  const again = await reopenEventLog(path, (err) => {
    throw err;
  });
  assert.equal(again.size, 2, "the partial line is not counted");
  again.append(chunk("three"));
  const { seqs, lines, done } = collect(again, 0);
  await waitFor(() => seqs.length === 3, "the new line");
  await again.close();
  await done;
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).update.content.text),
    ["one", "two", "three"],
  );
  const onDisk = (await readFile(path, "utf8")).trim().split("\n");
  assert.deepEqual(
    onDisk.map((line) => JSON.parse(line).seq),
    [1, 2, 3],
    "the partial line is gone from the file",
  );
});

test("a reopened log that is not there starts empty", async (t) => {
  const { path } = await logIn(t);
  await rm(path, { force: true });
  const fresh = await reopenEventLog(`${path}.missing`, (err) => {
    throw err;
  });
  assert.equal(fresh.size, 0);
  fresh.append(chunk("first"));
  await fresh.close();
  assert.equal(JSON.parse(await readFile(`${path}.missing`, "utf8")).seq, 1);
});

// --- the persistent dense index (#321) ------------------------------------

/** Byte end of every complete line in the JSONL. */
async function jsonlEnds(path: string): Promise<number[]> {
  const data = await readFile(path);
  const ends: number[] = [];
  for (let at = 0; at < data.length; ) {
    const newline = data.indexOf(0x0a, at);
    if (newline === -1) break;
    ends.push(newline + 1);
    at = newline + 1;
  }
  return ends;
}

test("live sidecar writes use full chunks and close flushes the partial tail", async (t) => {
  const { log, path } = await logIn(t);
  for (let i = 0; i < INDEX_CHUNK_ENTRIES; i++) log.append(chunk(`line ${i}`));
  await waitForAsync(async () => {
    try {
      return (
        v3LineCount(await readFile(indexPath(path))) === INDEX_CHUNK_ENTRIES
      );
    } catch {
      return false;
    }
  }, "the first full live sidecar chunk");

  const full = await readFile(indexPath(path));
  assert.equal(full.length, indexSize(INDEX_CHUNK_ENTRIES));
  log.append(chunk("pending"));
  await waitFor(() => log.size === INDEX_CHUNK_ENTRIES + 1, "the tail commit");
  assert.equal(
    v3LineCount(await readFile(indexPath(path))),
    INDEX_CHUNK_ENTRIES,
    "a live partial chunk stays in memory, not in one-chunk-per-event writes",
  );

  await log.close();
  const complete = await readFile(indexPath(path));
  assert.equal(v3LineCount(complete), INDEX_CHUNK_ENTRIES + 1);
  assert.equal(complete.length, indexSize(INDEX_CHUNK_ENTRIES + 1));
  assert.deepEqual(complete.subarray(0, full.length), full);
  assert.deepEqual(v3Ends(complete), await jsonlEnds(path));
});

test("a stale valid sidecar is refreshed in place and another open sees all lines", async (t) => {
  const { log, path } = await logIn(t);
  for (const text of ["one", "two", "three", "four", "five"]) {
    log.append(chunk(text));
  }
  await log.close();

  const before = await readFile(indexPath(path));
  const beforeCount = v3LineCount(before);
  assert.equal(beforeCount, 5);
  await appendFile(path, `${JSON.stringify({ seq: 6, ...chunk("six") })}\n`);

  const replay = await openEventLog(path);
  assert.equal(replay.size, 6);
  const after = await readFile(indexPath(path));
  assert.equal(
    v3LineCount(after),
    6,
    "the stale open appended the new complete line",
  );
  assert.deepEqual(
    after.subarray(0, before.length),
    before,
    "the existing indexed prefix bytes survive the incremental refresh",
  );
  assert.deepEqual(v3Ends(after), await jsonlEnds(path));

  const middle = collect(replay, 2);
  await middle.done;
  assert.deepEqual(middle.seqs, [3, 4, 5, 6]);
  assert.deepEqual(
    middle.lines.map((line) => JSON.parse(line).update.content.text),
    ["three", "four", "five", "six"],
  );

  const again = await openEventLog(path);
  const all = collect(again, 0);
  await all.done;
  assert.deepEqual(all.seqs, [1, 2, 3, 4, 5, 6]);
  const tail = collect(again, again.size);
  await tail.done;
  assert.deepEqual(tail.seqs, []);
});

for (const kind of ["missing", "corrupt"] as const) {
  test(`a ${kind} sidecar is rebuilt in v3 without changing replay`, async (t) => {
    const { log, path } = await logIn(t);
    for (const text of ["one", "two", "three"]) log.append(chunk(text));
    await log.close();
    if (kind === "missing") {
      await rm(indexPath(path));
    } else {
      const damaged = await readFile(indexPath(path));
      damaged.writeDoubleLE(1, INDEX_HEADER_BYTES + INDEX_CHUNK_HEADER_BYTES);
      await writeFile(indexPath(path), damaged);
    }

    const replay = await openEventLog(path);
    assert.equal(replay.size, 3);
    assert.deepEqual(
      v3Ends(await readFile(indexPath(path))),
      await jsonlEnds(path),
    );
    for (const after of [0, 1, 2, 3]) {
      const r = collect(replay, after);
      await r.done;
      assert.deepEqual(r.seqs, range(after + 1, 3), `replay after ${after}`);
    }
  });
}

test("a truncated final sidecar chunk is ignored and rebuilt from its valid prefix", async (t) => {
  const { log, path } = await logIn(t);
  const total = 300;
  for (let i = 1; i <= total; i++) log.append(chunk(`line ${i}`));
  await log.close();

  const complete = await readFile(indexPath(path));
  const firstChunkEnd =
    INDEX_HEADER_BYTES +
    INDEX_CHUNK_OVERHEAD_BYTES +
    INDEX_CHUNK_ENTRIES * INDEX_END_BYTES;
  await writeFile(indexPath(path), complete.subarray(0, firstChunkEnd + 17));

  const replay = await openEventLog(path);
  assert.equal(replay.size, total);
  const rebuilt = await readFile(indexPath(path));
  assert.equal(v3LineCount(rebuilt), total);
  assert.deepEqual(v3Ends(rebuilt), await jsonlEnds(path));
  const tail = collect(replay, total - 2);
  await tail.done;
  assert.deepEqual(tail.seqs, [total - 1, total]);
});

test("a v2 sidecar is rejected and rebuilt as v3", async (t) => {
  const { log, path } = await logIn(t);
  for (const text of ["one", "two", "three"]) log.append(chunk(text));
  await log.close();

  const ends = await jsonlEnds(path);
  await writeFile(indexPath(path), v2Index(ends));
  const replay = await openEventLog(path);
  assert.equal(replay.size, 3);
  const rebuilt = await readFile(indexPath(path));
  assert.equal(rebuilt.readUInt16LE(4), INDEX_VERSION);
  assert.equal(v3LineCount(rebuilt), 3);
  assert.deepEqual(v3Ends(rebuilt), ends);

  const r = collect(replay, 1);
  await r.done;
  assert.deepEqual(r.seqs, [2, 3]);
});

test("a CRC-valid sidecar with wrong line boundaries is rejected by the anchors", async (t) => {
  const { log, path } = await logIn(t);
  for (const text of ["one", "two", "three"]) log.append(chunk(text));
  await log.close();
  const fileBytes = (await stat(path)).size;

  // Its CRC is valid, but one record says the whole JSONL is one line. The
  // bounded first-line and last-line checks catch this without a full scan.
  await writeFile(indexPath(path), v3Index([fileBytes]));

  const replay = await openEventLog(path);
  assert.equal(replay.size, 3, "the wrong sidecar is not trusted");
  const rebuilt = await readFile(indexPath(path));
  assert.equal(v3LineCount(rebuilt), 3);
  assert.deepEqual(v3Ends(rebuilt), await jsonlEnds(path));

  for (const after of [0, 1, 2, 3]) {
    const r = collect(replay, after);
    await r.done;
    assert.deepEqual(r.seqs, range(after + 1, 3), `replay after ${after}`);
  }
});

test("a stale sidecar gains complete tail lines and ignores a partial one", async (t) => {
  const { log, path } = await logIn(t);
  log.append(chunk("one"));
  log.append(chunk("two"));
  await log.close();

  const partial = '{"seq":5,"agen';
  await appendFile(
    path,
    `${JSON.stringify({ seq: 3, ...chunk("three") })}\n${JSON.stringify({
      seq: 4,
      ...chunk("four"),
    })}\n${partial}`,
  );

  const replay = await openEventLog(path);
  const r = collect(replay, 2);
  await r.done;
  assert.equal(replay.size, 4);
  assert.deepEqual(r.seqs, [3, 4]);
  assert.deepEqual(
    r.lines.map((line) => JSON.parse(line).update.content.text),
    ["three", "four"],
  );
  const rebuilt = await readFile(indexPath(path));
  assert.equal(v3LineCount(rebuilt), 4);
  assert.deepEqual(v3Ends(rebuilt), await jsonlEnds(path));
});

test("a sidecar ahead of the log is rebuilt from the complete lines", async (t) => {
  const { log, path } = await logIn(t);
  for (const text of ["one", "two", "three"]) log.append(chunk(text));
  await log.close();
  const ends = v3Ends(await readFile(indexPath(path)));
  await truncate(path, ends[1] as number);

  const replay = await openEventLog(path);
  assert.equal(replay.size, 2);
  const r = collect(replay, 1);
  await r.done;
  assert.deepEqual(r.seqs, [2]);
  const rebuilt = await readFile(indexPath(path));
  assert.equal(v3LineCount(rebuilt), 2);
  assert.deepEqual(v3Ends(rebuilt), await jsonlEnds(path));
});

test("two reopen and append cycles reuse no seq and keep the sidecar exact", async (t) => {
  const { log, path } = await logIn(t);
  log.append(chunk("one"));
  log.append(chunk("two"));
  await log.close();

  const second = await reopenEventLog(path, (err) => {
    throw err;
  });
  assert.equal(second.size, 2);
  const secondPrefix = await readFile(indexPath(path));
  second.append(chunk("three"));
  await waitFor(() => second.size === 3, "the reopened log's commit");
  assert.equal(
    v3LineCount(await readFile(indexPath(path))),
    2,
    "the partial live tail waits for close",
  );
  await second.close();
  const secondSidecar = await readFile(indexPath(path));
  assert.deepEqual(
    secondSidecar.subarray(0, secondPrefix.length),
    secondPrefix,
  );

  const third = await reopenEventLog(path, (err) => {
    throw err;
  });
  assert.equal(third.size, 3, "the first reopen did not reuse seq 2");
  third.append(chunk("four"));
  await third.close();

  const final = await openEventLog(path);
  assert.equal(final.size, 4);
  const all = collect(final, 0);
  await all.done;
  assert.deepEqual(all.seqs, [1, 2, 3, 4]);
  assert.deepEqual(
    all.lines.map((line) => JSON.parse(line).update.content.text),
    ["one", "two", "three", "four"],
  );
  const sidecar = await readFile(indexPath(path));
  assert.equal(v3LineCount(sidecar), 4);
  assert.deepEqual(v3Ends(sidecar), await jsonlEnds(path));
});

test("a sidecar write failure at close does not reject or sacrifice the JSONL", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kapelle-eventlog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "events.jsonl");
  await mkdir(indexPath(path));
  // One line is below the live chunk threshold. The sidecar's first write is
  // therefore the forced close flush, and it is the one that fails here.
  const errors: string[] = [];
  const log = createEventLog(path, (err) => errors.push(err.message));
  log.append(chunk("safe"));
  await log.close();

  assert.equal(log.size, 1);
  assert.deepEqual(
    errors,
    [],
    "the sidecar cache never reports as log failure",
  );
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).update.content.text,
    "safe",
  );
});

test("a synthetic 1 M-line log measures initial and sidecar boot indexing", async (t) => {
  const { log, path } = await logIn(t);
  await log.close();
  const TOTAL = 1_000_000;
  const BATCH = 10_000;
  for (let first = 1; first <= TOTAL; first += BATCH) {
    const lines: string[] = [];
    for (let seq = first; seq < first + BATCH; seq++) {
      lines.push(`{"seq":${seq}}`);
    }
    await appendFile(path, `${lines.join("\n")}\n`);
  }

  let started = performance.now();
  const initial = await openEventLog(path);
  const initialMs = performance.now() - started;
  assert.equal(initial.size, TOTAL);
  const last = collect(initial, TOTAL - 1);
  await last.done;
  assert.deepEqual(last.seqs, [TOTAL]);
  assert.equal(JSON.parse(last.lines[0] as string).seq, TOTAL);

  started = performance.now();
  const warm = await openEventLog(path);
  const warmMs = performance.now() - started;
  assert.equal(warm.size, TOTAL);
  assert.equal((await stat(indexPath(path))).size, indexSize(TOTAL));
  t.diagnostic(
    `1 M-line boot index: initial ${initialMs.toFixed(1)} ms; valid sidecar ${warmMs.toFixed(1)} ms`,
  );
});
