/**
 * `chat/piped.ts` — the chat screen for a pipe (M4-7).
 *
 * Piped, `chat.ts` is one room as plain lines, which is what a script or a
 * test reads. It sends through `client/mention.ts` and `client/command.ts`,
 * as the TUI does. A question is not answered here: the piped screen only
 * prints the question and how it closed (M4-3).
 */

import { createInterface } from "node:readline";

import {
  USAGE as COMMAND_USAGE,
  HELP,
  parseCommand,
  runCommand,
} from "../client/command.ts";
import type { MessageAccepted, RoomDto } from "../client/contract.ts";
import { call, type DaemonAddress } from "../client/daemon.ts";
import { resolveTarget } from "../client/mention.ts";
import {
  applyLine,
  type Entry,
  nameOf,
  newRoomState,
  type RoomState,
} from "../client/room.ts";
import { readRoom, reconcile, rosterOf } from "./common.ts";

/** Prints the reducer's entries as a conversation, for a piped stdin. An
 *  answer that grows prints only its new text. A participant's name comes
 *  before its first line, tool calls included, since someone else's, as on
 *  the screen. */
function makePrinter(state: RoomState) {
  let atLineStart = true;
  let last: Entry | undefined;
  /** The participant whose name was printed last; unset after the
   *  person's own message. */
  let speaker: string | undefined;
  const printed = new WeakMap<Entry, number>();
  const write = (s: string) => {
    if (!s) return;
    process.stdout.write(s);
    atLineStart = s.endsWith("\n");
  };
  const line = (s: string) => {
    if (!atLineStart) write("\n");
    write(`${s}\n`);
  };
  return {
    show(e: Entry) {
      switch (e.type) {
        case "user":
          speaker = undefined;
          line(`you → ${nameOf(state, e.participantId)}: ${e.text}`);
          break;
        case "queued":
          line(`  (queued for ${nameOf(state, e.participantId)}) ${e.text}`);
          break;
        case "queue_cleared":
          line(`! ${e.count} queued message(s) dropped, unsent`);
          break;
        case "answer":
          if (last !== e) {
            if (!atLineStart) write("\n");
            if (speaker !== e.participantId) {
              write(`${nameOf(state, e.participantId)}: `);
            }
          }
          speaker = e.participantId;
          write(e.text.slice(printed.get(e) ?? 0));
          printed.set(e, e.text.length);
          break;
        case "tool":
          if (speaker !== e.participantId) {
            line(`${nameOf(state, e.participantId)}:`);
          }
          speaker = e.participantId;
          line(`  · ${e.title}`);
          break;
        case "turn_ended":
          if (e.error) line(`! the turn failed: ${e.error}`);
          else if (e.stopReason !== "end_turn") {
            line(`! the turn ended: ${e.stopReason}`);
          } else if (!atLineStart) write("\n");
          break;
        case "exited":
          line("! the harness exited");
          break;
        case "permission": {
          // The same entry comes back when the question closes. This screen
          // only watches: the TUI or `POST /permissions/:id` answers (M4-3).
          const name = nameOf(state, e.participantId);
          if (e.allow === undefined) line(`? ${name} asks: ${e.title}`);
          else {
            line(`  ${name}: ${e.allow ? "allowed" : "denied"} (${e.reason})`);
          }
          break;
        }
        default:
          // Stall warnings: M4-4's. Nothing was written.
          return;
      }
      last = e;
    },
  };
}

/** The chat loop for one room on a pipe: what a script or a test reads.
 *  Resolves with the exit code. A refused message or command prints to
 *  stderr and the loop goes on, so the exit stays 0. A refused `/dismiss`
 *  is the one that ends it, with 1: the person asked for the end. */
