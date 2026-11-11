/**
 * Chat rooms over the daemon's HTTP API: open, message queue, roster,
 * fast-forward, the diff route, the room commands' routes (M4-5), a room
 * across a restart (M6-7a), delete (#235) and shutdown (#316). No screen: the
 * chat clients have the `chat-*` files. A real `daemon.ts` and
 * `mock-agent.mjs`; no harness.
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` **and `XDG_STATE_HOME`**, so no
 * test ever meets another test's `daemon.json` or `repos.json` — or the
 * developer's real ones — even while the other files run at the same time.
 * The helpers more than one of these files needs live in
 * `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import {
  type Outcome,
  parseCommand,
  type RouteCommand,
  runCommand,
} from "../client/command.ts";
import type {
  DeletePreview,
  Diff,
  MessageAccepted,
  ParticipantDto,
  PermissionDecision,
  RoomEventLine,
  RoomListEntry,
} from "../client/contract.ts";
import type { Named } from "../client/mention.ts";
import { readRoomRecord, writeRoomRecord } from "../core/room.ts";
import { stateDirFor } from "../core/runtime.ts";
import {
  addRepo as added,
  answersIn,
  api,
  bootDaemon as boot,
  commitAt,
  countedGit,
  type Daemon,
  gatedGit,
  gitRepo,
  HOSTILE_AGENT,
  hasBranch,
  headAt,
  MOCK_AGENT,
  only,
  type Pending,
  participantIdle,
  pendingOne,
  REMEMBER,
  type RoomReply,
  roomIdle,
  roomLog,
  roomToRestart,
  tempDir,
  until,
  withAgent,
} from "../integration/helpers.ts";

// --- chat rooms (chat MVP) ------------------------------------------------------

/** Every event of a room, read from its SSE stream, or of one participant
 *  when `agentId` is given. Only call once the room is dismissed: the stream
 *  ends only when its log closes. */
async function roomEvents(
  d: Daemon,
  id: string,
  agentId?: string,
): Promise<
  (Omit<RoomEventLine, "update"> & { update: Record<string, unknown> })[]
> {
  const path = agentId ? `agents/${agentId}/events` : "events";
  const res = await fetch(`${d.url}/rooms/${id}/${path}`, {
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(res.status, 200);
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

test("a room keeps one harness and its context across messages, until it is dismissed", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));

  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  assert.equal(open.body.status, "active");
  assert.equal(only(open.body).status, "idle");
  const { id } = open.body;
  const { worktree } = only(open.body);
  // The participant's own checkout, named by the room id (S9) and its own id
  // (M6-6a), in the repository's workspace under `stateDirFor(root)` rather
  // than inside the repository itself (#129).
  assert.match(
    worktree,
    /\/wt\/room-\d{8}-\d{6}-[0-9a-z]{4}\/p-[0-9a-z]{8}$/,
    "the participant has its own checkout",
  );
  assert.ok(
    !worktree.startsWith(cwd),
    `the checkout is outside the repository, got ${worktree}`,
  );

  for (const text of ["alpha", "beta"]) {
    const r = await api<RoomReply>(d, "POST", `/rooms/${id}/messages`, {
      text,
    });
    assert.equal(r.status, 202, r.body.error?.message);
    await roomIdle(d, id);
  }

  const gone = await api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`);
  assert.equal(gone.status, 200, gone.body.error?.message);
  assert.equal(gone.body.status, "dismissed");
  assert.equal(only(gone.body).status, "dismissed");

  const events = await roomEvents(d, id);
  // M5-5 (#137): a room's log carries `at` too, but no run terminal event —
  // rooms get the timestamp and no `_client_run_finished` (C6).
  for (const e of events) {
    assert.equal(typeof e.at, "string", "every room event has at");
    assert.equal(new Date(e.at as string).toISOString(), e.at);
    assert.notEqual(e.update.sessionUpdate, "_client_run_finished");
  }
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.deepEqual(
    of("_client_user_message").map((e) => e.update.text),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    of("agent_message_chunk").map(
      (e) => (e.update.content as { text: string }).text,
    ),
    ["previous: (none)", "previous: alpha"],
    "the second turn saw the first: one session, context kept",
  );
  assert.deepEqual(
    of("_client_turn_ended").map((e) => e.update.stopReason),
    ["end_turn", "end_turn"],
  );
  assert.equal(
    of("_client_harness_spawned").length,
    1,
    "one harness for both turns",
  );
  assert.equal(of("_client_harness_exited").length, 1, "dismiss stopped it");

  const late = await api<RoomReply>(d, "POST", `/rooms/${id}/messages`, {
    text: "gamma",
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "room_dismissed");
  const again = await api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "room_dismissed");
});

test("dismissing a room commits nothing and leaves the checkout (R37)", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);

  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const { worktree: workspace, id: participantId } = only(open.body);
  const base = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();

  // Stand in for a participant that worked and did not commit. R37 says the
  // supervisor never commits for it — not at close, not ever.
  await writeFile(join(workspace, "draft.txt"), "half a thought\n");

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);

  // The checkout is still there, with the work still uncommitted in it, and
  // the branch has not moved. The spike released as `done`, which committed
  // `draft.txt` under our name and deleted the directory it was in.
  assert.ok(
    existsSync(join(workspace, "draft.txt")),
    "the work is still there",
  );
  assert.equal(
    spawnSync(
      "git",
      ["rev-parse", `refs/heads/kapelle/${id}/${participantId}`],
      { cwd: root, encoding: "utf8" },
    ).stdout.trim(),
    base,
    "the participant's branch is still at the base commit",
  );
});

test("two dismissals racing both wait for the one teardown, and both get 200", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));

  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;

  // S6(a): a dismissal answers only once the harness has stopped and the
  // checkout is released. `status()` reads `dismissed` the instant a
  // dismiss begins, so keying the 409 on it told the second caller the room was
  // already dismissed while the harness was still alive.
  const [first, second] = await Promise.all([
    api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`),
    api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`),
  ]);
  assert.equal(first.status, 200, first.body.error?.message);
  assert.equal(second.status, 200, second.body.error?.message);

  // Both waited for the same teardown, so the harness is gone by now.
  const events = await roomEvents(d, id);
  assert.equal(
    events.filter((e) => e.update.sessionUpdate === "_client_harness_exited")
      .length,
    1,
    "one harness, stopped once",
  );

  // A dismissal that arrives after the teardown has settled is a 409.
  assert.equal(
    (await api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`)).status,
    409,
  );
});

test("a release that fails is reported and the room is still dismissed, not a 500 (R37)", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);

  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const workspace = only(open.body).worktree;

  // A locked worktree makes `git worktree remove --force` fail — the sweep
  // suite relies on the same trick — so `release` throws on this untouched
  // checkout. The room still has to be dismissed, the failure has to be visible, and
  // the daemon must not be left unable to shut down.
  assert.equal(
    spawnSync("git", ["worktree", "lock", workspace], { cwd: root }).status,
    0,
  );
  t.after(() => {
    spawnSync("git", ["worktree", "unlock", workspace], { cwd: root });
  });

  const gone = await api<RoomReply>(d, "POST", `/rooms/${id}/dismiss`);
  assert.equal(gone.status, 200, gone.body.error?.message);
  assert.equal(gone.body.status, "dismissed");
  assert.equal(only(gone.body).status, "dismissed");
  assert.ok(
    only(gone.body).notices.some((n) =>
      /could not release the participant's checkout/.test(n.text),
    ),
    `release failure not reported: ${JSON.stringify(only(gone.body).notices)}`,
  );

  // A rejected teardown used to escape `shutdown()`'s `Promise.all`, leaving
  // `daemon.json` behind and skipping `process.exit(0)`.
  process.kill(d.pid, "SIGTERM");
  const r = await d.done;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(d.file), false, "daemon.json is removed on shutdown");
});

/** A reply to a message, or its refusal. */
type MessageReply = MessageAccepted & RoomReply;

test("a busy participant queues 16 messages, refuses the seventeenth with 429, and a cancel drops them", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario stall`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const to = `/rooms/${id}/agents/${only(open.body).id}`;
  const say = (text: string) =>
    api<MessageReply>(d, "POST", `${to}/messages`, { text });

  const live = await say("live");
  assert.equal(live.status, 202, live.body.error?.message);
  assert.equal(live.body.queued, 0);
  for (let i = 1; i <= 16; i++) {
    const r = await say(`wait ${i}`);
    assert.equal(r.status, 202, r.body.error?.message);
    assert.equal(r.body.queued, i, "the live turn and the ones before");
  }
  const full = await say("one too many");
  assert.equal(full.status, 429);
  assert.equal(full.body.error.code, "queue_full");

  const cancel = await api<RoomReply>(d, "POST", `${to}/turns/current/cancel`);
  assert.equal(cancel.status, 202, cancel.body.error?.message);
  await roomIdle(d, id);
  const none = await api<RoomReply>(d, "POST", `${to}/turns/current/cancel`);
  assert.equal(none.status, 409);
  assert.equal(none.body.error.code, "no_turn");
  assert.equal(
    (await api<RoomReply>(d, "GET", `/rooms/${id}`)).body.status,
    "active",
    "a cancel is not a dismiss",
  );
  // The session stays: the same harness takes the next message.
  assert.equal((await say("next")).body.queued, 0);

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const events = await roomEvents(d, id);
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.equal(of("_client_message_queued").length, 16);
  assert.deepEqual(
    of("_client_queue_cleared").map((e) => e.update.count),
    [16],
  );
  assert.deepEqual(
    of("_client_user_message").map((e) => e.update.text),
    ["live", "next"],
  );
  assert.equal(of("_client_turn_ended").length, 2, "dismiss ended the second");
  assert.equal(of("_client_harness_spawned").length, 1);
});

// The test drives the HTTP race, queue, log and record in one scenario: its
// call count is the proof.
// pi-lens-ignore: high-fan-out
test("a cancel after the prompt settled, while the checkout is read, is no_turn and keeps the queue", async (t) => {
  const gate = await gatedGit(t);
  const d = await boot(t, undefined, [], undefined, { PATH: gate.path });
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const to = `/rooms/${id}/agents/${only(open.body).id}`;
  const say = (text: string) =>
    api<MessageReply>(d, "POST", `${to}/messages`, { text });

  await gate.arm();
  assert.equal((await say("one")).status, 202);
  await until("the checkout read", () => existsSync(gate.entered));
  const waiting = await say("two");
  assert.equal(waiting.status, 202);
  assert.equal(waiting.body.queued, 1);

  const cancel = await api<RoomReply>(d, "POST", `${to}/turns/current/cancel`);
  assert.equal(cancel.status, 409);
  assert.equal(cancel.body.error.code, "no_turn");
  assert.match(cancel.body.error.message, /no live prompt/);

  await gate.release();
  await roomIdle(d, id);
  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);

  const events = await roomEvents(d, id);
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.deepEqual(
    of("_client_user_message").map((e) => e.update.text),
    ["one", "two"],
    "the queued message still ran",
  );
  assert.equal(of("_client_queue_cleared").length, 0);
  assert.equal(of("_client_cancel_requested").length, 0);
  assert.deepEqual(
    of("_client_turn_ended").map((e) => e.update.stopReason),
    ["end_turn", "end_turn"],
  );

  const record = JSON.parse(
    await readFile(join(stateDirFor(cwd), "rooms", id, "room.json"), "utf8"),
  ) as { participants: { turnCancelled?: true }[] };
  assert.equal(record.participants[0]?.turnCancelled, undefined);
});

test("messages to a busy participant are answered in order, and a cancel keeps its memory", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario slow --stall-turn 4`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const to = `/rooms/${id}/agents/${only(open.body).id}`;
  const say = async (text: string) =>
    (await api<MessageReply>(d, "POST", `${to}/messages`, { text })).body;

  // The first three slow turns hold long enough to queue. The fourth stalls
  // until cancelled, so the 202 cannot race the one-second answer; a test that
  // never reaches the cancel fails by timeout.
  const queued = [];
  for (const text of ["a", "b", "c"]) queued.push((await say(text)).queued);
  assert.deepEqual(queued, [0, 1, 2]);
  await roomIdle(d, id);
  await say("d");
  assert.equal(
    (await api(d, "POST", `${to}/turns/current/cancel`)).status,
    202,
  );
  await roomIdle(d, id);
  await say("e");
  await roomIdle(d, id);

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const events = await roomEvents(d, id);
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.deepEqual(
    of("_client_user_message").map((e) => e.update.text),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(
    of("agent_message_chunk").map(
      (e) => (e.update.content as { text: string }).text,
    ),
    ["previous: (none)", "previous: a", "previous: b", "previous: d"],
    "in order, on one session, and the cancelled turn is remembered",
  );
  assert.deepEqual(
    of("_client_turn_ended").map((e) => e.update.stopReason),
    ["end_turn", "end_turn", "end_turn", "cancelled", "end_turn"],
  );
});

test("a message from the orchestrator names it: on the log, and as the harness's first line", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "po", role: "orchestrator" },
      { cmd: `node ${MOCK_AGENT} --scenario slow`, name: "dev" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const [po, dev] = open.body.participants.map((p) => p.id) as [string, string];
  const say = (to: string, text: string, from?: string) =>
    api<MessageReply>(d, "POST", `/rooms/${id}/agents/${to}/messages`, {
      text,
      ...(from && { from }),
    });

  for (const [to, from] of [
    [po, dev],
    [dev, dev],
    [dev, "p-nobody"],
    [po, po],
  ] as const) {
    const r = await say(to, "no", from);
    assert.equal(r.status, 400, `${from} → ${to}`);
    assert.equal(r.body.error.code, "invalid_sender");
  }
  const wide = await api<RoomReply>(d, "POST", `/rooms/${id}/messages`, {
    text: "no",
    from: po,
  });
  assert.equal(wide.status, 400);
  assert.equal(wide.body.error.code, "invalid_request");
  assert.match(wide.body.error.message, /unknown field "from"/);
  const typed = await api<MessageReply>(
    d,
    "POST",
    `/rooms/${id}/agents/${dev}/messages`,
    { text: "no", from: 5 },
  );
  assert.equal(typed.status, 400);
  assert.equal(typed.body.error.code, "invalid_request");

  // Each `slow` turn lasts a second, so b and c queue behind a.
  const queued = [];
  for (const [text, from] of [
    ["a", po],
    ["b", undefined],
    ["c", po],
  ] as const) {
    const r = await say(dev, text, from);
    assert.equal(r.status, 202, r.body.error?.message);
    queued.push(r.body.queued);
  }
  assert.deepEqual(queued, [0, 1, 2]);
  // c waits; a rename now does not change the name its harness reads.
  const renamed = await api(d, "PATCH", `/rooms/${id}/agents/${po}`, {
    name: "lead",
  });
  assert.equal(renamed.status, 200);
  const idle = async () => {
    for (const until = Date.now() + 20_000; ; ) {
      const r = await api<RoomReply>(d, "GET", `/rooms/${id}`);
      if (r.body.participants.every((p) => p.status !== "busy")) return;
      assert.ok(Date.now() < until, "dev never went idle");
      await new Promise((ok) => setTimeout(ok, 25));
    }
  };
  await idle();
  assert.equal((await say(dev, "d")).status, 202);
  await idle();

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const events = await roomEvents(d, id, dev);
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  assert.deepEqual(
    of("_client_user_message").map((e) => [e.update.text, e.update.from]),
    [
      ["a", po],
      ["b", undefined],
      ["c", po],
      ["d", undefined],
    ],
    "the log keeps the text without the line, and the sender's id",
  );
  assert.deepEqual(
    of("_client_message_queued").map((e) => [e.update.text, e.update.from]),
    [
      ["b", undefined],
      ["c", po],
    ],
  );
  assert.deepEqual(
    of("agent_message_chunk").map(
      (e) => (e.update.content as { text: string }).text,
    ),
    [
      "previous: (none)",
      "previous: [from po]\na",
      "previous: b",
      "previous: [from po]\nc",
    ],
    "the harness read the line only on the orchestrator's messages",
  );
});

