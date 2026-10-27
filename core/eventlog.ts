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
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { finished } from "node:stream/promises";
import { crc32 } from "node:zlib";
import type { AgentEventEnvelope } from "../protocol/agent.ts";
import type { AgentEvent } from "../protocol/types.ts";

const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
/** KIDX version 3. A 40-byte header is followed by append-only chunks. Each
 *  chunk carries a fast CRC32 and up to `INDEX_CHUNK_ENTRIES` dense end offsets,
 *  one per complete line. Starts are the previous end, so a line needs only one
 *  float64. IEEE-754 doubles exactly represent every safe-integer byte offset.
 *  The header names the log file (device, inode, birth time), so a sidecar
 *  copied from another log is rebuilt rather than trusted.
 *
 *  The CRC and the bounded first-line/last-line anchors catch accidental,
 *  truncated, stale and cross-version sidecars. They do not prove that every
 *  interior offset is a real line boundary: doing that would require reading
 *  all of events.jsonl and would defeat the warm-index budget. Corruption here
 *  means a missing, torn or accidentally modified cache, not a forged one: a
 *  writer with state-directory access can already modify the JSONL itself. */
const INDEX_MAGIC = Buffer.from("KIDX");
const INDEX_VERSION = 3;
const INDEX_HEADER_BYTES = 40;
const INDEX_END_BYTES = 8;
const INDEX_CHUNK_MAGIC = Buffer.from("KCHK");
const INDEX_CHUNK_HEADER_BYTES = 8;
const INDEX_CHUNK_CRC_BYTES = 4;
const INDEX_CHUNK_OVERHEAD_BYTES =
  INDEX_CHUNK_HEADER_BYTES + INDEX_CHUNK_CRC_BYTES;
const INDEX_CHUNK_ENTRIES = 256;

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

/** The lines already on disk: where each ends, and the bytes they take. */
interface LogIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

const identityOf = (stats: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}): LogIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
  birthtimeNs: stats.birthtimeNs,
});

const fileIdentity = async (path: string): Promise<LogIdentity> =>
  identityOf(await stat(path, { bigint: true }));

interface Index {
  /** `ends[seq - 1]` is the byte offset after that line. */
  ends: Float64Array;
  bytes: number;
  /** The log file this index belongs to, so a copied sidecar is not trusted. */
  identity: LogIdentity;
  /** The usable sidecar prefix, when one exists. `count` offsets end at
   *  `at` bytes, so new chunks can be appended without copying the old ones. */
  sidecar?: { at: number; count: number };
}

/** Grows a dense offset view without copying on every append. */
function growOffsets(ends: Float64Array, needed: number): Float64Array {
  if (needed <= ends.length) return ends;
  let length = ends.length || 16;
  while (length < needed) length *= 2;
  const grown = new Float64Array(length);
  grown.set(ends);
  return grown;
}

/** A new log at `path`, or with `from`, one that appends after the lines
 *  `from` indexed. */
