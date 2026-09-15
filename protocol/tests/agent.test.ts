/**
 * M1a-3 acceptance tests — issue #11.
 *
 * Everything here is driven by a real subprocess over real stdio rather than
 * by poking at internals, because every decision under test is about what does
 * or does not reach the wire.
 *
 * Covered so far: the per-request timeout (#62 B1), the in-flight prompt guard
 * (#62 R5), the whole `PromptResponse` (#62 B3), the cancel-intent event
 * (#62 R4), stderr capture on death, `#guardPath` containment, `#guardWrite`'s
 * no-ask refusal and its reuse of an approved edit decision, and the
 * toolCall-id lookup's parity with the pre-port client.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";

import { MOCK_AGENT } from "../../integration/helpers.ts";
import { AcpAgent } from "../agent.ts";

/**
 * The structural shape a test needs from an emitted event. Declared here
 * rather than imported, so the client is not forced to export a name whose
 * only consumer is this file.
 */
type CapturedEvent = {
  agent: string;
  update: { sessionUpdate: string; sessionId?: string };
};

/** Every event except the harness's own spawn and exit (M2-4), which bracket
 *  every run and are covered by their own test. */
const turnEvents = (events: CapturedEvent[]) =>
  events.filter((e) => !e.update.sessionUpdate.startsWith("_client_harness_"));

/** What the policy is handed, structurally. Same reasoning as above. */
type CapturedToolCall = { title: string; kind: string };

/**
 * Announces a `tool_call` that omits `toolCallId`, then asks permission with a
 * `toolCall` that also omits it.
 *
 * Malformed against the schema, which requires the field — but `toolCallId` is
 * a cast off the wire and never validated, so this is reachable from a
 * non-conformant harness. The pre-port client stored under key `undefined` and
 * found it again; the port briefly keyed on `""` and missed.
 */
const PERMISSION_WITHOUT_ID = [
  'let buf = "";',
  "let nextId = 2000;",
  "const pending = new Map();",
  'const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  "  let nl;",
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, nl);",
  "    buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    const msg = JSON.parse(line);",
  '    if (msg.method === "initialize")',
  '      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });',
  '    else if (msg.method === "session/new")',
  '      write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });',
  '    else if (msg.method === "debug/permission") {',
  "      write({",
  '        jsonrpc: "2.0",',
  '        method: "session/update",',
  "        params: {",
  '          sessionId: "s1",',
  "          update: {",
  '            sessionUpdate: "tool_call",',
  '            title: "Read foo",',
  '            kind: "read",',
  "          },",
  "        },",
  "      });",
  "      const rid = nextId++;",
  "      pending.set(rid, msg.id);",
  "      write({",
  '        jsonrpc: "2.0",',
  "        id: rid,",
  '        method: "session/request_permission",',
  "        params: {",
  '          sessionId: "s1",',
  "          toolCall: {},",
  '          options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],',
  "        },",
  "      });",
  "    } else if (msg.id !== undefined && pending.has(msg.id)) {",
  "      const probeId = pending.get(msg.id);",
  "      pending.delete(msg.id);",
  '      write({ jsonrpc: "2.0", id: probeId, result: { answered: true } });',
  "    }",
  "  }",
  "});",
].join("\n");

/** Accepts the pipe, reads stdin, and answers nothing, ever. */
const HANGS_FOREVER = "process.stdin.resume();";

/**
 * Records the `initialize` params, answers the handshake, and returns the
 * recorded params on request. Exists so the package identity on the wire is
 * pinned without reaching into `AcpAgent`'s private outbound queue.
 */
const INITIALIZE_PROBE = [
  'let buf = "";',
  "let initParams = null;",
  'const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  "  let nl;",
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, nl);",
  "    buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    const msg = JSON.parse(line);",
  '    if (msg.method === "initialize") {',
  "      initParams = msg.params;",
  '      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });',
  '    } else if (msg.method === "debug/init_client_info") {',
  '      write({ jsonrpc: "2.0", id: msg.id, result: initParams ?? {} });',
  "    }",
  "  }",
  "});",
].join("\n");

/**
 * Accepts the pipe, explains itself on stderr, then dies during the handshake.
 *
 * The shape is copied from the real measurement in issue #11: node's
 * MODULE_NOT_FOUND banner puts the actionable line near the head and leaves
 * frames after it, which is why a tail-only window would have lost it.
 */
const DIES_MID_HANDSHAKE = [
  "process.stdin.resume();",
  "setTimeout(() => {",
  '  console.error("node:internal/modules/cjs/loader:1568");',
  "  console.error(\"Error: Cannot find module '/nonexistent/preload.js'\");",
  '  console.error("    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)");',
  '  console.error("Node.js v24.20.0");',
  "  process.exit(1);",
  "}, 60);",
].join("\n");

/**
 * A minimal scripted harness: answers the handshake immediately, delays the
 * turn by `promptDelayMs`, and counts every `session/prompt` it actually
 * received so a test can prove a refused prompt never reached the wire.
 *
 * Written without imports so it behaves the same whether node treats `--eval`
 * input as CommonJS or ESM.
 */