test("the orchestrator turn cap counts accepted messages, survives a restart, and can be raised", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const root = await gitRepo(t);
  await mkdir(join(root, ".kapelle"), { recursive: true });
  await writeFile(
    join(root, ".kapelle", "config.json"),
    JSON.stringify({ orchestratorTurnCap: 1 }),
    { mode: 0o644 },
  );
  const cwd = await added(first, root);
  const open = await api<RoomReply>(first, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "po", role: "orchestrator" },
      { cmd: `node ${MOCK_AGENT} --scenario slow`, name: "dev" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const [po, dev] = open.body.participants;
  assert.ok(po && dev);
  const record = join(stateDirFor(cwd), "rooms", id, "room.json");
  const saved = async () => JSON.parse(await readFile(record, "utf8"));
  const say = (d: Daemon, text: string, from?: string) =>
    api<MessageReply>(d, "POST", `/rooms/${id}/agents/${dev.id}/messages`, {
      text,
      ...(from && { from }),
    });

  assert.equal((await say(first, "person")).status, 202);
  assert.equal((await saved()).turnCap, 1);
  assert.equal((await saved()).turnCount, 0, "a person's message is free");
  const queued = await say(first, "queued", po.id);
  assert.equal(queued.status, 202, queued.body.error?.message);
  assert.equal(queued.body.queued, 1);
  assert.equal((await saved()).turnCount, 1);
  const capped = await say(first, "capped", po.id);
  assert.equal(capped.status, 429);
  assert.equal(capped.body.error.code, "turn_cap");
  assert.equal((await saved()).turnCount, 1);
  await participantIdle(first, id, dev.id);

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = await boot(t, runtime, [], state);
  const stillCapped = await say(second, "still capped", po.id);
  assert.equal(stillCapped.status, 429);
  assert.equal(stillCapped.body.error.code, "turn_cap");
  assert.equal((await saved()).turnCount, 1);

  const raised = await api<RoomReply>(second, "PATCH", `/rooms/${id}`, {
    turnCap: 2,
  });
  assert.equal(raised.status, 200, raised.body.error?.message);
  assert.equal((await saved()).turnCap, 2);
  const admitted = await say(second, "after raise", po.id);
  assert.equal(admitted.status, 202, admitted.body.error?.message);
  await participantIdle(second, id, dev.id);
  assert.equal((await saved()).turnCount, 2);

  // The person's message after po's order makes dev send po a copy. A copy
  // is not an orchestrator worker message, so it must not use the cap.
  const copied = await say(second, "person to dev");
  assert.equal(copied.status, 202, copied.body.error?.message);
  await participantIdle(second, id, dev.id);
  await until("the copy", async () =>
    (await roomLog(cwd, id)).some(
      (line) =>
        line.update.sessionUpdate === "_client_user_message" &&
        typeof line.update.text === "string" &&
        line.update.text.startsWith("[copy]"),
    ),
  );
  assert.equal((await saved()).turnCount, 2, "a copy does not count");

  const lines = await roomLog(cwd, id);
  assert.equal(
    lines.filter(
      (line) => line.update.sessionUpdate === "_client_turn_cap_reached",
    ).length,
    2,
  );
  const messages = lines
    .filter(
      (line) =>
        line.update.sessionUpdate === "_client_user_message" ||
        line.update.sessionUpdate === "_client_message_queued",
    )
    .map((line) => line.update.text);
  for (const refused of ["capped", "still capped"]) {
    assert.ok(
      !messages.includes(refused),
      `${refused} neither queued nor started`,
    );
  }
});

test("one room log names each line's room and participant, and a participant's stream is its own lines", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", { cwd });
  const { id } = open.body;
  // One harness for both, so only the participant id tells them apart.
  const alice = await addAgent(d, id, {
    cmd: REMEMBER,
    name: "alice",
    role: "orchestrator",
  });
  const bob = await addAgent(d, id, { cmd: REMEMBER, name: "bob" });

  const toAlice = await api(d, "POST", `/rooms/${id}/messages`, {
    text: "to alice",
  });
  assert.equal(toAlice.status, 202);
  const toBob = await api(d, "POST", `/rooms/${id}/agents/${bob.id}/messages`, {
    text: "to bob",
  });
  assert.equal(toBob.status, 202);
  // Alice never ordered bob, so his turn sends her no copy (#333).
  await agentIdle(d, id, bob.id);
  await agentIdle(d, id, alice.id);
  const nobody = `/rooms/${id}/agents/p-nobody`;
  for (const [method, path, body] of [
    ["POST", `${nobody}/messages`, { text: "hi" }],
    ["GET", `${nobody}/events`, undefined],
    ["POST", `${nobody}/turns/current/cancel`, undefined],
  ] as const) {
    const r = await api(d, method, path, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.body.error.code, "participant_not_found");
  }
  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);

  const all = await roomEvents(d, id);
  for (const line of all) {
    assert.equal(line.roomId, id);
    assert.ok([alice.id, bob.id].includes(line.participantId));
    assert.ok(!("agent" in line), "a room line has no agent (S10)");
  }
  const bobs = await roomEvents(d, id, bob.id);
  assert.deepEqual(
    bobs,
    all.filter((e) => e.participantId === bob.id),
    "the same lines, with the room's seq",
  );
  const said = (lines: typeof all) =>
    lines
      .filter((e) => e.update.sessionUpdate === "_client_user_message")
      .map((e) => e.update.text);
  assert.deepEqual(said(bobs), ["to bob"]);
  assert.deepEqual(said(await roomEvents(d, id, alice.id)), ["to alice"]);
});

test("POST /rooms refuses an unadded folder, a missing or unknown harness, and a bad message", async (t) => {
  const d = await boot(t);
  const repo = await gitRepo(t);

  const unadded = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(repo, REMEMBER),
  );
  assert.equal(unadded.status, 403);
  assert.equal(unadded.body.error.code, "repo_not_added");

  const cwd = await added(d, repo);
  const refused: [unknown, RegExp][] = [
    [[{}], /"agent" or "cmd"/],
    [[{ agent: "nope" }], /unknown agent "nope"/],
    [[{ agent: 7, cmd: REMEMBER }], /"agent" must be a non-empty string/],
    [[{ agent: "opencode", cmd: null }], /"cmd" must be a non-empty string/],
    [{ cmd: REMEMBER }, /"agents" must be a list/],
    [[{ cmd: REMEMBER, name: "no spaces" }], /invalid agent name/],
    [[{ cmd: REMEMBER, name: "a".repeat(33) }], /invalid agent name/],
    [[{ cmd: REMEMBER, name: null }], /invalid agent name null/],
    // A default name that breaks R22 asks for one rather than mangling it.
    [[{ cmd: "/bin/true" }], /give the agent a "name"/],
    [[{ cmd: REMEMBER, role: "boss" }], /invalid role "boss"/],
    [[{ cmd: REMEMBER, mode: "turbo" }], /invalid mode "turbo"/],
    [[{ cmd: REMEMBER, turbo: true }], /unknown agent field "turbo"/],
    [[{ cmd: REMEMBER, name: "c", base: "no-such-ref" }], /does not resolve/],
  ];
  for (const [agents, message] of refused) {
    const r = await api<RoomReply>(d, "POST", "/rooms", { cwd, agents });
    assert.equal(r.status, 400, JSON.stringify(agents));
    assert.equal(r.body.error.code, "invalid_request");
    assert.match(r.body.error.message, message);
  }
  const clashes: [unknown, string][] = [
    [
      [
        { cmd: REMEMBER, name: "a" },
        { cmd: REMEMBER, name: "A" },
      ],
      "name_taken",
    ],
    [
      [
        { cmd: REMEMBER, name: "a", role: "orchestrator" },
        { cmd: REMEMBER, name: "b", role: "orchestrator" },
      ],
      "orchestrator_exists",
    ],
  ];
  for (const [agents, code] of clashes) {
    const r = await api<RoomReply>(d, "POST", "/rooms", { cwd, agents });
    assert.equal(r.status, 409, JSON.stringify(agents));
    assert.equal(r.body.error.code, code);
  }
  for (const title of [7, "", "  "]) {
    const r = await api<RoomReply>(d, "POST", "/rooms", { cwd, title });
    assert.equal(r.status, 400, JSON.stringify(title));
    assert.match(r.body.error.message, /"title" must be a non-empty string/);
  }

  const missing = await api(d, "POST", "/rooms/missing/messages", {
    text: "x",
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "room_not_found");
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  const empty = await api(d, "POST", `/rooms/${open.body.id}/messages`, {
    text: " ",
  });
  assert.equal(empty.status, 400);
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("every room route answers room_not_found for an unknown id", async (t) => {
  const d = await boot(t);
  const routes: [string, string, unknown][] = [
    ["GET", "/rooms/nope", undefined],
    ["POST", "/rooms/nope/dismiss", undefined],
    ["POST", "/rooms/nope/messages", { text: "hi" }],
    ["GET", "/rooms/nope/events", undefined],
    ["GET", "/rooms/nope/delete-preview", undefined],
    ["POST", "/rooms/nope/agents/p-x/messages", { text: "hi" }],
    ["GET", "/rooms/nope/agents/p-x/events", undefined],
    ["POST", "/rooms/nope/agents/p-x/turns/current/cancel", undefined],
    ["POST", "/rooms/nope/agents", { cmd: REMEMBER }],
    ["GET", "/rooms/nope/agents", undefined],
    ["GET", "/rooms/nope/agents/p-x", undefined],
    ["PATCH", "/rooms/nope/agents/p-x", { name: "a" }],
    ["DELETE", "/rooms/nope/agents/p-x", undefined],
    ["DELETE", "/rooms/nope", undefined],
  ];
  for (const [method, path, body] of routes) {
    const r = await api(d, method, path, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.body.error.code, "room_not_found", `${method} ${path}`);
  }
});

/** `POST /rooms/:id/agents` with `fields`, asserted 201. */
async function addAgent(
  d: Daemon,
  id: string,
  fields: Record<string, unknown>,
): Promise<ParticipantDto> {
  const r = await api<ParticipantDto & RoomReply>(
    d,
    "POST",
    `/rooms/${id}/agents`,
    fields,
  );
  assert.equal(r.status, 201, r.body.error?.message);
  return r.body;
}

/** Polls one participant until it is no longer `busy`. */
async function agentIdle(d: Daemon, id: string, agentId: string) {
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const r = await api<ParticipantDto>(
      d,
      "GET",
      `/rooms/${id}/agents/${agentId}`,
    );
    assert.equal(r.status, 200);
    if (r.body.status !== "busy") return r.body;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`participant ${agentId} never went idle`);
}

test("participants are added, listed, changed and removed through the routes", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", { cwd });
  const { id } = open.body;
  const base = `/rooms/${id}/agents`;

  const alice = await addAgent(d, id, {
    cmd: REMEMBER,
    name: "alice",
    role: "orchestrator",
  });
  const bob = await addAgent(d, id, {
    cmd: REMEMBER,
    name: "bob",
    mode: "auto",
    settings: { allowReadOutsideRoot: true },
  });
  assert.equal(alice.mode, "auto");
  assert.deepEqual(alice.settings, { allowReadOutsideRoot: false });
  assert.deepEqual(bob.settings, { allowReadOutsideRoot: true });
  assert.notEqual(alice.worktree, bob.worktree);
  assert.notEqual(alice.branch, bob.branch);

  const list = await api<ParticipantDto[]>(d, "GET", base);
  assert.deepEqual(
    list.body.map((p) => p.name),
    ["alice", "bob"],
  );
  const one = await api<ParticipantDto>(d, "GET", `${base}/${bob.id}`);
  assert.equal(one.body.name, "bob");

  const renamed = await api<ParticipantDto>(d, "PATCH", `${base}/${bob.id}`, {
    name: "Bobby",
    mode: "auto",
    role: "tester",
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, "Bobby");
  assert.equal(renamed.body.role, "tester");
  assert.equal(renamed.body.id, bob.id, "a rename never moves the id");
  assert.equal(renamed.body.branch, bob.branch, "nor the branch");
  const cleared = await api<ParticipantDto>(d, "PATCH", `${base}/${bob.id}`, {
    role: null,
  });
  assert.equal(cleared.body.role, undefined);

  const refused: [string, string, unknown, number, string][] = [
    ["POST", base, { cmd: REMEMBER, name: "ALICE" }, 409, "name_taken"],
    [
      "POST",
      base,
      { cmd: REMEMBER, name: "carol", role: "orchestrator" },
      409,
      "orchestrator_exists",
    ],
    [
      "POST",
      base,
      { cmd: REMEMBER, name: "c", mode: null },
      400,
      "invalid_request",
    ],
    [
      "POST",
      base,
      { cmd: REMEMBER, name: "c", base: "nope" },
      400,
      "invalid_request",
    ],
    ["PATCH", `${base}/${bob.id}`, { name: "Alice" }, 409, "name_taken"],
    [
      "PATCH",
      `${base}/${bob.id}`,
      { role: "orchestrator" },
      409,
      "orchestrator_exists",
    ],
    ["PATCH", `${base}/${bob.id}`, { mode: "turbo" }, 400, "invalid_request"],
    ["PATCH", `${base}/${bob.id}`, {}, 400, "invalid_request"],
    ["PATCH", `${base}/${bob.id}`, { harness: "x" }, 400, "invalid_request"],
    ["GET", `${base}/p-nope`, undefined, 404, "participant_not_found"],
    ["PATCH", `${base}/p-nope`, { name: "x" }, 404, "participant_not_found"],
    ["DELETE", `${base}/p-nope`, undefined, 404, "participant_not_found"],
  ];
  for (const [method, path, body, status, code] of refused) {
    const r = await api(d, method, path, body);
    const label = `${method} ${path} ${JSON.stringify(body)}`;
    assert.equal(r.status, status, label);
    assert.equal(r.body.error.code, code, label);
  }
  assert.equal(
    (await api<ParticipantDto[]>(d, "GET", base)).body.length,
    2,
    "no refused add joined",
  );

  const gone = await api<RoomReply>(d, "DELETE", `${base}/${bob.id}`);
  assert.equal(gone.status, 200, gone.body.error?.message);
  assert.deepEqual(
    gone.body.participants.map((p) => p.id),
    [alice.id],
  );
  const listed = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.deepEqual(
    listed.body[0]?.participants.map((p) => p.name),
    ["alice"],
  );

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  for (const [method, path, body] of [
    ["POST", base, { cmd: REMEMBER, name: "carol" }],
    ["PATCH", `${base}/${alice.id}`, { name: "a" }],
    ["DELETE", `${base}/${alice.id}`, undefined],
  ] as const) {
    const r = await api(d, method, path, body);
    assert.equal(r.status, 409, `${method} ${path}`);
    assert.equal(r.body.error.code, "room_dismissed", `${method} ${path}`);
  }
});

test("PATCH /rooms/:id renames and raises the cap atomically, with validation", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", { cwd, title: "a" });
  const { id } = open.body;

  const renamed = await api<RoomReply>(d, "PATCH", `/rooms/${id}`, {
    title: "  login bug ",
  });
  assert.equal(renamed.status, 200, renamed.body.error?.message);
  assert.equal(renamed.body.id, id, "a rename never moves the id");
  assert.equal(renamed.body.title, "login bug");
  assert.equal(renamed.body.seq, open.body.seq, "a rename writes no line");
  const listed = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.equal(listed.body[0]?.title, "login bug");
  const record = join(stateDirFor(cwd), "rooms", id, "room.json");
  const saved = async () => JSON.parse(await readFile(record, "utf8"));
  assert.equal((await saved()).title, "login bug");
  assert.equal((await saved()).turnCap, 40, "the built-in cap");
  assert.equal((await saved()).turnCount, 0);

  for (const [path, body, status, code] of [
    [`/rooms/${id}`, {}, 400, "invalid_request"],
    [`/rooms/${id}`, { title: " " }, 400, "invalid_request"],
    [`/rooms/${id}`, { title: 7 }, 400, "invalid_request"],
    [`/rooms/${id}`, { turnCap: 0 }, 400, "invalid_request"],
    [`/rooms/${id}`, { turnCap: 1.5 }, 400, "invalid_request"],
    [`/rooms/${id}`, { turnCap: "41" }, 400, "invalid_request"],
    [`/rooms/${id}`, { turnCap: 40 }, 400, "invalid_request"],
    [
      `/rooms/${id}`,
      { title: "not applied", turnCap: 40 },
      400,
      "invalid_request",
    ],
    [`/rooms/${id}`, { title: "x", cwd }, 400, "invalid_request"],
    ["/rooms/nope", { title: "x" }, 404, "room_not_found"],
  ] as const) {
    const r = await api(d, "PATCH", path, body);
    const label = `${path} ${JSON.stringify(body)}`;
    assert.equal(r.status, status, label);
    assert.equal(r.body.error.code, code, label);
  }
  assert.equal((await saved()).title, "login bug");
  assert.equal((await saved()).turnCap, 40);

  const raised = await api<RoomReply>(d, "PATCH", `/rooms/${id}`, {
    title: "capped",
    turnCap: 41,
  });
  assert.equal(raised.status, 200, raised.body.error?.message);
  assert.equal(raised.body.title, "capped");
  assert.equal((await saved()).turnCap, 41);

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const late = await api(d, "PATCH", `/rooms/${id}`, { title: "x" });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "room_dismissed");
});

