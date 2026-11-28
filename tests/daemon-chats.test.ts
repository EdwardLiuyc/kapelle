/**
 * Chats over the daemon's HTTP API (M11-13): each `/chats` route, names that
 * clash or race, a question in a chat, a stream resumed with
 * `Last-Event-ID`, the archive, and a restart that keeps every chat. A real
 * `daemon.ts` and `mock-agent.mjs`; no harness, and no screen.
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` and `XDG_STATE_HOME`. The
 * helpers more than one file needs live in `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
  ArchivedChat,
  ChatDto,
  ChatEventLine,
  Diff,
  MessageAccepted,
  PermissionDecision,
  ScratchCleanReply,
  ScratchFolder,
} from "../client/contract.ts";
import {
  addRepo,
  api,
  bootDaemon,
  type Daemon,
  gitRepo,
  hasBranch,
  MOCK_AGENT,
  pendingOne,
  REMEMBER,
  tempDir,
  until,
} from "../integration/helpers.ts";

type ChatReply = ChatDto & { error?: { code: string; message: string } };
type Refused = { error: { code: string; message: string } };

const SLOW = `node ${MOCK_AGENT} --scenario slow`;

/** Polls `GET /chats/:id` until its agent is not `busy`. */
async function chatIdle(d: Daemon, id: string): Promise<ChatDto> {
  let chat: ChatDto | undefined;
  await until(`chat ${id} to go idle`, async () => {
    chat = (await api<ChatDto>(d, "GET", `/chats/${id}`)).body;
    return chat.agent.status !== "busy";
  });
  return chat as ChatDto;
}

/** The SSE frames of `path` after `lastEventId`: up to `count`, or every
 *  frame until the daemon ends the stream. */
