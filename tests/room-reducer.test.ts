/**
 * Room reducer tests — story M6-10 (#180).
 *
 * The stream is recorded, not written by hand: a real room (`core/room.ts`)
 * with three mock participants runs once, and its `events.jsonl` is what the
 * reducer reads. alice queues and answers three messages, each in two
 * chunks. bob asks a permission question under `ask` that is answered. Then
 * he is renamed, his role is set then cleared, his mode changes, and he is
 * removed. carol stalls until her turn is cancelled. Live, replay, reconnect
 * and a cut turn all read that one recording. The restart case (M6-7a, #151)
 * reads it too, cut where a crash would cut it, with the `paused` or
 * `killed` that `GET /rooms/:id` gives; a second recording has a revive.
 *
 * Here and not in `client/tests/`: recording needs `core/`, and a suite in
 * `client/` imports only `client/`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { RoomDto, RoomEventLine } from "../client/contract.ts";
import {
  applyLine,
  applyStatus,
  type Entry,
  needsAttention,
  newRoomState,
  printable,
  type RoomState,
  roster,
  seen,
  thread,
} from "../client/room.ts";
import { createEventBus } from "../core/events.ts";
import { newRoomId } from "../core/ids.ts";
import { createPermissionQueue } from "../core/permissions.ts";
import { openRoom, type Participant, roomAgent } from "../core/room.ts";
import { stateDirFor } from "../core/runtime.ts";
import { openWorktrees } from "../core/worktree.ts";
import {
  gitRepo,
  isolateStateHome,
  MOCK_AGENT,
} from "../integration/helpers.ts";

isolateStateHome();

interface Recording {
  lines: RoomEventLine[];
  alice: string;
  bob: string;
  carol: string;
}

async function record(t: TestContext): Promise<Recording> {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const bus = createEventBus();
  const queue = createPermissionQueue(60_000);
  let stalled = () => {};
  bus.addListener(({ update }) => {
    // Answered off the emit, as a client's `POST` would be.
    if (update.sessionUpdate === "_client_permission_queued") {
      setImmediate(() => queue.answer(update.id, true));
    }
    if (update.sessionUpdate === "_client_stall_warning") stalled();
  });
  const agent = (name: string, scenario?: string, mode?: string) =>
    roomAgent({
      cmd: `node ${MOCK_AGENT}${scenario ? ` --scenario ${scenario}` : ""}`,
      name,
      ...(mode && { mode }),
    });
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [agent("alice", "split")],
    setup: await openWorktrees(repo, roomId),
    bus,
    permissions: queue,
    limits: { stallIdleMs: 300, stallRepeatCount: 1000 },
  });
  const alice = room.participants[0] as Participant;
  await Promise.all(["a", "b", "c"].map((text) => alice.send(text)));

  const bob = await room.add(agent("bob", undefined, "ask"));
  await bob.send("write it");
  room.update(bob.id, { name: "robert", role: "tester" });
  room.update(bob.id, { mode: "safe", role: null });

  const carol = await room.add(agent("carol", "stall"));
  const warned = new Promise<void>((ok) => {
    stalled = ok;
  });
  const hang = carol.send("hang");
  const also = carol.send("also");
  await warned;
  carol.cancel();
  await hang;
  // The cancel drops the queued message; its send resolves on the clear.
  await also;

  await room.remove(bob.id);
  await room.dismiss();
  const log = join(stateDirFor(repo), "rooms", roomId, "events.jsonl");
  const lines = (await readFile(log, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RoomEventLine);
  return { lines, alice: alice.id, bob: bob.id, carol: carol.id };
}

// One recording for the file: it starts three harnesses.
let recording: Promise<Recording> | undefined;
const recorded = (t: TestContext) => {
  recording ??= record(t);
  return recording;
};

const replay = (lines: RoomEventLine[], state = newRoomState()) => {
  for (const line of lines) applyLine(state, line);
  return state;
};

const texts = (entries: Entry[], type: Entry["type"]) =>
  entries
    .filter((e) => e.type === type)
    .map((e) => ("text" in e ? e.text : e.type));

const who = (state: RoomState, id: string) => {
  const p = state.participants.get(id);
  assert.ok(p, `participant ${id} is on the roster`);
  return p;
};

test("replay: the whole history gives the roster, threads, turns and questions", async (t) => {
  const { lines, alice, bob, carol } = await recorded(t);
  const state = replay(lines);

  assert.equal(state.seq, lines.at(-1)?.seq);
  assert.deepEqual(
    roster(state).map((p) => p.name),
    ["alice", "carol"],
    "bob left; his old lines keep his last name",
  );
  const b = who(state, bob);
  assert.equal(b.name, "robert");
  assert.equal(b.role, undefined, "a null role cleared it");
  assert.equal(b.mode, "safe");
  assert.equal(b.removed, true);

  const a = who(state, alice);
  assert.deepEqual(
    a.turns.map(({ number, text, state }) => ({ number, text, state })),
    [
      { number: 1, text: "a", state: "ended" },
      { number: 2, text: "b", state: "ended" },
      { number: 3, text: "c", state: "ended" },
    ],
  );
  // The dismiss stopped her harness, and the log says so before it closes.
  assert.equal(a.status, "exited");
  assert.deepEqual(a.queue, []);
  const aliceThread = thread(state, alice);
  assert.ok(aliceThread.every((e) => e.participantId === alice));
  assert.deepEqual(texts(aliceThread, "queued"), ["b", "c"]);
  assert.deepEqual(texts(aliceThread, "answer"), [
    "previous: (none)",
    "previous: a",
    "previous: b",
  ]);

  // The mock's default turn asks more than once; each got its answer in place.
  const questions = thread(state, bob).filter((e) => e.type === "permission");
  assert.ok(questions.length > 0);
  for (const q of questions) {
    assert.deepEqual(q.type === "permission" && [q.allow, q.reason, q.turn], [
      true,
      "client",
      1,
    ]);
  }
  assert.equal(state.questions.size, 0, "no question is still open");

  const c = who(state, carol);
  assert.equal(c.turns[0]?.state, "ended");
  assert.equal(c.turns[0]?.stopReason, "cancelled");
  assert.deepEqual(c.queue, [], "the clear dropped the queued message");
  const carolThread = thread(state, carol);
  assert.deepEqual(texts(carolThread, "queued"), ["also"]);
  assert.deepEqual(
    carolThread
      .filter((e) => e.type === "queue_cleared")
      .map((e) => (e.type === "queue_cleared" ? e.count : 0)),
    [1],
    "the clear is on the timeline with its count",
  );
  assert.ok(carolThread.some((e) => e.type === "stall"));
  for (const id of [alice, bob, carol]) {
    assert.equal(needsAttention(state, id), false, id);
  }
});

test("live: the state is right at each line, not only at the end", async (t) => {
  const { lines, alice, bob, carol } = await recorded(t);
  const state = newRoomState();
  const checked = new Set<string>();
  for (const line of lines) {
    const changed = applyLine(state, line);
    const u = line.update;
    if (
      u.sessionUpdate === "_client_message_queued" &&
      line.participantId === alice &&
      u.text === "c"
    ) {
      const a = who(state, alice);
      assert.equal(a.status, "busy");
      assert.deepEqual(a.queue, ["b", "c"]);
      checked.add("queue");
    }
    if (u.sessionUpdate === "_client_permission_queued") {
      assert.equal(needsAttention(state, bob), true);
      seen(state, bob);
      assert.equal(
        needsAttention(state, bob),
        true,
        "only the answer clears it",
      );
      checked.add("question");
    }
    if (u.sessionUpdate === "_client_permission_answered") {
      assert.equal(changed?.type, "permission", "the question is redrawn");
      assert.equal(needsAttention(state, bob), false);
      checked.add("answer");
    }
    if (u.sessionUpdate === "_client_stall_warning") {
      assert.equal(needsAttention(state, carol), true);
      seen(state, carol);
      assert.equal(needsAttention(state, carol), false, "seen clears a stall");
      checked.add("stall");
    }
    if (u.sessionUpdate === "_client_queue_cleared") {
      assert.equal(changed?.type, "queue_cleared");
      assert.deepEqual(who(state, carol).queue, []);
      checked.add("clear");
    }
    if (u.sessionUpdate === "_client_participant_changed" && u.role) {
      assert.equal(who(state, bob).role, "tester");
      checked.add("role");
    }
    if (u.sessionUpdate === "agent_message_chunk") {
      assert.equal(changed?.type, "answer");
    }
  }
  assert.deepEqual([...checked].sort(), [
    "answer",
    "clear",
    "question",
    "queue",
    "role",
    "stall",
  ]);
});

test("reconnect: lines sent again change nothing", async (t) => {
  const { lines } = await recorded(t);
  const half = Math.floor(lines.length / 2);
  const state = replay(lines.slice(0, half));
  // The reader resumes from a `seq` it had already passed.
  for (const line of lines.slice(half - 5, half)) {
    assert.equal(applyLine(state, line), undefined, `seq ${line.seq}`);
  }
  replay(lines.slice(half - 5), state);
  assert.deepEqual(state, replay(lines));
});

test("a cut turn: a user message with no turn end, then the next turn starts", async (t) => {
  const { lines, alice } = await recorded(t);
  // As a crash leaves it: alice's first turn never ended.
  const first = lines.findIndex(
    (l) =>
      l.participantId === alice &&
      l.update.sessionUpdate === "_client_turn_ended",
  );
  const state = replay(lines.filter((_, i) => i !== first));
  assert.deepEqual(
    who(state, alice).turns.map((turn) => turn.state),
    ["cut", "ended", "ended"],
  );

  // A stream that stops mid-turn leaves the turn open, not cut: the next
  // line may still come.
  const open = replay(lines.slice(0, first));
  assert.deepEqual(
    who(open, alice).turns.map((turn) => turn.state),
    ["open"],
  );
  assert.equal(who(open, alice).status, "busy");
});

test("unread counts what the participants said, and seen clears it", async (t) => {
  const { lines, alice } = await recorded(t);
  const state = replay(lines);
  const a = who(state, alice);
  // Three answers, three turn ends and the exit at dismiss; the person's own
  // lines do not count.
  assert.equal(a.unread, 7);
  seen(state, alice);
  assert.equal(a.unread, 0);
});

test("a harness that exits mid-turn reads killed, and stays so when the turn ends", async (t) => {
  const { lines, carol } = await recorded(t);
  const of = (kind: string) =>
    lines.findIndex(
      (l) => l.participantId === carol && l.update.sessionUpdate === kind,
    );
  // Its exit moved before its turn end, as a crash writes them.
  const exit = lines[of("_client_harness_exited")] as RoomEventLine;
  const end = of("_client_turn_ended");
  const crashed = [
    ...lines.slice(0, end).filter((l) => l !== exit),
    exit,
    ...lines.slice(end).filter((l) => l !== exit),
  ].map((line, i) => ({ ...line, seq: i + 1 }));
  const state = newRoomState();
  for (const line of crashed.slice(0, end + 2)) applyLine(state, line);
  assert.equal(who(state, carol).turns[0]?.state, "ended");
  assert.equal(who(state, carol).status, "killed", "R46: stopped mid-turn");
});

test("a turn that ends with an error keeps the error on the turn and the entry", () => {
  const update = (
    seq: number,
    value: RoomEventLine["update"],
  ): RoomEventLine => ({
    seq,
    at: "2026-09-29T00:00:00Z",
    roomId: "room",
    participantId: "alice",
    update: value,
  });
  const state = replay([
    update(1, {
      sessionUpdate: "_client_participant_added",
      name: "alice",
      harness: "mock-agent",
      mode: "auto",
    }),
    update(2, {
      sessionUpdate: "_client_user_message",
      text: "a",
      turn: 1,
    }),
    update(3, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "half" },
    }),
    update(4, { sessionUpdate: "_client_harness_exited", pid: 123 }),
    update(5, {
      sessionUpdate: "_client_turn_ended",
      error: "the harness died",
    }),
  ]);

  const turn = who(state, "alice").turns[0];
  assert.equal(turn?.state, "ended", "the failed turn is still ended");
  assert.equal(turn?.error, "the harness died", "the turn keeps the error");
  const ended = state.timeline.at(-1);
  assert.equal(ended?.type, "turn_ended");
  assert.equal(
    ended?.type === "turn_ended" ? ended.error : undefined,
    "the harness died",
    "the timeline entry keeps the error",
  );
  assert.equal(who(state, "alice").status, "killed", "it died mid-turn");
});

test("a turn keeps its stall warning after seen, for the bell; the next turn starts without one", () => {
  const update = (
    seq: number,
    value: RoomEventLine["update"],
  ): RoomEventLine => ({
    seq,
    at: "2026-10-05T00:00:00Z",
    roomId: "room",
    participantId: "alice",
    update: value,
  });
  const state = replay([
    update(1, {
      sessionUpdate: "_client_participant_added",
      name: "alice",
      harness: "mock-agent",
      mode: "auto",
    }),
    update(2, { sessionUpdate: "_client_user_message", text: "a", turn: 1 }),
    update(3, {
      sessionUpdate: "_client_stall_warning",
      kind: "idle",
      text: "no activity for 5s",
    }),
  ]);
  seen(state, "alice");
  assert.equal(who(state, "alice").stalled, false, "seen clears the mark");
  assert.equal(who(state, "alice").turns[0]?.stall, "no activity for 5s");
  replay(
    [update(4, { sessionUpdate: "_client_user_message", text: "b", turn: 2 })],
    state,
  );
  assert.equal(who(state, "alice").turns[1]?.stall, undefined);
});

test("a question's title and input lose their control characters", () => {
  const state = newRoomState();
  const e = applyLine(state, {
    seq: 1,
    roomId: "r",
    participantId: "p",
    at: "2026-10-01T00:00:00.000Z",
    update: {
      sessionUpdate: "_client_permission_queued",
      id: "q",
      kind: "execute",
      title: "rm\x1b[2J -rf\n/",
      input: { "cmd\x07": "a\x1b]0;owned\x07b\u009bc" },
    },
  });
  assert.equal(e?.type, "permission");
  assert.deepEqual(e?.type === "permission" && [e.title, e.input], [
    "rm [2J -rf /",
    { "cmd ": "a ]0;owned b c" },
  ]);
  assert.equal(printable("tab\there"), "tab here");
  // Bidi, zero-width and line-separator characters change what a person
  // reads, not what runs: a right-to-left override can flip a command.
  assert.equal(
    printable("rm\u202e -rf\u2066x\u2069\u200b\ufeff\u2028\u061cy"),
    "rm  -rf x     y",
  );
  // The soft hyphen and the Tags block draw as nothing: a common way to
  // hide text in a string.
  assert.equal(printable("a\u00adb\u{e0041}\u{e0001}c"), "a b  c");
});

test("a question's diff keeps its lines and its counts, and loses its control characters", () => {
  const state = newRoomState();
  const e = applyLine(state, {
    seq: 1,
    roomId: "r",
    participantId: "p",
    at: "2026-10-05T00:00:00.000Z",
    update: {
      sessionUpdate: "_client_permission_queued",
      id: "q",
      kind: "edit",
      title: "Write x",
      diff: {
        text: "diff --git a/x b/x\n@@ -1 +1 @@\n-\tone\x1b[2J\n+two\u202e",
        files: 1,
        added: 1,
        removed: 1,
      },
    },
  });
  assert.deepEqual(e?.type === "permission" && e.diff, {
    text: "diff --git a/x b/x\n@@ -1 +1 @@\n-    one [2J\n+two ",
    files: 1,
    added: 1,
    removed: 1,
  });
});

test("a fast-forward becomes a timeline entry for a second client", () => {
  const state = newRoomState();
  const e = applyLine(state, {
    seq: 1,
    roomId: "r",
    participantId: "p-dev",
    at: "2026-10-07T00:00:00.000Z",
    update: {
      sessionUpdate: "_client_participant_fast_forwarded",
      from: "p-rev",
      branch: "kapelle/r/p-dev",
      sha: "abc123",
    },
  });
  assert.deepEqual(e, {
    seq: 1,
    participantId: "p-dev",
    type: "forward",
    from: "p-rev",
    branch: "kapelle/r/p-dev",
    sha: "abc123",
  });
  assert.deepEqual(state.timeline, [e]);
});

// --- after a restart (M6-7a, #151) ------------------------------------------

/** What `GET /rooms/:id` answers after a restart, as far as `applyStatus`
 *  reads it: each participant's status. */
