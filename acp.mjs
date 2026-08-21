import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export const PROTOCOL_VERSION = 1;

// Tool kinds we consider non-destructive. Used by the "safe" policy.
const READ_ONLY_KINDS = new Set(["read", "search", "fetch", "think"]);

/**
 * A single ACP agent subprocess.
 *
 * We are the CLIENT. We spawn the agent, own the workspace, answer its
 * requests for file access, and decide its permissions.
 */
export class AcpAgent {
  #proc = null;
  #nextId = 1;
  #pending = new Map();
  #toolCalls = new Map(); // toolCallId -> { title, kind }
  #closed = false;
  #terminals = new Map(); // SPIKE (M0-3): terminalId -> { child, chunks, exitStatus }
  #nextTerminalId = 1;

  constructor({
    name,
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    policy = safePolicy,
    onEvent = () => {},
    allowReadOutsideRoot = false,
    verbose = false,
  }) {
    this.name = name ?? command;
    this.command = command;
    this.args = args;
    this.cwd = resolve(cwd);
    this.env = env;
    this.policy = policy;
    this.onEvent = onEvent;
    this.allowReadOutsideRoot = allowReadOutsideRoot;
    this.verbose = verbose;
    this.sessionId = null;
    this.agentInfo = null;
    this.agentCapabilities = null;
  }

  // ---------- lifecycle ----------

