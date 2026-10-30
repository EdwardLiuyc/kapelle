/**
 * Room runtime tests — stories M6-6a (#150), M6-3 (#147), M6-4 (#148) and
 * M6-5 (#149).
 *
 * Drives `core/room.ts` directly, with no daemon and no route: each
 * participant owns a checkout and a branch, turns run in parallel, a base
 * may be another participant's branch, and a dismiss keeps the work. The
 * roster changes after the room opens: names stay unique, one orchestrator
 * at most, and a remove leaves the others alone. A busy participant queues
 * messages, and a cancel drops them (M6-4). Each participant has a mode: the
 * room sets the harness's own mode, and an `ask` participant's write waits in
 * the permission queue, named by room, participant and turn (M6-5).
 * A pause keeps the room on disk, and `restoreRoom` brings it back; the next
 * message revives a participant with a fresh session (M6-7a), or loads its
 * old one where the harness can (M6-7b).
 * `mock-agent.mjs`'s default turn writes `ACP_TEST.md` through the client,
 * which is the file each test looks for.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
import type { AgentEventEnvelope } from "../../protocol/agent.ts";
import { AGENTS } from "../../protocol/registry.ts";
import type {
  ClientMessageQueuedEvent,
  ClientUserMessageEvent,
} from "../../protocol/types.ts";
import type { Seen } from "../check.ts";
import { readProjectLinkPaths } from "../config.ts";
import { checkoutDiff } from "../diff.ts";
import { createEventBus, type EventBus } from "../events.ts";
import { newRoomId } from "../ids.ts";
import { createPermissionQueue } from "../permissions.ts";
import {
  crashed,
  openRoom,
  type Participant,
  participantChanges,
  QUEUE_BOUND,
  type Room,
  type RoomRecord,
  RoomRefusal,
  readRoomRecord,
  restoreRoom,
  roomAgent,
  roomAgents,
  roomFile,
  writeRoomRecord,
} from "../room.ts";
import { stateDirFor } from "../runtime.ts";
import { changedPaths, openWorktrees } from "../worktree.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

isolateStateHome();

/** Every room's `ask` queue. Nothing waits out this timeout: a turn's end
 *  settles what it left open. */
const queue = createPermissionQueue(60_000);

/** One checked agent request running the mock, named `name`. */
const mock = (name: string, fields: Record<string, unknown> = {}) =>
  roomAgent({ cmd: `node ${MOCK_AGENT}`, name, ...fields });

/** A room in `cwd` with `alice` as its starter, dismissed after the test. */
async function roomWithAlice(
  t: TestContext,
  cwd: string,
): Promise<{ room: Room; alice: Participant; roomId: string; bus: EventBus }> {
  const roomId = newRoomId();
  const bus = createEventBus();
  const room = await openRoom({
    roomId,
    cwd,
    agents: [mock("alice")],
    setup: await openWorktrees(cwd, roomId),
    bus,
    permissions: queue,
  });
  t.after(() => room.dismiss());
  return { room, alice: room.participants[0] as Participant, roomId, bus };
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
  const bus = createEventBus();
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
  });
  const joined: string[] = [];
  bus.addListener(({ update }) => {
    if (update.sessionUpdate === "_client_participant_added") {
      joined.push(update.name);
    }
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
  assert.deepEqual(joined, [], "a rolled-back add never joined the log");
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
    permissions: queue,
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
    permissions: queue,
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

test("every roster change is on the log, and a removed participant's last line says so (M6-10)", async (t) => {
  const { room, p: alice, events, of } = await roomOn(t, "remember");
  const bob = await room.add(mock("bob", { role: "tester" }));
  room.update(bob.id, { name: "robert", mode: "safe" });
  room.update(bob.id, { role: null });
  await room.remove(bob.id);

  const roster = events
    .filter((e) => e.update.sessionUpdate.startsWith("_client_participant_"))
    .map(({ agent, update }) => ({ agent, update }));
  assert.deepEqual(roster, [
    {
      agent: alice.id,
      update: {
        sessionUpdate: "_client_participant_added",
        name: "alice",
        harness: "mock-agent",
        mode: "auto",
      },
    },
    {
      agent: bob.id,
      update: {
        sessionUpdate: "_client_participant_added",
        name: "bob",
        role: "tester",
        harness: "mock-agent",
        mode: "auto",
      },
    },
    {
      agent: bob.id,
      update: {
        sessionUpdate: "_client_participant_changed",
        name: "robert",
        mode: "safe",
      },
    },
    {
      agent: bob.id,
      update: { sessionUpdate: "_client_participant_changed", role: null },
    },
    { agent: bob.id, update: { sessionUpdate: "_client_participant_removed" } },
  ]);
  // Joined once the harness has a session, and nothing of bob's after he left.
  const bobs = events.filter((e) => e.agent === bob.id);
  assert.equal(
    bobs.at(-1)?.update.sessionUpdate,
    "_client_participant_removed",
  );
  assert.ok(
    of("_client_harness_spawned").every(
      (e) =>
        events.indexOf(e) <
        events.findIndex(
          (a) =>
            a.agent === e.agent &&
            a.update.sessionUpdate === "_client_participant_added",
        ),
    ),
  );
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
  // R12: `auto` unless the request names another mode.
  assert.equal(roomAgent({ cmd, name: "a" }).mode, "auto");
  assert.equal(roomAgent({ cmd, name: "a", mode: "safe" }).mode, "safe");
  assert.equal(roomAgent({ cmd, name: "a", mode: "ask" }).mode, "ask");
  assert.throws(() => roomAgent({ cmd, name: "a", mode: "yolo" }), /mode/);
  assert.throws(() => roomAgent({ cmd, name: "a", mode: null }), /mode/);
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
    permissions: queue,
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
    permissions: queue,
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
      permissions: queue,
    }),
    { code: "invalid_request", message: /the folder newdir is not in HEAD/ },
  );
});

/** A room with one participant running the mock's `scenario`, and every
 *  event its bus carried. */
async function roomOn(
  t: TestContext,
  scenario: string,
  limits?: { stallIdleMs: number; stallRepeatCount: number },
) {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const bus = createEventBus();
  const events: AgentEventEnvelope[] = [];
  bus.addListener((e) => events.push(e));
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [
      roomAgent({
        cmd: `node ${MOCK_AGENT} --scenario ${scenario}`,
        name: "alice",
      }),
    ],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
    ...(limits && { limits }),
  });
  t.after(() => room.dismiss());
  const p = room.participants[0] as Participant;
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  return { room, p, events, of };
}

test("a busy participant queues messages and answers them in order, on one session", async (t) => {
  const { p, events, of } = await roomOn(t, "remember");

  const turns = ["a", "b", "c"].map((text) => p.send(text));
  assert.equal(p.status(), "busy");
  assert.equal(p.queued, 2);
  await Promise.all(turns);

  assert.equal(p.queued, 0);
  assert.equal(of("_client_message_queued").length, 2);
  assert.deepEqual(
    of("_client_user_message").map((e) => (e.update as { text: string }).text),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    of("agent_message_chunk").map(
      (e) => (e.update as { content: { text: string } }).content.text,
    ),
    ["previous: (none)", "previous: a", "previous: b"],
  );
  // S10: the bus names the participant, never the harness.
  assert.ok(events.every((e) => e.agent === p.id));
});

test(`the queue holds ${QUEUE_BOUND}, and a cancel drops it and keeps the session`, async (t) => {
  const { p, of } = await roomOn(t, "stall");

  const live = p.send("live");
  const waiting = Array.from({ length: QUEUE_BOUND }, (_, i) =>
    p.send(`wait ${i}`),
  );
  assert.equal(p.queued, QUEUE_BOUND);
  assert.throws(
    () => p.send("one too many"),
    (err) => err instanceof RoomRefusal && err.code === "queue_full",
  );

  assert.equal(p.cancel(), true);
  assert.equal(p.queued, 0);
  await Promise.all([live, ...waiting]);
  assert.equal(p.status(), "idle");
  assert.equal(p.cancel(), false, "nothing is live to cancel");
  assert.deepEqual(
    of("_client_queue_cleared").map((e) => e.update),
    [{ sessionUpdate: "_client_queue_cleared", count: QUEUE_BOUND }],
  );
  assert.deepEqual(
    of("_client_user_message").map((e) => (e.update as { text: string }).text),
    ["live"],
    "a dropped message never reached the harness",
  );

  // Same harness, same session: the next message starts a turn.
  const next = p.send("next");
  assert.equal(p.status(), "busy");
  p.cancel();
  await next;
  assert.equal(of("_client_harness_spawned").length, 1);
});

test("a harness that dies during a turn takes its queue, reads killed, and revives fresh", async (t) => {
  const { p, of } = await roomOn(t, "stall");
  const turns = [p.send("live"), p.send("queued")];
  const [spawned] = of("_client_harness_spawned");
  assert.ok(spawned);
  const { pid } = spawned.update as { pid: number };
  process.kill(pid, "SIGKILL");
  await Promise.all(turns);

  assert.equal(p.status(), "killed", "it stopped during a turn (R46)");
  assert.deepEqual(
    of("_client_queue_cleared").map((e) => e.update),
    [{ sessionUpdate: "_client_queue_cleared", count: 1 }],
  );
  assert.equal(p.resumed, undefined);

  // The next message starts a new harness with a fresh session.
  const revived = p.send("again");
  for (
    const until = Date.now() + 5_000;
    of("_client_participant_revived").length === 0 && Date.now() < until;
  ) {
    await new Promise((ok) => setTimeout(ok, 20));
  }
  const [line] = of("_client_participant_revived");
  assert.ok(line, "no revive within 5 s");
  assert.deepEqual(line.update, {
    sessionUpdate: "_client_participant_revived",
    resumed: "fresh",
    sessionId: p.sessionId,
  });
  assert.equal(p.resumed, "fresh");
  assert.equal(p.status(), "busy");
  assert.equal(of("_client_harness_spawned").length, 2);
  p.cancel();
  await revived;
  assert.equal(p.status(), "idle");
});

