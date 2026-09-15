#!/usr/bin/env node
/**
 * `chat.ts` — a terminal chat over the daemon's rooms (chat MVP).
 *
 * **A front end, not part of the daemon.** It speaks HTTP to `daemon.ts` and
 * nothing else, so anything it can do, a bridge to another chat app can do
 * too. The one import from this repository is `core/runtime.ts`, which says
 * where `daemon.json` lives; `tests/daemon.test.ts` holds that line.
 *
 * One room is one harness kept alive between messages, until `/dismiss`.
 * Leaving (`/leave`, end of input, ^C) keeps the room, and `attach` replays
 * its whole conversation from the room's event log.
 *
 * **Two screens over one stream.** On a TTY the room is a full-screen
 * `pi-tui` app: a scrolling transcript with each answer rendered as markdown
 * while it streams, and an editor below it. Piped, it is plain lines, which
 * is what a script or a test reads.
 */

import { readFile } from "node:fs/promises";
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

import { runtimeDir } from "./core/runtime.ts";

const USAGE = `usage:
  node chat.ts new --agent <id> [--cwd dir]       open a room and chat in it
  node chat.ts new --cmd "<command>" [--cwd dir]
  node chat.ts attach <roomId>                    rejoin a room; its history replays
  node chat.ts list                               every room the daemon holds
  node chat.ts dismiss <roomId>                   stop a room's harness

in a room, type a message and press enter:
  /leave     exit; the room and its harness stay alive
  /dismiss   stop the harness, commit its work, and exit`;

interface Daemon {
  port: number;
  token: string;
}

interface RoomView {
  id: string;
  cwd: string;
  harness: string;
  workspace: string;
  status: string;
  notices: { text: string }[];
  error?: string;
}

/** One line of a room's event log, as the SSE stream carries it. */
interface LogEvent {
  seq: number;
  agent: string;
  update: {
    sessionUpdate: string;
    text?: string;
    title?: string;
    stopReason?: string;
    error?: string;
    content?: { type: string; text?: string };
  };
}

/** The daemon named in `daemon.json`, or a throw that says how to start one. */
async function findDaemon(): Promise<Daemon> {
  const file = join(runtimeDir(), "daemon.json");
  let holder: { port?: unknown; token?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) holder = parsed;
  } catch {
    // Missing or malformed: the same answer as "not listening", below.
  }
  const { port, token } = holder;
  if (typeof port !== "number" || typeof token !== "string" || !token) {
    throw new Error(
      `no daemon is listening (${file} is missing or not ready). ` +
        "Start one with: kapelle daemon start",
    );
  }
  return { port, token };
}

async function api<T>(
  d: Daemon,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T & { error?: string } }> {
  const res = await fetch(`http://127.0.0.1:${d.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${d.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/**
 * Reads a room's SSE stream until the daemon ends it — which it does when
 * the room is dismissed — or `signal` aborts.
 */
async function follow(
  d: Daemon,
  id: string,
  onEvent: (event: LogEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${d.port}/rooms/${id}/events`, {
    headers: { authorization: `Bearer ${d.token}` },
    signal,
  });
  if (!res.ok || !res.body) {
    const { error } = (await res.json()) as { error?: string };
    throw new Error(error ?? `events: HTTP ${res.status}`);
  }
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
      }
    }
  }
}

