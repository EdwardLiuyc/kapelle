/**
 * The shared transport — `client/daemon.ts`, story M5-10a (#142).
 *
 * The daemon is faked with a bare HTTP server, so each reply is one line to
 * stage: an old version, a new one, an envelope, a refusal Node sent itself.
 * `tests/cli.test.ts` proves the same checks through the real verbs.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
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
  request,
  VersionRefused,
} from "../daemon.ts";
import { type Connect, followEvents, StreamClosed } from "../stream.ts";

/** A daemon that answers every request with `reply`, and records the
 *  headers it saw. */
async function fake(
  t: TestContext,
  reply: (res: ServerResponse, path: string) => void,
): Promise<DaemonAddress & { seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    reply(res, req.url ?? "/");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  return { port: (server.address() as AddressInfo).port, token: "tok", seen };
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
  assert.deepEqual(
    d.seen.map((h) => h.authorization),
    ["Bearer tok"],
  );
});

test("request keeps the caller's headers in every form fetch takes", async (t) => {
  const d = await fake(t, (res) => res.end());
  for (const headers of [
    { "last-event-id": "3" },
    new Headers({ "last-event-id": "3" }),
    [["last-event-id", "3"]] as [string, string][],
  ]) {
    await (await request(d, "/x", { headers })).text();
  }
  for (const h of d.seen) {
    assert.equal(h["last-event-id"], "3");
    assert.equal(h.authorization, "Bearer tok");
  }
  assert.equal(d.seen.length, 3);
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
    assert.match(err.message, /kapelle daemon stop/);
    return true;
  });
});

test("a daemon with no GET /version is refused, and names the stop verb", async (t) => {
  const d = await fake(t, (res) =>
    json(res, 404, { error: { code: "no_route", message: "no such route" } }),
  );
  await assert.rejects(checkVersion(d), (err) => {
    assert.ok(err instanceof VersionRefused);
    assert.match(err.message, /kapelle daemon stop/);
    return true;
  });
});

test("a 2xx non-JSON /version is a fatal refusal, not a retry", async (t) => {
  const d = await fake(t, (res) =>
    res.writeHead(200, { "content-type": "text/plain" }).end("not json"),
  );
  await assert.rejects(checkVersion(d), (err) => {
    assert.ok(err instanceof VersionRefused);
    assert.ok(err instanceof StreamClosed);
    assert.match(err.message, /no readable API version/);
    assert.match(err.message, /non-JSON/);
    assert.match(err.message, /kapelle daemon stop/);
    assert.doesNotMatch(err.message, /undefined/);
    return true;
  });

  // The same refusal out of `connect` must end the stream, not retry it.
  let tries = 0;
  const connect: Connect = async () => {
    tries += 1;
    if (tries === 1) await checkVersion(d);
    return undefined;
  };
  const events: unknown[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of followEvents(connect)) events.push(event);
    })(),
    VersionRefused,
  );
  assert.equal(tries, 1, "a non-JSON /version must not be retried");
  assert.deepEqual(events, []);
});

test("a non-404 /version refusal keeps the daemon's message", async (t) => {
  const d = await fake(t, (res) =>
    json(res, 401, {
      error: { code: "unauthorized", message: "missing or wrong token" },
    }),
  );
  await assert.rejects(checkVersion(d), (err) => {
    assert.ok(err instanceof VersionRefused);
    assert.ok(err instanceof StreamClosed);
    assert.equal(
      err.message,
      "the daemon refused GET /version: missing or wrong token",
    );
    return true;
  });
});

test("a /version with no readable major/minor is refused without undefined", async (t) => {
  for (const apiVersion of [
    { major: 1 },
    { minor: 4 },
    {},
    { major: "1", minor: 4 },
    { major: 1, minor: 4.5 },
    "1.4",
    null,
  ]) {
    const d = await fake(t, (res) =>
      json(res, 200, { apiVersion, capabilities: [] }),
    );
    await assert.rejects(checkVersion(d), (err) => {
      assert.ok(err instanceof VersionRefused);
      assert.match(err.message, /no readable API version/);
      assert.match(err.message, /kapelle daemon stop/);
      assert.doesNotMatch(err.message, /undefined/);
      return true;
    });
  }
});

test("a refusal answers the envelope; one with no envelope answers the status", async (t) => {
  const d = await fake(t, (res, path) => {
    if (path === "/envelope") {
      json(res, 409, { error: { code: "run_ended", message: "ended" } });
    } else if (path === "/no-message") {
      json(res, 409, { error: { code: "x" } });
    } else if (path === "/empty-message") {
      json(res, 409, { error: { code: "x", message: "" } });
    } else if (path === "/bad-code") {
      json(res, 409, { error: { code: 42 } });
    } else {
      res.writeHead(408).end();
    }
  });
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
  // An envelope whose `message` is missing or empty is unusable: the status
  // stands in, and a string `code` is kept when there is one.
  assert.deepEqual(await call(d, "/no-message"), {
    ok: false,
    status: 409,
    error: { code: "x", message: "HTTP 409" },
  });
  assert.deepEqual(await call(d, "/empty-message"), {
    ok: false,
    status: 409,
    error: { code: "x", message: "HTTP 409" },
  });
  assert.deepEqual(await call(d, "/bad-code"), {
    ok: false,
    status: 409,
    error: { code: "", message: "HTTP 409" },
  });
});

test("daemon.json: missing, unready or an address", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kapelle-client-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "daemon.json");
  assert.equal(await readDaemonFile(file), "missing");
  for (const text of [
    "null",
    "{",
    '{"port":1}',
    '{"port":0,"token":"x"}',
    '{"port":-1,"token":"x"}',
    '{"port":1.5,"token":"x"}',
    '{"port":65536,"token":"x"}',
  ]) {
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
  // Enumerate top-level `client/*.ts` so a new module cannot escape the
  // import. `client/tests/` is a subdirectory, not a top-level file.
  const files = (await readdir(join(root, "client"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
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
    for (const f of ${JSON.stringify(files)}) {
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
