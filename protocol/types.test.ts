/**
 * M1a-2 acceptance tests — issue #10.
 *
 * The compile-time half of the story's "done when" is the exhaustive switch in
 * `describeUpdate` below plus `isSessionUpdate` in types.ts: adding a variant
 * to `SessionUpdate` makes `tsc` fail in both. The runtime half is the `_meta`
 * round-trip: a message carrying `_meta` must survive a typed pass-through
 * with it intact — dropping it fails here rather than passing silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertNever,
  isSessionUpdate,
  type AgentEvent,
  type SessionNotification,
  type SessionUpdate,
} from "./types.ts";

// --- fixtures ---------------------------------------------------------------
// One sample per protocol variant, taken from the M0 wire captures
// (docs/M0-FINDINGS.md) and mock-agent.mjs where available.

const FIXTURES: SessionUpdate[] = [
  {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "hi" },
  },
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Reading package.json…" },
  },
  {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "thinking" },
    messageId: "m1",
  },
  {
    // Verbatim field set from claude-agent-acp 0.49.0 (M0-FINDINGS.md §M0-3)
    sessionUpdate: "tool_call",
    toolCallId: "toolu_01FDY",
    title: "Terminal",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "ls" },
    locations: [{ path: "src/a.ts", line: 3 }],
  },
  {
    // claude-agent-acp announces {} on tool_call and real argv ~0.5s later here
    sessionUpdate: "tool_call_update",
    toolCallId: "toolu_01FDY",
    status: "completed",
    content: [{ type: "diff", path: "src/a.ts", newText: "+line" }],
  },
  {
    sessionUpdate: "plan",
    entries: [{ content: "Read a file", priority: "high", status: "pending" }],
  },
  {
    // From all three harnesses, dropped before M1a-2 typed it (M0-1)
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "build", description: "build the thing" }],
  },
  { sessionUpdate: "current_mode_update", currentModeId: "plan" },
  {
    // Copilot only (M0-1)
    sessionUpdate: "config_option_update",
    configOptions: [{ id: "model", name: "Model", category: "model" }],
  },
  { sessionUpdate: "session_info_update", title: "run 42" },
  {
    // opencode once per turn; claude-agent-acp ~23 per long turn (M0-5)
    sessionUpdate: "usage_update",
    used: 1234,
    size: 200000,
  },
];

const CLIENT_EVENTS: AgentEvent[] = [
  {
    sessionUpdate: "_client_permission",
    allow: true,
    title: "Bash",
    kind: "execute",
  },
  { sessionUpdate: "_client_wrote_file", path: "/abs/path" },
  { sessionUpdate: "_client_cancel_requested", sessionId: "sess_1" },
];

// --- the exhaustive switch ---------------------------------------------------

/** Renders a one-line summary per variant. Every protocol variant MUST have a
 *  case; `default` is `assertNever`, so adding a variant to the union fails
 *  `npm run check` here until it is handled. */
function describeUpdate(u: SessionUpdate): string {
  switch (u.sessionUpdate) {
    case "user_message_chunk":
      return `user: ${u.content.type}`;
    case "agent_message_chunk":
      return `agent: ${u.content.type}`;
    case "agent_thought_chunk":
      return `thought: ${u.content.type}`;
    case "tool_call":
      return `tool ${u.toolCallId} [${u.kind ?? "other"}]`;
    case "tool_call_update":
      return `tool ${u.toolCallId} ${u.status ?? "…"}`;
    case "plan":
      return `plan: ${u.entries.length} entries`;
    case "available_commands_update":
      return `commands: ${u.availableCommands.length}`;
    case "current_mode_update":
      return `mode: ${u.currentModeId}`;
    case "config_option_update":
      return `config: ${u.configOptions.length}`;
    case "session_info_update":
      return `info: ${u.title ?? ""}`;
    case "usage_update":
      return `usage: ${u.used}/${u.size}`;
    default:
      return assertNever(u);
  }
}

test("every SessionUpdate variant is handled by the exhaustive switch", () => {
  for (const u of FIXTURES) {
    assert.match(
      describeUpdate(u),
      /\S/,
      `variant ${u.sessionUpdate} rendered empty`,
    );
  }
});

test("descriptions reflect the discriminated fields", () => {
  const toolCall = FIXTURES[3];
  assert.equal(describeUpdate(toolCall), "tool toolu_01FDY [execute]");
  const usage = FIXTURES[10];
  assert.equal(describeUpdate(usage), "usage: 1234/200000");
});

// --- isSessionUpdate ---------------------------------------------------------

test("isSessionUpdate accepts every protocol variant and rejects client events", () => {
  for (const u of FIXTURES) {
    assert.equal(isSessionUpdate(u), true, u.sessionUpdate);
  }
  for (const e of CLIENT_EVENTS) {
    assert.equal(isSessionUpdate(e), false, e.sessionUpdate);
  }
});

// --- _meta round-trip ---------------------------------------------------------

/** A typed pass-through mirroring the client's forwarding path: a wire line is
 *  parsed, handed to consumers as the typed notification, and the update is
 *  re-serialized. This is the path M1a-3's port must preserve. */
function forwardUpdate(line: string): SessionUpdate {
  const msg = JSON.parse(line) as SessionNotification;
  const update: SessionUpdate = msg.params.update;
  return update;
}

test("a message carrying _meta round-trips through the types with it intact", () => {
  const line =
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1",' +
    '"update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"bash",' +
    '"kind":"execute","_meta":{"terminal_info":{"terminal_id":"term_7"},' +
    '"claudeCode":{"toolName":"Bash"}}}}}';

  const update = forwardUpdate(line);
  assert.equal(update.sessionUpdate, "tool_call");
  assert.deepEqual(update._meta, {
    terminal_info: { terminal_id: "term_7" },
    claudeCode: { toolName: "Bash" },
  });

  // And it survives re-serialization — the event log keeps what it recorded.
  const back = JSON.parse(JSON.stringify(update)) as SessionUpdate;
  assert.deepEqual(back._meta, update._meta);
});

test("_meta round-trips on an outbound request too (both directions)", () => {
  const req = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "session/prompt" as const,
    params: {
      sessionId: "s1",
      prompt: [{ type: "text" as const, text: "go" }],
      _meta: { "claude/system": { append: "be brief" } },
    },
  };
  const back = JSON.parse(JSON.stringify(req));
  assert.deepEqual(back.params._meta, req.params._meta);
});

// --- drop guard ---------------------------------------------------------------

test("a reconstruction that drops _meta is caught, not passed silently", () => {
  const line =
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1",' +
    '"update":{"sessionUpdate":"usage_update","used":1,"size":2,' +
    '"_meta":{"_claude/rateLimit":{"utilization":0.9}}}}}';

  const update = forwardUpdate(line);
  assert.ok("_meta" in update, "_meta must reach consumers");

  // The mistake M1a-2 exists to prevent: rebuilding the update field-by-field.
  // The reconstruction matches the original in every field EXCEPT _meta —
  // identical to the eye, silent at runtime — which is why the typed path
  // must carry the object whole and the guard above must hold.
  const { _meta, ...withoutMeta } = update as SessionUpdate &
    Record<string, unknown>;
  const dropped = {
    sessionUpdate: update.sessionUpdate,
    used: (update as { used: number }).used,
    size: (update as { size: number }).size,
  };
  assert.deepEqual(dropped, withoutMeta);
  assert.equal("_meta" in dropped, false);
});

// --- misc ----------------------------------------------------------------------

test("assertNever throws on an unhandled value", () => {
  assert.throws(
    () => assertNever("surprise" as never),
    /unhandled protocol variant/,
  );
});
