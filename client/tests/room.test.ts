/**
 * Room reducer tests — story M6-10 (#180).
 *
 * The stream is recorded, not written by hand: a real room (`core/room.ts`)
 * with three mock participants runs once, and its `events.jsonl` is what the
 * reducer reads. alice queues and answers three messages, bob asks a
 * permission question under `ask` that is answered, then is renamed and
 * removed, and carol stalls until her turn is cancelled. Live, replay,
 * reconnect and a cut turn all read that one recording. The restart case
 * (`paused`, `killed`) is M6-7a's (#151).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { createEventBus } from "../../core/events.ts";
import { newRoomId } from "../../core/ids.ts";
import { createPermissionQueue } from "../../core/permissions.ts";
import { openRoom, type Participant, roomAgent } from "../../core/room.ts";
import { stateDirFor } from "../../core/runtime.ts";
import { openWorktrees } from "../../core/worktree.ts";
import {
  gitRepo,
  isolateStateHome,
  MOCK_AGENT,
} from "../../integration/helpers.ts";
import type { RoomEventLine } from "../contract.ts";
import {
  applyLine,
  type Entry,
  needsAttention,
  newRoomState,
  type RoomState,
  roster,
  seen,
  thread,
} from "../room.ts";

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
    agents: [agent("alice", "remember")],
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

  const carol = await room.add(agent("carol", "stall"));
  const warned = new Promise<void>((ok) => {
    stalled = ok;
  });
  const hang = carol.send("hang");
  await warned;
  carol.cancel();
  await hang;

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
  assert.equal(b.role, "tester");
  assert.equal(b.mode, "ask");
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
  assert.ok(thread(state, carol).some((e) => e.type === "stall"));
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
      checked.add("stall");
    }
    if (u.sessionUpdate === "agent_message_chunk") {
      assert.equal(changed?.type, "answer");
    }
  }
  assert.deepEqual([...checked].sort(), [
    "answer",
    "question",
    "queue",
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