test("two participants work in parallel in their own checkouts, and a third starts from one's branch", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario stall`,
        name: "stuck",
        role: "orchestrator",
      },
      { cmd: `node ${MOCK_AGENT}`, name: "writer" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const [stuck, writer] = open.body.participants as [
    ParticipantDto,
    ParticipantDto,
  ];
  const agent = (p: ParticipantDto) => `/rooms/${id}/agents/${p.id}`;
  const message = (text: string) =>
    api(d, "POST", `/rooms/${id}/messages`, { text });

  // Until M6-4 a message reaches only the orchestrator, so the role moves
  // from the stuck participant to the writer while the stuck one is busy.
  assert.equal((await message("hang")).status, 202);
  const cleared = await api(d, "PATCH", agent(stuck), { role: null });
  assert.equal(cleared.status, 200, cleared.body.error?.message);
  const moved = await api(d, "PATCH", agent(writer), { role: "orchestrator" });
  assert.equal(moved.status, 200, moved.body.error?.message);
  assert.equal((await message("write")).status, 202);
  await agentIdle(d, id, writer.id);
  const still = await api<ParticipantDto>(d, "GET", agent(stuck));
  assert.equal(still.body.status, "busy", "the two turns overlapped");

  assert.ok(existsSync(join(stuck.worktree, "stalled.txt")));
  assert.ok(!existsSync(join(stuck.worktree, "ACP_TEST.md")));
  assert.ok(existsSync(join(writer.worktree, "ACP_TEST.md")));
  assert.ok(!existsSync(join(writer.worktree, "stalled.txt")));

  // The stuck participant commits its own work (R37), and a third starts
  // from that branch through the route.
  for (const args of [
    ["add", "stalled.txt"],
    ["commit", "-m", "stuck: stalled.txt"],
  ]) {
    const r = spawnSync("git", args, { cwd: stuck.worktree });
    assert.equal(r.status, 0, String(r.stderr));
  }
  const head = spawnSync("git", ["rev-parse", stuck.branch as string], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();
  const reviewer = await addAgent(d, id, {
    cmd: REMEMBER,
    name: "reviewer",
    base: stuck.branch,
  });
  assert.equal(reviewer.baseSha, head);
  assert.ok(existsSync(join(reviewer.worktree, "stalled.txt")));

  // Removing the busy one ends its turn and leaves the others as they were.
  const gone = await api<RoomReply>(d, "DELETE", agent(stuck));
  assert.equal(gone.status, 200, gone.body.error?.message);
  assert.deepEqual(
    gone.body.participants.map((p) => [p.name, p.status]),
    [
      ["writer", "idle"],
      ["reviewer", "idle"],
    ],
  );
  const kept = spawnSync(
    "git",
    ["rev-parse", "--verify", stuck.branch as string],
    { cwd },
  );
  assert.equal(kept.status, 0, "the removed participant's branch is kept");
  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const ended = (await roomEvents(d, id)).filter(
    (e) => e.update.sessionUpdate === "_client_turn_ended",
  );
  assert.equal(ended.length, 2, "the removed participant's turn ended too");
});

test("an explicit empty agents list, a 32-character name and every role open a room", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));

  const empty = await api<RoomReply>(d, "POST", "/rooms", { cwd, agents: [] });
  assert.equal(empty.status, 201, empty.body.error?.message);
  assert.deepEqual(empty.body.participants, []);
  await api(d, "POST", `/rooms/${empty.body.id}/dismiss`);

  const agents: { cmd: string; name?: string; role?: string }[] = [
    { cmd: REMEMBER, name: "a".repeat(32) },
    ...["developer", "tester", "architect", "reviewer"].map((role) => ({
      cmd: REMEMBER,
      role,
    })),
  ];
  for (const agent of agents) {
    const open = await api<RoomReply>(d, "POST", "/rooms", {
      cwd,
      agents: [agent],
    });
    assert.equal(open.status, 201, open.body.error?.message);
    const got = await api<RoomReply>(d, "GET", `/rooms/${open.body.id}`);
    assert.equal(only(got.body).name, agent.name ?? "mock-agent");
    assert.equal(only(got.body).role, agent.role);
    await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
  }
});

test("a harness that dies leaves its participant exited, the room active, and a message revives it", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;

  // The harness pid is on the room's log; the SSE stream would not end
  // while the room lives, so the file is read directly.
  const log = join(stateDirFor(root), "rooms", id, "events.jsonl");
  let pid: number | undefined;
  for (const until = Date.now() + 10_000; !pid && Date.now() < until; ) {
    const lines = (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    pid = lines.find(
      (e) => e.update.sessionUpdate === "_client_harness_spawned",
    )?.update.pid;
    if (!pid) await new Promise((ok) => setTimeout(ok, 25));
  }
  assert.ok(pid, "the harness pid is on the log");
  process.kill(pid, "SIGKILL");

  let room: RoomReply | undefined;
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    room = (await api<RoomReply>(d, "GET", `/rooms/${id}`)).body;
    if (only(room).status === "exited") break;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  assert.equal(room && only(room).status, "exited");
  assert.equal(room?.status, "active", "the room outlives its harness (R33)");

  // M6-7a: the next message starts a new harness with a fresh session.
  const r = await api(d, "POST", `/rooms/${id}/messages`, { text: "hi" });
  assert.equal(r.status, 202, r.body.error?.message);
  const back = only(await roomIdle(d, id));
  assert.equal(back.status, "idle");
  assert.equal(back.resumed, "fresh");
  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
});

test("a message needs an orchestrator: an empty room and a room without one refuse it", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const empty = await api<RoomReply>(d, "POST", "/rooms", { cwd });
  const plain = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER }],
  });
  assert.equal(plain.status, 201, plain.body.error?.message);
  assert.equal(only(plain.body).role, undefined, "no role is given by default");
  for (const room of [empty.body, plain.body]) {
    const r = await api(d, "POST", `/rooms/${room.id}/messages`, {
      text: "hi",
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "no_orchestrator");
    await api(d, "POST", `/rooms/${room.id}/dismiss`);
  }
});

test("a room whose harness cannot start is a 500 room_open_failed", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  // The harness binary is absent, so `openRoom` fails after the checkout is
  // ready; that failure has its own code, not `internal` (M5-3, #135).
  const r = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, "definitely-not-a-command"),
  );
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, "room_open_failed");
});

test("an ask participant asks through /permissions, and nobody answering denies it at the timeout", async (t) => {
  const d = await boot(t, undefined, ["--permission-timeout", "2"]);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const { id } = (await api<RoomReply>(d, "POST", "/rooms", { cwd })).body;
  const alice = await addAgent(d, id, {
    cmd: `node ${MOCK_AGENT}`,
    name: "alice",
    role: "orchestrator",
    mode: "ask",
  });
  assert.equal(alice.mode, "ask");

  const sent = await api(d, "POST", `/rooms/${id}/messages`, { text: "go" });
  assert.equal(sent.status, 202, sent.body.error?.message);
  const first = (await pendingOne(d)) as unknown as Record<string, unknown>;
  assert.deepEqual(
    { ...first, id: undefined },
    {
      id: undefined,
      roomId: id,
      participantId: alice.id,
      turn: 1,
      kind: "edit",
      title: "Write ACP_TEST.md",
      input: { path: "ACP_TEST.md" },
    },
  );
  const allowed = await api(d, "POST", `/permissions/${first.id}`, {
    allow: true,
  });
  assert.equal(allowed.status, 200, allowed.body.error?.message);
  assert.equal(
    (await api(d, "POST", `/permissions/${first.id}`, { allow: false })).status,
    409,
  );

  // The second question (the delete) waits for nobody: the 2 s timeout.
  const second = await pendingOne(d);
  assert.notEqual(second.id, first.id);
  let closed: PermissionDecision | undefined;
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    closed = (
      await api<PermissionDecision>(d, "GET", `/permissions/${second.id}`)
    ).body;
    if (closed.reason) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.deepEqual([closed?.allow, closed?.reason], [false, "timeout"]);

  const log = await roomLog(root, id);
  // Both permission events are in the room log, under the participant.
  assert.deepEqual(
    log
      .filter((e) => e.update.sessionUpdate === "_client_permission_queued")
      .map((e) => [e.participantId, e.update.id]),
    [
      [alice.id, first.id],
      [alice.id, second.id],
    ],
  );
  let answered = log.filter(
    (e) => e.update.sessionUpdate === "_client_permission_answered",
  );
  // The timeout path writes its answered event after the decision becomes
  // readable, so wait for the second event before asserting the pair.
  for (const until = Date.now() + 10_000; answered.length < 2; ) {
    assert.ok(Date.now() < until, "the timeout's answered event never came");
    await new Promise((ok) => setTimeout(ok, 25));
    answered = (await roomLog(root, id)).filter(
      (e) => e.update.sessionUpdate === "_client_permission_answered",
    );
  }
  assert.deepEqual(
    answered.map((e) => [e.participantId, e.update.reason]),
    [
      [alice.id, "client"],
      [alice.id, "timeout"],
    ],
  );
  assert.equal(
    log.find((e) => e.update.sessionUpdate === "_client_user_message")?.update
      .turn,
    1,
  );

  const changed = await api<ParticipantDto & RoomReply>(
    d,
    "PATCH",
    `/rooms/${id}/agents/${alice.id}`,
    { mode: "safe" },
  );
  assert.equal(changed.status, 200, changed.body.error?.message);
  assert.equal(changed.body.mode, "safe");
});

test("a room fast-forwards a target to a source, previews it, and logs the move", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "dev", role: "orchestrator" }],
  });
  assert.equal(open.status, 201, JSON.stringify(open.body));
  const roomId = open.body.id;
  const dev = only(open.body);
  await commitAt(dev.worktree, "dev.txt");

  const addedRev = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${roomId}/agents`,
    { cmd: REMEMBER, name: "reviewer", base: dev.branch },
  );
  assert.equal(addedRev.status, 201, JSON.stringify(addedRev.body));
  const reviewer = addedRev.body;
  await commitAt(reviewer.worktree, "review.txt");
  const revHead = headAt(reviewer.worktree);

  const preview = await api<Diff>(
    d,
    "GET",
    `/rooms/${roomId}/agents/${dev.id}/fast-forward?from=${reviewer.id}`,
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.files, 1, JSON.stringify(preview.body));
  assert.match(preview.body.text, /review\.txt/);

  const moved = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
    { from: reviewer.id },
  );
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.branch, dev.branch);
  assert.equal(headAt(dev.worktree), revHead);
  assert.equal(headAt(reviewer.worktree), revHead, "the source is untouched");
  assert.ok(existsSync(join(dev.worktree, "review.txt")));

  await api(d, "POST", `/rooms/${roomId}/dismiss`);
  const events = await roomEvents(d, roomId);
  const forwarded = events.filter(
    (e) => e.update.sessionUpdate === "_client_participant_fast_forwarded",
  );
  assert.deepEqual(
    forwarded.map((e) => e.update),
    [
      {
        sessionUpdate: "_client_participant_fast_forwarded",
        from: reviewer.id,
        branch: dev.branch,
        sha: revHead,
      },
    ],
  );
});

