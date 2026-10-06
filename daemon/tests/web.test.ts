/**
 * The browser page's daemon side, called directly — `daemon/web.ts`
 * (spike/pwa): which files the page path reaches, the one-time login
 * code, and the `.ts` a browser gets.
 */

import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { test } from "node:test";

import { loginCodes, serveApp, toBrowser } from "../web.ts";

/** A `GET` of `path`: its status and its headers, or `undefined` when it
 *  is no page path. */
function get(path: string) {
  let status = 0;
  let headers: Record<string, string> = {};
  const res = {
    writeHead(s: number, h: Record<string, string>) {
      status = s;
      headers = h;
    },
    end() {},
  } as unknown as ServerResponse;
  return serveApp(path, res) ? { status, headers } : undefined;
}

test("the page and its listed files are served, with the CSP", () => {
  for (const path of [
    "/app/",
    "/app/app.js",
    "/app/shim/util.js",
    "/app/client/room.ts",
    "/app/chat/view.ts",
    "/app/vendor/marked.js",
  ]) {
    const r = get(path);
    assert.equal(r?.status, 200, path);
    assert.match(
      r.headers["content-security-policy"] ?? "",
      /script-src 'self';/,
    );
  }
  assert.equal(get("/app")?.status, 308);
});

test("nothing outside the listed folders is served", () => {
  for (const path of [
    "/app/client/tests/room.test.ts",
    "/app/client/../daemon.ts",
    "/app/core/policy.ts",
    "/app/chat/tui.ts",
    "/app/.env",
    "/app/web.ts",
    "/app/shim/../../daemon.ts",
    "/app/vendor/other.js",
    "/app/client/room.ts/x",
  ]) {
    assert.equal(get(path)?.status, 404, path);
  }
  // Not a page path: the token check and the API routes get it.
  assert.equal(get("/rooms"), undefined);
  assert.equal(get("/application"), undefined);
});

test("a login code works once, and not after 60 s", () => {
  let now = 0;
  const codes = loginCodes(() => now);
  const a = codes.make();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(codes.take(a), true);
  assert.equal(codes.take(a), false);
  const b = codes.make();
  now = 60_001;
  assert.equal(codes.take(b), false);
  assert.equal(codes.take(undefined), false);
  assert.equal(codes.take(""), false);
});

test("a .ts file loses its types and gets the browser stand-ins", () => {
  const js = toBrowser(
    'import { readFile } from "node:fs/promises";\n' +
      'import { parseArgs } from "node:util";\n' +
      'import type { X } from "./x.ts";\n' +
      "const n: number = 1;\n",
  );
  assert.match(js, /from "\/app\/shim\/fs-promises\.js"/);
  assert.match(js, /from "\/app\/shim\/util\.js"/);
  assert.doesNotMatch(js, /node:|import type|: number/);
});
