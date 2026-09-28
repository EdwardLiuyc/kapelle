/**
 * A chat room — a container with a roster of participants (M6-2).
 *
 * **The room owns each harness's lifetime.** A run spawns a harness, sends one
 * prompt and stops it (`core/run.ts`). A room spawns a participant's harness
 * once, sends a prompt per message, and stops it only when the room is
 * dismissed. Measured safe on all four harnesses: a prompt sent after
 * `end_turn` completes on the same session with the first turn's context kept
 * (`docs/FINDINGS.md` §Multi-turn). A prompt *during* a live turn is still
 * refused, here as `busy` and below as `AcpAgent`'s in-flight guard (#62 R5).
 *
 * **One checkout per participant** (M6-6a, R14). Each one runs in
 * `stateDirFor(root)/wt/<roomId>/<participantId>`, on the branch
 * `kapelle/<roomId>/<participantId>`, so turns run in parallel without
 * touching each other's files (R6). Nothing is shared or inherited. `add`
 * takes the base to fork from: any ref, including another participant's
 * branch (R35c). A branch holds only what its participant committed, so a
 * participant started from it never sees the other's uncommitted files (R37).
 *
 * **A kept checkout lasts until the next daemon boot.** A room writes no
 * record until M6-7a, so the boot sweep (`core/sweep.ts`) takes every room
 * checkout for an orphan: it removes a clean one and keeps its branch, and
 * keeps a dirty one or one on a detached HEAD. No work is lost; the
 * directory may be.
 *
 * **A roster that changes** (M6-3). `add`, `update` and `remove` change it
 * after the room opens. A name is unique under ASCII case folding (R22), and
 * at most one participant is the orchestrator (R44). An add still in flight
 * holds its name and role, so two racing adds cannot both take one. A
 * removed participant leaves the roster. Its checkout is released as at
 * dismiss, and a release notice goes to the room's notices, since the
 * participant that would show it is gone.
 *
 * **The orchestrator is a label, not a slot** (R44). A participant has the
 * role it was given and no other; nothing is promoted by default.
 *
 * **MVP scope, deliberately.** The mode is `auto`, so nobody answers
 * permission prompts. No watchdog, no result preamble, no cross-check: a chat
 * turn is conversation, not a deliverable. What stays is what makes a room
 * safe to leave running: its own worktree, the path guard `AcpAgent` always
 * applies, the containment notices, and the persisted event log a client
 * replays when it attaches.
 *
 * ponytail: nothing caps the live harness count across runs and rooms (R40).
 * `runs + Σ(busy participants)` is unbounded, with the default mode `auto`,
 * and so is the `agents` list of one `POST /rooms`, which starts them in turn.
 * A daemon-wide cap belongs in `daemon.ts`, where both spawners meet; add one
 * when a machine actually runs out of memory or file handles, not before.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { AcpAgent } from "../protocol/agent.ts";
import {
  type ResolvedAgent,
  resolveAgent,
  resolveEnv,
  type Warning,
  warningsFor,
} from "../protocol/registry.ts";
import { createEventLog, type EventLog } from "./eventlog.ts";
import type { EventBus } from "./events.ts";
import { newParticipantId } from "./ids.ts";
import { policyFor, resolvePolicy } from "./policy.ts";
import { stateDirFor } from "./runtime.ts";
import { BadBase, type WorktreeSetup } from "./worktree.ts";

/** A refusal the daemon answers with its own error code. Any other throw
 *  from `add`, `update` or `remove` is a failure, not a refusal. */