test("a harness that dies while idle reads exited, and the next message revives it", async (t) => {
  const { p, of } = await roomOn(t, "remember");
  await p.send("one");
  const [spawned] = of("_client_harness_spawned");
  assert.ok(spawned);
  process.kill((spawned.update as { pid: number }).pid, "SIGKILL");
  for (
    const until = Date.now() + 5_000;
    p.status() !== "exited" && Date.now() < until;
  ) {
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(p.status(), "exited");

  await p.send("two");
  const answers = of("agent_message_chunk").map(
    (e) => (e.update as { content: { text: string } }).content.text,
  );
  // `remember` answers with the session's last prompt: a fresh one has none.
  assert.deepEqual(answers, ["previous: (none)", "previous: (none)"]);
  assert.equal(p.status(), "idle");
  assert.equal(p.resumed, "fresh");
});

test("the watchdog warns about a silent turn and never cancels it (R38)", async (t) => {
  const { p, of } = await roomOn(t, "stall", {
    stallIdleMs: 100,
    stallRepeatCount: 0,
  });
  const turn = p.send("hi");
  for (
    const until = Date.now() + 5_000;
    of("_client_stall_warning").length === 0 && Date.now() < until;
  ) {
    await new Promise((ok) => setTimeout(ok, 50));
  }

  const [warning] = of("_client_stall_warning");
  assert.ok(warning, "no stall warning within 5 s");
  assert.equal(warning.agent, p.id);
  assert.equal((warning.update as { kind: string }).kind, "idle");
  assert.equal(p.status(), "busy", "a warning is not a cancel");
  assert.equal(of("_client_cancel_requested").length, 0);
  p.cancel();
  await turn;
});

test("removing a participant drops its queue and reports it", async (t) => {
  const { room, p, of } = await roomOn(t, "stall");
  const live = p.send("live");
  const waiting = [p.send("a"), p.send("b")];
  assert.equal(p.queued, 2);

  await room.remove(p.id);
  assert.deepEqual(
    of("_client_queue_cleared").map((e) => e.update),
    [{ sessionUpdate: "_client_queue_cleared", count: 2 }],
  );
  await live;
  await Promise.all(waiting);
  assert.throws(
    () => p.send("after"),
    (err) => err instanceof RoomRefusal && err.code === "agent_exited",
  );
});

// --- modes and permissions (M6-5, #149) --------------------------------------

/** A `measured` half for the mock: ids the test can tell apart, and a
 *  harness that never asks, so its containment line names the mode. */
const MEASURED = {
  shell: "internal",
  argvChannel: "notification",
  asksPermission: false,
  modeMap: { safe: "id-safe", ask: "id-ask", auto: "id-auto" },
  usage: "per-turn",
  measuredOn: { version: "0.1.0", date: "2026-09-29" },
} as const;

/** A room whose one participant runs the mock with `fields`, and every
 *  event its bus carried. `spec` overrides registry fields, such as a
 *  `measured` half. */
async function modeRoom(
  t: TestContext,
  fields: Record<string, unknown>,
  { scenario, spec }: { scenario?: string; spec?: object } = {},
) {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const bus = createEventBus();
  const events: AgentEventEnvelope[] = [];
  bus.addListener((e) => events.push(e));
  const request = roomAgent({
    cmd: `node ${MOCK_AGENT}${scenario ? ` --scenario ${scenario}` : ""}`,
    name: "alice",
    ...fields,
  });
  if (spec) request.spec = { ...request.spec, ...spec } as typeof request.spec;
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [request],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
  });
  t.after(() => room.dismiss());
  const p = room.participants[0] as Participant;
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  return { room, p, of, events, roomId };
}

/** The `n`th `_client_permission_queued` event, once it has arrived. */
async function queued(of: (kind: string) => AgentEventEnvelope[], n: number) {
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    const found = of("_client_permission_queued")[n - 1];
    if (found) return found.update as { id: string; kind: string };
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error(`no permission #${n} was queued`);
}

test("a room sets the harness mode: safe's id, or ask's for ask and auto, never auto's", async (t) => {
  const { room, p, of, events } = await modeRoom(
    t,
    { mode: "safe" },
    { scenario: "remember", spec: { measured: MEASURED } },
  );
  const sent = () =>
    of("current_mode_update").map(
      (e) => (e.update as { currentModeId: string }).currentModeId,
    );
  assert.deepEqual(sent(), ["id-safe"], "sent at session start");
  const line = (mode: string) =>
    p.notices.some((n) => n.text.includes(`--mode ${mode} does not bound`));
  assert.ok(line("safe"));

  room.update(p.id, { mode: "auto" });
  assert.equal(p.mode, "auto");
  assert.deepEqual(sent(), ["id-safe"], "nothing is sent between turns");
  assert.ok(line("auto"), "the change posts the new mode's containment line");
  assert.ok(!line("safe"), "and it replaces the old mode's line");

  await p.send("one");
  assert.deepEqual(sent(), ["id-safe", "id-ask"], "sent before the turn");
  const order = events
    .map((e) => e.update.sessionUpdate)
    .filter((u) =>
      [
        "_client_user_message",
        "current_mode_update",
        "agent_message_chunk",
      ].includes(u),
    );
  assert.deepEqual(order.slice(-3), [
    "_client_user_message",
    "current_mode_update",
    "agent_message_chunk",
  ]);

  room.update(p.id, { mode: "ask" });
  await p.send("two");
  assert.deepEqual(sent(), ["id-safe", "id-ask"], "ask and auto share an id");

  room.update(p.id, { mode: "safe" });
  await p.send("three");
  assert.deepEqual(sent(), ["id-safe", "id-ask", "id-safe"]);
  assert.ok(!sent().includes("id-auto"));
});

test("a harness with no mode ids gets none, and a line that says so once", async (t) => {
  const { room, p, of } = await modeRoom(t, { mode: "safe" });
  room.update(p.id, { mode: "auto" });
  await p.send("one");
  room.update(p.id, { mode: "safe" });
  await p.send("two");
  assert.equal(of("current_mode_update").length, 0);
  const lines = p.notices.filter((n) => /mode was not negotiated/.test(n.text));
  assert.deepEqual(
    lines.map((n) => n.text.match(/(\w+) mode was/)?.[1]),
    ["safe"],
    "one line, for the current mode",
  );
});

test("a mode above the harness's ceiling is refused, and nothing applies", async (t) => {
  const { room, p } = await modeRoom(
    t,
    { mode: "safe" },
    { spec: { maxMode: "safe" } },
  );
  assert.throws(
    () => room.update(p.id, { name: "bob", mode: "auto" }),
    (err) => err instanceof RoomRefusal && err.code === "invalid_request",
  );
  assert.deepEqual([p.name, p.mode], ["alice", "safe"]);
});

test("a turn cancelled while its mode is sent never sends its prompt", async (t) => {
  const { room, p, of } = await modeRoom(
    t,
    { mode: "safe" },
    { spec: { measured: MEASURED } },
  );
  room.update(p.id, { mode: "auto" });
  const turn = p.send("go");
  assert.equal(p.cancel(), true);
  await turn;
  assert.deepEqual(
    of("_client_turn_ended").map(
      (e) => (e.update as { stopReason?: string }).stopReason,
    ),
    ["cancelled"],
  );
  assert.ok(!existsSync(join(p.worktree, "ACP_TEST.md")));
});

test("an ask participant's write waits in the queue, named by room, participant and turn", async (t) => {
  const { p, of, roomId } = await modeRoom(t, { mode: "ask" });
  const turn = p.send("go");
  const first = await queued(of, 1);
  assert.deepEqual(queue.get(first.id), {
    id: first.id,
    roomId,
    participantId: p.id,
    turn: 1,
    kind: "edit",
    title: "Write ACP_TEST.md",
    // The tool's input, as text (M4-3).
    input: { path: "ACP_TEST.md" },
  });
  const [message] = of("_client_user_message");
  assert.ok(message);
  assert.equal((message.update as { turn: number }).turn, 1);

  assert.equal(queue.answer(first.id, true), "ok");
  const second = await queued(of, 2);
  assert.equal(queue.answer(second.id, false), "ok");
  await turn;
  assert.equal(queue.answer(first.id, false), "settled", "first writer wins");
  assert.ok(existsSync(join(p.worktree, "ACP_TEST.md")));
  assert.deepEqual(
    of("_client_permission_answered").map((e) => e.update),
    [
      {
        sessionUpdate: "_client_permission_answered",
        id: first.id,
        allow: true,
        reason: "client",
      },
      {
        sessionUpdate: "_client_permission_answered",
        id: second.id,
        allow: false,
        reason: "client",
      },
    ],
  );
  // S10: the room log names the participant, never the harness.
  assert.ok(
    [
      ...of("_client_permission_queued"),
      ...of("_client_permission_answered"),
    ].every((e) => e.agent === p.id),
  );

  // The next turn is turn 2.
  const next = p.send("again");
  const third = await queued(of, 3);
  assert.equal((queue.get(third.id) as { turn: number }).turn, 2);
  p.cancel();
  await next;
});

for (const [how, end] of [
  ["a cancel", async ({ p }) => void p.cancel()],
  ["a removal", async ({ room, p }) => room.remove(p.id)],
  ["a dismiss", async ({ room }) => room.dismiss()],
  [
    "a harness that exits",
    async ({ of }) => {
      const [spawned] = of("_client_harness_spawned");
      assert.ok(spawned);
      process.kill((spawned.update as { pid: number }).pid, "SIGKILL");
    },
  ],
] as [
  string,
  (r: Awaited<ReturnType<typeof modeRoom>>) => Promise<unknown>,
][]) {
  test(`${how} closes an open decision as cancel`, async (t) => {
    const r = await modeRoom(t, { mode: "ask" });
    const turn = r.p.send("go");
    const { id } = await queued(r.of, 1);
    await end(r);
    await turn;
    assert.deepEqual(
      r.of("_client_permission_answered").map((e) => e.update),
      [
        {
          sessionUpdate: "_client_permission_answered",
          id,
          allow: false,
          reason: "cancel",
        },
      ],
    );
    assert.equal((queue.get(id) as { reason: string }).reason, "cancel");
  });
}

test("a safe participant's write is refused, and it reads nothing outside", async (t) => {
  const { room, p, of } = await modeRoom(t, {
    mode: "safe",
    settings: { allowReadOutsideRoot: true },
  });
  assert.deepEqual(p.settings, { allowReadOutsideRoot: false });
  await p.send("go");
  assert.ok(!existsSync(join(p.worktree, "ACP_TEST.md")));
  assert.equal(of("_client_permission_queued").length, 0, "nothing asks");

  room.update(p.id, { mode: "auto" });
  assert.deepEqual(p.settings, { allowReadOutsideRoot: true });
});

