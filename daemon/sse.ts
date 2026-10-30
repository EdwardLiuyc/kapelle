/**
 * The event stream as SSE — stories M2-2 and M5-6 (#138), split out of
 * `daemon.ts` so tests can import it.
 *
 * Decided at pickup (2026-09-24):
 *
 * **A ping every 15 s** (F1). A `: ping` comment line, which an SSE client
 * ignores. It lets a client tell a quiet run from a daemon that hangs: the
 * reference client reconnects after 45 s with no bytes. Fixed, with no config
 * key. No `retry:` line (F2): only a browser `EventSource` reads it, and the
 * browser path is retired.
 *
 * **A full socket pauses the reader** (F5, F6). `res.write` returning false
 * hands `follow` a promise for `drain`, and `follow` reads nothing more until
 * then. There is no disconnect: a client that stops reading holds one socket
 * and its buffer, and the event file keeps the rest. No ping is written while
 * the socket is full (F7), so a ping cannot grow that buffer either.
 */

import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventLog } from "../core/eventlog.ts";
import { refusal } from "./http.ts";

const PING_MS = 15_000;

/** SSE over one event log: replay after `Last-Event-ID`, then the live tail,
 *  ending when the log closes. Shared by runs and rooms. `keep` skips a line
 *  it answers false for, which is how one participant's view of a room log
 *  is served (M6-4); `seq` stays the log's. */
export async function streamLog(
  log: EventLog,
  req: IncomingMessage,
  res: ServerResponse,
  signal: AbortSignal,
  {
    pingMs = PING_MS,
    keep,
  }: { pingMs?: number; keep?: (line: string) => boolean } = {},
) {
  const header = req.headers["last-event-id"];
  const after = header === undefined ? 0 : Number(header);
  if (!Number.isInteger(after) || after < 0 || after > log.size) {
    throw refusal(
      400,
      "invalid_request",
      `Last-Event-ID must be a whole number from 0 to ${log.size}; got ${header}`,
    );
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    // A clean stop ends this stream after `server.close()`. Do not let the
    // client reuse the socket for the reconcile that follows (#390).
    connection: "close",
  });
  // Headers go out now, not on the first write: a reconnecting client whose
  // `Last-Event-ID` is already the tail has no history to replay, and without
  // this it would sit in "connecting" until the next event.
  res.flushHeaders();
  const ping = setInterval(() => {
    if (!res.writableNeedDrain) res.write(": ping\n\n");
  }, pingMs);
  try {
    await log.follow(
      after,
      (seq, line) => {
        if (keep && !keep(line)) return undefined;
        return res.write(`id: ${seq}\ndata: ${line}\n\n`)
          ? undefined
          : // A socket error ends the wait too; `signal` then stops the reader
            // on `close`. A rejection here would be unhandled once `follow`
            // stopped waiting.
            once(res, "drain").then(
              () => {},
              () => {},
            );
      },
      signal,
    );
  } catch {
    // Headers are sent, so no error body can follow. A cut stream is what
    // tells an SSE client to reconnect with its `Last-Event-ID`.
    res.destroy();
    return;
  } finally {
    clearInterval(ping);
  }
  res.end();
}
