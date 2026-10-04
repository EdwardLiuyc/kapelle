/**
 * The rooms a screen follows — `client/roomset.ts`, story M4-11 (#211).
 * One test per rule the story names.
 *
 * The daemon is faked with a bare HTTP server. Each room's stream stays open
 * until the test lets it end, and `GET /rooms/:id` then says what happened.
 * The poll runs every 20 ms, so no test waits 5 s.
 */

import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { RoomEventLine, RoomListEntry, RoomStatus } from "../contract.ts";
import type { DaemonAddress } from "../daemon.ts";
import {
  type End,
  type Ended,
  type ReadAddress,
  reconcile,
  roomSet,
} from "../roomset.ts";

const POLL_MS = 20;

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
async function fake(t: TestContext) {
  const daemon = {
    d: { port: 0, token: "tok" } as DaemonAddress,
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
    /** Every `GET /rooms/:id`, by room. */
    reads: [] as string[],
    /** Ends a room's stream. */
    release: (id: string) => daemon.streams.get(id)?.end(),
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
  const json = (res: ServerResponse, status: number, body: unknown) =>
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  const server = createServer((req, res) => {
    const [, , id, events] = (req.url ?? "/").split("/");
    if (!id) {
      daemon.polls++;
      if (daemon.listStatus === 0) return req.socket.destroy();
      return json(res, daemon.listStatus, daemon.list);
    }
    if (events) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const line of daemon.lines.get(id) ?? []) {
        res.write(`id: ${line.seq}\ndata: ${JSON.stringify(line)}\n\n`);
      }
      daemon.streams.set(id, res);
      return;
    }
    daemon.reads.push(id);
    const s = daemon.status.get(id);
    if (s === undefined) return json(res, 404, { error: "no such room" });
    if (typeof s === "number") return json(res, s, { error: "refused" });
    json(res, 200, { ...entry(id), createdAt: "", status: s });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  daemon.d.port = (server.address() as AddressInfo).port;
  t.after(daemon.stop);
  return daemon;
}

/** A set over `daemon`, with what it said kept in order. */
function follow(t: TestContext, d: DaemonAddress) {
  const said = {
    lines: [] as string[],
    closed: [] as [string, Ended][],
    ends: [] as End[],
    polls: 0,
  };
  const address: ReadAddress = async () => d;
  const set = roomSet(
    d,
    address,
    {
      line: (id, l) => said.lines.push(`${id} ${l.update.sessionUpdate}`),
      loaded: () => {},
      polled: () => said.polls++,
      closed: (id, ended) => said.closed.push([id, ended]),
      end: (why) => said.ends.push(why),
    },
    POLL_MS,
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
  assert.deepEqual(said.lines, ["r1 _client_participant_added"]);
  assert.equal(set.rooms.get("r1")?.state.participants.get("p1")?.name, "ann");
  assert.equal(set.rooms.get("r2")?.state.participants.size, 0);
  // Once when it joined, once more for the participant the header lacks.
  await until(() => daemon.reads.filter((id) => id === "r1").length === 2);
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