const reply = (statuses: Record<string, string>) =>
  ({
    participants: Object.entries(statuses).map(([id, status]) => ({
      id,
      status,
    })),
  }) as unknown as RoomDto;

test("after a crash: GET's killed and paused hold, and the turn the crash cut reads cut, in either order", async (t) => {
  const { lines, alice, carol } = await recorded(t);
  // As a `kill -9` leaves the log: carol's turn started and never ended.
  const end = lines.findIndex(
    (l) =>
      l.participantId === carol &&
      l.update.sessionUpdate === "_client_turn_ended",
  );
  const log = lines.slice(0, end);
  const got = reply({ [alice]: "paused", [carol]: "killed" });

  const after = replay(log);
  applyStatus(after, got);
  const before = newRoomState();
  // The reply first: a screen can read the room before the replay is in.
  applyStatus(before, got);
  replay(log, before);
  applyStatus(before, got);

  for (const state of [after, before]) {
    assert.equal(who(state, carol).status, "killed");
    assert.deepEqual(
      who(state, carol).turns.map((turn) => turn.state),
      ["cut"],
    );
    assert.equal(who(state, alice).status, "paused");
    assert.deepEqual(
      who(state, alice).turns.map((turn) => turn.state),
      ["ended", "ended", "ended"],
      "a turn that ended is not cut",
    );
  }
});