function scriptedAgent(promptDelayMs: number): string {
  return [
    'let buf = "";',
    "let promptCount = 0;",
    "let cancelCount = 0;",
    "const send = (id, result) =>",
    "  process.stdout.write(",
    '    JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n",',
    "  );",
    'process.stdin.on("data", (chunk) => {',
    "  buf += chunk;",
    "  let nl;",
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    "    const line = buf.slice(0, nl);",
    "    buf = buf.slice(nl + 1);",
    "    if (!line.trim()) continue;",
    "    const msg = JSON.parse(line);",
    '    if (msg.method === "initialize") send(msg.id, { protocolVersion: 1 });',
    '    else if (msg.method === "session/new") send(msg.id, { sessionId: "s1" });',
    '    else if (msg.method === "debug/prompt_count")',
    "      send(msg.id, { count: promptCount });",
    '    else if (msg.method === "session/cancel") cancelCount += 1;',
    '    else if (msg.method === "debug/cancel_count")',
    "      send(msg.id, { count: cancelCount });",
    '    else if (msg.method === "session/prompt") {',
    "      promptCount += 1;",
    "      const reply = {",
    '        stopReason: "end_turn",',
    "        usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },",
    '        _meta: { "_claude/rateLimit": "ok" },',
    "      };",
    `      setTimeout(() => send(msg.id, reply), ${promptDelayMs});`,
    "    }",
    "  }",
    "});",
  ].join("\n");
}

/**
 * A harness that turns `debug/fs` into a real `fs/*` request aimed back at us,
 * then reports what the client answered. `#guardPath` is private, so this
 * exercises it through the entry point that actually reaches it in production.
 */
const FS_PROBE = [
  'let buf = "";',
  "let nextId = 1000;",
  "const pending = new Map();",
  'const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  "  let nl;",
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, nl);",
  "    buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    const msg = JSON.parse(line);",
  '    if (msg.method === "initialize")',
  '      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });',
  '    else if (msg.method === "debug/fs") {',
  "      const rid = nextId++;",
  "      pending.set(rid, msg.id);",
  '      const params = { sessionId: "s1", path: msg.params.path };',
  '      if (msg.params.write) params.content = "written by the agent";',
  "      write({",
  '        jsonrpc: "2.0",',
  "        id: rid,",
  '        method: msg.params.write ? "fs/write_text_file" : "fs/read_text_file",',
  "        params,",
  "      });",
  "    } else if (msg.id !== undefined && pending.has(msg.id)) {",
  "      const probeId = pending.get(msg.id);",
  "      pending.delete(msg.id);",
  "      write({",
  '        jsonrpc: "2.0",',
  "        id: probeId,",
  "        result: {",
  "          refused: msg.error !== undefined,",
  "          message: msg.error ? msg.error.message : null,",
  "          content: msg.result ? msg.result.content : null,",
  "        },",
  "      });",
  "    }",
  "  }",
  "});",
].join("\n");

type FsProbe = {
  refused: boolean;
  message: string | null;
  content: string | null;
};

async function guardAgent(
  t: TestContext,
  root: string,
  allowReadOutsideRoot = false,
): Promise<AcpAgent> {
  const agent = new AcpAgent({
    name: "fs-probe",
    command: process.execPath,
    args: ["-e", FS_PROBE],
    cwd: root,
    allowReadOutsideRoot,
    requestTimeoutMs: 5_000,
    // Allow-all, so this suite tests the path guard alone. Since M1b-6 a write
    // also passes the policy, and the default is DENY_ALL — without this every
    // case below would pass for the wrong reason. The policy half has its own
    // suite in `protocol/tests/hostile.test.ts`.
    policy: () => true,
  });
  t.after(() => agent.stop());
  await agent.start();
  return agent;
}

function probe(agent: AcpAgent, path: string, write = false): Promise<FsProbe> {
  return agent.request<FsProbe>("debug/fs", { path, write });
}

/**
 * A temp directory that removes itself when the test ends, however it ends.
 * Without this the guard suite leaves `acp-guard-*` / `acp-outside-*` behind on
 * every run.
 */
async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// --- toolCall lookup parity with the pre-port client --------------------------