test("a fast-forward refuses a busy or dirty target and a diverged one, with codes", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  type Refusal = { error: { code: string; message: string } };

  const pair = async (devCmd = REMEMBER) => {
    const open = await api<RoomReply>(d, "POST", "/rooms", {
      cwd,
      agents: [{ cmd: devCmd, name: "dev", role: "orchestrator" }],
    });
    assert.equal(open.status, 201, JSON.stringify(open.body));
    const dev = only(open.body);
    const addedRev = await api<ParticipantDto>(
      d,
      "POST",
      `/rooms/${open.body.id}/agents`,
      { cmd: REMEMBER, name: "reviewer", base: dev.branch },
    );
    assert.equal(addedRev.status, 201, JSON.stringify(addedRev.body));
    return { roomId: open.body.id, dev, reviewer: addedRev.body };
  };

  // A busy target is refused before anything else.
  {
    const { roomId, dev, reviewer } = await pair(
      `node ${MOCK_AGENT} --scenario slow`,
    );
    const sent = await api(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/messages`,
      {
        text: "hold",
      },
    );
    assert.equal(sent.status, 202);
    const refused = await api<Refusal>(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
      { from: reviewer.id },
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "agent_busy");
    await api(d, "POST", `/rooms/${roomId}/dismiss`);
  }

  // Tracked dirt refuses; an untracked file does not, once the dirt is gone.
  {
    const { roomId, dev, reviewer } = await pair();
    await commitAt(reviewer.worktree, "review.txt");
    const before = headAt(dev.worktree);
    await writeFile(join(dev.worktree, "README.md"), "dirty\n");

    const refused = await api<Refusal>(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
      { from: reviewer.id },
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "dirty_worktree");
    assert.equal(headAt(dev.worktree), before);

    const clean = spawnSync("git", ["checkout", "--", "README.md"], {
      cwd: dev.worktree,
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stderr);
    await writeFile(join(dev.worktree, "scratch.txt"), "untracked\n");
    const moved = await api<ParticipantDto>(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
      { from: reviewer.id },
    );
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.ok(existsSync(join(dev.worktree, "scratch.txt")));
    await api(d, "POST", `/rooms/${roomId}/dismiss`);
  }

  // A target commit since the fork makes this a merge, not a fast-forward.
  {
    const { roomId, dev, reviewer } = await pair();
    await commitAt(dev.worktree, "late.txt");
    await commitAt(reviewer.worktree, "review.txt");
    const before = headAt(dev.worktree);
    const refused = await api<Refusal>(
      d,
      "POST",
      `/rooms/${roomId}/agents/${dev.id}/fast-forward`,
      { from: reviewer.id },
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "not_fast_forward");
    assert.equal(headAt(dev.worktree), before);
    await api(d, "POST", `/rooms/${roomId}/dismiss`);
  }
});

// --- room commands (M4-5) -----------------------------------------------------

/** The address `client/` takes, from a test daemon. */
const addressOf = (d: Daemon) => ({
  port: Number(new URL(d.url).port),
  token: d.token,
});

/** Parses a typed line and sends it; the line must be a route command. */
async function typed(
  d: Daemon,
  roomId: string | undefined,
  line: string,
  roster: readonly Named[] = [],
): Promise<Outcome> {
  const c = parseCommand(line, roster);
  assert.ok(c && "verb" in c, `not a command: ${line} → ${JSON.stringify(c)}`);
  assert.ok(
    c.verb !== "leave" &&
      c.verb !== "help" &&
      c.verb !== "form" &&
      c.verb !== "models",
    line,
  );
  if (c.verb === "ff") {
    // The screen turns the parsed command into its route call (M6-11a).
    return runCommand(addressOf(d), roomId, {
      verb: "forward",
      id: c.id,
      name: c.name,
      fromId: c.from.id,
      fromName: c.from.name,
    });
  }
  return runCommand(addressOf(d), roomId, c as RouteCommand);
}

test("every typed room command reaches its route", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const opened = await typed(
    d,
    undefined,
    `/new --cmd "${REMEMBER}" --name alice --title fix --cwd ${cwd}`,
  );
  assert.ok(opened.ok && opened.room, JSON.stringify(opened));
  assert.equal(opened.line, "opened room fix");
  const roomId = opened.room.id;
  const alice = only(opened.room);
  assert.equal(alice.role, "developer");

  // A commit on alice's branch, so `--base @alice` is not the room's HEAD.
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", alice.worktree, ...args], { encoding: "utf8" });
  assert.equal(git("commit", "--allow-empty", "-qm", "alice's").status, 0);
  const aliceHead = git("rev-parse", "HEAD").stdout.trim();

  const roster = () =>
    api<RoomReply>(d, "GET", `/rooms/${roomId}`).then(
      (r) => r.body.participants,
    );
  const addBob = await typed(
    d,
    roomId,
    `/add --cmd "node ${MOCK_AGENT} --scenario stall" --name bob --role tester --mode ask --base @Alice`,
    await roster(),
  );
  assert.ok(addBob.ok, JSON.stringify(addBob));
  assert.equal(addBob.line, "added bob (mock-agent, tester, ask)");
  let bob = (await roster()).find((p) => p.name === "bob");
  assert.equal(bob?.baseSha, aliceHead, "bob starts from alice's branch");

  for (const [line, want] of [
    ["@bob /rename carol", "renamed bob to carol"],
    ["@carol /role developer", "carol is now developer"],
    ["@carol /role none", "carol has no role"],
    ["@carol /mode safe", "carol is now in safe mode"],
  ] as const) {
    const r = await typed(d, roomId, line, await roster());
    assert.ok(r.ok, `${line}: ${JSON.stringify(r)}`);
    assert.equal(r.line, want);
  }
  bob = (await roster()).find((p) => p.id === bob?.id);
  assert.equal(bob?.name, "carol");
  assert.equal(bob?.role, undefined);
  assert.equal(bob?.mode, "safe");

  const beforeTitle = await api<RoomReply>(d, "GET", `/rooms/${roomId}`);
  const retitled = await typed(d, roomId, "/title login bug", await roster());
  assert.ok(retitled.ok, JSON.stringify(retitled));
  assert.equal(retitled.line, "renamed the room to login bug");
  assert.equal(retitled.room?.title, "login bug");
  assert.equal(
    retitled.room?.seq,
    beforeTitle.body.seq,
    "a rename writes no room line",
  );
  const capped = await typed(d, roomId, "/cap 41", await roster());
  assert.ok(capped.ok, JSON.stringify(capped));
  assert.equal(capped.line, "raised the orchestrator turn cap to 41");
  const notRaised = await typed(d, roomId, "/cap 41", await roster());
  assert.ok(!notRaised.ok);
  assert.equal(notRaised.code, "invalid_request");
  assert.match(notRaised.message, /greater than .*41/);

  const said = await api(
    d,
    "POST",
    `/rooms/${roomId}/agents/${bob?.id}/messages`,
    { text: "hang" },
  );
  assert.equal(said.status, 202);
  const cancel = await typed(d, roomId, "@carol /cancel", await roster());
  assert.ok(cancel.ok, JSON.stringify(cancel));
  assert.equal(cancel.line, "cancelling carol's turn");

  const forward = await typed(
    d,
    roomId,
    "@alice /ff --from @carol",
    await roster(),
  );
  assert.ok(forward.ok, JSON.stringify(forward));
  assert.equal(forward.line, "moved alice up to carol's commit");

  const removed = await typed(d, roomId, "@carol /remove", await roster());
  assert.ok(removed.ok, JSON.stringify(removed));
  assert.deepEqual(
    (await roster()).map((p) => p.name),
    ["alice"],
  );

  const gone = await typed(d, roomId, "/dismiss");
  assert.ok(gone.ok, JSON.stringify(gone));
  assert.equal(gone.room?.status, "dismissed");

  // The stall scenario left its uncommitted file in carol's kept checkout.
  assert.ok(bob?.worktree);
  await rm(join(bob.worktree, "stalled.txt"), { force: true });
  const deleted = await typed(d, roomId, "/delete");
  assert.ok(deleted.ok, JSON.stringify(deleted));
  assert.equal(deleted.line, `deleted ${roomId}`);
  assert.equal((await api(d, "GET", `/rooms/${roomId}`)).status, 404);
});

test("a model reaches both routes, typed or posted, and a refused one still adds the agent (M9-5)", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const MODELS = `node ${MOCK_AGENT} --scenario models`;
  const opened = await typed(
    d,
    undefined,
    `/new --cmd "${MODELS}" --name alice --model mock/smart --cwd ${cwd}`,
  );
  assert.ok(opened.ok && opened.room, JSON.stringify(opened));
  assert.equal(only(opened.room).model, "mock/smart");
  assert.equal(opened.line, `opened room ${opened.room.id}`);
  const roomId = opened.room.id;
  // `/new` says a refused model at once, as `/add` does.
  const other = await typed(
    d,
    undefined,
    `/new --cmd "${MODELS}" --model mock/bogus --title other --cwd ${cwd}`,
  );
  assert.ok(other.ok && other.room, JSON.stringify(other));
  assert.equal(
    other.line,
    'opened room other; ! not confirmed on the model "mock/bogus"',
  );
  await api(d, "POST", `/rooms/${other.room.id}/dismiss`);

  const bob = await typed(
    d,
    roomId,
    `/add --cmd "${MODELS}" --name bob --model mock/bogus`,
  );
  assert.ok(bob.ok, JSON.stringify(bob));
  assert.equal(
    bob.line,
    'added bob (mock-agent, auto, mock/fast); ! not confirmed on the model "mock/bogus"',
  );
  // A harness that never answers the set may still apply it, so the line
  // claims no outcome: the room's notice says "did not confirm".
  const eve = await typed(
    d,
    roomId,
    `/add --cmd "${MODELS} --model-exit" --name eve --model mock/smart`,
  );
  assert.ok(eve.ok, JSON.stringify(eve));
  assert.match(eve.line ?? "", /; ! not confirmed on the model "mock\/smart"$/);
  const posted = await api<ParticipantDto>(
    d,
    "POST",
    `/rooms/${roomId}/agents`,
    { cmd: MODELS, name: "carol", model: "mock/smart" },
  );
  assert.equal(posted.status, 201);
  assert.equal(posted.body.model, "mock/smart");

  const room = await api<RoomReply>(d, "GET", `/rooms/${roomId}`);
  const byName = new Map(room.body.participants.map((p) => [p.name, p]));
  assert.equal(byName.get("bob")?.model, "mock/fast");
  assert.ok(
    byName
      .get("bob")
      ?.notices.some((n) => n.text.includes('refused the model "mock/bogus"')),
    JSON.stringify(byName.get("bob")?.notices),
  );

  for (const [path, body] of [
    [`/rooms/${roomId}/agents`, { cmd: MODELS, name: "dan", model: 7 }],
    ["/rooms", { cwd, agents: [{ cmd: MODELS, model: "" }] }],
  ] as const) {
    const bad = await api<RoomReply>(d, "POST", path, body);
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error?.code, "invalid_request");
    assert.match(bad.body.error?.message ?? "", /"model" must be/);
  }
});

test("a typed or patched model change answers with the model in use, keeps a refused one off, and refuses a bad value (M9-6)", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const MODELS = `node ${MOCK_AGENT} --scenario models`;
  const opened = await typed(
    d,
    undefined,
    `/new --cmd "${MODELS}" --name alice --cwd ${cwd}`,
  );
  assert.ok(opened.ok && opened.room, JSON.stringify(opened));
  const roomId = opened.room.id;
  const alice = only(opened.room);
  assert.deepEqual(alice.models, [
    { id: "mock/fast", name: "Fast" },
    { id: "mock/smart", name: "Smart" },
  ]);
  const roster = [{ id: alice.id, name: "alice" }];

  const changed = await typed(d, roomId, "@alice /model mock/smart", roster);
  assert.ok(changed.ok, JSON.stringify(changed));
  assert.equal(changed.line, 'alice now runs on the model "mock/smart"');
  assert.equal(changed.participant?.model, "mock/smart");

  const base = `/rooms/${roomId}/agents/${alice.id}`;
  const refused = await api<ParticipantDto>(d, "PATCH", base, {
    model: "mock/bogus",
  });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.model, "mock/smart", "the model it had");
  assert.ok(
    refused.body.notices.some((n) =>
      n.text.includes('refused the model "mock/bogus"'),
    ),
    JSON.stringify(refused.body.notices),
  );
  const line = await typed(d, roomId, "@alice /model mock/bogus", roster);
  assert.ok(line.ok, JSON.stringify(line));
  assert.equal(line.line, '! alice is not confirmed on the model "mock/bogus"');

  // With the rest of a PATCH: every change is checked before any is made.
  const both = await api<ParticipantDto>(d, "PATCH", base, {
    mode: "safe",
    model: "mock/fast",
  });
  assert.equal(both.status, 200);
  assert.equal(both.body.mode, "safe");
  assert.equal(both.body.model, "mock/fast");
  for (const model of ["", 7, null]) {
    const bad = await api<RoomReply>(d, "PATCH", base, { name: "x", model });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error?.code, "invalid_request");
  }
  const kept = await api<RoomReply>(d, "GET", `/rooms/${roomId}`);
  assert.equal(
    only(kept.body).name,
    "alice",
    "a refused PATCH changed nothing",
  );
});

test("each room command shows the daemon's own message for each refusal its route documents", async (t) => {
  const d = await boot(t);
  const repo = await gitRepo(t);
  const cwd = await added(d, repo);
  const outside = await gitRepo(t);
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, name: "alice", role: "orchestrator" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const roomId = open.body.id;
  const alice = only(open.body);
  const ghost = [{ id: "p-nobody", name: "ghost" }];
  const roster: Named[] = [
    { id: alice.id, name: "alice", role: "orchestrator" },
  ];

  const refusals: [string, string | undefined, string, typeof roster][] = [
    // POST /rooms
    [
      `/new --cmd "${REMEMBER}" --cwd ${outside}`,
      undefined,
      "repo_not_added",
      [],
    ],
    [
      `/new --cmd "${REMEMBER}" --cwd ${join(repo, "missing")}`,
      undefined,
      "invalid_request",
      [],
    ],
    [
      `/new --cmd "${REMEMBER}" --name "a b" --cwd ${cwd}`,
      undefined,
      "invalid_request",
      [],
    ],
    [
      `/new --cmd /no/such/harness --name x --cwd ${cwd}`,
      undefined,
      "room_open_failed",
      [],
    ],
    // POST /rooms/:id/agents
    [`/add --cmd "${REMEMBER}" --name dan`, "room-nope", "room_not_found", []],
    [
      `/add --cmd "${REMEMBER}" --name dan --mode loud`,
      roomId,
      "invalid_request",
      [],
    ],
    [
      `/add --cmd "${REMEMBER}" --name dan --base no-such-ref`,
      roomId,
      "invalid_request",
      [],
    ],
    [`/add --cmd "${REMEMBER}" --name alice`, roomId, "name_taken", []],
    [
      `/add --cmd "${REMEMBER}" --name dan --role orchestrator`,
      roomId,
      "orchestrator_exists",
      [],
    ],
    [`/add --cmd /no/such/harness --name dan`, roomId, "room_open_failed", []],
    // PATCH /rooms/:id/agents/:agentId
    ["@alice /mode ask", "room-nope", "room_not_found", roster],
    ["@ghost /mode ask", roomId, "participant_not_found", ghost],
    ["@alice /mode loud", roomId, "invalid_request", roster],
    // DELETE /rooms/:id/agents/:agentId
    ["@alice /remove", "room-nope", "room_not_found", roster],
    ["@ghost /remove", roomId, "participant_not_found", ghost],
    // POST /rooms/:id/agents/:agentId/turns/current/cancel
    ["@alice /cancel", "room-nope", "room_not_found", roster],
    ["@ghost /cancel", roomId, "participant_not_found", ghost],
    ["@alice /cancel", roomId, "no_turn", roster],
    // PATCH /rooms/:id
    ["/title x", "room-nope", "room_not_found", []],
    // POST /rooms/:id/dismiss
    ["/dismiss", "room-nope", "room_not_found", []],
  ];
  // A second participant, so a rename and a role change can clash.
  const bob = await api<ParticipantDto>(d, "POST", `/rooms/${roomId}/agents`, {
    cmd: REMEMBER,
    name: "bob",
  });
  assert.equal(bob.status, 201);
  const both = [...roster, { id: bob.body.id, name: "bob" }];
  refusals.push(
    ["@bob /rename alice", roomId, "name_taken", both],
    ["@bob /role orchestrator", roomId, "orchestrator_exists", both],
  );

  const check = async (
    line: string,
    room: string | undefined,
    code: string,
    names: typeof roster,
  ) => {
    const r = await typed(d, room, line, names);
    assert.ok(!r.ok, `${line}: expected ${code}, got ${JSON.stringify(r)}`);
    assert.equal(r.code, code, `${line}: ${r.message}`);
    // The daemon's sentence, passed through: never a bare status.
    assert.ok(r.message && !/^HTTP \d+$/.test(r.message), r.message);
  };
  for (const [line, room, code, names] of refusals) {
    await check(line, room, code, names);
  }

  // A `--base @name` the room lacks is refused before the POST.
  const nobody = await typed(d, roomId, "/add pi --base @nobody", both);
  assert.deepEqual(nobody, {
    ok: false,
    code: "",
    message: "no participant named @nobody",
  });

  // A project config gone bad after the add: the room reads it at open.
  await mkdir(join(repo, ".kapelle"), { recursive: true });
  await writeFile(join(repo, ".kapelle", "config.json"), "{ nope");
  await check(
    `/new --cmd "${REMEMBER}" --cwd ${cwd}`,
    undefined,
    "invalid_config",
    [],
  );

  // Every route on a dismissed room.
  const dismissed = await api(d, "POST", `/rooms/${roomId}/dismiss`);
  assert.equal(dismissed.status, 200);
  for (const line of [
    "/dismiss",
    `/add --cmd "${REMEMBER}" --name carol`,
    "@alice /mode ask",
    "@alice /remove",
    "@alice /cancel",
    "/title x",
  ]) {
    await check(line, roomId, "room_dismissed", roster);
  }
});

test("GET /rooms/:id/agents/:agentId/diff shows what an agent did not commit, new files too, and with base its commits", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  const route = `/rooms/${open.body.id}/agents/${p.id}/diff`;
  type DiffReply = Diff & { error: { code: string } };

  const clean = await api<DiffReply>(d, "GET", route);
  assert.equal(clean.status, 200);
  assert.deepEqual(clean.body, { text: "", files: 0, added: 0, removed: 0 });

  // In `auto` the agent asks nothing; the person still sees what it did.
  await writeFile(join(p.worktree, "README.md"), "changed\n");
  await writeFile(join(p.worktree, "new.txt"), "fresh\n");
  const head = await api<DiffReply>(d, "GET", `${route}?against=head`);
  assert.equal(head.status, 200);
  assert.deepEqual(
    [head.body.files, head.body.added, head.body.removed],
    [2, 2, 1],
  );
  assert.match(
    head.body.text,
    /diff --git a\/new\.txt b\/new\.txt\nnew file mode/,
  );

  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: p.worktree });
  assert.equal(git("commit", "-qam", "agent work").status, 0);
  const after = await api<DiffReply>(d, "GET", route);
  assert.equal(after.body.files, 1, "the commit left only the new file");
  const base = await api<DiffReply>(d, "GET", `${route}?against=base`);
  assert.equal(base.body.files, 2, "the whole branch has the commit too");
  assert.match(base.body.text, /-first\n\+changed/);

  const bad = await api<DiffReply>(d, "GET", `${route}?against=main`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_request");
  const nobody = await api<DiffReply>(
    d,
    "GET",
    `/rooms/${open.body.id}/agents/nobody/diff`,
  );
  assert.equal(nobody.status, 404);

  // A checkout that is gone has no diff, and says so.
  await rm(p.worktree, { recursive: true, force: true });
  const gone = await api<DiffReply>(d, "GET", route);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.error.code, "no_diff");
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("a branch renamed and rebased in a turn reaches the room reply, room.json and the base diff", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario read-only`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  const renamed = "renamed-topic";
  const branch = spawnSync("git", ["branch", "-m", renamed], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(branch.status, 0, branch.stderr);

  // The agent commits, the base moves, and the agent rebases onto it.
  await commitAt(p.worktree, "agent.txt");
  await commitAt(cwd, "base.txt");
  const newer = headAt(cwd);
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(rebase.status, 0, rebase.stderr);

  // The route derives the new base itself, before a turn can update baseSha.
  const beforeTurn = await api<Diff>(
    d,
    "GET",
    `/rooms/${open.body.id}/agents/${p.id}/diff?against=base`,
  );
  assert.equal(beforeTurn.status, 200);
  assert.match(beforeTurn.body.text, /diff --git a\/agent\.txt b\/agent\.txt/);
  assert.doesNotMatch(beforeTurn.body.text, /base\.txt/);

  const sent = await api<RoomReply>(
    d,
    "POST",
    `/rooms/${open.body.id}/messages`,
    {
      text: "go",
    },
  );
  assert.equal(sent.status, 202, sent.body.error?.message);
  const roomNow = await roomIdle(d, open.body.id);
  assert.equal(only(roomNow).branch, renamed);
  assert.equal(only(roomNow).baseSha, newer);

  type DiffReply = Diff & { error: { code: string } };
  const diff = await api<DiffReply>(
    d,
    "GET",
    `/rooms/${open.body.id}/agents/${p.id}/diff?against=base`,
  );
  assert.equal(diff.status, 200);
  assert.match(diff.body.text, /diff --git a\/agent\.txt b\/agent\.txt/);
  assert.doesNotMatch(
    diff.body.text,
    /base\.txt/,
    "the new base's own file is not the agent's work",
  );

  // `room.json` is written after the turn's sync; poll for the save.
  const file = join(stateDirFor(cwd), "rooms", open.body.id, "room.json");
  for (const end = Date.now() + 5_000; ; ) {
    const record = JSON.parse(await readFile(file, "utf8")) as {
      participants: { branch?: string; baseSha?: string }[];
    };
    if (
      record.participants[0]?.branch === renamed &&
      record.participants[0]?.baseSha === newer
    ) {
      break;
    }
    if (Date.now() > end) assert.fail("room.json never showed the rename");
    await new Promise((ok) => setTimeout(ok, 25));
  }
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

for (const operation of [
  "advance",
  "merge",
  "fast-forward",
  "reset",
] as const) {
  test(`the base diff follows current topology after base ${operation}`, async (t) => {
    const d = await boot(t);
    const cwd = await added(d, await gitRepo(t));
    const open = await api<RoomReply>(
      d,
      "POST",
      "/rooms",
      withAgent(cwd, REMEMBER),
    );
    assert.equal(open.status, 201, open.body.error?.message);
    const p = only(open.body);
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: p.worktree, encoding: "utf8" });

    // A real merge needs the participant and base to have diverged.
    if (operation === "merge") await commitAt(p.worktree, "agent.txt");
    await commitAt(cwd, "base.txt");
    const moved =
      operation === "merge"
        ? git("merge", "--no-edit", "main")
        : operation === "fast-forward"
          ? git("merge", "--ff-only", "main")
          : operation === "reset"
            ? git("reset", "--hard", "main")
            : undefined;
    if (moved) assert.equal(moved.status, 0, moved.stderr);
    if (operation !== "merge") await commitAt(p.worktree, "agent.txt");

    // The merge-base SHA still goes through checkoutDiff's copied index.
    await writeFile(join(p.worktree, "README.md"), "dirty README\n");
    await writeFile(join(p.worktree, "new.txt"), "new\n");
    const before = git("status", "--porcelain").stdout;
    const diff = await api<Diff & { error: { message: string } }>(
      d,
      "GET",
      `/rooms/${open.body.id}/agents/${p.id}/diff?against=base`,
    );
    assert.equal(diff.status, 200, diff.body.error?.message);
    assert.equal(diff.body.files, 3, diff.body.text);
    assert.match(diff.body.text, /diff --git a\/agent\.txt b\/agent\.txt/);
    assert.match(diff.body.text, /diff --git a\/README\.md b\/README\.md/);
    assert.match(diff.body.text, /diff --git a\/new\.txt b\/new\.txt/);
    assert.doesNotMatch(diff.body.text, /base\.txt/);
    assert.equal(git("status", "--porcelain").stdout, before);
    await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
  });
}

test("a base ref that rewinds does not claim the old base as agent work", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const first = headAt(cwd);
  await commitAt(cwd, "base.txt");
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  await commitAt(p.worktree, "agent.txt");
  const rewind = spawnSync("git", ["reset", "--hard", first], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(rewind.status, 0, rewind.stderr);

  const diff = await api<Diff>(
    d,
    "GET",
    `/rooms/${open.body.id}/agents/${p.id}/diff?against=base`,
  );
  assert.equal(diff.status, 200);
  assert.match(diff.body.text, /agent\.txt/);
  assert.doesNotMatch(diff.body.text, /base\.txt/);
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("a participant reset behind its saved base keeps the current merge base", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const first = headAt(cwd);
  await commitAt(cwd, "base.txt");
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  await commitAt(p.worktree, "agent.txt");
  const reset = spawnSync("git", ["reset", "--hard", first], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(reset.status, 0, reset.stderr);

  const diff = await api<Diff>(
    d,
    "GET",
    `/rooms/${open.body.id}/agents/${p.id}/diff?against=base`,
  );
  assert.equal(diff.status, 200);
  assert.deepEqual(diff.body, { text: "", files: 0, added: 0, removed: 0 });
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("an unresolvable saved base does not hide a valid current merge base", async (t) => {
  const { first, cwd, id, alice, again } = await roomToRestart(t, REMEMBER);
  await commitAt(cwd, "base.txt");
  const switched = spawnSync("git", ["switch", "-c", "switched", "main"], {
    cwd: alice.worktree,
    encoding: "utf8",
  });
  assert.equal(switched.status, 0, switched.stderr);
  await commitAt(alice.worktree, "agent.txt");
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const file = join(stateDirFor(cwd), "rooms", id, "room.json");
  const saved = JSON.parse(await readFile(file, "utf8")) as {
    participants: { baseSha?: string }[];
  };
  const participant = saved.participants[0];
  assert.ok(participant);
  participant.baseSha = "0".repeat(40);
  await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
  const second = await again();
  const diff = await api<Diff & { error: { message: string } }>(
    second,
    "GET",
    `/rooms/${id}/agents/${alice.id}/diff?against=base`,
  );
  assert.equal(diff.status, 200, diff.body.error?.message);
  assert.match(diff.body.text, /agent\.txt/);
  assert.doesNotMatch(diff.body.text, /base\.txt/);
  await api(second, "POST", `/rooms/${id}/dismiss`);
});

test("the configured base ref survives restart; an old record uses its saved SHA", async (t) => {
  const { first, cwd, id, alice, again } = await roomToRestart(t, REMEMBER);
  const originalBase = alice.baseSha;
  await commitAt(cwd, "base.txt");
  const switched = spawnSync("git", ["switch", "-c", "switched", "main"], {
    cwd: alice.worktree,
    encoding: "utf8",
  });
  assert.equal(switched.status, 0, switched.stderr);
  await commitAt(alice.worktree, "agent.txt");

  const route = `/rooms/${id}/agents/${alice.id}/diff?against=base`;
  const before = await api<Diff>(first, "GET", route);
  assert.equal(before.status, 200);
  assert.match(before.body.text, /agent\.txt/);
  assert.doesNotMatch(before.body.text, /base\.txt/);

  const file = join(stateDirFor(cwd), "rooms", id, "room.json");
  const saved = JSON.parse(await readFile(file, "utf8")) as {
    participants: { baseRef?: string }[];
  };
  assert.equal(saved.participants[0]?.baseRef, "refs/heads/main");
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await again();
  await writeFile(join(alice.worktree, "README.md"), "dirty README\n");
  await writeFile(join(alice.worktree, "new.txt"), "new\n");
  const restored = await api<Diff>(second, "GET", route);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.files, 3, restored.body.text);
  assert.doesNotMatch(restored.body.text, /base\.txt/);

  // A record written before baseRef existed keeps the old, defined fallback.
  process.kill(second.pid, "SIGTERM");
  assert.equal((await second.done).code, 0);
  const legacy = JSON.parse(await readFile(file, "utf8")) as {
    participants: { baseRef?: string; baseSha?: string }[];
  };
  assert.equal(legacy.participants[0]?.baseSha, originalBase);
  delete legacy.participants[0]?.baseRef;
  await writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`);
  const third = await again();
  const fallback = await api<Diff>(third, "GET", route);
  assert.equal(fallback.status, 200);
  assert.match(fallback.body.text, /agent\.txt/);
  assert.match(fallback.body.text, /base\.txt/);
});

test("a pinned-SHA base stays pinned when the repository branch advances", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const base = headAt(cwd);
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, role: "orchestrator", base }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  await commitAt(p.worktree, "agent.txt");
  await commitAt(cwd, "base.txt");
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(rebase.status, 0, rebase.stderr);

  const diff = await api<Diff>(
    d,
    "GET",
    `/rooms/${open.body.id}/agents/${p.id}/diff?against=base`,
  );
  assert.equal(diff.status, 200);
  assert.match(diff.body.text, /agent\.txt/);
  assert.match(
    diff.body.text,
    /base\.txt/,
    "a newer main does not move an explicitly pinned base",
  );
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("a deleted explicit base ref falls back to the saved base SHA", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const topic = spawnSync("git", ["branch", "topic"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(topic.status, 0, topic.stderr);
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, role: "orchestrator", base: "topic" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  const git = (dir: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  await commitAt(p.worktree, "agent.txt");
  await commitAt(cwd, "base.txt");
  git(cwd, "branch", "-f", "topic", "main");
  git(p.worktree, "rebase", "topic");
  const route = `/rooms/${open.body.id}/agents/${p.id}/diff?against=base`;

  const movable = await api<Diff>(d, "GET", route);
  assert.equal(movable.status, 200);
  assert.doesNotMatch(movable.body.text, /base\.txt/);
  git(cwd, "branch", "-D", "topic");
  const fallback = await api<Diff>(d, "GET", route);
  assert.equal(fallback.status, 200);
  assert.match(fallback.body.text, /agent\.txt/);
  assert.match(fallback.body.text, /base\.txt/);
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

for (const scenario of ["diff-first", "file-text"]) {
  test(`an ask question about an edit carries its diff in GET /permissions: ${scenario}`, async (t) => {
    const d = await boot(t);
    const cwd = await added(d, await gitRepo(t));
    const open = await api<RoomReply>(d, "POST", "/rooms", {
      cwd,
      agents: [
        {
          cmd: `node ${MOCK_AGENT} --scenario ${scenario}`,
          role: "orchestrator",
          mode: "ask",
        },
      ],
    });
    assert.equal(open.status, 201, open.body.error?.message);
    const p = only(open.body);
    await api(d, "POST", `/rooms/${open.body.id}/agents/${p.id}/messages`, {
      text: "go",
    });
    const q = (await pendingOne(d)) as Pending & { diff?: Diff };
    assert.equal(q.title, "Write ACP_TEST.md");
    assert.deepEqual(
      q.diff && [q.diff.files, q.diff.added, q.diff.removed],
      [1, 1, 0],
    );
    assert.match(
      q.diff?.text ?? "",
      /^diff --git a\/ACP_TEST\.md b\/ACP_TEST\.md\nnew file mode[\s\S]*\n\+written by the mock agent through the client$/,
    );
    await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
  });
}

test("a direct fs/write_text_file ask carries its built diff", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      {
        cmd: `node ${HOSTILE_AGENT} --scenario write-no-ask`,
        role: "orchestrator",
        mode: "ask",
      },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  await api(d, "POST", `/rooms/${open.body.id}/agents/${p.id}/messages`, {
    text: "go",
  });
  const q = (await pendingOne(d)) as Pending & { diff?: Diff };
  assert.equal(q.kind, "edit");
  assert.equal(q.title, `fs/write_text_file ${join(p.worktree, "SNEAKY.md")}`);
  assert.deepEqual(
    q.diff && [q.diff.files, q.diff.added, q.diff.removed],
    [1, 1, 0],
  );
  assert.match(
    q.diff?.text ?? "",
    /^diff --git a\/SNEAKY\.md b\/SNEAKY\.md\nnew file mode[\s\S]*\n\+written without asking$/,
  );
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

test("the diff route says no branch when the participant has none", async (t) => {
  const d = await boot(t);
  // Not a git repository, so there are no worktrees and no branch to name.
  const cwd = await added(d, await tempDir(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER, role: "orchestrator" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  type DiffReply = Diff & { error: { code: string; message: string } };
  const route = `/rooms/${open.body.id}/agents/${p.id}/diff`;
  const base = await api<DiffReply>(d, "GET", `${route}?against=base`);
  assert.equal(base.status, 409);
  assert.equal(base.body.error.code, "no_diff");
  assert.match(base.body.error.message, /no branch to compare with/);
  const head = await api<DiffReply>(d, "GET", route);
  assert.equal(head.status, 409);
  assert.equal(head.body.error.code, "no_diff");
  await api(d, "POST", `/rooms/${open.body.id}/dismiss`);
});

// --- a room across a restart (M6-7a, #151) ----------------------------------

const SLOW = `node ${MOCK_AGENT} --scenario slow`;

// The test drives the whole restart flow end to end: its call count is the test.
// pi-lens-ignore: high-fan-out
test("a restart lists the room paused, replays it, and a message revives the participant fresh", async (t) => {
  const { first, cwd, id, alice, again } = await roomToRestart(t, REMEMBER);
  const sent = await api<RoomReply>(first, "POST", `/rooms/${id}/messages`, {
    text: "alpha",
  });
  assert.equal(sent.status, 202, sent.body.error?.message);
  await roomIdle(first, id);
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await again();
  const list = await api<RoomListEntry[]>(second, "GET", "/rooms");
  const entry = list.body.find((r) => r.id === id);
  assert.equal(entry?.status, "paused");
  assert.deepEqual(
    entry?.participants.map((p) => p.status),
    ["paused"],
  );
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.status, "paused");
  assert.equal(got.body.title, "kept");
  const back = only(got.body);
  assert.equal(back.id, alice.id);
  assert.equal(back.worktree, alice.worktree, "the same checkout");
  assert.equal(back.branch, alice.branch);
  assert.equal(back.status, "paused");
  assert.equal(back.resumed, undefined);
  const before = await roomLog(cwd, id);
  assert.deepEqual(answersIn(before), ["previous: (none)"]);

  // Its history replays on the stream of the new daemon.
  const res = await fetch(`${second.url}/rooms/${id}/events`, {
    headers: { authorization: `Bearer ${second.token}` },
  });
  assert.equal(res.status, 200);
  const reader = (res.body as ReadableStream<Uint8Array>)
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let text = "";
  while ((text.match(/^data: /gm) ?? []).length < before.length) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  await reader.cancel();
  assert.equal((text.match(/^data: /gm) ?? []).length, before.length);

  const revive = await api<RoomReply>(second, "POST", `/rooms/${id}/messages`, {
    text: "beta",
  });
  assert.equal(revive.status, 202, revive.body.error?.message);
  const after = only(await roomIdle(second, id));
  assert.equal(after.status, "idle");
  assert.equal(after.resumed, "fresh");
  const room = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(room.body.status, "active", "a revive makes the room active");

  const lines = await roomLog(cwd, id);
  assert.deepEqual(
    lines.map((l) => l.seq),
    lines.map((_, i) => i + 1),
    "one log, with seq carried on",
  );
  assert.deepEqual(
    answersIn(lines),
    ["previous: (none)", "previous: (none)"],
    "a fresh session does not remember alpha",
  );
  assert.ok(
    lines
      .slice(before.length)
      .some((l) => l.update.sessionUpdate === "_client_participant_revived"),
  );
});

test("a shutdown during a turn ends it in the log, and the participant is paused after the restart", async (t) => {
  const { first, cwd, id, again } = await roomToRestart(t, SLOW);
  await api(first, "POST", `/rooms/${id}/messages`, { text: "hi" });
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const kinds = (await roomLog(cwd, id)).map((l) => l.update.sessionUpdate);
  const asked = kinds.indexOf("_client_user_message");
  assert.ok(asked >= 0);
  assert.ok(
    kinds.indexOf("_client_turn_ended") > asked,
    "the cancelled turn ended in the log",
  );

  const second = await again();
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(only(got.body).status, "paused");
});

test("kill -9 during a turn leaves the participant killed after the next boot, and a message revives it", async (t) => {
  const { first, cwd, id, again } = await roomToRestart(t, SLOW);
  const record = join(stateDirFor(cwd), "rooms", id, "room.json");
  await api(first, "POST", `/rooms/${id}/messages`, { text: "hi" });
  await until(
    "room.json shows the turn",
    async () =>
      JSON.parse(await readFile(record, "utf8")).participants[0]?.status ===
      "busy",
  );
  process.kill(first.pid, "SIGKILL");
  await first.done;
  const left = (await roomLog(cwd, id)).length;

  const second = await again();
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.body.status, "paused");
  assert.equal(only(got.body).status, "killed");
  assert.equal(
    (await roomLog(cwd, id)).length,
    left,
    "the boot adds no line to the log",
  );

  const revive = await api<RoomReply>(second, "POST", `/rooms/${id}/messages`, {
    text: "again",
  });
  assert.equal(revive.status, 202, revive.body.error?.message);
  const after = only(await roomIdle(second, id));
  assert.equal(after.status, "idle");
  assert.equal(after.resumed, "fresh");
  assert.deepEqual(answersIn(await roomLog(cwd, id)), ["previous: (none)"]);
});

test("a dismissed room comes back dismissed after a restart, and a message is refused", async (t) => {
  const { first, id, again } = await roomToRestart(t, REMEMBER);
  const gone = await api<RoomReply>(first, "POST", `/rooms/${id}/dismiss`);
  assert.equal(gone.status, 200);
  process.kill(first.pid, "SIGTERM");
  await first.done;

  const second = await again();
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.status, "dismissed");
  assert.equal(only(got.body).status, "dismissed");
  const late = await api<RoomReply>(second, "POST", `/rooms/${id}/messages`, {
    text: "hi",
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "room_dismissed");
  const twice = await api<RoomReply>(second, "POST", `/rooms/${id}/dismiss`);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error.code, "room_dismissed");
});

// The test drives the whole lazy-build flow end to end: its call count is the test.
// pi-lens-ignore: high-fan-out
test("a dismissed room the boot did not build lists and answers as before (#451)", async (t) => {
  const { first, id, again } = await roomToRestart(t, REMEMBER);
  await api(first, "POST", `/rooms/${id}/messages`, { text: "alpha" });
  await roomIdle(first, id);
  assert.equal((await api(first, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const listed = (await api<RoomListEntry[]>(first, "GET", "/rooms")).body;
  const shown = await api<RoomReply>(first, "GET", `/rooms/${id}`);
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await again();
  const list = await api<RoomListEntry[]>(second, "GET", "/rooms");
  assert.deepEqual(list.body, listed, "the same entry, from the record");
  // Two lookups at once share the build (`daemon/tests/rooms.test.ts`).
  const both = await Promise.all([
    api<RoomReply>(second, "GET", `/rooms/${id}`),
    api<RoomReply>(second, "GET", `/rooms/${id}`),
  ]);
  for (const got of both) {
    assert.equal(got.status, 200, got.body.error?.message);
    assert.deepEqual(got.body, shown.body);
  }
  // `/events` and `DELETE` as first lookups: the next test.
});

// Each first-use route needs its own room and the restart between them, so one
// test drives both.
// pi-lens-ignore: high-fan-out
test("a dismissed room's events and DELETE each build it on first use (#451)", async (t) => {
  const { first, cwd, id: replayId, again } = await roomToRestart(t, REMEMBER);
  const opened = await api<RoomReply>(
    first,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(opened.status, 201, opened.body.error?.message);
  const deleteId = opened.body.id;
  for (const id of [replayId, deleteId]) {
    assert.equal(
      (await api(first, "POST", `/rooms/${id}/dismiss`)).status,
      200,
    );
  }
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await again();
  const before = await api<RoomListEntry[]>(second, "GET", "/rooms");
  assert.deepEqual(
    before.body.map((r) => r.id).sort(),
    [replayId, deleteId].sort(),
    "both rooms are listed from their records before any build",
  );

  // Each call is its room's first lookup after the restart.
  const [stream, deleted] = await Promise.all([
    fetch(`${second.url}/rooms/${replayId}/events`, {
      headers: { authorization: `Bearer ${second.token}` },
    }),
    api(second, "DELETE", `/rooms/${deleteId}`),
  ]);
  assert.equal(
    `${stream.status}/${deleted.status}`,
    "200/204",
    "the events stream and DELETE each built their room",
  );
  const replay = await stream.text();
  const lines = await roomLog(cwd, replayId);
  assert.ok(lines.length > 0);
  assert.equal((replay.match(/^data: /gm) ?? []).length, lines.length);
  assert.equal(existsSync(join(stateDirFor(cwd), "rooms", deleteId)), false);
  const after = await api<RoomListEntry[]>(second, "GET", "/rooms");
  assert.deepEqual(
    after.body.map((r) => r.id),
    [replayId],
    "the deleted room is gone; the replayed one is still listed",
  );
});

test("a dismissed room that cannot be built is listed until its first use, then a 404 (#451)", async (t) => {
  const { first, cwd, id, again } = await roomToRestart(t, REMEMBER);
  assert.equal((await api(first, "POST", `/rooms/${id}/dismiss`)).status, 200);
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  // A cwd in another repository: the build refuses it, as a boot did.
  const path = join(stateDirFor(cwd), "rooms", id, "room.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    JSON.stringify({ ...record, cwd: await realpath(await gitRepo(t)) }),
  );

  const second = await again();
  const before = await api<RoomListEntry[]>(second, "GET", "/rooms");
  assert.deepEqual(
    before.body.map((r) => r.id),
    [id],
    "the boot did not build it, so it did not fail",
  );
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.status, 404);
  assert.equal(got.body.error.code, "room_not_found");
  const after = await api<RoomListEntry[]>(second, "GET", "/rooms");
  assert.deepEqual(after.body, []);
  process.kill(second.pid, "SIGTERM");
  const { stderr } = await second.done;
  const skipped = stderr
    .split("\n")
    .find(
      (line) =>
        line.startsWith("skipping room ") &&
        line.includes(id) &&
        line.includes("no longer inside"),
    );
  assert.ok(skipped, stderr);
});

// The test drives the restart, tombstone write, dirty refusal and delete: one flow.
// pi-lens-ignore: high-fan-out
test("a room with unknown saved agents restores, lists and deletes (#312)", async (t) => {
  const { first, cwd, id, alice, again } = await roomToRestart(t, REMEMBER);
  const lost = await addAgent(first, id, { cmd: REMEMBER, name: "lost" });
  assert.ok(alice.branch);
  assert.ok(lost.branch);
  const renamed = `kapelle-renamed-${lost.id}`;
  execFileSync("git", ["branch", "-m", renamed], { cwd: lost.worktree });
  const dirty = join(lost.worktree, "tombstone-dirty.txt");
  await writeFile(dirty, "keep me\n");

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const path = join(stateDirFor(cwd), "rooms", id, "room.json");
  const record = readRoomRecord(path);
  const savedAlice = record.participants.find((p) => p.id === alice.id);
  const savedLost = record.participants.find((p) => p.id === lost.id);
  assert.ok(savedAlice);
  assert.ok(savedLost);
  delete savedAlice.cmd;
  savedAlice.agent = "missing-harness";
  delete savedLost.cmd;
  savedLost.agent = "missing-harness";
  savedLost.branch = renamed;
  savedLost.branchRenamed = true;
  writeRoomRecord(path, record);

  const second = await again();
  const list = await api<RoomListEntry[]>(second, "GET", "/rooms");
  const entry = list.body.find((r) => r.id === id);
  assert.equal(entry?.status, "paused");
  assert.deepEqual(
    entry?.participants,
    [],
    "an empty room is still listed after both participants are tombstoned",
  );
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.participants, []);
  const stored = readRoomRecord(path);
  assert.deepEqual(
    stored.tombstones?.map((p) => p.id),
    [alice.id, lost.id],
    "both full participant records are kept as tombstones",
  );
  assert.equal(stored.tombstones?.[1]?.branch, renamed);
  assert.equal(stored.tombstones?.[1]?.branchRenamed, true);

  const refused = await api(second, "DELETE", `/rooms/${id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "uncommitted_work");
  assert.match(refused.body.error.message, /tombstone-dirty\.txt/);
  await rm(dirty);
  const deleted = await api(second, "DELETE", `/rooms/${id}`);
  assert.equal(deleted.status, 204);
  assert.equal(existsSync(lost.worktree), false, "the tombstone checkout goes");
  assert.equal(existsSync(alice.worktree), false, "the other checkout goes");
  assert.equal(hasBranch(cwd, renamed), false, "the renamed branch goes");
  assert.equal(hasBranch(cwd, alice.branch), false, "the room branch goes");

  process.kill(second.pid, "SIGTERM");
  const { stderr } = await second.done;
  const notices = stderr
    .split("\n")
    .filter(
      (line) =>
        line.includes(id) &&
        line.includes("missing-harness") &&
        line.includes(path),
    );
  assert.equal(notices.length, 2, stderr);
});

// The test drives the whole room-lifecycle flow: its call count is the test.
// pi-lens-ignore: high-fan-out
test("the delete preview lists every owned branch and the commits no outside ref reaches (#352)", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const dev = only(open.body);
  assert.ok(dev.branch);
  await commitAt(dev.worktree, "dev.txt");

  const bob = await addAgent(d, id, { cmd: REMEMBER, name: "bob" });
  assert.ok(bob.branch);
  await commitAt(bob.worktree, "bob.txt");
  const removed = await api<RoomReply>(
    d,
    "DELETE",
    `/rooms/${id}/agents/${bob.id}`,
  );
  assert.equal(removed.status, 200, removed.body.error?.message);

  const preview = await api<DeletePreview>(
    d,
    "GET",
    `/rooms/${id}/delete-preview`,
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const branch = (name: string) =>
    preview.body.branches.find((b) => b.branch === name);
  assert.equal(branch(dev.branch)?.participant, dev.name);
  assert.deepEqual(
    branch(dev.branch)?.commits.map((c) => c.subject),
    ["dev.txt"],
  );
  assert.equal(branch(bob.branch)?.participant, undefined);
  assert.deepEqual(
    branch(bob.branch)?.commits.map((c) => c.subject),
    ["bob.txt"],
  );

  // Once dev's branch is reachable from main, none of its commits would be
  // lost by removing the room's refs.
  const merged = spawnSync("git", ["merge", "--ff-only", dev.branch], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(merged.status, 0, merged.stderr);
  const after = await api<DeletePreview>(
    d,
    "GET",
    `/rooms/${id}/delete-preview`,
  );
  assert.deepEqual(
    after.body.branches.find((b) => b.branch === dev.branch)?.commits,
    [],
  );
  assert.deepEqual(
    after.body.branches
      .find((b) => b.branch === bob.branch)
      ?.commits.map((c) => c.subject),
    ["bob.txt"],
  );
  assert.equal((await api(d, "GET", "/rooms/nope/delete-preview")).status, 404);
});

test("the delete preview caps a long branch and reports its total", async (t) => {
  const d = await boot(t);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const p = only(open.body);
  for (let i = 0; i < 201; i++) {
    const made = spawnSync(
      "git",
      ["commit", "--allow-empty", "-qm", `preview commit ${i}`],
      { cwd: p.worktree, encoding: "utf8" },
    );
    assert.equal(made.status, 0, made.stderr);
  }

  const preview = await api<DeletePreview>(
    d,
    "GET",
    `/rooms/${open.body.id}/delete-preview`,
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const branch = preview.body.branches.find((b) => b.branch === p.branch);
  assert.equal(branch?.commits.length, 200);
  assert.equal(branch?.total, 201);
});

test("the delete preview accepts a renamed branch named like a tracked path (#352 review)", async (t) => {
  const d = await boot(t);
  const cwd = await added(
    d,
    await gitRepo(t, { files: { "docs/readme.md": "docs\n" } }),
  );
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario read-only`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const p = only(open.body);
  const renamed = spawnSync("git", ["branch", "-m", "docs"], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(renamed.status, 0, renamed.stderr);
  await commitAt(p.worktree, "agent.txt");
  const sent = await api(d, "POST", `/rooms/${id}/messages`, { text: "go" });
  assert.equal(sent.status, 202, sent.body.error?.message);
  await roomIdle(d, id);

  const preview = await api<DeletePreview>(
    d,
    "GET",
    `/rooms/${id}/delete-preview`,
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(
    preview.body.branches
      .find((b) => b.branch === "docs")
      ?.commits.map((c) => c.subject),
    ["agent.txt"],
  );
});

test("DELETE refuses an active room and uncommitted work, then removes a dismissed room whole (#235)", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const { worktree, branch } = only(open.body);
  const live = await api(d, "DELETE", `/rooms/${id}`);
  assert.equal(live.status, 409);
  assert.equal(live.body.error.code, "room_active");

  // A dismiss keeps a checkout with work in it, and so does a refused delete.
  await writeFile(join(worktree, "draft.txt"), "half a thought\n");
  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const dirty = await api(d, "DELETE", `/rooms/${id}`);
  assert.equal(dirty.status, 409);
  assert.equal(dirty.body.error.code, "uncommitted_work");
  assert.match(dirty.body.error.message, /draft\.txt/);
  assert.equal((await api(d, "GET", `/rooms/${id}`)).status, 200);
  assert.ok(existsSync(join(worktree, "draft.txt")), "nothing was removed");

  await rm(join(worktree, "draft.txt"));
  const deleted = await fetch(`${d.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");
  assert.equal(existsSync(worktree), false, "the checkout is gone");
  assert.equal(existsSync(join(stateDirFor(root), "rooms", id)), false);
  const ref = spawnSync(
    "git",
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    {
      cwd: root,
    },
  );
  assert.notEqual(ref.status, 0, "the branch is gone");
  assert.equal((await api(d, "GET", `/rooms/${id}`)).status, 404);
  const list = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.equal(
    list.body.some((r) => r.id === id),
    false,
  );
});

test("DELETE removes a branch the harness renamed into", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario read-only`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const p = only(open.body);
  const renamed = "renamed-topic";
  const rename = spawnSync("git", ["branch", "-m", renamed], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(rename.status, 0, rename.stderr);
  await commitAt(p.worktree, "agent.txt");
  const sent = await api(d, "POST", `/rooms/${id}/messages`, { text: "go" });
  assert.equal(sent.status, 202, sent.body.error?.message);
  await roomIdle(d, id);
  assert.equal(
    only((await api<RoomReply>(d, "GET", `/rooms/${id}`)).body).branch,
    renamed,
  );

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  assert.equal(hasBranch(root, renamed), true, "the committed branch stays");
  const deleted = await fetch(`${d.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(deleted.status, 204);
  assert.equal(
    hasBranch(root, renamed),
    false,
    "the renamed branch goes with the room",
  );
});

test("DELETE leaves a branch the harness switched to, not one it created", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario read-only`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const p = only(open.body);
  const original = p.branch as string;
  const foreign = "user-topic";
  const made = spawnSync("git", ["branch", foreign, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(made.status, 0, made.stderr);
  const switched = spawnSync("git", ["switch", "-q", foreign], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(
    (await api(d, "POST", `/rooms/${id}/messages`, { text: "go" })).status,
    202,
  );
  await roomIdle(d, id);
  assert.equal(
    only((await api<RoomReply>(d, "GET", `/rooms/${id}`)).body).branch,
    foreign,
  );

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const deleted = await fetch(`${d.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(deleted.status, 204);
  assert.equal(hasBranch(root, foreign), true, "the foreign branch is left");
  assert.equal(hasBranch(root, original), false, "the room's own branch goes");
});

test("DELETE keeps a foreign branch after the room's own ref is gone", async (t) => {
  const d = await boot(t);
  const root = await gitRepo(t);
  const cwd = await added(d, root);
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario read-only`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const p = only(open.body);
  const original = p.branch as string;
  // The harness renames the room's branch away, then switches to a branch
  // that already existed. The original ref is now gone; the foreign one is
  // still not the room's to delete.
  const away = "wip-away";
  const renamed = spawnSync("git", ["branch", "-m", away], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(renamed.status, 0, renamed.stderr);
  const foreign = "user-topic";
  const made = spawnSync("git", ["branch", foreign, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(made.status, 0, made.stderr);
  const switched = spawnSync("git", ["switch", "-q", foreign], {
    cwd: p.worktree,
    encoding: "utf8",
  });
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(
    (await api(d, "POST", `/rooms/${id}/messages`, { text: "go" })).status,
    202,
  );
  await roomIdle(d, id);
  assert.equal(
    only((await api<RoomReply>(d, "GET", `/rooms/${id}`)).body).branch,
    foreign,
  );

  assert.equal((await api(d, "POST", `/rooms/${id}/dismiss`)).status, 200);
  const deleted = await fetch(`${d.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(deleted.status, 204);
  assert.equal(
    hasBranch(root, foreign),
    true,
    "the pre-existing branch survives the room's gone ref",
  );
  assert.equal(hasBranch(root, original), false);
  assert.equal(
    hasBranch(root, away),
    true,
    "the name the room renamed through is left too",
  );
});

test("a paused room is deleted without a revive, and its open stream ends (#235)", async (t) => {
  const { first, cwd, id, alice, again } = await roomToRestart(t, REMEMBER);
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await again();
  const res = await fetch(`${second.url}/rooms/${id}/events`, {
    headers: { authorization: `Bearer ${second.token}` },
  });
  assert.equal(res.status, 200);
  const drained = res.text();
  const deleted = await api(second, "DELETE", `/rooms/${id}`);
  assert.equal(deleted.status, 204, deleted.body?.error?.message);
  await drained;
  assert.equal(existsSync(alice.worktree), false);
  assert.equal(existsSync(join(stateDirFor(cwd), "rooms", id)), false);
  assert.equal((await api(second, "GET", `/rooms/${id}`)).status, 404);
});

// The test drives the shutdown flow: its call count is the test.
// pi-lens-ignore: high-fan-out
test("a room opened while the daemon shuts down does not come back (#316)", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const cwd = await realpath(await added(first, await gitRepo(t)));

  // A harness that answers ACP after a delay, so the request is inside
  // `openRoom` when the signal lands. No other room holds the shutdown
  // open: it must wait for this request by itself.
  const slowInit = join(cwd, "slow-init.mjs");
  const pidFile = join(cwd, "slow-init.pid");
  await writeFile(
    slowInit,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `await new Promise((ok) => setTimeout(ok, 500));\n` +
      `await import(${JSON.stringify(MOCK_AGENT)});\n`,
  );
  const opening = fetch(`${first.url}/rooms`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${first.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(withAgent(cwd, `node ${slowInit}`)),
  });
  // The harness has started: past the `stopping` check, inside `openRoom`.
  for (const until = Date.now() + 5_000; !existsSync(pidFile); ) {
    if (Date.now() > until) {
      throw new Error("the opening request never reached openRoom");
    }
    await new Promise((ok) => setTimeout(ok, 10));
  }
  const harness = Number(await readFile(pidFile, "utf8"));
  process.kill(first.pid, "SIGTERM");

  const refused = await opening;
  assert.equal(refused.status, 503);
  assert.equal(
    ((await refused.json()) as RoomReply).error.code,
    "shutting_down",
  );
  assert.equal((await first.done).code, 0);
  assert.throws(
    () => process.kill(harness, 0),
    "the harness does not outlive the daemon",
  );

  // Nothing of it is left on disk: no record, no log, no stderr log.
  const roomsDir = join(stateDirFor(cwd), "rooms");
  assert.deepEqual(
    readdirSync(roomsDir),
    [],
    "the refused room's folder is gone",
  );

  const second = await boot(t, runtime, [], state);
  const list = await api<RoomListEntry[]>(second, "GET", "/rooms");
  assert.deepEqual(
    list.body,
    [],
    "the room the client never got must not come back",
  );
});

test("a shutdown still waits for a room create whose client has gone (#316)", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const cwd = await realpath(await added(first, await gitRepo(t)));

  // The same slow harness: the request is inside `openRoom` when its
  // client goes and the signal lands.
  const slowInit = join(cwd, "slow-init.mjs");
  const pidFile = join(cwd, "slow-init.pid");
  await writeFile(
    slowInit,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `await new Promise((ok) => setTimeout(ok, 500));\n` +
      `await import(${JSON.stringify(MOCK_AGENT)});\n`,
  );
  const gone = new AbortController();
  const opening = fetch(`${first.url}/rooms`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${first.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(withAgent(cwd, `node ${slowInit}`)),
    signal: gone.signal,
  });
  for (const until = Date.now() + 5_000; !existsSync(pidFile); ) {
    if (Date.now() > until) {
      throw new Error("the opening request never reached openRoom");
    }
    await new Promise((ok) => setTimeout(ok, 10));
  }
  const harness = Number(await readFile(pidFile, "utf8"));
  gone.abort();
  await assert.rejects(opening);
  process.kill(first.pid, "SIGTERM");

  assert.equal((await first.done).code, 0);
  assert.throws(
    () => process.kill(harness, 0),
    "the harness does not outlive the daemon",
  );
  assert.deepEqual(
    readdirSync(join(stateDirFor(cwd), "rooms")),
    [],
    "the room's folder is gone",
  );
});

test("a shutdown waits for a room delete in flight, which answers 204 (#316)", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  // A `git` that sleeps before each `worktree prune`, so the delete is
  // inside `removeRoom` when the signal lands.
  const bin = await tempDir(t);
  const marker = join(bin, "removing");
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\n` +
      `if [ "$1" = worktree ] && [ "$2" = prune ]; then\n` +
      `  : > ${JSON.stringify(marker)}; sleep 1\n` +
      `fi\n` +
      `exec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  const first = await boot(t, runtime, [], state, {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  });
  const cwd = await added(first, await gitRepo(t));
  const open = await api<RoomReply>(
    first,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const alice = open.body.participants[0] as ParticipantDto;
  // A commit keeps the checkout and its branch past the dismiss, so the
  // delete has both to remove.
  execFileSync("git", [
    "-C",
    alice.worktree as string,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--allow-empty",
    "-qm",
    "work",
  ]);
  assert.equal((await api(first, "POST", `/rooms/${id}/dismiss`)).status, 200);
  assert.equal(hasBranch(cwd, alice.branch as string), true);
  // The boot sweep prunes too; only the delete may set the marker now.
  await rm(marker, { force: true });

  const deleting = fetch(`${first.url}/rooms/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${first.token}` },
  });
  for (const until = Date.now() + 5_000; !existsSync(marker); ) {
    if (Date.now() > until) throw new Error("the delete never reached git");
    await new Promise((ok) => setTimeout(ok, 10));
  }
  process.kill(first.pid, "SIGTERM");

  assert.equal((await deleting).status, 204);
  assert.equal((await first.done).code, 0);
  assert.equal(existsSync(join(stateDirFor(cwd), "rooms", id)), false);
  // Before the next boot, whose sweep would remove a branch left behind.
  assert.equal(existsSync(alice.worktree as string), false);
  assert.equal(hasBranch(cwd, alice.branch as string), false);

  const second = await boot(t, runtime, [], state);
  assert.equal((await api(second, "GET", `/rooms/${id}`)).status, 404);
});

/** Starts a request now and sends its JSON body only after `later` ran, so
 *  the route reads it after whatever `later` did. */
async function bodyAfter(
  d: Daemon,
  method: string,
  path: string,
  body: unknown,
  later: () => Promise<void>,
): Promise<{ status: number; body: RoomReply }> {
  const text = JSON.stringify(body);
  const url = new URL(path, d.url);
  const reply = new Promise<{ status: number; body: RoomReply }>((ok, fail) => {
    const req = request(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${d.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () =>
          ok({ status: res.statusCode ?? 0, body: JSON.parse(data) }),
        );
      },
    );
    req.on("error", fail);
    req.flushHeaders();
    // The headers must be in before `later` runs: a shutdown refuses a new
    // connection, never one it already took.
    req.on("socket", (socket) =>
      socket.once("connect", () =>
        setTimeout(() => void later().then(() => req.end(text), fail), 50),
      ),
    );
  });
  return reply;
}

test("a shutdown answers PATCH, fast-forward and an install with 503, not room_dismissed", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // A deaf turn holds the shutdown open for its 2 s grace.
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, `node ${MOCK_AGENT} --scenario deaf`),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const { id } = open.body;
  const p = only(open.body).id;
  await api(d, "POST", `/rooms/${id}/messages`, { text: "busy" });

  const stop = async () => {
    process.kill(d.pid, "SIGTERM");
    await new Promise((ok) => setTimeout(ok, 300));
  };
  const later = () => new Promise<void>((ok) => setTimeout(ok, 300));
  const [patched, forwarded, installed] = await Promise.all([
    bodyAfter(d, "PATCH", `/rooms/${id}/agents/${p}`, { name: "x" }, stop),
    bodyAfter(
      d,
      "POST",
      `/rooms/${id}/agents/${p}/fast-forward`,
      { from: p },
      later,
    ),
    // M9-3b: refused before its find, so a stop probes no agent.
    bodyAfter(d, "POST", "/harnesses/install", { ids: ["claude"] }, later),
  ]);
  for (const r of [patched, forwarded, installed]) {
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error.code, "shutting_down");
  }
  assert.equal((await d.done).code, 0);
});

test("a restart opens a room without links when its linkPaths went bad (#274)", async (t) => {
  const { first, cwd, id, again } = await roomToRestart(t, REMEMBER);
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  await mkdir(join(cwd, ".kapelle"), { recursive: true });
  await writeFile(
    join(cwd, ".kapelle", "config.json"),
    JSON.stringify({ linkPaths: ["README.md"] }),
    { mode: 0o644 },
  );

  const second = await again();
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.status, 200, got.body.error?.message);
  assert.equal(got.body.status, "paused");
  const notices = got.body.participants
    .flatMap((p) => p.notices)
    .map((n) => n.text)
    .join("\n");
  assert.match(notices, /the room opened without its links/);
});

