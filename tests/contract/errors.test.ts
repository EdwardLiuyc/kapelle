/**
 * Error envelopes and request limits — story M5-3, issue #135.
 *
 * A client switches on `error.code`, never on the prose (C7); a write with a
 * field its route does not take is refused (C8); a body that is not JSON by
 * `Content-Type` is a 415 (J2), and one over 4 MiB a 413 before it is held
 * in memory (J1). The route-specific codes are asserted beside the tests of
 * their routes in `tests/daemon.test.ts`; this file holds the ones every
 * write shares. The daemon is a real subprocess reached over HTTP.
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import type { ErrorReply } from "../../client/contract.ts";
import {
  daemonApi as api,
  bootDaemon as boot,
  type Daemon,
  MOCK_AGENT,
  tempDir,
} from "../../integration/helpers.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function added(d: Daemon, dir: string): Promise<string> {
  const r = await api<{ root: string }>(d, "POST", "/repos", { path: dir });
  assert.equal(r.status, 200);
  return r.body.root;
}

/** A raw POST whose headers say whatever the test wants. */
async function post(
  d: Daemon,
  path: string,
  headers: Record<string, string>,
  body: RequestInit["body"],
) {
  const res = await fetch(d.url + path, {
    method: "POST",
    headers: { authorization: `Bearer ${d.token}`, ...headers },
    body,
    duplex: "half",
  } as RequestInit);
  return { status: res.status, body: (await res.json()) as ErrorReply };
}

test("a body not sent as application/json is 415, and a charset is fine", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const body = JSON.stringify({ path: cwd });

  // `fetch` sends text/plain for a string body, and `curl -d` a form type:
  // both are the mistake this refusal names.
  for (const type of [undefined, "application/x-www-form-urlencoded"]) {
    const r = await post(
      d,
      "/repos",
      type ? { "content-type": type } : {},
      body,
    );
    assert.equal(r.status, 415, type);
    assert.equal(r.body.error.code, "unsupported_media_type");
    assert.match(r.body.error.message, /application\/json/);
  }

  const charset = await post(
    d,
    "/repos",
    { "content-type": "Application/JSON; charset=utf-8" },
    body,
  );
  assert.equal(charset.status, 200);
});

test("a body over 4 MiB is 413, whether or not it says its length", async (t) => {
  const d = await boot(t);
  const json = { "content-type": "application/json" };

  // Chunked: no Content-Length, so the daemon counts as the body arrives.
  const big = new Blob([`{"path":"${"a".repeat(MAX_BODY_BYTES)}"}`]);
  const chunked = await post(d, "/repos", json, big.stream());
  assert.equal(chunked.status, 413);
  assert.equal(chunked.body.error.code, "body_too_large");

  // Declared: the headers alone are refused. Not one byte of the body is
  // sent, so a reply proves the daemon never waited to buffer it.
  const { port } = new URL(d.url);
  const declared = await new Promise<{ status: number; body: ErrorReply }>(
    (ok, fail) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/repos",
          method: "POST",
          headers: {
            authorization: `Bearer ${d.token}`,
            ...json,
            "content-length": String(MAX_BODY_BYTES + 1),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => {
            text += c;
          });
          res.on("end", () =>
            ok({ status: res.statusCode ?? 0, body: JSON.parse(text) }),
          );
        },
      );
      req.on("error", fail);
      req.flushHeaders();
    },
  );
  assert.equal(declared.status, 413);
  assert.equal(declared.body.error.code, "body_too_large");

  // The daemon still serves after both refusals.
  assert.equal((await api(d, "GET", "/repos")).status, 200);
});

test("after a 413, the rest of an upload with no length is still read", async (t) => {
  // The daemon answers once the count passes 4 MiB, then must keep reading
  // and discard the rest. Destroying the request instead left the rest
  // unread: the upload stalled after 8 MiB (measured 2026-09-23), and a
  // client that reads the reply only after its upload would hang.
  const d = await boot(t);
  const { port } = new URL(d.url);
  const socket = connect(Number(port), "127.0.0.1");
  t.after(() => socket.destroy());
  await new Promise((ok) => socket.once("connect", ok));
  let reply = "";
  socket.on("data", (c) => {
    reply += c;
  });
  socket.write(
    "POST /repos HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
      `Authorization: Bearer ${d.token}\r\n` +
      "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
  );
  const mib = Buffer.alloc(1024 * 1024, 97);
  const total = 64;
  let sent = 0;
  for (; sent < total; sent++) {
    socket.write("100000\r\n");
    socket.write(mib);
    if (socket.write("\r\n")) continue;
    const drained = await Promise.race([
      new Promise((ok) => socket.once("drain", () => ok(true))),
      new Promise((ok) => setTimeout(() => ok(false), 2000)),
    ]);
    if (!drained) break;
  }
  assert.equal(sent, total, `the upload stalled after ${sent} MiB`);
  assert.match(reply, /^HTTP\/1\.1 413 /);
  assert.match(reply, /"body_too_large"/);
});

