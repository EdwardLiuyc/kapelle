#!/usr/bin/env node
/**
 * `chat.ts` — a terminal chat over the daemon's rooms (chat MVP).
 *
 * **Experimental.** One participant per room — the first on its roster, which
 * is the one it shows and the one it sends to by id — `auto` only, and no
 * permission answering. The room API is Experimental in
 * `docs/CLIENT-API.md`, and M6-3..M6-9 will reshape it; nothing here is a
 * compatibility commitment.
 *
 * **A front end, not part of the daemon.** It speaks HTTP to `daemon.ts` and
 * nothing else, so anything it can do, a bridge to another chat app can do
 * too. From this repository it imports `client/`, which is the transport and
 * the contract's types, and `core/runtime.ts`, which says where `daemon.json`
 * lives (M4-1, S8). `tests/daemon.test.ts` holds that line.
 *
 * **It parses no event itself.** Each line goes through the room reducer
 * (`client/room.ts`, M6-10), and both screens draw the entry it returns. The
 * names come from the reducer too, so a rename shows on the lines after it.
 * A line already drawn keeps the name it had.
 *
 * One room is one harness kept alive between messages, until `/dismiss`.
 * Leaving (`/leave`, end of input, ^C) keeps the room, and `attach` replays
 * its whole conversation from the room's event log.
 *
 * **Two screens over one stream.** On a TTY the room is a full-screen
 * `pi-tui` app: a scrolling transcript with each answer rendered as markdown
 * while it streams, and an editor below it. Piped, it is plain lines, which
 * is what a script or a test reads.
 *
 * **pi-tui is ratified under M1c-7's rule (M4-1).** It is presentation only,
 * so its worst failure is a broken screen, never a changed decision; it is
 * pinned exactly; its nested `marked` is overridden to ours, so one copy is
 * installed; and a throw from it leaves the screen before the process exits,
 * with the command to rejoin the room, which lives on in the daemon. It ships two native helpers, both loaded lazily inside a
 * try/catch: `darwin-modifiers.node` reads Shift for Shift+Enter in Apple
 * Terminal only, and `win32-console-mode.node` runs on Windows only, which
 * `package.json`'s `os` leaves out. Linux never loads either.
 */

