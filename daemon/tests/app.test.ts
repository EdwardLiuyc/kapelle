/**
 * The daemon's app, served in this process — `daemon/app.ts` (M12-7a). No
 * daemon is spawned: the test makes the app, listens on port 0 and stops it.
 * The boot, the claim and the signals stay with the subprocess suites
 * (`tests/daemon*.test.ts`), which start `daemon.ts` itself.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addRepo,
  api,
  type Daemon,
  MOCK_AGENT,
  mockRun,
  type RoomReply,
  roomIdle,
  settled,
  tempDir,
  until,
  useDaemonDirs,
  withAgent,
} from "../../integration/helpers.ts";
import { digest } from "../http.ts";

test("createDaemonApp loads cleanly and serves both routes", async (t) => {
  const signals = Object.keys(osConstants.signals);
  const listeners = new Map(
    signals.map((signal) => [signal, process.listenerCount(signal)]),
  );
  const servers = () =>
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "TCPSERVERWRAP").length;
  const serversBefore = servers();
  const argv = process.argv;
  process.argv = new Proxy(argv, {
    get() {
      throw new Error("daemon/app.ts read process.argv at import");
    },
  });
  const { createDaemonApp } = await import("../app.ts").finally(() => {
    process.argv = argv;
  });
  for (const signal of signals) {
    assert.equal(
      process.listenerCount(signal),
      listeners.get(signal),
      `importing daemon/app.ts added a ${signal} handler`,
    );
  }
  assert.equal(
    servers(),
    serversBefore,
    "importing daemon/app.ts opened a server",
  );

  const state = await tempDir(t);
  const before = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.XDG_CONFIG_HOME = useDaemonDirs(state).XDG_CONFIG_HOME;
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const token = "app-test-token";
  const childrenFile = join(state, "children.json");
  const app = createDaemonApp({
    repos: [],
    expected: digest(token),
    daemonFile: join(state, "daemon.json"),
    childrenFile,
    permissionTimeoutMs: 120_000,
  });
  // Making the app opened nothing; the import checks above prove its own
  // side-effect-free load.
  assert.equal(app.server.listening, false);
  app.restoreRuns();
  await app.restoreRooms();
  await new Promise<void>((ok) => app.server.listen(0, "127.0.0.1", ok));
  const closeServer = async () => {
    app.server.closeIdleConnections();
    if (!app.server.listening) return;
    await new Promise<void>((ok, fail) =>
      app.server.close((err) => (err ? fail(err) : ok())),
    );
  };
  t.after(async () => {
    try {
      await app.stop("test");
    } finally {
      await closeServer();
    }
  });
  const { port } = app.server.address() as AddressInfo;
  // SAFETY: `api` and the polling helpers read only `url` and `token`; the
  // other fields describe a spawned daemon, and there is none.
  const d = { url: `http://127.0.0.1:${port}`, token } as Daemon;

  const unauthorised = await api(d, "GET", "/runs", undefined, null);
  assert.equal(unauthorised.status, 401);

  const cwd = await addRepo(d, await tempDir(t));

  // A run route.
  const run = await api(d, "POST", "/runs", {
    cwd,
    run: mockRun([{ id: "one", prompt: "hi" }]),
  });
  assert.equal(run.status, 202);
  assert.equal((await settled(d, run.body.id)).status, "done");

  // A room route.
  const room = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT}`),
  );
  assert.equal(room.status, 201, room.body.error?.message);
  const sent = await api(d, "POST", `/rooms/${room.body.id}/messages`, {
    text: "hi",
  });
  assert.equal(sent.status, 202);
  await roomIdle(d, room.body.id);
  // The room's harness is live, so its pid is on record for the sweep.
  assert.ok(existsSync(childrenFile));

  // A stop pauses the room and stops its harness: the record goes with it.
  await app.stop("test");
  // The boot owns the listener, not the app; this test is that caller here.
  assert.equal(app.server.listening, true);
  await closeServer();
  assert.equal(app.server.listening, false);
  await until("children.json removed", () => !existsSync(childrenFile));
});
