/**
 * The event log — story M2-2, issue #32.
 *
 * One bus listener per run, appending every event to
 * `.kapelle/runs/<runId>/events.jsonl` as `{seq, agent, update}`, one line
 * each. Decided at pickup (2026-09-14):
 *
 * **Raw, never coalesced.** Every `agent_message_chunk` is its own line, with
 * its `_meta`. Joined text cannot be split again; a reader who wants messages
 * joins them when reading. M0-4 measured 443 events in one opencode turn, so
 * a task is tens of kilobytes, and no compression is applied.
 *
 * **The file is the only replay source.** `follow` tails it from the reader's
 * own position, so history and the live tail come out of one loop and there
 * is no ring-to-file hand-off to get wrong. Memory holds a byte offset per
 * line, never the events.
 *
 * **A caught-up reader skips the disk.** Each committed line rings the
 * readers with the line itself, and a reader waiting for exactly that `seq`
 * sends it. A reader still on the file never matches: it reads up to what was
 * committed when it looked, so every bell it hears is for a later line, and
 * the loop goes back for it. The check and the send run on one thread with
 * nothing in between, which is why a second thread would add a race and no
 * speed — the write itself already runs on libuv's pool.
 *
 * **Committed, not appended.** A line counts once its write callback fires,
 * so no reader sees a line that is not on disk, or half of one.
 */

import { createWriteStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { finished } from "node:stream/promises";
import type { AgentEventEnvelope } from "../protocol/agent.ts";

const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

type Send = (seq: number, line: string) => void;

export interface EventLog {
  /** The bus listener. Ignored once the log is closed or has failed. */
  append: (event: AgentEventEnvelope) => void;
  /**
   * Sends every committed line after `after`, then each new one as it
   * commits, until the log closes or `signal` aborts. `line` has no newline.
   *
   * ponytail: `send` has no backpressure, so a client that stops reading
   * buffers the rest of the run in its socket. Pause on `res.write` returning
   * false if a slow viewer ever shows up in memory.
   */
  follow(after: number, send: Send, signal?: AbortSignal): Promise<void>;
  /** Lines committed so far — the highest `seq` any reader can have seen. */
  readonly size: number;
  /** Flushes what was appended and ends every reader once it has caught up. */
  close(): Promise<void>;
}

export function createEventLog(
  path: string,
  onError: (err: Error) => void,
): EventLog {
  const out = createWriteStream(path, { flags: "w" });
  /** `starts[seq - 1]` is where that line begins. */
  const starts: number[] = [];
  let appended = 0;
  let appendedBytes = 0;
  let committed = 0;
  let committedBytes = 0;
  let accepting = true;
  const bells = new Set<Send>();

  let markEnded = () => {};
  const ended = new Promise<void>((ok) => {
    markEnded = ok;
  });

  out.on("error", (err) => {
    // The run goes on without its durable copy, the same as a stderr log that
    // cannot be written (M1b-7). Readers end at what was committed.
    if (!accepting) return;
    accepting = false;
    onError(err);
    markEnded();
  });

  return {
    append(event) {
      if (!accepting) return;
      appended += 1;
      const seq = appended;
      const line = JSON.stringify({ seq, ...event });
      const bytes = Buffer.byteLength(line) + 1;
      starts.push(appendedBytes);
      appendedBytes += bytes;
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
      const bell: Send = (seq, line) => {
        // `signal` can abort while the reader is parked; the bell must go
        // quiet then, not on the microtask that removes it.
        if (seq !== next || signal?.aborted) return;
        send(seq, line);
        next += 1;
      };
      bells.add(bell);
      let file: FileHandle | undefined;
      try {
        while (next <= committed && !signal?.aborted) {
          file ??= await open(path, "r");
          const to = committedBytes;
          await readLines(file, starts[next - 1] ?? to, to, signal, (line) => {
            send(next, line);
            next += 1;
          });
        }
        if (signal?.aborted) return;
        if (accepting || committed < appended) {
          await Promise.race([ended, aborted(signal)]);
        }
      } finally {
        bells.delete(bell);
        await file?.close();
      }
    },

    get size() {
      return committed;
    },

    async close() {
      if (!accepting) return ended;
      accepting = false;
      out.end();
      await finished(out).catch(() => {});
      markEnded();
    },
  };
}

/** Sends each whole line in `[from, to)`; `to` always sits on a line end. */
async function readLines(
  file: FileHandle,
  from: number,
  to: number,
  signal: AbortSignal | undefined,
  onLine: (line: string) => void,
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
      onLine(data.toString("utf8", 0, nl));
      data = data.subarray(nl + 1);
      nl = data.indexOf(NEWLINE);
    }
    carry = Buffer.from(data);
  }
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise(() => {});
  return new Promise((ok) => {
    if (signal.aborted) ok();
    else signal.addEventListener("abort", () => ok(), { once: true });
  });
}
