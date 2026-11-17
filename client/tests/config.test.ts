/**
 * The project config's lines and the form's patch (M10-5, #494). No daemon:
 * the rows are what `GET /config` answers.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { configLines, configPatch } from "../config.ts";
import type { ConfigRow, ConfigView } from "../contract.ts";

const rows: ConfigRow[] = [
  { key: "stallIdleMs", value: 300000, default: 300000, source: "default" },
  {
    key: "ttlMs",
    value: 5000,
    default: 3600000,
    file: 60000,
    source: "env",
    env: "KAPELLE_TTL_MS",
  },
  {
    key: "linkPaths",
    value: ["node_modules"],
    default: [],
    file: ["node_modules"],
    source: "config",
  },
];

test("the lines name each key's value in use and its source", () => {
  const view: ConfigView = {
    root: "/r",
    path: "/r/.kapelle/config.json",
    rows,
  };
  assert.deepEqual(configLines(view), [
    "config for /r (/r/.kapelle/config.json)",
    "stallIdleMs = 300000 (default)",
    "ttlMs = 5000 (env KAPELLE_TTL_MS wins; the file says 60000)",
    'linkPaths = ["node_modules"] (config)',
  ]);
});

test("the patch has only the changed keys; blank is null, JSON is parsed, the rest is text", () => {
  assert.deepEqual(configPatch(rows, {}), {});
  assert.deepEqual(
    configPatch(rows, {
      stallIdleMs: " 1000 ",
      ttlMs: "",
      linkPaths: '["node_modules", "vendor"]',
    }),
    { stallIdleMs: 1000, ttlMs: null, linkPaths: ["node_modules", "vendor"] },
  );
  // Unchanged text, and blank where the file has nothing, send nothing.
  assert.deepEqual(configPatch(rows, { stallIdleMs: "", ttlMs: "60000" }), {});
  // The same value typed another way is no change either.
  assert.deepEqual(
    configPatch(rows, { ttlMs: "60000.0", linkPaths: '[ "node_modules" ]' }),
    {},
  );
  // The screen never guesses: the daemon refuses a value that is not JSON.
  assert.deepEqual(configPatch(rows, { linkPaths: "node_modules" }), {
    linkPaths: "node_modules",
  });
});
