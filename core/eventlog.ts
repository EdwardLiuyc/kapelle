/**
 * The event log — story M2-2, issue #32.
 *
 * One bus listener per run, appending every event to
 * `<stateDirFor(root)>/runs/<runId>/events.jsonl` as `{seq, at, agent,
 * update}`, one line each. Decided at pickup (2026-09-14):
 *
 * **Raw, never coalesced.** Every `agent_message_chunk` is its own line, with
 * its `_meta`. Joined text cannot be split again; a reader who wants messages
 * joins them when reading. M0-4 measured 443 events in one opencode turn, so
 * a task is tens of kilobytes, and no compression is applied.
 *
 * **The file is the only replay source.** `follow` tails it from the reader's
 * own position, so history and the live tail come out of one loop and there
 * is no ring-to-file hand-off to get wrong. Memory holds a byte offset per
 * line, never the events. A dense binary `events.idx` persists those offsets
 * (#321): open reads it and scans only the unindexed tail, rebuilding it when
 * missing or invalid. The JSONL stays authoritative after a crash.
 *
 * **A caught-up reader skips the disk.** Each committed line rings the
 * readers with the line itself, and a reader waiting for exactly that `seq`
 * sends it. A reader still on the file never matches: it reads up to what was
 * committed when it looked, so every bell it hears is for a later line, and
 * the loop goes back for it. The check and the send run on one thread with
 * nothing in between, which is why a second thread would add a race and no
 * speed — the write itself already runs on libuv's pool.
 *
 * **A full reader pauses** (M5-6, #138, decision F5). `send` returns a
 * promise when the reader cannot take more — a socket whose `write` returned
 * false — and `follow` stops until it settles. The bell stays quiet while a
 * reader is paused, and the reader goes back to the file for what it missed.
 * So a client that stops reading costs one chunk and its socket buffer, never
 * the rest of the run: the file is the buffer.
 *
 * **Committed, not appended.** A line counts once its write callback fires,
 * so no reader sees a line that is not on disk, or half of one.
 *
 * **`at` is stamped here** (M5-5, #137, decision C6): the ISO time the line
 * was appended, on every log — a room's too — so a reader can order turns
 * across logs. A line written before M5-5 has none.
 *
 * **A room's line names its room and participant** (M6-4, S10):
 * `{seq, at, roomId, participantId, update}`, one log and one `seq` for the
 * whole room. No `agent`: a harness name is not unique in a room, and a
 * display name changes on a rename, while the id never does.
 *
 * **A room's log is reopened after a restart** (M6-7a, #151):
 * `reopenEventLog` restores saved offsets or scans the old file, cuts a
 * partial last line, and goes on appending with `seq` carried on.
 */

import { createWriteStream, existsSync } from "node:fs";
import {
  appendFile,
  type FileHandle,
  open,
  readFile,
  truncate,
  writeFile,
} from "node:fs/promises";
import { finished } from "node:stream/promises";
import type { AgentEventEnvelope } from "../protocol/agent.ts";
import type { AgentEvent } from "../protocol/types.ts";

const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
/** KIDX, version 1, then one {start, end} float64 pair per complete line.
 *  IEEE-754 doubles exactly represent every safe-integer byte offset. */
const INDEX_HEADER = Buffer.from([0x4b, 0x49, 0x44, 0x58, 1, 0, 0, 0]);
const INDEX_RECORD_BYTES = 16;

const sidecarPath = (path: string) =>
  path.endsWith(".jsonl")
    ? `${path.slice(0, -".jsonl".length)}.idx`
    : `${path}.idx`;

/** Sends one line. A promise back means "full": send no more until it
 *  settles. */
type Send = (seq: number, line: string) => Promise<void> | undefined;
type Bell = (seq: number, line: string) => void;

/** One line of a room's log, before `seq` and `at` (S10). */
interface RoomEventEnvelope {
  roomId: string;
  participantId: string;
  update: AgentEvent;
}

