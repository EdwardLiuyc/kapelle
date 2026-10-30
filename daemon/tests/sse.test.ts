/**
 * The event stream over a real socket — `daemon/sse.ts`, story M5-6 (#138).
 *
 * `tests/daemon-runs.test.ts` proves replay and `Last-Event-ID` through a whole
 * daemon. This file serves one log from a bare HTTP server, so it can shorten
 * the ping and read the server's own socket buffer while a client stalls.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import {
  Agent,
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
    if (req.url !== "/") {
      res.end("served");
      return;
    }
    served.res = res;
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    void streamLog(log, req, res, gone.signal, { pingMs });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(async () => {
    await log.close();
    server.closeAllConnections();
    if (server.listening) server.close();
  });
  const { port } = server.address() as AddressInfo;
  const open = (agent?: Agent) =>
    new Promise<IncomingMessage>((ok, fail) => {
      get({ port, host: "127.0.0.1", agent }, ok).on("error", fail);
    });
  return { log, served, open, server, port };
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

test("a stopped server cannot answer on the socket its stream just ended", async (t) => {
  const { log, open, server, port } = await serve(t, 60_000);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const res = await open(agent);
  res.resume();
  const closed = new Promise<void>((ok) => server.close(() => ok()));
  const answer = new Promise<string | number>((ok) => {
    res.on("end", () => {
      get({ port, host: "127.0.0.1", path: "/rooms/r1", agent }, (reply) => {
        reply.resume();
        ok(reply.statusCode ?? 0);
      }).on("error", (err: NodeJS.ErrnoException) =>
        ok(err.code ?? err.message),
      );
    });
  });

  // A clean stop ends the stream after closing the listener. The reconcile
  // that follows must not ride the stream's keep-alive socket back in.
  await log.close();
  const reply = await answer;
  agent.destroy();
  await closed;
  assert.equal(
    typeof reply,
    "string",
    `the old daemon answered the reconcile (HTTP ${reply})`,
  );
});

test("a client that stops reading holds one socket buffer, then gets every event once", async (t) => {
  const { log, served, open } = await serve(t, 60_000);
  const res = await open();
  res.pause();
  const text = `${"x".repeat(10_000)}`;
  const events = 500; // about 5 MB, far past Node's buffer
  // Sample the daemon's own buffer the whole time. Not `writableNeedDrain`:
  // the kernel keeps taking bytes from a paused client, several MB on
  // loopback, so whether Node ever reports "full" is the kernel's call, and
  // under load it did not (a flaky wait). The buffer is what the pause bounds.
  let most = 0;
  const sample = setInterval(() => {
    most = Math.max(most, served.res?.writableLength ?? 0);
  }, 2);
  for (let i = 0; i < events; i++) {
    log.append({
      agent: "t0",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }
  await until(() => log.size === events, "the events to commit", 30_000);
  await new Promise((r) => setTimeout(r, 200));
  clearInterval(sample);
  // Node's buffer, not the kernel's: the high-water mark (64 KiB on Node 24)
  // plus the one event that crossed it. Without the pause it held the run.
  const res0 = served.res as ServerResponse;
  const bound = res0.writableHighWaterMark + text.length + 1_000;
  assert.ok(most < bound, `the daemon buffered ${most} bytes, over ${bound}`);

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
  await until(() => ids.length >= events, "every event", 30_000);
  assert.deepEqual(
    ids,
    Array.from({ length: events }, (_, i) => i + 1),
  );
  res.destroy();
});

test("no ping while the socket reports full, and retry: is never sent", async (t) => {
  const { log, served, open } = await serve(t, 20);
  const res = await open();
  const res0 = served.res as ServerResponse;

  // Pin the one thing the ping guard reads. A paused client does not freeze
  // the kernel buffer, so `writableNeedDrain` can drop on its own and make a
  // race flaky; F7 is a property of the guard, so hold it true.
  Object.defineProperty(res0, "writableNeedDrain", {
    configurable: true,
    get: () => true,
  });
  const writes: string[] = [];
  const target = res0 as unknown as {
    write(chunk: string, ...rest: unknown[]): boolean;
  };
  const original = target.write.bind(res0);
  target.write = (chunk, ...rest) => {
    writes.push(chunk);
    return original(chunk, ...rest);
  };

  for (const text of ["a", "b"]) {
    log.append({
      agent: "t0",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }
  await until(() => log.size === 2, "the events to commit");
  await new Promise((r) => setTimeout(r, 150)); // several 20 ms ping intervals
  assert.deepEqual(
    writes.filter((chunk) => chunk.includes(": ping")),
    [],
    "no ping while the socket is full",
  );

  // Not full any more: the ping must come back, and nothing ever writes
  // `retry:` (F2).
  Reflect.deleteProperty(res0, "writableNeedDrain");
  let received = "";
  res.setEncoding("utf8");
  res.on("data", (s: string) => {
    received += s;
  });
  res.resume();
  await until(() => received.includes(": ping\n\n"), "a ping once not full");
  assert.ok(!received.includes("retry:"), "no retry: line on the wire");
  res.destroy();
});
