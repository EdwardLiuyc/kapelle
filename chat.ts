#!/usr/bin/env node
/**
 * `chat.ts` — a terminal chat over the daemon's rooms (chat MVP).
 *
 * **Experimental.** One participant per room, `auto` only, no roster and no
 * permission answering. The room API is not a promise until M5-1 documents
 * it, and M6-1..M6-9 will reshape it; nothing here is a compatibility
 * commitment.
 *
 * **A front end, not part of the daemon.** It speaks HTTP to `daemon.ts` and
 * nothing else, so anything it can do, a bridge to another chat app can do
 * too. The one import from this repository is `core/runtime.ts`, which says
 * where `daemon.json` lives; `tests/daemon.test.ts` holds that line.
 *
 * One room is one harness kept alive between messages, until `/dismiss`.
 * Leaving (`/leave`, end of input, ^C) keeps the room, and `attach` replays
 * its whole conversation from the room's event log.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { runtimeDir } from "./core/runtime.ts";

const USAGE = `usage: (experimental — the room API may change without notice)
  node chat.ts new --agent <id> [--cwd dir]       open a room and chat in it
  node chat.ts new --cmd "<command>" [--cwd dir]
  node chat.ts attach <roomId>                    rejoin a room; its history replays
  node chat.ts list                               every room the daemon holds
  node chat.ts dismiss <roomId>                   stop a room's harness

in a room, type a message and press enter:
  /leave     exit; the room and its harness stay alive
  /dismiss   stop the harness and exit; uncommitted work stays in its
             checkout, because the supervisor never commits for it (R37)`;

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

/** A refused request's `error` (docs/CLIENT-API.md); `code` is for code,
 *  `message` for the person. */
interface Refusal {
  code: string;
  message: string;
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
): Promise<{ status: number; body: T; error?: Refusal }> {
  const res = await fetch(`http://127.0.0.1:${d.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${d.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!text) return { status: res.status, body: {} as T };
  try {
    const parsed = JSON.parse(text);
    return res.ok
      ? { status: res.status, body: parsed as T }
      : { status: res.status, body: {} as T, error: parsed.error };
  } catch {
    throw new Error(`HTTP ${res.status}: response was not JSON`);
  }
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
    const { error } = (await res.json()) as { error?: Refusal };
    throw new Error(error?.message ?? `events: HTTP ${res.status}`);
  }
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          throw new Error("malformed SSE frame from the daemon");
        }
      }
    }
  }
}

/** Prints a room's events as a conversation. */
function makePrinter(tty: boolean) {
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
    /** Messages this terminal sent and already shows as typed input. */
    pendingEcho: 0,
    show(event: LogEvent) {
      const u = event.update;
      switch (u.sessionUpdate) {
        case "_client_user_message":
          speaking = false;
          if (tty && this.pendingEcho > 0) {
            this.pendingEcho -= 1;
            return;
          }
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
        default:
          // An update this client does not render is dropped: the room emits
          // more kinds than chat.ts draws, and a new one must not crash a chat.
          break;
      }
    },
  };
}

/** The chat loop for one room. Resolves with the exit code. */
async function chat(d: Daemon, room: RoomView): Promise<number> {
  console.log(`room ${room.id} · ${room.harness} · ${room.workspace}`);
  for (const { text } of room.notices) console.log(`! ${text}`);
  console.log("type a message; /leave to exit, /dismiss to stop the room");

  const tty = Boolean(process.stdin.isTTY);
  const printer = makePrinter(tty);

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

  // `output` is not optional on a TTY: terminal mode switches the terminal's
  // own echo off and draws typed keys and the prompt itself, to `output`.
  // Without it nothing typed was visible at all.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: tty,
  });
  rl.setPrompt("> ");
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

  /** The stream ended without our `DELETE`: ask the daemon what happened.
   *  `closed` is someone else's dismissal; anything else means the daemon or
   *  its stream is gone and the room's fate is unknown. */
  const reconcile = async (): Promise<number> => {
    try {
      const r = await api<RoomView>(d, "GET", `/rooms/${room.id}`);
      if (r.status === 200) {
        if (r.body.status === "closed") {
          console.log("the room was dismissed");
          return 0;
        }
        // The stream died, the room did not. Name the state the daemon
        // reports rather than the status of the GET that reported it, and
        // say how to get back in.
        console.error(
          `! lost the room stream; the room is still ${r.body.status} — ` +
            `rejoin with: chat.ts attach ${room.id}`,
        );
      } else if (r.status === 404) {
        console.error(
          `! the daemon no longer knows room ${room.id}; it may have restarted`,
        );
      } else {
        console.error(
          `! lost the room stream (HTTP ${r.status}); the room may still be alive`,
        );
      }
    } catch (err) {
      console.error(`! lost the daemon: ${(err as Error).message}`);
    }
    return 1;
  };

  let code = 0;
  for (;;) {
    if (tty) rl.prompt();
    const next = await Promise.race([nextLine(), ended]);
    if (next === "ended") {
      code = await reconcile();
      break;
    }
    if (next === null || next.trim() === "/leave") break;
    const text = next.trim();
    if (!text) continue;

    if (text === "/dismiss") {
      const r = await api<RoomView>(d, "DELETE", `/rooms/${room.id}`);
      if (r.status !== 200) {
        console.error(`! ${r.error?.message}`);
        code = 1;
        break;
      }
      await ended;
      console.log("the room was dismissed");
      break;
    }

    // Counted before the request: the message can reach the log, and this
    // stream, before the response does.
    printer.pendingEcho += Number(tty);
    const r = await api<{ seq: number }>(
      d,
      "POST",
      `/rooms/${room.id}/messages`,
      { text },
    );
    if (r.status !== 202) {
      printer.pendingEcho -= Number(tty);
      console.error(`! ${r.error?.message}`);
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
      console.error(`error: ${r.error?.message}`);
      if (r.error?.code === "repo_not_added") {
        console.error("add the repository first: kapelle daemon add <path>");
      }
      return 1;
    }
    return chat(d, r.body);
  }

  if (verb === "attach" && arg) {
    const r = await api<RoomView>(d, "GET", `/rooms/${arg}`);
    if (r.status !== 200) {
      console.error(`error: ${r.error?.message}`);
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
      console.error(`error: ${r.error?.message}`);
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
