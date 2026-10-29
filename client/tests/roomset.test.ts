/**
 * The rooms a screen follows — `client/roomset.ts`, story M4-11 (#211).
 * One test per rule the story names.
 *
 * The daemon is faked with a bare HTTP server. Each room's stream stays open
 * until the test lets it end, and `GET /rooms/:id` then says what happened.
 * The poll runs every 20 ms and a daemon that went away gets 150 ms, so no
 * test waits 5 s or 30 s. A restart is a second fake with a new token
 * (M6-7d).
 */

import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import {
  API_VERSION,
  type RoomEventLine,
  type RoomListEntry,
  type RoomStatus,
} from "../contract.ts";
import type { DaemonAddress } from "../daemon.ts";
import {
  type End,
  type Ended,
  type ReadAddress,
  reconcile,
  roomSet,
} from "../roomset.ts";

const POLL_MS = 20;
const WAIT_MS = 150;

const entry = (id: string): RoomListEntry => ({
  id,
  cwd: "/repo",
  title: id,
  status: "active",
  updatedAt: "",
  participants: [],
});

/** A daemon whose answers the test sets. A room missing from `status`
 *  answers `404`; a number there is the HTTP status. */
async function fake(t: TestContext, token = "tok") {
  /** Reads whose answer waits for `releaseRead`. */
  const held: (() => void)[] = [];
  /** Polls whose answer waits for `releaseLists`. */
  const heldLists: (() => void)[] = [];
  const daemon = {
    d: { port: 0, token } as DaemonAddress,
    /** What `GET /version` answers. */
    version: { ...API_VERSION } as { major: number; minor: number },
    /** The `Last-Event-ID` of each stream asked for. */
    after: [] as string[],
    /** What `GET /rooms` answers, and with which status. */
    list: [] as RoomListEntry[],
    /** `0` drops the connection instead. */
    listStatus: 200,
    /** How many times `GET /rooms` was asked. */
    polls: 0,
    /** When set, a `GET /rooms` answer waits for `releaseLists`, with the
     *  list as it was when the poll came. */
    holdLists: false,
    releaseLists: () => {
      for (const answer of heldLists.splice(0)) answer();
    },
    status: new Map<string, RoomStatus | number>(),
    /** The lines each room's stream sends before it waits. */
    lines: new Map<string, RoomEventLine[]>(),
    streams: new Map<string, ServerResponse>(),
    /** The participants `GET /rooms/:id` names, with their status. */
    participants: [] as { id: string; status: string }[],
    /** Every `GET /rooms/:id`, by room. */
    reads: [] as string[],
    /** When set, a `GET /rooms/:id` answer waits for `releaseRead`. */
    holdReads: false,
    /** Answers every held read. */
    releaseRead: () => {
      for (const answer of held.splice(0)) answer();
    },
    /** `GET /rooms/:id` answers still open; the set keeps this at 1. */
    readsInFlight: 0,
    /** The most of those open at once, for the serialization assertion. */
    maxReadsInFlight: 0,
    /** Sends every line, whatever `Last-Event-ID` asks for. */
    replayAll: false,
    /** Ends a room's stream. */
    release: (id: string) => daemon.streams.get(id)?.end(),
    /** Takes no new connection; an open stream stays, as in a clean stop. */
    refuse: () => server.close(),
    stop: () => {
      server.closeAllConnections();
      if (server.listening) server.close();
    },
  };
  const json = (res: ServerResponse, status: number, body: unknown) =>
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  const server = createServer((req, res) => {
    if (req.url === "/version") {
      return json(res, 200, { apiVersion: daemon.version, capabilities: [] });
    }
    const [, , id, events] = (req.url ?? "/").split("/");
    if (!id) {
      daemon.polls++;
      if (daemon.listStatus === 0) return req.socket.destroy();
      const list = daemon.list;
      if (daemon.holdLists) {
        heldLists.push(() => json(res, daemon.listStatus, list));
        return;
      }
      return json(res, daemon.listStatus, list);
    }
    if (events) {
      const after = String(req.headers["last-event-id"] ?? 0);
      daemon.after.push(after);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const line of daemon.lines.get(id) ?? []) {
        if (!daemon.replayAll && line.seq <= Number(after)) continue;
        res.write(`id: ${line.seq}\ndata: ${JSON.stringify(line)}\n\n`);
      }
      daemon.streams.set(id, res);
      return;
    }
    daemon.reads.push(id);
    daemon.readsInFlight++;
    daemon.maxReadsInFlight = Math.max(
      daemon.maxReadsInFlight,
      daemon.readsInFlight,
    );
    /** Answers one read, whatever the answer is. */
    const answer = (status: number, body: unknown) => {
      daemon.readsInFlight--;
      json(res, status, body);
    };
    // The status is read when the answer goes, so a test can fail a held read.
    const dto = () => {
      const s = daemon.status.get(id);
      if (s === undefined) return answer(404, { error: "no such room" });
      if (typeof s === "number") return answer(s, { error: "refused" });
      answer(200, {
        ...entry(id),
        createdAt: "",
        status: s,
        participants: daemon.participants,
        seq: 0,
      });
    };
    // A held answer lets the room's stream beat the first read (#232).
    if (daemon.holdReads) held.push(dto);
    else dto();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  daemon.d.port = (server.address() as AddressInfo).port;
  t.after(daemon.stop);
  return daemon;
}

/** A set over `daemon`, with what it said kept in order. `address` is
 *  `daemon.json`: by default it always names `d`. */
function follow(
  t: TestContext,
  d: DaemonAddress,
  address: ReadAddress = async () => d,
) {
  const said = {
    lines: [] as string[],
    loaded: [] as string[],
    closed: [] as [string, Ended][],
    ends: [] as End[],
    restarts: [] as (string | undefined)[],
    reloads: [] as string[],
    aways: 0,
    polls: 0,
  };
  const set = roomSet(
    d,
    address,
    {
      line: (id, l) =>
        said.lines.push(`${id} ${l.seq} ${l.update.sessionUpdate}`),
      loaded: (id) => said.loaded.push(id),
      reloaded: (id) => said.reloads.push(id),
      polled: () => said.polls++,
      restarted: (warning) => said.restarts.push(warning),
      away: () => said.aways++,
      closed: (id, ended) => said.closed.push([id, ended]),
      end: (why) => said.ends.push(why),
    },
    POLL_MS,
    WAIT_MS,
  );
  t.after(() => set.stop());
  return { set, said };
}

async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(ok(), "timed out");
}

