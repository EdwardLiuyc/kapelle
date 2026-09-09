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
 *
 * `--scenario <name>` selects a non-compliant fixture instead (M1b-5). Argv,
 * never a keyword in the prompt: `silent-session` fires during the handshake,
 * before any prompt exists, so no keyword could reach it. With no flag the
 * compliant default path runs, so `npm run selftest` is unchanged.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

/** Every fixture, and what the client is meant to make of it. */
const SCENARIOS = {
  refuse: "ends the turn with stopReason refusal",
  "silent-session": "never answers session/new",
  "no-result": "prose with no <task-result> block at all",
  "malformed-result": "a block whose <summary> is empty",
  "claimed-success": "claims success and changes nothing",
  "files-not-in-diff": "lists a file it never wrote",
  "unasked-write": "writes a file itself, without asking permission",
};

const at = process.argv.indexOf("--scenario");
const scenario = at === -1 ? null : process.argv[at + 1];
if (scenario !== null && !Object.hasOwn(SCENARIOS, scenario)) {
  // Louder than a fallback to the default path: a typo'd scenario that ran
  // the compliant fixture would make a test pass for the wrong reason.
  console.error(
    `[mock-agent] unknown --scenario "${scenario}". Known: ${Object.keys(
      SCENARIOS,
    ).join(", ")}`,
  );
  process.exit(2);
}

const result = (status, summary, details, files) =>
  `<task-result>\n<status>${status}</status>\n<summary>${summary}</summary>\n` +
  `<details>${details}</details>\n${files ? `<files>${files}</files>\n` : ""}` +
  `</task-result>\n`;

/**
 * The final message each block-shaped fixture sends, in place of the whole
 * read / permission / write dance the default path runs.
 *
 * No tools and no permission requests, so `permissionCount` is 0 and the
 * working tree holds only what the fixture itself put there — which is what
 * makes each cross-check in `core/result.ts` fire on its own.
 */
const FINAL_MESSAGE = {
  "no-result": "I read the file and fixed it. That is all I have to say.",
  "malformed-result": `Done.\n${result("success", "", "Nothing was changed.")}`,
  "claimed-success": result("success", "Fixed the bug.", "Edited one file."),
  // `partial`, so the lie about `<files>` is the only thing under test: a
  // `success` claim with an unchanged tree would trip a second warning too.
  "files-not-in-diff": result(
    "partial",
    "Fixed most of the bug.",
    "Edited one file.",
    "ghost.md",
  ),
  // **No `<files>`, deliberately.** The write lands in the process cwd, but
  // `changedPaths` reads `git status`, which reports paths from the repository
  // root — so under a `--cwd` naming a subdirectory the tree says
  // `sub/sneaky.txt` and any cwd-relative `<files>` here would trip
  // `filesNotInDiff` alongside the `policyNeverFired` this fixture is for.
  // Reporting nothing is also what a real agent that forgot the field does.
  "unasked-write": result(
    "success",
    "Wrote a file.",
    "Wrote it directly, never through the client.",
  ),
};

// M0-5 pinned `usage` on the prompt *response* — the only per-task token count
// present on all three harnesses, and the one the mock never sent.
const USAGE = {
  inputTokens: 1200,
  outputTokens: 34,
  totalTokens: 1234,
  cachedReadTokens: 0,
};

let nextId = 1000;
let sessionCount = 0;
const pending = new Map();
/** Every id we minted. A prompt for any other id is a client bug. */
const sessions = new Set();

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) =>
  send({ jsonrpc: "2.0", id, error: { code: -32602, message } });
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
    // Silence, not an error: the client's own handshake deadline
    // (`protocol/agent.ts:503`) is the thing under test, and any reply at all
    // would answer it.
    if (scenario === "silent-session") return;
    const sid = `sess_mock_${++sessionCount}`;
    sessions.add(sid);
    reply(msg.id, { sessionId: sid });
  }

  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;

    // An id we never minted is a client bug, and a mock that answered it
    // anyway would hide one.
    if (!sessions.has(sid)) {
      fail(msg.id, `unknown session "${sid}"`);
      return;
    }

    // `refuse` is the offline way to reach a **failure that never throws** —
    // M1b-2's stop-reason table says `refusal`, `max_tokens` and
    // `max_turn_requests` all return normally, and a client that only reports
    // exceptions goes silent on every one of them.
    if (scenario === "refuse") {
      reply(msg.id, { stopReason: "refusal", usage: USAGE });
      return;
    }

    const final = FINAL_MESSAGE[scenario];
    if (final) {
      if (scenario === "unasked-write") {
        // Directly, never through `fs/write_text_file`: `policyNeverFired` is
        // about a harness that mutates the workspace with its own tools, which
        // is what the client cannot see and can only infer afterwards.
        writeFileSync("sneaky.txt", "written behind the client's back\n");
      }
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: final },
      });
      reply(msg.id, { stopReason: "end_turn", usage: USAGE });
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
      rawInput: { path: "ACP_TEST.md" },
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

    // Markdown, split mid-line across chunks the way a real harness streams it
    // (M1c-7). `mock-agent.mjs` being too tidy is what hid this bug through
    // M1a, so the message carries the three constructs the story names: a GFM
    // table, a nested list, and a fence with a blank line inside it — the last
    // being the one a naive blank-line rule splits in two.
    for (const chunk of [
      "\n## What I did\n\n| step | result |\n| --- | --- |\n| read",
      " | ok |\n| write | see above |\n\n- checked the file\n  - it par",
      "sed\n  - it was **not** empty\n- reported back\n\n```js\nconst x = 1;\n",
      "\nconst y = 2;\n```\n",
    ]) {
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      });
    }

    // The result block M1b-4's preamble asks for, as a compliant harness
    // sends it: last in the final message, and `<files>` only when the write
    // actually happened — a block that claimed ACP_TEST.md under `safe` would
    // trip the cross-check the client is meant to keep for real disagreement.
    // The non-compliant fixtures are `FINAL_MESSAGE` above (M1b-5).
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text:
          `\n<task-result>\n<status>${wrote ? "success" : "partial"}</status>\n` +
          `<summary>Read package.json and ${wrote ? "wrote" : "was refused"} ACP_TEST.md.</summary>\n` +
          `<details>Exercised the read, permission and write paths of the client.</details>\n` +
          (wrote ? "<files>ACP_TEST.md</files>\n" : "") +
          `</task-result>\n`,
      },
    });

    update(sid, { sessionUpdate: "usage_update", used: 1234, size: 200000 });
    reply(msg.id, { stopReason: "end_turn", usage: USAGE });
  }
});