test("a mode send that failed is sent again before the next turn", async (t) => {
  const { p, of } = await modeRoom(
    t,
    { mode: "safe" },
    { scenario: "mode-refused-once", spec: { measured: MEASURED } },
  );
  assert.equal(of("current_mode_update").length, 0, "the first send failed");
  assert.ok(p.notices.some((n) => /refused, once/.test(n.text)));

  await p.send("go");
  assert.deepEqual(
    of("current_mode_update").map(
      (e) => (e.update as { currentModeId: string }).currentModeId,
    ),
    ["id-safe"],
  );
  assert.ok(
    !p.notices.some((n) => /refused, once/.test(n.text)),
    "the failure line is gone once the send worked",
  );
});

for (const [to, allow] of [
  ["auto", true],
  ["safe", false],
] as const) {
  test(`a change from ask to ${to} closes the waiting decision as mode_change`, async (t) => {
    const { room, p, of } = await modeRoom(t, { mode: "ask" });
    const turn = p.send("go");
    const { id } = await queued(of, 1);
    room.update(p.id, { mode: to });
    await turn;
    assert.deepEqual(
      of("_client_permission_answered").map((e) => e.update),
      [
        {
          sessionUpdate: "_client_permission_answered",
          id,
          allow,
          reason: "mode_change",
        },
      ],
    );
    assert.equal(
      of("_client_permission_queued").length,
      1,
      "the rest of the turn asks nobody",
    );
    assert.equal(existsSync(join(p.worktree, "ACP_TEST.md")), allow);
  });
}

test("the mode-send line names the current mode, within ask and auto too", async (t) => {
  const { room, p } = await modeRoom(t, {});
  const named = () =>
    p.notices
      .map((n) => n.text.match(/so (\w+) mode was not negotiated/)?.[1])
      .filter(Boolean);
  assert.deepEqual(named(), ["auto"]);
  room.update(p.id, { mode: "ask" });
  assert.deepEqual(named(), ["ask"], "at once, with no turn between");
  room.update(p.id, { mode: "safe" });
  assert.deepEqual(named(), ["safe"]);
});

test("a failed mode send names the current mode until it is sent again", async (t) => {
  const { room, p } = await modeRoom(
    t,
    { mode: "ask" },
    { scenario: "mode-refused-once", spec: { measured: MEASURED } },
  );
  const failed = () =>
    p.notices
      .map((n) => n.text.match(/failed .* (\w+) mode is filtering only/)?.[1])
      .filter(Boolean);
  assert.deepEqual(failed(), ["ask"]);
  room.update(p.id, { mode: "auto" });
  assert.deepEqual(failed(), ["auto"], "the same id failed, for auto too");
  room.update(p.id, { mode: "safe" });
  assert.deepEqual(failed(), [], "safe's id was never sent, so nothing failed");
});

for (const [mode, id] of [
  ["safe", "id-safe"],
  ["ask", "id-ask"],
  ["auto", "id-ask"],
] as const) {
  test(`a room opened in ${mode} sends ${id} at session start`, async (t) => {
    const { of } = await modeRoom(
      t,
      { mode },
      { spec: { measured: MEASURED } },
    );
    assert.deepEqual(
      of("current_mode_update").map(
        (e) => (e.update as { currentModeId: string }).currentModeId,
      ),
      [id],
    );
  });
}

test("a mode change answers only that participant's question", async (t) => {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const bus = createEventBus();
  const request = (name: string) => {
    const one = roomAgent({ cmd: `node ${MOCK_AGENT}`, name, mode: "ask" });
    one.spec = { ...one.spec, measured: MEASURED } as typeof one.spec;
    return one;
  };
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [request("alice"), request("bob")],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
  });
  t.after(() => room.dismiss());
  const [alice, bob] = room.participants as [Participant, Participant];
  const turns = [alice.send("go"), bob.send("go")];

  let asks: { id: string; participantId: string }[] = [];
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    asks = queue
      .list()
      .flatMap((d) =>
        "roomId" in d && d.roomId === roomId
          ? [{ id: d.id, participantId: d.participantId }]
          : [],
      );
    if (asks.length === 2) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(asks.length, 2, "both participants asked");
  const aliceAsk = asks.find((a) => a.participantId === alice.id);
  const bobAsk = asks.find((a) => a.participantId === bob.id);
  assert.ok(aliceAsk && bobAsk);

  room.update(bob.id, { mode: "auto" });

  const bobSettled = queue.get(bobAsk.id) as {
    allow?: boolean;
    reason?: string;
  };
  assert.deepEqual(
    [bobSettled.allow, bobSettled.reason],
    [true, "mode_change"],
  );
  assert.equal(
    (queue.get(aliceAsk.id) as { reason?: string }).reason,
    undefined,
    "alice's question is still open",
  );

  alice.cancel();
  bob.cancel();
  await Promise.all(turns);
});

test("a fast-forward moves the target's branch and checkout to the source commit", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice, bus } = await roomWithAlice(t, repo);
  await commitIn(alice, "alice.txt");
  const bob = await room.add(mock("bob", { base: alice.branch }));
  await commitIn(bob, "bob.txt");

  const events: unknown[] = [];
  bus.addListener(({ update }) => {
    if (update.sessionUpdate === "_client_participant_fast_forwarded") {
      events.push(update);
    }
  });
  const source = await git(bob.worktree, "rev-parse", "HEAD");
  await room.fastForward(alice.id, bob.id);

  assert.equal(await git(alice.worktree, "rev-parse", "HEAD"), source);
  assert.equal(
    await git(alice.worktree, "rev-parse", alice.branch as string),
    source,
  );
  assert.ok(existsSync(join(alice.worktree, "bob.txt")));
  assert.equal(await git(bob.worktree, "rev-parse", "HEAD"), source);
  assert.deepEqual(events, [
    {
      sessionUpdate: "_client_participant_fast_forwarded",
      from: bob.id,
      branch: alice.branch,
      sha: source,
    },
  ]);
});

test("a fast-forward to the commit the target already has is a silent no-op", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice, bus } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { base: alice.branch }));
  const events: unknown[] = [];
  bus.addListener(({ update }) => {
    if (update.sessionUpdate === "_client_participant_fast_forwarded") {
      events.push(update);
    }
  });
  const before = await git(alice.worktree, "rev-parse", "HEAD");

  await room.fastForward(alice.id, bob.id);

  assert.equal(await git(alice.worktree, "rev-parse", "HEAD"), before);
  assert.deepEqual(events, []);
});

test("a fast-forward refuses a busy target, and changes nothing", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { base: alice.branch }));
  const before = await git(alice.worktree, "rev-parse", "HEAD");
  const turn = alice.send("hold");
  assert.equal(alice.status(), "busy");

  await assert.rejects(
    room.fastForward(alice.id, bob.id),
    (err: unknown) => err instanceof RoomRefusal && err.code === "agent_busy",
  );
  assert.equal(await git(alice.worktree, "rev-parse", "HEAD"), before);
  await turn;
});

test("a fast-forward refuses tracked dirt, but not an untracked file (2c)", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { base: alice.branch }));
  await commitIn(bob, "bob.txt");
  const target = await git(bob.worktree, "rev-parse", "HEAD");

  await writeFile(join(alice.worktree, "README.md"), "dirty\n");
  await assert.rejects(
    room.fastForward(alice.id, bob.id),
    (err: unknown) =>
      err instanceof RoomRefusal && err.code === "dirty_worktree",
  );
  assert.notEqual(await git(alice.worktree, "rev-parse", "HEAD"), target);

  await git(alice.worktree, "checkout", "--", "README.md");
  await writeFile(join(alice.worktree, "scratch.txt"), "untracked\n");
  await room.fastForward(alice.id, bob.id);
  assert.equal(await git(alice.worktree, "rev-parse", "HEAD"), target);
  assert.ok(existsSync(join(alice.worktree, "scratch.txt")));
});

test("a fast-forward refuses a diverged target (R45)", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { base: alice.branch }));
  await commitIn(alice, "alice-late.txt");
  await commitIn(bob, "bob.txt");
  const before = await git(alice.worktree, "rev-parse", "HEAD");

  await assert.rejects(
    room.fastForward(alice.id, bob.id),
    (err: unknown) =>
      err instanceof RoomRefusal && err.code === "not_fast_forward",
  );
  assert.equal(await git(alice.worktree, "rev-parse", "HEAD"), before);
});

test("a fast-forward refuses a target checkout that is not on its branch", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { base: alice.branch }));
  await commitIn(bob, "bob.txt");
  await git(alice.worktree, "checkout", "-b", "detour");
  const before = await git(alice.worktree, "rev-parse", "HEAD");

  await assert.rejects(
    room.fastForward(alice.id, bob.id),
    (err: unknown) =>
      err instanceof RoomRefusal && err.code === "not_fast_forward",
  );
  assert.equal(await git(alice.worktree, "rev-parse", "HEAD"), before);
});

test("a message during a fast-forward does not start a turn on the moving checkout", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice, bus } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { base: alice.branch }));
  await commitIn(bob, "bob.txt");
  const order: string[] = [];
  bus.addListener(({ agent, update }) => {
    if (agent !== alice.id) return;
    if (update.sessionUpdate === "_client_user_message") order.push("turn");
    if (update.sessionUpdate === "_client_participant_fast_forwarded") {
      order.push("moved");
    }
  });
  const moving = room.fastForward(alice.id, bob.id);
  const turn = alice.send("hello");
  await moving;
  await turn;
  assert.deepEqual(order, ["moved", "turn"]);
});

test("a fast-forward refuses an untracked file the move would overwrite, and keeps it", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { base: alice.branch }));
  await commitIn(bob, "bob.txt");
  await writeFile(join(alice.worktree, "bob.txt"), "alice's own\n");
  const before = await git(alice.worktree, "rev-parse", "HEAD");

  await assert.rejects(
    room.fastForward(alice.id, bob.id),
    (err: unknown) =>
      err instanceof RoomRefusal && err.code === "dirty_worktree",
  );
  assert.equal(await git(alice.worktree, "rev-parse", "HEAD"), before);
  assert.equal(
    await readFile(join(alice.worktree, "bob.txt"), "utf8"),
    "alice's own\n",
  );
});