export class RoomRefusal extends Error {
  readonly code:
    | "invalid_request"
    | "name_taken"
    | "orchestrator_exists"
    | "participant_not_found"
    | "room_dismissed";
  constructor(code: RoomRefusal["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** `paused` is M6-7a's; nothing sets it yet. A room whose participant has
 *  exited still reads `active` (R33). */
type RoomStatus = "active" | "paused" | "dismissed";

/** `exited` is a harness that died before the room was dismissed. `paused`
 *  and `killed` are M6-7a's; nothing sets them yet. */
type ParticipantStatus =
  | "idle"
  | "busy"
  | "exited"
  | "paused"
  | "killed"
  | "dismissed";

/** R44's closed set. A label only: it sends no text to the harness. */
const ROLES = ["orchestrator", "developer", "tester", "architect"] as const;
type Role = (typeof ROLES)[number];

/** R22: ASCII on purpose, so the first word of an `@name` message is always
 *  the whole name, and Unicode case folding cannot make two names one.
 *  Because a name is ASCII, `toLowerCase` is ASCII case folding here. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** R15, amended 2026-09-28 (#147): the run-file `Task` fields that act in a
 *  room today. The watchdog knobs come with M6-4 (R38). No `purpose`: a
 *  person sends instructions as a message, never as a hidden prefix. */
interface Settings {
  allowReadOutsideRoot: boolean;
}

/** A line the room kept for the operator, as `Warning` has it. */
interface RoomNotice {
  text: string;
  kind?: Warning["kind"];
}

/** One agent the request asked for, checked and resolved. */
export interface AgentRequest {
  spec: ResolvedAgent;
  name: string;
  role?: Role;
  /** The ref to fork from, such as another participant's `branch`; the
   *  repository's HEAD when absent. */
  base?: string;
  settings: Settings;
}

/** What `PATCH` may change. A `null` role clears it. */
export interface ParticipantChanges {
  name?: string;
  role?: Role | null;
}

export interface Participant {
  /** Opaque (`newParticipantId`); a rename never moves it. */
  readonly id: string;
  /** Changed only through `Room.update`, which checks it. */
  name: string;
  role?: Role;
  readonly harness: string;
  readonly mode: "auto";
  readonly settings: Settings;
  /** Where the harness runs: its own checkout, or the cwd itself. */
  readonly worktree: string;
  /** The checkout's branch and the SHA it forked from, when there is one. */
  readonly branch?: string;
  readonly baseSha?: string;
  /** Recorded from the first version, though nothing loads it until
   *  `session/load` lands (R17, the M2-6 precedent). */
  readonly sessionId: string;
  /** The room's notices, then this participant's containment and worktree
   *  notices. #13's lines are never dropped, and a room has no terminal of
   *  its own, so the caller publishes them. */
  readonly notices: readonly RoomNotice[];
  status(): ParticipantStatus;
  /**
   * Sends one message and resolves when that turn ends. Refuses — before any
   * byte reaches the harness — while a turn is live or once it is over.
   * A turn that fails is not a rejection: it ends with `_client_turn_ended`
   * carrying `error`, which is how every client learns of it.
   */
  send(text: string): Promise<void>;
}

export interface Room {
  readonly participants: readonly Participant[];
  /** The room's persisted events, or undefined when it could not be written. */
  readonly eventLog: EventLog | undefined;
  status(): RoomStatus;
  /** Adds one participant in a checkout of its own, forked from
   *  `request.base` or from the repository's HEAD. Resolves once its harness
   *  has a session. A throw adds no participant, and removes the checkout and
   *  branch if the harness left them untouched. One it wrote into is kept,
   *  and a room notice names it. */
  add(request: AgentRequest): Promise<Participant>;
  /** Renames a participant or changes its role. Checks every change before
   *  it applies any. */
  update(id: string, changes: ParticipantChanges): Participant;
  /** Cancels the participant's turn, stops its harness and releases its
   *  checkout without committing (R37). It leaves the roster at once. */
  remove(id: string): Promise<void>;
  /** Cancels every live turn, stops every harness, releases every checkout
   *  **without committing** (R37) and closes the log. Safe to call twice. A
   *  release that fails is reported as a notice and the checkout is left
   *  where it is; `dismiss()` still resolves, because a dismissed room can
   *  never be retried. */
  dismiss(): Promise<void>;
}

/** The harness `agent` or `cmd` names, or a throw naming what is wrong. */
function roomHarness(agent: unknown, cmd: unknown): ResolvedAgent {
  // A field that is present must be a string, as for `name`: a `7` or a
  // `null` is a bad value, not a missing one.
  const str = (field: string, v: unknown) => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v) {
      throw new Error(`"${field}" must be a non-empty string`);
    }
    return v;
  };
  const byName = str("agent", agent);
  const byCmd = str("cmd", cmd);
  if (!byName && !byCmd) throw new Error('an agent needs "agent" or "cmd"');
  const spec = resolveAgent(byName ?? "", byCmd);
  // The ceiling check `resolvePolicy` owns; every measured entry allows
  // `auto` today, and a future one that does not must be refused, not run.
  resolvePolicy({
    run: { mode: "auto" },
    harness: { name: spec.name, maxMode: spec.maxMode },
  });
  return spec;
}

/** The fields one agent takes, at `POST /rooms` and at
 *  `POST /rooms/:id/agents`. */
export const AGENT_FIELDS: readonly string[] = [
  "agent",
  "cmd",
  "name",
  "role",
  "mode",
  "base",
  "settings",
];

/** A name, or a throw naming what is wrong. `fallback` is the harness name
 *  an add uses when the request gave none. */
function checkName(name: unknown, fallback?: string): string {
  // `=== undefined`, not `??`: a JSON `null` is a bad name, not a missing one.
  const chosen = name === undefined ? fallback : name;
  if (typeof chosen !== "string" || !NAME_PATTERN.test(chosen)) {
    throw new Error(
      `invalid agent name ${JSON.stringify(chosen)}: must match ` +
        `${NAME_PATTERN.source}` +
        (name === undefined ? '; give the agent a "name"' : ""),
    );
  }
  return chosen;
}

function checkRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) {
    throw new Error(
      `invalid role ${JSON.stringify(role)}: one of ${ROLES.join(", ")}`,
    );
  }
  return role as Role;
}

