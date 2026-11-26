/**
 * A chat: one agent with its own log — story M11-12 (#556).
 *
 * Drives `core/chat.ts` against `mock-agent.mjs`. The mock's `remember`
 * scenario answers each turn with the prompt before it, from a store, so a
 * loaded session is told apart from a fresh one by what it answers. A crash
 * is a pause, then a record set back to `removing` by hand, as a daemon
 * killed during a remove leaves it.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";

import {
  gitRepo,
  isolateStateHome,
  loadingMock,
} from "../../integration/helpers.ts";
import {
  archivedChatDir,
  type Chat,
  chatDir,
  finishChatRemove,
  openChat,
  restoreChat,
} from "../chat.ts";
import { createEventBus } from "../events.ts";
import { newChatId } from "../ids.ts";
import { createPermissionQueue } from "../permissions.ts";
import { roomAgent } from "../room/validate.ts";
import { stateDir, stateDirFor } from "../runtime.ts";

const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)("git", args, { cwd })).stdout.trim();

isolateStateHome();

/** What a chat needs from its daemon: its own bus and the queue. */
const deps = () => ({
  bus: createEventBus(),
  permissions: createPermissionQueue(60_000),
});

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** The lines of a chat's log, parsed. */
const logOf = (dir: string) =>
  readFileSync(join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const answers = (dir: string) =>
  logOf(dir)
    .filter((l) => l.update.sessionUpdate === "agent_message_chunk")
    .map((l) => l.update.content.text);

async function chatIn(
  t: TestContext,
  cwd: string | undefined,
  scenario = "remember",
) {
  const agent = await loadingMock(t, scenario);
  const chat = await openChat({
    ...deps(),
    agent: roomAgent({ agent, name: "solo", ...(cwd && { cwd }) }),
  });
  t.after(() => chat.pause());
  return chat;
}

const branchOf = (chat: Chat) => `kapelle/${chat.id}/${chat.participant.id}`;

test("a chat keeps its memory across two turns and a restart, on its own log (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await chatIn(t, repo);
  const p = chat.participant;
  const dir = chatDir(chat.id);
  assert.equal(
    p.worktree,
    join(stateDirFor(repo), "wt", chat.id, p.id),
    "its checkout is named by the chat",
  );
  assert.equal(p.branch, branchOf(chat));

  await p.send("one");
  await p.send("two");
  assert.deepEqual(answers(dir), ["previous: (none)", "previous: one"]);
  await chat.pause();

  const record = readJson(join(dir, "chat.json"));
  assert.equal(record.id, chat.id);
  assert.equal(record.lifecycle, "active");
  assert.equal(record.participant.status, "paused");
  assert.deepEqual(record.repositories, [repo]);
  const lines = logOf(dir);
  assert.deepEqual(
    lines.map((l) => l.seq),
    lines.map((_, i) => i + 1),
    "seq counts from 1",
  );
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), [
      "at",
      "chatId",
      "seq",
      "update",
    ]);
    assert.equal(line.chatId, chat.id);
  }

  const restoredBus = createEventBus();
  const restored: string[] = [];
  restoredBus.addListener(({ update }) => {
    restored.push(update.sessionUpdate);
  });
  const back = await restoreChat({
    bus: restoredBus,
    permissions: createPermissionQueue(60_000),
    id: chat.id,
  });
  t.after(() => back.pause());
  const q = back.participant;
  assert.equal(q.status(), "paused", "no harness started");
  assert.ok(
    !restored.includes("_client_harness_spawned"),
    "restore started no harness",
  );
  assert.equal(q.worktree, p.worktree, "the same checkout");
  await q.send("three");
  assert.equal(q.resumed, "loaded", "the revive loaded the session");
  assert.equal(q.sessionId, p.sessionId);
  await back.pause();
  assert.equal(answers(dir).at(-1), "previous: two", "it remembers");
  const after = logOf(dir);
  assert.deepEqual(
    after.map((l) => l.seq),
    after.map((_, i) => i + 1),
    "the restored log carries seq on without a gap",
  );
  for (const line of after) {
    assert.deepEqual(Object.keys(line).sort(), [
      "at",
      "chatId",
      "seq",
      "update",
    ]);
    assert.equal(line.chatId, chat.id);
  }
});