import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import {
  type Component,
  Container,
  Editor,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";

import type {
  MessageAccepted,
  RoomDto,
  RoomEventLine,
  RoomListEntry,
} from "./client/contract.ts";
import {
  call,
  checkVersion,
  type DaemonAddress,
  readDaemonFile,
  request,
} from "./client/daemon.ts";
import {
  applyLine,
  type Entry,
  nameOf,
  newRoomState,
  type RoomState,
} from "./client/room.ts";
import { type Connect, followEvents } from "./client/stream.ts";
import { runtimeDir } from "./core/runtime.ts";

const USAGE = `usage: (experimental — the room API may change without notice)
  node chat.ts new --agent <id> [--name n] [--cwd dir]      open a room and chat in it
  node chat.ts new --cmd "<command>" [--name n] [--cwd dir]
  node chat.ts attach <roomId>                              rejoin a room; its history replays
  node chat.ts list                                         every room the daemon holds
  node chat.ts dismiss <roomId>                             stop a room's harness

--name is the agent's name; the harness name by default. Give one when that
is not a valid name, as for --cmd "/opt/bin/my-agent".

in a room, type a message and press enter:
  /leave     exit; the room and its harness stay alive
  /dismiss   stop the harness and exit; uncommitted work stays in its
             checkout, because the supervisor never commits for it (R37)`;

const daemonFile = () => join(runtimeDir(), "daemon.json");

/** The daemon named in `daemon.json`, or a throw that says how to start one.
 *  Read again on every call: a daemon that restarts has a new token. */
async function address(): Promise<DaemonAddress> {
  const d = await readDaemonFile(daemonFile());
  if (typeof d === "string") {
    throw new Error(
      `no daemon is listening (${daemonFile()} is missing or not ready). ` +
        "Start one with: kapelle daemon start",
    );
  }
  return d;
}

/**
 * Reads a room's events into `onEvent` until the daemon ends the stream —
 * which it does when the room is dismissed. A cut while the daemon still
 * answers reconnects and resumes after the last event seen
 * (`client/stream.ts`). Throws when the daemon stops or refuses the stream.
 */
async function readRoom(
  id: string,
  onEvent: (event: RoomEventLine) => void,
): Promise<void> {
  // A room does not survive a daemon restart, so there is nothing to wait
  // for: no daemon, or one that does not answer, ends the stream at once.
  // That is also why there is no version check here.
  const connect: Connect = async (after, signal) => {
    const d = await readDaemonFile(daemonFile());
    if (typeof d === "string") return undefined;
    try {
      return await request(d, `/rooms/${encodeURIComponent(id)}/events`, {
        signal,
        headers: { "last-event-id": String(after) },
      });
    } catch (err) {
      // An abort is the reader's own silence timer: try again.
      if (signal.aborted) throw err;
      return undefined;
    }
  };
  for await (const event of followEvents<RoomEventLine>(connect)) {
    onEvent(event);
  }
}

/** The stream ended without our dismiss: ask the daemon what happened.
 *  `dismissed` is someone else's dismissal; anything else means the daemon or
 *  its stream is gone and the room's fate is unknown. */
async function reconcile(id: string): Promise<{ code: number; line: string }> {
  try {
    const r = await call<RoomDto>(await address(), `/rooms/${id}`);
    if (r.ok) {
      if (r.body.status === "dismissed") {
        return { code: 0, line: "the room was dismissed" };
      }
      // The stream died, the room did not. Name the state the daemon
      // reports rather than the status of the GET that reported it, and
      // say how to get back in.
      return {
        code: 1,
        line:
          `! lost the room stream; the room is still ${r.body.status} — ` +
          `rejoin with: chat.ts attach ${id}`,
      };
    }
    if (r.status === 404) {
      return {
        code: 1,
        line: `! the daemon no longer knows room ${id}; it may have restarted`,
      };
    }
    return {
      code: 1,
      line: `! lost the room stream (HTTP ${r.status}); the room may still be alive`,
    };
  } catch (err) {
    return { code: 1, line: `! lost the daemon: ${(err as Error).message}` };
  }
}

/** Where a message goes: the participant this chat shows, by id (M6-4). A
 *  room with none gets the room route, so the daemon's refusal says why. */
const messagesPath = (room: RoomDto) => {
  const [agent] = room.participants;
  return agent
    ? `/rooms/${room.id}/agents/${agent.id}/messages`
    : `/rooms/${room.id}/messages`;
};

/** Prints the reducer's entries as a conversation, for a piped stdin. An
 *  answer that grows prints only its new text, and its name again when
 *  another line came between. */
function makePrinter(state: RoomState) {
  let atLineStart = true;
  let last: Entry | undefined;
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
          line(`you: ${e.text}`);
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
            write(`${nameOf(state, e.participantId)}: `);
          }
          write(e.text.slice(printed.get(e) ?? 0));
          printed.set(e, e.text.length);
          break;
        case "tool":
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
        default:
          // Questions and stall warnings: this chat runs `auto` and answers
          // nothing yet (M4-3, M4-4). Nothing was written.
          return;
      }
      last = e;
    },
  };
}

const sgr = (open: number, close: number) => (s: string) =>
  `\x1b[${open}m${s}\x1b[${close}m`;
const bold = sgr(1, 22);
const dim = sgr(2, 22);
const italic = sgr(3, 23);
const underline = sgr(4, 24);
const cyan = sgr(36, 39);
const green = sgr(32, 39);
const yellow = sgr(33, 39);

/** A rendered line without its padding: the trailing spaces and the style
 *  codes among them go, and a styled line ends with a reset, because a
 *  wrapped line can open a style and leave it open. */
const unpad = (line: string) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const text = line.replace(/(?: |\x1b\[[0-9;]*m)+$/, "");
  return text.includes("\x1b") ? `${text}\x1b[0m` : text;
};

const MARKDOWN_THEME: MarkdownTheme = {
  heading: (s) => bold(cyan(s)),
  link: (s) => underline(cyan(s)),
  linkUrl: dim,
  code: yellow,
  codeBlock: (s) => s,
  codeBlockBorder: dim,
  quote: italic,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic,
  strikethrough: sgr(9, 29),
  underline,
};

const EDITOR_THEME = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};

/**
 * The full-screen chat for one room. Resolves with the exit code.
 *
 * Busy is the reducer's status for the agent, which it reads from the stream,
 * not from this terminal's own requests. So a replayed history, or a message
 * another client sent, leaves the status line right with no bookkeeping of
 * which turn is ours. Busy never locks the editor: `/dismiss` and `/leave`
 * must work mid-turn, and a message sent then waits in the agent's queue
 * (M6-4).
 */
