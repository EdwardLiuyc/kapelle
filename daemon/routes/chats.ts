/**
 * The chat routes (M11-13): `/chats`, each chat, its messages, cancel, diff
 * and stream, the chats' scratch folders, and the archive, read only. It also
 * owns the daemon's one list of chats and the boot's restore of it. A chat
 * itself is `core/chat.ts`. The old hall stays a room until M11-15.
 *
 * **One list for the whole daemon.** There is no hall record until M11-11,
 * so every chat is in it, in boot order and then in the order they were
 * added.
 *
 * **A name is unique across live chats**, under ASCII case folding (R22). An
 * add holds its name from before its harness starts until the chat is in the
 * list or the add failed, so a racing add or rename is told `name_taken`. A
 * chat that is being removed frees its name.
 *
 * **An id is checked before a path is made from it.** `chatDir` and
 * `archivedChatDir` join what they are given, so every route checks
 * `isChatId` first. An unknown id, or one that is not a chat id, is
 * `404 chat_not_found`. A chat being removed, or archived, is
 * `410 chat_removed` on a live route.
 *
 * **The restore** lists `<stateDir>/chats/` once, after the boot sweep has
 * finished each remove a crash left (M11-14). It skips `archive/`, a folder
 * with no `chat.json` (an open whose archive could not be written), and a
 * record it cannot read or restore, each with a stderr line. A chat whose
 * agent is no longer known is archived (`archiveChat`), with a note in its
 * record that names the agent.
 *
 * **A chat's stall warnings follow its repository's config** (R38), as a
 * room's do, read at its add and at each restore. A chat with no folder has
 * no project config, so it uses the defaults. A bad config refuses an add
 * (`400 invalid_config`); a restore warns and uses the defaults.
 *
 * **A shutdown pauses every chat**, which the next boot restores. An add that
 * finishes once the shutdown has begun was never handed out, so it is
 * removed, as an unanswered room create is dismissed (#316).
 */

import { existsSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type {
  ArchivedChat,
  ChatDto,
  Diff,
  MessageAccepted,
  ScratchCleanReply,
  ScratchFolder,
} from "../../client/contract.ts";
import {
  archiveChat,
  archivedChatDir,
  type Chat,
  chatDir,
  chatScratchDir,
  chatsDir,
  openChat,
  readChatRecord,
  restoreChat,
  UnknownAgentError,
} from "../../core/chat.ts";
import { noteSession } from "../../core/check.ts";
import { openEventLog } from "../../core/eventlog.ts";
import { createEventBus } from "../../core/events.ts";
import { isChatId, newChatId } from "../../core/ids.ts";
import type { createPermissionQueue } from "../../core/permissions.ts";
import { RoomRefusal } from "../../core/room/types.ts";
import {
  AGENT_FIELDS,
  participantChanges,
  roomAgent,
} from "../../core/room/validate.ts";
import { stateDirRoot } from "../../core/worktree.ts";
import type { createChildren } from "../children.ts";
import { toArchivedChat, toChatDto } from "../dto.ts";
import { type Route, readBody, refusal, send } from "../http.ts";
import { createScratchLock } from "../rooms.ts";
import { cleanScratch, listScratch } from "../scratch.ts";
import { streamLog } from "../sse.ts";
import {
  agentFolder,
  participantDiff,
  placeOpener,
  stallLimits,
} from "./rooms.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** A chat's add takes a room agent's fields but `role` (`core/chat.ts`).
 *  A field added to `AGENT_FIELDS` reaches chats too, on purpose: a chat's
 *  agent is a room participant's parts. Exclude it here if it is room-only. */
const CHAT_FIELDS = AGENT_FIELDS.filter((field) => field !== "role");

/** What a `PATCH /chats/:id` may change. */
const CHANGE_FIELDS = ["name", "mode", "model", "thoughtLevel"];

/** What the chat routes share with the rest of the app. */
interface ChatRouteDeps {
  repos: ReadonlySet<string>;
  children: ReturnType<typeof createChildren>;
  permissions: ReturnType<typeof createPermissionQueue>;
  /** True once a shutdown has begun: no chat may open or change. */
  stopping: () => boolean;
}

export function chatRoutes({
  repos,
  children,
  permissions,
  stopping,
}: ChatRouteDeps) {
  const chats = new Map<string, Chat>();
  /** The folded names that adds still starting hold. */
  const held = new Set<string>();
  /** The chats a `DELETE` took, from before it waits for the scratch lock:
   *  a second `DELETE` meanwhile is `410`, as for a chat already removing. */
  const removing = new Set<string>();
  /** Each add and remove still running, for the shutdown to wait on. */
  const changes = new Set<Promise<unknown>>();
  const scratch = createScratchLock();

  const shuttingDown = () =>
    refusal(503, "shutting_down", "the daemon is shutting down");

  function track<T>(work: Promise<T>): Promise<T> {
    changes.add(work);
    const done = () => changes.delete(work);
    work.then(done, done);
    return work;
  }

  /** What a chat needs from the daemon. */
  const chatDeps = (id: string) => {
    const bus = createEventBus();
    children.track(bus, "chat", id);
    return {
      bus,
      permissions,
      noteSession,
      openPlace: placeOpener("chat", id),
    };
  };

  /** The stall limits for an agent in `cwd`: its repository's, or none for
   *  the defaults when it has no folder. Throws for a config that does not
   *  load. */
  async function chatLimits(cwd: string | undefined) {
    if (cwd === undefined) return {};
    return { limits: stallLimits((await stateDirRoot(cwd)).root) };
  }

  /** A refusal from a chat as the daemon answers it, or `err` itself when
   *  it is a failure. A shutdown pauses every chat, which then refuses as
   *  removed; the daemon's own reason is the true one. */
  function chatRefused(err: unknown, id: string) {
    if (stopping()) return shuttingDown();
    if (!(err instanceof RoomRefusal)) return err;
    if (err.code === "room_dismissed") {
      return refusal(410, "chat_removed", `chat ${id} is removed`);
    }
    let status = 409;
    if (err.code === "invalid_request" || err.code === "invalid_config") {
      status = 400;
    } else if (err.code === "queue_full") {
      status = 429;
    }
    return refusal(status, err.code, err.message);
  }

  /** The live chat `id` names, or a 404 or a 410. The id is checked before
   *  any path is made from it. */
  function chatOf(id: string): Chat {
    if (!isChatId(id)) {
      throw refusal(404, "chat_not_found", `no chat ${JSON.stringify(id)}`);
    }
    const chat = chats.get(id);
    if (chat?.lifecycle() === "active" && !removing.has(id)) return chat;
    if (chat || existsSync(archivedChatDir(id))) {
      throw refusal(410, "chat_removed", `chat ${id} is removed`);
    }
    throw refusal(404, "chat_not_found", `no chat ${id}`);
  }

  /** Refuses a name another live chat has, or an add still holds. */
  function refuseTaken(name: string, self?: Chat) {
    const folded = name.toLowerCase();
    const taken =
      held.has(folded) ||
      [...chats.values()].some(
        (chat) =>
          chat !== self &&
          chat.lifecycle() === "active" &&
          chat.participant.name.toLowerCase() === folded,
      );
    if (taken) {
      throw refusal(409, "name_taken", `a chat is already named ${name}`);
    }
  }

  /** Every chat's agent keyed by participant id, for the scratch routes. A
   *  chat being removed still owns its folder until its release. */
  const liveScratch = () =>
    new Map(
      [...chats.values()].map(
        (chat) => [chat.participant.id, chat.participant.name] as const,
      ),
    );

  /**
   * `POST /chats {agent | cmd, name?, mode?, model?, thoughtLevel?, base?,
   * settings?, cwd?}` — a new chat, `201` once its agent has a session. With
   * no `cwd`, its agent gets a scratch folder (M11-2).
   */
  async function postChat(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req, CHAT_FIELDS);
    let request: ReturnType<typeof roomAgent>;
    try {
      request = roomAgent(body);
    } catch (err) {
      throw refusal(400, "invalid_request", messageOf(err));
    }
    await agentFolder(repos, request);
    let limits: Awaited<ReturnType<typeof chatLimits>>;
    try {
      limits = await chatLimits(request.cwd);
    } catch (err) {
      throw refusal(400, "invalid_config", messageOf(err));
    }
    if (stopping()) throw shuttingDown();
    refuseTaken(request.name);
    const folded = request.name.toLowerCase();
    held.add(folded);
    const id = newChatId();
    let chat: Chat;
    try {
      chat = await scratch.change(() =>
        openChat({ id, agent: request, ...chatDeps(id), ...limits }),
      );
      if (stopping()) {
        await scratch.change(() => chat.remove());
        throw shuttingDown();
      }
      chats.set(id, chat);
    } catch (err) {
      if (stopping()) throw shuttingDown();
      const refused = chatRefused(err, id);
      throw refused === err
        ? refusal(500, "chat_open_failed", messageOf(err))
        : refused;
    } finally {
      held.delete(folded);
    }
    send(res, 201, toChatDto(chat) satisfies ChatDto);
  }

  /** `PATCH /chats/:id {name?, mode?, model?, thoughtLevel?}`. The mode goes
   *  first, as it is the change a check can still refuse; the model, then
   *  the level, go last, as in a room (M9-6, M9-9). */
  async function patchChat(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const chat = chatOf(id);
    const body = await readBody(req, CHANGE_FIELDS);
    if (CHANGE_FIELDS.every((field) => body[field] === undefined)) {
      throw refusal(
        400,
        "invalid_request",
        'send at least one of "name", "mode", "model" or "thoughtLevel"',
      );
    }
    let changes: ReturnType<typeof participantChanges>;
    try {
      changes = participantChanges(body);
    } catch (err) {
      throw refusal(400, "invalid_request", messageOf(err));
    }
    const { name, mode, model, thoughtLevel } = changes;
    if (name !== undefined) refuseTaken(name, chat);
    try {
      if (mode !== undefined) chat.setMode(mode);
      if (name !== undefined) chat.rename(name);
      if (model !== undefined) await chat.setModel(model);
      if (thoughtLevel !== undefined) await chat.setLevel(thoughtLevel);
    } catch (err) {
      throw chatRefused(err, id);
    }
    send(res, 200, toChatDto(chat) satisfies ChatDto);
  }

  /** `POST /chats/:id/messages {text}` — `202` once the message is on the
   *  chat's log, as a turn that started or one queued behind the live turn.
   *  `seq` and `queued` are as for a room (`MessageAccepted`). */
  async function postMessage(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const chat = chatOf(id);
    const { text } = await readBody(req, ["text"]);
    if (typeof text !== "string" || !text.trim()) {
      throw refusal(
        400,
        "invalid_request",
        '"text" must be a non-empty string',
      );
    }
    const p = chat.participant;
    const seq = chat.eventLog?.size ?? 0;
    const queued = p.status() === "busy" ? p.queued + 1 : 0;
    let turn: Promise<void>;
    try {
      turn = p.send(text);
    } catch (err) {
      throw chatRefused(err, id);
    }
    // Settles with the turn; a failed turn is already on the log as an event.
    turn.catch(() => {});
    send(res, 202, { seq, queued } satisfies MessageAccepted);
  }

  /** `DELETE /chats/:id` — the remove (`core/chat.ts`), then the archived
   *  chat, whose notices name a checkout the remove kept. */
  async function deleteChat(id: string, res: ServerResponse) {
    const chat = chatOf(id);
    if (stopping()) throw shuttingDown();
    removing.add(id);
    try {
      await scratch.change(() => chat.remove());
    } catch (err) {
      throw chatRefused(err, id);
    } finally {
      removing.delete(id);
    }
    chats.delete(id);
    const folder = archivedChatDir(id);
    const record = readChatRecord(join(folder, "chat.json"), id);
    send(res, 200, toArchivedChat(record, folder) satisfies ArchivedChat);
  }

  /** `GET /chats/:id/events` — the chat's log, then its live tail, until
   *  the chat is removed or paused. `Last-Event-ID` is the chat's `seq`. */
  async function chatEvents(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const log = chatOf(id).eventLog;
    if (!log) throw refusal(404, "no_event_log", `chat ${id} has no event log`);
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    await streamLog(log, req, res, gone.signal);
  }

  /** `GET /chats/archive` — every archived chat, oldest id first. One whose
   *  record cannot be read is left out, with a stderr line. */
  function listArchive(res: ServerResponse) {
    const dir = join(chatsDir(), "archive");
    let ids: string[];
    try {
      ids = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      ids = [];
    }
    const list: ArchivedChat[] = [];
    for (const id of ids.filter(isChatId).sort((a, b) => a.localeCompare(b))) {
      const folder = archivedChatDir(id);
      try {
        list.push(
          toArchivedChat(readChatRecord(join(folder, "chat.json"), id), folder),
        );
      } catch (err) {
        console.error(`leaving out archived chat ${folder}: ${messageOf(err)}`);
      }
    }
    send(res, 200, list satisfies ArchivedChat[]);
  }

  /** `GET /chats/archive/:id/events` — an archived chat's log, read only.
   *  The stream ends after its last line. */
  async function archiveEvents(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const folder = isChatId(id) ? archivedChatDir(id) : undefined;
    if (!folder || !existsSync(join(folder, "chat.json"))) {
      throw refusal(
        404,
        "chat_not_found",
        `no archived chat ${JSON.stringify(id)}`,
      );
    }
    let log: Awaited<ReturnType<typeof openEventLog>>;
    try {
      log = await openEventLog(join(folder, "events.jsonl"));
    } catch {
      throw refusal(404, "no_event_log", `chat ${id} has no event log`);
    }
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    await streamLog(log, req, res, gone.signal);
  }

  /** `POST /chats/scratch/clean {"ids": [...]}` — as the hall's (M11-2):
   *  each named folder no chat owns is removed, each with its own result. */
  async function postScratchClean(req: IncomingMessage, res: ServerResponse) {
    const { ids } = await readBody(req, ["ids"]);
    if (
      !Array.isArray(ids) ||
      ids.some((value) => typeof value !== "string" || value === "")
    ) {
      throw refusal(
        400,
        "invalid_request",
        '"ids" must be an array of non-empty strings',
      );
    }
    const results = await scratch.snapshot(() =>
      cleanScratch(
        chatScratchDir(),
        [...new Set(ids as string[])],
        liveScratch(),
      ),
    );
    send(res, 200, { results } satisfies ScratchCleanReply);
  }

  /** Every live chat back from its `chat.json` (see the file header). */
  async function restore(): Promise<void> {
    let ids: string[];
    try {
      ids = readdirSync(chatsDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`skipping chats under ${chatsDir()}: ${messageOf(err)}`);
      }
      return;
    }
    for (const id of ids.sort((a, b) => a.localeCompare(b))) {
      if (id === "archive") continue;
      if (!isChatId(id)) {
        console.error(`skipping ${join(chatsDir(), id)}: not a chat id`);
        continue;
      }
      const dir = chatDir(id);
      if (!existsSync(join(dir, "chat.json"))) {
        console.error(`skipping chat folder ${dir}: it has no chat.json`);
        continue;
      }
      try {
        const { cwd } = readChatRecord(join(dir, "chat.json"), id).participant;
        const limits = await chatLimits(cwd).catch((err) => {
          console.error(
            `chat ${id}: ${messageOf(err)}; using the default limits`,
          );
          return {};
        });
        chats.set(id, await restoreChat({ id, ...chatDeps(id), ...limits }));
      } catch (err) {
        if (err instanceof UnknownAgentError) {
          await archiveUnknown(id, err.message);
        } else {
          console.error(`skipping chat ${dir}: ${messageOf(err)}`);
        }
      }
    }
  }

  /** Archives a chat whose agent is no longer known, and says so. A throw
   *  leaves it `removing`, for the next boot's sweep to finish. */
  async function archiveUnknown(id: string, note: string) {
    try {
      const lines = await archiveChat(id, note, {
        openPlace: placeOpener("chat", id),
      });
      console.error(`chat ${id}: ${note}, in ${archivedChatDir(id)}`);
      for (const line of lines) console.error(`chat ${id}: ${line.text}`);
    } catch (err) {
      console.error(
        `chat ${id}: ${note}; cannot archive it: ${messageOf(err)}`,
      );
    }
  }

  // `scratch` and `archive` are never a chat id, so the rows for one chat
  // leave them out: no two rows match one request.
  const ONE = "(?!scratch$|archive$)([^/]+)";
  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/chats$/,
      handler: ({ req, res }) => track(postChat(req, res)),
    },
    {
      method: "GET",
      pattern: /^\/chats$/,
      handler: ({ res }) =>
        send(
          res,
          200,
          [...chats.values()]
            .filter((chat) => chat.lifecycle() === "active")
            .map(toChatDto) satisfies ChatDto[],
        ),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/chats/${ONE}$`),
      handler: ({ res, params: [id] }) =>
        send(res, 200, toChatDto(chatOf(id)) satisfies ChatDto),
    },
    {
      method: "PATCH",
      pattern: new RegExp(`^/chats/${ONE}$`),
      handler: ({ req, res, params: [id] }) => patchChat(id, req, res),
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^/chats/${ONE}$`),
      handler: ({ res, params: [id] }) => track(deleteChat(id, res)),
    },
    {
      method: "POST",
      pattern: /^\/chats\/([^/]+)\/messages$/,
      handler: ({ req, res, params: [id] }) => postMessage(id, req, res),
    },
    {
      method: "POST",
      pattern: /^\/chats\/([^/]+)\/turns\/current\/cancel$/,
      handler: ({ res, params: [id] }) => {
        const chat = chatOf(id);
        if (!chat.participant.cancel()) {
          throw refusal(
            409,
            "no_turn",
            `${chat.participant.name} has no live prompt to cancel`,
          );
        }
        send(res, 202, toChatDto(chat) satisfies ChatDto);
      },
    },
    {
      method: "GET",
      pattern: /^\/chats\/([^/]+)\/events$/,
      handler: ({ req, res, params: [id] }) => chatEvents(id, req, res),
    },
    {
      method: "GET",
      pattern: /^\/chats\/([^/]+)\/diff$/,
      handler: async ({ res, query, params: [id] }) =>
        send(
          res,
          200,
          (await participantDiff(
            chatOf(id).participant,
            query.get("against"),
          )) satisfies Diff,
        ),
    },
    {
      method: "GET",
      pattern: /^\/chats\/scratch$/,
      handler: async ({ res }) =>
        send(
          res,
          200,
          (await scratch.snapshot(() =>
            listScratch(chatScratchDir(), liveScratch()),
          )) satisfies ScratchFolder[],
        ),
    },
    {
      method: "POST",
      pattern: /^\/chats\/scratch\/clean$/,
      handler: ({ req, res }) => postScratchClean(req, res),
    },
    {
      method: "GET",
      pattern: /^\/chats\/archive$/,
      handler: ({ res }) => listArchive(res),
    },
    {
      method: "GET",
      pattern: /^\/chats\/archive\/([^/]+)\/events$/,
      handler: ({ req, res, params: [id] }) => archiveEvents(id, req, res),
    },
  ];

  return {
    routes,
    restore,
    /** What a shutdown waits on: each add and remove, and each pause.
     *  Settled, not resolved: a refused add is still done. */
    stop: () =>
      Promise.allSettled([
        ...changes,
        ...[...chats.values()].map((chat) => chat.pause()),
      ]),
  };
}