test("a safe participant refuses a read outside the root, whatever the request said", async (t) => {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const bus = createEventBus();
  let said = "";
  bus.addListener(({ update }) => {
    said += JSON.stringify(update);
  });
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [
      roomAgent({
        cmd: `node ${HOSTILE_AGENT} --scenario absolute-path`,
        name: "alice",
        mode: "safe",
        settings: { allowReadOutsideRoot: true },
      }),
    ],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
  });
  t.after(() => room.dismiss());
  const alice = room.participants[0] as Participant;
  await alice.send("read /etc/passwd");
  assert.match(said, /OUTCOME=refused/);
});

test("a fast-forward refuses when the source branch ref is gone", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { base: alice.branch }));
  await commitIn(bob, "bob.txt");
  await git(repo, "update-ref", "-d", `refs/heads/${bob.branch}`);

  await assert.rejects(
    room.fastForward(alice.id, bob.id),
    (err: unknown) => err instanceof RoomRefusal && err.code === "no_branch",
  );
});

test("a fast-forward refuses when the target branch ref is gone", async (t) => {
  const repo = await gitRepo(t);
  const { room, alice } = await roomWithAlice(t, repo);
  const bob = await room.add(mock("bob", { base: alice.branch }));
  await git(repo, "update-ref", "-d", `refs/heads/${alice.branch}`);

  await assert.rejects(
    room.fastForward(alice.id, bob.id),
    (err: unknown) => err instanceof RoomRefusal && err.code === "no_branch",
  );
});

test("a harness that renames its branch moves the record and the release to it", async (t) => {
  const { room, p } = await roomOn(t, "read-only");
  const repo = room.meta.cwd;
  const renamed = "renamed-topic";
  assert.equal(p.branch, `kapelle/${room.meta.id}/${p.id}`);

  await git(p.worktree, "branch", "-m", renamed);
  await p.send("go");

  assert.equal(p.branch, renamed);
  assert.ok(await branchExists(repo, renamed));
  await until(
    () =>
      readRoomRecord(roomFile(repo, room.meta.id)).participants[0]?.branch ===
      renamed,
    "room.json shows the renamed branch",
  );

  await room.dismiss();
  assert.ok(
    !(await branchExists(repo, renamed)),
    "an untouched renamed branch is rolled back",
  );
});

test("a harness that rebases moves the base its whole-branch diff starts at", async (t) => {
  const { room, p } = await roomOn(t, "read-only");
  const repo = room.meta.cwd;
  await commitIn(p, "agent.txt");
  const before = p.baseSha;

  await writeFile(join(repo, "base.txt"), "new base\n");
  await git(repo, "add", "base.txt");
  await git(repo, "commit", "-m", "base moves");
  const newer = await git(repo, "rev-parse", "HEAD");
  assert.notEqual(newer, before);

  await git(p.worktree, "rebase", "main");
  await p.send("go");

  assert.equal(p.baseSha, newer);
  await until(
    () =>
      readRoomRecord(roomFile(repo, room.meta.id)).participants[0]?.baseSha ===
      newer,
    "room.json shows the rebased base",
  );
  const diff = await checkoutDiff(p.worktree, p.baseSha as string);
  assert.match(diff.text, /agent\.txt/);
  assert.doesNotMatch(diff.text, /base\.txt/);
});

// --- pause, restore and revive (M6-7a) -------------------------------------

/** A room of one `scenario` participant, as `roomOn` makes it, with the
 *  pieces a restore needs. */
async function pausable(
  t: TestContext,
  scenario: string,
  pauseGraceMs = 2_000,
) {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const bus = createEventBus();
  const events: AgentEventEnvelope[] = [];
  bus.addListener((e) => events.push(e));
  const room = await openRoom({
    roomId,
    cwd: repo,
    title: "kept",
    agents: [
      roomAgent({
        cmd: `node ${MOCK_AGENT} --scenario ${scenario}`,
        name: "alice",
      }),
    ],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
    pauseGraceMs,
  });
  t.after(() => room.dismiss());
  const p = room.participants[0] as Participant;
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  const file = roomFile(repo, roomId);
  return { repo, roomId, room, p, of, file };
}

/** The room `room.json` names, restored on a new bus. */
async function restored(
  t: TestContext,
  repo: string,
  record: RoomRecord,
  noteSession?: (agent: string, seen: Seen) => void,
) {
  const bus = createEventBus();
  const events: AgentEventEnvelope[] = [];
  bus.addListener((e) => events.push(e));
  const room = await restoreRoom({
    record,
    setup: await openWorktrees(record.cwd, record.id),
    bus,
    permissions: queue,
    ...(noteSession && { noteSession }),
  });
  t.after(() => room.dismiss());
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  return { room, p: room.participants[0] as Participant, of, repo };
}

