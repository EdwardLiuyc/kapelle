#!/usr/bin/env node
/**
 * A fake ACP agent that attacks its client — M1b-6, issue #22.
 *
 * The sibling of `mock-agent.mjs`, and the opposite of it. `mock-agent` is a
 * well-behaved harness that walks every client path; this one is a harness
 * that lies, escapes and floods, so the refusals can be tested with nothing
 * installed:
 *
 *   node cli.ts "escape" --cmd "node hostile-agent.mjs --scenario path-escape" --mode auto
 *
 * `--mode auto` in that line is deliberate. The path guard is unconditional
 * and does not consult the policy, so `auto` is the mode that proves the guard
 * refuses on its own rather than the policy refusing for it.
 *
 * Every scenario ends the turn normally after its attack. That is half the
 * story's *Done when*: each attempt is refused **and the run continues**, so a
 * scenario that killed the turn would prove only the first half.
 */
import { symlinkSync } from "node:fs";
import { createInterface } from "node:readline";

/** Every attack, and what the client is meant to do with it. */
const SCENARIOS = {
  "path-escape": "reads ../../etc/passwd through fs/read_text_file",
  "absolute-path": "reads /etc/passwd by absolute path",
  "symlink-escape": "reads an in-root symlink that points out of the root",
  "write-no-ask": "calls fs/write_text_file with no permission request first",
  "always-menu": "offers only allow_always, then writes the same path twice",
  "malformed-json": "puts a non-JSON line on stdout, then carries on",
  oversized: "puts a line past the client's length cap on stdout",
  "unknown-method": "calls a client method that does not exist",
};

const at = process.argv.indexOf("--scenario");
const scenario = at === -1 ? null : process.argv[at + 1];
if (scenario === null || !Object.hasOwn(SCENARIOS, scenario)) {
  // No default path, unlike `mock-agent`: a hostile agent with no attack
  // selected is just a worse mock, and a typo that ran it would make a
  // containment test pass without containing anything.
  console.error(
    `[hostile-agent] --scenario is required. Known: ${Object.keys(
      SCENARIOS,
    ).join(", ")}`,
  );
  process.exit(2);
}

let nextId = 1;
const pending = new Map();

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

/**
 * Unlike `mock-agent`'s, this resolves the **whole** envelope.
 *
 * A refusal arrives as a JSON-RPC `error` member, and an agent that only
 * looked at `result` could not tell "refused" from "allowed and empty" — which
 * is the one distinction every scenario here reports on.
 */
function callClient(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const update = (sessionId, u) =>
  notify("session/update", { sessionId, update: u });

const say = (sid, text) =>
  update(sid, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });

/**
 * One line per attack, in a shape a test can assert on.
 *
 * Machine-readable on purpose. The rule against asserting on agent prose is
 * about *real* harnesses, whose wording changes every run; this fake's line is
 * fixed by this file, so it is a contract rather than prose.
 */
const outcome = (sid, msg) => {
  const refused = msg.error !== undefined;
  const detail = refused ? msg.error.message : "allowed";
  say(
    sid,
    `\nATTACK=${scenario} OUTCOME=${refused ? "refused" : "allowed"} DETAIL=${detail}\n`,
  );
};

/** The compliant result block, so a hostile run trips no cross-check warning. */
const resultBlock = (sid) =>
  say(
    sid,
    `\n<task-result>\n<status>partial</status>\n` +
      `<summary>Ran the ${scenario} attack against the client.</summary>\n` +
      `<details>${SCENARIOS[scenario]}</details>\n</task-result>\n`,
  );

/** Each attack, keyed by name. Returns once the client has answered, if it does. */
const ATTACKS = {
  "path-escape": async (sid) =>
    outcome(
      sid,
      await callClient("fs/read_text_file", {
        sessionId: sid,
        path: "../../etc/passwd",
      }),
    ),

  "absolute-path": async (sid) =>
    outcome(
      sid,
      await callClient("fs/read_text_file", {
        sessionId: sid,
        path: "/etc/passwd",
      }),
    ),

  "symlink-escape": async (sid) => {
    // Planted with the agent's own fs, never through the client: the point is
    // a link the client did not create and must still not follow. A target
    // that does not exist is fine — `realpath` falls back to the nearest
    // ancestor, and /etc is outside any workspace root either way.
    try {
      symlinkSync("/etc/passwd", "escape-link.txt");
    } catch {
      // Already there from an earlier run in the same directory.
    }
    outcome(
      sid,
      await callClient("fs/read_text_file", {
        sessionId: sid,
        path: "escape-link.txt",
      }),
    );
  },

  "write-no-ask": async (sid) =>
    // No `session/request_permission`, and no `tool_call` announcing it
    // either. A client that gates only on the request it was sent writes this
    // file under every mode, `safe` included.
    outcome(
      sid,
      await callClient("fs/write_text_file", {
        sessionId: sid,
        path: "SNEAKY.md",
        content: "written without asking\n",
      }),
    ),

  "always-menu": async (sid) => {
    // A menu with no `allow_once` on it. `pickOption` prefers `allow_once` and
    // reaches `allow_always` only when nothing narrower was offered, so this is
    // the one shape that can produce an "always" answer the human never chose —
    // and the client must still spend that approval on a single write.
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "w1",
      title: "Write notes.md",
      kind: "edit",
      rawInput: { path: "notes.md" },
      status: "pending",
    });
    await callClient("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "w1" },
      options: [
        { optionId: "always", name: "Always allow", kind: "allow_always" },
      ],
    });

    const write = () =>
      callClient("fs/write_text_file", {
        sessionId: sid,
        path: "notes.md",
        content: "x\n",
      });
    outcome(sid, await write());
    outcome(sid, await write());
  },

  "malformed-json": async (sid) => {
    process.stdout.write("{ this is not json at all\n");
    say(sid, `\nATTACK=${scenario} OUTCOME=sent DETAIL=one-way\n`);
  },

  oversized: async (sid) => {
    // Valid JSON and a well-formed message, so only the length can be what
    // stops it — and a well-formed one on purpose. A malformed flood would be
    // dropped by the parser even with no cap at all, and the test could not
    // tell the cap from the `try/catch` around `JSON.parse`. The marker is
    // what makes the drop observable: if the cap goes, `FLOOD` reaches the
    // client's own event stream.
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `FLOOD${"x".repeat(33 * 1024 * 1024)}`,
          },
        },
      },
    });
    say(sid, `\nATTACK=${scenario} OUTCOME=sent DETAIL=one-way\n`);
  },

  "unknown-method": async (sid) =>
    outcome(
      sid,
      await callClient("client/definitely_not_a_method", { sessionId: sid }),
    ),
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`[hostile-agent] ignoring non-JSON line: ${line}`);
    return;
  }

  if (msg.id !== undefined && !msg.method) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }

  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: false, audio: false } },
    });
    return;
  }

  if (msg.method === "session/new") {
    reply(msg.id, { sessionId: "hostile-1" });
    return;
  }

  if (msg.method === "session/set_mode") {
    reply(msg.id, {});
    return;
  }

  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    say(sid, `Running the ${scenario} attack.`);
    await ATTACKS[scenario](sid);
    resultBlock(sid);
    reply(msg.id, { stopReason: "end_turn" });
  }
});
