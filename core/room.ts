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
 * **At most one participant, for now.** A room is created empty or with one
 * agent. A second needs a checkout of its own (M6-6a) and a route to reach
 * it (M6-4); M6-3 lifts the limit. The request shape is already a list, so
 * lifting it changes no client.
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

import { mkdirSync } from "node:fs";
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
 *  Uniqueness in a room under that folding arrives with M6-3's second
 *  participant; one agent cannot clash. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** The task id the room's one worktree and branch are named with:
 *  `stateDirFor(root)/wt/<roomId>/room`, on `kapelle/<roomId>/room`.
 *  M6-6a replaces it with one per participant. */
const ROOM_TASK = "room";

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
  /** Where the harness runs: the room's checkout, or the cwd itself. */
  readonly worktree: string;
  /** The checkout's branch and the SHA it forked from, when there is one. */
  readonly branch?: string;
  readonly baseSha?: string;
  /** Recorded from the first version, though nothing loads it until
   *  `session/load` lands (R17, the M2-6 precedent). */
  readonly sessionId: string;
  /** Containment and worktree notices. #13's lines are never dropped, and a
   *  room has no terminal of its own, so the caller publishes them. */
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
  /** Cancels a live turn, stops every harness, releases the room's worktree
   *  **without committing** (R37) and closes the log. Safe to call twice. A
   *  release that fails is reported as a notice and the checkout is left
   *  where it is; `dismiss()` still resolves, because a dismissed room can
   *  never be retried. */
  dismiss(): Promise<void>;
}

/** The harness `agent` or `cmd` names, or a throw naming what is wrong. */
function roomHarness(agent: unknown, cmd: unknown): ResolvedAgent {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  if (!str(agent) && !str(cmd))
    throw new Error('an agent needs "agent" or "cmd"');
  const spec = resolveAgent(str(agent) ?? "", str(cmd));
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
  // ponytail: one list for the room and its one participant. With no
  // participant nothing publishes it: a log failure shows only as
  // `no_event_log` on `GET /rooms/:id/events`, and `setup.notice` (no
  // worktree for this cwd) is dropped, since no harness runs uncontained.
  // M6-3 splits the list and must carry `setup` to the add path, so the
  // first participant added to an empty room still gets that notice.
  const notices: RoomNotice[] = [];
  const onNotice = (text: string, kind?: Warning["kind"]) =>
    notices.push(kind ? { text, kind } : { text });

  // #129: a room asks nothing of the operator's repository either — its log
  // and stderr live in the same workspace as a run's, outside the checkout.
  const logDir = join(stateDirFor(root), "rooms", roomId);
  let eventLog: EventLog | undefined;
  try {
    mkdirSync(logDir, { recursive: true });
    eventLog = createEventLog(join(logDir, "events.jsonl"), (err) =>
      onNotice(`cannot write event log: ${err.message}`),
    );
    bus.addListener(eventLog.append);
  } catch (err) {
    onNotice(
      `cannot write room logs to ${logDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let dismissing: Promise<void> | undefined;
  let stop: (() => Promise<void>) | undefined;

  // **Never `commit` (R37).** The supervisor stays out of the commit business:
  // a participant commits its own branch, and whatever is left uncommitted at
  // dismiss stays in the checkout for a person to look at. `keep` is also the
  // right answer for a room whose harness never got a session — an untouched
  // worktree is removed and its branch rolled back either way.
  const teardown = () => {
    dismissing ??= (async () => {
      try {
        await stop?.();
        // A release that throws — a locked worktree, a missing git — must
        // not strand the room: the log still closes below, `dismiss()` still
        // resolves, and the checkout is left in place rather than committed
        // or deleted. The caller is told, because a dismissed room can never
        // be retried.
        try {
          const kept = await worktrees?.release(ROOM_TASK, "keep");
          if (kept) onNotice(kept);
        } catch (err) {
          onNotice(
            `could not release the room's checkout: ` +
              `${err instanceof Error ? err.message : String(err)}; ` +
              "it is left in place",
          );
        }
      } finally {
        await eventLog?.close();
      }
    })();
    return dismissing;
  };

  const participants: Participant[] = [];
  const [request] = agents;
  if (request) {
    if (notice) onNotice(notice);
    try {
      const started = await startParticipant({
        request,
        cwd,
        setup,
        bus,
        notices,
        onNotice,
        stderrLog: eventLog ? join(logDir, "stderr.log") : undefined,
        dismissed: () => dismissing !== undefined,
      });
      stop = started.stop;
      participants.push(started.participant);
    } catch (err) {
      await teardown();
      throw err;
    }
  }

  return {
    participants,
    eventLog,
    status: () => (dismissing ? "dismissed" : "active"),
    dismiss: teardown,
  };
}

/** Takes the room's checkout, starts one harness in it and opens its
 *  session. On a throw, whatever it started is stopped by the caller's
 *  `teardown`, which releases the checkout. */
async function startParticipant({
  request: { spec, name, role },
  cwd,
  setup: { worktrees },
  bus,
  notices,
  onNotice,
  stderrLog,
  dismissed,
}: {
  request: AgentRequest;
  cwd: string;
  setup: WorktreeSetup;
  bus: EventBus;
  notices: readonly RoomNotice[];
  onNotice: (text: string, kind?: Warning["kind"]) => void;
  stderrLog: string | undefined;
  dismissed: () => boolean;
}): Promise<{ participant: Participant; stop: () => Promise<void> }> {
  const worktree = worktrees ? await worktrees.acquire(ROOM_TASK) : cwd;
  const info = worktrees?.info(ROOM_TASK);
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
    id: newParticipantId(),
    name,
    ...(role && { role }),
    harness: spec.name,
    mode: "auto",
    worktree,
    ...(info && { branch: info.branch, baseSha: info.baseSha }),
    sessionId,
    notices,
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