/** Waits until `ok` holds, for at most 5 s. */
async function until(ok: () => boolean, what: string) {
  for (const end = Date.now() + 5_000; !ok(); ) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

test("room.json holds the room and its participant from the start", async (t) => {
  const { p, file, roomId, repo } = await pausable(t, "remember");
  const record = readRoomRecord(file);
  assert.equal(record.id, roomId);
  assert.equal(record.cwd, repo);
  assert.equal(record.title, "kept");
  assert.equal(record.status, "active");
  assert.equal(record.participants.length, 1);
  const [saved] = record.participants;
  assert.equal(saved?.id, p.id);
  assert.equal(saved?.sessionId, p.sessionId);
  assert.equal(saved?.branch, p.branch);
  assert.match(saved?.cmd ?? "", /--scenario remember$/);
  assert.equal(saved?.status, "idle");
});

test("room.json shows a participant busy during its turn", async (t) => {
  const { p, file } = await pausable(t, "stall");
  const turn = p.send("hi");
  await until(
    () => readRoomRecord(file).participants[0]?.status === "busy",
    "room.json never read busy",
  );
  p.cancel();
  await turn;
  await until(
    () => readRoomRecord(file).participants[0]?.status === "idle",
    "room.json never read idle again",
  );
});

test("a pause during a turn ends it in the log, and leaves the participant paused", async (t) => {
  const { room, p, of, file } = await pausable(t, "slow");
  void p.send("hi");
  await until(() => p.status() === "busy", "the turn never started");
  await room.pause();

  assert.equal(of("_client_turn_ended").length, 1, "the turn ended first");
  assert.equal(p.status(), "paused");
  assert.equal(room.status(), "paused");
  const record = readRoomRecord(file);
  assert.equal(record.status, "paused");
  assert.equal(record.participants[0]?.status, "paused");
  assert.ok(existsSync(p.worktree), "a pause keeps the checkout");
});

test("a turn that outlives the pause's grace is killed", async (t) => {
  const { room, p, of, file } = await pausable(t, "deaf", 200);
  void p.send("hi");
  await until(() => p.status() === "busy", "the turn never started");
  const started = Date.now();
  await room.pause();

  assert.ok(Date.now() - started < 4_000, "one grace, then the stop");
  assert.equal(p.status(), "killed");
  assert.equal(readRoomRecord(file).participants[0]?.status, "killed");
  assert.equal(of("_client_turn_ended").length, 1);
});

test("a restored room replays its log, revives on a message and goes on with seq", async (t) => {
  const { repo, room, p, file } = await pausable(t, "remember");
  await p.send("one");
  await room.pause();
  const before = room.eventLog?.size ?? 0;
  assert.ok(before > 0);

  const back = await restored(t, repo, readRoomRecord(file));
  assert.equal(back.room.status(), "paused");
  assert.equal(back.p.id, p.id);
  assert.equal(back.p.status(), "paused");
  assert.equal(back.p.worktree, p.worktree, "the same checkout");
  assert.equal(back.p.resumed, undefined);
  assert.equal(back.room.eventLog?.size, before, "the history is there");

  await back.p.send("two");
  assert.equal(back.p.status(), "idle");
  assert.equal(back.p.resumed, "fresh");
  assert.equal(back.room.status(), "active");
  const answers = back
    .of("agent_message_chunk")
    .map((e) => (e.update as { content: { text: string } }).content.text);
  assert.deepEqual(answers, ["previous: (none)"], "a fresh session");
  assert.equal(back.of("_client_participant_revived").length, 1);

  const lines = (
    await readFile(
      join(stateDirFor(repo), "rooms", back.room.meta.id, "events.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map(
      (l) =>
        JSON.parse(l) as { seq: number; update: { sessionUpdate: string } },
    );
  assert.deepEqual(
    lines.map((l) => l.seq),
    lines.map((_, i) => i + 1),
    "one seq, carried on",
  );
  // The message, the new harness, then the revive, before any answer.
  assert.deepEqual(
    lines.slice(before, before + 3).map((l) => l.update.sessionUpdate),
    [
      "_client_user_message",
      "_client_harness_spawned",
      "_client_participant_revived",
    ],
  );
  const saved = readRoomRecord(file);
  assert.equal(saved.status, "active");
  assert.equal(saved.participants[0]?.resumed, "fresh");
});

test("a crash's record reads paused and killed, and the killed one revives", async (t) => {
  const { repo, room, p, file } = await pausable(t, "remember");
  await room.pause();
  // What a `kill -9` during a turn leaves: the room live, alice busy.
  const record = readRoomRecord(file);
  const left: RoomRecord = {
    ...record,
    status: "active",
    participants: record.participants.map((x) => ({ ...x, status: "busy" })),
  };
  const fixed = crashed(left);
  assert.equal(fixed.status, "paused");
  assert.equal(fixed.participants[0]?.status, "killed");
  assert.equal(
    crashed({
      ...left,
      participants: [
        {
          ...(left.participants[0] as RoomRecord["participants"][number]),
          status: "idle",
        },
      ],
    }).participants[0]?.status,
    "paused",
  );

  const back = await restored(t, repo, left);
  assert.equal(back.p.status(), "killed", "restore applies it too");
  await back.p.send("hi");
  assert.equal(back.p.status(), "idle");
  assert.equal(back.p.id, p.id);
});

test("a restore reads a branch renamed while the room was paused", async (t) => {
  const { repo, room, p, file } = await pausable(t, "remember");
  await p.send("one");
  await room.pause();
  await git(p.worktree, "branch", "-m", "renamed-topic");

  const back = await restored(t, repo, readRoomRecord(file));
  assert.equal(back.p.branch, "renamed-topic");
});

test("a dismissed room comes back dismissed and is never revived", async (t) => {
  const { repo, room, p, file } = await pausable(t, "remember");
  await p.send("one");
  await room.dismiss();
  const record = readRoomRecord(file);
  assert.equal(record.status, "dismissed");

  const back = await restored(t, repo, record);
  assert.equal(back.room.status(), "dismissed");
  assert.equal(back.p.status(), "dismissed");
  assert.throws(
    () => back.p.send("hi"),
    (err) => err instanceof RoomRefusal && err.code === "room_dismissed",
  );
  assert.equal(back.of("_client_harness_spawned").length, 0);
  assert.ok((back.room.eventLog?.size ?? 0) > 0, "its history replays");
});

test("a room that fails to open leaves no record", async (t) => {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  await assert.rejects(
    openRoom({
      roomId,
      cwd: repo,
      agents: [
        roomAgent({
          cmd: "node -e process.exit(1)",
          name: "alice",
        }),
      ],
      setup: await openWorktrees(repo, roomId),
      bus: createEventBus(),
      permissions: queue,
    }),
  );
  assert.equal(existsSync(roomFile(repo, roomId)), false);
});

test("a restored participant goes on counting its turns (S12)", async (t) => {
  const { repo, room, p, file } = await pausable(t, "remember");
  await p.send("one");
  await room.pause();

  const back = await restored(t, repo, readRoomRecord(file));
  await back.p.send("two");
  const [line] = back.of("_client_user_message");
  assert.equal(
    (line?.update as { turn?: number } | undefined)?.turn,
    2,
    "turn 1 is already on the log",
  );
});

test("a restored participant counts from 1 when room.json has a bad turns (#343)", async (t) => {
  const { repo, room, p, file } = await pausable(t, "remember");
  await p.send("one");
  await room.pause();

  const record = readRoomRecord(file);
  const saved = record.participants[0];
  assert.ok(saved);
  writeRoomRecord(file, {
    ...record,
    participants: [{ ...saved, turns: "x" as unknown as number }],
  });
  const read = readRoomRecord(file);
  const got = read.participants[0];
  assert.ok(got);
  assert.equal(got.turns, undefined);

  const back = await restored(t, repo, read);
  await back.p.send("two");
  const [line] = back.of("_client_user_message");
  assert.equal((line?.update as { turn?: number } | undefined)?.turn, 1);
});

test("an add after a pause is refused and starts no harness", async (t) => {
  const { room, of } = await pausable(t, "remember");
  await room.pause();
  await assert.rejects(
    room.add(roomAgent({ cmd: `node ${MOCK_AGENT}`, name: "bob" })),
    (err) => err instanceof RoomRefusal && err.code === "room_dismissed",
  );
  assert.equal(of("_client_harness_spawned").length, 1);
});

test("an add makes a restored paused room active", async (t) => {
  const { repo, room, file } = await pausable(t, "remember");
  await room.pause();
  const back = await restored(t, repo, readRoomRecord(file));
  assert.equal(back.room.status(), "paused");
  await back.room.add(roomAgent({ cmd: `node ${MOCK_AGENT}`, name: "bob" }));
  assert.equal(back.room.status(), "active");
  // The added line saves the room a moment later.
  await new Promise((ok) => setImmediate(ok));
  assert.equal(readRoomRecord(file).status, "active");
});

test("a revived harness gets a stderr log of its own", async (t) => {
  const { repo, room, p, file } = await pausable(t, "remember");
  await room.pause();
  const back = await restored(t, repo, readRoomRecord(file));
  await back.p.send("two");
  const logs = (
    await readdir(join(stateDirFor(repo), "rooms", room.meta.id))
  ).filter((n) => n.startsWith(`${p.id}.`) && n.endsWith(".stderr.log"));
  assert.equal(logs.length, 2, logs.join(", "));
});

test("a revive whose harness cannot start ends the turn with the error, and stays paused", async (t) => {
  const { repo, room, file } = await pausable(t, "remember");
  await room.pause();
  const record = readRoomRecord(file);
  const saved = record.participants[0] as RoomRecord["participants"][number];
  writeRoomRecord(file, {
    ...record,
    participants: [{ ...saved, cmd: "node -e process.exit(1)" }],
  });

  const back = await restored(t, repo, readRoomRecord(file));
  assert.equal(back.p.status(), "paused");
  await back.p.send("hi");

  assert.equal(back.p.status(), "paused", "a failed revive leaves it stopped");
  assert.equal(back.p.resumed, undefined);
  assert.equal(back.room.status(), "paused", "no revive means no active");
  assert.equal(back.of("_client_participant_revived").length, 0);
  const [ended] = back.of("_client_turn_ended");
  const error = (ended?.update as { error?: unknown } | undefined)?.error;
  assert.equal(typeof error, "string");
  assert.ok(error, "the turn ends with the harness's error");
});

test("forget removes the room's folder, and a save queued before it writes nothing", async (t) => {
  const { room, p, file } = await pausable(t, "remember");
  // A rename queues a save for a moment later.
  room.update(p.id, { name: "renamed" });
  room.forget();
  await new Promise((ok) => setImmediate(ok));
  await new Promise((ok) => setImmediate(ok));
  assert.equal(existsSync(join(file, "..")), false, "no folder comes back");
  // A save that still ran would have failed on the missing folder, and said so.
  assert.ok(
    !p.notices.some((n) => n.text.includes("cannot save the room record")),
    JSON.stringify(p.notices),
  );
});

test("a record with a role outside the set, or a title that is not text, is refused", async (t) => {
  const { room, file } = await pausable(t, "remember");
  await room.pause();
  const record = readRoomRecord(file);
  const saved = record.participants[0] as RoomRecord["participants"][number];
  writeRoomRecord(file, {
    ...record,
    participants: [{ ...saved, role: "boss" as "tester" }],
  });
  assert.throws(() => readRoomRecord(file), /has role "boss"/);
  writeRoomRecord(file, { ...record, title: 7 as unknown as string });
  assert.throws(() => readRoomRecord(file), /"title" is not a string/);
});

// --- session/load on revive (M6-7b) -----------------------------------------

/** A registry entry for the mock with a store and a measured load, named
 *  `id`, so a restored room resolves it again with `measured.loads`. Removed
 *  after the test. It changes the module's own `AGENTS`, which is safe only
 *  because the tests in one file run in turn and each id is unique. */
async function loadingMock(
  t: TestContext,
  scenario: string,
  { loads = true }: { loads?: boolean } = {},
) {
  const store = await tempDir(t);
  const id = `mock-load-${newRoomId()}`;
  AGENTS[id] = {
    launch: {
      command: process.execPath,
      args: [MOCK_AGENT, "--scenario", scenario, "--store", store],
    },
    maxMode: "auto",
    measured: { ...MEASURED, ...(loads && { loads: true as const }) },
  };
  t.after(() => {
    delete AGENTS[id];
  });
  return id;
}

/** `pausable`, on a `loadingMock`. */
async function loading(
  t: TestContext,
  scenario: string,
  {
    loads = true,
    pauseGraceMs = 2_000,
    model,
  }: { loads?: boolean; pauseGraceMs?: number; model?: string } = {},
) {
  const agent = await loadingMock(t, scenario, { loads });
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const bus = createEventBus();
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [roomAgent({ agent, name: "alice", ...(model && { model }) })],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
    pauseGraceMs,
  });
  t.after(() => room.dismiss());
  const p = room.participants[0] as Participant;
  return { repo, roomId, room, p, file: roomFile(repo, roomId), agent };
}

/** The revive event's fields, once there is one. */
const revivedOf = (of: (kind: string) => AgentEventEnvelope[]) =>
  of("_client_participant_revived")[0]?.update as
    | { resumed: string; sessionId: string; memoryMayBeBehind?: true }
    | undefined;

const answersOf = (of: (kind: string) => AgentEventEnvelope[]) =>
  of("agent_message_chunk").map(
    (e) => (e.update as { content: { text: string } }).content.text,
  );

test("a revive loads the old session, keeps the replay off the log and sends the mode again", async (t) => {
  const { repo, room, p, file } = await loading(t, "remember");
  await p.send("one");
  const sessionId = p.sessionId;
  await room.pause();
  const before = room.eventLog?.size ?? 0;

  const back = await restored(t, repo, readRoomRecord(file));
  await back.p.send("two");
  assert.deepEqual(answersOf(back.of), ["previous: one"], "it remembers");
  assert.equal(back.p.resumed, "loaded");
  assert.equal(back.p.sessionId, sessionId, "the same session");
  assert.deepEqual(revivedOf(back.of), {
    sessionUpdate: "_client_participant_revived",
    resumed: "loaded",
    sessionId,
  });

  const lines = (
    await readFile(
      join(stateDirFor(repo), "rooms", back.room.meta.id, "events.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map(
      (l) => (JSON.parse(l) as { update: { sessionUpdate: string } }).update,
    );
  const after = lines.slice(before).map((u) => u.sessionUpdate);
  assert.ok(!after.includes("user_message_chunk"), "no replayed message");
  assert.equal(
    after.filter((k) => k === "agent_message_chunk").length,
    1,
    "only the new answer",
  );
  // `auto` sends `ask`'s id; the load did not keep it.
  assert.deepEqual(
    back
      .of("current_mode_update")
      .map((e) => (e.update as { currentModeId: string }).currentModeId),
    ["id-ask"],
  );
  assert.ok(
    after.indexOf("current_mode_update") < after.indexOf("agent_message_chunk"),
    "the mode goes before the prompt",
  );
  assert.equal(readRoomRecord(file).participants[0]?.resumed, "loaded");
});

test("a pause that cancels a live turn reads paused, and the load warns", async (t) => {
  const { repo, room, p, file } = await loading(t, "slow");
  void p.send("hi");
  await until(() => p.status() === "busy", "the turn never started");
  await room.pause();
  assert.equal(p.status(), "paused");
  const saved = readRoomRecord(file).participants[0];
  assert.equal(saved?.status, "paused");
  assert.equal(saved?.turnCancelled, true);

  const back = await restored(t, repo, readRoomRecord(file));
  assert.equal(
    (back.p as unknown as Record<string, unknown>).turnCancelled,
    undefined,
    "not on the participant a client reads",
  );
  await back.p.send("again");
  assert.equal(revivedOf(back.of)?.resumed, "loaded");
  assert.equal(revivedOf(back.of)?.memoryMayBeBehind, true);
  await until(
    () => readRoomRecord(file).participants[0]?.turnCancelled === undefined,
    "the revive never cleared the flag",
  );
});

test("a person's cancel during a turn makes the next load warn, after an idle pause (#238)", async (t) => {
  const { repo, room, p, file } = await loading(t, "slow");
  const turn = p.send("hi");
  await until(() => p.status() === "busy", "the turn never started");
  assert.equal(p.cancel(), true);
  await turn;
  assert.equal(p.status(), "idle");
  await room.pause();
  assert.equal(readRoomRecord(file).participants[0]?.turnCancelled, true);

  const back = await restored(t, repo, readRoomRecord(file));
  await back.p.send("again");
  assert.equal(revivedOf(back.of)?.resumed, "loaded");
  assert.equal(revivedOf(back.of)?.memoryMayBeBehind, true);
});

test("an idle pause loads with no warning", async (t) => {
  const { repo, room, p, file } = await loading(t, "remember");
  await p.send("one");
  await room.pause();
  assert.equal(readRoomRecord(file).participants[0]?.turnCancelled, undefined);
  const back = await restored(t, repo, readRoomRecord(file));
  await back.p.send("two");
  assert.equal(revivedOf(back.of)?.memoryMayBeBehind, undefined);
});

test("a killed participant's load warns", async (t) => {
  const { repo, room, p, file } = await loading(t, "remember");
  await p.send("one");
  await room.pause();
  // What a `kill -9` during a turn leaves.
  const record = readRoomRecord(file);
  const back = await restored(t, repo, {
    ...record,
    status: "active",
    participants: record.participants.map((x) => ({ ...x, status: "busy" })),
  });
  assert.equal(back.p.status(), "killed");
  await back.p.send("two");
  assert.deepEqual(answersOf(back.of), ["previous: one"]);
  assert.equal(revivedOf(back.of)?.memoryMayBeBehind, true);
});

test("a harness with no measured load revives fresh, though it advertises one", async (t) => {
  const { repo, room, p, file } = await loading(t, "remember", {
    loads: false,
  });
  await p.send("one");
  await room.pause();
  const back = await restored(t, repo, readRoomRecord(file));
  await back.p.send("two");
  assert.deepEqual(answersOf(back.of), ["previous: (none)"]);
  assert.equal(back.p.resumed, "fresh");
  assert.notEqual(back.p.sessionId, p.sessionId);
});

test("a harness that does not advertise loadSession revives fresh, though the registry says it loads", async (t) => {
  const { repo, room, p, file } = await loading(t, "no-load");
  await p.send("one");
  await room.pause();
  const back = await restored(t, repo, readRoomRecord(file));
  await back.p.send("two");
  assert.deepEqual(answersOf(back.of), ["previous: (none)"]);
  assert.equal(back.p.resumed, "fresh");
  assert.notEqual(back.p.sessionId, p.sessionId);
});

test("a load that fails falls back to a fresh session", async (t) => {
  const { repo, room, p, file } = await loading(t, "remember");
  await p.send("one");
  await room.pause();
  const record = readRoomRecord(file);
  const saved = record.participants[0] as RoomRecord["participants"][number];
  const back = await restored(t, repo, {
    ...record,
    participants: [{ ...saved, sessionId: "sess_mock_gone" }],
  });
  await back.p.send("two");
  assert.deepEqual(answersOf(back.of), ["previous: (none)"]);
  assert.equal(revivedOf(back.of)?.resumed, "fresh");
  assert.notEqual(back.p.sessionId, "sess_mock_gone");
});

test("a participant's checkout gets the project's configured links (#274)", async (t) => {
  const repo = await gitRepo(t, { ignore: "node_modules/\n" });
  await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(repo, "node_modules", "pkg", "index.js"), "module\n");
  await mkdir(join(repo, ".kapelle"), { recursive: true });
  await writeFile(
    join(repo, ".kapelle", "config.json"),
    `${JSON.stringify({ linkPaths: ["node_modules"] })}\n`,
    { mode: 0o644 },
  );

  const roomId = newRoomId();
  const bus = createEventBus();
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [mock("alice")],
    setup: await openWorktrees(repo, roomId, {
      linkPaths: readProjectLinkPaths(repo),
    }),
    bus,
    permissions: queue,
  });
  t.after(() => room.dismiss());

  const alice = room.participants[0] as Participant;
  assert.equal(
    (await lstat(join(alice.worktree, "node_modules"))).isDirectory(),
    true,
  );
  assert.equal(
    (await lstat(join(alice.worktree, "node_modules", "pkg"))).isSymbolicLink(),
    true,
  );
  assert.deepEqual(await changedPaths(alice.worktree), []);

  await room.dismiss();
  assert.ok(
    existsSync(join(repo, "node_modules", "pkg", "index.js")),
    "dismiss keeps the main folder",
  );
});