test("each room's stream runs into its own reducer, and a new participant reads the room again", async (t) => {
  const daemon = await fake(t);
  // Held, so the join line beats the first answer: no sleep, no flake (#232).
  daemon.holdReads = true;
  daemon.status.set("r1", "active");
  daemon.lines.set("r1", [
    {
      seq: 1,
      at: "",
      roomId: "r1",
      participantId: "p1",
      update: {
        sessionUpdate: "_client_participant_added",
        name: "ann",
        harness: "mock",
        mode: "safe",
      },
    },
  ]);
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1"), entry("r2")]);
  await until(() => said.lines.length === 1);
  assert.deepEqual(said.lines, ["r1 1 _client_participant_added"]);
  assert.equal(set.rooms.get("r1")?.state.participants.get("p1")?.name, "ann");
  assert.equal(set.rooms.get("r2")?.state.participants.size, 0);
  // The join landed while the first read was held. Its answer asks for the
  // read that has the participant the header lacks.
  daemon.releaseRead();
  await until(() => daemon.reads.filter((id) => id === "r1").length === 2);
  daemon.releaseRead();
});

test("a burst of joins during the first read asks for one more read, not one each", async (t) => {
  const daemon = await fake(t);
  daemon.holdReads = true;
  daemon.status.set("r1", "active");
  daemon.lines.set("r1", [
    added(1, "p1", "p1"),
    added(2, "p2", "p2"),
    added(3, "p3", "p3"),
  ]);
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  // All three joins land while the first read is held: it is the only read.
  await until(() => said.lines.length === 3);
  assert.equal(daemon.reads.length, 1);
  daemon.releaseRead();
  // Its answer asks for exactly one follow-up for all three joins.
  await until(() => daemon.reads.length === 2);
  daemon.releaseRead();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(daemon.reads, ["r1", "r1"]);
  assert.equal(daemon.maxReadsInFlight, 1, "one read at a time");
});

