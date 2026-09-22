/**
 * The version handshake — story M5-1, issue #133.
 *
 * The first contract test (B8): the daemon is a subprocess reached over real
 * HTTP, and the only thing read from this repository is `client/contract.ts`,
 * the same file a client would import.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { API_VERSION, CAPABILITIES } from "../../client/contract.ts";
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
  return { url: `http://127.0.0.1:${port}/version`, token };
}

test("GET /version answers the contract version and every capability", async (t) => {
  const { url, token } = await boot(t);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    apiVersion: { major: 1, minor: 0 },
    capabilities: ["repos", "runs", "events", "permissions", "rooms"],
  });
  // The literal above is the promise; these keep the constants honest to it.
  assert.deepEqual(API_VERSION, { major: 1, minor: 0 });
  assert.deepEqual(
    [...CAPABILITIES],
    ["repos", "runs", "events", "permissions", "rooms"],
  );
});

test("GET /version needs the token like every other route", async (t) => {
  const { url } = await boot(t);
  const res = await fetch(url);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "missing or wrong token" });
});