// --- M8-2: a reply to the sender, a copy to the orchestrator --------------

/** A room with `po`, the orchestrator, on `poScenario`, and `dev` on
 *  `scenario`. `told(p)` is each message `p` got, as text, sender and kind. */
async function loopRoom(
  t: TestContext,
  scenario: string,
  poScenario = "remember",
) {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const bus = createEventBus();
  const events: AgentEventEnvelope[] = [];
  bus.addListener((e) => events.push(e));
  const logged: string[] = [];
  const agent = (name: string, s: string, role?: string) =>
    roomAgent({
      cmd: `node ${MOCK_AGENT} --scenario ${s}`,
      name,
      ...(role && { role }),
    });
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [agent("po", poScenario, "orchestrator"), agent("dev", scenario)],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
    log: (line) => logged.push(line),
  });
  t.after(() => room.dismiss());
  const [po, dev] = room.participants as [Participant, Participant];
  const of = (p: Participant, kind: string) =>
    events.filter((e) => e.agent === p.id && e.update.sessionUpdate === kind);
  const told = (p: Participant) =>
    of(p, "_client_user_message").map((e) => {
      const u = e.update as ClientUserMessageEvent;
      return [u.text, u.from, u.kind];
    });
  const settled = () =>
    until(
      () => room.participants.every((p) => p.status() !== "busy"),
      "every participant idle",
    );
  return {
    room,
    po,
    dev,
    of,
    told,
    settled,
    logged,
    repo,
    file: roomFile(repo, roomId),
  };
}

const said = (events: AgentEventEnvelope[]) =>
  events.map((e) => (e.update as { content: { text: string } }).content.text);

test("a turn from the orchestrator's message replies to it, and the reply's turn sends nothing", async (t) => {
  const { po, dev, of, told, settled } = await loopRoom(t, "remember");
  await dev.send("a", po);
  await settled();

  assert.deepEqual(told(po), [
    [
      "[reply from dev] end_turn, 0 tool calls\nprevious: (none)",
      dev.id,
      "reply",
    ],
  ]);
  assert.deepEqual(told(dev), [["a", po.id, undefined]], "no reply back");
  // The reply's own first line takes the place of `[from dev]`.
  await po.send("next");
  assert.equal(
    said(of(po, "agent_message_chunk")).at(-1),
    "previous: [reply from dev] end_turn, 0 tool calls\nprevious: (none)",
  );
});

test("a reply carries the last text before the last tool calls when none follows them", async (t) => {
  const { po, dev, told, settled } = await loopRoom(t, "answer");
  await dev.send("go", po);
  await settled();
  assert.deepEqual(told(po), [
    ["[reply from dev] end_turn, 3 tool calls\nMiddle.", dev.id, "reply"],
  ]);
});

test("a person's message to a worker the orchestrator ordered sends it one copy, and nothing else", async (t) => {
  const { room, po, dev, told, settled } = await loopRoom(t, "remember");
  // No order yet: no copy (#333).
  await dev.send("hi");
  await settled();
  assert.deepEqual(told(po), []);
  assert.equal(dev.orderedBy, undefined);

  await dev.send("a", po);
  await settled();
  assert.equal(dev.orderedBy, po.id);
  await dev.send("hi");
  await settled();
  assert.deepEqual(told(po).at(-1), [
    "[copy] you → dev · end_turn, 0 tool calls\nhi\n\n[answer]\nprevious: [from po]\na",
    dev.id,
    "copy",
  ]);
  assert.equal(dev.orderedBy, po.id, "a person's message keeps the mark");
  assert.equal(told(dev).length, 3, "and dev gets nothing back");

  // To the orchestrator itself, even with its own mark: nothing.
  await po.send("self", po);
  await settled();
  assert.equal(po.orderedBy, po.id);
  const before = told(po).length;
  await po.send("plan");
  await settled();
  assert.equal(told(po).length, before + 1);
  // In a room with no orchestrator: nothing.
  room.update(po.id, { role: null });
  await dev.send("again");
  await settled();
  assert.equal(told(po).length, before + 1);

  // A new orchestrator does not take over po's mark.
  const lead = await room.add(
    roomAgent({
      cmd: `node ${MOCK_AGENT}`,
      name: "lead",
      role: "orchestrator",
    }),
  );
  await dev.send("more");
  await settled();
  assert.equal(told(lead).length, 0);
});

test("the orchestrator's mark on a worker survives a pause and a restore (#333)", async (t) => {
  const { room, po, dev, settled, repo, file } = await loopRoom(t, "remember");
  await dev.send("a", po);
  await settled();
  await room.pause();
  const record = readRoomRecord(file);
  assert.equal(record.participants[1]?.orderedBy, po.id);
  const back = await restored(t, repo, record);
  assert.equal(back.room.participants[1]?.orderedBy, po.id);

  // A hand edit that is not an id is dropped.
  const [first, second] = record.participants as [
    RoomRecord["participants"][number],
    RoomRecord["participants"][number],
  ];
  writeRoomRecord(file, {
    ...record,
    participants: [first, { ...second, orderedBy: 42 as unknown as string }],
  });
  assert.equal(readRoomRecord(file).participants[1]?.orderedBy, undefined);
});

