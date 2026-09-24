/**
 * The event stream over a real socket — `daemon/sse.ts`, story M5-6 (#138).
 *
 * `tests/daemon.test.ts` proves replay and `Last-Event-ID` through a whole
 * daemon. This file serves one log from a bare HTTP server, so it can shorten
 * the ping and read the server's own socket buffer while a client stalls.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  get,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createEventLog, type EventLog } from "../../core/eventlog.ts";
import { streamLog } from "../sse.ts";

/** One live log served at `/`, and the server's side of the last response. */
async function serve(t: TestContext, pingMs: number) {
  const dir = await mkdtemp(join(tmpdir(), "kapelle-sse-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log: EventLog = createEventLog(join(dir, "events.jsonl"), (err) => {
    throw err;
  });
  const served: { res?: ServerResponse } = {};
  const server = createServer((req, res) => {
    served.res = res;
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    void streamLog(log, req, res, gone.signal, pingMs);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(async () => {
    await log.close();
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const open = () =>
    new Promise<IncomingMessage>((ok, fail) => {
      get({ port, host: "127.0.0.1" }, ok).on("error", fail);
    });
  return { log, served, open };
}

const until = async (ok: () => boolean, what: string, ms = 5_000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test("an idle stream gets a ping comment", async (t) => {
  const { open } = await serve(t, 50);
  const res = await open();
  let text = "";
  res.setEncoding("utf8");
  res.on("data", (s: string) => {
    text += s;
  });
  await until(() => text.includes(": ping\n\n"), "a ping");
  res.destroy();
});

test("a client that stops reading holds one socket buffer, then gets every event once", async (t) => {
  const { log, served, open } = await serve(t, 60_000);
  const res = await open();
  res.pause();
  const text = `${"x".repeat(10_000)}`;
  const events = 500; // about 5 MB, far past any socket buffer
  for (let i = 0; i < events; i++) {
    log.append({
      agent: "t0",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }
  await until(() => log.size === events, "the events to commit");
  await until(() => served.res?.writableNeedDrain === true, "a full socket");
  await new Promise((r) => setTimeout(r, 100));
  // Node's buffer, not the kernel's: the high-water mark (64 KiB on Node 24)
  // plus the one event that crossed it. Without the pause it held the run.
  const res0 = served.res as ServerResponse;
  const bound = res0.writableHighWaterMark + text.length + 1_000;
  assert.ok(
    res0.writableLength < bound,
    `the daemon buffered ${res0.writableLength} bytes, over ${bound}`,
  );

  const ids: number[] = [];
  let buffered = "";
  res.setEncoding("utf8");
  res.on("data", (s: string) => {
    buffered += s;
    // Whole blocks only: an `id:` line whose block is still arriving would
    // be counted again with the rest of it.
    const last = buffered.lastIndexOf("\n\n");
    if (last === -1) return;
    const end = last + 2;
    for (const m of buffered.slice(0, end).matchAll(/^id: (\d+)$/gm)) {
      ids.push(Number(m[1]));
    }
    buffered = buffered.slice(end);
  });
  res.resume();
  await until(() => ids.length >= events, "every event");
  assert.deepEqual(
    ids,
    Array.from({ length: events }, (_, i) => i + 1),
  );
  res.destroy();
});