test("a tool_call that omits its id is still found when permission is asked", async (t) => {
  const seen: CapturedToolCall[] = [];
  const agent = new AcpAgent({
    name: "no-id",
    command: process.execPath,
    args: ["-e", PERMISSION_WITHOUT_ID],
    requestTimeoutMs: 5_000,
    policy: (req) => {
      seen.push(req.toolCall);
      return true;
    },
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();
  await agent.request("debug/permission", {});

  assert.equal(seen.length, 1, "the policy must be consulted exactly once");
  // Keying the map on "" instead of undefined made these fall back to
  // "(untitled tool call)" and "other", so the policy judged a call it could
  // not see. That is the divergence this pins.
  assert.equal(seen[0].title, "Read foo");
  assert.equal(seen[0].kind, "read");
});

// --- #guardPath containment --------------------------------------------------

test("in-root paths are allowed, for both read and write", async (t) => {
  const root = await tempDir(t, "acp-guard-");
  await writeFile(join(root, "inside.txt"), "in-root content", "utf8");
  const agent = await guardAgent(t, root);

  const read = await probe(agent, "inside.txt");
  assert.equal(read.refused, false);
  assert.equal(read.content, "in-root content");

  const written = await probe(agent, "nested/new.txt", true);
  assert.equal(written.refused, false, "writing inside the root is allowed");
});

test("an escaping ../ path is refused", async (t) => {
  const root = await tempDir(t, "acp-guard-");
  const agent = await guardAgent(t, root);

  const read = await probe(agent, "../../etc/passwd");
  assert.equal(read.refused, true);
  assert.match(String(read.message), /path outside workspace root refused/);

  const write = await probe(agent, "../escaped.txt", true);
  assert.equal(write.refused, true);
});

test("an absolute path outside the root is refused", async (t) => {
  const root = await tempDir(t, "acp-guard-");
  const outside = await tempDir(t, "acp-outside-");
  await writeFile(join(outside, "secret.txt"), "outside content", "utf8");
  const agent = await guardAgent(t, root);

  const read = await probe(agent, join(outside, "secret.txt"));
  assert.equal(read.refused, true);
  assert.match(String(read.message), /path outside workspace root refused/);
});

test("allowReadOutsideRoot lifts reads but never writes", async (t) => {
  const root = await tempDir(t, "acp-guard-");
  const outside = await tempDir(t, "acp-outside-");
  await writeFile(join(outside, "secret.txt"), "outside content", "utf8");
  const agent = await guardAgent(t, root, true);

  const read = await probe(agent, join(outside, "secret.txt"));
  assert.equal(read.refused, false, "reads outside the root are permitted");
  assert.equal(read.content, "outside content");

  // The asymmetry is the whole point of the flag: it must not lift writes.
  const write = await probe(agent, join(outside, "planted.txt"), true);
  assert.equal(write.refused, true, "writes outside the root stay refused");
  assert.match(String(write.message), /path outside workspace root refused/);
});

test("a symlink out of the root is refused (closed by M1b-6)", async (t) => {
  const root = await tempDir(t, "acp-guard-");
  const outside = await tempDir(t, "acp-outside-");
  await writeFile(join(outside, "secret.txt"), "outside content", "utf8");
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  const agent = await guardAgent(t, root);

  // Until issue #22 this case read the outside file and the test recorded that
  // as a documented gap: `path.resolve` is string arithmetic and never touches
  // the filesystem, so `link.txt` looked in-root. `#guardPath` now compares
  // realpaths, and the message names the resolved target rather than the link.
  const read = await probe(agent, "link.txt");
  assert.equal(read.refused, true, "the link is resolved before the check");
  assert.match(String(read.message), /path outside workspace root refused/);
});

test("a symlink that stays inside the root is still followed", async (t) => {
  // The other side of the same edit. Realpathing everything would be easy to
  // over-tighten into refusing ordinary in-root links, which no story asked
  // for and which would break a workspace that uses one.
  const root = await tempDir(t, "acp-guard-");
  await writeFile(join(root, "real.txt"), "in-root content", "utf8");
  await symlink(join(root, "real.txt"), join(root, "alias.txt"));
  const agent = await guardAgent(t, root);

  const read = await probe(agent, "alias.txt");
  assert.equal(read.refused, false);
  assert.equal(read.content, "in-root content");
});

// --- a second turn after end_turn ------------------------------------------

test("a second prompt after end_turn runs on the same live session", async (t) => {
  // #62 R5 guards a prompt *during* a live turn. The multi-turn probe
  // (`docs/M0-FINDINGS.md` §Multi-turn, 2026-09-15) measured a follow-up prompt
  // completing on all four harnesses once the first turn had ended. This pins
  // the client half: after `end_turn` the guard is clear,
  // the session id is unchanged, no second harness is spawned, and the session
  // still holds the first turn's context.
  const root = await tempDir(t, "acp-two-turns-");
  const seen: CapturedEvent[] = [];
  const agent = new AcpAgent({
    name: "mock-remember",
    command: process.execPath,
    args: [MOCK_AGENT, "--scenario", "remember"],
    cwd: root,
    requestTimeoutMs: 10_000,
    onEvent: (e) => seen.push(e),
  });
  t.after(() => agent.stop());

  await agent.start();
  const sid = await agent.newSession();

  const first = await agent.prompt("alpha");
  assert.equal(first.stopReason, "end_turn");

  const second = await agent.prompt("beta");
  assert.equal(second.stopReason, "end_turn");
  assert.equal(agent.sessionId, sid, "no new session was opened");

  const text = seen
    .map(
      (e) => e.update as { sessionUpdate: string; content?: { text?: string } },
    )
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content?.text);
  assert.deepEqual(text, ["previous: (none)", "previous: alpha"]);

  const spawned = seen.filter(
    (e) => e.update.sessionUpdate === "_client_harness_spawned",
  );
  assert.equal(spawned.length, 1, "one harness served both turns");
});

// --- #guardWrite · mutation without asking -----------------------------------

test("an allowed permission is not re-decided when the same write crosses the wire", async (t) => {
  // A well-behaved harness announces an edit, asks permission, and only then
  // performs the write through `fs/write_text_file`. M1b-6 made the file
  // service consult the policy; that must apply to a write that skipped the
  // permission request, not turn one approved edit into two decisions (and two
  // `ask` prompts).
  const root = await tempDir(t, "acp-write-once-");
  const decisions: string[] = [];
  const agent = new AcpAgent({
    name: "mock-write",
    command: process.execPath,
    args: [MOCK_AGENT],
    cwd: root,
    requestTimeoutMs: 10_000,
    policy: ({ toolCall }) => {
      decisions.push(`${toolCall.kind}:${toolCall.title}`);
      return true;
    },
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();
  await agent.prompt("self test");

  const editDecisions = decisions.filter((d) => d.startsWith("edit:"));
  assert.equal(
    editDecisions.length,
    1,
    "the follow-up fs write is the same approved edit, not a second decision",
  );
  assert.match(editDecisions[0] ?? "", /Write ACP_TEST\.md/);
});

test("a guardWrite emits the pending event before its policy is consulted", async (t) => {
  // M1c-4, issue #28. `#requestPermission` is already covered above; this
  // closes the other policy-await path, where a harness writes through
  // `fs/write_text_file` without asking first.
  const root = await tempDir(t, "acp-guard-pending-");
  const seen: CapturedEvent[] = [];
  let seenWhenAsked: string[] = [];
  const agent = new AcpAgent({
    name: "fs-probe",
    command: process.execPath,
    args: ["-e", FS_PROBE],
    cwd: root,
    requestTimeoutMs: 5_000,
    onEvent: (e) => seen.push(e),
    policy: () => {
      seenWhenAsked = turnEvents(seen).map((e) => e.update.sessionUpdate);
      return true;
    },
  });
  t.after(() => agent.stop());

  await agent.start();
  const result = await probe(agent, "new.txt", true);
  assert.equal(result.refused, false);
  assert.deepEqual(
    seenWhenAsked,
    ["_client_permission_pending"],
    "the pending event, and only it, is out before a direct write is decided",
  );
  const pending = turnEvents(seen)[0]?.update as {
    title?: string;
    kind?: string;
  };
  assert.equal(pending.kind, "edit", "it carries the kind a filter needs");
  assert.ok(pending.title, "and the title a human needs to answer");
});

// --- M2-4 · stop() closes stdin first ------------------------------------------

/**
 * Starts `sleep 300` in a session of its own, the way every measured harness
 * runs a shell command, and writes its pid to `argv[1]`. On end of file it
 * kills that command and exits; on SIGTERM it dies with the command still
 * running — opencode's measured shape (2026-09-15).
 */
const REAPS_ON_EOF = [
  'const { spawn } = require("node:child_process");',
  'const { writeFileSync } = require("node:fs");',
  'const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });',
  "writeFileSync(process.argv[1], String(child.pid));",
  "process.stdin.resume();",
  'process.stdin.on("end", () => {',
  '  process.kill(child.pid, "SIGKILL");',
  "  process.exit(0);",
  "});",
].join("\n");

/**
 * Ignores end of file and leaks a grandchild that inherits stdout/stderr —
 * the shape whose pipes stay open after SIGKILL, so Node's `close` event
 * would never arrive and `stop()` would hang (M2-4, #34). Writes the
 * grandchild's pid to `argv[1]`.
 */
const LEAKS_A_PIPE_HOLDER = [
  'const { spawn } = require("node:child_process");',
  'const { writeFileSync } = require("node:fs");',
  'const child = spawn("sleep", ["300"], { stdio: ["ignore", "inherit", "inherit"] });',
  "writeFileSync(process.argv[1], String(child.pid));",
  "process.stdin.resume();",
  "setInterval(() => {}, 1000);",
].join("\n");

/** Resolves true once `pid` is gone, false if it is still alive after 5s. */
async function gone(pid: number): Promise<boolean> {
  for (const until = Date.now() + 5_000; Date.now() < until; ) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return false;
}

test("stop() closes stdin before any signal, so the harness reaps its own shell command", async (t) => {
  const dir = await tempDir(t, "acp-stop-");
  const pidFile = join(dir, "child.pid");
  const events: CapturedEvent[] = [];
  const agent = new AcpAgent({
    name: "reaps",
    command: process.execPath,
    args: ["-e", REAPS_ON_EOF, pidFile],
    onEvent: (e) => events.push(e),
  });
  t.after(() => agent.stop());
  // Never answers `initialize`: the rejection on close is expected.
  const started = agent.start().catch(() => {});

  let child = 0;
  for (const until = Date.now() + 5_000; !child && Date.now() < until; ) {
    child = Number(await readFile(pidFile, "utf8").catch(() => 0));
    if (!child) await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.ok(child, "the fake harness started its command");
  t.after(() => {
    try {
      process.kill(child, "SIGKILL");
    } catch {
      // Already gone: nothing left to kill.
    }
  });

  agent.stop();
  await started;

  // A signal first kills the harness before it reads end of file, and the
  // command it started in its own session outlives it.
  assert.equal(await gone(child), true, "the harness's command is gone");
  assert.deepEqual(
    events.map((e) => e.update.sessionUpdate),
    ["_client_harness_spawned", "_client_harness_exited"],
  );
});

test("a harness that ignores end of file is killed after the grace", async (t) => {
  const agent = new AcpAgent({
    name: "deaf",
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
    stopGraceMs: 200,
  });
  t.after(() => agent.stop());
  const started = agent.start().catch((err: Error) => err.message);

  agent.stop();
  const at = Date.now();
  // `null`: ended by a signal, not an exit of its own.
  assert.match(String(await started), /exited with code null/);
  assert.ok(Date.now() - at >= 150, "it waited for the grace first");
});

test("stop() settles once the harness is killed, though a leaked grandchild holds its pipes", async (t) => {
  const dir = await tempDir(t, "acp-leak-");
  const pidFile = join(dir, "grandchild.pid");
  const agent = new AcpAgent({
    name: "leaks",
    command: process.execPath,
    args: ["-e", LEAKS_A_PIPE_HOLDER, pidFile],
    stopGraceMs: 200,
  });
  t.after(() => agent.stop());
  const started = agent.start().catch(() => {});

  let grandchild = 0;
  for (const until = Date.now() + 5_000; !grandchild && Date.now() < until; ) {
    grandchild = Number(await readFile(pidFile, "utf8").catch(() => 0));
    if (!grandchild) await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.ok(grandchild, "the fake harness leaked its command");
  t.after(() => {
    try {
      process.kill(grandchild, "SIGKILL");
    } catch {
      // Already gone: nothing left to kill.
    }
  });

  const at = Date.now();
  await agent.stop();
  assert.ok(
    Date.now() - at < 3_000,
    "stop() resolved though the grandchild holds the pipes",
  );
  await started;
});

// --- #62 B1 · per-request timeout --------------------------------------------

test("the default deadline is the story's 30s", () => {
  const agent = new AcpAgent({ command: "true" });
  assert.equal(agent.requestTimeoutMs, 30_000);
});

test("the default stop grace is the measured 5s safety net", () => {
  const agent = new AcpAgent({ command: "true" });
  assert.equal(agent.stopGraceMs, 5_000);
});

test("initialize carries the kapelle clientInfo, not the old package name", async (t) => {
  const agent = new AcpAgent({
    name: "init-info",
    command: process.execPath,
    args: ["-e", INITIALIZE_PROBE],
    requestTimeoutMs: 5_000,
    policy: () => true,
  });
  t.after(() => agent.stop());

  await agent.start();
  const info = await agent.request<{
    clientInfo?: { name?: string; title?: string };
  }>("debug/init_client_info");

  assert.equal(info.clientInfo?.name, "kapelle");
  assert.equal(info.clientInfo?.title, "Kapelle");
});

test("a harness that never answers initialize fails on the deadline", async (t) => {
  const agent = new AcpAgent({
    name: "hangs",
    command: process.execPath,
    args: ["-e", HANGS_FOREVER],
    requestTimeoutMs: 150,
  });
  // Registered before the first await: a failing assertion must still reap the
  // subprocess, or a red test leaves an orphan behind.
  t.after(() => agent.stop());

  const startedAt = Date.now();
  await assert.rejects(
    () => agent.start(),
    /did not answer "initialize" within 150ms/,
  );
  // The point of the story: it fails on a deadline rather than hanging.
  assert.ok(
    Date.now() - startedAt < 5_000,
    "start() must reject on the deadline, not hang",
  );
});

test("session-management calls are bounded too, not just the handshake", async (t) => {
  // `session/new` is the slowest handshake step M0-1 measured (copilot, 3.0s),
  // so it is the call most likely to hang a task — and without this fixture
  // the allowlist could be narrowed to `["initialize"]` with the suite still
  // green. The fixture is `mock-agent.mjs`'s, so the same silence is
  // reachable from the CLI (M1b-5); the budget here is what keeps the test
  // off the 30s default.
  const agent = new AcpAgent({
    name: "stalls-on-new",
    command: process.execPath,
    args: [MOCK_AGENT, "--scenario", "silent-session"],
    // Generous enough to cover process spawn and node boot, so only the
    // deliberate stall can trip it.
    requestTimeoutMs: 2_000,
  });
  t.after(() => agent.stop());

  // The handshake answers, so this must not be what rejects.
  await agent.start();

  await assert.rejects(
    () => agent.newSession(),
    /did not answer "session\/new" within 2000ms/,
    "session/new carries a deadline, not only initialize",
  );
});

test("session/prompt is never bounded by the request deadline", async (t) => {
  const agent = new AcpAgent({
    name: "slow-turn",
    command: process.execPath,
    args: ["-e", scriptedAgent(3_000)],
    // Both numbers are well clear of process spawn: the invariant under test
    // is only that the turn outlasts the budget, so give the handshake room
    // rather than making a loaded CI runner the thing that fails.
    requestTimeoutMs: 2_000,
  });
  t.after(() => agent.stop());

  // Both of these are timed methods and must answer inside the budget.
  await agent.start();
  await agent.newSession();

  // This turn takes 3000ms against a 2000ms budget. If the deadline applied to
  // session/prompt, this would reject instead of resolving.
  const res = await agent.prompt("take your time");
  assert.equal(res.stopReason, "end_turn");
});

// --- #62 R5 · in-flight prompt guard -----------------------------------------

test("a second prompt during a live turn throws without reaching the wire", async (t) => {
  const agent = new AcpAgent({
    name: "guarded",
    command: process.execPath,
    args: ["-e", scriptedAgent(300)],
    requestTimeoutMs: 2_000,
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();

  const firstTurn = agent.prompt("first");
  await assert.rejects(
    () => agent.prompt("second"),
    /already running a turn/,
    "a second prompt must be refused, not sent",
  );
  assert.equal((await firstTurn).stopReason, "end_turn");

  // The harness counts every session/prompt it actually received. A guard that
  // sent first and failed afterwards would leave this at 2.
  const seen = await agent.request<{ count: number }>("debug/prompt_count");
  assert.equal(seen.count, 1, "the refused prompt must not reach the wire");
});

// --- #62 B3 · the whole PromptResponse ---------------------------------------

test("prompt() returns the whole response, usage and _meta intact", async (t) => {
  const agent = new AcpAgent({
    name: "counts-tokens",
    command: process.execPath,
    args: ["-e", scriptedAgent(10)],
    requestTimeoutMs: 2_000,
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();
  const res = await agent.prompt("how many tokens was that");

  assert.equal(res.stopReason, "end_turn");
  // M0-5: usage is the only per-task token count present on all three
  // harnesses. Dropping it must fail here rather than pass silently.
  assert.deepEqual(res.usage, {
    inputTokens: 11,
    outputTokens: 22,
    totalTokens: 33,
  });
  // The fleet's only exhaustion warning rides on _meta (M0-5), and M1a-2 put
  // _meta on the base of every message type precisely so it survives.
  assert.deepEqual(res._meta, { "_claude/rateLimit": "ok" });
});

// --- stderr capture on death -------------------------------------------------

test("a harness that dies mid-handshake fails with its own stderr", async (t) => {
  const agent = new AcpAgent({
    name: "dying",
    command: process.execPath,
    args: ["-e", DIES_MID_HANDSHAKE],
    requestTimeoutMs: 5_000,
  });
  t.after(() => agent.stop());

  let err: Error | null = null;
  try {
    await agent.start();
  } catch (caught) {
    err = caught as Error;
  }

  assert.ok(err, "start() must reject when the harness dies");
  // The bare exit code is what this replaces, so it must still be present.
  assert.match(err.message, /exited with code 1/);
  // ...and now the harness's own explanation comes with it.
  assert.match(err.message, /Cannot find module '\/nonexistent\/preload\.js'/);
  // That line sits near the head of the output; a tail-only window drops it.
  assert.match(err.message, /node:internal\/modules\/cjs\/loader:1568/);
});

test("an existing log is kept whole, never appended to or truncated", async (t) => {
  // A `runId` is minted per run, so a second harness writing an existing log
  // needs a caller that supplied one — M2's daemon can. Neither mixing the two
  // executions nor overwriting the first is acceptable, so the open is
  // exclusive: the run continues, one line says the log was refused, and what
  // is on disk stays as it was.
  const dir = await tempDir(t, "acp-log-");
  const log = join(dir, "taken.stderr.log");
  await writeFile(log, "an earlier run\n", "utf8");

  const agent = new AcpAgent({
    name: "second",
    command: process.execPath,
    args: ["-e", DIES_MID_HANDSHAKE],
    stderrLog: log,
    requestTimeoutMs: 5_000,
  });
  t.after(() => agent.stop());

  await assert.rejects(agent.start());

  assert.equal(
    await readFile(log, "utf8"),
    "an earlier run\n",
    "the first run's record is the one thing that must not be lost",
  );
});

test("a fresh log holds the harness's stderr, with no flag asked for", async (t) => {
  const dir = await tempDir(t, "acp-log-");
  const log = join(dir, "fresh.stderr.log");

  const agent = new AcpAgent({
    name: "dying",
    command: process.execPath,
    args: ["-e", DIES_MID_HANDSHAKE],
    stderrLog: log,
    requestTimeoutMs: 5_000,
  });
  t.after(() => agent.stop());

  await assert.rejects(agent.start());

  // Polled, not read once: `start()` rejects when the harness dies, and the
  // last stderr lines are still travelling up the pipe and through the log's
  // write stream. A single read was green locally and flaked on CI (#112).
  const wanted = /Cannot find module '\/nonexistent\/preload\.js'/;
  let text = "";
  for (const end = Date.now() + 5_000; Date.now() < end; ) {
    text = await readFile(log, "utf8");
    if (wanted.test(text)) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.match(text, wanted);
});

test("a silent harness produces no stderr section at all", async (t) => {
  const agent = new AcpAgent({
    name: "silent",
    command: process.execPath,
    args: ["-e", "process.exit(7);"],
    requestTimeoutMs: 5_000,
  });
  t.after(() => agent.stop());

  let err: Error | null = null;
  try {
    await agent.start();
  } catch (caught) {
    err = caught as Error;
  }

  assert.ok(err);
  // Exact, not a pattern: dropping #exitMessage's empty-buffer early return
  // yields a trailing newline that a /exited with code 7/ match would still
  // accept, so the assertion has to pin the whole string to be load-bearing.
  assert.equal(err.message, 'agent "silent" exited with code 7');
});

// --- #62 R4 · cancel-intent event --------------------------------------------

test("cancel() emits _client_cancel_requested and still sends the notify", async (t) => {
  const events: CapturedEvent[] = [];
  const agent = new AcpAgent({
    name: "cancels",
    command: process.execPath,
    args: ["-e", scriptedAgent(10)],
    requestTimeoutMs: 2_000,
    onEvent: (event) => {
      events.push(event);
    },
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();
  agent.cancel();

  const emitted = events.filter(
    (e) => e.update.sessionUpdate === "_client_cancel_requested",
  );
  assert.equal(emitted.length, 1, "exactly one cancel-intent event");
  assert.equal(emitted[0].agent, "cancels");
  assert.equal(emitted[0].update.sessionId, "s1");

  // The event must accompany the notification, not replace it: M1b-2 reads our
  // record of having asked, but the agent still has to be told.
  const seen = await agent.request<{ count: number }>("debug/cancel_count");
  assert.equal(seen.count, 1, "session/cancel must still reach the harness");
});

test("cancel() before a session exists sends nothing and emits nothing", async (t) => {
  const events: CapturedEvent[] = [];
  const agent = new AcpAgent({
    name: "idle",
    command: process.execPath,
    args: ["-e", scriptedAgent(10)],
    requestTimeoutMs: 2_000,
    onEvent: (event) => {
      events.push(event);
    },
  });
  t.after(() => agent.stop());

  await agent.start();
  agent.cancel(); // no session yet

  assert.equal(turnEvents(events).length, 0, "no event without a session");
  const seen = await agent.request<{ count: number }>("debug/cancel_count");
  assert.equal(seen.count, 0, "no session/cancel on the wire either");
});

/**
 * Answers the handshake, then exits only when told. The deterministic exit is
 * what lets the after-death test know death has happened without sleeping.
 */
const ANSWERS_THEN_EXITS = [
  'let buf = "";',
  'const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  "  let nl;",
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, nl);",
  "    buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    const msg = JSON.parse(line);",
  '    if (msg.method === "initialize")',
  '      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });',
  '    else if (msg.method === "session/new")',
  '      write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });',
  '    else if (msg.method === "debug/exit") process.exit(0);',
  "  }",
  "});",
].join("\n");

test("cancel() after the harness has died records nothing", async (t) => {
  const events: CapturedEvent[] = [];
  const agent = new AcpAgent({
    name: "late-cancel",
    command: process.execPath,
    args: ["-e", ANSWERS_THEN_EXITS],
    requestTimeoutMs: 2_000,
    onEvent: (event) => {
      events.push(event);
    },
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();

  // A request the fixture will never answer: #failAll rejects it when the
  // process closes, which is how the test knows death has happened rather
  // than guessing with a sleep.
  const never = agent.request("debug/never");
  agent.notify("debug/exit");
  await assert.rejects(never, /exited with code 0/);

  agent.cancel();

  // Nothing was sent, so an authoritative cancel record here would be the
  // false entry M1b-2 keys on.
  assert.equal(
    turnEvents(events).length,
    0,
    "no cancel-intent event for a cancel that reached nothing",
  );
});

test("the guard clears once a turn ends, so later prompts still work", async (t) => {
  const agent = new AcpAgent({
    name: "sequential",
    command: process.execPath,
    args: ["-e", scriptedAgent(50)],
    requestTimeoutMs: 2_000,
  });
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();

  assert.equal((await agent.prompt("first")).stopReason, "end_turn");
  assert.equal((await agent.prompt("second")).stopReason, "end_turn");

  const seen = await agent.request<{ count: number }>("debug/prompt_count");
  assert.equal(seen.count, 2, "sequential turns must both reach the harness");
});

// --- permission outcomes (M1a-5, issue #13) ----------------------------------

/**
 * Asks permission on demand with either a normal option list or an allow-only
 * one, and reports back what the client answered.
 *
 * `debug/ask` exists so the outcome is observable: the response to
 * `session/request_permission` is the thing under test, and nothing else on
 * the wire carries it. Also records `session/set_mode`, which is the only
 * other new surface this story puts on the wire.
 */
const REPORTS_PERMISSION_OUTCOME = [
  'let buf = "";',
  "let nextId = 3000;",
  "let mode = null;",
  "const pending = new Map();",
  'const write = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  "  let nl;",
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, nl);",
  "    buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    const msg = JSON.parse(line);",
  '    if (msg.method === "initialize")',
  '      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });',
  '    else if (msg.method === "session/new")',
  '      write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });',
  '    else if (msg.method === "session/set_mode") {',
  "      mode = msg.params;",
  '      write({ jsonrpc: "2.0", id: msg.id, result: {} });',
  '    } else if (msg.method === "debug/ask") {',
  "      const rid = nextId++;",
  "      pending.set(rid, msg.id);",
  "      write({",
  '        jsonrpc: "2.0",',
  "        id: rid,",
  '        method: "session/request_permission",',
  "        params: {",
  '          sessionId: "s1",',
  '          toolCall: { toolCallId: "t1", title: "Write it", kind: "edit" },',
  "          options: msg.params.allowOnly",
  "            ? [",
  '                { optionId: "always", name: "Always", kind: "allow_always" },',
  '                { optionId: "once", name: "Allow", kind: "allow_once" },',
  "              ]",
  "            : [",
  '                { optionId: "once", name: "Allow", kind: "allow_once" },',
  '                { optionId: "no", name: "Reject", kind: "reject_once" },',
  "              ],",
  "        },",
  "      });",
  "    } else if (msg.id !== undefined && pending.has(msg.id)) {",
  "      const debugId = pending.get(msg.id);",
  "      pending.delete(msg.id);",
  "      write({",
  '        jsonrpc: "2.0",',
  "        id: debugId,",
  "        result: { mode, outcome: msg.result.outcome },",
  "      });",
  "    }",
  "  }",
  "});",
].join("\n");

type AskResult = {
  mode: { sessionId: string; modeId: string } | null;
  outcome: { outcome: string; optionId?: string };
};

async function permissionAgent(
  t: TestContext,
  policy: () => boolean,
  onEvent?: (e: CapturedEvent) => void,
): Promise<AcpAgent> {
  const agent = new AcpAgent({
    name: "perm",
    command: process.execPath,
    args: ["-e", REPORTS_PERMISSION_OUTCOME],
    requestTimeoutMs: 5_000,
    policy,
    onEvent,
  });
  t.after(() => agent.stop());
  await agent.start();
  await agent.newSession();
  return agent;
}

test("a denial with no reject option answers cancelled, not a guessed allow", async (t) => {
  const seen: CapturedEvent[] = [];
  const agent = await permissionAgent(
    t,
    () => false,
    (e) => seen.push(e),
  );

  const res = await agent.request<AskResult>("debug/ask", { allowOnly: true });

  // The pre-M1a-5 tail would have sent `always` here — claude orders
  // allow_always first, so the denial would have become a persisted grant.
  assert.deepEqual(res.outcome, { outcome: "cancelled" });
  const record = seen.find(
    (e) => e.update.sessionUpdate === "_client_permission",
  );
  assert.ok(record, "the decision is still recorded");
  const decision = record.update as { allow?: boolean; optionId?: string };
  assert.equal(decision.allow, false, "the event still records the denial");
  assert.equal(
    decision.optionId,
    undefined,
    "and records that no option carried it",
  );
});

test("the pending event is emitted before the policy is consulted", async (t) => {
  // M1c-4, issue #28. The whole point of a separate event is the *moment*: a
  // record written after the decision cannot ring a bell for the human the
  // decision is waiting on. So the policy itself is the observer — whatever it
  // can already see is what left the client before it blocked.
  const seen: CapturedEvent[] = [];
  let seenWhenAsked: string[] = [];
  const agent = await permissionAgent(
    t,
    () => {
      seenWhenAsked = turnEvents(seen).map((e) => e.update.sessionUpdate);
      return true;
    },
    (e) => seen.push(e),
  );

  await agent.request<AskResult>("debug/ask", { allowOnly: false });

  assert.deepEqual(
    seenWhenAsked,
    ["_client_permission_pending"],
    "the pending event, and only it, is out before the decision is taken",
  );
  const pending = turnEvents(seen)[0]?.update as {
    title?: string;
    kind?: string;
  };
  assert.equal(pending.kind, "edit", "it carries the kind a filter needs");
  assert.ok(pending.title, "and the title a human needs to answer");
});

test("a matching reject option is preferred over cancelling", async (t) => {
  const agent = await permissionAgent(t, () => false);
  const res = await agent.request<AskResult>("debug/ask", { allowOnly: false });
  assert.deepEqual(res.outcome, { outcome: "selected", optionId: "no" });
});

test("an approval takes allow_once even when allow_always is listed first", async (t) => {
  const agent = await permissionAgent(t, () => true);
  const res = await agent.request<AskResult>("debug/ask", { allowOnly: true });
  assert.deepEqual(res.outcome, { outcome: "selected", optionId: "once" });
});

test("setMode sends the session id and the harness's own mode id", async (t) => {
  const agent = await permissionAgent(t, () => false);
  await agent.setMode("plan");
  const res = await agent.request<AskResult>("debug/ask", { allowOnly: false });
  assert.deepEqual(res.mode, { sessionId: "s1", modeId: "plan" });
});

test("every session gets a fresh id, and a forged one is refused", async (t) => {
  // The mock used to answer `sess_mock_1` to anything, so a client that sent a
  // stale or invented id would have been answered as if it were valid (M1b-5).
  // Nothing in the client can send one today — this is the fixture that stays
  // honest if that ever changes.
  const agent = new AcpAgent({
    name: "mock",
    command: process.execPath,
    args: [MOCK_AGENT],
  });
  t.after(() => agent.stop());

  await agent.start();
  const first = await agent.newSession();
  const second = await agent.newSession();
  assert.notEqual(first, second, "one process, two sessions, two ids");

  agent.sessionId = "sess_never_issued" as typeof second;
  await assert.rejects(() => agent.prompt("hi"), /unknown session/);
});
