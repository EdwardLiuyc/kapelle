#!/usr/bin/env node
/**
 * A fake ACP agent — the agent side of the protocol.
 *
 * Lets you exercise the client with no harness installed:
 *   node run.ts "hello" --cmd "node mock-agent.mjs" --mode safe
 *
 * It answers initialize / session/new / session/prompt, streams a message,
 * calls back into the client's fs/read_text_file, and asks permission for a
 * write — enough to prove every path in the client works.
 */
import { createInterface } from "node:readline";

let nextId = 1000;
const pending = new Map();

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

function callClient(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const update = (sessionId, u) =>
  notify("session/update", { sessionId, update: u });

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`[mock-agent] ignoring non-JSON line: ${line}`);
    return;
  }

  if (msg.id !== undefined && !msg.method) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }

  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
      agentInfo: { name: "mock-agent", version: "0.1.0" },
      authMethods: [],
    });
  }

  if (msg.method === "session/new") {
    reply(msg.id, { sessionId: "sess_mock_1" });
  }

  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;

    // A prompt containing "refuse" ends the turn with `refusal` and does
    // nothing else. It is the offline way to reach a **failure that never
    // throws** — M1b-2's stop-reason table says `refusal`, `max_tokens` and
    // `max_turn_requests` all return normally, and a client that only reports
    // exceptions goes silent on every one of them.
    const asked = (msg.params.prompt ?? [])
      .map((block) => block.text ?? "")
      .join(" ");
    if (asked.includes("refuse")) {
      reply(msg.id, { stopReason: "refusal" });
      return;
    }

    update(sid, {
      sessionUpdate: "plan",
      entries: [
        {
          content: "Read a file through the client",
          priority: "high",
          status: "pending",
        },
        {
          content: "Try a write that needs permission",
          priority: "medium",
          status: "pending",
        },
      ],
    });

    update(sid, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Deciding which file to read first." },
    });

    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Reading package.json via the client… " },
    });

    // Exercise the client's fs capability.
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read package.json",
      kind: "read",
      status: "pending",
    });
    const file = await callClient("fs/read_text_file", {
      sessionId: sid,
      path: "package.json",
      limit: 3,
    });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });

    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `got ${file?.content?.length ?? 0} chars.\n`,
      },
    });

    // Exercise the permission path with a mutating tool.
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Write ACP_TEST.md",
      kind: "edit",
      status: "pending",
    });
    const perm = await callClient("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "t2" },
      options: [
        { optionId: "yes", name: "Allow once", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });

    const wrote = perm?.outcome?.optionId === "yes";
    if (wrote) {
      await callClient("fs/write_text_file", {
        sessionId: sid,
        path: "ACP_TEST.md",
        content: "written by the mock agent through the client\n",
      });
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Wrote ACP_TEST.md." },
      });
    } else {
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Write refused by the client policy." },
      });
    }
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t2",
      // A real edit tool reports what it changed here, and `diff` is the only
      // ToolCallContent render.ts draws (the `±` line). Refused writes changed
      // nothing, so they report no content.
      status: "completed",
      ...(wrote
        ? {
            content: [
              {
                type: "diff",
                path: "ACP_TEST.md",
                newText: "written by the mock agent through the client\n",
              },
            ],
          }
        : {}),
    });

    // A harness that offers no way to say no. Every build we measured on
    // 2026-09-02 does offer one (issue #13), so this is the unmeasured case
    // the client must not fail open on: under --mode safe the client answers
    // `cancelled` rather than selecting the first option in the list.
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "t3",
      title: "Delete something, with no reject option offered",
      kind: "delete",
      status: "pending",
    });
    const forced = await callClient("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "t3" },
      options: [
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "once", name: "Allow once", kind: "allow_once" },
      ],
    });
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `\nAllow-only menu answered: ${JSON.stringify(forced?.outcome)}.`,
      },
    });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t3",
      status: "completed",
    });

    // A tool the agent could not complete. Unconditional, so the selftest on
    // its own reaches render.ts's failure branch — no mode, no flag needed.
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "t4",
      title: "Fetch a URL that does not resolve",
      kind: "fetch",
      status: "pending",
    });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t4",
      status: "failed",
    });

    update(sid, { sessionUpdate: "usage_update", used: 1234, size: 200000 });
    reply(msg.id, { stopReason: "end_turn" });
  }
});