  async start() {
    this.#proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#proc.on("error", (err) => {
      this.#failAll(new Error(`failed to spawn "${this.command}": ${err.message}`));
    });

    this.#proc.on("close", (code) => {
      this.#closed = true;
      this.#failAll(new Error(`agent "${this.name}" exited with code ${code}`));
    });

    createInterface({ input: this.#proc.stdout }).on("line", (line) => {
      this.#onLine(line);
    });

    // The spec allows agents to log freely on stderr. Surface it only when asked.
    createInterface({ input: this.#proc.stderr }).on("line", (line) => {
      if (this.verbose) process.stderr.write(`[${this.name}:stderr] ${line}\n`);
    });

    const res = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        // SPIKE (M0-3, #4): terminal is normally false. Flipped here to find out
        // whether any harness takes us up on it. Never merge this branch.
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        // SPIKE follow-up: claude-agent-acp ignores clientCapabilities.terminal and
        // reads this vendor _meta flag instead (acp-agent.js:1862, :3195).
        _meta: { terminal_output: true },
      },
      clientInfo: { name: "acp-mvp", title: "ACP MVP client", version: "0.1.0" },
    });

    this.agentInfo = res.agentInfo ?? null;
    this.agentCapabilities = res.agentCapabilities ?? {};

    if (res.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `protocol mismatch: we speak v${PROTOCOL_VERSION}, "${this.name}" answered v${res.protocolVersion}`
      );
    }

    if (Array.isArray(res.authMethods) && res.authMethods.length > 0) {
      this.#log(
        `note: agent offers auth methods [${res.authMethods
          .map((m) => m.id ?? m.name)
          .join(", ")}]. If prompts fail, log in via the agent's own CLI first.`
      );
    }

    return res;
  }

  async newSession({ mcpServers = [] } = {}) {
    const res = await this.request("session/new", { cwd: this.cwd, mcpServers });
    this.sessionId = res.sessionId;
    return this.sessionId;
  }

  /** Send a prompt and resolve with the stop reason once the turn ends. */
  async prompt(text) {
    if (!this.sessionId) throw new Error("no session — call newSession() first");
    const res = await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    return res.stopReason;
  }

  cancel() {
    if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
  }

  stop() {
    if (this.#proc && !this.#closed) {
      this.#proc.stdin.end();
      this.#proc.kill();
    }
  }

  // ---------- JSON-RPC plumbing ----------

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve_, reject) => {
      this.#pending.set(id, { resolve: resolve_, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #send(msg) {
    if (this.#closed) return;
    // Messages are newline-delimited and must not contain embedded newlines.
    this.#proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  #onLine(raw) {
    const line = raw.trim();
    if (!line) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Agents MUST NOT put non-ACP data on stdout, but be forgiving.
      this.#log(`ignoring non-JSON stdout: ${line.slice(0, 200)}`);
      return;
    }

    if (msg.method && msg.id !== undefined) return this.#onRequest(msg);
    if (msg.method) return this.#onNotification(msg);
    if (msg.id !== undefined) return this.#onResponse(msg);
  }

  #onResponse(msg) {
    const entry = this.#pending.get(msg.id);
    if (!entry) return;
    this.#pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
    } else {
      entry.resolve(msg.result);
    }
  }

  async #onRequest(msg) {
    try {
      const result = await this.#handleRequest(msg.method, msg.params ?? {});
      this.#send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (err) {
      this.#send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: err.message },
      });
    }
  }

  async #handleRequest(method, params) {
    switch (method) {
      case "fs/read_text_file":
        return this.#readTextFile(params);
      case "fs/write_text_file":
        return this.#writeTextFile(params);
      case "session/request_permission":
        return this.#requestPermission(params);
      // SPIKE (M0-3, #4). Observation, not containment: these really execute,
      // and #guardPath does not apply to them. Never merge.
      case "terminal/create":
        return this.#terminalCreate(params);
      case "terminal/output":
        return this.#terminalOutput(params);
      case "terminal/wait_for_exit":
        return this.#terminalWaitForExit(params);
      case "terminal/kill":
        return this.#terminalKill(params);
      case "terminal/release":
        return this.#terminalRelease(params);
      default: {
        const err = new Error(`method not supported by this client: ${method}`);
        throw err;
      }
    }
  }

  #onNotification(msg) {
    if (msg.method !== "session/update") return;
    const update = msg.params?.update;
    if (!update) return;

    // Permission requests only carry a toolCallId, so remember the details
    // announced here — otherwise the policy has nothing to judge.
    if (update.sessionUpdate === "tool_call") {
      // SPIKE (M0-3, #4): rawInput on the notification is a third possible argv
      // channel, invisible to render.mjs. Log it so Q2 is measured, not assumed.
      this.#spikeLog("session/update:tool_call", update);
      this.#toolCalls.set(update.toolCallId, {
        title: update.title,
        kind: update.kind ?? "other",
        rawInput: update.rawInput,
      });
    }
    if (update.sessionUpdate === "tool_call_update") {
      // SPIKE (M0-3, #4): argv may arrive late, on the update rather than the call.
      if (update.rawInput !== undefined) {
        this.#spikeLog("session/update:tool_call_update", {
          toolCallId: update.toolCallId,
          rawInput: update.rawInput,
        });
      }
      const prev = this.#toolCalls.get(update.toolCallId) ?? {};
      this.#toolCalls.set(update.toolCallId, { ...prev, ...update });
    }

    this.onEvent({ agent: this.name, update });
  }

  // ---------- client-side capabilities ----------

  #guardPath(p, { write }) {
    const abs = resolve(this.cwd, p);
    const inRoot = abs === this.cwd || abs.startsWith(this.cwd + sep);
    if (!inRoot && (write || !this.allowReadOutsideRoot)) {
      throw new Error(
        `path outside workspace root refused: ${abs} (root: ${this.cwd})`
      );
    }
    return abs;
  }

  async #readTextFile({ path, line, limit }) {
    const abs = this.#guardPath(path, { write: false });
    let content = await readFile(abs, "utf8");
    if (line != null || limit != null) {
      const lines = content.split("\n");
      const start = Math.max(0, (line ?? 1) - 1);
      const end = limit != null ? start + limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }

  async #writeTextFile({ path, content }) {
    const abs = this.#guardPath(path, { write: true });
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    this.onEvent({
      agent: this.name,
      update: { sessionUpdate: "_client_wrote_file", path: abs },
    });
    return null;
  }

  // ---------- SPIKE (M0-3, #4): terminal/* — delete with this branch ----------
  //
  // The story said "logging no-ops". A no-op is not a legal answer: terminal/create
  // must return a terminalId or the harness aborts the turn, or quietly falls back to
  // its own shell — and that fallback looks exactly like never having asked. So these
  // really run the command. The argv log below is the evidence the spike exists for.

  #spikeLog(method, params) {
    const line = `[SPIKE ${new Date().toISOString()}] ${this.name} ${method} ${JSON.stringify(params)}`;
    process.stderr.write(line + "\n");
  }

  async #terminalCreate(params) {
    this.#spikeLog("terminal/create", params);
    const { command, args = [], cwd, env, outputByteLimit } = params;
    const id = `spike-term-${this.#nextTerminalId++}`;

    // NOTE: no #guardPath here, deliberately. We are measuring what the harness
    // asks for, not containing it. Nothing about this stub is a safety layer.
    const child = spawn(command, args, {
      cwd: cwd ? resolve(this.cwd, cwd) : this.cwd,
      env: env ? { ...this.env, ...Object.fromEntries(env.map((e) => [e.name, e.value])) } : this.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const term = {
      child,
      chunks: [],
      bytes: 0,
      limit: outputByteLimit ?? 1_000_000,
      truncated: false,
      exitStatus: null,
      exited: new Promise((res) => {
        child.on("close", (exitCode, signal) => {
          term.exitStatus = { exitCode, signal: signal ?? null };
          res(term.exitStatus);
        });
      }),
    };
    const collect = (buf) => {
      term.bytes += buf.length;
      if (term.bytes > term.limit) term.truncated = true;
      else term.chunks.push(buf);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => collect(Buffer.from(`[spawn error] ${err.message}\n`)));

    this.#terminals.set(id, term);
    return { terminalId: id };
  }

  #terminal(id) {
    const term = this.#terminals.get(id);
    if (!term) throw new Error(`unknown terminalId: ${id}`);
    return term;
  }

  async #terminalOutput(params) {
    this.#spikeLog("terminal/output", params);
    const term = this.#terminal(params.terminalId);
    return {
      output: Buffer.concat(term.chunks).toString("utf8"),
      truncated: term.truncated,
      ...(term.exitStatus ? { exitStatus: term.exitStatus } : {}),
    };
  }

  async #terminalWaitForExit(params) {
    this.#spikeLog("terminal/wait_for_exit", params);
    const term = this.#terminal(params.terminalId);
    const exitStatus = term.exitStatus ?? (await term.exited);
    this.#spikeLog("terminal/wait_for_exit:resolved", { ...params, exitStatus });
    return { exitStatus };
  }

  async #terminalKill(params) {
    this.#spikeLog("terminal/kill", params);
    this.#terminal(params.terminalId).child.kill("SIGTERM");
    return null;
  }

  async #terminalRelease(params) {
    this.#spikeLog("terminal/release", params);
    const term = this.#terminal(params.terminalId);
    if (!term.exitStatus) term.child.kill("SIGTERM");
    this.#terminals.delete(params.terminalId);
    return null;
  }

  // ---------- end SPIKE ----------

  async #requestPermission({ toolCall, options }) {
    const known = this.#toolCalls.get(toolCall?.toolCallId) ?? {};
    const detail = {
      toolCallId: toolCall?.toolCallId,
      title: toolCall?.title ?? known.title ?? "(untitled tool call)",
      kind: toolCall?.kind ?? known.kind ?? "other",
      rawInput: toolCall?.rawInput ?? known.rawInput,
    };

    const allow = await this.policy({ agent: this.name, toolCall: detail, options });
    const optionId = pickOption(options, allow);

    this.onEvent({
      agent: this.name,
      update: {
        sessionUpdate: "_client_permission",
        allow,
        title: detail.title,
        kind: detail.kind,
        optionId,
      },
    });

    return { outcome: { outcome: "selected", optionId } };
  }

  #failAll(err) {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  #log(m) {
    if (this.verbose) process.stderr.write(`[${this.name}] ${m}\n`);
  }
}

/** Choose an optionId matching our allow/reject decision. */
function pickOption(options = [], allow) {
  const want = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of want) {
    const hit = options.find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  return options[0]?.optionId;
}

// ---------- permission policies ----------

/** Read-only work proceeds; anything that mutates is refused. */
export async function safePolicy({ toolCall }) {
  return READ_ONLY_KINDS.has(toolCall.kind);
}

/** Everything allowed. Path guards still apply to fs/* requests. */
export async function autoPolicy() {
  return true;
}

/** Read-only auto-approved; mutations prompt on the terminal. */
export function makeAskPolicy() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  return {
    close: () => rl.close(),
    policy: async ({ agent, toolCall }) => {
      if (READ_ONLY_KINDS.has(toolCall.kind)) return true;
      const answer = await ask(
        `\n  ${agent} wants to run [${toolCall.kind}] ${toolCall.title}\n  allow? [y/N] `
      );
      return /^y(es)?$/i.test(answer.trim());
    },
  };
}
