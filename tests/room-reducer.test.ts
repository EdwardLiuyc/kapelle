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
  cleanLines,
  commandLines,
  type Entry,
  fromPerson,
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

// It drives one whole room: its call count is the recording.
// pi-lens-ignore: high-fan-out
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

/** Lines by hand for the stall tests (#348): `line(who, update)` gives each
 *  the next `seq`. alice and bob are on the roster, each in a turn. */
const stallRoom = () => {
  const state = newRoomState();
  let seq = 0;
  const line = (participantId: string, update: RoomEventLine["update"]) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-25T00:00:00Z",
      roomId: "room",
      participantId,
      update,
    });
  for (const name of ["alice", "bob"]) {
    line(name, {
      sessionUpdate: "_client_participant_added",
      name,
      harness: "mock-agent",
      mode: "auto",
    });
    line(name, { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  }
  const warn = (participantId: string, kind: "idle" | "repeat") =>
    line(participantId, {
      sessionUpdate: "_client_stall_warning",
      kind,
      text: kind === "idle" ? "no activity for 5s" : '8× "Terminal" in a row',
    });
  const call = (participantId: string, id: string, title: string) =>
    line(participantId, {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title,
      rawInput: { command: id },
    });
  return { state, line, warn, call };
};

test("seen keeps a stall warning for the bell, out of attention; the next turn starts without one", () => {
  const { state, line, warn } = stallRoom();
  warn("alice", "idle");
  assert.equal(needsAttention(state, "alice"), true);
  seen(state, "alice");
  assert.equal(needsAttention(state, "alice"), false, "seen clears the mark");
  assert.equal(who(state, "alice").stall?.text, "no activity for 5s");
  assert.equal(who(state, "alice").stall?.seen, true);
  line("alice", { sessionUpdate: "_client_user_message", text: "b", turn: 2 });
  assert.equal(who(state, "alice").stall, undefined);
});

test("an idle warning is resolved by the next line of the same participant's harness (#348)", () => {
  const next: RoomEventLine["update"][] = [
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "back" },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hm" },
    },
    { sessionUpdate: "tool_call", toolCallId: "t2", title: "Terminal" },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    },
    { sessionUpdate: "usage_update", used: 1, size: 10 },
  ];
  for (const update of next) {
    const { state, line, warn, call } = stallRoom();
    call("alice", "t1", "Terminal");
    warn("alice", "idle");
    assert.equal(needsAttention(state, "alice"), true, update.sessionUpdate);
    // Another participant's line is not alice's activity.
    line("bob", update);
    assert.equal(
      needsAttention(state, "alice"),
      true,
      `bob's ${update.sessionUpdate}`,
    );
    line("alice", update);
    assert.equal(needsAttention(state, "alice"), false, update.sessionUpdate);
    assert.equal(who(state, "alice").stall, undefined, update.sessionUpdate);
    // History stays.
    assert.equal(
      state.timeline.filter((e) => e.type === "stall").length,
      1,
      update.sessionUpdate,
    );
  }
});

test("an idle warning outlives the room's own lines: the watchdog never sees them (#348)", () => {
  const { state, line, warn } = stallRoom();
  warn("alice", "idle");
  // The person nudges the silent agent, then renames it.
  line("alice", {
    sessionUpdate: "_client_message_queued",
    text: "are you there?",
  });
  line("alice", { sessionUpdate: "_client_participant_changed", name: "al" });
  assert.equal(needsAttention(state, "alice"), true);
  assert.equal(who(state, "alice").stall?.kind, "idle");
});

test("a repeat warning is resolved only by a tool call of another title (#348)", () => {
  const { state, line, warn, call } = stallRoom();
  call("alice", "t1", "Terminal");
  warn("alice", "repeat");
  assert.equal(who(state, "alice").stall?.title, "Terminal");
  // A busy loop is traffic too: none of it resolves a repeat.
  line("alice", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "still" },
  });
  line("alice", {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    title: "Read",
    rawInput: { command: "other" },
    status: "completed",
  });
  // Same title, other input: still the same title, as the watchdog sees it.
  call("alice", "t2", "Terminal");
  assert.equal(needsAttention(state, "alice"), true);
  // Another participant's new title is not alice's.
  call("bob", "t3", "Read");
  assert.equal(needsAttention(state, "alice"), true);
  call("alice", "t4", "Read");
  assert.equal(needsAttention(state, "alice"), false);
  assert.equal(who(state, "alice").stall, undefined);
});

