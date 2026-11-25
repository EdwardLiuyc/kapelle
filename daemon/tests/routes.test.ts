/**
 * The route table — `daemon/app.ts` and `daemon/routes/` (M12-7b). The app is
 * served in this process on port 0, and each row's handler is swapped for a
 * spy, so a test sees which row a request reached, if any.
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { tempDir, useDaemonDirs } from "../../integration/helpers.ts";
import { createDaemonApp } from "../app.ts";
import { digest, type Route } from "../http.ts";

const TOKEN = "routes-test-token";

/** One request per row of the table, in no special order. */
const SAMPLES: [string, string][] = [
  ["GET", "/version"],
  ["POST", "/repos"],
  ["GET", "/repos"],
  ["GET", "/config"],
  ["PATCH", "/config"],
  ["PUT", "/config"],
  ["POST", "/runs"],
  ["GET", "/runs"],
  ["GET", "/runs/r1"],
  ["DELETE", "/runs/r1"],
  ["GET", "/runs/r1/events"],
  ["GET", "/permissions"],
  ["GET", "/permissions/p1"],
  ["POST", "/permissions/p1"],
  ["POST", "/rooms"],
  ["GET", "/rooms"],
  ["GET", "/rooms/m1"],
  ["PATCH", "/rooms/m1"],
  ["DELETE", "/rooms/m1"],
  ["GET", "/rooms/m1/delete-preview"],
  ["POST", "/rooms/m1/dismiss"],
  ["GET", "/rooms/m1/events"],
  ["POST", "/rooms/m1/messages"],
  ["GET", "/rooms/m1/scratch"],
  ["POST", "/rooms/m1/scratch/clean"],
  ["GET", "/rooms/m1/agents"],
  ["POST", "/rooms/m1/agents"],
  ["GET", "/rooms/m1/agents/a1"],
  ["PATCH", "/rooms/m1/agents/a1"],
  ["DELETE", "/rooms/m1/agents/a1"],
  ["POST", "/rooms/m1/agents/a1/messages"],
  ["GET", "/rooms/m1/agents/a1/events"],
  ["GET", "/rooms/m1/agents/a1/diff"],
  ["GET", "/rooms/m1/agents/a1/fast-forward"],
  ["POST", "/rooms/m1/agents/a1/fast-forward"],
  ["POST", "/rooms/m1/agents/a1/turns/current/cancel"],
  ["GET", "/harnesses"],
  ["POST", "/harnesses"],
  ["POST", "/harnesses/done"],
  ["POST", "/harnesses/install"],
];

/** The app on port 0, every handler a spy that answers 204. */
async function serve(t: TestContext) {
  const state = await tempDir(t);
  const before = process.env.XDG_STATE_HOME;
  useDaemonDirs(state);
  t.after(() => {
    if (before === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = before;
  });
  const app = createDaemonApp({
    repos: [],
    expected: digest(TOKEN),
    daemonFile: join(state, "daemon.json"),
    childrenFile: join(state, "children.json"),
    permissionTimeoutMs: 120_000,
  });
  const calls = new Map<Route, unknown[]>();
  for (const row of app.routes) {
    row.handler = ({ res, params }) => {
      calls.set(row, [...(calls.get(row) ?? []), params]);
      res.writeHead(204).end();
    };
  }
  await new Promise<void>((ok) => app.server.listen(0, "127.0.0.1", ok));
  t.after(async () => {
    await app.stop("test");
    app.server.closeAllConnections();
    await new Promise((ok) => app.server.close(ok));
  });
  const { port } = app.server.address() as AddressInfo;
  /** A request with this `Host`, and the token unless `auth` is false. */
  const call = (
    method: string,
    path: string,
    { host = `127.0.0.1:${port}`, auth = true } = {},
  ) =>
    new Promise<{ status: number; code?: string }>((ok, fail) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          agent: false,
          setHost: false,
          headers: {
            host,
            ...(auth && { authorization: `Bearer ${TOKEN}` }),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => {
            text += c;
          });
          res.on("end", () =>
            ok({
              status: res.statusCode ?? 0,
              code: text ? JSON.parse(text).error?.code : undefined,
            }),
          );
        },
      );
      req.on("error", fail);
      req.end();
    });
  return { routes: app.routes, calls, call };
}

test("every row is reached only after the Host and token checks", async (t) => {
  const { routes, calls, call } = await serve(t);
  assert.equal(SAMPLES.length, routes.length, "one sample per row");

  for (const [method, path] of SAMPLES) {
    const forged = await call(method, path, { host: "evil.example" });
    assert.deepEqual(
      forged,
      { status: 403, code: "host_not_allowed" },
      `${method} ${path} with a forged Host`,
    );
    const anonymous = await call(method, path, { auth: false });
    assert.deepEqual(
      anonymous,
      { status: 401, code: "unauthorized" },
      `${method} ${path} with no token`,
    );
  }
  assert.equal(calls.size, 0, "no row ran before both checks passed");

  // Past both checks, each sample reaches one row, and each row is reached
  // once: no row is unreachable, and no two rows match one request.
  for (const [method, path] of SAMPLES) {
    assert.equal((await call(method, path)).status, 204, `${method} ${path}`);
  }
  for (const row of routes) {
    assert.equal(
      calls.get(row)?.length,
      1,
      `${row.method} ${row.pattern} reached once`,
    );
  }
});

test("an unknown path and a wrong method are 404 no_route", async (t) => {
  const { calls, call } = await serve(t);
  for (const [method, path] of [
    ["GET", "/nope"],
    ["GET", "/rooms/"],
    ["GET", "/runs/r1/events/more"],
    ["PUT", "/runs"],
    ["POST", "/version"],
    ["PATCH", "/runs/r1"],
  ] as const) {
    assert.deepEqual(
      await call(method, path),
      { status: 404, code: "no_route" },
      `${method} ${path}`,
    );
  }
  assert.equal(calls.size, 0);

  // A path id is passed on as sent, not decoded.
  assert.equal((await call("GET", "/runs/a%2Fb")).status, 204);
  assert.deepEqual([...calls.values()], [[["a%2Fb"]]]);
});