test("after a shutdown: a turn the log ended is ended, whatever GET came first", async (t) => {
  const { lines, carol } = await recorded(t);
  // The cancel's end is on the log, as a shutdown leaves it.
  const end = lines.findIndex(
    (l) =>
      l.participantId === carol &&
      l.update.sessionUpdate === "_client_turn_ended",
  );
  const log = lines.slice(0, end + 1);
  const state = newRoomState();
  replay(log.slice(0, end), state);
  // GET answered while carol's turn was still open in the replay.
  applyStatus(state, reply({ [carol]: "paused" }));
  replay(log.slice(end), state);
  const c = who(state, carol);
  assert.equal(c.status, "paused");
  assert.equal(c.turns[0]?.state, "ended");
  assert.equal(c.turns[0]?.stopReason, "cancelled");
});

/** A room whose harness is killed during a turn, then revived by the next
 *  message, as `core/room.ts` writes it. */
async function recordRevive(t: TestContext) {
  const repo = await gitRepo(t);
  const roomId = newRoomId();
  const room = await openRoom({
    roomId,
    cwd: repo,
    agents: [
      roomAgent({ cmd: `node ${MOCK_AGENT} --scenario slow`, name: "dora" }),
    ],
    setup: await openWorktrees(repo, roomId),
    bus: createEventBus(),
    permissions: createPermissionQueue(60_000),
  });
  t.after(() => room.dismiss());
  const dora = room.participants[0] as Participant;
  const log = join(stateDirFor(repo), "rooms", roomId, "events.jsonl");
  const read = async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RoomEventLine);
  const first = dora.send("one");
  for (const until = Date.now() + 5_000; ; ) {
    const spawned = (await read()).find(
      (l) => l.update.sessionUpdate === "_client_harness_spawned",
    );
    if (spawned) {
      process.kill((spawned.update as { pid: number }).pid, "SIGKILL");
      break;
    }
    if (Date.now() > until) throw new Error("no harness spawned");
    await new Promise((ok) => setTimeout(ok, 20));
  }
  await first;
  await dora.send("two");
  await room.dismiss();
  return { lines: await read(), dora: dora.id };
}