test("a join during a read that fails still reads the room again", async (t) => {
  const daemon = await fake(t);
  daemon.holdReads = true;
  daemon.status.set("r1", "active");
  daemon.lines.set("r1", [added(1, "p1", "p1")]);
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  await until(() => said.lines.length === 1);
  // The read the join waited on fails: the join still needs its own read.
  daemon.status.set("r1", 500);
  daemon.releaseRead();
  await until(() => daemon.reads.length === 2);
});

test("a read that ends after a dismiss does not read the room again", async (t) => {
  const daemon = await fake(t);
  daemon.holdReads = true;
  daemon.status.set("r1", "active");
  daemon.lines.set("r1", [added(1, "p1", "ann")]);
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  // The join lands while the read is held: `again` is set.
  await until(() => said.lines.length === 1);
  // The room is dismissed while that read is held. Its reconcile answers at
  // once; the held loadDto stays open.
  daemon.holdReads = false;
  daemon.status.set("r1", "dismissed");
  daemon.release("r1");
  await until(() => said.closed.length === 1);
  assert.equal(set.rooms.has("r1"), false);
  // The held answer ends: a gone room gets no chained read.
  daemon.releaseRead();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(daemon.reads, ["r1", "r1"], "loadDto and reconcile only");
});

test("a turn ending reads the room again, for a branch or base that moved in it", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "active");
  daemon.lines.set("r1", [
    {
      seq: 1,
      at: "",
      roomId: "r1",
      participantId: "p1",
      update: { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" },
    },
  ]);
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  await until(() => said.reloads.includes("r1"));
  assert.equal(daemon.reads.filter((id) => id === "r1").length, 2);
});

test("a turn-end read that finds a paused participant redraws the room", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "active");
  daemon.participants = [{ id: "p1", status: "idle" }];
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  await until(() => daemon.streams.has("r1"));
  await until(() => set.rooms.get("r1")?.dto !== undefined);
  const r = set.rooms.get("r1");
  const stream = daemon.streams.get("r1");
  assert.ok(r, "the room is followed");
  assert.ok(stream, "the room stream is open");
  assert.deepEqual(said.loaded, ["r1"]);

  // Add the participant after the first read: the DTO already names it, so
  // this line cannot queue the follow-up `loaded` read (#363).
  const join = added(1, "p1", "ann");
  stream.write(`id: ${join.seq}\ndata: ${JSON.stringify(join)}\n\n`);
  await until(() => r.state.participants.get("p1")?.status === "idle");
  assert.deepEqual(daemon.reads, ["r1"], "only the first read so far");

  // Hold the turn-end read and move the status while its reply waits.
  daemon.holdReads = true;
  stream.write(
    `id: 2\ndata: ${JSON.stringify({
      seq: 2,
      at: "",
      roomId: "r1",
      participantId: "p1",
      update: { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" },
    })}\n\n`,
  );
  await until(() => daemon.readsInFlight > 0);
  daemon.participants = [{ id: "p1", status: "paused" }];
  daemon.releaseRead();
  await until(() => said.loaded.length >= 2);
  assert.deepEqual(said.loaded, ["r1", "r1"]);
  assert.deepEqual(said.reloads, []);
  assert.equal(r.state.participants.get("p1")?.status, "paused");
});

test("an already-paused room refreshes its header on a turn end, not the transcript", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "active");
  daemon.participants = [
    { id: "p1", status: "paused" },
    { id: "p2", status: "idle" },
  ];
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  // The first read lands with p1 already paused; the added lines below come
  // after the dto, so they queue no extra read of their own.
  await until(() => set.rooms.get("r1")?.dto !== undefined);
  await until(() => said.loaded.length === 1);
  const stream = daemon.streams.get("r1");
  for (const line of [added(1, "p1", "ann"), added(2, "p2", "bob")]) {
    stream?.write(`id: ${line.seq}\ndata: ${JSON.stringify(line)}\n\n`);
  }
  await until(() => set.rooms.get("r1")?.state.participants.size === 2);
  daemon.holdReads = true;
  stream?.write(
    `id: 3\ndata: ${JSON.stringify({
      seq: 3,
      at: "",
      roomId: "r1",
      participantId: "p2",
      update: { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" },
    })}\n\n`,
  );
  await until(() => daemon.reads.length === 2);
  daemon.releaseRead();
  await until(() => said.reloads.includes("r1"));
  assert.equal(said.loaded.length, 1, "nothing drawn moved");
});

