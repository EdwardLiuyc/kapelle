/**
 * M1a-2 acceptance tests — issue #10.
 *
 * The compile-time half of the story's "done when" is the exhaustive switch in
 * `describeUpdate` below plus `isSessionUpdate` in types.ts: adding a variant
 * to `SessionUpdate` makes `tsc` fail in both. The runtime half is the `_meta`
 * round-trip: a message carrying `_meta` must survive a typed pass-through
 * with it intact — dropping it fails here rather than passing silently.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AgentEvent,
  assertNever,
  isSessionUpdate,
  type PromptRequest,
  type SessionNotification,
  type SessionUpdate,
} from "../types.ts";

// --- fixtures ---------------------------------------------------------------
// One sample per protocol variant, taken from the M0 wire captures
// (docs/FINDINGS.md) and mock-agent.mjs where available.

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
    // Composite of fields claude-agent-acp 0.49.0 announces on tool_call
    // (FINDINGS.md §M0-3). The real capture (§M0-3, "Why nothing called it") also
    // carries a _meta terminal block; rawInput is {} here, real argv arrives
    // on tool_call_update ~0.5s later (§M0-3, "Question 2").
    sessionUpdate: "tool_call",
    toolCallId: "toolu_01FDY",
    title: "Terminal",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "ls" },
    locations: [{ path: "src/a.ts", line: 3 }],
    _meta: { claudeCode: { toolName: "Bash" } },
  },
  {
    // Composite: claude-agent-acp announces {} on tool_call and the real argv
    // arrives here ~0.5s later (FINDINGS.md §M0-3, "Question 2")
    sessionUpdate: "tool_call_update",
    toolCallId: "toolu_01FDY",
    status: "completed",
    rawInput: { command: "ls -la" },
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
    // Copilot only (M0-1); currentValue "claude-sonnet-5" measured on the
    // wire under category "model" (FINDINGS.md §M0-5, "All three name the
    // model they ran") — the "which model ran" channel M1a-4 consumes.
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "claude-sonnet-5",
        options: [{ value: "claude-sonnet-5", name: "Claude Sonnet 5" }],
      },
    ],
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
  {
    sessionUpdate: "_client_permission_answered",
    id: "7d4c1e0a-5b2f-4a61-9c3e-2f8b1d6a9e40",
    allow: false,
    reason: "timeout",
  },
  { sessionUpdate: "_client_wrote_file", path: "/abs/path" },
  { sessionUpdate: "_client_cancel_requested", sessionId: "sess_1" },
  {
    sessionUpdate: "_client_result_warning",
    kind: "filesNotInDiff",
    text: "<files> names ghost.ts, which the working tree does not show as changed.",
  },
  { sessionUpdate: "_client_task_started", harness: "opencode" },
  {
    sessionUpdate: "_client_worktree_created",
    path: "/wt/run/one/pkg",
    branch: "kapelle/run/one",
    baseSha: "0123456789abcdef",
  },
  { sessionUpdate: "_client_task_finished", status: "done", durationMs: 1234 },
];

// --- the exhaustive switch ---------------------------------------------------

/** Renders a one-line summary per variant. Every protocol variant MUST have a
 *  case; `default` is `assertNever`, so adding a variant to the union fails
 *  `npm run check` here until it is handled. */
// The 11-case exhaustive switch IS the test's mechanism: splitting the dispatch
// would let a new variant slip past one copy of it.
// pi-lens-ignore: high-complexity
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
  // Annotated as PromptRequest so params._meta typechecks against the real
  // outbound type — the round-trip proves the outbound types carry it.
  const req: PromptRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: {
      sessionId: "s1",
      prompt: [{ type: "text", text: "go" }],
      _meta: { "claude/system": { append: "be brief" } },
    },
  };
  const back: PromptRequest = JSON.parse(JSON.stringify(req)) as PromptRequest;
  assert.deepEqual(back.params._meta, req.params._meta);
});

// --- drop guard ---------------------------------------------------------------

test("field-by-field reconstruction loses exactly _meta (the round-trip tests are the guard)", () => {
  const line =
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1",' +
    '"update":{"sessionUpdate":"usage_update","used":1,"size":2,' +
    '"_meta":{"_claude/rateLimit":{"utilization":0.9}}}}}';

  const update = forwardUpdate(line);
  // The real guard: the typed pass-through preserves _meta on the update
  // object, so a reconstruction that loses it is a consumer bug, not a
  // property of the type. The round-trip tests above prove _meta survives the
  // typed path; this asserts the field is present to drop.
  assert.ok("_meta" in update, "_meta must reach consumers");

  // What the mistake looks like: rebuilding the update field-by-field drops
  // _meta silently at runtime. The round-trip tests are the contract; this
  // documents the failure mode for reviewers.
  const { _meta: dropped, ...withoutMeta } = update as SessionUpdate &
    Record<string, unknown>;
  assert.equal("_meta" in withoutMeta, false);
  void dropped;
});

// --- misc ----------------------------------------------------------------------

test("assertNever throws on an unhandled value", () => {
  assert.throws(
    () => assertNever("surprise" as never),
    /unhandled protocol variant/,
  );
});