export function createEventLog(
  path: string,
  onError: (err: Error) => void,
  from?: Index,
): EventLog {
  const out = createWriteStream(path, { flags: from ? "a" : "w" });
  let ends = from?.ends ?? new Float64Array(0);
  let appended = ends.length;
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
    report(err);
    markEnded();
  });

  // The sidecar is a cache. Keep its append queue separate from the JSONL so a
  // slow or failed cache write never delays a line or reaches `onError`.
  let identity = from?.identity;
  let sidecarAt = from?.sidecar?.at;
  let sidecarCount = from?.sidecar?.count ?? 0;
  let sidecarWrite = Promise.resolve();
  let sidecarFailed = false;

  const flushSidecar = (force = false): Promise<void> => {
    if (sidecarFailed) return sidecarWrite;
    sidecarWrite = sidecarWrite
      .then(async () => {
        if (sidecarFailed) return;
        // Live writes contain full chunks only. The final partial chunk is
        // forced at close; after a crash its lines are recovered from JSONL.
        const pending = committed - sidecarCount;
        const to = force
          ? committed
          : sidecarCount +
            Math.floor(pending / INDEX_CHUNK_ENTRIES) * INDEX_CHUNK_ENTRIES;
        if (to <= sidecarCount) return;
        if (sidecarAt === undefined) {
          // Missing, invalid, or a failed update: rebuild this cache once. It
          // is only this path that copies the dense prefix.
          identity ??= await fileIdentity(path);
          const data = encodeIndex(ends.subarray(0, to), identity);
          await writeFile(sidecarPath(path), data);
          sidecarAt = data.length;
          sidecarCount = to;
          return;
        }
        const data = encodeChunks(ends, sidecarCount, to);
        await appendFile(sidecarPath(path), data);
        sidecarAt += data.length;
        sidecarCount = to;
      })
      .catch(() => {
        // A cache failure costs the next boot's warm start, never the JSONL
        // or the live log. Do not report it to the caller.
        sidecarFailed = true;
      });
    return sidecarWrite;
  };

  return {
    append(event) {
      if (!accepting) return;
      appended += 1;
      const seq = appended;
      const at = new Date().toISOString();
      const line = JSON.stringify({ seq, at, ...event });
      const bytes = Buffer.byteLength(line) + 1;
      appendedBytes += bytes;
      ends = growOffsets(ends, appended);
      ends[appended - 1] = appendedBytes;
      // Write callbacks fire in write order, so `committed` only ever moves
      // forward by one line.
      out.write(`${line}\n`, (err) => {
        if (err) return;
        committed = seq;
        committedBytes += bytes;
        if (committed - sidecarCount >= INDEX_CHUNK_ENTRIES) {
          void flushSidecar();
        }
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
            const start = next > 1 ? (ends[next - 2] as number) : 0;
            await readLines(file, start, to, signal, (line) => {
              push(line);
              return !full;
            });
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
        await finished(out).catch(() => {});
        markEnded();
        // Flush the offsets committed by the callbacks above. `flushSidecar`
        // swallows cache failures, so close cannot reject because of a cache.
        await flushSidecar(true);
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
  const { ends, bytes } = await indexOf(path);

  return {
    // Nothing writes to a run that is over. Present because the interface is
    // shared with the live log, never called.
    append() {},

    async follow(after, send, signal) {
      if (after >= ends.length || signal?.aborted) return;
      const file = await open(path, "r");
      try {
        let next = after + 1;
        while (next <= ends.length && !signal?.aborted) {
          let full: Promise<void> | undefined;
          const start = next > 1 ? (ends[next - 2] as number) : 0;
          await readLines(file, start, bytes, signal, (line) => {
            full = send(next, line);
            next += 1;
            return !full;
          });
          if (full) await withAbort(full, signal);
        }
      } finally {
        await file.close();
      }
      // No park at the end: the run is over, so the reader is caught up for
      // good and the stream ends.
    },

    get size() {
      return ends.length;
    },

    async close() {},
  };
}

/** The first complete line end in `[0, limit)`, or undefined when there is no
 *  newline. This reads only until the first newline. */
async function firstLineEnd(
  log: FileHandle,
  limit: number,
): Promise<number | undefined> {
  const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, limit)));
  for (let pos = 0; pos < limit; ) {
    const { bytesRead } = await log.read(
      buf,
      0,
      Math.min(buf.length, limit - pos),
      pos,
    );
    if (bytesRead === 0) return undefined;
    const newline = buf.subarray(0, bytesRead).indexOf(NEWLINE);
    if (newline !== -1) return pos + newline + 1;
    pos += bytesRead;
  }
  return undefined;
}

/** The byte offset where the complete line ending at `end` starts. It scans
 *  backwards, so a sidecar can check its last boundary without a full scan. */
async function lastLineStart(
  log: FileHandle,
  end: number,
): Promise<number | undefined> {
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let cursor = end - 1;
  while (cursor > 0) {
    const from = Math.max(0, cursor - buf.length);
    let pos = from;
    while (pos < cursor) {
      const { bytesRead } = await log.read(buf, 0, cursor - pos, pos);
      if (bytesRead === 0) return undefined;
      const newline = buf.subarray(0, bytesRead).lastIndexOf(NEWLINE);
      if (newline !== -1) return pos + newline + 1;
      pos += bytesRead;
    }
    cursor = from;
  }
  return 0;
}

