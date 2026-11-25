/**
 * The daemon's app (M12-7a): every route and the state behind them, made by
 * `createDaemonApp(deps)`. Importing this file starts nothing: no server
 * listens, no flag is read and no signal is caught. `daemon/main.ts` boots a
 * daemon around it, and a test can serve it on port 0 in its own process.
 *
 * **One daemon for all of the operator's repositories** (decided 2026-09-11,
 * #31). A repository is added once (`POST /repos`), and a run names the folder
 * it runs in (`POST /runs {cwd, run}`); a folder outside every added
 * repository is refused. One port, one token, and one place — M4's dashboard
 * — to watch every run. Run state lives in each repository's own workspace
 * under `stateDirFor(root)`, outside the repository.
 *
 * **Transport over `core/`, and nothing more.** It calls `stateDirRoot`,
 * `stateDirFor`, `validateRun`, `runRun`, the permission queue, `findAgents`
 * and the login checks for the installed agents, and for chat rooms
 * `roomAgents` and `openRoom`; worktrees, policy and the harness subprocesses
 * stay behind them. If orchestration grew here, the scheduler would be
 * untestable without a server and the CLI would drift into a second
 * implementation (`docs/STORIES.md`, M2-1).
 *
 * **Its state sits in small owners**, each with one job: runs
 * (`daemon/run.ts`), child processes (`daemon/children.ts`), idempotency keys
 * (`daemon/idempotency.ts`), and rooms with their scratch lock
 * (`daemon/rooms.ts`). A daemon-wide cap on live harnesses, if one is ever
 * wanted (R40), goes here.
 *
 * **The token is not optional, even on 127.0.0.1.** Every account on the
 * machine can reach the loopback address, and a run file is a command line —
 * `cmd`, or any harness under `auto`. `daemon/main.ts` makes it and publishes
 * it; this file only checks its digest.
 *
 * **A `Host` outside loopback is refused before the token is read** (M2-8,
 * #38), which closes DNS rebinding — an attacker page gaining same-origin
 * access to this loopback daemon. The browser half, `?token=` on the SSE
 * endpoint, is retired with the browser dashboard (A3): no story serves a page.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import {
  API_VERSION,
  CAPABILITIES,
  type ConfigView,
  type DeletePreview,
  type Diff,
  type ErrorReply,
  type HarnessesReply,
  type InstallLine,
  type MessageAccepted,
  type ParticipantDto,
  type PendingDecision,
  type PermissionAnswered,
  type PermissionDecision,
  type RepoAdded,
  type RepoRoots,
  type RoomDto,
  type RoomListEntry,
  type RunAccepted,
  type RunDto,
  type RunListEntry,
  type ScratchCleanReply,
  type ScratchFolder,
  type VersionReply,
} from "../client/contract.ts";
import {
  checkFields,
  dueForCheck,
  noteSession,
  readChecks,
  runChecks,
  stopChecks,
} from "../core/check.ts";
import {
  InvalidConfig,
  PROJECT_KEYS,
  projectConfigView,
  readProjectConfig,
  readProjectLinkPaths,
  replaceProjectConfig,
  resolveOrchestratorTurnCap,
  resolveRunDefaults,
  saveProjectConfig,
} from "../core/config.ts";
import {
  checkoutDiff,
  isAncestor,
  mergeBase,
  rangeDiff,
} from "../core/diff.ts";
import type { EventLog } from "../core/eventlog.ts";
import { createEventBus } from "../core/events.ts";
import {
  describe,
  findAgents,
  installArgs,
  installCommand,
  readSavedDone,
  readSetup,
  runNpm,
  type Setup,
  stopNpmInstalls,
  writeSetup,
} from "../core/harnesses.ts";
import { HALL_ID, newRoomId, newRunId } from "../core/ids.ts";
import { createPermissionQueue } from "../core/permissions.ts";
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
} from "../core/room.ts";
import { runRun } from "../core/run.ts";
import { type Run, validateRun } from "../core/runfile.ts";
import { stateDir, stateDirFor, writeRepos } from "../core/runtime.ts";
import { removeRoom, roomDeletePreview, roomWork } from "../core/sweep.ts";
import { WATCHDOG_DEFAULTS, type WatchdogLimits } from "../core/watchdog.ts";
import {
  LinkPathError,
  openWorktrees,
  stateDirRoot,
  validateWorktreeLinks,
  type WorktreeSetup,
} from "../core/worktree.ts";
import { AGENTS } from "../protocol/registry.ts";
import { createChildren } from "./children.ts";
import {
  type RunState,
  toParticipantDto,
  toRoomDto,
  toRunDto,
  toRunListEntry,
  toTaskDto,
} from "./dto.ts";
import {
  authorised,
  existingDir,
  hostAllowed,
  Refusal,
  readBody,
  refusal,
  send,
} from "./http.ts";
import { createIdempotencyKeys } from "./idempotency.ts";
import { createRooms, createScratchLock, type RoomEntry } from "./rooms.ts";
import { cancelRun, createRuns, externalLiveWriter } from "./run.ts";
import { cleanScratch, listScratch } from "./scratch.ts";
import { streamLog } from "./sse.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The hall's own folder. A function of the state directory only: the boot
 *  sweep needs it before any app exists. */