export interface EventLog {
  /** The bus listener. Ignored once the log is closed or has failed. */
  append: (event: AgentEventEnvelope | RoomEventEnvelope) => void;
  /**
   * Sends every committed line after `after`, then each new one as it
   * commits, until the log closes or `signal` aborts. `line` has no newline.
   * When `send` returns a promise, nothing more is sent until it settles.
   */
  follow(after: number, send: Send, signal?: AbortSignal): Promise<void>;
  /** Lines committed so far — the highest `seq` any reader can have seen. */
  readonly size: number;
  /** Flushes what was appended and ends every reader once it has caught up. */
  close(): Promise<void>;
}

/** The lines already on disk: where each starts, and the bytes they take. */
interface Index {
  starts: number[];
  bytes: number;
  /** Whether the sidecar already covers exactly these lines. */
  sidecarReady: boolean;
}

/** A new log at `path`, or with `from`, one that appends after the lines
 *  `from` indexed. */
export function createEventLog(
  path: string,
  onError: (err: Error) => void,
  from?: Index,
): EventLog {
  const out = createWriteStream(path, { flags: from ? "a" : "w" });
  const indexOut = createWriteStream(sidecarPath(path), {
    flags: from?.sidecarReady ? "a" : "w",
  });
  if (!from?.sidecarReady) indexOut.write(INDEX_HEADER);
  /** `starts[seq - 1]` is where that line begins. */
  const starts: number[] = from ? [...from.starts] : [];
  let appended = starts.length;
  let appendedBytes = from?.bytes ?? 0;
  let committed = appended;
  let committedBytes = appendedBytes;
  let accepting = true;
  const bells = new Set<Bell>();
  /** One per reader: wakes it from its park, so it sees `over` and ends. */
  const wakers = new Set<() => void>();

  let over = false;
  let closing: Promise<void> | undefined;
  const markEnded = () => {
    over = true;
    for (const waker of wakers) waker();
  };

  let reportedCode: string | undefined;
  let errorReported = false;
  const report = (err: Error) => {
    const { code } = err as NodeJS.ErrnoException;
    if (errorReported && code === reportedCode) return;
    errorReported = true;
    reportedCode = code;
    onError(err);
  };
  out.on("error", (err) => {
    // The run goes on without its durable copy, the same as a stderr log that
    // cannot be written (M1b-7). Readers end at what was committed.
    if (!accepting) return;
    accepting = false;
    indexOut.end();
    report(err);
    markEnded();
  });
  // An index failure costs the next boot's optimization, never the JSONL.
  indexOut.on("error", report);

  return {
    append(event) {
      if (!accepting) return;
      appended += 1;
      const seq = appended;
      const at = new Date().toISOString();
      const line = JSON.stringify({ seq, at, ...event });
      const bytes = Buffer.byteLength(line) + 1;
      starts.push(appendedBytes);
      appendedBytes += bytes;
      const record = Buffer.allocUnsafe(INDEX_RECORD_BYTES);
      record.writeDoubleLE(starts[seq - 1] as number, 0);
      record.writeDoubleLE(appendedBytes, 8);
      indexOut.write(record);
      // Write callbacks fire in write order, so `committed` only ever moves
      // forward by one line.
      out.write(`${line}\n`, (err) => {
        if (err) return;
        committed = seq;
        committedBytes += bytes;
        for (const bell of bells) bell(seq, line);
      });
    },

    async follow(after, send, signal) {
      let next = after + 1;
      /** Set while the reader is full; nothing is sent until it settles. */
      let full: Promise<void> | undefined;
      let wake = () => {};
      const push = (line: string) => {
        full = send(next, line);
        next += 1;
      };
      const bell: Bell = (seq, line) => {
        // `signal` can abort while the reader is parked; the bell must go
        // quiet then, not on the microtask that removes it.
        if (seq !== next || full || signal?.aborted) return;
        push(line);
        if (full) wake();
      };
      // Not `wake` itself: each park replaces it.
      const waker = () => wake();
      bells.add(bell);
      wakers.add(waker);
      let file: FileHandle | undefined;
      try {
        while (!signal?.aborted) {
          if (full) {
            await withAbort(full, signal);
            full = undefined;
            continue;
          }
          if (next <= committed) {
            file ??= await open(path, "r");
            const to = committedBytes;
            await readLines(
              file,
              starts[next - 1] ?? to,
              to,
              signal,
              (line) => {
                push(line);
                return !full;
              },
            );
            continue;
          }
          if (over) return;
          // Parked: the bell sends each new line. It wakes the loop when a
          // send fills the reader, and `markEnded` wakes it at the end.
          // Each park replaces `wake`, so repeated pauses leave no old
          // resolver or abort listener behind.
          await withAbort(
            new Promise<void>((ok) => {
              wake = ok;
            }),
            signal,
          );
        }
      } finally {
        bells.delete(bell);
        wakers.delete(waker);
        await file?.close();
      }
    },

    get size() {
      return committed;
    },

    close() {
      closing ??= (async () => {
        accepting = false;
        out.end();
        indexOut.end();
        await Promise.allSettled([finished(out), finished(indexOut)]);
        markEnded();
      })();
      return closing;
    },
  };
}

