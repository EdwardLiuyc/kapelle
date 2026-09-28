/**
 * Room runtime tests — stories M6-6a (#150) and M6-3 (#147).
 *
 * Drives `core/room.ts` directly, with no daemon and no route: each
 * participant owns a checkout and a branch, turns run in parallel, a base
 * may be another participant's branch, and a dismiss keeps the work. The
 * roster changes after the room opens: names stay unique, one orchestrator
 * at most, and a remove leaves the others alone.
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
  HOSTILE_AGENT,
  isolateStateHome,
  MOCK_AGENT,
  tempDir,
} from "../../integration/helpers.ts";
import { createEventBus } from "../events.ts";
import { newRoomId } from "../ids.ts";
import {
  openRoom,
  type Participant,
  type Room,
  roomAgent,
  roomAgents,
} from "../room.ts";
import { stateDirFor } from "../runtime.ts";
import { changedPaths, openWorktrees } from "../worktree.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

isolateStateHome();

/** One checked agent request running the mock, named `name`. */
const mock = (name: string, fields: Record<string, unknown> = {}) =>
  roomAgent({ cmd: `node ${MOCK_AGENT}`, name, ...fields });

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

  const bob = await room.add(mock("bob", { base: alice.branch }));

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

  await assert.rejects(
    room.add(mock("bob", { base: "no-such-ref" })),
    /no-such-ref/,
  );
  const dead = roomAgents([{ cmd: "false", name: "carol" }])[0];
  await assert.rejects(room.add(dead as ReturnType<typeof mock>));

  assert.equal(room.participants.length, 1);
  assert.deepEqual(await roomBranches(repo, roomId), [alice.branch]);
  assert.equal(room.status(), "active");
  await alice.send("still here");
  assert.equal(alice.status(), "idle");
});

test("failed adds whose harnesses wrote into their checkouts keep them, and each says so", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice, roomId } = await roomWithAlice(t, repo);
  // A harness that writes into its cwd, then dies before its session.
  const bin = join(await tempDir(t), "scribble.sh");
  await writeFile(bin, "#!/bin/sh\necho x > scribble.txt\nexit 1\n", {
    mode: 0o755,
  });
  const dead = (name: string) =>
    roomAgents([{ cmd: bin, name }])[0] as ReturnType<typeof mock>;

  // Two at once, so each rollback must name its own checkout.
  const failed = await Promise.allSettled([
    room.add(dead("carol")),
    room.add(dead("dave")),
  ]);
  assert.deepEqual(
    failed.map((r) => r.status),
    ["rejected", "rejected"],
  );

  assert.equal(room.participants.length, 1);
  const kept = (await roomBranches(repo, roomId)).filter(
    (b) => b !== alice.branch,
  );
  assert.equal(kept.length, 2, "each written checkout keeps its branch");
  const notices = alice.notices.map((n) => n.text).join("\n");
  for (const branch of kept) {
    const id = branch.split("/").pop() as string;
    const path = join(stateDirFor(repo), "wt", roomId, id);
    assert.ok(existsSync(join(path, "scribble.txt")), `${path} is kept`);
    assert.ok(notices.includes(path), `no notice names ${path}`);
  }
  await alice.send("still here");
  assert.equal(alice.status(), "idle");
});

test("a base is refused in a folder that is not a repository", async (t) => {
  const { room } = await roomWithAlice(t, await tempDir(t));
  await assert.rejects(
    room.add(mock("bob", { base: "main" })),
    /git repository/,
  );
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

const STALL = `node ${MOCK_AGENT} --scenario stall`;

test("a name is unique under ASCII case folding, at add, at rename and while an add is in flight", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);

  await assert.rejects(room.add(mock("ALICE")), { code: "name_taken" });
  // An add still starting holds its name.
  const bob = room.add(mock("bob"));
  await assert.rejects(room.add(mock("Bob")), { code: "name_taken" });
  const bobP = await bob;
  assert.throws(() => room.update(bobP.id, { name: "Alice" }), {
    code: "name_taken",
  });
  // Its own name in another case is not a clash.
  assert.equal(room.update(alice.id, { name: "Alice" }).name, "Alice");
  assert.equal(room.participants.length, 2);
});

test("one orchestrator at most, at add and at a role change, and a null role clears it", async (t) => {
  const repo = await gitRepo(t);
  const { room } = await roomWithAlice(t, repo);
  await room.add(mock("carol", { role: "orchestrator" }));
  await assert.rejects(room.add(mock("bob", { role: "orchestrator" })), {
    code: "orchestrator_exists",
  });
  const bob = await room.add(mock("bob", { role: "tester" }));
  assert.throws(() => room.update(bob.id, { role: "orchestrator" }), {
    code: "orchestrator_exists",
  });

  const carol = room.participants.find((p) => p.name === "carol");
  room.update(carol?.id as string, { role: null });
  assert.equal(carol?.role, undefined);
  assert.equal(
    room.update(bob.id, { role: "orchestrator" }).role,
    "orchestrator",
  );
});