test("a restart checks each repository's links once, runs no git status for its rooms, and keeps their links (#322)", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const cwd = await realpath(
    await added(
      first,
      await gitRepo(t, {
        ignore: "node_modules/\n",
        files: {
          ".kapelle/config.json": `${JSON.stringify({ linkPaths: ["node_modules"] })}\n`,
        },
      }),
    ),
  );
  await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const open = await api<RoomReply>(first, "POST", "/rooms", { cwd });
    assert.equal(open.status, 201, open.body.error?.message);
    ids.push(open.body.id);
  }
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const git = await countedGit(t);
  const second = await boot(t, runtime, [], state, { PATH: git.path });
  const calls = (await git.calls()).map((c) => c.split(" "));
  const list = await api<RoomListEntry[]>(second, "GET", "/rooms");
  assert.deepEqual(
    list.body.filter((r) => ids.includes(r.id)).map((r) => r.status),
    ["paused", "paused", "paused"],
  );
  assert.equal(
    calls.filter((c) => c.includes("status")).length,
    0,
    "a room never reads the dirty-tree advisory",
  );
  assert.equal(
    calls.filter((c) => c.includes("ls-files")).length,
    1,
    "one link plan for the repository, not two per room",
  );

  // A restored room still mirrors the links into a new checkout.
  const bob = await addAgent(second, ids[0] as string, {
    cmd: REMEMBER,
    name: "bob",
  });
  assert.equal(
    (await lstat(join(bob.worktree, "node_modules", "pkg"))).isSymbolicLink(),
    true,
  );
});

