/**
 * The event stream, read with reconnect — story M5-6 (#138), decision F3.
 *
 * The daemon keeps no cursor for a client. Every event carries its `seq`, and
 * this reader remembers the last one it passed on. After a cut it connects
 * again with that number in `Last-Event-ID`, so the daemon replays from the
 * next event, and any event at or below it is dropped (F4). Nothing is saved
 * to disk: a new process starts from `seq` 0 and rebuilds from the replay.
 *
 * **A cut is any of these:** the connection fails, the body errors before its
 * end, or no byte arrives for `silenceMs` — the daemon pings every 15 s, so 45 s
 * of silence means a daemon that hangs. The wait between tries doubles from
 * 250 ms up to 5 s, and goes back to 250 ms once a connection gets data. Not
 * on the connect itself: a daemon can answer `200` and then cut the stream at
 * once (its event file is gone, say), and that must still back off.
 *
 * **The silence timer runs only while the caller reads.** It is re-armed as
 * bytes are read, and bytes are read only while the caller pulls the next
 * event. So a caller that holds an event for more than `silenceMs` cuts its
 * own stream, and the reader reconnects. `attach` never holds one: its asks
 * run beside the loop, not in it. A caller that must wait, such as a TUI,
 * reads into its own queue.
 *
 * **When to stop is the caller's `connect`.** It returns `undefined` when the
 * daemon stopped on purpose (the CLI: `daemon.json` is gone), and the reader
 * throws `StreamClosed`. Any refusal (a status that is not 2xx) and a
 * malformed event also throw: trying again gets the same answer. Only a clean
 * end of the body is the end of the stream.
 *
 * The SSE parser lives here too. `daemon.ts` beside it is the rest of the
 * transport (M5-10a): `daemon.json`, the HTTP calls and the version check.
 */

import type { ErrorReply, EventLine } from "./contract.ts";

const SILENCE_MS = 45_000;
const FIRST_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;

/** Opens the stream after `after`, or `undefined` when there is no daemon to
 *  wait for. A throw is a failed try, and the reader tries again. */
export type Connect = (
  after: number,
  signal: AbortSignal,
) => Promise<Response | undefined>;

/** Thrown when the reader stops for good: the daemon stopped, or it refused
 *  the stream. */
export class StreamClosed extends Error {}

export interface FollowOptions {
  /** Called after each connect that the daemon accepts. */
  onConnect?: () => void;
  /** Called with the cut, before the wait for the next try. */
  onRetry?: (err: unknown) => void;
  silenceMs?: number;
}

/** `T` is `RoomEventLine` for a room's stream; the reader needs only `seq`. */
export async function* followEvents<T extends { seq: number } = EventLine>(
  connect: Connect,
  { onConnect, onRetry, silenceMs = SILENCE_MS }: FollowOptions = {},
): AsyncGenerator<T> {
  let last = 0;
  let delay = FIRST_DELAY_MS;
  for (;;) {
    const cut = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => cut.abort(new Error(`no data for ${silenceMs / 1000} s`)),
        silenceMs,
      );
    };
    try {
      arm();
      const res = await connect(last, cut.signal);
      if (res === undefined) throw new StreamClosed("the daemon stopped");
      if (!res.ok || !res.body) throw new StreamClosed(await refusalOf(res));
      onConnect?.();
      const heard = () => {
        delay = FIRST_DELAY_MS;
        arm();
      };
      for await (const event of sseEvents<T>(res.body, heard, cut.signal)) {
        if (event.seq <= last) continue;
        last = event.seq;
        yield event;
      }
      return;
    } catch (err) {
      if (err instanceof StreamClosed) throw err;
      onRetry?.(cut.signal.aborted ? cut.signal.reason : err);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((ok) => setTimeout(ok, delay));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

/**
 * The events of an SSE body, as `core/eventlog.ts` wrote them. `onBytes`
 * runs for every chunk, pings included. A body cut before its end, or an
 * abort of `signal`, throws.
 */
async function* sseEvents<T>(
  body: ReadableStream<Uint8Array>,
  onBytes: () => void = () => {},
  signal?: AbortSignal,
): AsyncGenerator<T> {
  let buffered = "";
  // `signal` errors the pipe itself, so a quiet body ends even when the
  // fetch that made it did not get the signal.
  for await (const text of body.pipeThrough(new TextDecoderStream(), {
    signal,
  })) {
    onBytes();
    buffered += text;
    let end = buffered.indexOf("\n\n");
    while (end !== -1) {
      for (const line of buffered.slice(0, end).split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          yield JSON.parse(line.slice(6));
        } catch {
          // Not a cut: the daemon sends only whole lines, and a replay would
          // send the same one again, so a retry could never get past it.
          throw new StreamClosed("malformed event from the daemon stream");
        }
      }
      buffered = buffered.slice(end + 2);
      end = buffered.indexOf("\n\n");
    }
  }
}

async function refusalOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as Partial<ErrorReply>;
  return body.error?.message ?? `HTTP ${res.status}`;
}
