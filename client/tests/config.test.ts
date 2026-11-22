/**
 * The project config's lines and the form's patch (M10-5, #494). No daemon:
 * the rows are what `GET /config` answers.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { runCommand } from "../command.ts";
import {
  CONFIG_INVALID_HINT,
  configInvalidRefusal,
  configLines,
  configPatch,
} from "../config.ts";
import type { ConfigRow, ConfigView } from "../contract.ts";
import type { DaemonAddress } from "../daemon.ts";

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

test("an invalid view shares its refusal and gives the pipe one next step", () => {
  assert.equal(
    configInvalidRefusal("/r/.kapelle/config.json is not valid JSON: bad"),
    "/r/.kapelle/config.json is not valid JSON: bad",
  );
  assert.match(CONFIG_INVALID_HINT, /fix the file by hand/);
});

test("an empty replacement is refused before it sends a request (#504)", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        root: "/r",
        path: "/r/.kapelle/config.json",
        rows: [],
      } satisfies ConfigView),
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  const d: DaemonAddress = {
    port: (server.address() as AddressInfo).port,
    token: "tok",
  };

  const out = await runCommand(d, undefined, {
    verb: "config",
    cwd: "/r",
    patch: {},
    replace: true,
  });
  assert.equal(requests, 0);
  assert.equal(out.ok, false);
  assert.match(out.message ?? "", /nothing entered/i);
});

test("a replacement request is PUT /config with the whole form value set (#504)", async (t) => {
  let method = "";
  let sent = "";
  const server = createServer(async (req, res) => {
    method = req.method ?? "";
    for await (const chunk of req) sent += chunk;
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        root: "/r",
        path: "/r/.kapelle/config.json",
        rows: [],
      } satisfies ConfigView),
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  const d: DaemonAddress = {
    port: (server.address() as AddressInfo).port,
    token: "tok",
  };

  const out = await runCommand(d, undefined, {
    verb: "config",
    cwd: "/r",
    patch: { maxConcurrency: 2 },
    replace: true,
  });
  assert.equal(method, "PUT");
  assert.deepEqual(JSON.parse(sent), { maxConcurrency: 2 });
  assert.equal(out.ok, true);
  assert.match(
    out.line ?? "",
    /replaced \/r\/.kapelle\/config.json with maxConcurrency/,
  );
});
