/**
 * One participant with no room — story M12-8c (#555).
 *
 * Drives `core/room/member.ts` and `core/room/participant.ts` with an owner
 * the test makes, against `mock-agent.mjs`: no `Room`, no `room.json`, no
 * roster. The mock's `remember` scenario answers each turn with the prompt
 * before it, from a store, so a loaded session is told apart from a fresh one
 * by what it answers.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";

import {
  gitRepo,
  isolateStateHome,
  MOCK_AGENT,
  tempDir,
} from "../../../integration/helpers.ts";
import type { AgentEventEnvelope } from "../../../protocol/agent.ts";
import { AGENTS } from "../../../protocol/registry.ts";
import { createEventBus } from "../../events.ts";
import { newRoomId } from "../../ids.ts";
import { createPermissionQueue } from "../../permissions.ts";
import { WATCHDOG_DEFAULTS } from "../../watchdog.ts";
import { openWorktrees } from "../../worktree.ts";
import {
  addMember,
  type Owner,
  ownerPlaces,
  ownWatchdog,
  recordOf,
  removeMember,
  restoreMember,
} from "../member.ts";
import { readParticipantRecord } from "../record.ts";
import type { RoomNotice } from "../types.ts";
import { roomAgent } from "../validate.ts";

const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)("git", args, { cwd })).stdout.trim();

isolateStateHome();

/** A registry entry for the mock with a store and a measured load, so a
 *  revive loads. Removed after the test. */
async function loadingMock(t: TestContext) {
  const store = await tempDir(t);
  const id = `mock-load-${newRoomId()}`;
  AGENTS[id] = {
    launch: {
      command: process.execPath,
      args: [MOCK_AGENT, "--scenario", "remember", "--store", store],
    },
    maxMode: "auto",
    measured: {
      shell: "internal",
      argvChannel: "notification",
      asksPermission: false,
      modeMap: { safe: "id-safe", ask: "id-ask", auto: "id-auto" },
      usage: "per-turn",
      measuredOn: { version: "0.1.0", date: "2026-09-29" },
      loads: true,
    },
  };
  t.after(() => {
    delete AGENTS[id];
  });
  return id;
}

/** An owner that is not a room, in `repo`, and every event its bus carried. */
async function soloOwner(t: TestContext, repo: string) {
  const id = newRoomId();
  const bus = createEventBus();
  const events: AgentEventEnvelope[] = [];
  bus.addListener((e) => {
    events.push(e);
  });
  const watch = ownWatchdog(bus, WATCHDOG_DEFAULTS);
  t.after(watch.stop);
  const notices: RoomNotice[] = [];
  const owner: Owner = {
    id,
    bus,
    permissions: createPermissionQueue(60_000),
    places: ownerPlaces(id, repo, await openWorktrees(repo, id)),
    notices: () => notices,
    onNotice: (text) => notices.push({ text }),
    stderrLog: () => undefined,
    stopped: () => false,
    watchdog: watch.watchdog,
    limits: watch.limits,
    onRevive: () => {},
    onTurnEnd: () => {},
    onChange: () => {},
  };
  const of = (kind: string) =>
    events.filter((e) => e.update.sessionUpdate === kind);
  return { owner, events, notices, of };
}

test("one participant with no room: two turns, a pause, a load and a remove", async (t) => {
  const agent = await loadingMock(t);
  const repo = await gitRepo(t);
  const { owner, events, notices, of } = await soloOwner(t, repo);
  const m = await addMember(owner, roomAgent({ agent, name: "solo" }));
  const p = m.participant;
  t.after(() => m.stop());
  const branch = `kapelle/${owner.id}/${p.id}`;
  assert.equal(p.branch, branch, "the branch is named by the owner");
  assert.ok(existsSync(p.worktree), "its own checkout");
  const answers = () =>
    of("agent_message_chunk").map(
      (e) => (e.update as { content: { text: string } }).content.text,
    );

  await p.send("one");
  await p.send("two");
  assert.deepEqual(answers(), ["previous: (none)", "previous: one"]);
  const sessionId = p.sessionId;

  await m.pause(2_000);
  assert.equal(p.status(), "paused");

  // A pause is a shutdown: what comes back is the saved record, read
  // through the one-participant check, as a restart reads it.
  const saved = readParticipantRecord(
    JSON.parse(JSON.stringify(recordOf(m))),
    (why) => new Error(why),
  );
  assert.equal(saved.status, "paused");
  const back = await restoreMember(owner, saved);
  t.after(() => back.stop());
  const q = back.participant;
  assert.equal(q.worktree, p.worktree, "the same checkout");

  await q.send("three");
  assert.equal(q.resumed, "loaded", "the revive loaded the session");
  assert.equal(q.sessionId, sessionId, "the same session");
  assert.deepEqual(
    of("_client_participant_revived").map((e) => e.update),
    [
      {
        sessionUpdate: "_client_participant_revived",
        resumed: "loaded",
        sessionId,
      },
    ],
  );
  assert.equal(answers().at(-1), "previous: two", "it remembers");
  assert.equal(q.status(), "idle");
  assert.equal(back.turns(), 3);

  await removeMember(owner, back);
  assert.equal(
    events.at(-1)?.update.sessionUpdate,
    "_client_participant_removed",
    "the last line",
  );
  assert.ok(!existsSync(p.worktree), "the untouched checkout is released");
  assert.equal(
    await git(repo, "branch", "--list", branch),
    "",
    "and its branch",
  );
  assert.deepEqual(notices, [], "nothing was kept");
});

test("a participant record is checked alone, and the owner names the error", () => {
  const fail = (why: string) => new Error(`chat.json: ${why}`);
  const record = {
    id: "p-1",
    name: "solo",
    agent: "claude",
    harness: "claude",
    worktree: "/tmp/w",
    sessionId: "s",
    mode: "auto",
    status: "idle",
    turns: 1.5,
  };
  const read = readParticipantRecord(record, fail);
  assert.equal(read.turns, undefined, "a broken count is dropped");
  assert.deepEqual(read.notices, []);
  assert.deepEqual(read.settings, { allowReadOutsideRoot: false });
  assert.throws(
    () => readParticipantRecord({ ...record, mode: "yolo" }, fail),
    {
      message: 'chat.json: participant p-1 has mode "yolo"',
    },
  );
  assert.throws(() => readParticipantRecord(null, fail), {
    message: `chat.json: a participant's "id" is not a string`,
  });
});