test("chat.json's updatedAt moves on activity, not on a pause or a restore (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await chatIn(t, repo);
  const file = join(chatDir(chat.id), "chat.json");
  const opened = readJson(file);
  assert.equal(opened.updatedAt, opened.createdAt);
  const tick = () => new Promise((ok) => setTimeout(ok, 5));
  await tick();
  await chat.participant.send("one");
  await chat.pause();
  const active = readJson(file).updatedAt;
  assert.ok(active > opened.createdAt, "a turn moves updatedAt");

  await tick();
  const back = await restoreChat({ ...deps(), id: chat.id });
  await back.pause();
  assert.equal(readJson(file).updatedAt, active, "a restart is no activity");
});

test("a chat's mode, model and level change, and chat.json keeps them (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await chatIn(t, repo, "levels");
  const p = chat.participant;
  chat.setMode("safe");
  assert.equal(p.mode, "safe");
  await chat.setModel("mock/smart");
  assert.equal(p.model, "mock/smart");
  await chat.setLevel("max");
  assert.equal(p.thoughtLevel, "max");
  assert.throws(() => chat.setMode("yolo" as "safe"));
  // The pause saves the record and flushes the log.
  await chat.pause();
  const record = readJson(join(chatDir(chat.id), "chat.json")).participant;
  assert.equal(record.mode, "safe");
  assert.equal(record.model, "mock/smart");
  assert.equal(record.thoughtLevel, "max");
  const changed = logOf(chatDir(chat.id))
    .filter((l) => l.update.sessionUpdate === "_client_participant_changed")
    .map(({ update: { sessionUpdate: _, ...rest } }) => rest);
  assert.deepEqual(changed, [
    { mode: "safe" },
    { model: "mock/smart" },
    { thoughtLevel: "max" },
  ]);

  const back = await restoreChat({ ...deps(), id: chat.id });
  t.after(() => back.pause());
  const q = back.participant;
  assert.equal(q.mode, "safe", "the mode survives the restart");
  await q.send("again");
  assert.equal(q.model, "mock/smart", "the revive asks for the model");
  assert.equal(q.thoughtLevel, "max", "and the level");
  await back.pause();
});