test("a later warning replaces the live one with its own seq; a turn end clears it", () => {
  const { state, line, warn } = stallRoom();
  warn("alice", "idle");
  const first = who(state, "alice").stall?.seq;
  seen(state, "alice");
  line("alice", { sessionUpdate: "usage_update", used: 1, size: 10 });
  warn("alice", "idle");
  const second = who(state, "alice").stall;
  assert.ok(first !== undefined && second && second.seq > first);
  assert.equal(second.seen, false);
  assert.equal(needsAttention(state, "alice"), true);
  line("alice", {
    sessionUpdate: "_client_turn_ended",
    stopReason: "end_turn",
  });
  assert.equal(who(state, "alice").stall, undefined);
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
  // The kind is one ACP defines, or `other`: the question box's title
  // shows it (M7-4), and a harness can send any JSON there.
  for (const kind of [7, "\x1b]52;c;aGk=\x07edit"]) {
    const q = applyLine(state, {
      seq: state.seq + 1,
      roomId: "r",
      participantId: "p",
      at: "2026-10-01T00:00:00.000Z",
      update: {
        sessionUpdate: "_client_permission_queued",
        id: `q${state.seq}`,
        kind: kind as never,
        title: "t",
      },
    });
    assert.equal(q?.type === "permission" && q.kind, "other");
  }
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

test("a message and an answer keep their lines and lose their escape sequences (#229)", () => {
  const state = newRoomState();
  let seq = 0;
  const line = (update: Record<string, unknown>) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-10T09:00:00Z",
      roomId: "r",
      participantId: "p",
      update: update as unknown as RoomEventLine["update"],
    });
  const bad = "a\x1b[2J\nb\x1b]52;c;aGFja2Vk\x07";
  const clean = "a [2J\nb ]52;c;aGFja2Vk ";
  line({
    sessionUpdate: "_client_participant_added",
    name: "ana",
    harness: "claude",
    mode: "ask",
  });
  const queued = line({ sessionUpdate: "_client_message_queued", text: bad });
  assert.equal(queued?.type === "queued" && queued.text, clean);
  assert.deepEqual(who(state, "p").queue, [clean]);
  const user = line({ sessionUpdate: "_client_user_message", text: bad });
  assert.equal(user?.type === "user" && user.text, clean);
  assert.equal(who(state, "p").turns[0]?.text, clean);
  // Split over two chunks: the second half is plain text once `ESC` is gone.
  line({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "a\x1b" },
  });
  const answer = line({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "[2J\nb\x1b]52;c;aGFja2Vk\x07" },
  });
  assert.equal(answer?.type === "answer" && answer.text, clean);
  // A turn's error is the harness's own message; both screens draw it.
  const end = line({
    sessionUpdate: "_client_turn_ended",
    stopReason: bad,
    error: bad,
  });
  assert.equal(end?.type === "turn_ended" && end.error, printable(bad));
  assert.equal(end?.type === "turn_ended" && end.stopReason, printable(bad));
  assert.equal(who(state, "p").turns[0]?.error, printable(bad));
  // The footer draws the currency.
  line({
    sessionUpdate: "usage_update",
    used: 1,
    size: 2,
    cost: { amount: 1, currency: bad },
  });
  assert.equal(who(state, "p").usage?.cost?.currency, printable(bad));
  // The joiner stays, so a family emoji is one emoji.
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  assert.equal(cleanLines(family), family);
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
    at: "2026-10-07T00:00:00.000Z",
    type: "forward",
    from: "p-rev",
    branch: "kapelle/r/p-dev",
    sha: "abc123",
  });
  assert.deepEqual(state.timeline, [e]);
});

// --- after a restart (M6-7a, #151) ------------------------------------------

/** What `GET /rooms/:id` answers, as far as `applyStatus` reads it: each
 *  participant's status, and `seq`, the log's size when the daemon
 *  answered. */
const reply = (statuses: Record<string, string>, seq: number) =>
  ({
    seq,
    participants: Object.entries(statuses).map(([id, status]) => ({
      id,
      status,
    })),
  }) as unknown as RoomDto;

/** The `seq` of `lines[i]`. */
const seqAt = (lines: RoomEventLine[], i: number) =>
  (lines[i] as RoomEventLine).seq;

test("after a crash: GET's killed and paused hold, and the turn the crash cut reads cut, in either order", async (t) => {
  const { lines, alice, carol } = await recorded(t);
  // As a `kill -9` leaves the log: carol's turn started and never ended.
  const end = lines.findIndex(
    (l) =>
      l.participantId === carol &&
      l.update.sessionUpdate === "_client_turn_ended",
  );
  const log = lines.slice(0, end);
  const got = reply(
    { [alice]: "paused", [carol]: "killed" },
    seqAt(log, log.length - 1),
  );

  const after = replay(log);
  applyStatus(after, got);
  const before = newRoomState();
  // The reply first: a screen can read the room before the replay is in.
  applyStatus(before, got);
  replay(log, before);

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
  applyStatus(state, reply({ [carol]: "paused" }, seqAt(log, end)));
  replay(log.slice(end), state);
  const c = who(state, carol);
  assert.equal(c.status, "paused");
  assert.equal(c.turns[0]?.state, "ended");
  assert.equal(c.turns[0]?.stopReason, "cancelled");
});

/** A room whose harness is killed during a turn, then revived by the next
 *  message, as `core/room.ts` writes it. */
// It drives one whole room: its call count is the recording.
// pi-lens-ignore: high-fan-out
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
  // The daemon answered before the message that revived her.
  applyStatus(state, reply({ [dora]: "killed" }, seqAt(lines, revived - 3)));
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

test("a GET reply that arrived after the revive does not re-mark it", async (t) => {
  const { lines, dora } = await recordRevive(t);
  const revived = lines.findIndex(
    (l) => l.update.sessionUpdate === "_client_participant_revived",
  );
  assert.ok(revived > 0, "the recording has a revive");

  const state = replay(lines.slice(0, revived + 1));
  // The room was read before the revive, and the reply lands after its line.
  applyStatus(state, reply({ [dora]: "killed" }, seqAt(lines, revived - 3)));
  assert.equal(who(state, dora).reported, undefined);
  assert.equal(who(state, dora).status, "busy", "the revived turn is live");
  assert.equal(who(state, dora).turns.at(-1)?.state, "open");
});

