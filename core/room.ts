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
 * **At most one participant through the route, for now.** `POST /rooms`
 * creates a room empty or with one agent; M6-3 adds the route that calls
 * `add`. The request shape is already a list, so lifting it changes no
 * client.
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
 * `runs + Σ(busy participants)` is unbounded, with the default mode `auto`.
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
import type { WorktreeSetup } from "./worktree.ts";

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
 *  Uniqueness in a room under that folding is M6-3's. Until then `add`
 *  takes a name already in use, and only the route's one-agent limit keeps
 *  two apart. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

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
}

export interface Participant {
  /** Opaque (`newParticipantId`); a rename never moves it. */
  readonly id: string;
  readonly name: string;
  readonly role?: Role;
  readonly harness: string;
  readonly mode: "auto";
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
  /** Adds one participant in a checkout of its own, forked from `base` — a
   *  ref, such as another participant's `branch` — or from the repository's
   *  HEAD. Resolves once its harness has a session. A throw adds no
   *  participant, and removes the checkout and branch if the harness left
   *  them untouched. One it wrote into is kept, and a room notice names it. */
  add(request: AgentRequest, base?: string): Promise<Participant>;
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

/**
 * The `agents` of a `POST /rooms` body, checked, or a throw naming what is
 * wrong. Split from `openRoom` so the daemon can answer a bad request with a
 * 400 before it touches the repository.
 */
export function roomAgents(raw: unknown): AgentRequest[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('"agents" must be a list');
  if (raw.length > 1) {
    throw new Error("a room takes at most one agent for now");
  }
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("an agent must be an object");
    }
    const fields = ["agent", "cmd", "name", "role"];
    const extra = Object.keys(entry).find((key) => !fields.includes(key));
    if (extra !== undefined) {
      throw new Error(
        `unknown agent field "${extra}"; an agent takes ${fields.join(", ")}`,
      );
    }
    const { agent, cmd, name, role } = entry as Record<string, unknown>;
    const spec = roomHarness(agent, cmd);
    // `=== undefined`, not `??`: a JSON `null` is a bad name, not a missing one.
    const chosen = name === undefined ? spec.name : name;
    if (typeof chosen !== "string" || !NAME_PATTERN.test(chosen)) {
      throw new Error(
        `invalid agent name ${JSON.stringify(chosen)}: must match ` +
          `${NAME_PATTERN.source}` +
          (name === undefined ? '; give the agent a "name"' : ""),
      );
    }
    if (role !== undefined && !ROLES.includes(role as Role)) {
      throw new Error(
        `invalid role ${JSON.stringify(role)}: one of ${ROLES.join(", ")}`,
      );
    }
    return role === undefined
      ? { spec, name: chosen }
      : { spec, name: chosen, role: role as Role };
  });
}

export interface RoomOptions {
  roomId: string;
  /** The folder the room was asked for; the harness runs here when there is
   *  no worktree, and at the same subdirectory inside one when there is. */
  cwd: string;
  /** From `roomAgents`: none, or one. */
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
          "it is left in place",
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

  // A dismiss waits for every add in flight, so nothing an add started
  // outlives `dismiss()`: the add sees the dismiss and rolls itself back.
  const adding = new Set<Promise<Participant>>();

  const teardown = () => {
    dismissing ??= (async () => {
      try {
        await Promise.allSettled(adding);
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

  const start = async (request: AgentRequest, base?: string) => {
    if (dismissing) throw new Error("the room is dismissed");
    // Refused, not ignored: the caller asked to start from someone's work,
    // and a shared cwd has no branch to start from.
    if (base !== undefined && !worktrees) {
      throw new Error(
        `cannot start from ${JSON.stringify(base)}: ${cwd} is not a git ` +
          "repository with a commit, so no participant has a branch",
      );
    }
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
      throw err;
    }
    // A dismiss that began while this harness was starting did not see it.
    if (dismissing) {
      await started.stop();
      await rollback(id, worktree);
      throw new Error("the room is dismissed");
    }
    members.push({ ...started, onNotice });
    participants.push(started.participant);
    return started.participant;
  };

  const add = (request: AgentRequest, base?: string) => {
    const p = start(request, base);
    adding.add(p);
    const done = () => adding.delete(p);
    p.then(done, done);
    return p;
  };

  const [request] = agents;
  if (request) {
    try {
      await add(request);
    } catch (err) {
      await teardown();
      throw err;
    }
  }

  return {
    participants,
    eventLog,
    status: () => (dismissing ? "dismissed" : "active"),
    add,
    dismiss: teardown,
  };
}

/** Starts one harness in the participant's checkout and opens its session.
 *  On a throw it has stopped whatever it started; the caller releases the
 *  checkout. */
async function startParticipant({
  id,
  request: { spec, name, role },
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
