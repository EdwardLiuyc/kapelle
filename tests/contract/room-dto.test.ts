/**
 * The room DTOs — story M6-2, issue #146.
 *
 * A room is created empty or with one agent, and both round-trip through
 * `GET /rooms/:id`. `GET /rooms` carries each roster inline and short (R9,
 * R44), and no key outside `client/contract.ts` reaches the wire. The daemon
 * is a real subprocess reached over HTTP; the types are the ones a client
 * imports.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ParticipantDto,
  RoomDto,
  RoomListEntry,
} from "../../client/contract.ts";
import {
  daemonApi as api,
  bootDaemon as boot,
  gitRepo,
  MOCK_AGENT,
} from "../../integration/helpers.ts";

/** Every key each type declares; a reply may not carry any other. The
 *  literal `satisfies` makes a contract field a compile error here until the
 *  set grows with it. */
const ROOM_KEYS = new Set(
  Object.keys({
    id: 0,
    cwd: 0,
    title: 0,
    createdAt: 0,
    updatedAt: 0,
    status: 0,
    seq: 0,
    participants: 0,
  } satisfies Record<keyof RoomDto, 0>),
);
const PARTICIPANT_KEYS = new Set(
  Object.keys({
    id: 0,
    name: 0,
    role: 0,
    harness: 0,
    mode: 0,
    settings: 0,
    worktree: 0,
    branch: 0,
    baseSha: 0,
    sessionId: 0,
    resumed: 0,
    turnFrom: 0,
    status: 0,
    notices: 0,
  } satisfies Record<keyof ParticipantDto, 0>),
);
const LIST_KEYS = new Set(
  Object.keys({
    id: 0,
    cwd: 0,
    title: 0,
    status: 0,
    updatedAt: 0,
    participants: 0,
  } satisfies Record<keyof RoomListEntry, 0>),
);

function assertKeys(value: object, keys: Set<string>, label: string) {
  for (const key of Object.keys(value)) {
    assert.ok(keys.has(key), `${label} carries unknown key ${key}`);
  }
}

test("an empty room and a room with one agent round-trip through GET /rooms/:id", async (t) => {
  const d = await boot(t);
  const cwd = (
    await api<{ root: string }>(d, "POST", "/repos", {
      path: await gitRepo(t),
    })
  ).body.root;

  const empty = await api<RoomDto>(d, "POST", "/rooms", {
    cwd,
    title: "  t  ",
  });
  assert.equal(empty.status, 201);
  assert.match(empty.body.id, /^room-\d{8}-\d{6}-[0-9a-z]{4}$/);
  assert.equal(empty.body.title, "t", "the title is kept trimmed");
  assert.equal(empty.body.status, "active");
  assert.deepEqual(empty.body.participants, []);
  assert.equal(
    new Date(empty.body.createdAt).toISOString(),
    empty.body.createdAt,
  );

  const starter = await api<RoomDto>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: `node ${MOCK_AGENT}`, name: "alice", role: "orchestrator" },
    ],
  });
  assert.equal(starter.status, 201, JSON.stringify(starter.body));
  assert.equal(starter.body.title, undefined, "no title, no key");
  const [alice] = starter.body.participants;
  assert.ok(alice);
  assert.match(alice.id, /^p-[0-9a-z]{8}$/);
  assert.equal(alice.name, "alice");
  assert.equal(alice.role, "orchestrator");
  assert.equal(alice.harness, "mock-agent");
  assert.equal(alice.mode, "auto");
  assert.equal(alice.status, "idle");
  assert.equal(alice.branch, `kapelle/${starter.body.id}/${alice.id}`);
  assert.match(alice.baseSha ?? "", /^[0-9a-f]{40}$/);
  assert.equal(typeof alice.sessionId, "string");

  for (const posted of [empty.body, starter.body]) {
    const got = await api<RoomDto>(d, "GET", `/rooms/${posted.id}`);
    assert.equal(got.status, 200);
    // `seq` can only grow: lines the open wrote may reach the disk after
    // POST answered.
    assert.ok(got.body.seq >= posted.seq, "the log only grows");
    assert.deepEqual(
      { ...got.body, seq: posted.seq },
      posted,
      "GET returns what POST answered",
    );
    assertKeys(got.body, ROOM_KEYS, "room");
    for (const p of got.body.participants) {
      assertKeys(p, PARTICIPANT_KEYS, "participant");
    }
  }

  // The list carries each roster inline, and short.
  const list = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.equal(list.status, 200);
  for (const entry of list.body) assertKeys(entry, LIST_KEYS, "list entry");
  assert.deepEqual(
    list.body.map((r) => [r.id, r.participants]),
    [
      [empty.body.id, []],
      [
        starter.body.id,
        [{ id: alice.id, name: "alice", role: "orchestrator", status: "idle" }],
      ],
    ],
  );

  // Dismiss is final for the room and its participant alike.
  const gone = await api<RoomDto>(
    d,
    "POST",
    `/rooms/${starter.body.id}/dismiss`,
  );
  assert.equal(gone.status, 200);
  assert.equal(gone.body.status, "dismissed");
  assert.equal(gone.body.participants[0]?.status, "dismissed");
  await api(d, "POST", `/rooms/${empty.body.id}/dismiss`);
});
