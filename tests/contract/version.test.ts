/**
 * The version handshake — story M5-1, issue #133.
 *
 * The first contract test (B8): the daemon is a subprocess reached over real
 * HTTP, and the only thing read from this repository is `client/contract.ts`,
 * the same file a client would import.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  API_VERSION,
  CAPABILITIES,
  type ErrorReply,
} from "../../client/contract.ts";
import { spawnCli, tempDir } from "../../integration/helpers.ts";

async function boot(t: TestContext) {
  const dir = await tempDir(t);
  const d = spawnCli(t, ["--port", "0"], "daemon.ts", {
    XDG_RUNTIME_DIR: dir,
    XDG_STATE_HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config-home"),
  });
  await d.waitFor("listening on ");
  const { port, token } = JSON.parse(
    await readFile(join(dir, "kapelle", "daemon.json"), "utf8"),
  );
  return { url: `http://127.0.0.1:${port}/version`, port, token };
}

/** `fetch` takes the Host from the URL, so a forged Host needs node:http. */
function versionReply(port: number, headers: Record<string, string>) {
  return new Promise<{ status: number; body: ErrorReply }>(
    (resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path: "/version", headers },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

test("GET /version answers the contract version and every capability", async (t) => {
  const { url, token } = await boot(t);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), {
    apiVersion: { major: 1, minor: 14 },
    capabilities: ["repos", "runs", "events", "permissions", "rooms"],
  });
  // The literal above is the promise; these keep the constants honest to it.
  assert.deepEqual(API_VERSION, { major: 1, minor: 14 });
  assert.deepEqual(
    [...CAPABILITIES],
    ["repos", "runs", "events", "permissions", "rooms"],
  );
});

test("GET /version needs the token like every other route", async (t) => {
  const { url, token } = await boot(t);
  const missing = await fetch(url);
  assert.equal(missing.status, 401);
  const missingBody = (await missing.json()) as ErrorReply;
  assert.equal(missingBody.error.code, "unauthorized");

  const wrong = await fetch(url, {
    headers: { authorization: "Bearer not-a-real-token" },
  });
  assert.equal(wrong.status, 401);
  const wrongBody = (await wrong.json()) as ErrorReply;
  assert.equal(wrongBody.error.code, "unauthorized");

  // The real token still works, so the refusals above are not a broken route.
  const good = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(good.status, 200);
});

test("GET /version is behind the Host guard", async (t) => {
  const { port, token } = await boot(t);
  const forged = await versionReply(port, {
    Host: "evil.example",
    authorization: `Bearer ${token}`,
  });
  assert.equal(forged.status, 403);
  // The doc promises `{error}` on every refusal, this one included.
  assert.equal(forged.body.error.code, "host_not_allowed");
});

test("POST /version is a 404 with an {error} body", async (t) => {
  const { url, token } = await boot(t);
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as ErrorReply;
  assert.equal(body.error.code, "no_route");
  assert.equal(typeof body.error.message, "string");
});