test("after a shutdown: the harness's exit on the log keeps GET's paused", async (t) => {
  const { lines, carol } = await recorded(t);
  const end = lines.findIndex(
    (l) =>
      l.participantId === carol &&
      l.update.sessionUpdate === "_client_turn_ended",
  );
  const ended = lines[end] as RoomEventLine;
  // A pause stops the harness once its turn has ended: its exit comes next.
  const exited: RoomEventLine = {
    ...ended,
    seq: ended.seq + 1,
    update: { sessionUpdate: "_client_harness_exited", pid: 1 },
  };
  const state = newRoomState();
  applyStatus(state, reply({ [carol]: "paused" }, exited.seq));
  replay([...lines.slice(0, end + 1), exited], state);
  assert.equal(who(state, carol).status, "paused");
});

test("a second restart: GET's paused holds over a revive from the first, in either order", async (t) => {
  const { lines, dora } = await recordRevive(t);
  const revived = lines.findIndex(
    (l) => l.update.sessionUpdate === "_client_participant_revived",
  );
  const end = lines.findIndex(
    (l, i) => i > revived && l.update.sessionUpdate === "_client_turn_ended",
  );
  // The revived turn ended, then a second shutdown stopped her harness.
  const ended = lines[end] as RoomEventLine;
  const log = [
    ...lines.slice(0, end + 1),
    {
      ...ended,
      seq: ended.seq + 1,
      update: { sessionUpdate: "_client_harness_exited", pid: 1 },
    } satisfies RoomEventLine,
  ];
  const got = reply({ [dora]: "paused" }, ended.seq + 1);

  const after = replay(log);
  applyStatus(after, got);
  const before = newRoomState();
  applyStatus(before, got);
  replay(log, before);

  for (const state of [after, before]) {
    assert.equal(who(state, dora).status, "paused");
    assert.equal(who(state, dora).turns.at(-1)?.state, "ended");
  }
});

test("a revive entry is behind only when loaded, and keeps an unknown resumed (#238)", () => {
  const entryFor = (update: Record<string, unknown>) => {
    const state = newRoomState();
    applyLine(state, {
      seq: 1,
      at: "2026-10-09T00:00:00Z",
      roomId: "r1",
      participantId: "p-ana",
      update: {
        sessionUpdate: "_client_participant_revived",
        sessionId: "s1",
        ...update,
      } as unknown as RoomEventLine["update"],
    });
    return thread(state, "p-ana").at(-1);
  };
  assert.deepEqual(entryFor({ resumed: "loaded", memoryMayBeBehind: true }), {
    seq: 1,
    participantId: "p-ana",
    at: "2026-10-09T00:00:00Z",
    type: "revived",
    resumed: "loaded",
    behind: true,
  });
  const fresh = entryFor({ resumed: "fresh", memoryMayBeBehind: true });
  assert.equal(fresh?.type, "revived");
  assert.equal("behind" in (fresh ?? {}), false, "fresh is never behind");
  const unknown = entryFor({ resumed: "forked" });
  assert.equal(
    unknown?.type === "revived" ? unknown.resumed : undefined,
    "forked",
  );
});