test("every write refuses a field its route does not take", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const run = {
    cmd: `node ${MOCK_AGENT}`,
    mode: "auto",
    tasks: [{ id: "one", prompt: "hi" }],
  };
  // An empty room: the refusals below come before any harness is needed.
  const room = await api<{ id: string }>(d, "POST", "/rooms", { cwd });
  assert.equal(room.status, 201);

  const writes: [string, Record<string, unknown>][] = [
    ["/repos", { path: cwd }],
    ["/runs", { cwd, run }],
    ["/rooms", { cwd }],
    [`/rooms/${room.body.id}/messages`, { text: "hi" }],
    ["/permissions/nope", { allow: true }],
  ];
  for (const [path, body] of writes) {
    const r = await api<ErrorReply>(d, "POST", path, { ...body, extra: 1 });
    assert.equal(r.status, 400, path);
    assert.equal(r.body.error.code, "invalid_request", path);
    assert.match(r.body.error.message, /unknown field "extra"/, path);
  }
  // Nothing was started by a refused write.
  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
  // Dismissed here, not in `t.after`: the daemon's own hook, registered
  // first, would already have stopped it.
  assert.equal(
    (await api(d, "POST", `/rooms/${room.body.id}/dismiss`)).status,
    200,
  );
});

test("a body that is not a JSON object is invalid_request", async (t) => {
  const d = await boot(t);
  const json = { "content-type": "application/json" };
  for (const body of ["{", "[]", "null"]) {
    const r = await post(d, "/repos", json, body);
    assert.equal(r.status, 400, body);
    assert.equal(r.body.error.code, "invalid_request", body);
  }
});

test("a body of exactly 4 MiB is read, and one byte more is refused", async (t) => {
  const d = await boot(t);
  const json = { "content-type": "application/json" };
  const prefix = '{"path":"';
  const suffix = '"}';
  const exact =
    prefix +
    "a".repeat(MAX_BODY_BYTES - prefix.length - suffix.length) +
    suffix;
  assert.equal(Buffer.byteLength(exact), MAX_BODY_BYTES);

  // Read to the end, then refused by the path validator: the cap is "at
  // most 4 MiB", so this must not be the 413.
  const atCap = await post(d, "/repos", json, exact);
  assert.equal(atCap.status, 400);
  assert.equal(atCap.body.error.code, "invalid_request");

  const over = `${exact} `;
  assert.equal(Buffer.byteLength(over), MAX_BODY_BYTES + 1);
  const refused = await post(d, "/repos", json, over);
  assert.equal(refused.status, 413);
  assert.equal(refused.body.error.code, "body_too_large");
});

test("every write refuses a body that is not application/json", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await tempDir(t));
  const run = {
    cmd: `node ${MOCK_AGENT}`,
    mode: "auto",
    tasks: [{ id: "one", prompt: "hi" }],
  };
  // An empty room: the refusals below come before any harness is needed.
  const room = await api<{ id: string }>(d, "POST", "/rooms", { cwd });
  assert.equal(room.status, 201);

  const writes: [string, Record<string, unknown>][] = [
    ["/repos", { path: cwd }],
    ["/runs", { cwd, run }],
    ["/rooms", { cwd }],
    [`/rooms/${room.body.id}/messages`, { text: "hi" }],
    ["/permissions/nope", { allow: true }],
  ];
  for (const [path, body] of writes) {
    const r = await post(
      d,
      path,
      { "content-type": "text/plain" },
      JSON.stringify(body),
    );
    assert.equal(r.status, 415, path);
    assert.equal(r.body.error.code, "unsupported_media_type", path);
  }
  assert.equal(
    (await api(d, "POST", `/rooms/${room.body.id}/dismiss`)).status,
    200,
  );
});