/**
 * A finished run's log, read back from disk (M2-6, #36).
 *
 * The same `EventLog` a live run hands out, so `daemon.ts` serves
 * `GET /runs/:id/events` for a run from before a restart through the one code
 * path. Read-only on purpose: a run that is over gets no more lines.
 * `reopenEventLog` is the one that appends.
 *
 * A valid sidecar supplies the line offsets and count; only the unindexed tail
 * needs scanning. A missing or invalid sidecar is rebuilt. A trailing partial
 * line, which is what a `kill -9` mid-write leaves, is dropped by `readLines`:
 * the same "committed, not appended" rule the writer follows.
 */
export async function openEventLog(path: string): Promise<EventLog> {
  const { starts, bytes } = await indexOf(path);

  return {
    // Nothing writes to a run that is over. Present because the interface is
    // shared with the live log, never called.
    append() {},

    async follow(after, send, signal) {
      if (after >= starts.length || signal?.aborted) return;
      const file = await open(path, "r");
      try {
        let next = after + 1;
        while (next <= starts.length && !signal?.aborted) {
          let full: Promise<void> | undefined;
          await readLines(
            file,
            starts[next - 1] as number,
            bytes,
            signal,
            (line) => {
              full = send(next, line);
              next += 1;
              return !full;
            },
          );
          if (full) await withAbort(full, signal);
        }
      } finally {
        await file.close();
      }
      // No park at the end: the run is over, so the reader is caught up for
      // good and the stream ends.
    },

    get size() {
      return starts.length;
    },

    async close() {},
  };
}

/** A valid saved index, or undefined when the JSONL must rebuild it. */
async function readSidecar(
  path: string,
  log: FileHandle,
  logBytes: number,
): Promise<Index | undefined> {
  let data: Buffer;
  try {
    data = await readFile(sidecarPath(path));
  } catch {
    return undefined;
  }
  if (
    data.length < INDEX_HEADER.length ||
    (data.length - INDEX_HEADER.length) % INDEX_RECORD_BYTES !== 0 ||
    !data.subarray(0, INDEX_HEADER.length).equals(INDEX_HEADER)
  ) {
    return undefined;
  }
  const starts: number[] = [];
  let bytes = 0;
  for (
    let pos = INDEX_HEADER.length;
    pos < data.length;
    pos += INDEX_RECORD_BYTES
  ) {
    const start = data.readDoubleLE(pos);
    const end = data.readDoubleLE(pos + 8);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return undefined;
    }
    if (start !== bytes || end <= start || end > logBytes) return undefined;
    starts.push(start);
    bytes = end;
  }
  if (bytes > 0) {
    const newline = Buffer.alloc(1);
    const { bytesRead } = await log.read(newline, 0, 1, bytes - 1);
    if (bytesRead !== 1 || newline[0] !== NEWLINE) return undefined;
  }
  return { starts, bytes, sidecarReady: true };
}