test("a remove cancels a live turn, keeps the branch with work, and leaves the others alone", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { cmd: STALL }));
  await commitIn(bob, "bob.txt");
  const turn = bob.send("hang");
  assert.equal(bob.status(), "busy");

  await room.remove(bob.id);
  await turn;

  assert.deepEqual(
    room.participants.map((p) => p.name),
    ["alice"],
  );
  assert.ok(await branchExists(repo, bob.branch as string));
  assert.ok(existsSync(bob.worktree), "the checkout is kept, as at dismiss");
  await assert.rejects(room.remove(bob.id), { code: "participant_not_found" });
  // Its name is free again, and alice still answers.
  await room.add(mock("bob"));
  await alice.send("still here");
  assert.equal(alice.status(), "idle");
});

test("update and remove refuse a dismissed room", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  await room.dismiss();
  assert.throws(() => room.update(alice.id, { name: "a" }), {
    code: "room_dismissed",
  });
  await assert.rejects(room.remove(alice.id), { code: "room_dismissed" });
});

test("an unknown base is a refusal, not a failure", async (t) => {
  const repo = await gitRepo(t);
  const { room } = await roomWithAlice(t, repo);
  await assert.rejects(room.add(mock("bob", { base: "no-such-ref" })), {
    code: "invalid_request",
  });
});

test("an agent request checks mode, settings and names in one list", () => {
  const cmd = `node ${MOCK_AGENT}`;
  assert.throws(() => roomAgent({ cmd, name: "a", mode: "safe" }), /M6-5/);
  assert.throws(() => roomAgent({ cmd, name: "a", mode: "ask" }), /M6-5/);
  assert.throws(() => roomAgent({ cmd, name: "a", mode: "yolo" }), /mode/);
  assert.throws(
    () => roomAgent({ cmd, name: "a", settings: { ttlMs: 5 } }),
    /unknown setting "ttlMs"/,
  );
  assert.throws(
    () => roomAgent({ cmd, name: "a", settings: { allowReadOutsideRoot: 1 } }),
    /true or false/,
  );
  assert.deepEqual(
    roomAgent({ cmd, name: "a", mode: "auto", settings: {} }).settings,
    { allowReadOutsideRoot: false },
  );
  assert.throws(
    () =>
      roomAgents([
        { cmd, name: "a" },
        { cmd, name: "A" },
      ]),
    { code: "name_taken" },
  );
  assert.throws(
    () =>
      roomAgents([
        { cmd, name: "a", role: "orchestrator" },
        { cmd, name: "b", role: "orchestrator" },
      ]),
    { code: "orchestrator_exists" },
  );
});

test("a rename cannot take the name of an add still in flight", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const carol = room.add(mock("carol"));
  assert.throws(() => room.update(alice.id, { name: "Carol" }), {
    code: "name_taken",
  });
  await carol;
});

test("a dismiss waits for a remove in flight to release its checkout", async (t) => {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [mock("bob")],
    setup: await openWorktrees(repo, roomId),
    bus: createEventBus(),
  });
  const bob = room.participants[0] as Participant;
  const removing = room.remove(bob.id);
  await room.dismiss();
  // bob wrote nothing, so its release removes the checkout.
  assert.ok(!existsSync(bob.worktree), "released before the dismiss resolved");
  await removing;
});

test("allowReadOutsideRoot reaches the harness's file service", async (t) => {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const bus = createEventBus();
  let said = "";
  bus.addListener(({ update }) => {
    said += JSON.stringify(update);
  });
  const reader = (name: string, allowReadOutsideRoot: boolean) =>
    roomAgent({
      cmd: `node ${HOSTILE_AGENT} --scenario absolute-path`,
      name,
      settings: { allowReadOutsideRoot },
    });
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [reader("closed", false), reader("open", true)],
    setup: await openWorktrees(repo, roomId),
    bus,
  });
  t.after(() => room.dismiss());
  const [closed, open] = room.participants as [Participant, Participant];

  await closed.send("read");
  assert.match(said, /OUTCOME=refused/);
  said = "";
  await open.send("read");
  assert.match(said, /OUTCOME=allowed/);
});

test("a role change cannot take the orchestrator role from an add still in flight", async (t) => {
  const { room, alice } = await roomWithAlice(t, await gitRepo(t));
  const carol = room.add(mock("carol", { role: "orchestrator" }));
  assert.throws(() => room.update(alice.id, { role: "orchestrator" }), {
    code: "orchestrator_exists",
  });
  // The add got the role it held, and alice kept none.
  assert.equal((await carol).role, "orchestrator");
  assert.equal(alice.role, undefined);
});

test("a base that lacks the room's subdirectory is a refusal, not a failure", async (t) => {
  const repo = await gitRepo(t);
  await mkdir(join(repo, "app"));
  await writeFile(join(repo, "app", "x.txt"), "x\n");
  await git(repo, "add", "app");
  await git(repo, "commit", "-m", "app");
  const { room } = await roomWithAlice(t, join(repo, "app"));
  await assert.rejects(room.add(mock("bob", { base: "HEAD~1" })), {
    code: "invalid_request",
    message: /the folder app is not in HEAD~1/,
  });
});

test("a room in a folder that is not committed refuses an add, naming the folder", async (t) => {
  const repo = await gitRepo(t);
  await mkdir(join(repo, "newdir"));
  const roomId = newRoomId();
  await assert.rejects(
    openRoom({
      roomId,
      cwd: join(repo, "newdir"),
      agents: [mock("alice")],
      setup: await openWorktrees(join(repo, "newdir"), roomId),
      bus: createEventBus(),
    }),
    { code: "invalid_request", message: /the folder newdir is not in HEAD/ },
  );
});