test("a remove releases the checkout and moves the folder to the archive (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await chatIn(t, repo);
  const p = chat.participant;
  await p.send("one");
  const removing = chat.remove();
  const during = readJson(join(chatDir(chat.id), "chat.json"));
  assert.equal(during.lifecycle, "removing");
  assert.match(during.removedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(await removing, [], "nothing was kept");
  assert.equal(chat.lifecycle(), "archived");
  assert.ok(!existsSync(chatDir(chat.id)), "the live folder is gone");
  const archived = archivedChatDir(chat.id);
  const record = readJson(join(archived, "chat.json"));
  assert.equal(record.lifecycle, "archived");
  assert.equal(record.removedAt, during.removedAt, "removedAt is kept");
  assert.equal(
    record.participant.status,
    "idle",
    "an archived chat keeps a chat status, not a room's dismissed",
  );
  assert.equal(p.status(), "idle");
  assert.equal(
    logOf(archived).at(-1)?.update.sessionUpdate,
    "_client_participant_removed",
    "the log moved with it, closed on its last line",
  );
  const log = chat.eventLog;
  assert.ok(log);
  const lines = logOf(archived).length;
  log.append({
    chatId: chat.id,
    update: { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" },
  });
  await log.close();
  assert.equal(
    logOf(archived).length,
    lines,
    "the remove left the log closed to a later append",
  );
  assert.ok(!existsSync(p.worktree), "the untouched checkout is gone");
  assert.equal(await git(repo, "branch", "--list", branchOf(chat)), "");
  assert.throws(() => p.send("two"), { code: "room_dismissed" });
  assert.throws(() => p.send("two"), /the chat is removed/);
  assert.throws(() => chat.setMode("safe"), { code: "room_dismissed" });
  await assert.rejects(chat.setModel("mock/smart"), {
    code: "room_dismissed",
  });
  await assert.rejects(chat.setLevel("max"), { code: "room_dismissed" });
});

test("a remove cancels the turn, drops its queue and denies its open question (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const bus = createEventBus();
  const permissions = createPermissionQueue(60_000);
  const updates: string[] = [];
  bus.addListener(({ update }) => {
    updates.push(update.sessionUpdate);
  });
  const agent = await loadingMock(t, "diff-first");
  const chat = await openChat({
    bus,
    permissions,
    agent: roomAgent({ agent, name: "solo", cwd: repo, mode: "ask" }),
  });
  t.after(() => chat.pause());

  const live = chat.participant.send("live");
  const waiting = chat.participant.send("waiting");
  let pending: ReturnType<typeof permissions.list>[number] | undefined;
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    pending = permissions.list()[0];
    if (pending) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.ok(pending, "the ask turn queued a question");
  assert.equal(chat.participant.queued, 1);

  await chat.remove();
  await Promise.all([live, waiting]);

  assert.deepEqual(permissions.list(), [], "the open question was denied");
  assert.deepEqual(permissions.get(pending.id), {
    ...pending,
    allow: false,
    reason: "cancel",
  });
  assert.ok(
    updates.includes("_client_queue_cleared"),
    "the waiting message was dropped and announced",
  );
  assert.equal(chat.participant.status(), "idle");
  assert.equal(
    logOf(archivedChatDir(chat.id)).at(-1)?.update.sessionUpdate,
    "_client_participant_removed",
    "the remove's last line survives the close and move",
  );
});

test("another notice during a remove does not hide the kept checkout's (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const bus = createEventBus();
  const agent = await loadingMock(t, "diff-first");
  const chat = await openChat({
    bus,
    permissions: createPermissionQueue(60_000),
    agent: roomAgent({ agent, name: "solo", cwd: repo, mode: "ask" }),
  });
  t.after(() => chat.pause());
  const { worktree } = chat.participant;
  writeFileSync(join(worktree, "work.txt"), "work\n");
  // An `ask` turn waits on its question, so the remove cuts a live turn.
  void chat.participant.send("live");
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    if (chat.participant.status() === "busy") break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(chat.participant.status(), "busy");

  // The turn's end saves the record. A folder where the save writes its
  // temp file makes that save fail and add its own notice, during the
  // remove. It goes before the move, so the archive can be written.
  const tmp = join(chatDir(chat.id), `chat.json.${process.pid}.tmp`);
  bus.addListener(({ update }) => {
    if (update.sessionUpdate === "_client_participant_removed") {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  const removing = chat.remove();
  mkdirSync(tmp);
  const notices = (await removing).map((n) => n.text);
  assert.ok(
    notices.some((text) => text.startsWith("cannot save the chat record")),
    `the other notice landed during the remove: ${notices.join(" | ")}`,
  );
  assert.ok(
    notices.some((text) => text.includes(worktree)),
    `the kept checkout is still named: ${notices.join(" | ")}`,
  );
});

test("a remove keeps a checkout with work in it, and a notice names it (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await chatIn(t, repo);
  const p = chat.participant;
  writeFileSync(join(p.worktree, "work.txt"), "work\n");
  const notices = await chat.remove();
  assert.equal(notices.length, 1);
  assert.ok(notices[0]?.text.includes(p.worktree), notices[0]?.text);
  assert.ok(existsSync(join(p.worktree, "work.txt")), "the work stays");
  assert.equal(
    await git(repo, "branch", "--list", branchOf(chat)),
    `+ ${branchOf(chat)}`,
    "and its branch",
  );
  const record = readJson(join(archivedChatDir(chat.id), "chat.json"));
  assert.deepEqual(record.notices, notices, "the archive keeps the notice");
});

/** A chat whose daemon died during its remove, before the move. */
async function crashedBeforeMove(t: TestContext, repo: string) {
  const chat = await chatIn(t, repo);
  await chat.pause();
  const file = join(chatDir(chat.id), "chat.json");
  writeFileSync(
    file,
    JSON.stringify({
      ...readJson(file),
      lifecycle: "removing",
      removedAt: new Date().toISOString(),
    }),
  );
  return chat;
}

test("a boot finishes a remove a crash cut short before the move (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await crashedBeforeMove(t, repo);
  const removing = readJson(join(chatDir(chat.id), "chat.json"));
  await assert.rejects(restoreChat({ ...deps(), id: chat.id }), /removing/);
  assert.deepEqual(await finishChatRemove(chat.id), []);
  assert.ok(!existsSync(chat.participant.worktree), "the checkout is released");
  assert.equal(await git(repo, "branch", "--list", branchOf(chat)), "");
  assert.ok(!existsSync(chatDir(chat.id)));
  const record = readJson(join(archivedChatDir(chat.id), "chat.json"));
  assert.equal(record.lifecycle, "archived");
  assert.equal(record.removedAt, removing.removedAt);
});