async function chatPiped(d: DaemonAddress, room: RoomDto): Promise<number> {
  if (room.participants.length === 0)
    console.log(`room ${room.id} · no agents`);
  for (const p of room.participants) {
    console.log(`room ${room.id} · ${p.name} (${p.harness}) · ${p.worktree}`);
    for (const { text } of p.notices) console.log(`! ${text}`);
  }
  console.log(
    "type a message; @name picks the agent; /help lists the commands; /leave to exit",
  );

  const state = newRoomState();
  const printer = makePrinter(state);

  // The one answer being waited on: `left` more turn ends of `id` above `after`.
  let waiting:
    | { id: string; after: number; left: number; done: () => void }
    | undefined;

  const ended = readRoom(room.id, (line) => {
    const e = applyLine(state, line);
    if (!e) return;
    printer.show(e);
    if (
      e.type === "turn_ended" &&
      waiting &&
      e.participantId === waiting.id &&
      e.seq > waiting.after &&
      --waiting.left === 0
    ) {
      waiting.done();
      waiting = undefined;
    }
  }).then(
    () => "ended" as const,
    (err) => {
      console.error(`! ${(err as Error).message}`);
      return "ended" as const;
    },
  );

  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines: string[] = [];
  let inputDone = false;
  let wake = () => {};
  rl.on("line", (l) => {
    lines.push(l);
    wake();
  });
  rl.on("close", () => {
    inputDone = true;
    wake();
  });
  const nextLine = async (): Promise<string | null> => {
    while (lines.length === 0) {
      if (inputDone) return null;
      await new Promise<void>((ok) => {
        wake = ok;
      });
    }
    return lines.shift() ?? null;
  };

  let code = 0;
  for (;;) {
    const next = await Promise.race([nextLine(), ended]);
    if (next === "ended") {
      const r = await reconcile(room.id);
      (r.code ? console.error : console.log)(r.line);
      code = r.code;
      break;
    }
    if (next === null) break;
    const text = next.trim();
    if (!text) continue;
    const c = parseCommand(text, rosterOf(state, room.participants));
    if (c && "error" in c) {
      console.error(`! ${c.error}`);
      continue;
    }
    if (c?.verb === "leave") break;
    if (c?.verb === "help") {
      for (const l of HELP) console.log(l);
      continue;
    }
    if (c?.verb === "form") {
      console.error(`! a form needs a terminal: ${COMMAND_USAGE[c.form]}`);
      continue;
    }
    if (c) {
      const r = await runCommand(d, room.id, c);
      if (!r.ok) {
        console.error(`! ${r.message}`);
        // A pipe cannot ask, as the screen does: say how to add it.
        if (r.code === "repo_not_added" && c.verb === "new") {
          console.error(`add it first: kapelle daemon add ${c.body.cwd}`);
        }
        if (c.verb === "dismiss") {
          code = 1;
          break;
        }
        continue;
      }
      if (c.verb !== "dismiss") {
        console.log(r.line);
        // A pipe stays in the room it started in, so name the new room:
        // its id is not on the line when it has a title.
        if (c.verb === "new" && r.room) {
          console.log(`attach with: kapelle chat attach ${r.room.id}`);
        }
        continue;
      }
      await ended;
      console.log("the room was dismissed");
      break;
    }

    const t = resolveTarget(text, rosterOf(state, room.participants));
    if ("error" in t) {
      console.error(`! ${t.error}`);
      continue;
    }
    const r = await call<MessageAccepted>(
      d,
      `/rooms/${room.id}/agents/${t.id}/messages`,
      { method: "POST", body: { text: t.text } },
    );
    if (!r.ok) {
      console.error(`! ${r.error.message}`);
      continue;
    }
    // Turn ends the stream already delivered count toward this answer.
    const after = r.body.seq;
    const left =
      r.body.queued +
      1 -
      state.timeline.filter(
        (e) =>
          e.type === "turn_ended" && e.participantId === t.id && e.seq > after,
      ).length;
    if (left <= 0) continue;
    await Promise.race([
      new Promise<void>((done) => {
        waiting = { id: t.id, after, left, done };
      }),
      ended,
    ]);
  }

  rl.close();
  return code;
}

export { chatPiped };
