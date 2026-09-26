/**
 * The shared transport — `client/daemon.ts`, story M5-10a (#142).
 *
 * The daemon is faked with a bare HTTP server, so each reply is one line to
 * stage: an old version, a new one, an envelope, a refusal Node sent itself.
 * `tests/cli.test.ts` proves the same checks through the real verbs.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { API_VERSION } from "../contract.ts";
import {
  call,
  checkVersion,
  type DaemonAddress,
  readDaemonFile,
  VersionRefused,
} from "../daemon.ts";

/** A daemon that answers every request with `reply`, and records the
 *  `authorization` header it saw. */
async function fake(
  t: TestContext,
  reply: (res: ServerResponse, path: string) => void,
): Promise<DaemonAddress & { auth: (string | undefined)[] }> {
  const auth: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    auth.push(req.headers.authorization);
    reply(res, req.url ?? "/");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  return { port: (server.address() as AddressInfo).port, token: "tok", auth };
}

const json = (res: ServerResponse, status: number, body: unknown) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));

const version = (major: number, minor: number) => (res: ServerResponse) =>
  json(res, 200, { apiVersion: { major, minor }, capabilities: [] });

test("the same version passes silently, with the token sent", async (t) => {
  const d = await fake(t, version(API_VERSION.major, API_VERSION.minor));
  assert.equal(await checkVersion(d), undefined);
  assert.deepEqual(d.auth, ["Bearer tok"]);
});

test("a different minor is a warning that names both versions", async (t) => {
  const d = await fake(t, version(API_VERSION.major, API_VERSION.minor + 1));
  const warning = await checkVersion(d);
  assert.match(
    warning ?? "",
    new RegExp(
      `speaks API ${API_VERSION.major}\\.${API_VERSION.minor + 1} and this client ${API_VERSION.major}\\.${API_VERSION.minor}`,
    ),
  );
});

test("a different major is refused, and the refusal ends a stream", async (t) => {
  const d = await fake(t, version(API_VERSION.major + 1, 0));
  await assert.rejects(checkVersion(d), (err) => {
    assert.ok(err instanceof VersionRefused);
    assert.match(err.message, /update the client or the daemon/);
    return true;
  });
});

test("a daemon with no GET /version is refused", async (t) => {
  const d = await fake(t, (res) =>
    json(res, 404, { error: { code: "no_route", message: "no such route" } }),
  );
  await assert.rejects(checkVersion(d), VersionRefused);
});

test("a refusal answers the envelope; one with no envelope answers the status", async (t) => {
  const d = await fake(t, (res, path) =>
    path === "/envelope"
      ? json(res, 409, { error: { code: "run_ended", message: "ended" } })
      : res.writeHead(408).end(),
  );
  assert.deepEqual(await call(d, "/envelope"), {
    ok: false,
    status: 409,
    error: { code: "run_ended", message: "ended" },
  });
  assert.deepEqual(await call(d, "/bare"), {
    ok: false,
    status: 408,
    error: { code: "", message: "HTTP 408" },
  });
});

test("daemon.json: missing, unready or an address", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kapelle-client-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "daemon.json");
  assert.equal(await readDaemonFile(file), "missing");
  for (const text of ["null", "{", '{"port":1}', '{"port":0,"token":"x"}']) {
    await writeFile(file, text);
    assert.equal(await readDaemonFile(file), "unready", text);
  }
  await writeFile(file, '{"port":1,"token":"x","pid":2}');
  assert.deepEqual(await readDaemonFile(file), { port: 1, token: "x" });
});

test("client/ loads nothing under core/ or protocol/ at runtime", async () => {
  // A child process, so the hook sees every module load from a cold start.
  // `import type` is erased, so contract.ts's types from protocol/ load nothing.
  const root = join(import.meta.dirname, "..", "..");
  const script = `
    import { registerHooks } from "node:module";
    const seen = [];
    registerHooks({
      resolve(spec, ctx, next) {
        const r = next(spec, ctx);
        seen.push(r.url);
        return r;
      },
    });
    for (const f of ["contract.ts", "daemon.ts", "stream.ts"]) {
      await import(new URL("client/" + f, ${JSON.stringify(`file://${root}/`)}));
    }
    console.log(JSON.stringify(seen));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    script,
  ]);
  const seen: string[] = JSON.parse(stdout);
  assert.ok(seen.some((u) => u.endsWith("/client/daemon.ts")));
  assert.deepEqual(
    seen.filter((u) => /\/(core|protocol)\//.test(u)),
    [],
  );
});