test("a boot finish removes a branch whose checkout a crash already removed (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await crashedBeforeMove(t, repo);
  const branch = branchOf(chat);
  // `release` removes the checkout before its branch. A crash in that gap
  // leaves exactly this record and branch, with no checkout.
  await git(repo, "worktree", "remove", "--force", chat.participant.worktree);
  assert.equal(await git(repo, "branch", "--list", branch), branch);

  await finishChatRemove(chat.id);
  assert.equal(
    await git(repo, "branch", "--list", branch),
    "",
    "finishing the remove leaves no branch behind",
  );
});

test("a crash before the move keeps and names a checkout with work (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await crashedBeforeMove(t, repo);
  const { worktree } = chat.participant;
  writeFileSync(join(worktree, "work.txt"), "work\n");
  const notices = await finishChatRemove(chat.id);
  assert.equal(notices.length, 1);
  assert.ok(notices[0]?.text.includes(worktree));
  assert.ok(existsSync(join(worktree, "work.txt")));
});

test("a boot finishes a remove a crash cut short after the move (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await chatIn(t, repo);
  await chat.remove();
  const file = join(archivedChatDir(chat.id), "chat.json");
  const removing = readJson(file);
  writeFileSync(file, JSON.stringify({ ...removing, lifecycle: "removing" }));
  assert.deepEqual(await finishChatRemove(chat.id), []);
  const archived = readJson(file);
  assert.equal(archived.lifecycle, "archived");
  assert.equal(archived.removedAt, removing.removedAt);
  await assert.rejects(finishChatRemove(chat.id), /archived, not removing/);
});

test("a crash after the move still names a checkout with work (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await chatIn(t, repo);
  const { worktree } = chat.participant;
  writeFileSync(join(worktree, "work.txt"), "work\n");
  await chat.remove();
  const file = join(archivedChatDir(chat.id), "chat.json");
  const moved = readJson(file);
  // The folder moved, then the daemon died before it could write the kept
  // checkout's notice into the archived record.
  writeFileSync(
    file,
    JSON.stringify({ ...moved, lifecycle: "removing", notices: [] }),
  );
  const notices = await finishChatRemove(chat.id);
  assert.equal(notices.length, 1);
  assert.ok(notices[0]?.text.includes(worktree), notices[0]?.text);
  assert.deepEqual(
    readJson(file).notices,
    notices,
    "the kept checkout is named in the archived record",
  );
});