/** `auto` only until M6-5 (#149) builds the permission queue a room needs
 *  for `ask`, and the negotiation `safe` does at session start. */
function checkMode(mode: unknown) {
  if (mode === undefined || mode === "auto") return;
  if (mode === "ask" || mode === "safe") {
    throw new Error(
      `mode "${mode}" comes with M6-5; a participant runs in "auto" for now`,
    );
  }
  throw new Error(`invalid mode ${JSON.stringify(mode)}: must be "auto"`);
}

function checkSettings(raw: unknown): Settings {
  if (raw === undefined) return { allowReadOutsideRoot: false };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('"settings" must be an object');
  }
  const extra = Object.keys(raw).find((key) => key !== "allowReadOutsideRoot");
  if (extra !== undefined) {
    throw new Error(
      `unknown setting "${extra}"; "settings" takes allowReadOutsideRoot`,
    );
  }
  const { allowReadOutsideRoot = false } = raw as Record<string, unknown>;
  if (typeof allowReadOutsideRoot !== "boolean") {
    throw new Error('"allowReadOutsideRoot" must be true or false');
  }
  return { allowReadOutsideRoot };
}

/** The refusal a name or role meets among `others`, or undefined (R22,
 *  R44). */
function clash(
  others: Iterable<{ name: string; role?: Role | undefined }>,
  next: { name?: string | undefined; role?: Role | null | undefined },
): RoomRefusal | undefined {
  for (const other of others) {
    if (next.name?.toLowerCase() === other.name.toLowerCase()) {
      return new RoomRefusal(
        "name_taken",
        `the name "${next.name}" is taken by "${other.name}"`,
      );
    }
    if (next.role === "orchestrator" && other.role === "orchestrator") {
      return new RoomRefusal(
        "orchestrator_exists",
        `"${other.name}" is already the orchestrator; change its role first`,
      );
    }
  }
  return undefined;
}

/** One agent of a request body, checked, or a throw naming what is wrong. */
export function roomAgent(entry: unknown): AgentRequest {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("an agent must be an object");
  }
  const extra = Object.keys(entry).find((key) => !AGENT_FIELDS.includes(key));
  if (extra !== undefined) {
    throw new Error(
      `unknown agent field "${extra}"; an agent takes ${AGENT_FIELDS.join(", ")}`,
    );
  }
  const { agent, cmd, name, role, mode, base, settings } = entry as Record<
    string,
    unknown
  >;
  const spec = roomHarness(agent, cmd);
  const request: AgentRequest = {
    spec,
    name: checkName(name, spec.name),
    settings: checkSettings(settings),
  };
  if (role !== undefined) request.role = checkRole(role);
  checkMode(mode);
  if (base !== undefined) {
    if (typeof base !== "string" || !base) {
      throw new Error('"base" must be a non-empty string');
    }
    request.base = base;
  }
  return request;
}

/**
 * The `agents` of a `POST /rooms` body, checked, or a throw naming what is
 * wrong. Split from `openRoom` so the daemon can answer a bad request before
 * it touches the repository. A name or role that clashes inside the list is
 * a `RoomRefusal`, as it would be at add.
 */
