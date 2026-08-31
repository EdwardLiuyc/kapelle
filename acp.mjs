import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = 1;

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
  #toolCalls = new Map(); // toolCallId -> { title, kind, rawInput }
  #closed = false;

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
      this.#failAll(
        new Error(`failed to spawn "${this.command}": ${err.message}`),
      );
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
        // We answer fs/* ourselves. We do NOT offer terminal/*, so the agent
        // runs shell commands in its own process instead of through us.
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: {
        name: "acp-mvp",
        title: "ACP MVP client",
        version: "0.1.0",
      },
    });

    this.agentInfo = res.agentInfo ?? null;
    this.agentCapabilities = res.agentCapabilities ?? {};

    if (res.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `protocol mismatch: we speak v${PROTOCOL_VERSION}, "${this.name}" answered v${res.protocolVersion}`,
      );
    }

    if (Array.isArray(res.authMethods) && res.authMethods.length > 0) {
      this.#log(
        `note: agent offers auth methods [${res.authMethods
          .map((m) => m.id ?? m.name)
          .join(
            ", ",
          )}]. If prompts fail, log in via the agent's own CLI first.`,
      );
    }

    return res;
  }

  async newSession({ mcpServers = [] } = {}) {
    const res = await this.request("session/new", {
      cwd: this.cwd,
      mcpServers,
    });
    this.sessionId = res.sessionId;
    return this.sessionId;
  }

  /** Send a prompt and resolve with the stop reason once the turn ends. */
  async prompt(text) {
    if (!this.sessionId)
      throw new Error("no session — call newSession() first");
    const res = await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    return res.stopReason;
  }

  cancel() {
    if (this.sessionId)
      this.notify("session/cancel", { sessionId: this.sessionId });
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
    this.#proc.stdin.write(`${JSON.stringify(msg)}\n`);
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
      this.#toolCalls.set(update.toolCallId, {
        title: update.title,
        kind: update.kind ?? "other",
        rawInput: update.rawInput,
      });
    }
    if (update.sessionUpdate === "tool_call_update") {
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
        `path outside workspace root refused: ${abs} (root: ${this.cwd})`,
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
      const end = limit == null ? lines.length : start + limit;
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
    // Schema-faithful success payload (WriteTextFileResponse is {}): JSON-RPC
    // still requires a `result` member — null worked, {} matches the type.
    return {};
  }

  async #requestPermission({ toolCall, options }) {
    const known = this.#toolCalls.get(toolCall?.toolCallId) ?? {};
    const detail = {
      toolCallId: toolCall?.toolCallId,
      title: toolCall?.title ?? known.title ?? "(untitled tool call)",
      kind: toolCall?.kind ?? known.kind ?? "other",
      rawInput: toolCall?.rawInput ?? known.rawInput,
    };

    const allow = await this.policy({
      agent: this.name,
      toolCall: detail,
      options,
    });
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
  const want = allow
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
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
        `\n  ${agent} wants to run [${toolCall.kind}] ${toolCall.title}\n  allow? [y/N] `,
      );
      return /^y(es)?$/i.test(answer.trim());
    },
  };
}
