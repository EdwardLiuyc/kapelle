#!/usr/bin/env node
/**
 * `chat.ts` — a terminal chat over the daemon's rooms (chat MVP).
 *
 * The room API is stable since contract 1.8 (M6-7a, `docs/CLIENT-API.md`).
 * This screen is not an API: its keys and lines may change. `kapelle chat`
 * runs this file (S7a).
 *
 * **The entry only** (M4-7): the arguments, the `new`, `attach`, `list`,
 * `dismiss` and `scratch` verbs, and which screen to open. The screens are in
 * `chat/`:
 * `chat/tui.ts` on a terminal, `chat/piped.ts` on a pipe, and what both use
 * in `chat/common.ts`.
 *
 * **A front end, not part of the daemon.** It speaks HTTP to `daemon.ts` and
 * nothing else, so anything it can do, a bridge to another chat app can do
 * too. From this repository it and `chat/` import `client/`, which is the
 * transport and the contract's types, and `core/runtime.ts`, which says
 * where `daemon.json` lives (M4-1, S8). `tests/chat-piped.test.ts` holds
 * that line.
 *
 * **It parses no event itself.** Each line goes through the room reducer
 * (`client/room.ts`, M6-10), and both screens draw the entry it returns. The
 * names come from the reducer too, so a rename shows on the lines after it.
 * A line already drawn keeps the name it had.
 *
 * **The composer names the target** (R43): a leading `@name` goes to that
 * participant, and no mention goes to the orchestrator, or to the only agent
 * when the room has none. In a hall chat a bare message is refused unless the
 * pipe attached one agent by name. Both screens resolve it with
 * `client/mention.ts`, so they cannot differ. Room commands (`/add`,
 * `@name /mode ask`, …) go through `client/command.ts` the same way (M4-5),
 * and never reach an agent.
 *
 * A room keeps its harnesses alive between messages, until `/dismiss` or
 * `/delete`. Leaving (`/leave`, end of input, ^C) keeps every room, and `attach`
 * replays a room's whole conversation from its event log.
 *
 * **Two screens.** On a TTY it is a full-screen `pi-tui` app over every
 * room the daemon holds, and the hall's agents as chats (M4-2, M11-1).
 * Piped, it is one room or one hall agent as plain lines.
 */

import { parseArgs } from "node:util";
import { address } from "./chat/common.ts";
import { chatPiped } from "./chat/piped.ts";
import { chatTui } from "./chat/tui.ts";
import { HALL_ID, HELP, NO_HALL } from "./client/command.ts";
import type {
  RoomDto,
  RoomListEntry,
  ScratchCleanReply,
  ScratchFolder,
} from "./client/contract.ts";
import { call, checkVersion, type DaemonAddress } from "./client/daemon.ts";
import { absoluteFolder, FOLDER_GONE } from "./client/folder.ts";
import { fold } from "./client/mention.ts";
import { printable } from "./client/room.ts";

const USAGE = `usage:
  node chat.ts                                              every room and chat, on a terminal
  node chat.ts new --agent <id> [--name n] [--cwd dir]      open a room and chat in it
  node chat.ts new --cmd "<command>" [--name n] [--cwd dir]
  node chat.ts attach <roomId|@name> [--no-setup]           rejoin a room; a pipe can open a hall chat
  node chat.ts list                                         every room, then every chat
  node chat.ts dismiss <roomId>                             stop a room's harness
  node chat.ts scratch [clean [--yes]]                      kept hall scratch folders;
                                                             clean previews, --yes removes

--no-setup keeps the setup list closed at start; kapelle demo uses it.

--name is the agent's name; the harness name by default. Give one when that
is not a valid name, as for --cmd "/opt/bin/my-agent".

kapelle chat takes the same verbs.

in a room, type a message and press enter. It goes to the orchestrator, or to
the only agent when the room has none; start it with @name to send it to that
agent instead. A pipe opens one hall agent with attach @name, and a bare
message goes to that agent.
  /leave     exit; the rooms and their harnesses stay alive
  /dismiss   stop the room's harnesses; uncommitted work stays in each
             checkout, because the supervisor never commits for it (R37)
  /delete    show the branches and unmerged commits, then confirm; removes
             the room and every branch it owns
  /help      the commands below, on the screen
  /setup     the agents the daemon found, and what to install; it opens at
             the start until "done" (/setup done), or while no agent is ready
  ${HELP.slice(0, 9).join("\n  ")}
a command never reaches an agent. Room commands work after a thread's
@name too; in a piped hall chat, a participant command with no @name goes to
the pinned agent.

on a terminal: alt+up/down or ctrl+p/n (or a click) picks a room's timeline,
one agent's thread or a chat; ctrl+t (or a click on « ») hides the sidebar;
ctrl+o opens the menu over the conversation, and /new, /add or /chat alone
opens its form`;