function encodeIndexHeader(identity: LogIdentity): Buffer {
  const header = Buffer.alloc(INDEX_HEADER_BYTES);
  INDEX_MAGIC.copy(header, 0);
  header.writeUInt16LE(INDEX_VERSION, 4);
  header.writeUInt16LE(INDEX_HEADER_BYTES, 6);
  header.writeUInt32LE(INDEX_CHUNK_ENTRIES, 8);
  header.writeBigUInt64LE(identity.dev, 12);
  header.writeBigUInt64LE(identity.ino, 20);
  header.writeBigUInt64LE(identity.birthtimeNs, 28);
  return header;
}

/** One appendable chunk. The CRC covers the magic, count and every end
 *  offset; a torn final chunk can therefore be ignored without trusting it. */
function encodeChunk(ends: Float64Array, from: number, to: number): Buffer {
  const count = to - from;
  const checksumAt = INDEX_CHUNK_HEADER_BYTES + count * INDEX_END_BYTES;
  const data = Buffer.allocUnsafe(checksumAt + INDEX_CHUNK_CRC_BYTES);
  INDEX_CHUNK_MAGIC.copy(data, 0);
  data.writeUInt32LE(count, 4);
  for (let i = 0; i < count; i++) {
    data.writeDoubleLE(ends[from + i] as number, 8 + i * INDEX_END_BYTES);
  }
  data.writeUInt32LE(crc32(data.subarray(0, checksumAt)), checksumAt);
  return data;
}

/** New chunks for dense offsets `[from, to)`, without copying offsets before
 *  `from`. This is the stale-refresh and live-append path. */
function encodeChunks(ends: Float64Array, from: number, to: number): Buffer {
  const chunks: Buffer[] = [];
  for (let start = from; start < to; start += INDEX_CHUNK_ENTRIES) {
    chunks.push(
      encodeChunk(ends, start, Math.min(start + INDEX_CHUNK_ENTRIES, to)),
    );
  }
  return Buffer.concat(chunks);
}

/** A complete sidecar. Only missing/invalid sidecars take this copy path. */
function encodeIndex(ends: Float64Array, identity: LogIdentity): Buffer {
  return Buffer.concat([
    encodeIndexHeader(identity),
    encodeChunks(ends, 0, ends.length),
  ]);
}

interface ParsedSidecar {
  ends: Float64Array;
  bytes: number;
  /** Usable prefix length. Bytes after it are an incomplete/corrupt tail. */
  at: number;
  count: number;
  complete: boolean;
}

/** Parses whole valid chunks and stops at the first incomplete or corrupt
 *  one. The valid prefix is still useful: the JSONL tail is scanned from its
 *  last end, then the bad tail is replaced. */
function parseSidecar(
  data: Buffer,
  logBytes: number,
  identity: LogIdentity,
): ParsedSidecar | undefined {
  if (
    data.length < INDEX_HEADER_BYTES ||
    !data.subarray(0, INDEX_MAGIC.length).equals(INDEX_MAGIC) ||
    data.readUInt16LE(4) !== INDEX_VERSION ||
    data.readUInt16LE(6) !== INDEX_HEADER_BYTES ||
    data.readUInt32LE(8) !== INDEX_CHUNK_ENTRIES ||
    data.readBigUInt64LE(12) !== identity.dev ||
    data.readBigUInt64LE(20) !== identity.ino ||
    data.readBigUInt64LE(28) !== identity.birthtimeNs
  ) {
    return undefined;
  }

  let ends: Float64Array = new Float64Array(0);
  let count = 0;
  let pos = INDEX_HEADER_BYTES;
  let complete = true;
  for (; pos < data.length; ) {
    const remaining = data.length - pos;
    if (remaining < INDEX_CHUNK_OVERHEAD_BYTES) {
      complete = false;
      break;
    }
    if (!data.subarray(pos, pos + 4).equals(INDEX_CHUNK_MAGIC)) {
      complete = false;
      break;
    }
    const chunkCount = data.readUInt32LE(pos + 4);
    if (chunkCount === 0 || chunkCount > INDEX_CHUNK_ENTRIES) {
      complete = false;
      break;
    }
    const checksumAt =
      pos + INDEX_CHUNK_HEADER_BYTES + chunkCount * INDEX_END_BYTES;
    const frameBytes = checksumAt + INDEX_CHUNK_CRC_BYTES - pos;
    if (remaining < frameBytes) {
      complete = false;
      break;
    }
    if (
      crc32(data.subarray(pos, checksumAt)) !== data.readUInt32LE(checksumAt)
    ) {
      complete = false;
      break;
    }

    const chunkEnds = new Float64Array(chunkCount);
    let previous = count > 0 ? (ends[count - 1] as number) : 0;
    let chunkValid = true;
    for (let i = 0; i < chunkCount; i++) {
      const end = data.readDoubleLE(
        pos + INDEX_CHUNK_HEADER_BYTES + i * INDEX_END_BYTES,
      );
      if (!Number.isSafeInteger(end) || end <= previous || end > logBytes) {
        chunkValid = false;
        break;
      }
      chunkEnds[i] = end;
      previous = end;
    }
    if (!chunkValid) {
      complete = false;
      break;
    }

    ends = growOffsets(ends, count + chunkCount);
    ends.set(chunkEnds, count);
    count += chunkCount;
    pos += frameBytes;
  }

  return {
    ends: ends.subarray(0, count),
    bytes: count > 0 ? (ends[count - 1] as number) : 0,
    at: pos,
    count,
    complete: complete && pos === data.length,
  };
}