async function frames(
  d: Daemon,
  path: string,
  lastEventId?: number,
  count = Number.POSITIVE_INFINITY,
): Promise<{ id: number; data: ChatEventLine }[]> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${d.token}`,
  };
  if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
  const stop = new AbortController();
  const res = await fetch(d.url + path, { headers, signal: stop.signal });
  if (res.status !== 200) assert.fail(`${path}: ${await res.text()}`);
  const out: { id: number; data: ChatEventLine }[] = [];
  let buffer = "";
  const body = res.body?.pipeThrough(new TextDecoderStream());
  for await (const text of body ?? []) {
    buffer += text;
    for (let end = buffer.indexOf("\n\n"); end !== -1; ) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (data === undefined) continue;
      out.push({
        id: Number(/^id: (\d+)$/m.exec(frame)?.[1]),
        data: JSON.parse(data),
      });
    }
    if (out.length >= count) {
      stop.abort();
      break;
    }
  }
  return out.slice(0, count);
}

test("a chat's routes: add, list, get, message, stream, change, cancel, diff, remove and the archive", async (t) => {
  const d = await bootDaemon(t);
  const cwd = await realpath(await addRepo(d, await gitRepo(t)));
  const added = await api<ChatReply>(d, "POST", "/chats", {
    cmd: REMEMBER,
    name: "ann",
    cwd,
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const { id } = added.body;
  const ann = added.body.agent;
  assert.match(id, /^chat-/);
  assert.equal(ann.name, "ann");
  assert.equal(ann.branch, `kapelle/${id}/${ann.id}`);

  const list = await api<ChatDto[]>(d, "GET", "/chats");
  assert.deepEqual(
    list.body.map((c) => [c.id, c.agent.name]),
    [[id, "ann"]],
  );

  for (const text of ["one", "two"]) {
    const sent = await api<MessageAccepted>(
      d,
      "POST",
      `/chats/${id}/messages`,
      {
        text,
      },
    );
    assert.equal(sent.status, 202);
    await chatIdle(d, id);
  }
  const chat = (await api<ChatDto>(d, "GET", `/chats/${id}`)).body;
  assert.ok(chat.seq > 4, `seq ${chat.seq}`);

  // A stream resumed after line 2 starts at line 3, and every line names the
  // chat and no participant.
  const resumed = await frames(d, `/chats/${id}/events`, 2, chat.seq - 2);
  assert.deepEqual(
    resumed.map((f) => f.id),
    Array.from({ length: chat.seq - 2 }, (_, i) => i + 3),
  );
  assert.ok(resumed.every((f) => f.data.chatId === id && f.data.seq === f.id));
  assert.ok(resumed.every((f) => !("participantId" in f.data)));

  const renamed = await api<ChatReply>(d, "PATCH", `/chats/${id}`, {
    name: "bea",
    mode: "safe",
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual(
    [renamed.body.agent.name, renamed.body.agent.mode],
    ["bea", "safe"],
  );
  for (const [body, code] of [
    [{}, "invalid_request"],
    [{ role: "tester" }, "invalid_request"],
    [{ name: "has space" }, "invalid_request"],
  ] as const) {
    const bad = await api<Refused>(d, "PATCH", `/chats/${id}`, body);
    assert.deepEqual([bad.status, bad.body.error.code], [400, code]);
  }
  const role = await api<Refused>(d, "POST", "/chats", {
    cmd: REMEMBER,
    role: "tester",
  });
  assert.deepEqual(
    [role.status, role.body.error.code],
    [400, "invalid_request"],
  );

  const noTurn = await api<Refused>(
    d,
    "POST",
    `/chats/${id}/turns/current/cancel`,
  );
  assert.deepEqual([noTurn.status, noTurn.body.error.code], [409, "no_turn"]);

  await writeFile(join(ann.worktree, "notes.md"), "hello\n");
  const diff = await api<Diff>(d, "GET", `/chats/${id}/diff`);
  assert.equal(diff.status, 200);
  assert.match(diff.body.text, /notes\.md/);
  const badDiff = await api<Refused>(d, "GET", `/chats/${id}/diff?against=x`);
  assert.equal(badDiff.status, 400);

  // The remove keeps the checkout with work in it, and names it.
  const removed = await api<ArchivedChat>(d, "DELETE", `/chats/${id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.name, "bea");
  assert.match(removed.body.folder, /chats\/archive\/chat-/);
  assert.ok(
    removed.body.notices.some((n) => n.text.includes(ann.worktree)),
    JSON.stringify(removed.body.notices),
  );
  for (const [method, path, body] of [
    ["GET", `/chats/${id}`, undefined],
    ["PATCH", `/chats/${id}`, { name: "bea" }],
    ["POST", `/chats/${id}/messages`, { text: "one more" }],
    ["POST", `/chats/${id}/turns/current/cancel`, undefined],
    ["GET", `/chats/${id}/events`, undefined],
    ["GET", `/chats/${id}/diff`, undefined],
    ["DELETE", `/chats/${id}`, undefined],
  ] as const) {
    const gone = await api<Refused>(d, method, path, body);
    assert.deepEqual(
      [gone.status, gone.body.error.code],
      [410, "chat_removed"],
      `${method} ${path}`,
    );
  }
  assert.deepEqual((await api<ChatDto[]>(d, "GET", "/chats")).body, []);

  const archive = await api<ArchivedChat[]>(d, "GET", "/chats/archive");
  assert.deepEqual(
    archive.body.map((a) => [a.id, a.name, a.harness]),
    [[id, "bea", "mock-agent"]],
  );
  // The archive's stream is the whole log, read only, and then it ends.
  const all = await frames(d, `/chats/archive/${id}/events`);
  assert.ok(all.length >= chat.seq);
  assert.deepEqual(
    (await frames(d, `/chats/archive/${id}/events`, 2)).map((f) => f.id),
    all.slice(2).map((f) => f.id),
  );
  await rm(join(removed.body.folder, "events.jsonl"));
  const noLog = await api<Refused>(d, "GET", `/chats/archive/${id}/events`);
  assert.deepEqual(
    [noLog.status, noLog.body.error.code],
    [404, "no_event_log"],
  );

  // An id that is not a chat id is never made into a path.
  for (const path of [
    "/chats/nope",
    "/chats/..%2F..%2Fx",
    "/chats/chat-20260101-000000-zzzz",
    "/chats/archive/nope/events",
    "/chats/nope/messages",
  ]) {
    const method = path.endsWith("messages") ? "POST" : "GET";
    const r = await api<Refused>(
      d,
      method,
      path,
      method === "POST" ? { text: "x" } : undefined,
    );
    assert.deepEqual(
      [r.status, r.body.error.code],
      [404, "chat_not_found"],
      path,
    );
  }
});