test("a room made elsewhere joins on the next poll", async (t) => {
  const daemon = await fake(t);
  const { set, said } = follow(t, daemon.d);
  set.start([]);
  daemon.list = [entry("r1"), { ...entry("r2"), status: "dismissed" }];
  await until(() => set.rooms.has("r1"));
  await until(() => daemon.streams.has("r1"));
  assert.ok(!set.rooms.has("r2"), "a dismissed room does not join");
  assert.deepEqual(said.ends, []);
});

test("a room followed already is not followed again, and the poll renews its entry", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "active");
  daemon.list = [{ ...entry("r1"), title: "renamed" }];
  const { set } = follow(t, daemon.d);
  set.start([entry("r1")]);
  await until(() => daemon.polls >= 3);
  const r1 = set.rooms.get("r1");
  assert.equal(r1?.entry.title, "renamed");
  // As when the screen made the room and the poll saw it first.
  set.add(entry("r1"));
  assert.equal(set.rooms.get("r1"), r1);
  assert.deepEqual(daemon.reads, ["r1"], "the room was read once");
});

test("a title is stored as a screen may draw it", async (t) => {
  const daemon = await fake(t);
  daemon.list = [{ ...entry("r1"), title: "a\nb\u001b[2Jc" }];
  const { set } = follow(t, daemon.d);
  set.start([]);
  await until(() => set.rooms.has("r1"));
  const title = set.rooms.get("r1")?.entry.title ?? "";
  assert.doesNotMatch(title, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  assert.match(title, /^a b \[2Jc$/);
});

test("a poll asked before a rename cannot bring the old title back, and the rest of it lands", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "active");
  daemon.list = [{ ...entry("r1"), title: "old", status: "paused" }];
  daemon.holdLists = true;
  const { set, said } = follow(t, daemon.d);
  set.start([{ ...entry("r1"), title: "old" }]);
  await until(() => daemon.polls >= 1);
  // The rename lands while that poll waits, with the old title in it.
  set.retitle("r1", "new\u001b");
  daemon.list = [{ ...entry("r1"), title: "new" }];
  daemon.releaseLists();
  await until(() => said.polls >= 1);
  assert.equal(set.rooms.get("r1")?.entry.title, "new ");
  assert.equal(set.rooms.get("r1")?.entry.status, "paused");
  // A poll asked after the rename renews the entry again.
  daemon.holdLists = false;
  daemon.list = [{ ...entry("r1"), title: "later" }];
  await until(() => set.rooms.get("r1")?.entry.title === "later");
});

test("a dismissed room leaves the set, and the set goes on", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "active");
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  await until(() => daemon.streams.has("r1"));
  daemon.status.set("r1", "dismissed");
  daemon.release("r1");
  await until(() => said.closed.length === 1);
  assert.deepEqual(said.closed, [["r1", { kind: "dismissed" }]]);
  assert.equal(set.rooms.size, 0);
  // One read when it joined, one for the end: `readRoom` hands its read on.
  assert.deepEqual(daemon.reads, ["r1", "r1"]);
  assert.deepEqual(said.ends, []);
});

test("a retained dismissed room stays until the screen drops it", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "dismissed");
  const { set, said } = follow(t, daemon.d);
  set.retain("r1");
  set.start([{ ...entry("r1"), status: "dismissed" }]);
  await until(() => daemon.streams.has("r1"));
  daemon.release("r1");
  await until(() => set.rooms.get("r1")?.held === true);
  assert.deepEqual(said.closed, [], "a held room is not reported as closed");
  assert.deepEqual(said.ends, []);
  assert.ok(set.rooms.has("r1"));
  set.drop("r1");
  assert.equal(set.rooms.has("r1"), false);
});

test("a held room lets the set end when the daemon is gone", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "dismissed");
  const { set, said } = follow(t, daemon.d);
  set.retain("r1");
  set.start([{ ...entry("r1"), status: "dismissed" }]);
  await until(() => daemon.streams.has("r1"));
  daemon.release("r1");
  await until(() => set.rooms.get("r1")?.held === true);
  await until(() => daemon.polls > 0);
  assert.deepEqual(said.ends, [], "the daemon still answers");

  daemon.stop();
  await until(() => said.ends.length === 1);
  assert.deepEqual(said.ends, [{ kind: "gone" }]);
});