test("each participant keeps its turn's start, a thinking flag, its last tool and usage; each entry its at (M7-1)", () => {
  const state = newRoomState();
  let seq = 0;
  const line = (update: Record<string, unknown>, at = "2026-10-10T09:00:00Z") =>
    applyLine(state, {
      seq: ++seq,
      at,
      roomId: "r1",
      participantId: "p-ana",
      update: update as unknown as RoomEventLine["update"],
    });
  const ana = () => who(state, "p-ana");
  line({
    sessionUpdate: "_client_participant_added",
    name: "ana",
    harness: "claude",
    mode: "ask",
  });
  const sent = line(
    { sessionUpdate: "_client_user_message", text: "go", turn: 1 },
    "2026-10-10T09:01:00Z",
  );
  assert.equal(sent?.at, "2026-10-10T09:01:00Z", "an entry keeps its at");
  assert.equal(ana().turns[0]?.start, "2026-10-10T09:01:00Z");

  const thought = {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "SECRET" },
  };
  assert.equal(line(thought), undefined, "a thought adds no entry");
  const first = seq;
  assert.equal(ana().thinking, first);
  line(thought);
  assert.equal(ana().thinking, first, "a second chunk does not change it");
  line({
    sessionUpdate: "usage_update",
    used: 50_000,
    size: 200_000,
    cost: { amount: 0.4, currency: "USD" },
  });
  assert.equal(ana().thinking, first, "a usage_update does not clear it");
  assert.deepEqual(ana().usage, {
    used: 50_000,
    size: 200_000,
    cost: { amount: 0.4, currency: "USD" },
  });
  assert.ok(!JSON.stringify(state).includes("SECRET"), "no thinking text kept");

  line({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Read\u001b[2J File",
  });
  assert.equal(ana().thinking, undefined, "a tool call clears it");
  assert.equal(ana().tool?.title, "Read [2J File", "the last tool, printable");
  line(thought);
  line({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  });
  assert.equal(ana().thinking, undefined, "an answer chunk clears it");
  line(thought);
  line({ sessionUpdate: "_client_turn_ended", stopReason: "end_turn" });
  assert.equal(ana().thinking, undefined, "the turn's end clears it");
  assert.equal(ana().tool, undefined, "and the last tool");
  assert.equal(ana().usage?.used, 50_000, "the usage stays");
  line({ sessionUpdate: "_client_user_message", text: "again", turn: 2 });
  line({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit" });
  line({ sessionUpdate: "_client_user_message", text: "next", turn: 3 });
  assert.equal(ana().tool, undefined, "a new turn clears the last tool");
});

/** A room with `ann` and `bob`, and a line maker for it. The tool calls
 *  are the shapes measured on 2026-10-09 (#240). */
function toolRoom() {
  const state = newRoomState();
  let seq = 0;
  const send = (participantId: string, update: Record<string, unknown>) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-10T00:00:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
  for (const name of ["ann", "bob"]) {
    send(name, {
      sessionUpdate: "_client_participant_added",
      name,
      harness: "mock",
      mode: "auto",
    });
  }
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  /** The tool call's entry after its first event, then after each update:
   *  `[title, detail, status]`. */
  const rows = (first: Record<string, unknown>, ...updates: object[]) => {
    const e = send("ann", {
      sessionUpdate: "tool_call",
      toolCallId: `t${seq}`,
      ...first,
    });
    const id = `t${seq - 1}`;
    const now = () => (e?.type === "tool" ? [e.title, e.detail, e.status] : []);
    const seen = [now()];
    for (const u of updates) {
      const changed = send("ann", {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        ...u,
      });
      assert.equal(changed, e, "each update changes the same entry");
      seen.push(now());
    }
    return seen;
  };
  return { state, send, rows };
}

test("a tool call's updates change its one entry: the title, the detail and the status (#240)", () => {
  const { state, rows } = toolRoom();
  const last = (r: unknown[][]) => r.at(-1);
  // claude: a plain label, then the real title on the update. Its command
  // is the title, so there is no detail.
  assert.deepEqual(
    last(
      rows(
        { title: "Terminal", kind: "execute", rawInput: {} },
        {
          title: "echo hi",
          rawInput: { command: "echo hi", description: "Print hi" },
          status: "in_progress",
        },
        { status: "completed" },
      ),
    ),
    ["echo hi", undefined, "completed"],
  );
  // Its title gives a path from its folder, and quotes a pattern: both
  // are said already.
  assert.deepEqual(
    last(
      rows(
        { title: "Read File", kind: "read", rawInput: {} },
        { title: "Read src/a.ts", rawInput: { file_path: "/w/src/a.ts" } },
      ),
    ),
    ["Read src/a.ts", undefined, undefined],
  );
  assert.deepEqual(
    last(
      rows(
        { title: "grep", kind: "search", rawInput: {} },
        {
          title: 'grep -n "foo" src',
          rawInput: { pattern: "foo", path: "src" },
        },
      ),
    ),
    ['grep -n "foo" src', undefined, undefined],
  );
  // opencode: the shell title becomes the command; `edit` keeps its title,
  // so the path is the detail. `cwd` is not shown.
  assert.deepEqual(
    last(
      rows(
        { title: "shell", rawInput: { cwd: "/w" } },
        { title: "ls -la", rawInput: { command: "ls -la" } },
      ),
    ),
    ["ls -la", undefined, undefined],
  );
  // The command can come before the title that says it: the detail goes
  // once the title says it.
  assert.deepEqual(
    rows(
      { title: "shell", rawInput: { cwd: "/w" } },
      { rawInput: { command: "ls" } },
      { title: "ls" },
    ),
    [
      ["shell", undefined, undefined],
      ["shell", "ls", undefined],
      ["ls", undefined, undefined],
    ],
  );
  assert.deepEqual(
    last(
      rows(
        { title: "edit", rawInput: {} },
        {
          rawInput: { filePath: "/w/a.ts", oldString: "A", newString: "B" },
          status: "failed",
        },
      ),
    ),
    ["edit", "/w/a.ts", "failed"],
  );
  // copilot: the command is in the first event's rawInput.
  assert.deepEqual(
    rows({
      title: "Echo probe string",
      rawInput: { command: "echo probe", description: "Echo probe string" },
      status: "pending",
    }),
    [["Echo probe string", "echo probe", "pending"]],
  );
  // pi: its file tool shows the operation and the path; a shell title is
  // the command already.
  assert.deepEqual(
    rows({
      title: "str_replace_editor",
      rawInput: { command: "str_replace", path: "/w/a.ts", old_str: "x" },
      locations: [{ path: "/w/a.ts" }],
    }),
    [["str_replace_editor", "str_replace /w/a.ts", undefined]],
  );
  assert.deepEqual(
    rows({ title: "echo hi", rawInput: { command: "echo hi" } }),
    [["echo hi", undefined, undefined]],
  );
  // No input at all: the description, else the first location.
  assert.deepEqual(
    rows({ title: "think", rawInput: { description: "plan it" } }),
    [["think", "plan it", undefined]],
  );
  assert.deepEqual(rows({ title: "look", locations: [{ path: "/w/b" }] }), [
    ["look", "/w/b", undefined],
  ]);
  assert.deepEqual(rows({ title: "look" }, { locations: [{ path: "/w/c" }] }), [
    ["look", undefined, undefined],
    ["look", "/w/c", undefined],
  ]);
  assert.equal(
    state.timeline.filter((e) => e.type === "tool").length,
    12,
    "one entry per call",
  );
});

test("a tool call's command breaks at a real newline and at a `;` that separates (#351)", () => {
  /** The commands, before short ones share a row again: a row would hide
   *  where they broke. */
  const of = (command: string) => commandLines(command).flat();
  assert.deepEqual(of("for n in 1 2; do echo $n; done"), [
    "for n in 1 2;",
    "do echo $n;",
    "done",
  ]);
  // A real newline is a line of its own.
  assert.deepEqual(of("cd /w\nnpm test"), ["cd /w", "npm test"]);
  // A trailing `;` ends its own line and makes no empty one.
  assert.deepEqual(of("a; b;"), ["a;", "b;"]);
  // `&&`, `||` and `|` read as one thought.
  assert.deepEqual(of("a && b || c | d"), ["a && b || c | d"]);
  // A `;` inside a quote, `$(…)` or a backtick separates nothing.
  assert.deepEqual(of("echo 'a; b'"), ["echo 'a; b'"]);
  assert.deepEqual(of('echo "a; b"'), ['echo "a; b"']);
  assert.deepEqual(of('echo "a\\"; b"'), ['echo "a\\"; b"']);
  assert.deepEqual(of("echo $(a; b) c"), ["echo $(a; b) c"]);
  assert.deepEqual(of("echo `a; b` c"), ["echo `a; b` c"]);
  // The contexts nest: a quote, a subshell or arithmetic inside `$()` does
  // not end the outer one.
  assert.deepEqual(of('echo "$(echo "a;b")"; ls'), [
    'echo "$(echo "a;b")";',
    "ls",
  ]);
  assert.deepEqual(of("echo $( (echo a); echo b)"), [
    "echo $( (echo a); echo b)",
  ]);
  assert.deepEqual(of("echo $(echo $(a; b); c)"), ["echo $(echo $(a; b); c)"]);
  assert.deepEqual(of('echo "`echo a;b`"; ls'), ['echo "`echo a;b`";', "ls"]);
  assert.deepEqual(of('for ((i=0; i<3; i++)); do echo "$i"; done'), [
    "for ((i=0; i<3; i++));",
    'do echo "$i";',
    "done",
  ]);
  // A comment and parameter text hold their `;` too.
  assert.deepEqual(of("echo hi # a; b\nls; pwd"), [
    "echo hi # a; b",
    "ls;",
    "pwd",
  ]);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter text
  assert.deepEqual(of("echo ${x:-a;b}; ls"), ["echo ${x:-a;b};", "ls"]);
  // A quote stays open across a real newline: the newline makes rows, but
  // the `;` on the next line is still inside it.
  assert.deepEqual(of("echo 'a; b\nc; d"), ["echo 'a; b", "c; d"]);
  // A heredoc body is text, not commands. The tag ends it.
  assert.deepEqual(of("cat > f <<'EOF'\na; b\nEOF\nls; pwd"), [
    "cat > f <<'EOF'",
    "a; b",
    "EOF",
    "ls;",
    "pwd",
  ]);
  assert.deepEqual(of("cat <<-END\nx; y\nEND\nz"), [
    "cat <<-END",
    "x; y",
    "END",
    "z",
  ]);
  // Two heredocs on one line: the second body follows the first.
  assert.deepEqual(of("f <<A <<B\na; 1\nA\nb; 2\nB"), [
    "f <<A <<B",
    "a; 1",
    "A",
    "b; 2",
    "B",
  ]);
  // `<<<` is a here-string, so its `;` still separates and it starts no
  // body on the next line.
  assert.deepEqual(of("cat <<<x; ls\npwd; echo"), [
    "cat <<<x;",
    "ls",
    "pwd;",
    "echo",
  ]);
  // A backslash quotes any character of the tag, as the shell does.
  assert.deepEqual(of("cat <<\\EOF\na; b\nEOF\nls"), [
    "cat <<\\EOF",
    "a; b",
    "EOF",
    "ls",
  ]);
  assert.deepEqual(of("cat <<E\\OF\na; b\nEOF\nls"), [
    "cat <<E\\OF",
    "a; b",
    "EOF",
    "ls",
  ]);
  // A `<<` inside arithmetic is a left shift, not a heredoc: it must not
  // swallow the lines after it (#361 review).
  assert.deepEqual(of("dd bs=$((1<<20))\necho a; echo b\nls"), [
    "dd bs=$((1<<20))",
    "echo a;",
    "echo b",
    "ls",
  ]);
  assert.deepEqual(of("if ((x << 2)); then ls; fi"), [
    "if ((x << 2));",
    "then ls;",
    "fi",
  ]);
});

test("a tool row shows four lines at most, each cut at 200 characters (#351)", () => {
  const { rows } = toolRoom();
  const of = (command: string) => {
    const [row] = rows({ title: command, rawInput: { command } });
    return String(row?.[0]).split("\n");
  };
  /** `n` commands of 50 characters, so no two share a row. */
  const cmds = (n: number) =>
    Array.from({ length: n }, (_, i) => "abcdef"[i]?.repeat(49)).join(";");
  const row = (c: string, end = ";") => `${c.repeat(49)}${end}`;
  const four = [row("a"), row("b"), row("c"), row("d")];
  assert.deepEqual(of(cmds(6)), [...four, "… 2 more lines"]);
  assert.deepEqual(of(cmds(5)), [...four, "… 1 more line"]);
  assert.deepEqual(of(cmds(4)), [...four.slice(0, 3), row("d", "")]);
  // Each line keeps its own cut, at exactly 200 characters.
  assert.deepEqual(of("x".repeat(200)), ["x".repeat(200)]);
  assert.deepEqual(of("x".repeat(201)), [`${"x".repeat(199)}…`]);
  const long = `${"x".repeat(250)};${"y".repeat(250)}`;
  assert.deepEqual(of(long), [`${"x".repeat(199)}…`, `${"y".repeat(199)}…`]);
  // The detail follows the same rules. Here the title says none of it.
  const [terminal] = rows({
    title: "Terminal",
    rawInput: { command: cmds(5) },
  });
  assert.deepEqual(String(terminal?.[1]).split("\n"), [
    ...four,
    "… 1 more line",
  ]);
  // The slot budgets a separator a line, so a fifth full line is seen
  // whichever separator made it (#361 review). With `;`, which stays on
  // its own line:
  const semis = `${"x".repeat(199)};`.repeat(5);
  assert.deepEqual(of(semis), [
    ...Array(4).fill(`${"x".repeat(199)};`),
    "… 1 more line",
  ]);
  // And with a newline, which belongs to no line and so costs the slot a
  // character the lines do not get back.
  const wide = Array(5).fill("x".repeat(200)).join("\n");
  assert.deepEqual(of(wide), [
    ...Array(4).fill("x".repeat(200)),
    "… 1 more line",
  ]);
  // Four full lines fit, so nothing is lost and no marker shows.
  assert.deepEqual(
    of(Array(4).fill("x".repeat(200)).join("\n")),
    Array(4).fill("x".repeat(200)),
  );
});

test("short commands of one line share a row, up to 80 characters", () => {
  const { rows } = toolRoom();
  const of = (command: string) => {
    const [row] = rows({ title: command, rawInput: { command } });
    return String(row?.[0]).split("\n");
  };
  assert.deepEqual(of("a;b;c;d;e;f"), ["a; b; c; d; e; f"]);
  // Two commands that fill exactly 80 characters share a row; one more
  // character breaks it.
  const x = `${"x".repeat(39)};`;
  assert.deepEqual(of(`${x}${"y".repeat(39)}`), [`${x} ${"y".repeat(39)}`]);
  assert.deepEqual(of(`${x}${"y".repeat(40)}`), [x, "y".repeat(40)]);
  // A real newline still starts a row, and a heredoc body is never packed.
  assert.deepEqual(of("a;\nb"), ["a;", "b"]);
  assert.deepEqual(of("cat <<E\na;\nb\nE"), ["cat <<E", "a;", "b", "E"]);
});

test("only a command is split at a `;`: a pattern, a path or a url is not (#361 review)", () => {
  const { rows } = toolRoom();
  const detail = (rawInput: Record<string, string>) => {
    const [row] = rows({ title: "Search", rawInput });
    return String(row?.[1]).split("\n");
  };
  // A grep pattern holds no shell separator.
  assert.deepEqual(detail({ pattern: "a;.*b" }), ["a;.*b"]);
  assert.deepEqual(detail({ url: "https://x/a;b=c" }), ["https://x/a;b=c"]);
  assert.deepEqual(detail({ path: "/w/a;b.ts" }), ["/w/a;b.ts"]);
  // pi sends its editor's operation under `command`: joined with a path,
  // it is no shell command either, so it does not split.
  assert.deepEqual(detail({ command: "str_replace", path: "/w/a;b.ts" }), [
    "str_replace /w/a;b.ts",
  ]);
  // A command alone still splits: its short commands share a row again,
  // with a space after the `;`.
  assert.deepEqual(detail({ command: "cd /w;ls" }), ["cd /w; ls"]);
  // A real newline still makes a line, whatever the key.
  assert.deepEqual(detail({ query: "one\ntwo" }), ["one", "two"]);
});

test("a tool call's command shows no escape or control character (#229, #351)", () => {
  const { rows } = toolRoom();
  // An escape sequence, a right-to-left override and a carriage return.
  const command = "echo\x1b[2J a\u202eb\rc; ls";
  const [row] = rows({ title: command, rawInput: { command } });
  assert.deepEqual(String(row?.[0]).split("\n"), ["echo [2J a b c; ls"]);
  assert.equal(row?.[1], undefined, "the title says the command already");
  // The detail takes the same path when the title does not say it.
  const [detail] = rows({ title: "shell", rawInput: { command } });
  assert.deepEqual(String(detail?.[1]).split("\n"), ["echo [2J a b c; ls"]);
  for (const text of [row?.[0], detail?.[1]]) {
    for (const bad of ["\x1b", "\u202e", "\r"]) {
      assert.ok(!String(text).includes(bad), "no control reaches the screen");
    }
  }
});

test("a tool call's update neither splits a streaming answer nor counts as unread", () => {
  const { state, send } = toolRoom();
  const chunk = (text: string) =>
    send("ann", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  send("ann", {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Terminal",
  });
  const answer = chunk("one ");
  const unread = state.participants.get("ann")?.unread;
  send("ann", {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    title: "ls",
  });
  chunk("two");
  assert.equal(answer?.type === "answer" && answer.text, "one two");
  assert.equal(state.participants.get("ann")?.unread, unread);
});

test("a message the orchestrator sent counts as unread; the person's does not (M8-1)", () => {
  const { state, send } = toolRoom();
  const unread = () => state.participants.get("ann")?.unread;
  assert.equal(unread(), 0, "the person's go");
  const mine = send("ann", {
    sessionUpdate: "_client_message_queued",
    text: "a",
  });
  assert.equal(unread(), 0);
  const queued = send("ann", {
    sessionUpdate: "_client_message_queued",
    text: "b",
    from: "bob",
  });
  const started = send("ann", {
    sessionUpdate: "_client_user_message",
    text: "b",
    turn: 2,
    from: "bob",
  });
  assert.equal(unread(), 2);
  assert.deepEqual(
    [mine, queued, started].map((e) => e && fromPerson(e)),
    [true, false, false],
  );
});

test("a tool call's update for an unknown id, or another participant's, changes nothing", () => {
  const { state, send } = toolRoom();
  const ann = send("ann", {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Terminal",
  });
  const before = state.timeline.length;
  assert.equal(
    send("ann", {
      sessionUpdate: "tool_call_update",
      toolCallId: "nope",
      title: "x",
    }),
    undefined,
  );
  // bob's harness uses the same id for its own call.
  assert.equal(
    send("bob", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "rm -rf /",
    }),
    undefined,
  );
  assert.equal(state.timeline.length, before);
  assert.equal(ann?.type === "tool" && ann.title, "Terminal");
});

test("a tool call's title and detail lose their control characters, are capped, and never hold a whole file", () => {
  const { send } = toolRoom();
  const e = send("ann", {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "rm\x1b[2J -rf\n/",
    rawInput: {
      path: `/w/${"a".repeat(400)}\x07`,
      old_string: "SECRET",
      new_string: "SECRET",
      file_text: "SECRET",
      content: "SECRET",
    },
    rawOutput: "SECRET",
    content: [{ type: "content", content: { type: "text", text: "SECRET" } }],
  });
  assert.equal(e?.type, "tool");
  if (e?.type !== "tool") return;
  // The escape goes; the real newline stays a line (#351).
  assert.equal(e.title, "rm [2J -rf\n/");
  assert.equal(e.detail?.length, 200);
  assert.ok(e.detail?.endsWith("…"));
  assert.ok(!e.detail?.includes("\x07"));
  assert.doesNotMatch(JSON.stringify(e), /SECRET/);
  const updated = send("ann", {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    title: "‮evil",
    rawInput: { file_text: "SECRET" },
  });
  assert.equal(updated?.type === "tool" && updated.title, " evil");
  assert.doesNotMatch(JSON.stringify(updated), /SECRET/);
});

test("a tool detail: a prose title word hides no path, a said description gives way to the location, and a long command still matches its title (#253)", () => {
  const { rows } = toolRoom();
  // copilot's title is prose: `config` is not the end of the path.
  assert.deepEqual(
    rows({ title: "Update the config", rawInput: { path: "/w/etc/config" } }),
    [["Update the config", "/w/etc/config", undefined]],
  );
  // claude's relative path still hides the full one, `a.ts` alone too.
  assert.deepEqual(
    rows({ title: "Read a.ts", rawInput: { file_path: "/w/a.ts" } }),
    [["Read a.ts", undefined, undefined]],
  );
  // The description says what the title says: the location shows.
  assert.deepEqual(
    rows({
      title: "plan it",
      rawInput: { description: "plan it" },
      locations: [{ path: "/w/b" }],
    }),
    [["plan it", "/w/b", undefined]],
  );
  // The slot keeps `SLOT_TEXT` characters of each; both are cut alike, so
  // a command that is its title still matches.
  const long = `python - <<'EOF'\n${"x".repeat(5000)}`;
  assert.deepEqual(
    rows({ title: long, rawInput: { command: long } }).map(([, d]) => d),
    [undefined],
  );
});

test("a tool call's status is one ACP defines, and an update that changes nothing drawn returns nothing (#253)", () => {
  const { send } = toolRoom();
  const e = send("ann", {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "x",
    status: "\x1b[2Jbogus",
  });
  assert.equal(e?.type === "tool" && "status" in e, false);
  assert.equal(
    send("ann", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      _meta: { terminal_output: { data: "hi" } },
    }),
    undefined,
    "output alone draws nothing",
  );
  assert.equal(
    send("ann", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "nope",
    }),
    undefined,
  );
  assert.equal(
    send("ann", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
    }),
    e,
  );
});