test("a chat's cancel, model and level, and the chats' scratch folders", async (t) => {
  const d = await bootDaemon(t);
  const state = await realpath(join(d.file, ".."));
  const slow = await api<ChatReply>(d, "POST", "/chats", { cmd: SLOW });
  assert.equal(slow.status, 201, JSON.stringify(slow.body));
  const sid = slow.body.id;
  const folder = slow.body.agent.worktree;
  assert.equal(folder, join(state, "scratch", "chats", slow.body.agent.id));
  // The boot sweep's record names the chat as the harness's owner.
  const children = JSON.parse(
    await readFile(join(d.file, "..", "children.json"), "utf8"),
  ).children as { kind: string; ownerId: string; unitId: string }[];
  assert.ok(
    children.some(
      (c) =>
        c.kind === "chat" &&
        c.ownerId === sid &&
        c.unitId === slow.body.agent.id,
    ),
    JSON.stringify(children),
  );

  const liveMessage = await api<MessageAccepted>(
    d,
    "POST",
    `/chats/${sid}/messages`,
    { text: "wait" },
  );
  assert.equal(liveMessage.status, 202, JSON.stringify(liveMessage.body));
  assert.equal(liveMessage.body.queued, 0);
  for (let i = 1; i <= 16; i++) {
    const queued = await api<MessageAccepted>(
      d,
      "POST",
      `/chats/${sid}/messages`,
      { text: `wait ${i}` },
    );
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    assert.equal(queued.body.queued, i);
  }
  const full = await api<Refused>(d, "POST", `/chats/${sid}/messages`, {
    text: "one too many",
  });
  assert.deepEqual([full.status, full.body.error.code], [429, "queue_full"]);
  const cancelled = await api<ChatReply>(
    d,
    "POST",
    `/chats/${sid}/turns/current/cancel`,
  );
  assert.equal(cancelled.status, 202, JSON.stringify(cancelled.body));
  await chatIdle(d, sid);

  const levels = await api<ChatReply>(d, "POST", "/chats", {
    cmd: `node ${MOCK_AGENT} --scenario levels`,
    name: "lev",
  });
  assert.equal(levels.status, 201, JSON.stringify(levels.body));
  const both = await api<ChatReply>(d, "PATCH", `/chats/${levels.body.id}`, {
    model: "mock/smart",
    thoughtLevel: "max",
  });
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.deepEqual(
    [both.body.agent.model, both.body.agent.thoughtLevel],
    ["mock/smart", "max"],
  );

  const listed = await api<ScratchFolder[]>(d, "GET", "/chats/scratch");
  const mine = listed.body.find((f) => f.path === folder);
  assert.deepEqual(
    [mine?.inUse, mine?.participant],
    [true, slow.body.agent.name],
  );
  const inUse = await api<ScratchCleanReply>(
    d,
    "POST",
    "/chats/scratch/clean",
    {
      ids: [slow.body.agent.id],
    },
  );
  assert.equal(inUse.body.results[0]?.protected, true);
  assert.ok(existsSync(folder));

  // A used scratch folder outlives its chat; then the clean removes it.
  await writeFile(join(folder, "kept.txt"), "work\n");
  assert.equal((await api(d, "DELETE", `/chats/${sid}`)).status, 200);
  const freed = await api<ScratchFolder[]>(d, "GET", "/chats/scratch");
  assert.equal(freed.body.find((f) => f.path === folder)?.inUse, false);
  const cleaned = await api<ScratchCleanReply>(
    d,
    "POST",
    "/chats/scratch/clean",
    {
      ids: [slow.body.agent.id],
    },
  );
  assert.equal(cleaned.body.results[0]?.removed, true);
  assert.equal(existsSync(folder), false);
});