export function hallDir(): string {
  return join(stateDir(), "hall");
}

/** Where the hall keeps each participant's scratch folder. */
function hallScratchDir(): string {
  return join(stateDir(), "scratch", HALL_ID);
}

/** A parse base for `req.url`, which is a path, not a URL. Never fetched;
 *  named as a constant so it is not mistaken for a configurable endpoint. */
const REQUEST_URL_BASE = "http://daemon";

/** What the boot hands the app. */
export interface DaemonDeps {
  /** Every repository root added, restored from `repos.json` (M2-6, #36).
   *  Not re-checked here: a repository that has since moved is refused by
   *  `POST /runs`, which checks membership on use. */
  repos: Iterable<string>;
  /** The token's digest (`digest` in `daemon/http.ts`). */
  expected: Buffer;
  /** `daemon.json`, read before `children.json` is rewritten. */
  daemonFile: string;
  /** Where the live harness pids are recorded for the next boot's sweep. */
  childrenFile: string;
  /** How long an `ask` decision waits before it is denied (M2-3). */
  permissionTimeoutMs: number;
}

/** The app. `server` is made, not listening; `restoreRuns` and
 *  `restoreRooms` run once, before the port opens; `stop` ends it. */
export function createDaemonApp(deps: DaemonDeps) {
  const repos = new Set<string>(deps.repos);
  const { runs, inFlight, cancels, eventLogs, restoredLog, restore } =
    createRuns();
  const children = createChildren(deps.daemonFile, deps.childrenFile);
  const idempotency = createIdempotencyKeys();
  const scratch = createScratchLock();

  /**
   * Every `ask` decision the daemon is waiting on, across all runs (M2-3, #33).
   * An unanswered one is denied after `--permission-timeout`, so an `ask` run
   * with nobody attached completes instead of hanging.
   */
  const permissions = createPermissionQueue(deps.permissionTimeoutMs);

  async function postRepo(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req, ["path"]);
    // Since #129 a repository cannot be in a state that refuses a run, so this
    // only resolves the root. The 409 that used to live here — a tracked or
    // unignored `.kapelle/` — is gone with the state that caused it.
    const { root } = await stateDirRoot(existingDir(body.path, "path"));
    // M2-7: a config that does not load is refused at add time, naming the file
    // and key, rather than at the repository's first run.
    try {
      const config = readProjectConfig(root);
      await validateWorktreeLinks(root, config.linkPaths ?? []);
    } catch (err) {
      throw refusal(400, "invalid_config", messageOf(err));
    }
    // Persisted before the 200 and before the in-memory add: a caller told its
    // repository was added must not find it gone after a restart, and a failed
    // write must not leave memory ahead of disk. Hence the copy — it is what
    // lets the write happen first, and it dedups a repository added twice.
    const next = new Set(repos).add(root);
    writeRepos([...next]);
    repos.add(root);
    send(res, 200, { root } satisfies RepoAdded);
  }

  /**
   * The repository root `cwd` belongs to, or a 403 for a folder outside every
   * added one. `stateDirRoot` never throws, so an unadded folder is told to add
   * itself rather than to fix something else. Shared by `POST /runs` and
   * `POST /rooms`, which refuse in the same order.
   */
  async function refuseUnadded(cwd: string): Promise<string> {
    const { root } = await stateDirRoot(cwd);
    if (!repos.has(root)) {
      throw refusal(
        403,
        "repo_not_added",
        `${root} has not been added to the daemon. POST /repos ` +
          `{"path": ${JSON.stringify(root)}} first.`,
      );
    }
    return root;
  }

  /** The config view of an added repository (M10-5): every project key, its
   *  value in use and its source. A safe file whose content is invalid is a
   *  200 with `invalid`; an unsafe path is the 400 the other config reads give. */
  function sendConfig(res: ServerResponse, root: string) {
    let view: ReturnType<typeof projectConfigView>;
    try {
      view = projectConfigView(root);
    } catch (err) {
      throw refusal(400, "invalid_config", messageOf(err));
    }
    send(res, 200, { root, ...view } satisfies ConfigView);
  }

  /** `PATCH /config?cwd=…` (M10-5): save the changed project keys of an added
   *  repository, `null` to remove one, then answer the view. Only that
   *  repository's `.kapelle/config.json` is written (`saveProjectConfig`). */
  async function patchConfig(
    cwd: string | null,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const body = await readBody(req, PROJECT_KEYS);
    const root = await refuseUnadded(existingDir(cwd, "cwd"));
    try {
      await saveProjectConfig(root, body);
    } catch (err) {
      if (err instanceof InvalidConfig || err instanceof LinkPathError) {
        throw refusal(400, "invalid_config", messageOf(err));
      }
      throw err;
    }
    sendConfig(res, root);
  }

  /** `PUT /config?cwd=…` (#504): replace the whole project file after the
   *  complete new content passes the same value and git checks. */
  async function putConfig(
    cwd: string | null,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const body = await readBody(req, PROJECT_KEYS);
    const root = await refuseUnadded(existingDir(cwd, "cwd"));
    try {
      await replaceProjectConfig(root, body);
    } catch (err) {
      if (err instanceof InvalidConfig || err instanceof LinkPathError) {
        throw refusal(400, "invalid_config", messageOf(err));
      }
      throw err;
    }
    sendConfig(res, root);
  }

  /**
   * `POST /runs`, with an optional `Idempotency-Key` (M5-7, #139): see
   * `daemon/idempotency.ts`.
   */
  async function postRun(req: IncomingMessage, res: ServerResponse) {
    const id = await idempotency.once(
      req,
      () => readBody(req, ["cwd", "run"]),
      startRun,
    );
    send(res, 202, { id } satisfies RunAccepted);
  }

  /** Validate a `POST /runs` body, start the run, and return its id. */
  async function startRun(body: Record<string, unknown>): Promise<string> {
    const cwd = existingDir(body.cwd, "cwd");
    const root = await refuseUnadded(cwd);

    // M2-7: project config and `KAPELLE_*` supply the run-file defaults. Two
    // codes for two 400s, because the fix is in a different file: the
    // repository's config, or the run file the client sent.
    let defaults: ReturnType<typeof resolveRunDefaults>;
    try {
      defaults = resolveRunDefaults(root);
    } catch (err) {
      throw refusal(400, "invalid_config", messageOf(err));
    }
    let run: Run;
    try {
      run = validateRun(body.run, AGENTS, defaults);
    } catch (err) {
      throw refusal(400, "invalid_run", messageOf(err));
    }
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

    // No preflight before the 202 any more (#129). It existed to answer the two
    // 409s — an unsafe `.kapelle/`, a dirty tree — that this daemon no longer
    // has, and it cost about ten git spawns per run to repeat what `runRun`
    // does anyway (measured on #107).
    const id = newRunId();

    // After the last await, so no run can start once a shutdown has begun.
    if (stopping) {
      throw refusal(503, "shutting_down", "the daemon is shutting down");
    }

    const state: RunState = {
      id,
      cwd,
      root,
      status: "running",
      source: "live",
      startedAt: new Date().toISOString(),
      notices: [],
      tasks: [],
    };
    const bus = createEventBus();
    children.track(bus, "run", id);
    bus.addListener(({ agent, update }) => {
      if (update.sessionUpdate === "_client_task_finished") {
        // A task the watchdog's TTL cut leaves decisions nobody can act on: its
        // harness is gone and the run-wide signal has not fired, because the
        // siblings are still running. The task's own end is the sturdy hook —
        // a cancelled harness asks again on its way out (measured against
        // `mock-agent.mjs`: a second request arrives after `session/cancel`),
        // so denying at the cancel would leave that one listed until the timeout.
        permissions.denyTask(id, agent);
      }
    });
    const canceller = new AbortController();
    runs.set(id, state);
    cancels.set(id, canceller);
    let settleLog: (log?: EventLog) => void = () => {};
    eventLogs.set(
      id,
      new Promise((ok) => {
        settleLog = ok;
      }),
    );
    const done = runRun(run, {
      cwd,
      linkPaths,
      runId: id,
      bus,
      signal: canceller.signal,
      onEventLog: settleLog,
      askPolicy: permissions.policyFor(id, bus, canceller.signal),
      onTasks: (tasks) => {
        state.tasks = tasks.map(toTaskDto);
      },
      onNotice: (taskId, text, kind) => {
        state.notices.push(kind ? { taskId, text, kind } : { taskId, text });
      },
      // Before `_client_run_finished` is appended (M5-5), so a client that
      // reads it and then asks `GET /runs/:id` sees this status, and the same
      // `endedAt` the record carries. `DELETE` relies on this publication
      // preceding final cleanup.
      onFinished: (report, endedAt) => {
        state.status = report.status;
        state.report = report;
        state.endedAt = endedAt;
      },
    })
      .then(
        // `onFinished` settled a run that ended; only a throw is left here.
        () => {},
        (err) => {
          state.status = "failed";
          state.error = messageOf(err);
          state.endedAt = new Date().toISOString();
        },
      )
      .finally(() => {
        // A task the watchdog cut can leave a decision behind; the run is over,
        // so deny it now rather than list it until the timer. The reason is
        // what the queue reports as the decision's `reason` (M5-4).
        canceller.abort("run_end");
        cancels.delete(id);
        inFlight.delete(done);
        settleLog(undefined);
      });
    inFlight.add(done);
    return id;
  }

  /**
   * `GET /runs/:id/events` — every event of the run, then the live tail, as SSE
   * (M2-2, #32). Each event's `id:` is its `seq`, so a reconnecting client's
   * `Last-Event-ID` resumes at the next one. The stream ends when the run does.
   */
  async function getEvents(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    // Before any await: a client that leaves while the log is still pending
    // must not leave a reader behind for the rest of the run.
    const gone = new AbortController();
    res.on("close", () => gone.abort());

    const pending = eventLogs.get(id) ?? restoredLog(id);
    if (!pending) throw refusal(404, "run_not_found", `no run ${id}`);
    const log = await pending;
    if (!log) {
      throw refusal(404, "no_event_log", `run ${id} has no event log`);
    }
    await streamLog(log, req, res, gone.signal);
  }

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
    await refuseUnadded(request.cwd);
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
    const root = await refuseUnadded(cwd);

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
    if (stopping) {
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
    if (stopping) {
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
    if (stopping) throw shuttingDown();
    let participant: Awaited<ReturnType<Room["add"]>>;
    try {
      const add = () => entry.room.add(request);
      participant = id === HALL_ID ? await scratch.change(add) : await add();
    } catch (err) {
      // A shutdown pauses the room under the add, which then reads as
      // dismissed; the daemon's own reason is the true one.
      if (stopping) throw shuttingDown();
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
    if (stopping) {
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
    if (stopping) {
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
    if (stopping) {
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

  /** `POST /permissions/:id {"allow": boolean}` — the first answer wins. */
  async function postPermission(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const { allow } = await readBody(req, ["allow"]);
    if (typeof allow !== "boolean") {
      throw refusal(
        400,
        "invalid_request",
        `"allow" must be true or false; got ${allow}`,
      );
    }
    const result = permissions.answer(id, allow);
    if (result === "unknown") {
      throw refusal(404, "permission_not_found", `no permission ${id}`);
    }
    // A defined error, not an overwrite: someone else's answer, the timeout or
    // a cancel already decided it, and the harness has been told.
    if (result === "settled") {
      throw refusal(
        409,
        "already_decided",
        `permission ${id} was already decided`,
      );
    }
    send(res, 200, { id, allow } satisfies PermissionAnswered);
  }

  /** The find in flight, so asks that meet share it. */
  let finding: Promise<Setup> | undefined;

  /**
   * The installed agents (M9-3): the saved find, or a new one when `again` is
   * set or none is saved. The first ask finds, not the boot, so a daemon
   * nobody asks spawns no `--version`. A new find keeps the person's `done`,
   * read once it ends, so a "done" during it is kept.
   */
  async function setupNow(again: boolean): Promise<Setup> {
    const saved = again ? undefined : readSetup();
    if (saved) return saved;
    // An install needs a find that began after npm wrote its program. A find
    // already in flight may have read PATH before that.
    if (again && finding) {
      await finding.catch(() => {});
      if (finding) return finding;
    }
    finding ??= findAgents(process.env.PATH ?? "")
      .then((found) => {
        const s = {
          checkedAt: new Date().toISOString(),
          done: readSavedDone(),
          found,
        };
        writeSetup(s);
        return s;
      })
      .finally(() => {
        finding = undefined;
      });
    return finding;
  }

  /** Set once SIGTERM/SIGINT has begun: no new check or install may start. */
  let stopping = false;

  /** The check in flight (M9-4): one at a time, so two asks never start the
   *  same agents twice. */
  let checking: Promise<void> | undefined;

  /**
   * Checks the ready agents of find `s` that are due (`dueForCheck`): all of
   * them when `force`. The reply waits for it (decided 2026-10-28): about 5 s,
   * and the chat does not block on it. An ask that meets a check waits for it,
   * then checks only what is still due.
   */
  async function checkNow(s: Setup, force: boolean): Promise<void> {
    if (stopping) return;
    while (checking) await checking.catch(() => {});
    if (stopping) return;
    const ids = dueForCheck(s, readChecks(), force);
    if (ids.length === 0) return;
    checking = runChecks(ids, s.found).finally(() => {
      checking = undefined;
    });
    await checking;
  }

  function harnessesReply(s: Setup): HarnessesReply {
    const found = new Map(describe(s).map((a) => [a.id, a]));
    const checks = readChecks();
    return {
      checkedAt: s.checkedAt,
      done: s.done,
      harnesses: Object.entries(AGENTS).map(([id, a]) => ({
        id,
        measured: a.measured !== undefined,
        ...found.get(id),
        // A check describes a ready agent only.
        ...(found.get(id)?.state === "ready" && checkFields(id, checks[id])),
      })),
    };
  }

  /** Set while `POST /harnesses/install` runs: one install at a time. */
  let installing = false;

  /**
   * `POST /harnesses/install` (M9-3b): the person's checked agents, by id.
   * The body takes `ids` only, so a command never arrives here: the daemon
   * builds each one from its registry (`installArgs`). Each id must be an
   * agent the find now calls `main_only`. The reply streams NDJSON: each
   * install's command and npm's output, then the failures and a new find. A
   * chat that leaves does not stop npm; the next find sees what it did.
   */
  async function postInstall(req: IncomingMessage, res: ServerResponse) {
    const { ids } = await readBody(req, ["ids"]);
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) => typeof id === "string")
    ) {
      throw refusal(400, "invalid_request", "ids must be a list of agent ids");
    }
    if (stopping) {
      throw refusal(503, "shutting_down", "the daemon is shutting down");
    }
    if (installing) {
      throw refusal(409, "install_running", "an install is already running");
    }
    installing = true;
    try {
      const state = new Map(
        describe(await setupNow(true)).map((a) => [a.id, a.state]),
      );
      const plan = [...new Set(ids as string[])].map((id) => {
        const args = installArgs(id);
        if (!args || state.get(id) !== "main_only") {
          throw refusal(
            400,
            "invalid_request",
            `${JSON.stringify(id)} is not an agent kapelle can install: ` +
              "only one whose own program is installed and its ACP program is not",
          );
        }
        return { id, args };
      });
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      const line = (l: InstallLine) => {
        if (!res.destroyed) res.write(`${JSON.stringify(l)}\n`);
      };
      const npmError = new Map<string, string>();
      for (const { id, args } of plan) {
        if (stopping) break;
        line({ id, command: installCommand(args) });
        const error = await runNpm(args, (output) => line({ id, output }));
        if (stopping) break;
        if (error) npmError.set(id, error);
      }
      // The daemon is going: no final find and no second agent. The stream's
      // client sees it end, and the next daemon finds what npm wrote.
      if (stopping) {
        res.destroy();
        return;
      }
      // The find is the result, not npm's exit code (#374), both ways: npm
      // exits 0 when it installs into a global bin folder that is not on our
      // PATH, and a ready agent is no failure whatever npm said, unless it has
      // a warning too: then npm died after its link, and its error stays.
      // `command` is only for a failure that running it by hand can help.
      const setup = await setupNow(true);
      // A newly ready agent has no saved check, so it is due.
      await checkNow(setup, false);
      const now = new Map(describe(setup).map((a) => [a.id, a]));
      const failed = plan.flatMap(({ id, args }) => {
        const a = now.get(id);
        const error = npmError.get(id);
        if (a?.state === "ready" && !(a.warning && error)) return [];
        return [
          error
            ? { id, command: installCommand(args), error }
            : {
                id,
                error:
                  `npm finished, but ${a?.acpProgram} is still not on the ` +
                  "daemon's PATH: put npm's global bin folder on it, then " +
                  "restart the daemon",
              },
        ];
      });
      line({ failed, setup: harnessesReply(setup) });
      res.end();
    } finally {
      installing = false;
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    // Before the token and every route: a forged, duplicated or missing Host is
    // refused here. requireHostHeader: false lets this guard handle the last.
    if (!hostAllowed(req)) {
      throw refusal(403, "host_not_allowed", "host not allowed");
    }
    if (!authorised(req, deps.expected)) {
      throw refusal(401, "unauthorized", "missing or wrong token");
    }
    const { pathname, searchParams } = new URL(
      req.url ?? "/",
      REQUEST_URL_BASE,
    );
    const one = /^\/runs\/([^/]+)$/.exec(pathname);
    const events = /^\/runs\/([^/]+)\/events$/.exec(pathname);
    const decision = /^\/permissions\/([^/]+)$/.exec(pathname);
    const room = /^\/rooms\/([^/]+)$/.exec(pathname);
    const roomSub =
      /^\/rooms\/([^/]+)\/(events|messages|dismiss|agents|delete-preview|scratch)$/.exec(
        pathname,
      );
    const scratchClean = /^\/rooms\/([^/]+)\/scratch\/clean$/.exec(pathname);
    const agentOne = /^\/rooms\/([^/]+)\/agents\/([^/]+)$/.exec(pathname);
    const agentSub =
      /^\/rooms\/([^/]+)\/agents\/([^/]+)\/(messages|events|diff|fast-forward|turns\/current\/cancel)$/.exec(
        pathname,
      );

    if (req.method === "GET" && pathname === "/version") {
      send(res, 200, {
        apiVersion: API_VERSION,
        capabilities: [...CAPABILITIES],
      } satisfies VersionReply);
    } else if (req.method === "GET" && pathname === "/harnesses") {
      const s = await setupNow(false);
      await checkNow(s, false);
      send(res, 200, harnessesReply(s));
    } else if (req.method === "POST" && pathname === "/harnesses") {
      const s = await setupNow(true);
      await checkNow(s, true);
      send(res, 200, harnessesReply(s));
    } else if (req.method === "POST" && pathname === "/harnesses/done") {
      const s = { ...(await setupNow(false)), done: true };
      writeSetup(s);
      send(res, 200, harnessesReply(s));
    } else if (req.method === "POST" && pathname === "/harnesses/install") {
      await postInstall(req, res);
    } else if (req.method === "POST" && pathname === "/repos") {
      await postRepo(req, res);
    } else if (req.method === "GET" && pathname === "/repos") {
      send(res, 200, [...repos] satisfies RepoRoots);
    } else if (req.method === "GET" && pathname === "/config") {
      const cwd = existingDir(searchParams.get("cwd"), "cwd");
      sendConfig(res, await refuseUnadded(cwd));
    } else if (req.method === "PATCH" && pathname === "/config") {
      await patchConfig(searchParams.get("cwd"), req, res);
    } else if (req.method === "PUT" && pathname === "/config") {
      await putConfig(searchParams.get("cwd"), req, res);
    } else if (req.method === "POST" && pathname === "/runs") {
      await postRun(req, res);
    } else if (req.method === "GET" && pathname === "/runs") {
      send(
        res,
        200,
        [...runs.values()].map(toRunListEntry) satisfies RunListEntry[],
      );
    } else if (req.method === "POST" && pathname === "/rooms") {
      await rooms.hold(res, postRoom(req, res));
    } else if (req.method === "GET" && pathname === "/rooms") {
      send(res, 200, rooms.list() satisfies RoomListEntry[]);
    } else if (req.method === "GET" && roomSub?.[2] === "delete-preview") {
      await previewDeleteRoom(roomSub[1] as string, res);
    } else if (req.method === "DELETE" && room) {
      await rooms.hold(res, deleteRoom(room[1] as string, res));
    } else if (req.method === "GET" && room) {
      const id = room[1] as string;
      refuseDeleted(id);
      const { state, room: live } = await roomEntry(id);
      send(res, 200, toRoomDto(state, live) satisfies RoomDto);
    } else if (req.method === "PATCH" && room) {
      await patchRoom(room[1] as string, req, res);
    } else if (req.method === "POST" && roomSub?.[2] === "messages") {
      await postMessage(roomSub[1] as string, undefined, req, res);
    } else if (req.method === "POST" && agentSub?.[3] === "messages") {
      await postMessage(agentSub[1] as string, agentSub[2], req, res);
    } else if (req.method === "GET" && agentSub?.[3] === "fast-forward") {
      await fastForwardPreview(
        agentSub[1] as string,
        agentSub[2] as string,
        searchParams.get("from"),
        res,
      );
    } else if (req.method === "POST" && agentSub?.[3] === "fast-forward") {
      await fastForwardAgent(
        agentSub[1] as string,
        agentSub[2] as string,
        req,
        res,
      );
    } else if (req.method === "GET" && agentSub?.[3] === "diff") {
      await agentDiff(
        agentSub[1] as string,
        agentSub[2] as string,
        searchParams.get("against"),
        res,
      );
    } else if (req.method === "GET" && agentSub?.[3] === "events") {
      await roomEvents(agentSub[1] as string, agentSub[2], req, res);
    } else if (
      req.method === "POST" &&
      agentSub?.[3] === "turns/current/cancel"
    ) {
      await cancelTurn(agentSub[1] as string, agentSub[2] as string, res);
    } else if (req.method === "GET" && roomSub?.[2] === "scratch") {
      await getScratch(roomSub[1] as string, res);
    } else if (req.method === "POST" && scratchClean) {
      await postScratchClean(scratchClean[1] as string, req, res);
    } else if (req.method === "POST" && roomSub?.[2] === "agents") {
      await postAgent(roomSub[1] as string, req, res);
    } else if (req.method === "GET" && roomSub?.[2] === "agents") {
      const entry = await roomEntry(roomSub[1] as string);
      send(
        res,
        200,
        entry.room.participants.map(
          toParticipantDto,
        ) satisfies ParticipantDto[],
      );
    } else if (req.method === "GET" && agentOne) {
      const p = await participantEntry(
        agentOne[1] as string,
        agentOne[2] as string,
      );
      send(res, 200, toParticipantDto(p) satisfies ParticipantDto);
    } else if (req.method === "PATCH" && agentOne) {
      await patchAgent(agentOne[1] as string, agentOne[2] as string, req, res);
    } else if (req.method === "DELETE" && agentOne) {
      await deleteAgent(agentOne[1] as string, agentOne[2] as string, res);
    } else if (req.method === "POST" && roomSub?.[2] === "dismiss") {
      await dismissRoom(roomSub[1] as string, res);
    } else if (req.method === "GET" && roomSub?.[2] === "events") {
      await roomEvents(roomSub[1] as string, undefined, req, res);
    } else if (req.method === "GET" && events) {
      await getEvents(events[1] as string, req, res);
    } else if (req.method === "GET" && one) {
      const state = runs.get(one[1] as string);
      if (!state) throw refusal(404, "run_not_found", `no run ${one[1]}`);
      send(res, 200, toRunDto(state) satisfies RunDto);
    } else if (req.method === "GET" && pathname === "/permissions") {
      send(res, 200, permissions.list() satisfies PendingDecision[]);
    } else if (req.method === "GET" && decision) {
      const found = permissions.get(decision[1] as string);
      if (!found) {
        throw refusal(
          404,
          "permission_not_found",
          `no permission ${decision[1]}`,
        );
      }
      send(res, 200, found satisfies PermissionDecision);
    } else if (req.method === "POST" && decision) {
      await postPermission(decision[1] as string, req, res);
    } else if (req.method === "DELETE" && one) {
      // Asynchronous on purpose: cancel is cooperative, so the answer is an
      // acknowledgement and `GET` reports the verdict. `core/run.ts` stops a
      // harness 2 s after the abort, so no timer is needed here.
      const id = one[1] as string;
      const owned = runs.get(id);
      if (!owned) {
        const writer = await externalLiveWriter(repos, id);
        if (writer) {
          throw refusal(
            409,
            "run_not_owned",
            `run ${id} is owned by live process pid ${writer.pid}; stop it ` +
              "where it was started",
          );
        }
      }
      const state = cancelRun(id, owned, cancels.get(id));
      send(res, 202, toRunDto(state) satisfies RunDto);
    } else {
      throw refusal(404, "no_route", `no route for ${req.method} ${pathname}`);
    }
  }

  /**
   * J3: a request not fully received in 30 s gets Node's own `408 Request
   * Timeout`, with an empty body, and its connection is closed. Node sends it,
   * not `route`, so it is the one exception to the envelope, with Node's reply
   * to malformed HTTP. It covers receiving the request only: a slow reply and an
   * SSE stream are never cut (measured 2026-09-23). Node checks every 30 s, so
   * the 408 lands between 30 and 60 s.
   */
  const server = createServer(
    { requireHostHeader: false, requestTimeout: 30_000 },
    (req, res) => {
      route(req, res).catch((err) => {
        // A stream already started (an SSE log, an install): no JSON refusal
        // can follow its headers, and a second `writeHead` would throw here,
        // outside any catch. Cut it, so the client sees the end.
        if (res.headersSent) {
          console.error(`${req.method} ${req.url}: ${messageOf(err)}`);
          res.destroy();
          return;
        }
        const { status, code } =
          err instanceof Refusal
            ? err
            : ({ status: 500, code: "internal" } as const);
        // A refusal sent before the body was read (a 413, a 415, a 404 on a
        // write) leaves the rest to Node, which reads and discards it, bounded
        // by `requestTimeout`. Never `connection: close`: the client is often
        // still uploading, and a close then reaches it as EPIPE instead of this
        // reply (measured 2026-09-23, 4 runs in 10 on one core).
        send(res, status, {
          error: { code, message: messageOf(err) },
        } satisfies ErrorReply);
      });
    },
  );

  /**
   * The app's half of a shutdown (M2-4, #34): cancel every run, pause every
   * room, and wait for each to settle. The caller closes the server, removes
   * `daemon.json` and exits (`daemon/main.ts`). An install's npm is killed
   * rather than waited for, and a check's harness is stopped and its
   * temporary folder cleaned up, so a stop leaves neither running. A second
   * call answers at once.
   *
   * **A room is paused, not dismissed** (M6-7a, R42c): its live turns are
   * cancelled, its harnesses stopped and its checkouts kept, and the next boot
   * brings it back. A turn still live after the 2 s grace reads `killed`.
   * A room create or delete still unanswered is waited for too (#316): the
   * create then dismisses its room, and the delete ends with its 204.
   *
   * No kill loop of its own. A cancelled task stops its harness through
   * `core/run.ts` (2 s after the abort), and `AcpAgent.stop()` closes stdin
   * before it ever signals — the only stop that also ends the shell commands a
   * harness started. Waiting on the runs is what waits on their harnesses, and
   * it is also what lets each worktree be released.
   */
  async function stop(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: cancelling ${inFlight.size} run(s), then exiting`);
    stopNpmInstalls();
    const checksStopped = stopChecks();
    for (const canceller of cancels.values()) canceller.abort("cancel");
    await Promise.all([
      ...inFlight,
      ...rooms.changes(),
      ...rooms.built().map(({ room }) => room.pause()),
      checksStopped,
    ]);
  }

  return {
    server,
    /** Read every added repository's finished runs back (M2-6). */
    restoreRuns: () => restore(repos),
    /** The hall, then every added repository's rooms (M6-7a, M11-1). */
    async restoreRooms() {
      await openHall();
      await restoreRooms();
    },
    stop,
  };
}