test("a tool call keeps its kind and its diff's +a −d: a new file counts every line as added (M7-2)", () => {
  const { send } = toolRoom();
  const tool = (update: Record<string, unknown>) => {
    const e = send("ann", { sessionUpdate: "tool_call", ...update });
    assert.equal(e?.type, "tool");
    return e as Extract<Entry, { type: "tool" }>;
  };
  const diff = (oldText: unknown, newText: unknown) => ({
    content: [{ type: "diff", path: "/w/a.ts", oldText, newText }],
  });
  // One change in one place: the shared start and end are dropped.
  const one = tool({
    toolCallId: "e1",
    title: "Edit",
    kind: "edit",
    ...diff("a\nb\nc\nd\n", "a\nB\nB2\nd\n"),
  });
  assert.equal(one.kind, "edit");
  assert.deepEqual([one.added, one.removed], [2, 2]);
  // No oldText: a new file. A last newline starts no line.
  const fresh = tool({ toolCallId: "e2", ...diff(undefined, "x\ny\nz\n") });
  assert.deepEqual([fresh.added, fresh.removed], [3, 0]);
  // An oldText that is not text is a new file too.
  const odd = tool({ toolCallId: "e3", ...diff(42, "x\n") });
  assert.deepEqual([odd.added, odd.removed], [1, 0]);
  // Two changes far apart count too high: all between them.
  const two = tool({ toolCallId: "e4", ...diff("a\nb\nc\n", "A\nb\nC\n") });
  assert.deepEqual([two.added, two.removed], [3, 3]);
  // No diff, an unknown kind: no counts, no kind.
  const plain = tool({ toolCallId: "e5", kind: "\x1b[2J", content: [] });
  assert.equal("kind" in plain || "added" in plain, false);
  // An update carries the diff and the kind: the same entry changes.
  assert.equal(
    send("ann", {
      sessionUpdate: "tool_call_update",
      toolCallId: "e5",
      kind: "edit",
      ...diff("a\n", "a\nb\n"),
    }),
    plain,
  );
  assert.deepEqual([plain.kind, plain.added, plain.removed], ["edit", 1, 0]);
  // Several diff blocks add up.
  const many = tool({
    toolCallId: "e6",
    content: [...diff("a\n", "b\n").content, ...diff(undefined, "c\n").content],
  });
  assert.deepEqual([many.added, many.removed], [2, 1]);
});