const isTty = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** A terminal gets every room, with `room` selected; a pipe gets `room`
 *  alone, or one of its participants when `participantId` names a hall chat.
 *  A dismissed room is listed only when it is the one asked for, so `attach`
 *  still replays it. */
async function chat(
  d: DaemonAddress,
  room?: RoomDto,
  setup = true,
  participantId?: string,
): Promise<number> {
  // `main` prints the usage for a pipe with no verb, so a pipe has a room.
  if (!isTty() && room) return chatPiped(d, room, participantId);
  const r = await call<RoomListEntry[]>(d, "/rooms");
  if (!r.ok) {
    console.error(`error: ${r.error.message}`);
    return 1;
  }
  const list = r.body.filter(
    (x) => x.status !== "dismissed" || x.id === room?.id,
  );
  // With no room, the screen still opens: ctrl+o or /new opens one (M4-5).
  return chatTui(d, list, room?.id, setup);
}

/** The room `attach` asks for, and on a pipe the hall agent it pins (M11-1). */
async function attachTarget(
  d: DaemonAddress,
  arg: string,
): Promise<{ room: RoomDto; participantId?: string } | { error: string }> {
  let roomId = arg;
  let participantId: string | undefined;
  if (arg.startsWith("@")) {
    if (isTty()) {
      return {
        error:
          "attach by name works on a pipe; run kapelle chat and pick the chat",
      };
    }
    const rooms = await call<RoomListEntry[]>(d, "/rooms");
    if (!rooms.ok) return { error: rooms.error.message };
    const hall = rooms.body.find((x) => x.hall);
    if (!hall) return { error: NO_HALL };
    const name = fold(arg.slice(1));
    const participant = hall.participants.find((p) => fold(p.name) === name);
    if (!participant) {
      return { error: `no hall chat named ${arg}; run kapelle chat list` };
    }
    roomId = hall.id;
    participantId = participant.id;
  } else if (!isTty() && fold(arg) === fold(HALL_ID)) {
    return {
      error:
        "attach a hall chat by name: kapelle chat list, then kapelle chat attach @<name>",
    };
  }
  const r = await call<RoomDto>(d, `/rooms/${roomId}`);
  return r.ok ? { room: r.body, participantId } : { error: r.error.message };
}

/** A folder's size for the scratch list, short enough for one line. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Print one scratch folder. `entries` is what the operator is deciding on. */
function printScratch(folder: ScratchFolder): void {
  let state: string;
  if (folder.inUse) {
    state = `in use by @${printable(folder.participant ?? folder.id)} (protected)`;
  } else if (folder.kind === "directory") {
    state = "stale";
  } else if (folder.kind === "symlink") {
    state = "symbolic link (not removable)";
  } else {
    state = "not a folder (not removable)";
  }
  console.log(`${printable(folder.id)}  ${state}  ${printable(folder.path)}`);
  if (folder.kind === "directory") {
    const entries = folder.entries.length
      ? folder.entries.map(printable).join(", ")
      : "empty";
    console.log(`  ${folder.files} file(s), ${size(folder.bytes)}: ${entries}`);
  }
  if (folder.problem !== undefined) {
    console.log(`  ! ${printable(folder.problem)}`);
  }
}

/** `kapelle chat scratch [clean [--yes]]` — list, preview, or remove stale
 *  hall scratch folders. The daemon's live roster decides which are stale. */