test("a reply or a copy never counts as an order (#333)", async (t) => {
  const { po, dev, settled } = await loopRoom(t, "remember");
  await dev.send("go", po);
  await settled();
  assert.equal(po.orderedBy, undefined, "a reply is not an order");
  await dev.send("again");
  await settled();
  assert.equal(po.orderedBy, undefined, "a copy is not an order");
});

test("an error turn replies with its error, and none of its text", async (t) => {
  const { po, dev, told, settled } = await loopRoom(t, "prompt-error");
  await dev.send("go", po);
  await settled();
  const [[text, from, kind] = []] = told(po);
  assert.match(
    text as string,
    /^\[reply from dev\] error, 1 tool call\n.*the model failed/,
  );
  assert.doesNotMatch(text as string, /Plan\./);
  assert.deepEqual([from, kind], [dev.id, "reply"]);
});

// `half` answers the cancel `end_turn`, as copilot does: the reply still
// says `cancelled by the person`, from our own record (§M0-4).
test("a cancel drops the kept text: the reply is its first line only", async (t) => {
  const { po, dev, of, told, settled } = await loopRoom(t, "half");
  const turn = dev.send("go", po);
  await until(() => of(dev, "tool_call").length > 0, "dev's tool call");
  dev.cancel();
  await turn;
  await settled();
  assert.deepEqual(told(po), [
    ["[reply from dev] cancelled by the person, 1 tool call", dev.id, "reply"],
  ]);
});

test("a person's cancel of a worker's turn says so in the copy too (#377)", async (t) => {
  const { po, dev, of, told, settled } = await loopRoom(t, "half");
  const order = dev.send("go", po);
  await until(() => of(dev, "tool_call").length > 0, "dev's first tool call");
  dev.cancel();
  await order;
  await settled();
  const direct = dev.send("hi");
  await until(() => of(dev, "tool_call").length > 1, "dev's second tool call");
  dev.cancel();
  await direct;
  await settled();
  assert.deepEqual(told(po).at(-1), [
    "[copy] you → dev · cancelled by the person, 1 tool call\nhi",
    dev.id,
    "copy",
  ]);
});

test("a harness exit drops the kept text: the reply is the error only", async (t) => {
  const { po, dev, of, told, settled } = await loopRoom(t, "half");
  const turn = dev.send("go", po);
  await until(() => of(dev, "tool_call").length > 0, "dev's tool call");
  const [spawned] = of(dev, "_client_harness_spawned");
  assert.ok(spawned);
  process.kill((spawned.update as { pid: number }).pid, "SIGKILL");
  await turn;
  await settled();
  const [[text] = []] = told(po);
  assert.match(text as string, /^\[reply from dev\] error, 1 tool call\n/);
  assert.doesNotMatch(text as string, /Plan\./);
});

test("a reply to a sender that left the room is dropped, and the log says so", async (t) => {
  const { room, po, dev, told, logged } = await loopRoom(t, "half");
  const turn = dev.send("go", po);
  await room.remove(po.id);
  dev.cancel();
  await turn;
  assert.equal(told(dev).length, 1);
  assert.equal(logged.length, 1);
  assert.match(
    logged[0] as string,
    /^room .+: the reply from dev to po was dropped: po has left the room$/,
  );
});

// 64 KiB is 21,845 whole `€`, three bytes each: the cut drops the one it
// would split.
for (const [scenario, calls, kept] of [
  ["long", "0 tool calls", "x".repeat(64 * 1024)],
  ["long-call", "1 tool call", "€".repeat(21_845)],
]) {
  test(`an answer over 64 KiB is cut, and the reply says so (${scenario})`, async (t) => {
    const { po, dev, told, settled } = await loopRoom(t, scenario as string);
    await dev.send("go", po);
    await settled();
    const [[text] = []] = told(po);
    const [head, body] = (text as string).split("\n");
    assert.equal(head, `[reply from dev] end_turn, ${calls}, cut at 64 KiB`);
    assert.equal(body, kept);
  });
}

test(`a reply reaches an orchestrator with ${QUEUE_BOUND} messages waiting`, async (t) => {
  const { po, dev, of } = await loopRoom(t, "remember", "stall");
  const waiting = [po.send("live")];
  for (let i = 0; i < QUEUE_BOUND; i++) waiting.push(po.send(`wait ${i}`));
  await dev.send("go", po);
  assert.equal(po.queued, QUEUE_BOUND + 1);
  const last = of(po, "_client_message_queued").at(-1)?.update as
    | ClientMessageQueuedEvent
    | undefined;
  assert.equal(last?.kind, "reply");
  assert.equal(last?.from, dev.id);
  po.cancel();
  await Promise.all(waiting);
});

test("three queued messages from the orchestrator get three replies, in order", async (t) => {
  const { po, dev, told, settled } = await loopRoom(t, "slow");
  await Promise.all(["a", "b", "c"].map((text) => dev.send(text, po)));
  await settled();
  assert.deepEqual(
    told(po).map(([text]) => text),
    [
      "[reply from dev] end_turn, 0 tool calls\nprevious: (none)",
      "[reply from dev] end_turn, 0 tool calls\nprevious: [from po]\na",
      "[reply from dev] end_turn, 0 tool calls\nprevious: [from po]\nb",
    ],
  );
});

test("a cancel after the harness answered, while the checkout is read, still replies with the answer", async (t) => {
  const { po, dev, of, told, settled } = await loopRoom(t, "remember");
  // A `git` that waits while `slow` exists holds the turn in its end step,
  // after the harness answered and before the turn's end line.
  const dir = await tempDir(t);
  const slow = join(dir, "slow");
  const real = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  await writeFile(
    join(dir, "git"),
    `#!/bin/sh\n[ -e "${slow}" ] && sleep 0.5\nexec "${real}" "$@"\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  await writeFile(slow, "");
  const turn = dev.send("go", po);
  await until(() => of(dev, "agent_message_chunk").length > 0, "the answer");
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(dev.cancel(), true, "the turn is still live");
  await turn;
  await settled();
  assert.deepEqual(told(po), [
    [
      "[reply from dev] end_turn, 0 tool calls\nprevious: (none)",
      dev.id,
      "reply",
    ],
  ]);
});

test("a turn that ends while the room pauses sends nothing", async (t) => {
  const { room, po, dev, told } = await loopRoom(t, "slow");
  // A harness that ignores SIGTERM keeps its remove in flight for the stop's
  // grace, and the pause waits for it before it stops anyone.
  const stuck = await room.add(
    roomAgent({ cmd: `node ${MOCK_AGENT} --scenario stubborn`, name: "stuck" }),
  );
  const turn = dev.send("go", po);
  const removing = room.remove(stuck.id);
  const pausing = room.pause();
  await turn;
  await new Promise((ok) => setTimeout(ok, 100));
  assert.deepEqual(told(po), []);
  await removing;
  await pausing;
});

test("a stopped orchestrator revives for a reply, as for any message", async (t) => {
  const { po, dev, of, told, settled } = await loopRoom(t, "remember");
  await po.send("one");
  const [spawned] = of(po, "_client_harness_spawned");
  assert.ok(spawned);
  process.kill((spawned.update as { pid: number }).pid, "SIGKILL");
  await until(() => po.status() === "exited", "po exited");
  await dev.send("go", po);
  await settled();
  assert.equal(of(po, "_client_participant_revived").length, 1);
  assert.equal(told(po).at(-1)?.[2], "reply");
});

for (const how of ["remove", "dismiss"] as const) {
  test(`a worker's ${how} during its turn sends nothing`, async (t) => {
    const { room, po, dev, of, told } = await loopRoom(t, "half");
    const turn = dev.send("go", po);
    await until(() => of(dev, "tool_call").length > 0, "dev's tool call");
    await (how === "remove" ? room.remove(dev.id) : room.dismiss());
    await turn;
    assert.deepEqual(told(po), []);
  });
}

test("a room reports one auth notice per harness start, however many come (M9-4)", async (t) => {
  const launch = AGENTS.claude.launch;
  AGENTS.claude.launch = {
    command: process.execPath,
    args: [MOCK_AGENT, "--scenario", "auth-repeat"],
  };
  t.after(() => {
    AGENTS.claude.launch = launch;
  });
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const logins: Seen[] = [];
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [roomAgent({ agent: "claude", name: "alice" })],
    setup: await openWorktrees(repo, roomId),
    bus: createEventBus(),
    permissions: queue,
    noteSession: (agent, seen) => {
      if (agent === "claude" && seen.login) logins.push(seen);
    },
  });
  t.after(() => room.dismiss());
  // All twenty came before `session/new` answered. Each report is a
  // synchronous write of `checks.json`, so one per start bounds them.
  assert.deepEqual(logins, [{ login: "logged_out" }]);
});

test("a revive's load saves the models, and no login for an agent that loads logged out (M9-4b)", async (t) => {
  const { repo, room, p, file, agent } = await loading(t, "models");
  await p.send("one");
  await room.pause();
  // Now a registry agent kapelle checks, so the revive reports.
  const entry = AGENTS[agent];
  assert.ok(entry);
  entry.setup = { program: "mock", login: "mock login" };
  const seen: Seen[] = [];
  const back = await restored(t, repo, readRoomRecord(file), (_id, s) =>
    seen.push(s),
  );
  await back.p.send("two");
  assert.equal(back.p.resumed, "loaded");
  // This entry has no `loadNeedsLogin`: for such an agent, a load that works
  // proves nothing about the login (§Models and login).
  assert.deepEqual(seen, [
    {
      models: [
        { id: "mock/fast", name: "Fast" },
        { id: "mock/smart", name: "Smart" },
      ],
      model: "mock/fast",
    },
  ]);
});

test("a revive's load gives a login state where a load needs a login (M9-4b)", async (t) => {
  const { repo, room, p, file, agent } = await loading(t, "models");
  await p.send("one");
  await room.pause();
  // Now a registry agent kapelle checks, whose successful load is the proof.
  const entry = AGENTS[agent];
  assert.ok(entry);
  entry.setup = {
    program: "mock",
    login: "mock login",
    loadNeedsLogin: true,
  };
  const seen: Seen[] = [];
  const back = await restored(t, repo, readRoomRecord(file), (_id, s) =>
    seen.push(s),
  );
  await back.p.send("two");
  assert.equal(back.p.resumed, "loaded");
  assert.deepEqual(seen, [
    {
      models: [
        { id: "mock/fast", name: "Fast" },
        { id: "mock/smart", name: "Smart" },
      ],
      model: "mock/fast",
      login: "ok",
    },
  ]);
});