test("the set ends when every room lost its stream", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "active");
  daemon.status.set("r2", "active");
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1"), entry("r2")]);
  await until(() => daemon.streams.size === 2);
  daemon.release("r1");
  await until(() => said.closed.length === 1);
  assert.deepEqual(set.rooms.get("r1")?.lost, {
    kind: "alive",
    status: "active",
  });
  assert.deepEqual(said.ends, [], "r2 still has its stream");
  daemon.release("r2");
  await until(() => said.ends.length === 1);
  assert.deepEqual(said.ends, [
    {
      kind: "lost",
      roomId: "r2",
      ended: { kind: "alive", status: "active" },
      err: undefined,
    },
  ]);
});

test("with no room left the set stays while the daemon answers", async (t) => {
  const daemon = await fake(t);
  const { set, said } = follow(t, daemon.d);
  set.start([]);
  await until(() => said.polls >= 3);
  assert.deepEqual(said.ends, []);
});

test("with a room open a poll that fails or answers 401 does not end the set", async (t) => {
  for (const listStatus of [0, 401]) {
    const daemon = await fake(t);
    daemon.status.set("r1", "active");
    daemon.listStatus = listStatus;
    const { set, said } = follow(t, daemon.d);
    set.start([entry("r1")]);
    await until(() => daemon.polls >= 3);
    assert.deepEqual(said.ends, [], `poll answer ${listStatus}`);
  }
});

test("with no room left the set ends when the daemon answers 401", async (t) => {
  const daemon = await fake(t);
  daemon.listStatus = 401;
  const { set, said } = follow(t, daemon.d);
  set.start([]);
  await until(() => said.ends.length > 0);
  // The polls after it must not end the set again.
  await new Promise((r) => setTimeout(r, 5 * POLL_MS));
  assert.deepEqual(said.ends, [{ kind: "gone" }]);
});

test("with no room left the set ends when the daemon is gone", async (t) => {
  const daemon = await fake(t);
  const { set, said } = follow(t, daemon.d);
  set.start([]);
  daemon.stop();
  await until(() => said.ends.length > 0);
  // The polls after it must not end the set again.
  await new Promise((r) => setTimeout(r, 5 * POLL_MS));
  assert.deepEqual(said.ends, [{ kind: "gone" }]);
});

test("reconcile says what happened, not a line", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("paused", "paused");
  daemon.status.set("broken", 500);
  const address: ReadAddress = async () => daemon.d;
  assert.deepEqual(await reconcile(address, "paused"), {
    kind: "alive",
    status: "paused",
  });
  assert.deepEqual(await reconcile(address, "missing"), { kind: "unknown" });
  assert.deepEqual(await reconcile(address, "broken"), {
    kind: "refused",
    status: 500,
  });
  const none: ReadAddress = async () => {
    throw new Error("no daemon is listening");
  };
  assert.deepEqual(await reconcile(none, "paused"), {
    kind: "gone",
    message: "no daemon is listening",
  });
});

test("a revive reads the room again, for the model it set after the load (M9-5)", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "active");
  daemon.participants = [{ id: "p1", status: "idle" }];
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  await until(() => set.rooms.get("r1")?.dto !== undefined);
  const stream = daemon.streams.get("r1");
  assert.ok(stream);
  const line = (seq: number, update: object) =>
    `id: ${seq}\ndata: ${JSON.stringify({ seq, roomId: "r1", participantId: "p1", update })}\n\n`;
  // The added line gives the reducer the participant; its DTO read is done
  // before the revive, so only the revive can take the model from the reply.
  stream.write(
    line(1, {
      sessionUpdate: "_client_participant_added",
      name: "ann",
      harness: "mock",
      mode: "safe",
    }),
  );
  await until(() => set.rooms.get("r1")?.state.participants.has("p1") === true);
  stream.write(
    line(2, {
      sessionUpdate: "_client_participant_revived",
      resumed: "loaded",
      sessionId: "s1",
    }),
  );
  await until(() => said.reloads.includes("r1"));
  assert.equal(daemon.reads.filter((id) => id === "r1").length, 2);
});