async function runScratch(
  d: DaemonAddress,
  clean: boolean,
  yes: boolean,
): Promise<number> {
  const r = await call<ScratchFolder[]>(d, `/rooms/${HALL_ID}/scratch`);
  if (!r.ok) {
    console.error(`error: ${r.error.message}`);
    return 1;
  }
  for (const folder of r.body) printScratch(folder);
  if (!clean) return 0;

  const stale = r.body.filter(
    (folder) => !folder.inUse && folder.kind === "directory",
  );
  if (!yes) {
    console.log(
      stale.length
        ? `nothing was deleted; run kapelle chat scratch clean --yes to remove ${stale.length} stale folder(s)`
        : "nothing to remove",
    );
    return 0;
  }
  if (stale.length === 0) {
    console.log("nothing to remove");
    return 0;
  }

  const cleaned = await call<ScratchCleanReply>(
    d,
    `/rooms/${HALL_ID}/scratch/clean`,
    {
      method: "POST",
      body: { ids: stale.map((folder) => folder.id) },
    },
  );
  if (!cleaned.ok) {
    console.error(`error: ${cleaned.error.message}`);
    return 1;
  }
  let failed = 0;
  for (const result of cleaned.body.results) {
    if (result.removed) {
      console.log(`removed ${printable(result.path)}`);
    } else if (result.protected) {
      console.log(
        `kept ${printable(result.path)}: ${printable(result.error ?? "in use")}`,
      );
    } else {
      failed++;
      console.error(
        `! could not remove ${printable(result.path)}: ${printable(result.error ?? "unknown error")}`,
      );
    }
  }
  return failed > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      cmd: { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
      "no-setup": { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [verb, arg] = positionals;
  if (values.help || (!verb && !isTty())) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  // The screen and `new` need the current folder, and `process.cwd()`
  // throws when it was removed. Say so before the screen opens; the screen
  // handles a folder removed after that. `list`, `attach` and `dismiss`
  // need no folder.
  const cwd = absoluteFolder(values.cwd);
  if (!cwd && (!verb || verb === "new")) {
    console.error(`error: ${FOLDER_GONE}`);
    return 1;
  }

  const d = await address();
  // B5: a different `major` throws `VersionRefused`, which `main`'s caller
  // prints; a different `minor` is a warning.
  const warning = await checkVersion(d);
  if (warning) console.error(`! ${warning}`);

  if (!verb) return chat(d);

  if (verb === "new" && cwd) {
    const r = await call<RoomDto>(d, "/rooms", {
      method: "POST",
      body: {
        cwd,
        agents: [
          {
            agent: values.agent,
            cmd: values.cmd,
            name: values.name,
            role: "developer",
          },
        ],
      },
    });
    if (!r.ok) {
      console.error(`error: ${r.error.message}`);
      if (r.error.code === "repo_not_added") {
        console.error("add the repository first: kapelle daemon add <path>");
      }
      return 1;
    }
    return chat(d, r.body);
  }

  if (verb === "attach" && arg) {
    const found = await attachTarget(d, arg);
    if ("error" in found) {
      console.error(`error: ${found.error}`);
      return 1;
    }
    return chat(d, found.room, !values["no-setup"], found.participantId);
  }

  if (verb === "scratch") {
    if (
      positionals.length > 2 ||
      (arg !== undefined && arg !== "clean") ||
      (values.yes && arg !== "clean")
    ) {
      console.error(USAGE);
      return 1;
    }
    return runScratch(d, arg === "clean", values.yes === true);
  }

  if (verb === "list") {
    const r = await call<RoomListEntry[]>(d, "/rooms");
    if (!r.ok) {
      console.error(`error: ${r.error.message}`);
      return 1;
    }
    // The rooms, then the hall's agents as chats (M11-1).
    for (const room of r.body.filter((x) => !x.hall)) {
      const names = room.participants.map((p) => p.name).join(",") || "-";
      console.log(`${room.id}  ${room.status}  ${names}  ${room.cwd}`);
    }
    for (const hall of r.body.filter((x) => x.hall)) {
      for (const p of hall.participants) {
        console.log(`@${p.name} (hall)  ${p.status}  ${hall.cwd}`);
      }
    }
    return 0;
  }

  if (verb === "dismiss" && arg) {
    const r = await call<RoomDto>(d, `/rooms/${arg}/dismiss`, {
      method: "POST",
    });
    if (!r.ok) {
      console.error(`error: ${r.error.message}`);
      return 1;
    }
    console.log(`dismissed ${arg}`);
    return 0;
  }

  console.error(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