/** Prints a room's events as a conversation, for a piped stdin. */
function makePrinter() {
  let atLineStart = true;
  let speaking = false;
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
    show(event: LogEvent) {
      const u = event.update;
      switch (u.sessionUpdate) {
        case "_client_user_message":
          speaking = false;
          line(`you: ${u.text}`);
          return;
        case "agent_message_chunk":
          if (u.content?.type !== "text") return;
          if (!speaking) {
            if (!atLineStart) write("\n");
            write(`${event.agent}: `);
            speaking = true;
          }
          write(u.content.text ?? "");
          return;
        case "tool_call":
          line(`  · ${u.title}`);
          speaking = false;
          return;
        case "_client_turn_ended":
          if (u.error) line(`! the turn failed: ${u.error}`);
          else if (u.stopReason !== "end_turn") {
            line(`! the turn ended: ${u.stopReason}`);
          } else if (!atLineStart) write("\n");
          speaking = false;
          return;
        case "_client_harness_exited":
          line("! the harness exited");
          return;
      }
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
 * Busy is read from the stream, not from this terminal's own requests: a
 * `_client_user_message` starts a turn and `_client_turn_ended` ends it. So a
 * replayed history, or a message another client sent, leaves the editor in
 * the right state with no bookkeeping of which turn is ours.
 */
function chatTui(d: Daemon, room: RoomView): Promise<number> {
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
  const setBusy = (busy: boolean) => {
    editor.disableSubmit = busy;
    status.setText(
      dim(
        busy
          ? `${room.harness} is answering…`
          : "enter to send · /leave keeps the room · /dismiss stops it",
      ),
    );
    tui.requestRender();
  };

  note(`room ${room.id} · ${room.harness} · ${room.workspace}`);
  for (const { text } of room.notices) add(new Text(yellow(`! ${text}`), 1, 0));
  setBusy(room.status === "busy");

  // The answer being streamed: chunks are joined and the whole text re-set,
  // because markdown only parses correctly as a whole.
  // ponytail: re-parses the whole answer per frame (~5 ms at 53k chars,
  // measured); split finished blocks into their own components if it lags.
  let answer: { md: Markdown; text: string } | undefined;
  const show = ({ agent, update: u }: LogEvent) => {
    switch (u.sessionUpdate) {
      case "_client_user_message":
        answer = undefined;
        add(new Text(`\n${bold(cyan("you"))}\n${u.text}`, 1, 0));
        setBusy(true);
        return;
      case "agent_message_chunk":
        if (u.content?.type !== "text") return;
        if (!answer) {
          add(new Text(`\n${bold(green(agent))}`, 1, 0));
          answer = { md: new Markdown("", 1, 0, MARKDOWN_THEME), text: "" };
          add(answer.md);
        }
        answer.text += u.content.text ?? "";
        answer.md.setText(answer.text);
        tui.requestRender();
        return;
      case "tool_call":
        answer = undefined;
        note(`  · ${u.title}`);
        return;
      case "_client_turn_ended":
        answer = undefined;
        if (u.error)
          add(new Text(yellow(`! the turn failed: ${u.error}`), 1, 0));
        else if (u.stopReason !== "end_turn") {
          add(new Text(yellow(`! the turn ended: ${u.stopReason}`), 1, 0));
        }
        setBusy(false);
        return;
      case "_client_harness_exited":
        add(new Text(yellow("! the harness exited"), 1, 0));
        return;
    }
  };

  return new Promise((finish) => {
    const stop = new AbortController();
    let done = false;
    // `tui.stop()` leaves the alternate screen and prints the whole transcript
    // to the normal one, so the conversation stays in scrollback on exit.
    const end = (code: number, last: string) => {
      if (done) return;
      done = true;
      stop.abort();
      tui.stop();
      console.log(last);
      finish(code);
    };
    const left = `left room ${room.id}; rejoin with: node chat.ts attach ${room.id}`;

    tui.addInputListener((data) => {
      if (!matchesKey(data, Key.ctrl("c"))) return undefined;
      end(0, left);
      return { consume: true };
    });

    editor.onSubmit = async (text) => {
      if (!text) return;
      if (text === "/leave") return end(0, left);
      if (text === "/dismiss") {
        status.setText(dim("dismissing: stopping the harness…"));
        tui.requestRender();
        const r = await api<RoomView>(d, "DELETE", `/rooms/${room.id}`);
        // A 200 ends the stream, and that ends the chat below.
        if (r.status !== 200) end(1, `! ${r.body.error}`);
        return;
      }
      editor.addToHistory(text);
      const r = await api(d, "POST", `/rooms/${room.id}/messages`, { text });
      if (r.status !== 202) add(new Text(yellow(`! ${r.body.error}`), 1, 0));
    };

    tui.start();
    follow(d, room.id, show, stop.signal).then(
      () => end(0, "the room was dismissed"),
      (err) => end(1, `! ${(err as Error).message}`),
    );
  });
}

/** The chat loop for one room. Resolves with the exit code. */
async function chat(d: Daemon, room: RoomView): Promise<number> {
  if (process.stdin.isTTY && process.stdout.isTTY) return chatTui(d, room);

  console.log(`room ${room.id} · ${room.harness} · ${room.workspace}`);
  for (const { text } of room.notices) console.log(`! ${text}`);
  console.log("type a message; /leave to exit, /dismiss to stop the room");

  const printer = makePrinter();

  // The highest `_client_turn_ended` seen, and the one turn being waited on.
  let lastTurnEnd = 0;
  let waiting: { after: number; done: () => void } | undefined;

  const stop = new AbortController();
  const ended = follow(
    d,
    room.id,
    (event) => {
      printer.show(event);
      if (event.update.sessionUpdate === "_client_turn_ended") {
        lastTurnEnd = event.seq;
        if (waiting && event.seq > waiting.after) {
          waiting.done();
          waiting = undefined;
        }
      }
    },
    stop.signal,
  ).then(
    () => "ended" as const,
    (err) => {
      if (!stop.signal.aborted) console.error(`! ${(err as Error).message}`);
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
      console.log("the room was dismissed");
      break;
    }
    if (next === null || next.trim() === "/leave") break;
    const text = next.trim();
    if (!text) continue;

    if (text === "/dismiss") {
      const r = await api<RoomView>(d, "DELETE", `/rooms/${room.id}`);
      if (r.status !== 200) {
        console.error(`! ${r.body.error}`);
        code = 1;
        break;
      }
      await ended;
      console.log("the room was dismissed");
      break;
    }

    const r = await api<{ seq: number }>(
      d,
      "POST",
      `/rooms/${room.id}/messages`,
      { text },
    );
    if (r.status !== 202) {
      console.error(`! ${r.body.error}`);
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

  stop.abort();
  rl.close();
  return code;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      cmd: { type: "string" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [verb, arg] = positionals;
  if (values.help || !verb) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const d = await findDaemon();

  if (verb === "new") {
    const cwd = resolve(values.cwd ?? process.cwd());
    const r = await api<RoomView>(d, "POST", "/rooms", {
      cwd,
      agent: values.agent,
      cmd: values.cmd,
    });
    if (r.status !== 201) {
      console.error(`error: ${r.body.error}`);
      if (r.status === 403) {
        console.error("add the repository first: kapelle daemon add <path>");
      }
      return 1;
    }
    return chat(d, r.body);
  }

  if (verb === "attach" && arg) {
    const r = await api<RoomView>(d, "GET", `/rooms/${arg}`);
    if (r.status !== 200) {
      console.error(`error: ${r.body.error}`);
      return 1;
    }
    return chat(d, r.body);
  }

  if (verb === "list") {
    const r = await api<RoomView[]>(d, "GET", "/rooms");
    for (const room of r.body) {
      console.log(`${room.id}  ${room.status}  ${room.harness}  ${room.cwd}`);
    }
    return 0;
  }

  if (verb === "dismiss" && arg) {
    const r = await api<RoomView>(d, "DELETE", `/rooms/${arg}`);
    if (r.status !== 200) {
      console.error(`error: ${r.body.error}`);
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