export function roomAgents(raw: unknown): AgentRequest[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('"agents" must be a list');
  const requests: AgentRequest[] = [];
  for (const entry of raw) {
    const request = roomAgent(entry);
    const refused = clash(requests, request);
    if (refused) throw refused;
    requests.push(request);
  }
  return requests;
}

/** A `PATCH /rooms/:id/agents/:agentId` body, checked. */
export function participantChanges(
  body: Record<string, unknown>,
): ParticipantChanges {
  const { name, mode, role } = body;
  if (name === undefined && mode === undefined && role === undefined) {
    throw new Error('send at least one of "name", "mode" or "role"');
  }
  checkMode(mode);
  const changes: ParticipantChanges = {};
  if (name !== undefined) changes.name = checkName(name);
  if (role !== undefined) changes.role = role === null ? null : checkRole(role);
  return changes;
}

export interface RoomOptions {
  roomId: string;
  /** The folder the room was asked for; the harness runs here when there is
   *  no worktree, and at the same subdirectory inside one when there is. */
  cwd: string;
  /** From `roomAgents`, added in this order. */
  agents: AgentRequest[];
  /** The preflight the caller already ran (`openWorktrees`). */
  setup: WorktreeSetup;
  bus: EventBus;
}

type Notify = (text: string, kind?: Warning["kind"]) => void;

/** One participant, and what the room needs to end it. */
interface Member {
  participant: Participant;
  stop: () => Promise<void>;
  onNotice: Notify;
}

/** Opens a room and resolves once every participant's harness has a
 *  session. A harness that cannot start is a throw, never a dead
 *  participant (S13). */