test("a restart gives every room the bad-links notice and logs once per repository (#322)", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const roots = [
    await realpath(await added(first, await gitRepo(t))),
    await realpath(await added(first, await gitRepo(t))),
  ] as const;
  const ids: string[] = [];
  for (const cwd of [roots[0], roots[0], roots[1]]) {
    const open = await api<RoomReply>(
      first,
      "POST",
      "/rooms",
      withAgent(cwd, REMEMBER),
    );
    assert.equal(open.status, 201, open.body.error?.message);
    ids.push(open.body.id);
  }
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  for (const cwd of roots) {
    await mkdir(join(cwd, ".kapelle"), { recursive: true });
    await writeFile(
      join(cwd, ".kapelle", "config.json"),
      JSON.stringify({ linkPaths: ["README.md"] }),
      { mode: 0o644 },
    );
  }
  const second = await boot(t, runtime, [], state);
  for (const id of ids) {
    const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
    assert.equal(got.status, 200, got.body.error?.message);
    assert.equal(only(got.body).status, "paused");
    assert.ok(
      only(got.body).notices.some((n) =>
        /the room opened without its links/.test(n.text),
      ),
      JSON.stringify(only(got.body).notices),
    );
  }

  process.kill(second.pid, "SIGTERM");
  const { stderr } = await second.done;
  assert.equal(
    stderr
      .split("\n")
      .filter((line) =>
        /opening without linked paths|the room opened without its links/.test(
          line,
        ),
      ).length,
    2,
    stderr,
  );
});

