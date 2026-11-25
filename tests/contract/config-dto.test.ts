/**
 * The config DTO — story M12-3, issue #534.
 *
 * `GET`, `PATCH` and `PUT /config` share `sendConfig`, so this drives all
 * three through a real daemon and pins every reply and row key to
 * `client/contract.ts`. Permission replies stay unit-covered in
 * `daemon/tests/dto.test.ts`: staging an open ask needs a live harness, and
 * the existing daemon suites already drive those routes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ConfigRow, ConfigView } from "../../client/contract.ts";
import {
  addRepo,
  daemonApi as api,
  bootDaemon as boot,
  gitRepo,
} from "../../integration/helpers.ts";

/** Every key `ConfigView` declares; a reply may not carry any other. */
const CONFIG_KEYS = new Set(
  Object.keys({
    root: 0,
    path: 0,
    rows: 0,
    invalid: 0,
  } satisfies Record<keyof ConfigView, 0>),
);

/** Every key `ConfigRow` declares, held to the type the same way. */
const CONFIG_ROW_KEYS = new Set(
  Object.keys({
    key: 0,
    value: 0,
    source: 0,
    default: 0,
    file: 0,
    env: 0,
  } satisfies Record<keyof ConfigRow, 0>),
);

function assertConfigReply(reply: ConfigView, label: string): void {
  for (const key of Object.keys(reply)) {
    assert.ok(CONFIG_KEYS.has(key), `${label} carries unknown key ${key}`);
  }
  for (const row of reply.rows) {
    for (const key of Object.keys(row)) {
      assert.ok(
        CONFIG_ROW_KEYS.has(key),
        `${label} row ${row.key} carries unknown key ${key}`,
      );
    }
  }
  assert.equal("invalid" in reply, false, `${label} carries an absent gap`);
}

test("GET, PATCH and PUT /config carry only contract keys", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t, {
    files: { ".kapelle/config.json": '{"maxConcurrency": 2}\n' },
  });
  const cwd = await addRepo(d, root);
  const query = `/config?cwd=${encodeURIComponent(cwd)}`;

  const got = await api<ConfigView>(d, "GET", query);
  const patched = await api<ConfigView>(d, "PATCH", query, { ttlMs: 5000 });
  const replaced = await api<ConfigView>(d, "PUT", query, {
    stallIdleMs: 1000,
  });

  for (const [label, reply] of [
    ["GET", got],
    ["PATCH", patched],
    ["PUT", replaced],
  ] as const) {
    assert.equal(reply.status, 200, `${label} status`);
    assert.equal(reply.body.root, cwd, `${label} root`);
    assertConfigReply(reply.body, label);
  }

  process.kill(d.pid, "SIGTERM");
  assert.equal((await d.done).code, 0);
});