// --- across a daemon restart (M6-7d, #236) ---------------------------------

const added = (seq: number, id: string, name: string): RoomEventLine => ({
  seq,
  at: "",
  roomId: "r1",
  participantId: id,
  update: {
    sessionUpdate: "_client_participant_added",
    name,
    harness: "mock",
    mode: "safe",
  },
});

/** `daemon.json` as the test sets it: `undefined` is no file. */
function daemonFile(first: DaemonAddress) {
  const file = { now: first as DaemonAddress | undefined };
  const address: ReadAddress = async () => {
    if (!file.now) throw new Error("no daemon is listening");
    return { ...file.now };
  };
  return { file, address };
}

for (const how of ["a crash", "a clean stop"]) {
  test(`after ${how} the set waits, checks the new daemon, reads the room again and resumes after the last line`, async (t) => {
    const old = await fake(t);
    old.status.set("r1", "active");
    old.lines.set("r1", [added(1, "p1", "ann")]);
    const { file, address } = daemonFile(old.d);
    const d = { ...old.d };
    const { set, said } = follow(t, d, address);
    set.start([entry("r1")]);
    await until(() => said.lines.length === 1);

    // A clean stop takes no new connection, then pauses the room, which
    // ends its stream normally, then removes `daemon.json` (`daemon.ts`,
    // `shutdown`). A crash only cuts the stream.
    if (how === "a clean stop") {
      old.refuse();
      old.release("r1");
      await new Promise((r) => setTimeout(r, 50));
    }
    old.stop();
    file.now = undefined;
    await new Promise((r) => setTimeout(r, WAIT_MS / 3));

    const next = await fake(t, "tok2");
    next.status.set("r1", "paused");
    next.participants = [{ id: "p1", status: "paused" }];
    next.lines.set("r1", [added(1, "p1", "ann"), added(2, "p2", "bob")]);
    // A line at or below the last one seen is dropped even when a daemon
    // sends it again (F4).
    next.replayAll = true;
    file.now = next.d;

    await until(() => said.lines.length === 2);
    assert.deepEqual(said.lines, [
      "r1 1 _client_participant_added",
      "r1 2 _client_participant_added",
    ]);
    assert.deepEqual(next.after, ["1"], "it resumed after the last line");
    assert.deepEqual(said.restarts, [undefined]);
    assert.deepEqual(d, next.d, "the screen's address took the new token");
    await until(() => next.reads.includes("r1"));
    await until(
      () =>
        set.rooms.get("r1")?.state.participants.get("p1")?.status === "paused",
    );
    assert.deepEqual(said.ends, []);
    assert.deepEqual(said.closed, []);
  });
}

test("a restart during a held read waits its turn and reads the new daemon once", async (t) => {
  const old = await fake(t);
  old.holdReads = true;
  old.status.set("r1", "active");
  const { file, address } = daemonFile(old.d);
  const d = { ...old.d };
  const { set, said } = follow(t, d, address);
  set.start([entry("r1")]);
  await until(() => old.reads.length === 1);

  // The daemon restarts while that read is held: the ask waits for it.
  const next = await fake(t, "tok2");
  next.status.set("r1", "active");
  next.participants = [{ id: "p1", status: "active" }];
  file.now = next.d;
  await set.fresh();
  const r = set.rooms.get("r1");
  assert.equal(r?.reading, true, "the held read is still open");
  assert.equal(
    r?.again,
    "loaded",
    "the restart's ask is deferred, not parallel",
  );
  assert.deepEqual(next.reads, [], "the new daemon is not read yet");

  // The held answer ends: the deferred ask goes to the new daemon, once,
  // and its answer is the one kept.
  old.releaseRead();
  await until(() => next.reads.length === 1);
  await until(() => said.loaded.length === 2);
  assert.equal(
    set.rooms.get("r1")?.dto?.participants.length,
    1,
    "the newer answer is the one kept",
  );
  assert.deepEqual(old.reads, ["r1"]);
  assert.deepEqual(next.reads, ["r1"]);
  assert.equal(old.maxReadsInFlight, 1);
  assert.equal(next.maxReadsInFlight, 1);
});