export async function openRoom({
  roomId,
  cwd,
  agents,
  setup,
  bus,
}: RoomOptions): Promise<Room> {
  const { worktrees, notice, root } = setup;
  // The room's own lines: only the event log's today. With no participant
  // nothing publishes them, and a log failure shows only as `no_event_log`
  // on `GET /rooms/:id/events`. A room has no notices on the wire, so every
  // participant shows them before its own.
  const roomNotices: RoomNotice[] = [];
  const onRoomNotice: Notify = (text, kind) =>
    roomNotices.push(kind ? { text, kind } : { text });

  // #129: a room asks nothing of the operator's repository either — its log
  // and stderr live in the same workspace as a run's, outside the checkout.
  const logDir = join(stateDirFor(root), "rooms", roomId);
  let eventLog: EventLog | undefined;
  try {
    mkdirSync(logDir, { recursive: true });
    eventLog = createEventLog(join(logDir, "events.jsonl"), (err) =>
      onRoomNotice(`cannot write event log: ${err.message}`),
    );
    bus.addListener(eventLog.append);
  } catch (err) {
    onRoomNotice(
      `cannot write room logs to ${logDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let dismissing: Promise<void> | undefined;
  const members: Member[] = [];
  const participants: Participant[] = [];

  // **Never `commit` (R37).** The supervisor stays out of the commit business:
  // a participant commits its own branch, and whatever is left uncommitted at
  // dismiss stays in the checkout for a person to look at. `keep` is also the
  // right answer for a participant whose harness never got a session — an
  // untouched worktree is removed and its branch rolled back either way.
  //
  // A release that throws — a locked worktree, a missing git — must not
  // strand the room: the log still closes, `dismiss()` still resolves, and
  // the checkout is left in place rather than committed or deleted. The
  // participant is told, because a dismissed room can never be retried.
  // The line names the path: after a failed add it is the only record.
  //
  // Returns whether it wrote a notice, so the caller never adds a second
  // line about the same checkout.
  const release = async (
    id: string,
    worktree: string | undefined,
    onNotice: Notify,
  ): Promise<boolean> => {
    try {
      const kept = await worktrees?.release(id, "keep");
      if (kept) onNotice(kept);
      return Boolean(kept);
    } catch (err) {
      onNotice(
        `could not release the participant's checkout` +
          `${worktree ? ` at ${worktree}` : ""}: ` +
          `${err instanceof Error ? err.message : String(err)}; ` +
          "the checkout, its branch or both may be left in place",
      );
      return true;
    }
  };

  // The rollback half of the spawn, for an add that failed or met a dismiss.
  // `keep` removes an untouched checkout and its branch, so the room is as it
  // was. One the harness already wrote into is kept, as at dismiss. A
  // participant that never joined has no notices of its own, so both lines
  // go to the room's, which every participant shows.
  const rollback = async (id: string, worktree: string | undefined) => {
    const named = await release(id, worktree, onRoomNotice);
    if (!named && worktrees && worktree && existsSync(worktree)) {
      onRoomNotice(
        `a participant that did not join left its worktree at ${worktree}: ` +
          "its harness wrote into it, so the worktree and its branch are kept",
      );
    }
  };

  // A dismiss waits for every add and remove in flight, so nothing either
  // started outlives `dismiss()`: an add sees the dismiss and rolls itself
  // back, and a remove finishes its release.
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => {
    inflight.add(p);
    const done = () => inflight.delete(p);
    p.then(done, done);
    return p;
  };
  // The adds that have not joined yet. Each holds its name and role, so a
  // second add or a rename cannot take them while the harness starts.
  const pending = new Set<AgentRequest>();
  const dismissed = () =>
    new RoomRefusal("room_dismissed", "the room is dismissed");

  const teardown = () => {
    dismissing ??= (async () => {
      try {
        await Promise.allSettled(inflight);
        await Promise.all(members.map((m) => m.stop()));
        for (const { participant: p, onNotice } of members) {
          await release(p.id, p.worktree, onNotice);
        }
      } finally {
        await eventLog?.close();
      }
    })();
    return dismissing;
  };

  const spawn = async (request: AgentRequest, base: string | undefined) => {
    const id = newParticipantId();
    const own: RoomNotice[] = [];
    const onNotice: Notify = (text, kind) =>
      own.push(kind ? { text, kind } : { text });
    if (notice) onNotice(notice);

    // Taken here rather than in `startParticipant`, so a rollback knows
    // which path to look at.
    let worktree: string | undefined;
    let started: Awaited<ReturnType<typeof startParticipant>>;
    try {
      worktree = worktrees ? await worktrees.acquire(id, base) : cwd;
      started = await startParticipant({
        id,
        request,
        worktree,
        info: worktrees?.info(id),
        bus,
        notices: () => [...roomNotices, ...own],
        onNotice,
        stderrLog: eventLog ? join(logDir, `${id}.stderr.log`) : undefined,
        dismissed: () => dismissing !== undefined,
      });
    } catch (err) {
      await rollback(id, worktree);
      throw err instanceof BadBase
        ? new RoomRefusal("invalid_request", err.message)
        : err;
    }
    // A dismiss that began while this harness was starting did not see it.
    if (dismissing) {
      await started.stop();
      await rollback(id, worktree);
      throw dismissed();
    }
    members.push({ ...started, onNotice });
    participants.push(started.participant);
    return started.participant;
  };

  const start = async (request: AgentRequest) => {
    // Everything up to the first `await` runs at once, so the check and the
    // reservation cannot interleave with another add.
    if (dismissing) throw dismissed();
    const refused = clash([...participants, ...pending], request);
    if (refused) throw refused;
    const { base } = request;
    // Refused, not ignored: the caller asked to start from someone's work,
    // and a shared cwd has no branch to start from.
    if (base !== undefined && !worktrees) {
      throw new RoomRefusal(
        "invalid_request",
        `cannot start from ${JSON.stringify(base)}: ${cwd} is not a git ` +
          "repository with a commit, so no participant has a branch",
      );
    }
    pending.add(request);
    try {
      return await spawn(request, base);
    } finally {
      pending.delete(request);
    }
  };

  const member = (id: string) => {
    const found = members.find((m) => m.participant.id === id);
    if (!found) {
      throw new RoomRefusal("participant_not_found", `no participant ${id}`);
    }
    return found;
  };

  const update = (id: string, changes: ParticipantChanges) => {
    if (dismissing) throw dismissed();
    const { participant: p } = member(id);
    const others = participants.filter((o) => o !== p);
    const refused = clash([...others, ...pending], changes);
    if (refused) throw refused;
    if (changes.name !== undefined) p.name = changes.name;
    if (changes.role === null) delete p.role;
    else if (changes.role !== undefined) p.role = changes.role;
    return p;
  };

  const remove = async (id: string) => {
    if (dismissing) throw dismissed();
    const found = member(id);
    // Off the roster before the first `await`, so its name is free and a
    // second remove is told it is gone.
    members.splice(members.indexOf(found), 1);
    participants.splice(participants.indexOf(found.participant), 1);
    // No `finally` for the release: `stop()` cannot reject. It awaits the
    // harness's exit, which only resolves, and a turn whose handlers only
    // emit on a bus that catches every listener. A step that can reject,
    // added to `stop()`, would strand this checkout with no notice.
    await found.stop();
    // The participant is gone, so a kept checkout is the room's to report.
    await release(id, found.participant.worktree, onRoomNotice);
  };

  for (const request of agents) {
    try {
      await track(start(request));
    } catch (err) {
      await teardown();
      throw err;
    }
  }

  return {
    participants,
    eventLog,
    status: () => (dismissing ? "dismissed" : "active"),
    add: (request) => track(start(request)),
    update,
    remove: (id) => track(remove(id)),
    dismiss: teardown,
  };
}