test("POST /rooms checks links once and reads no dirty advisory (#322)", async (t) => {
  const git = await countedGit(t);
  const d = await boot(t, undefined, [], undefined, { PATH: git.path });
  const cwd = await added(d, await gitRepo(t));
  await mkdir(join(cwd, ".kapelle"), { recursive: true });
  await writeFile(
    join(cwd, ".kapelle", "config.json"),
    JSON.stringify({ linkPaths: ["not-installed"] }),
    { mode: 0o644 },
  );
  const before = (await git.calls()).length;
  const open = await api<RoomReply>(d, "POST", "/rooms", { cwd });
  assert.equal(open.status, 201, open.body.error?.message);
  const calls = (await git.calls()).slice(before).map((c) => c.split(" "));
  assert.equal(
    calls.filter((c) => c.includes("status")).length,
    0,
    "a room never reads the dirty-tree advisory",
  );
  assert.equal(
    calls.filter((c) => c.includes("ls-files")).length,
    1,
    "the caller checks the links and the preflight does not plan them again",
  );
  assert.equal(
    (await api(d, "POST", `/rooms/${open.body.id}/dismiss`)).status,
    200,
  );
});

test("a boot reads each repository's limits once and shares them with its rooms (#322)", async (t) => {
  const runtime = await tempDir(t);
  const state = await tempDir(t);
  const first = await boot(t, runtime, [], state);
  const cwd = await realpath(await added(first, await gitRepo(t)));
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const open = await api<RoomReply>(first, "POST", "/rooms", { cwd });
    assert.equal(open.status, 201, open.body.error?.message);
    ids.push(open.body.id);
  }
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // Old records without a cap take this boot's configured one. Remove the
  // cap openRoom saved, so the restored rooms show which preflight they used.
  for (const id of ids) {
    const file = join(stateDirFor(cwd), "rooms", id, "room.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    delete record.turnCap;
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  const config = join(cwd, ".kapelle", "config.json");
  await mkdir(join(cwd, ".kapelle"), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({ orchestratorTurnCap: 11, linkPaths: ["not-installed"] }),
    { mode: 0o644 },
  );

  // Hold the first room's checkout preflight after its config was read. The
  // next room must reuse that preflight: reading the changed config would
  // reject stallIdleMs -1 and lose the shared turn cap 11 for the default.
  const bin = await tempDir(t);
  const linked = join(bin, "links-checked");
  const entered = join(bin, "entered");
  const release = join(bin, "release");
  const found = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(found.status, 0, found.stderr);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\n` +
      `if [ "$1" = "--literal-pathspecs" ] && [ "$2" = "ls-files" ]; then\n` +
      `  : > ${JSON.stringify(linked)}\n` +
      `fi\n` +
      `if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && ` +
      `[ -e ${JSON.stringify(linked)} ] && [ ! -e ${JSON.stringify(release)} ]; then\n` +
      `  : > ${JSON.stringify(entered)}\n` +
      `  while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.05; done\n` +
      `fi\n` +
      `exec ${JSON.stringify(found.stdout.trim())} "$@"\n`,
    { mode: 0o755 },
  );
  const booting = boot(t, runtime, [], state, {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  });
  // Registered after the daemon's own cleanup, so a failed wait frees the
  // wrapper before spawnCli's teardown has to kill anything.
  t.after(async () => {
    try {
      await writeFile(release, "");
    } catch {
      // The wrapper folder is still ours; this only releases a failed test.
    }
  });
  await until("the first room's config read", () => existsSync(entered));
  await writeFile(
    config,
    JSON.stringify({
      orchestratorTurnCap: 12,
      stallIdleMs: -1,
      linkPaths: ["not-installed"],
    }),
    { mode: 0o644 },
  );
  await writeFile(release, "");
  const second = await booting;

  const caps = [];
  for (const id of ids) {
    const file = join(stateDirFor(cwd), "rooms", id, "room.json");
    caps.push(JSON.parse(await readFile(file, "utf8")).turnCap);
  }
  assert.deepEqual(caps, [11, 11], "both rooms used the boot's one preflight");
  process.kill(second.pid, "SIGTERM");
  const { code, stderr } = await second.done;
  assert.equal(code, 0);
  assert.doesNotMatch(
    stderr,
    /using the default room limits/,
    "the second room read the changed config instead of the boot's limits",
  );
});

test("a dismissed room built after a restart checks links then, not at boot (#322)", async (t) => {
  const { first, cwd, id, again } = await roomToRestart(t, REMEMBER);
  assert.equal((await api(first, "POST", `/rooms/${id}/dismiss`)).status, 200);
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  const second = await again();
  // Written after boot: a dismissed room was only read, so this check must
  // happen when its first use builds it.
  await mkdir(join(cwd, ".kapelle"), { recursive: true });
  await writeFile(
    join(cwd, ".kapelle", "config.json"),
    JSON.stringify({ linkPaths: ["README.md"] }),
    { mode: 0o644 },
  );
  const before = await api<RoomListEntry[]>(second, "GET", "/rooms");
  assert.deepEqual(
    before.body.map((r) => r.id),
    [id],
    "the list reads the record without building the room",
  );
  const got = await api<RoomReply>(second, "GET", `/rooms/${id}`);
  assert.equal(got.status, 200, got.body.error?.message);
  assert.ok(
    only(got.body).notices.some((n) =>
      /the room opened without its links/.test(n.text),
    ),
    JSON.stringify(only(got.body).notices),
  );

  process.kill(second.pid, "SIGTERM");
  const { stderr } = await second.done;
  assert.equal(
    stderr
      .split("\n")
      .filter((line) =>
        /opening without linked paths|the room opened without its links/.test(
          line,
        ),
      ).length,
    1,
    stderr,
  );
});

test("a linkPaths entry git would see refuses a room's open as a 400", async (t) => {
  const d = await boot(t);
  const root = await added(
    d,
    await gitRepo(t, {
      files: {
        ".kapelle/config.json": `${JSON.stringify({ linkPaths: ["vendor.txt"] })}\n`,
      },
    }),
  );
  // Untracked and not ignored, so the link would dirty the checkout.
  await writeFile(join(root, "vendor.txt"), "vendor\n");

  const refused = await api(d, "POST", "/rooms", {
    cwd: root,
    agents: [{ cmd: `node ${MOCK_AGENT}`, name: "alice" }],
  });
  assert.equal(refused.status, 400, refused.body.error?.message);
  assert.equal(refused.body.error.code, "invalid_config");
  assert.match(refused.body.error.message, /is not ignored in a new checkout/);
});
