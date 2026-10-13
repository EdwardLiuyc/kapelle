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
    status: new Map<string, RoomStatus | number>(),
    /** The lines each room's stream sends before it waits. */
    lines: new Map<string, RoomEventLine[]>(),
    streams: new Map<string, ServerResponse>(),
    /** The participants `GET /rooms/:id` names, with their status. */
    participants: [] as { id: string; status: string }[],
    /** Every `GET /rooms/:id`, by room. */
    reads: [] as string[],
    /** How long `GET /rooms/:id` waits before answering; `0` is immediate. */
    readDelayMs: 0,
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
      return json(res, daemon.listStatus, daemon.list);
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
    const s = daemon.status.get(id);
    if (s === undefined) return answer(404, { error: "no such room" });
    if (typeof s === "number") return answer(s, { error: "refused" });
    const dto = () =>
      answer(200, {
        ...entry(id),
        createdAt: "",
        status: s,
        participants: daemon.participants,
        seq: 0,
      });
    // A delayed or held answer lets the room's stream beat the first read
    // (#232).
    if (daemon.holdReads) held.push(dto);
    else if (daemon.readDelayMs > 0) setTimeout(dto, daemon.readDelayMs);
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
    closed: [] as [string, Ended][],
    ends: [] as End[],
    restarts: [] as (string | undefined)[],
    aways: 0,
    polls: 0,
  };
  const set = roomSet(
    d,
    address,
    {
      line: (id, l) =>
        said.lines.push(`${id} ${l.seq} ${l.update.sessionUpdate}`),
      loaded: () => {},
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
  // The line must beat the first answer, or the test is flaky (#232).
  daemon.readDelayMs = 100;
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
  // Once when it joined, once more for the participant the header lacks.
  await until(() => daemon.reads.filter((id) => id === "r1").length === 2);
});

test("a burst of joins during the first read asks for one more read, not one each", async (t) => {
  const daemon = await fake(t);
  daemon.holdReads = true;
  daemon.status.set("r1", "active");
  const added = (seq: number, id: string): RoomEventLine => ({
    seq,
    at: "",
    roomId: "r1",
    participantId: id,
    update: {
      sessionUpdate: "_client_participant_added",
      name: id,
      harness: "mock",
      mode: "safe",
    },
  });
  daemon.lines.set("r1", [added(1, "p1"), added(2, "p2"), added(3, "p3")]);
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
    assert.match(message ?? "", /update the client or the daemon/);
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
