/**
 * `kapelle demo` (#463), driven as a real subprocess on a pipe against a
 * daemon: the demo agent answers, asks one question, writes once it is
 * allowed, and the diff shows the write. Later runs clean the old checkouts,
 * whether their participant is still on the roster or was removed. A rejected
 * question writes nothing. A write after a revive keeps the notes made
 * before it. That the packed package ships the agent is in
 * `tests/package.test.ts`.
 */

import assert from "node:assert/strict";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { RoomDto, RoomListEntry } from "../client/contract.ts";
import {
  daemonApi as api,
  bootDaemon,
  pendingOne,
  REPO,
  roomIdle,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";
import { AGENTS } from "../protocol/registry.ts";

/** Wait until the demo room is open, or fail with why its process stopped. */
async function openDemo(c: ReturnType<typeof spawnCli>): Promise<void> {
  const opened = await Promise.race([
    c.waitFor("Now type a message").then(
      () => true,
      () => false,
    ),
    c.done,
  ]);
  if (opened !== true) {
    assert.fail(
      typeof opened === "boolean"
        ? "kapelle demo did not open a room"
        : `kapelle demo exited ${opened.code}: ${opened.stderr}`,
    );
  }
}

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
  await openDemo(c);
  c.child.stdin.write("hello\n");
  await c.waitFor('You said: "hello"');
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
  assert.match(
    r.stdout,
    /The notice that says "no measured labels" is about me/,
  );

  const first = (await api<RoomListEntry[]>(d, "GET", "/rooms")).body;
  assert.deepEqual(
    first.map((room) => [room.cwd, room.participants.map((p) => p.name)]),
    [[folder, ["demo"]]],
  );
  assert.notEqual(folder, REPO, "never the person's checkout");

  const again = spawnCli(t, ["demo"], "cli.ts", env);
  await openDemo(again);
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

test("kapelle demo cleans a removed participant's dirty checkout before the next run", {
  timeout: 90_000,
}, async (t) => {
  const runtime = await realpath(await tempDir(t));
  const d = await bootDaemon(t, runtime);
  const env = {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: runtime,
    XDG_CONFIG_HOME: join(runtime, "config-home"),
  };

  const c = spawnCli(t, ["demo"], "cli.ts", env);
  await openDemo(c);
  c.child.stdin.write("hello\n");
  const asked = await pendingOne(d);
  assert.equal(
    (await api(d, "POST", `/permissions/${asked.id}`, { allow: true })).status,
    200,
  );
  await c.waitFor("Wrote notes.md");
  const [old] = (await api<RoomListEntry[]>(d, "GET", "/rooms")).body;
  assert.ok(old, "the demo room is listed");
  const room = (await api<RoomDto>(d, "GET", `/rooms/${old.id}`)).body;
  const worktree = room.participants[0]?.worktree;
  assert.ok(worktree, JSON.stringify(room));
  // The checkout is dirty: this is the state that used to block the delete.
  await access(join(worktree, "notes.md"));
  c.child.stdin.write("@demo /remove\n");
  await c.waitFor("removed demo");
  c.child.stdin.write("/leave\n");
  const left = await c.done;
  assert.equal(left.code, 0, left.stderr);

  const again = spawnCli(t, ["demo"], "cli.ts", env);
  await openDemo(again);
  again.child.stdin.write("/leave\n");
  const r2 = await again.done;
  assert.equal(r2.code, 0, r2.stderr);
  const rooms = (await api<RoomListEntry[]>(d, "GET", "/rooms")).body;
  assert.equal(rooms.length, 1, JSON.stringify(rooms));
  assert.notEqual(rooms[0]?.id, old.id);
  const repos = await readdir(join(runtime, "kapelle", "repos"));
  assert.equal(
    repos.filter((n) => n.startsWith("demo-")).length,
    1,
    `${repos}`,
  );
  await assert.rejects(access(worktree), "the old checkout is gone");
});

test("kapelle demo writes nothing when its permission question is rejected", {
  timeout: 90_000,
}, async (t) => {
  const runtime = await realpath(await tempDir(t));
  const d = await bootDaemon(t, runtime);
  const c = spawnCli(t, ["demo"], "cli.ts", {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: runtime,
    XDG_CONFIG_HOME: join(runtime, "config-home"),
  });
  await openDemo(c);
  c.child.stdin.write("do not write this\n");
  const asked = await pendingOne(d);
  assert.equal(asked.title, "Write notes.md");
  assert.equal(
    (await api(d, "POST", `/permissions/${asked.id}`, { allow: false })).status,
    200,
  );
  const answer = await Promise.race([
    c.waitFor("Nothing changed").then(
      () => "denied" as const,
      () => undefined,
    ),
    c.waitFor("Wrote notes.md").then(
      () => "wrote" as const,
      () => undefined,
    ),
    c.done.then((result) => {
      assert.equal(result.code, 0, result.stderr);
      return "exited" as const;
    }),
  ]);
  assert.equal(answer, "denied");
  const [listed] = (await api<RoomListEntry[]>(d, "GET", "/rooms")).body;
  assert.ok(listed, "the demo room is listed");
  const room = (await api<RoomDto>(d, "GET", `/rooms/${listed.id}`)).body;
  const worktree = room.participants[0]?.worktree;
  assert.ok(worktree, JSON.stringify(room));
  await access(worktree);
  await assert.rejects(access(join(worktree, "notes.md")));
  c.child.stdin.write("/leave\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Wrote notes\.md/);
});

test("kapelle demo refuses an extra command word before it starts a daemon", async (t) => {
  const runtime = await realpath(await tempDir(t));
  const r = await spawnCli(t, ["demo", "demo"], "cli.ts", {
    XDG_RUNTIME_DIR: join(runtime, "missing-runtime"),
    XDG_STATE_HOME: runtime,
  }).done;
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^usage: kapelle demo$/m);
  assert.doesNotMatch(r.stderr, /XDG_RUNTIME_DIR/);
});

test("kapelle demo keeps the notes made before a revive: the write after it reads notes.md first", {
  timeout: 90_000,
}, async (t) => {
  const runtime = await realpath(await tempDir(t));
  const first = await bootDaemon(t, runtime);
  const c = spawnCli(t, ["demo"], "cli.ts", {
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: runtime,
    XDG_CONFIG_HOME: join(runtime, "config-home"),
  });
  await openDemo(c);
  c.child.stdin.write("one\n");
  const asked = await pendingOne(first);
  await api(first, "POST", `/permissions/${asked.id}`, { allow: true });
  await c.waitFor("Wrote notes.md");
  c.child.stdin.write("/leave\n");
  assert.equal((await c.done).code, 0);
  const [listed] = (await api<RoomListEntry[]>(first, "GET", "/rooms")).body;
  assert.ok(listed, "the demo room is listed");
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // A new daemon revives the agent with a fresh session: it has no memory
  // of the first note, and the file on disk still has it.
  const d = await bootDaemon(t, runtime);
  const room = (await api<RoomDto>(d, "GET", `/rooms/${listed.id}`)).body;
  const p = room.participants[0];
  assert.ok(p, JSON.stringify(room));
  const send = (text: string) =>
    api(d, "POST", `/rooms/${room.id}/agents/${p.id}/messages`, { text });
  await send("back again"); // the fresh session's first turn is the welcome
  await roomIdle(d, room.id);
  await send("two");
  const next = await pendingOne(d);
  await api(d, "POST", `/permissions/${next.id}`, { allow: true });
  await roomIdle(d, room.id);
  assert.equal(
    await readFile(join(p.worktree, "notes.md"), "utf8"),
    "- one\n- two\n",
  );
});
