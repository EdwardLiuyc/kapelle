/**
 * The daemon's HTTP edge, called directly — `daemon/http.ts`.
 *
 * `tests/daemon.test.ts` and `tests/contract/errors.test.ts` prove these over
 * real sockets. This file calls each guard with a fake request, so every
 * branch is one line to stage: the RFC shapes of the `Host` guard (M2-8), the
 * token compare, and the body reader's refusal order (M5-3).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  authorised,
  digest,
  existingDir,
  hostAllowed,
  Refusal,
  readBody,
} from "../http.ts";

/** A request with only the fields the guards read. `rawHeaders` is built from
 *  `raw` so a duplicated header can be staged; `headers` keeps the first, as
 *  Node does. */
function fakeReq(url: string, raw: [string, string][] = []): IncomingMessage {
  const headers: Record<string, string> = {};
  for (const [k, v] of raw) headers[k.toLowerCase()] ??= v;
  return { url, rawHeaders: raw.flat(), headers } as unknown as IncomingMessage;
}

test("hostAllowed admits every loopback spelling, with or without a port", () => {
  for (const host of [
    "127.0.0.1",
    "127.0.0.1:4719",
    "localhost",
    "LOCALHOST:1",
    "localhost.",
    "[::1]",
    "[::1]:4719",
  ]) {
    assert.equal(hostAllowed(fakeReq("/runs", [["Host", host]])), true, host);
  }
});

test("hostAllowed ignores the port, by decision (M2-8)", () => {
  // Rebinding needs an attacker-chosen name, not a port, so a loopback name on
  // any port passes. `hostAllowed` never learns which port the daemon is on.
  for (const host of ["127.0.0.1:9999", "localhost:1", "[::1]:65535"]) {
    assert.equal(hostAllowed(fakeReq("/runs", [["Host", host]])), true, host);
  }
});

test("hostAllowed refuses a forged, folded or missing Host", () => {
  for (const host of [
    "evil.example",
    "localhoſt",
    "127.0.0.2",
    "localhost.evil",
  ]) {
    assert.equal(hostAllowed(fakeReq("/runs", [["Host", host]])), false, host);
  }
  assert.equal(hostAllowed(fakeReq("/runs")), false, "no Host at all");
});

test("hostAllowed refuses two Host lines, even when the first is loopback", () => {
  const req = fakeReq("/runs", [
    ["Host", "127.0.0.1"],
    ["host", "evil.example"],
  ]);
  assert.equal(hostAllowed(req), false);
});

test("hostAllowed reads an absolute-form target over the Host line", () => {
  const forged = fakeReq("http://evil.example/runs", [["Host", "127.0.0.1"]]);
  assert.equal(hostAllowed(forged), false);
  const loop = fakeReq("http://127.0.0.1:4719/runs", [
    ["Host", "evil.example"],
  ]);
  assert.equal(hostAllowed(loop), true);
});

test("authorised accepts only the exact bearer token", () => {
  const expected = digest("s3cret");
  const with_ = (auth?: string) =>
    authorised(
      fakeReq("/", auth === undefined ? [] : [["Authorization", auth]]),
      expected,
    );
  assert.equal(with_("Bearer s3cret"), true);
  assert.equal(with_("Bearer s3cre"), false);
  assert.equal(with_("bearer s3cret"), false);
  assert.equal(with_("s3cret"), false);
  assert.equal(with_(), false);
});

/** A body as a stream, with the headers `readBody` reads. */
function body(chunks: Buffer[], headers: Record<string, string> = {}) {
  return Object.assign(Readable.from(chunks), {
    headers: { "content-type": "application/json", ...headers },
  }) as unknown as IncomingMessage;
}

async function refused(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof Refusal);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

test("readBody parses an object, even with a character split across chunks", async () => {
  const bytes = Buffer.from('{"text":"é"}');
  const at = bytes.indexOf(0xc3) + 1;
  const got = await readBody(
    body([bytes.subarray(0, at), bytes.subarray(at)]),
    ["text"],
  );
  assert.deepEqual(got, { text: "é" });
});

test("readBody accepts a charset parameter on Content-Type", async () => {
  const req = body([Buffer.from("{}")], {
    "content-type": "Application/JSON; charset=utf-8",
  });
  assert.deepEqual(await readBody(req, []), {});
});

test("readBody refuses in order: 415, 413, 400", async () => {
  await refused(
    readBody(body([Buffer.from("{}")], { "content-type": "text/plain" }), []),
    415,
    "unsupported_media_type",
  );
  await refused(
    readBody(body([], { "content-length": String(4 * 1024 * 1024 + 1) }), []),
    413,
    "body_too_large",
  );
  await refused(readBody(body([Buffer.from("{")]), []), 400, "invalid_request");
  await refused(
    readBody(body([Buffer.from("[]")]), []),
    400,
    "invalid_request",
  );
  await refused(
    readBody(body([Buffer.from("null")]), []),
    400,
    "invalid_request",
  );
  await refused(
    readBody(body([Buffer.from('{"path":"/","x":1}')]), ["path"]),
    400,
    "invalid_request",
  );
});

test("readBody counts a body sent without Content-Length", async () => {
  const mib = Buffer.alloc(1024 * 1024, 0x20);
  await refused(
    readBody(body([mib, mib, mib, mib, Buffer.from(" ")]), []),
    413,
    "body_too_large",
  );
});

test("existingDir returns the real path of a folder, else a 400", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kapelle-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = existingDir(dir, "cwd");
  const link = join(dir, "link");
  symlinkSync(real, link);
  assert.equal(existingDir(link, "cwd"), real);

  const file = join(dir, "f");
  writeFileSync(file, "");
  for (const bad of ["relative/path", file, join(dir, "missing"), 5]) {
    assert.throws(
      () => existingDir(bad, "cwd"),
      (err) => err instanceof Refusal && err.status === 400,
      String(bad),
    );
  }
});