function chatTui(d: DaemonAddress, room: RoomDto): Promise<number> {
  const [agent] = room.participants;
  const state = newRoomState();
  const tui = new TuiAltScreen(new ProcessTerminal());
  const transcript = new Container();
  const status = new Text("", 1, 0);
  const editor = new Editor(tui, EDITOR_THEME, { paddingX: 1 });
  tui.setLayoutRoot(
    new VStack([
      {
        component: new ScrollView(transcript, { follow: "end", primary: true }),
        basis: "auto",
        grow: 1,
        shrink: 1,
        minSize: 1,
      },
      { component: status, basis: "auto", shrink: 0 },
      { component: editor, basis: "auto", shrink: 1, minSize: 1 },
    ]),
  );
  tui.setFocus(editor);

  const add = (c: Component) => {
    transcript.addChild(c);
    tui.requestRender();
  };
  const note = (s: string) => add(new Text(dim(s), 1, 0));
  const warn = (s: string) => add(new Text(yellow(s), 1, 0));
  const setBusy = (busy: boolean) => {
    status.setText(
      dim(
        busy
          ? `${agent?.name ?? "the agent"} is answering…`
          : "enter to send · /leave keeps the room · /dismiss stops it",
      ),
    );
    tui.requestRender();
  };

  note(
    agent
      ? `room ${room.id} · ${agent.name} (${agent.harness}) · ${agent.worktree}`
      : `room ${room.id} · no agents`,
  );
  for (const { text } of agent?.notices ?? []) warn(`! ${text}`);
  let busy = agent?.status === "busy";
  setBusy(busy);

  // Each answer's component. The reducer joins the chunks, and the whole
  // text is re-set, because markdown only parses correctly as a whole.
  // ponytail: re-parses the whole answer per frame (~5 ms at 53k chars,
  // measured); split finished blocks into their own components if it lags.
  const answers = new WeakMap<Entry, Markdown>();
  const draw = (e: Entry) => {
    switch (e.type) {
      case "user":
        add(new Text(`\n${bold(cyan("you"))}\n${e.text}`, 1, 0));
        return;
      case "queued":
        note(`queued for ${nameOf(state, e.participantId)}: ${e.text}`);
        return;
      case "queue_cleared":
        warn(`! ${e.count} queued message(s) dropped, unsent`);
        return;
      case "answer": {
        let md = answers.get(e);
        if (!md) {
          const name = nameOf(state, e.participantId);
          add(new Text(`\n${bold(green(name))}`, 1, 0));
          md = new Markdown("", 1, 0, MARKDOWN_THEME);
          answers.set(e, md);
          add(md);
        }
        md.setText(e.text);
        tui.requestRender();
        return;
      }
      case "tool":
        note(`  · ${e.title}`);
        return;
      case "turn_ended":
        if (e.error) warn(`! the turn failed: ${e.error}`);
        else if (e.stopReason !== "end_turn") {
          warn(`! the turn ended: ${e.stopReason}`);
        }
        return;
      case "exited":
        warn("! the harness exited");
        return;
      default:
        // Not drawn yet, as in the piped printer.
        return;
    }
  };
  const show = (line: RoomEventLine) => {
    const e = applyLine(state, line);
    if (e) draw(e);
    const now = state.participants.get(agent?.id ?? "")?.status === "busy";
    if (now === busy) return;
    busy = now;
    setBusy(busy);
  };

  return new Promise((finish) => {
    let done = false;
    // The transcript is printed to the normal screen on exit, so the
    // conversation stays in scrollback. Not by `tui.stop()`'s own reprint:
    // that pads every line to the full width, and a terminal that wraps at
    // the last column at once (Windows ConPTY, some multiplexers) then shows
    // an empty line after each one. It would also copy the status line and
    // the editor. So only the transcript is printed, with the padding cut.
    const end = (code: number, ...last: string[]) => {
      if (done) return;
      done = true;
      // The screen is going: a later throw gets Node's default again, a
      // stack and a non-zero exit, instead of being swallowed here.
      process.off("uncaughtException", crash);
      process.off("unhandledRejection", crash);
      let lines: string[] = [];
      try {
        lines = transcript.render(process.stdout.columns || 80);
      } catch {
        // The transcript is what failed to draw: leave the screen without
        // it. `attach` replays the conversation.
      }
      tui.stop({ preserveScreen: true });
      for (const line of lines) console.log(unpad(line));
      for (const line of last) console.log(line);
      finish(code);
    };
    const left = `left room ${room.id}; rejoin with: node chat.ts attach ${room.id}`;

    tui.addInputListener((data) => {
      if (!matchesKey(data, Key.ctrl("c"))) return undefined;
      end(0, left);
      return { consume: true };
    });

    // pi-tui calls this and drops the promise, so a throw (the daemon gone
    // mid-request) must end the chat here, or it crashes on the alt screen.
    editor.onSubmit = (text) => {
      submit(text).catch((err) => end(1, `! ${(err as Error).message}`));
    };
    const submit = async (text: string) => {
      if (!text) return;
      if (text === "/leave") return end(0, left);
      if (text === "/dismiss") {
        status.setText(dim("dismissing: stopping the harness…"));
        tui.requestRender();
        const r = await call<RoomDto>(d, `/rooms/${room.id}/dismiss`, {
          method: "POST",
        });
        // A 200 ends the stream, and that ends the chat below.
        if (!r.ok) end(1, `! ${r.error.message}`);
        return;
      }
      editor.addToHistory(text);
      const r = await call<MessageAccepted>(d, messagesPath(room), {
        method: "POST",
        body: { text },
      });
      if (!r.ok) warn(`! ${r.error.message}`);
    };

    // pi-tui draws off our call stack, so a bug in it is an uncaught throw
    // that would end the process on the alternate screen. Leave the screen
    // first: M1c-7 needs its worst failure to stay cosmetic.
    const crash = (err: unknown) =>
      end(
        1,
        `! the chat screen failed: ${err instanceof Error ? err.message : String(err)}`,
        left,
      );
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
    try {
      tui.start();
    } catch (err) {
      crash(err);
      return;
    }
    readRoom(room.id, show).then(
      async () => {
        const { code, line } = await reconcile(room.id);
        end(code, line);
      },
      async (err) => {
        const { code, line } = await reconcile(room.id);
        end(code, `! ${(err as Error).message}`, line);
      },
    );
  });
}