// --- M9-5: the model a participant asks for -----------------------------

/** A room whose `alice` runs the mock's `scenario` and asks for `model`.
 *  `modelCurrent` makes the mock's set reply name that model instead.
 *  `methods` lists each request her harness got, in order. */
async function modelRoom(
  t: TestContext,
  model?: string,
  scenario = "models",
  modelCurrent?: string,
  flags = "",
) {
  const repo = await gitRepo(t);
  const record = join(await tempDir(t), "requests.jsonl");
  const roomId = newRoomId();
  const bus = createEventBus();
  const changed: AgentEventEnvelope[] = [];
  bus.addListener((e) => {
    if (e.update.sessionUpdate === "_client_participant_changed") {
      changed.push(e);
    }
  });
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [
      roomAgent({
        cmd:
          `node ${MOCK_AGENT} --scenario ${scenario} --record ${record}` +
          `${modelCurrent ? ` --model-current ${modelCurrent}` : ""}${flags}`,
        name: "alice",
        ...(model && { model }),
      }),
    ],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
  });
  t.after(() => room.dismiss());
  const methods = async () =>
    (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { method: string }).method);
  const p = room.participants[0] as Participant;
  return { room, p, methods, changed, file: roomFile(repo, roomId) };
}

const modelLines = (p: Participant) =>
  p.notices.filter((n) => n.text.includes("model")).map((n) => n.text);

test("an asked model is set after session/new, before the first turn, and room.json keeps it (M9-5)", async (t) => {
  const { p, methods, file } = await modelRoom(t, "mock/smart");
  assert.equal(p.model, "mock/smart");
  assert.deepEqual(modelLines(p), []);
  await p.send("one");
  const sent = await methods();
  const set = sent.indexOf("session/set_config_option");
  assert.ok(set > sent.indexOf("session/new"), sent.join(" "));
  assert.ok(set < sent.indexOf("session/prompt"), sent.join(" "));
  assert.equal(readRoomRecord(file).participants[0]?.model, "mock/smart");
});

test("the model in use comes from the set reply, not the request (M9-5)", async (t) => {
  const { p, file } = await modelRoom(t, "mock/smart", "models", "mock/fast");
  assert.equal(p.model, "mock/fast", "the harness's reply");
  // The room says so, as the /add line does.
  assert.deepEqual(modelLines(p), [
    'mock-agent took the model "mock/smart" but runs on "mock/fast"',
  ]);
  // The request is still what room.json keeps, for the next revive.
  assert.equal(readRoomRecord(file).participants[0]?.model, "mock/smart");
});

test("a set the harness never answers is no refusal: its notice says so (M9-5)", async (t) => {
  const { p } = await modelRoom(
    t,
    "mock/smart",
    "models",
    undefined,
    " --model-exit",
  );
  const [line] = modelLines(p);
  assert.match(
    line ?? "",
    /^mock-agent did not confirm the model "mock\/smart" \(/,
  );
  assert.match(line ?? "", /; it may still run on the model "mock\/fast"$/);
  assert.equal(p.model, "mock/fast");
});

test("with no model asked, nothing is sent and the harness's own model shows (M9-5)", async (t) => {
  const { p, methods, file } = await modelRoom(t);
  assert.equal(p.model, "mock/fast");
  assert.ok(!(await methods()).includes("session/set_config_option"));
  assert.equal(readRoomRecord(file).participants[0]?.model, undefined);
});

test("a refused model keeps the agent, on its own model, with kapelle's notice (M9-5)", async (t) => {
  const { p, file } = await modelRoom(t, "mock/bogus");
  assert.equal(p.model, "mock/fast", "the harness's own model");
  assert.equal(p.status(), "idle");
  assert.deepEqual(modelLines(p), [
    'mock-agent refused the model "mock/bogus" (Internal error (code -32603)); ' +
      'it runs on the model "mock/fast"',
  ]);
  // The ask is kept: a revive tries it again.
  assert.equal(readRoomRecord(file).participants[0]?.model, "mock/bogus");
  await p.send("one");
  assert.equal(p.status(), "idle", "it still takes turns");
});

test("a harness that lists no models gets a notice, and no send (M9-5)", async (t) => {
  const { p, methods } = await modelRoom(t, "mock/smart", "remember");
  assert.equal(p.model, undefined);
  assert.deepEqual(modelLines(p), [
    'mock-agent lists no models, so the model "mock/smart" was not set; it runs on its own model',
  ]);
  assert.ok(!(await methods()).includes("session/set_config_option"));
});

test("a revive sends the model again after the load (M9-5)", async (t) => {
  const { repo, room, p, file } = await loading(t, "models", {
    model: "mock/smart",
  });
  await p.send("one");
  await room.pause();
  const back = await restored(t, repo, readRoomRecord(file));
  // Not known until the harness starts again.
  assert.equal(back.p.model, undefined);
  await back.p.send("two");
  assert.equal(back.p.resumed, "loaded");
  // The mock's load starts on mock/fast again, as no harness was measured
  // to keep a model, so only a new send gives mock/smart.
  assert.equal(back.p.model, "mock/smart");
  assert.deepEqual(modelLines(back.p), []);
});

test("an agent request takes a model as a non-empty string (M9-5)", () => {
  assert.equal(mock("a", { model: "x/y" }).model, "x/y");
  assert.equal(mock("a").model, undefined);
  for (const model of [7, "", "  ", null]) {
    assert.throws(
      () => mock("a", { model }),
      /"model" must be a non-empty string/,
    );
  }
});

// --- M9-6: the person changes the model during a chat ----------------------

/** One turn for `setImmediate`: the room saves `room.json` on the next one. */
const saved = () => new Promise((done) => setImmediate(done));

test("an idle harness gets a changed model at once, and room.json keeps it (M9-6)", async (t) => {
  const { room, p, methods, changed, file } = await modelRoom(t);
  assert.equal(p.model, "mock/fast");
  const after = await room.setModel(p.id, "mock/smart");
  // Answered before the call resolves: the reply shows the model in use.
  assert.equal(after.model, "mock/smart");
  assert.deepEqual(modelLines(p), []);
  assert.ok((await methods()).includes("session/set_config_option"));
  assert.deepEqual(
    changed.map((e) => e.update),
    [{ sessionUpdate: "_client_participant_changed", model: "mock/smart" }],
  );
  await saved();
  assert.equal(readRoomRecord(file).participants[0]?.model, "mock/smart");
});

test("a busy harness gets a changed model before its next turn, never during one (M9-6)", async (t) => {
  const { room, p, methods } = await modelRoom(t);
  const turn = p.send("one");
  assert.equal(p.status(), "busy");
  const after = await room.setModel(p.id, "mock/smart");
  assert.equal(after.model, "mock/fast", "not sent yet");
  await turn;
  // The turn ended, and still nothing was sent: it waits for the next one.
  assert.ok(!(await methods()).includes("session/set_config_option"));
  assert.equal(p.model, "mock/fast");
  await p.send("two");
  const sent = await methods();
  const set = sent.indexOf("session/set_config_option");
  const prompts = sent.flatMap((m, i) => (m === "session/prompt" ? [i] : []));
  assert.equal(prompts.length, 2, sent.join(" "));
  assert.ok(
    set > (prompts[0] ?? -1) && set < (prompts[1] ?? -1),
    sent.join(" "),
  );
  assert.equal(p.model, "mock/smart");
});

test("a refused change keeps the model in use, and a revive does not ask for it (M9-6)", async (t) => {
  const { room, p, changed, file } = await modelRoom(t, "mock/smart");
  const after = await room.setModel(p.id, "mock/bogus");
  assert.equal(after.model, "mock/smart", "the model it had");
  assert.deepEqual(modelLines(p), [
    'mock-agent refused the model "mock/bogus" (Internal error (code -32603)); ' +
      'it runs on the model "mock/smart"',
  ]);
  // Every client hears the model in use, so it reads the notice too.
  assert.deepEqual(
    changed.map((e) => e.update),
    [{ sessionUpdate: "_client_participant_changed", model: "mock/smart" }],
  );
  await saved();
  assert.equal(readRoomRecord(file).participants[0]?.model, "mock/smart");
  await p.send("one");
  assert.equal(p.status(), "idle", "it still takes turns");
});

test("a set reply with fewer options leaves the live list as the session sent it (M9-6)", async (t) => {
  const { room, p } = await modelRoom(
    t,
    undefined,
    "models",
    undefined,
    " --model-few",
  );
  const before = [
    { id: "mock/fast", name: "Fast" },
    { id: "mock/smart", name: "Smart" },
  ];
  assert.deepEqual(p.models, before);
  await room.setModel(p.id, "mock/smart");
  assert.equal(p.model, "mock/smart");
  assert.deepEqual(p.models, before);
});

test("a changed model comes back after a revive, and one with no harness gets it at its start (M9-6)", async (t) => {
  const { repo, room, p, file } = await loading(t, "models");
  await p.send("one");
  await room.setModel(p.id, "mock/smart");
  await room.pause();
  assert.equal(readRoomRecord(file).participants[0]?.model, "mock/smart");
  const back = await restored(t, repo, readRoomRecord(file));
  // No harness yet, so no list; the change waits for the start.
  assert.equal(back.p.models, undefined);
  await back.room.setModel(back.p.id, "mock/fast");
  assert.equal(back.p.model, undefined);
  await back.p.send("two");
  assert.equal(back.p.resumed, "loaded");
  assert.equal(back.p.model, "mock/fast");
  await back.room.pause();
  assert.equal(readRoomRecord(file).participants[0]?.model, "mock/fast");
});

test("a PATCH body takes a model as a non-empty string, alone or with the rest (M9-6)", () => {
  assert.deepEqual(participantChanges({ model: "x/y" }), { model: "x/y" });
  assert.deepEqual(participantChanges({ mode: "safe", model: "x/y" }), {
    mode: "safe",
    model: "x/y",
  });
  for (const model of [7, "", "  ", null]) {
    assert.throws(
      () => participantChanges({ model }),
      /"model" must be a non-empty string/,
    );
  }
});
