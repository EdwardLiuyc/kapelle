/**
 * Room runtime tests — story M6-6a, issue #150.
 *
 * Drives `core/room.ts` directly, with no daemon and no route: each
 * participant owns a checkout and a branch, turns run in parallel, a base
 * may be another participant's branch, and a dismiss keeps the work.
 * `mock-agent.mjs`'s default turn writes `ACP_TEST.md` through the client,
 * which is the file each test looks for.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import {
  gitRepo,
  isolateStateHome,
  MOCK_AGENT,
  tempDir,
} from "../../integration/helpers.ts";
import { createEventBus } from "../events.ts";
import { newRoomId } from "../ids.ts";
import { openRoom, type Participant, type Room, roomAgents } from "../room.ts";
import { stateDirFor } from "../runtime.ts";
import { changedPaths, openWorktrees } from "../worktree.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

isolateStateHome();

/** One checked agent request running the mock, named `name`. */
const mock = (name: string) =>
  roomAgents([{ cmd: `node ${MOCK_AGENT}`, name }])[0] as NonNullable<
    ReturnType<typeof roomAgents>[number]
  >;

/** A room in `cwd` with `alice` as its starter, dismissed after the test. */
async function roomWithAlice(
  t: TestContext,
  cwd: string,
): Promise<{ room: Room; alice: Participant; roomId: string }> {
  const roomId = newRoomId();
  const room = await openRoom({
    roomId,
    cwd,
    agents: [mock("alice")],
    setup: await openWorktrees(cwd, roomId),
    bus: createEventBus(),
  });
  t.after(() => room.dismiss());
  return { room, alice: room.participants[0] as Participant, roomId };
}

/** Commits one file on a participant's branch, as the participant would
 *  itself (R37: the supervisor never commits). */
async function commitIn(p: Participant, file: string) {
  await writeFile(join(p.worktree, file), `${p.name}\n`);
  await git(p.worktree, "add", file);
  await git(p.worktree, "commit", "-m", `${p.name}: ${file}`);
}

const branchExists = async (repo: string, branch: string) =>
  (await git(repo, "branch", "--list", branch)) !== "";

/** The room's branches, by name only: `git branch --list` would add a `+`
 *  for a branch checked out in a worktree. */