test("a revive is a timeline entry, clears GET's status and leaves the participant idle", async (t) => {
  const { lines, dora } = await recordRevive(t);
  const revived = lines.findIndex(
    (l) => l.update.sessionUpdate === "_client_participant_revived",
  );
  assert.ok(revived > 0, "the recording has a revive");

  // Live: the harness died mid-turn, then the next message revived it.
  const live = replay(lines.slice(0, revived + 1));
  const entries = thread(live, dora);
  assert.equal(entries.at(-1)?.type, "revived");
  assert.equal(who(live, dora).status, "busy", "the reviving turn is live");

  // After a restart, GET said killed before the revive's lines arrived.
  const state = newRoomState();
  replay(lines.slice(0, revived - 2), state);
  applyStatus(state, reply({ [dora]: "killed" }));
  assert.equal(who(state, dora).status, "killed");
  replay(lines.slice(revived - 2, revived + 1), state);
  assert.equal(who(state, dora).reported, undefined, "the revive clears it");
  assert.equal(who(state, dora).status, "busy");
  assert.equal(who(state, dora).turns.at(-1)?.state, "open");
  const end = lines.findIndex(
    (l, i) => i > revived && l.update.sessionUpdate === "_client_turn_ended",
  );
  replay(lines.slice(revived + 1, end + 1), state);
  assert.equal(who(state, dora).status, "idle");
  assert.equal(who(state, dora).turns.at(-1)?.state, "ended");
});