test("two chats in one repository: removing one leaves the other's checkout and branch (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const a = await chatIn(t, repo);
  const b = await chatIn(t, repo);
  await a.remove();
  assert.ok(!existsSync(a.participant.worktree));
  assert.equal(await git(repo, "branch", "--list", branchOf(a)), "");
  assert.ok(existsSync(b.participant.worktree), "the other checkout stays");
  assert.equal(
    await git(repo, "branch", "--list", branchOf(b)),
    `+ ${branchOf(b)}`,
    "and its branch",
  );
  assert.equal(b.lifecycle(), "active");
});

test("a chat has one agent and no roles (M11-12)", async (t) => {
  const agent = await loadingMock(t, "remember");
  const id = newChatId();
  await assert.rejects(
    openChat({
      ...deps(),
      id,
      agent: roomAgent({ agent, name: "solo", role: "developer" }),
    }),
    /a chat has no roles/,
  );
  assert.ok(!existsSync(chatDir(id)), "a refused role starts nothing");
});

test("a chat record is checked against its folder and chat shape (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const chat = await chatIn(t, repo);
  await chat.pause();
  const file = join(chatDir(chat.id), "chat.json");
  const good = readJson(file);
  const cases = [
    {
      why: "another chat's id",
      record: { ...good, id: newChatId() },
      error: /"id" is .*not/,
    },
    {
      why: "a role",
      record: {
        ...good,
        participant: { ...good.participant, role: "developer" },
      },
      error: /a chat has no roles/,
    },
    {
      why: "a room's dismissed status",
      record: {
        ...good,
        participant: { ...good.participant, status: "dismissed" },
      },
      error: /a chat uses idle, busy, exited, paused or killed/,
    },
    {
      why: "removing with no removedAt",
      record: { ...good, lifecycle: "removing" },
      error: /"removedAt" is required/,
    },
  ];
  for (const one of cases) {
    writeFileSync(file, JSON.stringify(one.record));
    await assert.rejects(
      restoreChat({ ...deps(), id: chat.id }),
      one.error,
      one.why,
    );
  }
  writeFileSync(file, JSON.stringify(good));
});

test("a chat with no folder gets a scratch folder, which an empty remove deletes (M11-12)", async (t) => {
  const chat = await chatIn(t, undefined);
  const { worktree } = chat.participant;
  assert.equal(
    worktree,
    join(stateDir(), "scratch", "chats", chat.participant.id),
  );
  assert.ok(existsSync(worktree));
  assert.deepEqual(await chat.remove(), []);
  assert.ok(!existsSync(worktree));
});

test("a new chat never takes a live or an archived chat's id (M11-12)", async (t) => {
  const agent = await loadingMock(t, "remember");
  const request = () => roomAgent({ agent, name: "solo" });
  const live = newChatId();
  mkdirSync(chatDir(live), { recursive: true });
  await assert.rejects(
    openChat({ ...deps(), id: live, agent: request() }),
    /already exists/,
  );
  const old = newChatId();
  mkdirSync(archivedChatDir(old), { recursive: true });
  await assert.rejects(
    openChat({ ...deps(), id: old, agent: request() }),
    /already exists, archived/,
  );
  assert.ok(!existsSync(chatDir(old)), "nothing is left of the refused chat");
  await assert.rejects(
    openChat({ ...deps(), id: "room-x", agent: request() }),
    /invalid chat id/,
  );
});

test("a chat that cannot start keeps nothing (M11-12)", async (t) => {
  const repo = await gitRepo(t);
  const agent = await loadingMock(t, "remember");
  const id = newChatId();
  await assert.rejects(
    openChat({
      ...deps(),
      id,
      agent: roomAgent({ agent, name: "solo", cwd: repo, base: "nope" }),
    }),
  );
  assert.ok(!existsSync(chatDir(id)));
});