const roomBranches = async (repo: string, roomId: string) =>
  (
    await git(
      repo,
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/kapelle/${roomId}/`,
    )
  )
    .split("\n")
    .filter(Boolean);

test("each participant has its own checkout and branch, and turns run in parallel", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice, roomId } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob"));

  assert.equal(room.participants.length, 2);
  assert.equal(alice.branch, `kapelle/${roomId}/${alice.id}`);
  assert.equal(bob.branch, `kapelle/${roomId}/${bob.id}`);
  assert.notEqual(alice.worktree, bob.worktree);

  const turns = [alice.send("hi"), bob.send("hi")];
  assert.equal(alice.status(), "busy");
  assert.equal(bob.status(), "busy");
  await Promise.all(turns);

  // Each write landed in its writer's checkout, and nowhere else.
  assert.deepEqual(await changedPaths(alice.worktree), ["ACP_TEST.md"]);
  assert.deepEqual(await changedPaths(bob.worktree), ["ACP_TEST.md"]);
  assert.deepEqual(await changedPaths(repo), []);
});

test("a participant given another's branch as its base starts from that branch's head", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  await commitIn(alice, "alice.txt");

  const bob = await room.add(mock("bob"), alice.branch);

  assert.equal(bob.baseSha, await git(repo, "rev-parse", `${alice.branch}`));
  assert.ok(existsSync(join(bob.worktree, "alice.txt")));
});

test("a dismiss keeps every branch with work, and rolls back an untouched one", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob"));
  await commitIn(alice, "alice.txt");

  await room.dismiss();

  assert.equal(alice.status(), "dismissed");
  assert.equal(bob.status(), "dismissed");
  assert.ok(await branchExists(repo, alice.branch as string));
  assert.ok(existsSync(alice.worktree), "the checkout is kept, as R37 says");
  assert.ok(!(await branchExists(repo, bob.branch as string)));
  assert.ok(!existsSync(bob.worktree));
});

test("a failed add leaves no checkout or branch, and the room keeps working", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice, roomId } = await roomWithAlice(t, repo);

  await assert.rejects(room.add(mock("bob"), "no-such-ref"), /no-such-ref/);
  const dead = roomAgents([{ cmd: "false", name: "carol" }])[0];
  await assert.rejects(room.add(dead as ReturnType<typeof mock>));

  assert.equal(room.participants.length, 1);
  assert.deepEqual(await roomBranches(repo, roomId), [alice.branch]);
  assert.equal(room.status(), "active");
  await alice.send("still here");
  assert.equal(alice.status(), "idle");
});

test("a failed add whose harness wrote into its checkout keeps it, and says so", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice, roomId } = await roomWithAlice(t, repo);
  // A harness that writes into its cwd, then dies before its session.
  const bin = join(await tempDir(t), "scribble.sh");
  await writeFile(bin, "#!/bin/sh\necho x > scribble.txt\nexit 1\n", {
    mode: 0o755,
  });
  const dead = roomAgents([{ cmd: bin, name: "carol" }])[0];

  await assert.rejects(room.add(dead as ReturnType<typeof mock>));

  assert.equal(room.participants.length, 1);
  const kept = (await roomBranches(repo, roomId)).filter(
    (b) => b !== alice.branch,
  );
  assert.equal(kept.length, 1, "the written checkout keeps its branch");
  assert.match(
    alice.notices.map((n) => n.text).join("\n"),
    /did not join left its checkout/,
  );
});

test("a base is refused in a folder that is not a repository", async (t) => {
  const { room } = await roomWithAlice(t, await tempDir(t));
  await assert.rejects(room.add(mock("bob"), "main"), /git repository/);
});

test("a participant cannot be added to a dismissed room", async (t) => {
  const repo = await gitRepo(t);
  const { room } = await roomWithAlice(t, repo);
  await room.dismiss();
  await assert.rejects(room.add(mock("bob")), /dismissed/);
});

test("a dismiss during an add leaves nothing behind once it resolves", async (t) => {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [],
    setup: await openWorktrees(repo, roomId),
    bus: createEventBus(),
  });
  const adding = room.add(mock("bob"));
  // Checked the moment `dismiss()` resolves. A look at the branches alone
  // races: it can run before the add has made its branch at all.
  let settled = false;
  adding.then(
    () => (settled = true),
    () => (settled = true),
  );
  await room.dismiss();
  assert.ok(settled, "dismiss() resolved while an add was still starting");
  assert.deepEqual(await roomBranches(repo, roomId), []);
  await assert.rejects(adding, /dismissed/);
});

test("a dismiss stops every participant's harness", async (t) => {
  const repo = await gitRepo(t);
  const bus = createEventBus();
  const exits: string[] = [];
  bus.addListener((e) => {
    if (e.update.sessionUpdate === "_client_harness_exited")
      exits.push(e.agent);
  });

  const roomId = newRoomId();
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [mock("alice")],
    setup: await openWorktrees(repo, roomId),
    bus,
  });
  t.after(() => room.dismiss());
  const bob = await room.add(mock("bob"));
  const alice = room.participants[0] as Participant;

  const turns = [alice.send("hi"), bob.send("hi")];
  assert.equal(alice.status(), "busy");
  assert.equal(bob.status(), "busy");
  await room.dismiss();
  await Promise.allSettled(turns);
  await new Promise((ok) => setImmediate(ok));

  assert.equal(
    exits.length,
    2,
    `both harnesses should have exited, got ${JSON.stringify(exits)}`,
  );
});

test("every participant shows the room's notices and the shared-cwd notice", async (t) => {
  const cwd = await tempDir(t);
  const roomId = newRoomId();
  // A file where the room's log folder goes gives the room a notice of its own.
  const rooms = join(stateDirFor(cwd), "rooms");
  await mkdir(rooms, { recursive: true });
  await writeFile(join(rooms, roomId), "");
  const room = await openRoom({
    roomId,
    cwd,
    agents: [mock("alice")],
    setup: await openWorktrees(cwd, roomId),
    bus: createEventBus(),
  });
  t.after(() => room.dismiss());
  await room.add(mock("bob"));

  for (const p of room.participants) {
    const texts = p.notices.map((n) => n.text).join("\n");
    assert.match(texts, /cannot write room logs/, p.name);
    assert.match(texts, /will collide/, p.name);
  }
});

test("each participant writes its own stderr log", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice, roomId } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob"));
  const logs = join(stateDirFor(repo), "rooms", roomId);
  assert.ok(existsSync(join(logs, `${alice.id}.stderr.log`)));
  assert.ok(existsSync(join(logs, `${bob.id}.stderr.log`)));
});