/** Binary records for `starts[from:]`, with a header for a full rebuild. */
function encodeIndex(
  starts: number[],
  bytes: number,
  from: number,
  header: boolean,
): Buffer {
  const offset = header ? INDEX_HEADER.length : 0;
  const data = Buffer.alloc(
    offset + (starts.length - from) * INDEX_RECORD_BYTES,
  );
  if (header) INDEX_HEADER.copy(data);
  for (let i = from; i < starts.length; i++) {
    const pos = offset + (i - from) * INDEX_RECORD_BYTES;
    data.writeDoubleLE(starts[i] as number, pos);
    data.writeDoubleLE(starts[i + 1] ?? bytes, pos + 8);
  }
  return data;
}

/** Where each whole line of `path` starts. A partial last line is not counted.
 *  Persist new offsets, but never refuse a readable log for its sidecar. */
async function indexOf(path: string): Promise<Index> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const size = stat.size;
    const saved = await readSidecar(path, file, size);
    const indexed = saved?.starts.length ?? 0;
    const starts = saved?.starts ?? [];
    const from = saved?.bytes ?? 0;
    let bytes = from;
    await readLines(file, from, size, undefined, (line) => {
      starts.push(bytes);
      bytes += Buffer.byteLength(line) + 1;
    });
    let sidecarReady = saved !== undefined;
    if (!saved || bytes !== from) {
      const records = encodeIndex(starts, bytes, indexed, !saved);
      try {
        if (saved) await appendFile(sidecarPath(path), records);
        else await writeFile(sidecarPath(path), records);
        sidecarReady = true;
      } catch {
        sidecarReady = false;
      }
    }
    return { starts, bytes, sidecarReady };
  } finally {
    await file.close();
  }
}

/**
 * A room's log after a restart (M6-7a): the lines on disk stay, and new ones
 * are appended with the next `seq`. Its sidecar avoids a full scan when valid.
 * A partial last line, which a `kill -9`
 * mid-write leaves, is cut first: an append after it would join the two into
 * one bad line. A log that is not there starts empty.
 */
export async function reopenEventLog(
  path: string,
  onError: (err: Error) => void,
): Promise<EventLog> {
  if (!existsSync(path)) return createEventLog(path, onError);
  const index = await indexOf(path);
  await truncate(path, index.bytes);
  return createEventLog(path, onError, index);
}

/** Sends each whole line in `[from, to)`; `to` always sits on a line end.
 *  Stops early, mid-chunk too, when `onLine` returns false. */
// Keep the internal hot path positional rather than allocating an options object.
// pi-lens-ignore: long-parameter-list
async function readLines(
  file: FileHandle,
  from: number,
  to: number,
  signal: AbortSignal | undefined,
  // biome-ignore lint/suspicious/noConfusingVoidType: the index scan returns nothing.
  onLine: (line: string) => boolean | void,
): Promise<void> {
  const buf = Buffer.alloc(CHUNK_BYTES);
  let carry = Buffer.alloc(0);
  for (let pos = from; pos < to && !signal?.aborted; ) {
    const { bytesRead } = await file.read(
      buf,
      0,
      Math.min(CHUNK_BYTES, to - pos),
      pos,
    );
    if (bytesRead === 0) return;
    // An abort during the read must not dispatch this chunk: `follow` promises
    // sends stop when `signal` aborts.
    if (signal?.aborted) return;
    pos += bytesRead;
    // Split on bytes, not on a decoded string: a chunk boundary can land
    // inside a multi-byte character, never inside a newline.
    let data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
    for (let nl = data.indexOf(NEWLINE); nl !== -1 && !signal?.aborted; ) {
      if (onLine(data.toString("utf8", 0, nl)) === false) return;
      data = data.subarray(nl + 1);
      nl = data.indexOf(NEWLINE);
    }
    carry = Buffer.from(data);
  }
}

/**
 * `promise`, or a settle when `signal` aborts, with the abort listener
 * detached as soon as either side settles. Without a signal it is the promise
 * alone: a parked reader waits forever. The detach is the point — `follow`
 * races on every pause and re-park, and a listener left behind would grow
 * without bound for a slow reader on a long-lived stream.
 */
function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((ok, fail) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      ok(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        ok(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        fail(err);
      },
    );
  });
}