test("of two DELETEs that wait behind a scratch listing, one removes the chat and the other is 410", async (t) => {
  const d = await bootDaemon(t);
  const ann = await api<ChatReply>(d, "POST", "/chats", {
    cmd: REMEMBER,
    name: "ann",
  });
  assert.equal(ann.status, 201, JSON.stringify(ann.body));
  // An add holds the scratch lock while its harness waits at the barrier.
  const barrier = await tempDir(t);
  const add = api<ChatReply>(d, "POST", "/chats", {
    cmd: `node ${MOCK_AGENT} --barrier ${barrier} --barrier-count 2`,
    name: "held",
  });
  await until(
    "the held add's harness",
    async () => (await readdir(barrier)).length === 1,
  );
  // A listing then waits for the add, and both DELETEs wait for the listing.
  const listing = api(d, "GET", "/chats/scratch");
  await new Promise((ok) => setTimeout(ok, 100));
  const deletes = [0, 1].map(() =>
    api<Refused>(d, "DELETE", `/chats/${ann.body.id}`),
  );
  await new Promise((ok) => setTimeout(ok, 100));
  await writeFile(join(barrier, "release.ready"), "");
  assert.equal((await add).status, 201);
  assert.equal((await listing).status, 200);
  const answers = await Promise.all(deletes);
  assert.deepEqual(
    answers.map((r) => r.status).sort(),
    [200, 410],
    JSON.stringify(answers.map((r) => r.body)),
  );
  assert.equal(
    answers.find((r) => r.status === 410)?.body.error.code,
    "chat_removed",
  );
});