/** The chat loop for one room. Resolves with the exit code. */
async function chat(d: DaemonAddress, room: RoomDto): Promise<number> {
  if (process.stdin.isTTY && process.stdout.isTTY) return chatTui(d, room);

  const [agent] = room.participants;
  console.log(
    agent
      ? `room ${room.id} · ${agent.name} (${agent.harness}) · ${agent.worktree}`
      : `room ${room.id} · no agents`,
  );
  for (const { text } of agent?.notices ?? []) console.log(`! ${text}`);
  console.log("type a message; /leave to exit, /dismiss to stop the room");

  const state = newRoomState();
  const printer = makePrinter(state);

  // The highest turn end seen, and the one turn being waited on.
  let lastTurnEnd = 0;
  let waiting: { after: number; done: () => void } | undefined;

  const ended = readRoom(room.id, (line) => {
    const e = applyLine(state, line);
    if (!e) return;
    printer.show(e);
    if (e.type === "turn_ended") {
      lastTurnEnd = e.seq;
      if (waiting && e.seq > waiting.after) {
        waiting.done();
        waiting = undefined;
      }
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
    if (next === null || next.trim() === "/leave") break;
    const text = next.trim();
    if (!text) continue;

    if (text === "/dismiss") {
      const r = await call<RoomDto>(d, `/rooms/${room.id}/dismiss`, {
        method: "POST",
      });
      if (!r.ok) {
        console.error(`! ${r.error.message}`);
        code = 1;
        break;
      }
      await ended;
      console.log("the room was dismissed");
      break;
    }

    const r = await call<MessageAccepted>(d, messagesPath(room), {
      method: "POST",
      body: { text },
    });
    if (!r.ok) {
      console.error(`! ${r.error.message}`);
      continue;
    }
    if (lastTurnEnd > r.body.seq) continue;
    await Promise.race([
      new Promise<void>((done) => {
        waiting = { after: r.body.seq, done };
      }),
      ended,
    ]);
  }

  rl.close();
  return code;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      cmd: { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [verb, arg] = positionals;
  if (values.help || !verb) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const d = await address();
  // B5: a different `major` throws `VersionRefused`, which `main`'s caller
  // prints; a different `minor` is a warning.
  const warning = await checkVersion(d);
  if (warning) console.error(`! ${warning}`);

  if (verb === "new") {
    const cwd = resolve(values.cwd ?? process.cwd());
    const r = await call<RoomDto>(d, "/rooms", {
      method: "POST",
      body: {
        cwd,
        agents: [
          {
            agent: values.agent,
            cmd: values.cmd,
            name: values.name,
            role: "orchestrator",
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
    const r = await call<RoomDto>(d, `/rooms/${arg}`);
    if (!r.ok) {
      console.error(`error: ${r.error.message}`);
      return 1;
    }
    return chat(d, r.body);
  }

  if (verb === "list") {
    const r = await call<RoomListEntry[]>(d, "/rooms");
    if (!r.ok) {
      console.error(`error: ${r.error.message}`);
      return 1;
    }
    for (const room of r.body) {
      const names = room.participants.map((p) => p.name).join(",") || "-";
      console.log(`${room.id}  ${room.status}  ${names}  ${room.cwd}`);
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