test("a daemon that does not come back ends the set after the wait", async (t) => {
  const old = await fake(t);
  old.status.set("r1", "active");
  const { file, address } = daemonFile(old.d);
  const { set, said } = follow(t, { ...old.d }, address);
  set.start([entry("r1")]);
  await until(() => old.streams.has("r1"));
  const stopped = Date.now();
  old.stop();
  file.now = undefined;
  await until(() => said.ends.length === 1);
  assert.ok(Date.now() - stopped >= WAIT_MS, "it waited first");
  const [end] = said.ends;
  assert.equal(end?.kind, "lost");
  assert.equal(end?.kind === "lost" && end.ended.kind, "gone");
});

test("a new daemon with a different major ends the set with the version message", async (t) => {
  for (const rooms of [[entry("r1")], []]) {
    const old = await fake(t);
    old.status.set("r1", "active");
    const { file, address } = daemonFile(old.d);
    const { set, said } = follow(t, { ...old.d }, address);
    set.start(rooms);
    if (rooms.length) await until(() => old.streams.has("r1"));
    old.stop();
    const next = await fake(t, "tok2");
    next.version = { major: API_VERSION.major + 1, minor: 0 };
    file.now = next.d;
    await until(() => said.ends.length === 1);
    const [end] = said.ends;
    const message =
      end?.kind === "lost"
        ? (end.err as Error | undefined)?.message
        : end?.message;
    assert.match(message ?? "", /kapelle daemon stop/);
    assert.deepEqual(said.restarts, [], `${rooms.length} room(s)`);
  }
});

test("with no room open the set waits for a daemon that comes back, and polls it", async (t) => {
  const old = await fake(t);
  const { file, address } = daemonFile(old.d);
  const { set, said } = follow(t, { ...old.d }, address);
  set.start([]);
  await until(() => said.polls >= 1);
  old.stop();
  file.now = undefined;
  await new Promise((r) => setTimeout(r, WAIT_MS / 3));
  const next = await fake(t, "tok2");
  file.now = next.d;
  await until(() => next.polls >= 2);
  assert.deepEqual(said.ends, []);
  assert.deepEqual(said.restarts, [undefined]);
  assert.equal(said.aways, 1, "the poll said once that the daemon is away");
});

test("a clean end on a paused room while the daemon answers ends the reader, not a loop", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "paused");
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  await until(() => daemon.streams.has("r1"));
  daemon.release("r1");
  // Its one room lost its stream, so the set ends.
  await until(() => said.ends.length === 1);
  assert.deepEqual(said.ends, [
    {
      kind: "lost",
      roomId: "r1",
      ended: { kind: "alive", status: "paused" },
      err: undefined,
    },
  ]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(daemon.after.length, 1, "the stream was not opened again");
});

test("a new token whose version check fails is checked again", async (t) => {
  const old = await fake(t);
  old.status.set("r1", "active");
  const { file, address } = daemonFile(old.d);
  const { set, said } = follow(t, { ...old.d }, address);
  set.start([entry("r1")]);
  await until(() => old.streams.has("r1"));
  old.stop();
  // `daemon.json` names the new token before its daemon answers.
  file.now = { port: old.d.port, token: "tok2" };
  await new Promise((r) => setTimeout(r, WAIT_MS / 3));
  const next = await fake(t, "tok2");
  next.status.set("r1", "paused");
  file.now = next.d;
  await until(() => said.restarts.length === 1);
  assert.deepEqual(said.ends, []);
});

test("the replay's old turn ends read the room once more, not once each", async (t) => {
  const daemon = await fake(t);
  daemon.status.set("r1", "active");
  daemon.lines.set(
    "r1",
    Array.from({ length: 50 }, (_, i) => ({
      seq: i + 1,
      at: "",
      roomId: "r1",
      participantId: "p1",
      update: {
        sessionUpdate: "_client_turn_ended" as const,
        stopReason: "end_turn",
      },
    })),
  );
  const { set, said } = follow(t, daemon.d);
  set.start([entry("r1")]);
  await until(() => said.reloads.includes("r1"));
  // At most: the first read, one a turn end sent, and one that waited for it.
  assert.ok(daemon.reads.filter((id) => id === "r1").length <= 3);
});
