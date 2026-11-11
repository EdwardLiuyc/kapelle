/**
 * `chat/piped.ts` — the chat screen for a pipe (M4-7).
 *
 * Piped, `chat.ts` is one room as plain lines, which is what a script or a
 * test reads. It reads a line through `client/submit.ts`, as the TUI does.
 * A question is not answered here: the piped screen only prints the
 * question and how it closed (M4-3). `/delete` prints its preview, and the
 * next non-empty line must be `/delete` again to confirm. A dismissed room
 * stays read-only so a `409` can be fixed and retried (#352).
 */

import { createInterface } from "node:readline";

import {
  USAGE as COMMAND_USAGE,
  deletePreview,
  deletePreviewLines,
  HELP,
  modelLines,
  participantNow,
  runCommand,
} from "../client/command.ts";
import type { MessageAccepted, RoomDto } from "../client/contract.ts";
import { call, type DaemonAddress } from "../client/daemon.ts";
import { agentDiff } from "../client/diff.ts";
import {
  applyLine,
  applyStatus,
  cleanLines,
  type Entry,
  nameOf,
  newRoomState,
  printable,
  type RoomState,
  senderOf,
} from "../client/room.ts";
import {
  codeOf,
  type Ended,
  followDaemon,
  readRoom,
  reconcile,
} from "../client/roomset.ts";
import { findAgain, markDone, setupLines } from "../client/setup.ts";
import { parseLine } from "../client/submit.ts";
import {
  address,
  endedLine,
  NO_DAEMON,
  revivedLine,
  rosterOf,
  stoppedLine,
} from "./common.ts";

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
  /** What each tool call printed last. */
  const shown = new WeakMap<Entry, string>();
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
          line(
            `${senderOf(state, e.from)} → ${nameOf(state, e.participantId)}: ${e.text}`,
          );
          break;
        case "queued":
          line(
            `  (queued for ${nameOf(state, e.participantId)}` +
              `${e.from ? `, from ${senderOf(state, e.from)}` : ""}) ${e.text}`,
          );
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
        case "tool": {
          // A pipe cannot change a line: the call prints again only when
          // what it shows changed (#240).
          const failed = e.status === "failed" ? " — failed" : "";
          // A title or a detail can be several lines (#351): the rest of
          // them line up under the first.
          const under = (lines: string[]) => lines.map((l) => `    ${l}`);
          const [head = "", ...rest] = e.title.split("\n");
          const text = [
            `  · ${head}${failed}`,
            ...under(rest),
            ...(e.detail ? under(e.detail.split("\n")) : []),
          ].join("\n");
          if (shown.get(e) === text) return;
          shown.set(e, text);
          if (speaker !== e.participantId) {
            line(`${nameOf(state, e.participantId)}:`);
          }
          speaker = e.participantId;
          line(text);
          break;
        }
        case "turn_ended":
          if (e.error) line(`! the turn failed: ${e.error}`);
          else if (e.stopReason !== "end_turn") {
            line(`! the turn ended: ${e.stopReason}`);
          } else if (!atLineStart) write("\n");
          break;
        case "exited":
          line("! the harness exited");
          break;
        case "revived":
          line(revivedLine(nameOf(state, e.participantId), e));
          break;
        case "forward":
          line(
            `↪ ${nameOf(state, e.participantId)} moved to ` +
              `${nameOf(state, e.from)}'s commit`,
          );
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
    // A notice can quote the harness: its version, or its own error (#229).
    for (const { text } of p.notices) console.log(`! ${printable(text)}`);
  }
  console.log(
    "type a message; @name picks the agent; /help lists the commands; /leave to exit",
  );

  const state = newRoomState();
  const printer = makePrinter(state);
  // `d` follows a restart in place (M6-7d). A restart writes no line, so the
  // room is read again for who it left `paused` or `killed`.
  const current = followDaemon(d, address, (warning) => {
    if (warning) console.error(`! ${warning}`);
    console.log("· the daemon restarted");
    call<RoomDto>(d, `/rooms/${room.id}`).then(
      (r) => {
        if (!r.ok) return;
        applyStatus(state, r.body);
        for (const p of r.body.participants) {
          if (p.status === "paused" || p.status === "killed") {
            console.log(stoppedLine(p.name, p.status));
          }
        }
      },
      // The stream says what happened to the daemon.
      () => {},
    );
  });

  // The one answer being waited on: `left` more turn ends of `id` above `after`.
  let waiting:
    | { id: string; after: number; left: number; done: () => void }
    | undefined;
  /** Let the loop wake for input or for the stream's end. */
  let wake = () => {};
  /** What the stream settled with, once it did. */
  let stream: { ended?: Ended; error?: string } | undefined;
  const streamDone = readRoom(current, room.id, (line) => {
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
    (ended) => {
      stream = { ended };
      wake();
    },
    (err) => {
      stream = { error: (err as Error).message };
      wake();
    },
  );

  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines: string[] = [];
  let inputDone = false;
  rl.on("line", (l) => {
    lines.push(l);
    wake();
  });
  rl.on("close", () => {
    inputDone = true;
    wake();
  });

  /** A dismissed room stays in read-only mode so `/delete` can retry after
   *  409. An active room enters it as soon as a delete dismisses it. */
  let readOnly = room.status === "dismissed";
  let holdDismissed = readOnly;
  let pendingDelete = false;
  let toldDismissed = false;

  let code = 0;
  for (;;) {
    if (stream) {
      const ended = stream.ended ?? (await reconcile(current, room.id));
      stream = undefined;
      // While a delete reads a dirty room it is briefly out of `GET /rooms`,
      // so a 404 is part of the dismissal already being handled.
      if (
        holdDismissed &&
        (ended.kind === "dismissed" || ended.kind === "unknown")
      ) {
        readOnly = true;
        pendingDelete = false;
        if (!toldDismissed) {
          console.log(
            "the room is dismissed; /delete to remove it, /leave to exit",
          );
          toldDismissed = true;
        }
        continue;
      }
      code = codeOf(ended);
      (code ? console.error : console.log)(endedLine(ended, room.id));
      break;
    }
    if (lines.length === 0) {
      if (inputDone) break;
      await new Promise<void>((ok) => {
        wake = ok;
      });
      continue;
    }
    const text = (lines.shift() ?? "").trim();
    if (!text) continue;

    // A send right after a restart must carry the new token.
    await current().catch(() => {});
    const confirming = pendingDelete && text === "/delete";
    pendingDelete = false;
    const c = parseLine(text, rosterOf(state, room.participants));
    if ("error" in c) {
      console.error(`! ${c.error}`);
      continue;
    }
    if (
      readOnly &&
      c.verb !== "delete" &&
      c.verb !== "help" &&
      c.verb !== "leave"
    ) {
      console.error("! the room is dismissed; /delete, /help or /leave");
      continue;
    }
    if (c.verb === "leave") break;
    if (c.verb === "help") {
      for (const l of HELP) console.log(l);
      continue;
    }
    if (c.verb === "delete") {
      if (!confirming) {
        const p = await deletePreview(d, room.id).catch(() => undefined);
        if (!p) {
          console.error(`! ${NO_DAEMON}`);
          continue;
        }
        if (!p.ok) {
          console.error(`! ${p.error.message}`);
          continue;
        }
        const n = p.body.branches.length;
        console.log(
          `delete ${printable(room.title ?? room.id)}: ${n} branch${n === 1 ? "" : "es"}`,
        );
        for (const l of deletePreviewLines(p.body)) console.log(l);
        console.log("type /delete again to confirm; any other input cancels");
        pendingDelete = true;
        continue;
      }
      holdDismissed = true;
      const r = await runCommand(d, room.id, c).catch(() => undefined);
      if (!r) {
        holdDismissed = readOnly;
        console.error(`! ${NO_DAEMON}`);
        continue;
      }
      if (!r.ok) {
        const dismissed = readOnly || r.room?.status === "dismissed";
        holdDismissed = dismissed;
        readOnly = dismissed;
        console.error(`! ${r.message}`);
        if (r.code === "uncommitted_work") {
          console.error("commit or remove them, then type /delete again");
        }
        continue;
      }
      console.log(r.line);
      code = 0;
      break;
    }
    if (c.verb === "ff") {
      console.error(
        "! a fast-forward needs the TUI preview; run it from kapelle chat on a terminal",
      );
      continue;
    }
    if (c.verb === "term") {
      console.error(
        "! a shell needs the full-screen chat: run kapelle chat on a terminal",
      );
      continue;
    }
    if (c.verb === "setup") {
      const r = await (c.done ? markDone(d) : findAgain(d)).catch(
        () => undefined,
      );
      if (!r) console.error(`! ${NO_DAEMON}`);
      else if (!r.ok) console.error(`! ${r.error.message}`);
      else if (c.done)
        console.log("setup done: the list no longer opens at start");
      else for (const l of setupLines(r.body)) console.log(l.text);
      continue;
    }
    if (c.verb === "form") {
      const usage = c.form === "loop" ? HELP[2] : COMMAND_USAGE[c.form];
      console.error(`! a form needs a terminal: ${usage}`);
      continue;
    }
    // A pipe has no pick list: the live models are printed (M9-6).
    if (c.verb === "models") {
      const r = await participantNow(d, room.id, c.id).catch(() => undefined);
      if (!r) console.error(`! ${NO_DAEMON}`);
      else if (!r.ok) console.error(`! ${r.message}`);
      else for (const l of modelLines(r.p)) console.log(l);
      continue;
    }
    // A pipe has no pane: the diff is printed as it is (M4-6).
    if (c.verb === "diff") {
      const r = await agentDiff(d, room.id, c.id, c.against).catch(
        () => undefined,
      );
      if (!r) console.error(`! ${NO_DAEMON}`);
      else if (!r.ok) console.error(`! ${r.error.message}`);
      else console.log(cleanLines(r.body.text) || `${c.name}: no changes`);
      continue;
    }
    if (c.verb !== "message") {
      const r = await runCommand(d, room.id, c).catch(() => undefined);
      if (!r) {
        console.error(`! ${NO_DAEMON}`);
        continue;
      }
      if (!r.ok) {
        console.error(`! ${r.message}`);
        // A pipe cannot ask, as the screen does: say how to add it.
        if (
          r.code === "repo_not_added" &&
          (c.verb === "new" || c.verb === "loop")
        ) {
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
        if ((c.verb === "new" || c.verb === "loop") && r.room) {
          console.log(`attach with: kapelle chat attach ${r.room.id}`);
        }
        continue;
      }
      await streamDone;
      console.log("the room was dismissed");
      break;
    }

    const t = c.target;
    if ("error" in t) {
      console.error(`! ${t.error}`);
      continue;
    }
    const r = await call<MessageAccepted>(
      d,
      `/rooms/${room.id}/agents/${t.id}/messages`,
      { method: "POST", body: { text: t.text } },
    ).catch(() => undefined);
    if (!r) {
      console.error(`! ${NO_DAEMON}`);
      continue;
    }
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
      streamDone,
    ]);
  }

  rl.close();
  return code;
}

export { chatPiped, makePrinter };