test("a chat's change moves updatedAt before its reply", async (t) => {
  const d = await bootDaemon(t);
  const added = await api<ChatDto>(d, "POST", "/chats", {
    cmd: REMEMBER,
    name: "ann",
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));

  const changed = await api<ChatDto>(d, "PATCH", `/chats/${added.body.id}`, {
    name: "bea",
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.ok(
    Date.parse(changed.body.updatedAt) > Date.parse(added.body.updatedAt),
    `${changed.body.updatedAt} is after ${added.body.updatedAt}`,
  );
});

test("a chat whose harness cannot start is 500 chat_open_failed and is archived", async (t) => {
  const d = await bootDaemon(t);
  const failed = await api<Refused>(d, "POST", "/chats", {
    cmd: "definitely-not-a-command",
  });
  assert.deepEqual(
    [failed.status, failed.body.error.code],
    [500, "chat_open_failed"],
  );

  const archive = await api<ArchivedChat[]>(d, "GET", "/chats/archive");
  assert.equal(archive.body.length, 1);
  assert.ok(
    failed.body.error.message.includes(archive.body[0]?.folder ?? ""),
    failed.body.error.message,
  );
});

test("a chat's name is unique across chats under case folding, and two racing adds cannot both take one", async (t) => {
  const d = await bootDaemon(t);
  const ann = await api<ChatReply>(d, "POST", "/chats", {
    cmd: REMEMBER,
    name: "ann",
  });
  assert.equal(ann.status, 201);
  const clash = await api<Refused>(d, "POST", "/chats", {
    cmd: REMEMBER,
    name: "ANN",
  });
  assert.deepEqual([clash.status, clash.body.error.code], [409, "name_taken"]);

  const race = await Promise.all(
    [0, 1].map(() =>
      api<ChatReply>(d, "POST", "/chats", { cmd: REMEMBER, name: "zed" }),
    ),
  );
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    race.find((r) => r.status === 409)?.body.error?.code,
    "name_taken",
  );

  const rename = await api<Refused>(d, "PATCH", `/chats/${ann.body.id}`, {
    name: "Zed",
  });
  assert.deepEqual(
    [rename.status, rename.body.error.code],
    [409, "name_taken"],
  );

  // A removed chat frees its name.
  assert.equal((await api(d, "DELETE", `/chats/${ann.body.id}`)).status, 200);
  const again = await api<ChatReply>(d, "POST", "/chats", {
    cmd: REMEMBER,
    name: "ann",
  });
  assert.equal(again.status, 201, JSON.stringify(again.body));
});

test("a chat's question is {chatId, turn}: answered by a person, then by a mode change", async (t) => {
  const d = await bootDaemon(t);
  const cwd = await addRepo(d, await gitRepo(t));
  const added = await api<ChatReply>(d, "POST", "/chats", {
    cmd: `node ${MOCK_AGENT}`,
    mode: "ask",
    cwd,
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const { id } = added.body;
  await api(d, "POST", `/chats/${id}/messages`, { text: "go" });

  const first = (await pendingOne(d)) as unknown as Record<string, unknown>;
  assert.deepEqual(
    { ...first, id: undefined },
    {
      id: undefined,
      chatId: id,
      turn: 1,
      kind: "edit",
      title: "Write ACP_TEST.md",
      input: { path: "ACP_TEST.md" },
    },
  );
  const allowed = await api(d, "POST", `/permissions/${first.id}`, {
    allow: true,
  });
  assert.equal(allowed.status, 200);

  // The next question waits; leaving `ask` for `auto` answers it.
  let second: { id: string } | undefined;
  await until("a second question", async () => {
    const open = (await api<{ id: string }[]>(d, "GET", "/permissions")).body;
    second = open.find((q) => q.id !== first.id);
    return second !== undefined;
  });
  const changed = await api(d, "PATCH", `/chats/${id}`, { mode: "auto" });
  assert.equal(changed.status, 200);
  const closed = (
    await api<PermissionDecision>(d, "GET", `/permissions/${second?.id}`)
  ).body;
  assert.deepEqual(
    [closed.allow, closed.reason, "chatId" in closed && closed.chatId],
    [true, "mode_change", id],
  );
});

test("a restart keeps every chat, skips a folder with no chat.json or an unreadable record, and archives a chat whose agent is no longer known", async (t) => {
  const runtime = await tempDir(t);
  const stateHome = await tempDir(t);
  const first = await bootDaemon(t, runtime, [], stateHome);
  const state = await realpath(join(stateHome, "kapelle"));
  const root = await realpath(await addRepo(first, await gitRepo(t)));

  const kept = await api<ChatReply>(first, "POST", "/chats", {
    cmd: REMEMBER,
    name: "kept",
    cwd: root,
  });
  const scratch = await api<ChatReply>(first, "POST", "/chats", {
    cmd: REMEMBER,
    name: "loose",
  });
  const retired = await api<ChatReply>(first, "POST", "/chats", {
    cmd: REMEMBER,
    name: "retired",
    cwd: root,
  });
  for (const r of [kept, scratch, retired]) {
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const changed = await api<ChatReply>(
    first,
    "PATCH",
    `/chats/${kept.body.id}`,
    { name: "kept2", mode: "safe" },
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  await api(first, "POST", `/chats/${kept.body.id}/messages`, { text: "hi" });
  const seq = (await chatIdle(first, kept.body.id)).seq;
  await writeFile(join(retired.body.agent.worktree, "work.txt"), "work\n");
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);

  // The saved agent becomes one no registry knows.
  const file = join(state, "chats", retired.body.id, "chat.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  delete record.participant.cmd;
  record.participant.agent = "retired-agent";
  await writeFile(file, JSON.stringify(record));
  // An open whose archive failed leaves a folder with no record.
  await mkdir(join(state, "chats", "chat-20260101-000000-aaaa"));
  // A crash can leave an unreadable record; it is skipped without stopping
  // the chats after it.
  const broken = join(state, "chats", "chat-20260101-000000-bbbb");
  await mkdir(broken);
  await writeFile(join(broken, "chat.json"), "{not json");

  const second = await bootDaemon(t, runtime, [], stateHome);
  const listed = await api<ChatDto[]>(second, "GET", "/chats");
  assert.deepEqual(
    listed.body.map((c) => [c.id, c.agent.name]).sort(),
    [
      [kept.body.id, "kept2"],
      [scratch.body.id, "loose"],
    ].sort(),
  );
  // The log and the change both go on: the pause added its own lines.
  const back = listed.body.find((c) => c.id === kept.body.id);
  assert.ok((back?.seq ?? 0) >= seq, `seq ${back?.seq} after ${seq}`);
  assert.deepEqual([back?.agent.name, back?.agent.mode], ["kept2", "safe"]);
  assert.equal(back?.agent.worktree, kept.body.agent.worktree);

  const clash = await api<Refused>(second, "POST", "/chats", {
    cmd: REMEMBER,
    name: "KEPT2",
  });
  assert.deepEqual([clash.status, clash.body.error.code], [409, "name_taken"]);

  const archive = (await api<ArchivedChat[]>(second, "GET", "/chats/archive"))
    .body;
  assert.equal(archive.length, 1);
  const [gone] = archive;
  assert.equal(gone?.id, retired.body.id);
  const notes = gone?.notices.map((n) => n.text).join("\n") ?? "";
  assert.match(notes, /the agent "retired-agent" is no longer known/);
  assert.match(notes, /is kept: it holds work/);
  assert.ok(existsSync(join(retired.body.agent.worktree, "work.txt")));
  assert.equal(
    (await api<Refused>(second, "GET", `/chats/${retired.body.id}`)).body.error
      .code,
    "chat_removed",
  );

  // The restored chat still takes a message.
  const sent = await api(second, "POST", `/chats/${kept.body.id}/messages`, {
    text: "again",
  });
  assert.equal(sent.status, 202);
  await chatIdle(second, kept.body.id);
  assert.ok(hasBranch(root, kept.body.agent.branch ?? ""));
});

test("a chat's stall warnings follow its repository's config on add and restore, and one with no folder uses the defaults", async (t) => {
  const runtime = await tempDir(t);
  const stateHome = await tempDir(t);
  const first = await bootDaemon(t, runtime, [], stateHome);
  const state = await realpath(join(stateHome, "kapelle"));
  const root = await gitRepo(t);
  const config = join(root, ".kapelle", "config.json");
  // The daemon reads only a private config file.
  await mkdir(join(root, ".kapelle"), { mode: 0o700 });
  await writeFile(config, JSON.stringify({ stallIdleMs: 200 }), {
    mode: 0o600,
  });
  const cwd = await addRepo(first, root);
  const STALL = `node ${MOCK_AGENT} --scenario stall`;
  const inRepo = await api<ChatReply>(first, "POST", "/chats", {
    cmd: STALL,
    name: "repo",
    cwd,
  });
  const loose = await api<ChatReply>(first, "POST", "/chats", {
    cmd: STALL,
    name: "loose",
  });
  for (const chat of [inRepo, loose]) {
    assert.equal(chat.status, 201, JSON.stringify(chat.body));
    await api(first, "POST", `/chats/${chat.body.id}/messages`, {
      text: "hang",
    });
  }
  const warnings = async (id: string) =>
    (await readFile(join(state, "chats", id, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"_client_stall_warning"')).length;
  await until(
    "the repository chat's stall warning",
    async () => (await warnings(inRepo.body.id)) > 0,
    10_000,
  );
  // The default is 300 s, so the chat with no folder, quiet as long, has none.
  assert.equal(await warnings(loose.body.id), 0);

  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = await bootDaemon(t, runtime, [], stateHome);
  const beforeRestart = await warnings(inRepo.body.id);
  await api(second, "POST", `/chats/${inRepo.body.id}/messages`, {
    text: "again",
  });
  await until(
    "the restored repository chat's stall warning",
    async () => (await warnings(inRepo.body.id)) > beforeRestart,
    10_000,
  );
  assert.equal(await warnings(loose.body.id), 0);

  // A config that does not load refuses an add in that repository.
  await writeFile(config, JSON.stringify({ stallIdle: 1 }));
  const bad = await api<Refused>(second, "POST", "/chats", {
    cmd: STALL,
    cwd,
  });
  assert.deepEqual([bad.status, bad.body.error.code], [400, "invalid_config"]);
});
