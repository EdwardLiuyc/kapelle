/**
 * The room routes (M12-7b): `/rooms`, each room, its participants, their
 * messages, turns, diffs and fast-forwards, the hall's scratch folders, and
 * the room log streams. It also owns what builds a room: the boot's restore,
 * the hall (M11-1) and a dismissed room built on first use (#451), because a
 * route and a restore build a room the same way.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type {
  DeletePreview,
  Diff,
  MessageAccepted,
  ParticipantDto,
  RoomDto,
  RoomListEntry,
  ScratchCleanReply,
  ScratchFolder,
} from "../../client/contract.ts";
import { noteSession } from "../../core/check.ts";
import {
  readProjectLinkPaths,
  resolveOrchestratorTurnCap,
  resolveRunDefaults,
} from "../../core/config.ts";
import {
  checkoutDiff,
  isAncestor,
  mergeBase,
  rangeDiff,
} from "../../core/diff.ts";
import { createEventBus } from "../../core/events.ts";
import { HALL_ID, newRoomId } from "../../core/ids.ts";
import type { createPermissionQueue } from "../../core/permissions.ts";
import {
  AGENT_FIELDS,
  openRoom,
  participantChanges,
  type Room,
  type RoomRecord,
  RoomRefusal,
  readRoomRecord,
  restoreRoom,
  roomAgent,
  roomAgents,
  roomFile,
} from "../../core/room.ts";
import { stateDir, stateDirFor } from "../../core/runtime.ts";
import { removeRoom, roomDeletePreview, roomWork } from "../../core/sweep.ts";
import { WATCHDOG_DEFAULTS, type WatchdogLimits } from "../../core/watchdog.ts";
import {
  LinkPathError,
  openWorktrees,
  stateDirRoot,
  validateWorktreeLinks,
  type WorktreeSetup,
} from "../../core/worktree.ts";
import type { createChildren } from "../children.ts";
import { toParticipantDto, toRoomDto } from "../dto.ts";
import { existingDir, type Route, readBody, refusal, send } from "../http.ts";
import {
  createRooms,
  createScratchLock,
  hallDir,
  type RoomEntry,
} from "../rooms.ts";
import { cleanScratch, listScratch } from "../scratch.ts";
import { streamLog } from "../sse.ts";
import { refuseUnadded } from "./repos.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Where the hall keeps each participant's scratch folder. */
function hallScratchDir(): string {
  return join(stateDir(), "scratch", HALL_ID);
}

/** What the room routes share with the rest of the app. */
interface RoomRouteDeps {
  repos: ReadonlySet<string>;
  children: ReturnType<typeof createChildren>;
  permissions: ReturnType<typeof createPermissionQueue>;
  /** True once a shutdown has begun: no room may open or change. */
  stopping: () => boolean;
}

/** The routes, the rooms they serve (a shutdown pauses them), and the boot's
 *  restore: the hall first, so `GET /rooms` lists it first, then every added
 *  repository's rooms. */
