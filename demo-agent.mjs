#!/usr/bin/env node
/**
 * The demo agent (#463): an offline ACP agent for people, not for tests.
 * `kapelle demo` starts it in a room, so a new person can try the chat with
 * no harness, no account, no tokens and no network.
 *
 * Its first turn greets the person and names the keys. Each later turn
 * answers the message, then asks to add it to `notes.md` in its checkout:
 * one permission question, and a diff to look at once it is allowed. It
 * writes only through the client's `fs/write_text_file`, so the policy and
 * the path guard see every write.
 *
 * `mock-agent.mjs` is the test fixture. Keep test scenarios out of this file.
 */
import { join } from "node:path";
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = (sessionId, u) =>
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: u },
  });
const say = (sessionId, text) =>
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });

let nextId = 0;
const pending = new Map();
/** A request to the client; resolves with its result, or null on an error. */
const callClient = (method, params) =>
  new Promise((resolve) => {
    const id = `demo-${++nextId}`;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

/** Each session: its checkout, its turn count, and the notes so far. */
const sessions = new Map();

const WELCOME = `Hello! I am the demo agent. I run on this computer, with no account and no network.

The notice that says "no measured labels" is about me. kapelle shows it for every agent it has not measured. I only write through kapelle, and I ask first.

Some keys to try:

- Type a message and press Enter. It comes to me.
- When I ask a question, pick a row and press Enter. Deny is first, so a stray Enter says no.
- Type \`@demo /diff\` to see what I changed.
- Press ctrl+o to open the menu, and type \`/help\` to see every command.
- Type \`/leave\` to exit. The room stays, and \`kapelle demo\` starts a new one.

Now type a message. I will ask to add it to notes.md.
`;

async function turn(msg) {
  const { sessionId: sid, prompt } = msg.params;
  const s = sessions.get(sid);
  s.turns++;
  if (s.turns === 1) {
    say(sid, WELCOME);
    reply(msg.id, { stopReason: "end_turn" });
    return;
  }

  const text = prompt
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  say(sid, `You said: "${text}". I will add it to notes.md.\n`);

  const path = join(s.cwd, "notes.md");
  const oldText = s.notes;
  const newText = `${oldText}- ${text}\n`;
  const diff = { type: "diff", path, oldText, newText };
  const toolCallId = `write-${s.turns}`;
  update(sid, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: "Write notes.md",
    kind: "edit",
    rawInput: { path },
    content: [diff],
    status: "pending",
  });
  const answer = await callClient("session/request_permission", {
    sessionId: sid,
    toolCall: { toolCallId },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "deny", name: "Reject", kind: "reject_once" },
    ],
  });
  const allowed =
    answer?.outcome?.outcome === "selected" &&
    answer.outcome.optionId === "allow" &&
    (await callClient("fs/write_text_file", {
      sessionId: sid,
      path,
      content: newText,
    })) !== null;
  if (allowed) s.notes = newText;
  update(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: allowed ? "completed" : "failed",
    ...(allowed && { content: [diff] }),
  });
  say(
    sid,
    allowed
      ? "Wrote notes.md. Type `@demo /diff` to see the change."
      : "I did not write notes.md. Nothing changed.",
  );
  reply(msg.id, { stopReason: "end_turn" });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && !msg.method) {
    pending.get(msg.id)?.(msg.error ? null : msg.result);
    pending.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        agentInfo: { name: "kapelle-demo", version: "1.0.0" },
        authMethods: [],
      });
      return;
    case "session/new": {
      const sessionId = `demo-${sessions.size + 1}`;
      sessions.set(sessionId, { cwd: msg.params.cwd, turns: 0, notes: "" });
      reply(msg.id, { sessionId });
      return;
    }
    case "session/set_mode":
      reply(msg.id, {});
      return;
    case "session/prompt":
      turn(msg);
      return;
    case "session/cancel":
      return;
    default:
      if (msg.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `no method ${msg.method}` },
        });
      }
  }
});