/** Starts one harness in the participant's checkout and opens its session.
 *  On a throw it has stopped whatever it started; the caller releases the
 *  checkout. */
async function startParticipant({
  id,
  request: { spec, name, role, settings },
  worktree,
  info,
  bus,
  notices,
  onNotice,
  stderrLog,
  dismissed,
}: {
  id: string;
  request: AgentRequest;
  /** Its own checkout, or the cwd when there are no worktrees. */
  worktree: string;
  info: { branch: string; baseSha: string } | undefined;
  bus: EventBus;
  notices: () => readonly RoomNotice[];
  onNotice: Notify;
  stderrLog: string | undefined;
  dismissed: () => boolean;
}): Promise<{ participant: Participant; stop: () => Promise<void> }> {
  if (info) {
    bus.emit({
      agent: spec.name,
      update: {
        sessionUpdate: "_client_worktree_created",
        // Listed, not spread, as `core/run.ts` does: a wider `info` must not
        // shadow `path` (#85).
        path: worktree,
        branch: info.branch,
        baseSha: info.baseSha,
      },
    });
  }

  let exited = false;
  const agent = new AcpAgent({
    name: spec.name,
    command: spec.launch.command,
    args: spec.launch.args,
    env: resolveEnv(spec.launch.env),
    cwd: worktree,
    policy: policyFor("auto"),
    allowReadOutsideRoot: settings.allowReadOutsideRoot,
    stderrLog,
    onEvent: (event) => {
      if (event.update.sessionUpdate === "_client_harness_exited") {
        exited = true;
      }
      bus.emit(event);
    },
  });

  let turn: Promise<void> | undefined;
  // The harness answers a cancel within 64 ms on every measured build
  // (§M0-4), and `stop()` closes stdin after it, which ends the turn for one
  // that ignores the cancel.
  const stop = async () => {
    if (turn) agent.cancel();
    await agent.stop();
    await turn;
  };

  let sessionId: string;
  try {
    const init = await agent.start();
    for (const w of warningsFor(
      spec.name,
      spec,
      "auto",
      init.agentInfo?.version,
    )) {
      onNotice(w.text, w.kind);
    }
    sessionId = await agent.newSession();
  } catch (err) {
    await agent.stop();
    throw err;
  }

  const participant: Participant = {
    id,
    name,
    ...(role && { role }),
    harness: spec.name,
    mode: "auto",
    settings,
    worktree,
    ...(info && { branch: info.branch, baseSha: info.baseSha }),
    sessionId,
    get notices() {
      return notices();
    },
    status: () => {
      if (dismissed()) return "dismissed";
      if (exited) return "exited";
      return turn ? "busy" : "idle";
    },
    send(text) {
      if (dismissed()) throw new Error("the room is dismissed");
      if (exited) throw new Error("the agent's harness has exited");
      if (turn) throw new Error("the harness is still answering");
      bus.emit({
        agent: spec.name,
        update: { sessionUpdate: "_client_user_message", text },
      });
      turn = agent
        .prompt(text)
        .then(
          ({ stopReason }) => {
            bus.emit({
              agent: spec.name,
              update: { sessionUpdate: "_client_turn_ended", stopReason },
            });
          },
          (err) => {
            bus.emit({
              agent: spec.name,
              update: {
                sessionUpdate: "_client_turn_ended",
                error: err instanceof Error ? err.message : String(err),
              },
            });
          },
        )
        .finally(() => {
          turn = undefined;
        });
      return turn;
    },
  };
  return { participant, stop };
}