/** A valid saved index prefix, or undefined when there is no usable v3 header.
 *  The file identity and chunk CRCs catch accidental corruption and a sidecar
 *  copied from another log. The first-line and last-line anchors catch changed
 *  boundaries without a full scan. A forged sidecar with valid CRCs and the
 *  right file identity but wrong interior offsets is a stated non-goal:
 *  catching it would cost the warm-index budget. */
async function readSidecar(
  path: string,
  log: FileHandle,
  logBytes: number,
  identity: LogIdentity,
): Promise<ParsedSidecar | undefined> {
  let data: Buffer;
  try {
    data = await readFile(sidecarPath(path));
  } catch {
    return undefined;
  }
  const parsed = parseSidecar(data, logBytes, identity);
  if (!parsed) return undefined;
  if (parsed.count === 0) return parsed;

  const bytes = parsed.bytes;
  const newline = Buffer.allocUnsafe(1);
  const { bytesRead } = await log.read(newline, 0, 1, bytes - 1);
  if (bytesRead !== 1 || newline[0] !== NEWLINE) return undefined;
  const firstEnd = parsed.ends[0] as number;
  const lastStart =
    parsed.count > 1 ? (parsed.ends[parsed.count - 2] as number) : 0;
  if ((await firstLineEnd(log, bytes)) !== firstEnd) return undefined;
  if ((await lastLineStart(log, bytes)) !== lastStart) return undefined;
  return parsed;
}

/** Where each whole line of `path` ends. A partial last line is not counted.
 *  A valid sidecar is used as a prefix; only its unindexed tail is scanned.
 *  Newly scanned offsets are appended as chunks, so a stale open does not
 *  rewrite or re-hash the dense prefix. */
async function indexOf(path: string): Promise<Index> {
  const file = await open(path, "r");
  try {
    const stats = await file.stat({ bigint: true });
    const size = Number(stats.size);
    const identity = identityOf(stats);
    const saved = await readSidecar(path, file, size, identity);
    let ends = saved?.ends ?? new Float64Array(0);
    let count = ends.length;
    const from = saved?.bytes ?? 0;
    let bytes = from;
    await readLines(file, from, size, undefined, (line) => {
      ends = growOffsets(ends, count + 1);
      bytes += Buffer.byteLength(line) + 1;
      ends[count] = bytes;
      count += 1;
    });
    const complete = ends.subarray(0, count);

    let sidecar: Index["sidecar"];
    if (saved) {
      const added = encodeChunks(complete, saved.count, count);
      try {
        // A crash can leave a partial final chunk. Drop only that unusable
        // tail; every byte of the valid indexed prefix survives.
        if (!saved.complete) await truncate(sidecarPath(path), saved.at);
        if (added.length > 0) await appendFile(sidecarPath(path), added);
        sidecar = { at: saved.at + added.length, count };
      } catch {
        // The next open pays for the rebuild instead.
      }
    } else {
      try {
        const data = encodeIndex(complete, identity);
        await writeFile(sidecarPath(path), data);
        sidecar = { at: data.length, count };
      } catch {
        // The next open pays for the rebuild instead.
      }
    }
    return { ends: complete, bytes, identity, sidecar };
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