export function roomRoutes({
  repos,
  children,
  permissions,
  stopping,
}: RoomRouteDeps) {
  const scratch = createScratchLock();

  /** A dismissed room is built on first use (#451), and one that cannot be
   *  built is skipped then, with the notice the boot prints. */
  const rooms = createRooms(async (id, { record, root }) => {
    try {
      return await buildRestored(root, id, record);
    } catch (err) {
      console.error(`skipping room ${roomFile(root, id)}: ${messageOf(err)}`);
      return undefined;
    }
  });

  /** The watchdog's warn limits for a room, from the same layers as a run's
   *  (R38). Throws for a config that does not load. */
  function roomLimits(
    root: string,
  ): Pick<WatchdogLimits, "stallIdleMs" | "stallRepeatCount"> {
    const defaults = resolveRunDefaults(root);
    return {
      stallIdleMs: defaults.stallIdleMs ?? WATCHDOG_DEFAULTS.stallIdleMs,
      stallRepeatCount:
        defaults.stallRepeatCount ?? WATCHDOG_DEFAULTS.stallRepeatCount,
    };
  }

  /**
   * Every added repository's rooms, back from `room.json` (M6-7a). The boot
   * sweep ran first, so a room a crash left live already reads `paused`. No
   * harness starts: a participant revives on its next message. A record that
   * cannot be read, or a room that cannot be built, is skipped with a notice
   * naming it, as for runs: a daemon that refused to boot over one could not
   * be reached by the request that fixes it. Its checkouts stay on disk.
   *
   * **A dismissed room is only read** (#451): its record is kept, and the room
   * is built on first use (`daemon/rooms.ts`). Dismissed rooms stay for the
   * whole retention window, so building each one at boot made the boot grow
   * with every room closed; #451 has the measurement.
   *
   * **The repository's checks run once per boot, not per room** (#322): the
   * links and the limits are read for its first room to build and shared by
   * the rest. A dismissed room built later checks again: the config may have
   * changed since the boot.
   */
  async function restoreRooms(): Promise<void> {
    for (const root of repos) {
      let shared: Promise<RoomPreflight> | undefined;
      const dir = join(stateDirFor(root), "rooms");
      let ids: string[];
      try {
        ids = readdirSync(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`skipping rooms under ${dir}: ${messageOf(err)}`);
        }
        continue;
      }
      for (const id of ids) {
        const path = roomFile(root, id);
        // A directory with no record is a room that never opened.
        if (!existsSync(path)) continue;
        if (id === HALL_ID) {
          console.error(`skipping room ${path}: ${HALL_ID} is the hall's id`);
          continue;
        }
        try {
          const record = readRoomRecord(path);
          if (record.id !== id) throw new Error(`its id is not ${id}`);
          if (record.status === "dismissed") {
            rooms.defer(id, { record, root });
          } else {
            shared ??= roomPreflight(root, `rooms in ${root}`);
            rooms.set(id, await buildRestored(root, id, record, await shared));
          }
        } catch (err) {
          console.error(`skipping room ${path}: ${messageOf(err)}`);
        }
      }
    }
  }

  /**
   * The operator's hall (M11-1, D1): a room in a folder the daemon owns,
   * `<stateDir>/hall`, kept across restarts. Its own setup has no git: it is
   * built here, not by `openWorktrees`, so a home folder that is itself a
   * repository cannot give the hall branches. Since M11-2 an agent works in a
   * scratch folder of its own, or in the folder it picked, with a branch when
   * that is a repository; one added before works in the hall's folder. It
   * opens before `restoreRooms`, so `GET /rooms` lists it first. A hall that
   * cannot open is skipped with a notice, as a room is: the daemon still boots.
   */
  async function openHall(): Promise<void> {
    const cwd = hallDir();
    try {
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      // M11-2: an agent with no `cwd` gets a scratch folder, so none of them
      // works in the hall's folder itself. The notice is for the older ones.
      const setup: WorktreeSetup = {
        worktrees: null,
        root: cwd,
        notice:
          `the hall's agents all work in ${cwd}, with no git, so agents ` +
          `that touch the same files will collide.`,
      };
      const bus = createEventBus();
      children.track(bus, "room", HALL_ID);
      const deps = {
        setup,
        bus,
        permissions,
        noteSession,
        scratchDir: hallScratchDir(),
        openPlace: placeOpener(HALL_ID),
      };
      const path = roomFile(cwd, HALL_ID);
      let room: Room;
      if (existsSync(path)) {
        const record = readRoomRecord(path);
        if (record.id !== HALL_ID) {
          throw new Error(`its id is not ${HALL_ID}`);
        }
        if (record.cwd !== cwd) throw new Error(`its cwd is not ${cwd}`);
        if (record.status === "dismissed") throw new Error("it is dismissed");
        if (record.participants.some((p) => p.role === "orchestrator")) {
          throw new Error("it has an orchestrator");
        }
        // M11-2: an agent with its own folder works there. One without works
        // in its scratch folder, or, added before M11-2, in the hall's.
        const own = record.participants.filter((p) => p.cwd === undefined);
        const where = (p: (typeof own)[number]) =>
          p.scratch ? join(deps.scratchDir, p.id) : cwd;
        const outside = own.find((p) => p.worktree !== where(p));
        if (outside) {
          throw new Error(
            `${outside.name}'s worktree is not ${where(outside)}`,
          );
        }
        if (own.some((p) => p.branch !== undefined)) {
          throw new Error("a participant has a branch");
        }
        room = await restoreRoom({ record, ...deps });
      } else {
        room = await openRoom({
          roomId: HALL_ID,
          cwd,
          title: "hall",
          agents: [],
          ...deps,
        });
      }
      rooms.set(HALL_ID, { room, state: room.meta, root: cwd });
    } catch (err) {
      console.error(`skipping the hall in ${cwd}: ${messageOf(err)}`);
    }
  }

  /**
   * Opens a participant's own folder for room `roomId` (M11-2), as `postRoom`
   * opens the room's: the project's links checked, then `openWorktrees`. A
   * bad link config refuses an add, and a restore opens without links.
   */
  function placeOpener(roomId: string) {
    return async (cwd: string, restoring: boolean): Promise<WorktreeSetup> => {
      const { root } = await stateDirRoot(cwd);
      let linkPaths: string[] = [];
      try {
        linkPaths = readProjectLinkPaths(root);
        await validateWorktreeLinks(root, linkPaths);
      } catch (err) {
        if (!restoring) throw new RoomRefusal("invalid_config", messageOf(err));
        console.error(
          `room ${roomId}: ${messageOf(err)}; opening ${cwd} without links`,
        );
        linkPaths = [];
      }
      return openWorktrees(cwd, roomId, {
        linkPaths,
        linksChecked: true,
        advisory: false,
      });
    };
  }

  /** An agent's own folder (M11-2), real and absolute, inside an added
   *  repository, as `POST /rooms` checks its `cwd`. */
  async function agentFolder(request: { cwd?: string }) {
    if (request.cwd === undefined) return;
    request.cwd = existingDir(request.cwd, "cwd");
    await refuseUnadded(repos, request.cwd);
  }

  /** The hall's one refusal for a dismiss, a delete and its preview. */
  function refuseHall(id: string) {
    if (id === HALL_ID) {
      throw refusal(
        409,
        "hall_permanent",
        "the hall cannot be dismissed or deleted",
      );
    }
  }

  /** The hall has no orchestrator (D1), so no agent in it can take the role:
   *  a message with no `@name` must stay refused. */
  function refuseHallOrchestrator(id: string, role: unknown) {
    if (id === HALL_ID && role === "orchestrator") {
      throw refusal(400, "invalid_request", "the hall has no orchestrator");
    }
  }

  /** What a restored room reads from its repository's config. Never throws. */
  interface RoomPreflight {
    /** Shared by every room of the repository at boot, so never changed. */
    linkPaths: readonly string[];
    roomNotice?: string;
    limits?: ReturnType<typeof roomLimits>;
    turnCap?: number;
  }

  /** The checks a restored room needs from `root`. A config error is
   *  tolerated, as the other restore errors are: the room still opens, without
   *  links or with the default limits, and `label` names it on stderr. */
  async function roomPreflight(
    root: string,
    label: string,
  ): Promise<RoomPreflight> {
    const preflight: RoomPreflight = { linkPaths: [] };
    try {
      const listed = readProjectLinkPaths(root);
      await validateWorktreeLinks(root, listed);
      preflight.linkPaths = listed;
      // The room still opens without links; this is the restore fallback.
      // pi-lens-ignore: missing-error-propagation
    } catch (err) {
      preflight.roomNotice = `${messageOf(err)}; the room opened without its links`;
      console.error(
        `${label}: ${messageOf(err)}; opening without linked paths`,
      );
    }
    try {
      preflight.limits = roomLimits(root);
      preflight.turnCap = resolveOrchestratorTurnCap(root);
    } catch (err) {
      console.error(
        `${label}: ${messageOf(err)}; using the default room limits`,
      );
    }
    return preflight;
  }

  /** One room back from its record, at boot or, for a dismissed one, on first
   *  use. `preflight` is the boot's shared one; a first-use build reads its
   *  own. Throws for a room that cannot be built. */
  async function buildRestored(
    root: string,
    id: string,
    record: RoomRecord,
    preflight?: RoomPreflight,
  ): Promise<RoomEntry> {
    const { linkPaths, roomNotice, limits, turnCap } =
      preflight ?? (await roomPreflight(root, `room ${id}`));
    // The preflight checked the links, and a room never shows the dirty-tree
    // advisory, so its `git status` is skipped (#322).
    const setup = await openWorktrees(
      existsSync(record.cwd) ? record.cwd : root,
      id,
      { linkPaths, linksChecked: true, advisory: false },
    );
    if (setup.root !== root) {
      throw new Error(`${record.cwd} is no longer inside ${root}`);
    }
    const bus = createEventBus();
    children.track(bus, "room", id);
    const room = await restoreRoom({
      record,
      setup,
      bus,
      permissions,
      noteSession,
      openPlace: placeOpener(id),
      ...(limits && { limits }),
      ...(turnCap !== undefined && { turnCap }),
      ...(roomNotice && { roomNotice }),
    });
    return {
      room,
      state: room.meta,
      root,
      ...(room.status() === "dismissed" && { dismissed: true }),
    };
  }

  /** A room's own refusal as the daemon answers it, or undefined when `err`
   *  is a failure rather than a refusal. */
  function roomRefused(err: unknown) {
    if (!(err instanceof RoomRefusal)) return undefined;
    const status =
      err.code === "invalid_request" || err.code === "invalid_config"
        ? 400
        : err.code === "participant_not_found"
          ? 404
          : err.code === "queue_full" || err.code === "turn_cap"
            ? 429
            : 409;
    return refusal(status, err.code, err.message);
  }

  /**
   * `POST /rooms {cwd, title?, agents?: [agent]}` — a room, empty or with
   * agents added in order, kept until it is dismissed (M6-2). An agent is what
   * `POST /rooms/:id/agents` takes. The
   * refusals keep `POST /runs`'s order — not added (403), then a bad request
   * (400) — and the answer waits for every harness's session, so a harness
   * that cannot start is this request's error, not a dead participant (S13).
   * An agent's `mode` is `auto` unless it names `ask` or `safe` (R12, M6-5).
   */
  async function postRoom(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req, ["cwd", "title", "agents"]);
    const cwd = existingDir(body.cwd, "cwd");
    const root = await refuseUnadded(repos, cwd);

    // No length cap beyond the 4 MiB body limit, the same as a message.
    if (
      body.title !== undefined &&
      (typeof body.title !== "string" || !body.title.trim())
    ) {
      throw refusal(
        400,
        "invalid_request",
        '"title" must be a non-empty string',
      );
    }
    let agents: ReturnType<typeof roomAgents>;
    try {
      agents = roomAgents(body.agents);
    } catch (err) {
      throw roomRefused(err) ?? refusal(400, "invalid_request", messageOf(err));
    }
    for (const agent of agents) await agentFolder(agent);

    let linkPaths: string[];
    try {
      linkPaths = readProjectLinkPaths(root);
    } catch (err) {
      throw refusal(400, "invalid_config", messageOf(err));
    }
    try {
      await validateWorktreeLinks(root, linkPaths);
    } catch (err) {
      if (err instanceof LinkPathError) {
        throw refusal(400, "invalid_config", messageOf(err));
      }
      throw err;
    }

    const id = newRoomId();
    // No 409 wrapper (#129): since the state directory moved out of the
    // repository, `openWorktrees` throws for nothing a repository can be in.
    // The links were checked above, so it plans none and throws no
    // `LinkPathError`; a room never shows the advisory (#322).
    const setup = await openWorktrees(cwd, id, {
      linkPaths,
      linksChecked: true,
      advisory: false,
    });
    let limits: ReturnType<typeof roomLimits>;
    let turnCap: number | undefined;
    try {
      limits = roomLimits(setup.root);
      turnCap = resolveOrchestratorTurnCap(setup.root);
    } catch (err) {
      throw refusal(400, "invalid_config", messageOf(err));
    }
    if (stopping()) {
      throw refusal(503, "shutting_down", "the daemon is shutting down");
    }

    const bus = createEventBus();
    // A room's bus names each event by participant id, so that is the
    // `unitId` the sweep records.
    children.track(bus, "room", id);
    let room: Room;
    try {
      room = await openRoom({
        roomId: id,
        cwd,
        ...(typeof body.title === "string" && { title: body.title.trim() }),
        agents,
        setup,
        bus,
        permissions,
        noteSession,
        openPlace: placeOpener(id),
        limits,
        turnCap,
      });
    } catch (err) {
      throw (
        roomRefused(err) ?? refusal(500, "room_open_failed", messageOf(err))
      );
    }
    // A shutdown that began while this room was starting has already paused
    // every room it knew of; this one was never handed out. Dismiss it, then
    // forget it: a room the client never got must not come back, and must
    // leave no folder that no record names.
    if (stopping()) {
      await room.dismiss();
      room.forget();
      throw refusal(503, "shutting_down", "the daemon is shutting down");
    }
    rooms.set(id, { room, state: room.meta, root: setup.root });
    send(res, 201, toRoomDto(room.meta, room) satisfies RoomDto);
  }

  /** A deleted room answers 410 on the two reads a follower reconciles with.
   *  Participant-scoped streams keep the ordinary unknown-room 404. */
  function refuseDeleted(id: string) {
    if (rooms.deleted.has(id)) {
      throw refusal(410, "room_deleted", `room ${id} was deleted`);
    }
  }

  /** The room `id` names, built if it was not, or a 404. */
  async function roomEntry(id: string) {
    const entry = await rooms.get(id);
    if (!entry) throw refusal(404, "room_not_found", `no room ${id}`);
    return entry;
  }

  /**
   * `POST /rooms/:id/agents {agent | cmd, name?, role?, mode?, model?,
   * thoughtLevel?, base?, settings?}` — one more participant (M6-3). 201 once
   * its harness has a session, as for `POST /rooms` (S13).
   */
  async function postAgent(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const entry = await roomEntry(id);
    const body = await readBody(req, AGENT_FIELDS);
    let request: ReturnType<typeof roomAgent>;
    try {
      request = roomAgent(body);
    } catch (err) {
      throw roomRefused(err) ?? refusal(400, "invalid_request", messageOf(err));
    }
    refuseHallOrchestrator(id, request.role);
    await agentFolder(request);
    const shuttingDown = () =>
      refusal(503, "shutting_down", "the daemon is shutting down");
    if (stopping()) throw shuttingDown();
    let participant: Awaited<ReturnType<Room["add"]>>;
    try {
      const add = () => entry.room.add(request);
      participant = id === HALL_ID ? await scratch.change(add) : await add();
    } catch (err) {
      // A shutdown pauses the room under the add, which then reads as
      // dismissed; the daemon's own reason is the true one.
      if (stopping()) throw shuttingDown();
      throw (
        roomRefused(err) ?? refusal(500, "room_open_failed", messageOf(err))
      );
    }
    entry.room.touch();
    send(res, 201, toParticipantDto(participant) satisfies ParticipantDto);
  }

  /** What a refused change to a room answers. A shutdown pauses the room,
   *  which then refuses every change as dismissed; the daemon's own reason is
   *  the true one, and the room comes back after the restart. */
  function changeRefused(err: unknown) {
    if (stopping()) {
      return refusal(503, "shutting_down", "the daemon is shutting down");
    }
    return roomRefused(err) ?? err;
  }

  /** `PATCH /rooms/:id/agents/:agentId {name?, mode?, role?, model?,
   *  thoughtLevel?}` — the one route that changes a participant (R10, R44).
   *  `role: null` clears the role. The model, then the level, go last, after
   *  every other change is checked and made: an idle harness answers before
   *  the reply, a busy one hears of it before its next turn (M9-6, M9-9). */
  async function patchAgent(
    id: string,
    agentId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const entry = await roomEntry(id);
    const body = await readBody(req, [
      "name",
      "mode",
      "role",
      "model",
      "thoughtLevel",
    ]);
    let changes: ReturnType<typeof participantChanges>;
    try {
      changes = participantChanges(body);
    } catch (err) {
      throw refusal(400, "invalid_request", messageOf(err));
    }
    refuseHallOrchestrator(id, changes.role);
    const { model, thoughtLevel, ...rest } = changes;
    let participant: ReturnType<Room["update"]> | undefined;
    try {
      if (Object.keys(rest).length)
        participant = entry.room.update(agentId, rest);
      if (model !== undefined) {
        participant = await entry.room.setModel(agentId, model);
      }
      // After the model: the level list belongs to it (M9-9).
      if (thoughtLevel !== undefined) {
        participant = await entry.room.setLevel(agentId, thoughtLevel);
      }
    } catch (err) {
      throw changeRefused(err);
    }
    // `participantChanges` refuses a body with no change, so this is only a
    // guard: a refusal, as every other one on this route.
    if (!participant)
      throw refusal(400, "invalid_request", "no change to make");
    entry.room.touch();
    send(res, 200, toParticipantDto(participant) satisfies ParticipantDto);
  }

  /** `PATCH /rooms/:id {title?, turnCap?}` — a new title, or a higher
   *  orchestrator turn cap. Answers the room. */
  async function patchRoom(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const entry = await roomEntry(id);
    const body = await readBody(req, ["title", "turnCap"]);
    const { title, turnCap } = body;
    if (title === undefined && turnCap === undefined) {
      throw refusal(400, "invalid_request", "no change to make");
    }
    if (title !== undefined && (typeof title !== "string" || !title.trim())) {
      throw refusal(
        400,
        "invalid_request",
        '"title" must be a non-empty string',
      );
    }
    if (
      turnCap !== undefined &&
      (typeof turnCap !== "number" || !Number.isInteger(turnCap) || turnCap < 1)
    ) {
      throw refusal(
        400,
        "invalid_request",
        '"turnCap" must be a whole number 1 or greater',
      );
    }
    if (turnCap !== undefined && turnCap <= entry.room.meta.turnCap) {
      throw refusal(
        400,
        "invalid_request",
        `"turnCap" must be greater than the room's current cap (${entry.room.meta.turnCap})`,
      );
    }
    try {
      if (title !== undefined) entry.room.retitle(title.trim());
      if (turnCap !== undefined) entry.room.raiseTurnCap(turnCap);
    } catch (err) {
      throw changeRefused(err);
    }
    entry.room.touch();
    send(res, 200, toRoomDto(entry.state, entry.room) satisfies RoomDto);
  }

  /** The live hall roster keyed by participant id, for the scratch routes. */
  function liveScratch(room: Room): Map<string, string> {
    return new Map(room.participants.map((p) => [p.id, p.name] as const));
  }

  /** `GET /rooms/:id/scratch` — every entry under the hall's scratch root,
   *  with its live owner when it has one. Only the hall has scratch folders. */
  async function getScratch(id: string, res: ServerResponse) {
    const entry = await roomEntry(id);
    if (id !== HALL_ID) {
      throw refusal(
        400,
        "invalid_request",
        "only the hall has scratch folders",
      );
    }
    const folders = await scratch.snapshot(() =>
      listScratch(hallScratchDir(), liveScratch(entry.room)),
    );
    send(res, 200, folders satisfies ScratchFolder[]);
  }

  /** `POST /rooms/:id/scratch/clean {"ids": [...]}` — remove the named stale
   *  folders. Each id gets its own result, so one failure does not stop the
   *  others. The snapshot is taken under the scratch lock, so the roster cannot
   *  change while the clean runs. */
  async function postScratchClean(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const entry = await roomEntry(id);
    if (id !== HALL_ID) {
      throw refusal(
        400,
        "invalid_request",
        "only the hall has scratch folders",
      );
    }
    const body = await readBody(req, ["ids"]);
    const ids = body.ids;
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
        hallScratchDir(),
        [...new Set(ids as string[])],
        liveScratch(entry.room),
      ),
    );
    send(res, 200, { results } satisfies ScratchCleanReply);
  }

  /** `DELETE /rooms/:id/agents/:agentId` — cancels the participant's turn,
   *  stops its harness and keeps its work, as a dismiss does (R37). Answers
   *  the room, without it. */
  async function deleteAgent(id: string, agentId: string, res: ServerResponse) {
    const entry = await roomEntry(id);
    try {
      const remove = () => entry.room.remove(agentId);
      if (id === HALL_ID) await scratch.change(remove);
      else await remove();
    } catch (err) {
      throw changeRefused(err);
    }
    entry.room.touch();
    send(res, 200, toRoomDto(entry.state, entry.room) satisfies RoomDto);
  }

  /** The participant `agentId` names in room `id`, or a 404. */
  async function participantEntry(id: string, agentId: string) {
    return participantOf(await roomEntry(id), agentId);
  }

  /** The participant `agentId` names in a room already looked up, or a 404. */
  function participantOf({ room }: RoomEntry, agentId: string) {
    const found = room.participants.find((p) => p.id === agentId);
    if (!found) {
      throw refusal(404, "participant_not_found", `no participant ${agentId}`);
    }
    return found;
  }

  /**
   * `POST /rooms/:id/agents/:agentId/messages {text}` — one message to the
   * participant it names; `POST /rooms/:id/messages {text}` (no `agentId`) —
   * one to the room's orchestrator (R7a). The daemon never reads the text: a
   * client turns `@name` into the id (R43). 202 once the message is on the
   * room's log, as a turn that started or as one queued behind the live turn
   * (R32a); a full queue is `429` (R41). `seq` is the log's size before the
   * message, and `queued` is how many turns come first, so a client knows
   * which `_client_turn_ended` is its answer.
   *
   * The nested route also takes `from`: the id of the room's orchestrator,
   * which sent the message (M8-1). No `from` means the person. One operator
   * and one token (K6), so `from` is trusted as the rest of the body is; only
   * a sender that is not the orchestrator, or the orchestrator to itself, is
   * `invalid_sender`. Each accepted orchestrator message counts toward the
   * room's cap; the next one at the cap is `429 turn_cap` (M8-7). The room-wide
   * route goes to the orchestrator, which never sends to itself, so `from`
   * stays an unknown field there.
   */
  async function postMessage(
    id: string,
    agentId: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const entry = await roomEntry(id);
    const { text, from } = await readBody(
      req,
      agentId === undefined ? ["text"] : ["text", "from"],
    );
    if (typeof text !== "string" || !text.trim()) {
      throw refusal(
        400,
        "invalid_request",
        '"text" must be a non-empty string',
      );
    }
    if (from !== undefined && typeof from !== "string") {
      throw refusal(400, "invalid_request", '"from" must be a string');
    }
    if (entry.room.status() === "dismissed") {
      throw refusal(409, "room_dismissed", `room ${id} is dismissed`);
    }
    const target =
      agentId === undefined
        ? entry.room.participants.find((p) => p.role === "orchestrator")
        : participantOf(entry, agentId);
    if (!target) {
      // A hint, so a client that sent no `@name` can say whom to name.
      const names = entry.room.participants.map((p) => `@${p.name}`);
      throw refusal(
        409,
        "no_orchestrator",
        `room ${id} has no participant with the orchestrator role` +
          (names.length ? `; name one: ${names.join(", ")}` : ""),
      );
    }
    const sender =
      from === undefined
        ? undefined
        : entry.room.participants.find((p) => p.id === from);
    if (from !== undefined && sender?.role !== "orchestrator") {
      throw refusal(
        400,
        "invalid_sender",
        `"from" must be the room's orchestrator; ${JSON.stringify(from)} is not`,
      );
    }
    if (sender === target) {
      throw refusal(
        400,
        "invalid_sender",
        "the orchestrator cannot send a message to itself",
      );
    }
    const seq = entry.room.eventLog?.size ?? 0;
    const queued = target.status() === "busy" ? target.queued + 1 : 0;
    let turn: Promise<void>;
    try {
      turn = sender
        ? entry.room.send(target.id, text, sender)
        : target.send(text);
    } catch (err) {
      throw roomRefused(err) ?? err;
    }
    entry.room.touch();
    // Settles with the turn; a failed turn is already on the log as an event.
    turn.catch(() => {});
    send(res, 202, { seq, queued } satisfies MessageAccepted);
  }

  /**
   * `POST /rooms/:id/agents/:agentId/turns/current/cancel` — for a live
   * prompt, drops the participant's queue and asks its harness to end the
   * turn. The session and the room stay (S5a). 202, as a run's cancel: the
   * turn ends on the stream with `_client_turn_ended`. Once the prompt has
   * settled, there is no live turn: 409 `no_turn`, nothing dropped or sent.
   */
  async function cancelTurn(id: string, agentId: string, res: ServerResponse) {
    const entry = await roomEntry(id);
    if (entry.room.status() === "dismissed") {
      throw refusal(409, "room_dismissed", `room ${id} is dismissed`);
    }
    const p = participantOf(entry, agentId);
    if (!p.cancel()) {
      throw refusal(409, "no_turn", `${p.name} has no live prompt to cancel`);
    }
    send(res, 202, toParticipantDto(p) satisfies ParticipantDto);
  }

  /**
   * `GET /rooms/:id/agents/:agentId/diff?against=head|base` — what the
   * participant changed in its checkout (M4-6), in any mode: `head` (the
   * default) is what is not committed, `base` the whole branch from its current
   * merge base with the configured base ref. New files git does not track are
   * in it. A snapshot: nothing is kept.
   */
  async function agentDiff(
    id: string,
    agentId: string,
    against: string | null,
    res: ServerResponse,
  ) {
    const p = await participantEntry(id, agentId);
    if (against !== null && against !== "head" && against !== "base") {
      throw refusal(
        400,
        "invalid_request",
        `"against" must be head or base; got ${against}`,
      );
    }
    let ref = against === "base" ? p.baseSha : "HEAD";
    if (!ref) {
      throw refusal(409, "no_diff", `${p.name} has no branch to compare with`);
    }
    let diff: Diff;
    try {
      if (against === "base" && p.baseRef) {
        const candidate = await mergeBase(p.worktree, p.baseRef, "HEAD");
        if (candidate !== undefined) {
          // A rewound base must not claim a saved base commit still on HEAD.
          // If the participant reset off that SHA, the current merge base wins.
          // For an unresolvable saved SHA, HEAD ancestry is false and clears keepSaved.
          const keepSaved =
            candidate !== ref &&
            !(await isAncestor(p.worktree, ref, candidate)) &&
            (await isAncestor(p.worktree, ref, "HEAD"));
          if (!keepSaved) ref = candidate;
        }
      }
      diff = await checkoutDiff(p.worktree, ref);
    } catch (err) {
      throw refusal(
        409,
        "no_diff",
        `no diff for ${p.name}: ${(err as Error).message.split("\n")[0]}`,
      );
    }
    send(res, 200, diff satisfies Diff);
  }

  /**
   * `GET /rooms/:id/agents/:agentId/fast-forward?from=<participantId>` — the
   * commits the move would bring (M6-11a, 3b): `HEAD` to the source branch.
   * Read-only, so the TUI can show the diff before it confirms. No busy or
   * dirty check here: a preview is still useful when the move itself would be
   * refused.
   */
  async function fastForwardPreview(
    id: string,
    agentId: string,
    from: string | null,
    res: ServerResponse,
  ) {
    if (!from) {
      throw refusal(
        400,
        "invalid_request",
        'add "?from=<participantId>" for the source participant',
      );
    }
    const entry = await roomEntry(id);
    const target = participantOf(entry, agentId);
    const source = participantOf(entry, from);
    if (!target.branch || !source.branch) {
      const who = target.branch ? source : target;
      throw refusal(409, "no_branch", `${who.name} has no branch to compare`);
    }
    // As the move refuses it (M11-2), not as a git failure.
    const other = entry.room.otherRepository(target.id, source.id);
    if (other) throw refusal(409, "no_branch", other);
    let diff: Diff;
    try {
      diff = await rangeDiff(target.worktree, "HEAD", source.branch);
    } catch (err) {
      throw refusal(
        409,
        "no_diff",
        `no fast-forward preview for ${target.name}: ` +
          `${(err as Error).message.split("\n")[0]}`,
      );
    }
    send(res, 200, diff satisfies Diff);
  }

  /**
   * `POST /rooms/:id/agents/:agentId/fast-forward {"from":"<id>"}` — move the
   * target's branch and checkout up to the source participant's commit
   * (M6-11a, R45). The move runs inside the target's checkout; a refusal names
   * the code and leaves branch, index and files alone.
   */
  async function fastForwardAgent(
    id: string,
    agentId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const entry = await roomEntry(id);
    const body = await readBody(req, ["from"]);
    if (typeof body.from !== "string" || !body.from) {
      throw refusal(
        400,
        "invalid_request",
        '"from" must be the source participant id',
      );
    }
    let participant: Awaited<ReturnType<Room["fastForward"]>>;
    try {
      participant = await entry.room.fastForward(agentId, body.from);
    } catch (err) {
      throw changeRefused(err);
    }
    entry.room.touch();
    send(res, 200, toParticipantDto(participant) satisfies ParticipantDto);
  }

  /** `GET /rooms/:id/events`, the room timeline, or with `agentId`
   *  `GET /rooms/:id/agents/:agentId/events`: the same log, only that
   *  participant's lines (R8c). `seq` and `Last-Event-ID` are the room's. */
  async function roomEvents(
    id: string,
    agentId: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    if (agentId === undefined) refuseDeleted(id);
    const entry = await roomEntry(id);
    const log = entry.room.eventLog;
    if (agentId !== undefined) participantOf(entry, agentId);
    if (!log) {
      throw refusal(404, "no_event_log", `room ${id} has no event log`);
    }
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    const keep =
      agentId === undefined
        ? undefined
        : (line: string) => {
            try {
              const event = JSON.parse(line) as { participantId?: unknown };
              return event.participantId === agentId;
            } catch {
              // A malformed line is not this participant's; drop it rather
              // than throw from inside the stream's filter.
              return false;
            }
          };
    await streamLog(log, req, res, gone.signal, { keep });
  }

  /**
   * `POST /rooms/:id/dismiss` — a person ends the room. Synchronous, unlike a
   * run's cancel: it waits for the harness to stop and the checkout to be
   * released — kept, never committed (R37) — which `stop()` bounds at 5 s.
   */
  async function dismissRoom(id: string, res: ServerResponse) {
    const entry = await roomEntry(id);
    refuseHall(id);
    // A shutdown pauses every room; a dismiss now would be told it worked
    // while the room stays paused.
    if (stopping()) {
      throw refusal(503, "shutting_down", "the daemon is shutting down");
    }
    if (entry.dismissed) {
      throw refusal(409, "room_dismissed", `room ${id} is already dismissed`);
    }
    // **Not `status() === "dismissed"`**, which reads so the instant a dismiss
    // begins: a second request arriving mid-teardown would then be told the
    // room was already dismissed while its harness was still alive and its
    // checkout unreleased, which is exactly what S6(a) promises does not
    // happen. `dismiss()` hands every caller the same promise, so two racing
    // dismissals both wait for the one teardown and both get their 200.
    // `dismissed` is set after the await, so only a request that arrives once
    // the dismiss has settled is refused.
    await entry.room.dismiss();
    if (!entry.dismissed) {
      entry.dismissed = true;
      entry.room.touch();
    }
    send(res, 200, toRoomDto(entry.state, entry.room) satisfies RoomDto);
  }

  /**
   * `GET /rooms/:id/delete-preview` — what `DELETE` would remove from git
   * (#352): every branch the room owns, with its commits that no ref outside
   * the room can reach. Read-only, so it works on an active room too.
   */
  async function previewDeleteRoom(id: string, res: ServerResponse) {
    const entry = await roomEntry(id);
    refuseHall(id);
    const preview = await roomDeletePreview(entry.root, id);
    send(res, 200, preview satisfies DeletePreview);
  }

  /**
   * `DELETE /rooms/:id` — a person throws the room away (R18, #235): its
   * checkouts, branches, record and log go at once, and the answer is `204`.
   * Only a stopped room can go: a dismissed one, or a paused one nothing has
   * revived. An active room is refused, so no harness writes while the
   * checkouts are read. Uncommitted work refuses it too, with the files
   * named, and nothing changes on either refusal, but for the race below.
   */
  async function deleteRoom(id: string, res: ServerResponse) {
    const entry = await roomEntry(id);
    refuseHall(id);
    if (stopping()) {
      throw refusal(503, "shutting_down", "the daemon is shutting down");
    }
    const { room, root } = entry;
    // A revive in flight leaves the room `paused` until its harness is up,
    // but its participant already reads `busy`.
    const stopped =
      entry.dismissed ||
      (room.status() === "paused" &&
        room.participants.every((p) => !["idle", "busy"].includes(p.status())));
    if (!stopped) {
      throw refusal(
        409,
        "room_active",
        `room ${id} is active; dismiss it first (POST /rooms/${id}/dismiss)`,
      );
    }
    // Tombstone before the first await, so a follower that reconciles while
    // the delete runs gets 410, not 404. Refusal puts both back.
    rooms.deleted.add(id);
    rooms.delete(id);
    const refuseWork = async () => {
      const work = await roomWork(root, id);
      if (work.length > 0) {
        throw refusal(
          409,
          "uncommitted_work",
          `room ${id} has work nobody committed: ${work.join(", ")}`,
        );
      }
    };
    try {
      await refuseWork();
      // Ends a paused room's open streams and its timer; a no-op once
      // dismissed. A message or an add that took the room before it left the
      // list can revive a participant until here, so the work is read again
      // once every harness has stopped. That rare refusal leaves the room
      // dismissed.
      if (!entry.dismissed) {
        try {
          await room.dismiss();
        } finally {
          // A dismiss that threw has still begun: the room reads dismissed.
          entry.dismissed = true;
        }
        await refuseWork();
      }
      // The record stays when a checkout does (`removeRoom`), so the room
      // stays listed and can be deleted again.
      for (const line of await removeRoom(root, id)) {
        console.error(`room ${id}: ${line}`);
      }
    } catch (err) {
      rooms.deleted.delete(id);
      rooms.set(id, entry);
      throw err;
    }
    room.forget();
    res.writeHead(204).end();
  }

  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/rooms$/,
      handler: ({ req, res }) => rooms.hold(res, postRoom(req, res)),
    },
    {
      method: "GET",
      pattern: /^\/rooms$/,
      handler: ({ res }) =>
        send(res, 200, rooms.list() satisfies RoomListEntry[]),
    },
    {
      method: "GET",
      pattern: /^\/rooms\/([^/]+)$/,
      handler: async ({ res, params: [id] }) => {
        refuseDeleted(id);
        const { state, room: live } = await roomEntry(id);
        send(res, 200, toRoomDto(state, live) satisfies RoomDto);
      },
    },
    {
      method: "PATCH",
      pattern: /^\/rooms\/([^/]+)$/,
      handler: ({ req, res, params: [id] }) => patchRoom(id, req, res),
    },
    {
      method: "DELETE",
      pattern: /^\/rooms\/([^/]+)$/,
      handler: ({ res, params: [id] }) => rooms.hold(res, deleteRoom(id, res)),
    },
    {
      method: "GET",
      pattern: /^\/rooms\/([^/]+)\/delete-preview$/,
      handler: ({ res, params: [id] }) => previewDeleteRoom(id, res),
    },
    {
      method: "POST",
      pattern: /^\/rooms\/([^/]+)\/dismiss$/,
      handler: ({ res, params: [id] }) => dismissRoom(id, res),
    },
    {
      method: "GET",
      pattern: /^\/rooms\/([^/]+)\/events$/,
      handler: ({ req, res, params: [id] }) =>
        roomEvents(id, undefined, req, res),
    },
    {
      method: "POST",
      pattern: /^\/rooms\/([^/]+)\/messages$/,
      handler: ({ req, res, params: [id] }) =>
        postMessage(id, undefined, req, res),
    },
    {
      method: "GET",
      pattern: /^\/rooms\/([^/]+)\/scratch$/,
      handler: ({ res, params: [id] }) => getScratch(id, res),
    },
    {
      method: "POST",
      pattern: /^\/rooms\/([^/]+)\/scratch\/clean$/,
      handler: ({ req, res, params: [id] }) => postScratchClean(id, req, res),
    },
    {
      method: "GET",
      pattern: /^\/rooms\/([^/]+)\/agents$/,
      handler: async ({ res, params: [id] }) => {
        const entry = await roomEntry(id);
        send(
          res,
          200,
          entry.room.participants.map(
            toParticipantDto,
          ) satisfies ParticipantDto[],
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/rooms\/([^/]+)\/agents$/,
      handler: ({ req, res, params: [id] }) => postAgent(id, req, res),
    },
    {
      method: "GET",
      pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)$/,
      handler: async ({ res, params: [id, agentId] }) => {
        const p = await participantEntry(id, agentId);
        send(res, 200, toParticipantDto(p) satisfies ParticipantDto);
      },
    },
    {
      method: "PATCH",
      pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)$/,
      handler: ({ req, res, params: [id, agentId] }) =>
        patchAgent(id, agentId, req, res),
    },
    {
      method: "DELETE",
      pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)$/,
      handler: ({ res, params: [id, agentId] }) =>
        deleteAgent(id, agentId, res),
    },
    {
      method: "POST",
      pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)\/messages$/,
      handler: ({ req, res, params: [id, agentId] }) =>
        postMessage(id, agentId, req, res),
    },
    {
      method: "GET",
      pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)\/events$/,
      handler: ({ req, res, params: [id, agentId] }) =>
        roomEvents(id, agentId, req, res),
    },
    {
      method: "GET",
      pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)\/diff$/,
      handler: ({ res, query, params: [id, agentId] }) =>
        agentDiff(id, agentId, query.get("against"), res),
    },
    {
      method: "GET",
      pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)\/fast-forward$/,
      handler: ({ res, query, params: [id, agentId] }) =>
        fastForwardPreview(id, agentId, query.get("from"), res),
    },
    {
      method: "POST",
      pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)\/fast-forward$/,
      handler: ({ req, res, params: [id, agentId] }) =>
        fastForwardAgent(id, agentId, req, res),
    },
    {
      method: "POST",
      pattern: /^\/rooms\/([^/]+)\/agents\/([^/]+)\/turns\/current\/cancel$/,
      handler: ({ res, params: [id, agentId] }) => cancelTurn(id, agentId, res),
    },
  ];

  return {
    routes,
    rooms,
    async restore() {
      await openHall();
      await restoreRooms();
    },
  };
}