/**
 * The orchestrator's own messages (#362). A message the daemon wrote at the
 * end of a turn carries a `kind`, and the reducer keeps it, so a screen can
 * tell an order from an echo. A thread holds what its participant received
 * and the orders it sent, and never a `reply` or a `copy`.
 */
test("a message keeps its kind, and a thread holds the orders its participant sent (#362)", () => {
  const state = newRoomState();
  let seq = 0;
  const line = (participantId: string, update: Record<string, unknown>) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-26T09:00:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
  const po = "p-po";
  const ana = "p-ana";
  line(po, {
    sessionUpdate: "_client_participant_added",
    name: "po",
    harness: "claude",
    mode: "ask",
    role: "orchestrator",
  });
  line(ana, {
    sessionUpdate: "_client_participant_added",
    name: "ana",
    harness: "claude",
    mode: "ask",
  });
  // The person's own message: no sender, no kind.
  const asked = line(po, {
    sessionUpdate: "_client_user_message",
    text: "ask ana to fix the login bug",
    turn: 1,
  });
  // po's order to ana, and a copy of it that waited in ana's queue.
  const order = line(ana, {
    sessionUpdate: "_client_user_message",
    text: "fix the login bug",
    turn: 1,
    from: po,
  });
  const waited = line(ana, {
    sessionUpdate: "_client_message_queued",
    text: "and push it",
    from: po,
  });
  // ana's turn ended, so the daemon replied to po as ana.
  const replied = line(po, {
    sessionUpdate: "_client_user_message",
    text: "[reply from ana] end_turn, 1 tool call\nfixed",
    turn: 2,
    from: ana,
    kind: "reply",
  });
  const repliedLate = line(po, {
    sessionUpdate: "_client_message_queued",
    text: "[reply from ana] end_turn, 0 tool calls",
    from: ana,
    kind: "reply",
  });

  // `assert.equal("kind" in (e ?? {}), false)` would pass on a missing
  // entry too: `"kind" in {}` is false (#364 review). The entry has to be
  // there and carry no kind.
  assert.ok(asked && !("kind" in asked), "the person's has no kind");
  assert.ok(order && !("kind" in order), "an order has no kind");
  assert.deepEqual(
    [
      order?.type === "user" && order.from,
      waited?.type === "queued" && waited.from,
    ],
    [po, po],
  );
  assert.equal(replied?.type === "user" && replied.kind, "reply");
  assert.equal(repliedLate?.type === "queued" && repliedLate.kind, "reply");

  // po's thread: what po received, and the orders po sent to ana, the one
  // that waited in ana's queue included. The history lists `user` entries
  // only, so the queued one adds no second row.
  assert.deepEqual(
    thread(state, po).filter((e) => e.type === "user" || e.type === "queued"),
    [asked, order, waited, replied, repliedLate],
  );
  // ana's thread: what ana received only. The reply the daemon sent as ana
  // stays out, so ana's own answer is not quoted back into her thread.
  assert.deepEqual(
    thread(state, ana).filter((e) => e.type === "user" || e.type === "queued"),
    [order, waited],
  );
});
