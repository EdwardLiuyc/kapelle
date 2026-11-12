/**
 * `kapelle demo` (#463), driven as a real subprocess on a pipe against a
 * daemon: the demo agent answers, asks one question, writes once it is
 * allowed, and the diff shows the write. A second run leaves one demo room
 * and one demo state folder. That the packed package ships the agent is in
 * `tests/package.test.ts`.
 */

import assert from "node:assert/strict";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { RoomListEntry } from "../client/contract.ts";
import {
  daemonApi as api,
  bootDaemon,
  pendingOne,
  REPO,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";
import { AGENTS } from "../protocol/registry.ts";

test("kapelle demo: a reply, one question, the write and its diff; a second run leaves one room", {
  timeout: 90_000,
}, async (t) => {
  const runtime = await realpath(await tempDir(t));
  const d = await bootDaemon(t, runtime);
  const env = {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: runtime,
    XDG_CONFIG_HOME: join(runtime, "config-home"),
  };
  const folder = join(runtime, "kapelle", "demo");

  const c = spawnCli(t, ["demo"], "cli.ts", env);
  await c.waitFor("Now type a message");
  c.child.stdin.write("hello\n");
  const asked = await pendingOne(d);
  assert.equal(asked.title, "Write notes.md");
  assert.equal(
    (await api(d, "POST", `/permissions/${asked.id}`, { allow: true })).status,
    200,
  );
  await c.waitFor("Wrote notes.md");
  c.child.stdin.write("@demo /diff\n");
  await c.waitFor("+- hello");
  c.child.stdin.write("/leave\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /demo-agent: no measured labels/);

  const first = (await api<RoomListEntry[]>(d, "GET", "/rooms")).body;
  assert.deepEqual(
    first.map((room) => [room.cwd, room.participants.map((p) => p.name)]),
    [[folder, ["demo"]]],
  );
  assert.notEqual(folder, REPO, "never the person's checkout");

  const again = spawnCli(t, ["demo"], "cli.ts", env);
  await again.waitFor("Now type a message");
  again.child.stdin.write("/leave\n");
  const r2 = await again.done;
  assert.equal(r2.code, 0, r2.stderr);
  const second = (await api<RoomListEntry[]>(d, "GET", "/rooms")).body;
  assert.equal(second.length, 1, JSON.stringify(second));
  assert.notEqual(second[0]?.id, first[0]?.id);
  const repos = await readdir(join(runtime, "kapelle", "repos"));
  assert.equal(
    repos.filter((n) => n.startsWith("demo-")).length,
    1,
    `${repos}`,
  );

  // The setup list and --agent read the registry, which never names it.
  assert.ok(!Object.keys(AGENTS).some((id) => id.includes("demo")));
});
