/**
 * A chat room — one harness, one session, many turns (chat MVP).
 *
 * **The room owns the harness's lifetime.** A run spawns a harness, sends one
 * prompt and stops it (`core/run.ts`). A room spawns it once, sends a prompt
 * per message, and stops it only when the room is dismissed. Measured safe on
 * all four harnesses: a prompt sent after `end_turn` completes on the same
 * session with the first turn's context kept (`docs/M0-FINDINGS.md`
 * §Multi-turn). A prompt *during* a live turn is still refused, here as
 * `busy` and below as `AcpAgent`'s in-flight guard (#62 R5).
 *
 * **MVP scope, deliberately.** The mode is `auto`, so nobody answers
 * permission prompts. No watchdog, no result preamble, no cross-check: a chat
 * turn is conversation, not a deliverable. What stays is what makes a room
 * safe to leave running: its own worktree, the path guard `AcpAgent` always
 * applies, the containment notices, and the persisted event log a client
 * replays when it attaches.
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
import { policyFor, resolvePolicy } from "./policy.ts";
import { STATE_DIR, type WorktreeSetup } from "./worktree.ts";

/** `exited` is a harness that died before the room was dismissed. */
type RoomStatus = "idle" | "busy" | "exited" | "closed";

/** The task id a room's worktree and branch are named with:
 *  `.kapelle/wt/<roomId>/room`, on `kapelle/<roomId>/room`. */
const ROOM_TASK = "room";

export interface Room {
  readonly harness: string;
  /** Where the harness runs: the room's own checkout, or the cwd itself. */
  readonly workspace: string;
  /** The room's persisted events, or undefined when it could not be written. */
  readonly eventLog: EventLog | undefined;
  status(): RoomStatus;
  /**
   * Sends one message and resolves when that turn ends. Refuses — before any
   * byte reaches the harness — while a turn is live or once the room is over.
   * A turn that fails is not a rejection: it ends with `_client_turn_ended`
   * carrying `error`, which is how every client learns of it.
   */
  send(text: string): Promise<void>;
  /** Cancels a live turn, stops the harness, commits and removes the room's
   *  worktree, and closes the log. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * The harness a room would run, or a throw naming what is wrong with it.
 * Split from `openRoom` so the daemon can answer a bad request with a 400
 * before it touches the repository.
 */
export function roomHarness(agent?: string, cmd?: string): ResolvedAgent {
  if (!agent && !cmd) throw new Error('a room needs "agent" or "cmd"');
  const spec = resolveAgent(agent ?? "", cmd);
  // The ceiling check `resolvePolicy` owns; every measured entry allows
  // `auto` today, and a future one that does not must be refused, not run.
  resolvePolicy({
    run: { mode: "auto" },
    harness: { name: spec.name, maxMode: spec.maxMode },
  });
  return spec;
}

export interface RoomOptions {
  roomId: string;
  /** The folder the room was asked for; the harness runs here when there is
   *  no worktree, and at the same subdirectory inside one when there is. */
  cwd: string;
  spec: ResolvedAgent;
  /** The preflight the caller already ran (`openWorktrees`). */
  setup: WorktreeSetup;
  bus: EventBus;
  /** Containment and worktree notices. #13's lines are never dropped, and a
   *  room has no terminal of its own, so the caller keeps them. */
  onNotice: (text: string, kind?: Warning["kind"]) => void;
}

/** Opens a room and resolves once its harness has a session. */
export async function openRoom({
  roomId,
  cwd,
  spec,
  setup,
  bus,
  onNotice,
}: RoomOptions): Promise<Room> {
  const { worktrees, notice, root } = setup;
  if (notice) onNotice(notice);

  const logDir = join(root, STATE_DIR, "rooms", roomId);
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

  let workspace = cwd;
  try {
    if (worktrees) workspace = await worktrees.acquire(ROOM_TASK);
  } catch (err) {
    await eventLog?.close();
    throw err;
  }
  const info = worktrees?.info(ROOM_TASK);
  if (info) {
    bus.emit({
      agent: spec.name,
      update: {
        sessionUpdate: "_client_worktree_created",
        path: workspace,
        ...info,
      },
    });
  }

  let exited = false;
  bus.addListener(({ update }) => {
    if (update.sessionUpdate === "_client_harness_exited") exited = true;
  });

  const agent = new AcpAgent({
    name: spec.name,
    command: spec.launch.command,
    args: spec.launch.args,
    env: resolveEnv(spec.launch.env),
    cwd: workspace,
    policy: policyFor("auto"),
    stderrLog: eventLog ? join(logDir, "stderr.log") : undefined,
    onEvent: bus.emit,
  });

  let closing: Promise<void> | undefined;
  let turn: Promise<void> | undefined;

  const shutdown = (status: "done" | "failed") => {
    closing ??= (async () => {
      // The harness answers a cancel within 64 ms on every measured build
      // (§M0-4), and `stop()` closes stdin after it, which ends the turn for
      // one that ignores the cancel.
      if (turn) agent.cancel();
      await agent.stop();
      await turn;
      // `done` on dismiss: a room has no verdict, and its work is the
      // operator's to keep, so `release` commits what changed. `failed` for a
      // room that never got a session, which keeps anything it wrote.
      const kept = await worktrees?.release(ROOM_TASK, status);
      if (kept) onNotice(kept);
      await eventLog?.close();
    })();
    return closing;
  };

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
    await agent.newSession();
  } catch (err) {
    await shutdown("failed");
    throw err;
  }

  return {
    harness: spec.name,
    workspace,
    eventLog,
    status: () =>
      closing ? "closed" : exited ? "exited" : turn ? "busy" : "idle",
    send(text) {
      if (closing) throw new Error("the room is closed");
      if (exited) throw new Error("the room's harness has exited");
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
    close: () => shutdown("done"),
  };
}
