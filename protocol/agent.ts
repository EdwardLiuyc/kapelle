import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import type {
  AgentCapabilities,
  AgentEvent,
  Implementation,
  InitializeResponse,
  JsonRpcError,
  McpServer,
  Meta,
  NewSessionResponse,
  PermissionOption,
  PermissionOptionId,
  PromptResponse,
  ReadTextFileResponse,
  RequestPermissionResponse,
  SessionId,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallId,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  WriteTextFileResponse,
} from "./types.ts";

const PROTOCOL_VERSION = 1;

// Tool kinds we consider non-destructive. Used by the "safe" policy.
const READ_ONLY_KINDS = new Set<ToolKind>(["read", "search", "fetch", "think"]);

// --- the shapes the class hands to its collaborators -------------------------

/** What the policy is asked to judge — the merged view of a tool call. */
interface PolicyToolCall {
  toolCallId?: ToolCallId;
  title: string;
  kind: ToolKind;
  // Arbitrary agent-supplied JSON. `protocol/types.ts` types `rawInput` the
  // same way on ToolCall/ToolCallUpdate; there is no narrower value type.
  // pi-lens-ignore: no-unsafe-dictionary-unknown
  rawInput?: Record<string, unknown>;
}

export interface PolicyRequest {
  agent: string;
  toolCall: PolicyToolCall;
  options: PermissionOption[];
}

export type Policy = (req: PolicyRequest) => boolean | Promise<boolean>;

/**
 * One event leaving this client, tagged with the agent that caused it.
 * Local until a consumer needs to name it — M1a-7's `render.mjs` port is the
 * first that will, and exporting it there keeps knip honest in the meantime.
 */
interface AgentEventEnvelope {
  agent: string;
  update: AgentEvent;
}

export type EventSink = (event: AgentEventEnvelope) => void;

export interface AcpAgentOptions {
  name?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  policy?: Policy;
  onEvent?: EventSink;
  allowReadOutsideRoot?: boolean;
  verbose?: boolean;
}

// --- internal wire shapes ----------------------------------------------------

interface PendingRequest {
  // The JSON-RPC result is decoded by the caller via `request<R>()`; this map
  // is heterogeneous, so it cannot hold anything narrower.
  // pi-lens-ignore: no-unknown-parameters
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * What we retain per `toolCallId`. Wider than the three fields the policy
 * reads because `tool_call_update` is merged in whole (see `#onNotification`).
 */
interface RememberedToolCall extends Meta {
  sessionUpdate?: "tool_call" | "tool_call_update";
  toolCallId?: ToolCallId;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  // As in PolicyToolCall above — the protocol's own shape for raw tool input.
  // pi-lens-ignore: no-unsafe-dictionary-unknown
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
}

type OutgoingMessage =
  | { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | { jsonrpc: "2.0"; id: number | string; error: JsonRpcError };

/** A line off the agent's stdout, before we know which of the three it is. */
interface IncomingMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface ReadTextFileParams {
  path: string;
  line?: number;
  limit?: number;
}

interface WriteTextFileParams {
  path: string;
  content: string;
}

interface RequestPermissionParams {
  toolCall?: ToolCallUpdate;
  options: PermissionOption[];
}

// A `catch` binding is `unknown` by language rule under `strict`; that is the
// correct type here and narrowing it is this function's whole job.
// pi-lens-ignore: no-unknown-parameters
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A single ACP agent subprocess.
 *
 * We are the CLIENT. We spawn the agent, own the workspace, answer its
 * requests for file access, and decide its permissions.
 *
 * Ported from `acp.mjs` (M1a-3). This file is the port and nothing else — the
 * five behaviours the story also carries (request timeout, stderr ring buffer,
 * whole `PromptResponse` per #62 B3, cancel-intent event per #62 R4, in-flight
 * prompt guard per #62 R5) land on top of it, so that `npm run selftest`
 * passing unchanged still means something here.
 */
// A verbatim port of acp.mjs's single class — the story is "essentially
// intact", so splitting it is a refactor this change deliberately does not make.
// pi-lens-ignore: large-class
export class AcpAgent {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  policy: Policy;
  onEvent: EventSink;
  allowReadOutsideRoot: boolean;
  verbose: boolean;
  sessionId: SessionId | null;
  agentInfo: Implementation | null;
  agentCapabilities: AgentCapabilities | null;

  #proc: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #pending = new Map<number | string, PendingRequest>();
  #toolCalls = new Map<ToolCallId, RememberedToolCall>();
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
  }: AcpAgentOptions) {
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

  async start(): Promise<InitializeResponse> {
    // `stdio: "pipe"` is the string form of ["pipe", "pipe", "pipe"] and gives
    // us non-null stdin/stdout/stderr in the type.
    const proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: "pipe",
    });
    this.#proc = proc;

    proc.on("error", (err: Error) => {
      this.#failAll(
        new Error(`failed to spawn "${this.command}": ${err.message}`),
      );
    });

    proc.on("close", (code: number | null) => {
      this.#closed = true;
      this.#failAll(new Error(`agent "${this.name}" exited with code ${code}`));
    });

    createInterface({ input: proc.stdout }).on("line", (line: string) => {
      this.#onLine(line);
    });

    // The spec allows agents to log freely on stderr. Surface it only when asked.
    createInterface({ input: proc.stderr }).on("line", (line: string) => {
      if (this.verbose) process.stderr.write(`[${this.name}:stderr] ${line}\n`);
    });

    const res = await this.request<InitializeResponse>("initialize", {
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

  async newSession({
    mcpServers = [],
  }: {
    mcpServers?: McpServer[];
  } = {}): Promise<SessionId> {
    const res = await this.request<NewSessionResponse>("session/new", {
      cwd: this.cwd,
      mcpServers,
    });
    this.sessionId = res.sessionId;
    return this.sessionId;
  }

  /** Send a prompt and resolve with the stop reason once the turn ends. */
  async prompt(text: string): Promise<StopReason> {
    if (!this.sessionId)
      throw new Error("no session — call newSession() first");
    const res = await this.request<PromptResponse>("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    return res.stopReason;
  }

  cancel(): void {
    if (this.sessionId)
      this.notify("session/cancel", { sessionId: this.sessionId });
  }

  stop(): void {
    if (this.#proc && !this.#closed) {
      this.#proc.stdin.end();
      this.#proc.kill();
    }
  }

  // ---------- JSON-RPC plumbing ----------

  // Outbound params are serialized straight to JSON. M1a-2 decided against
  // runtime schema validation (zod would cost the zero-dependency trait), so
  // the wire boundary stays `unknown` and callers supply the type.
  // pi-lens-ignore: no-unknown-parameters
  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    const id = this.#nextId++;
    return new Promise<R>((resolve_, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve_(value as R),
        reject,
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  // Outbound, as `request()` above.
  // pi-lens-ignore: no-unknown-parameters
  notify(method: string, params?: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #send(msg: OutgoingMessage): void {
    if (this.#closed) return;
    if (!this.#proc) throw new Error(`agent "${this.name}" is not started`);
    // Messages are newline-delimited and must not contain embedded newlines.
    this.#proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #onLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;

    let msg: IncomingMessage;
    try {
      msg = JSON.parse(line) as IncomingMessage;
    } catch {
      // Agents MUST NOT put non-ACP data on stdout, but be forgiving.
      this.#log(`ignoring non-JSON stdout: ${line.slice(0, 200)}`);
      return;
    }

    if (msg.method && msg.id !== undefined) {
      void this.#onRequest(msg);
      return;
    }
    if (msg.method) {
      this.#onNotification(msg);
      return;
    }
    if (msg.id !== undefined) this.#onResponse(msg);
  }

  #onResponse(msg: IncomingMessage): void {
    if (msg.id === undefined) return;
    const entry = this.#pending.get(msg.id);
    if (!entry) return;
    this.#pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
    } else {
      entry.resolve(msg.result);
    }
  }

  async #onRequest(msg: IncomingMessage): Promise<void> {
    const { id, method } = msg;
    if (id === undefined || method === undefined) return;
    try {
      const result = await this.#handleRequest(method, msg.params ?? {});
      this.#send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.#send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: errorMessage(err) },
      });
    }
  }

  // Inbound params arrive untyped and are narrowed per-branch below, which is
  // the decode point M1a-2 chose instead of a runtime validator.
  // pi-lens-ignore: no-unknown-parameters
  async #handleRequest(
    method: string,
    // pi-lens-ignore: no-unknown-parameters
    params: unknown,
  ): Promise<
    ReadTextFileResponse | WriteTextFileResponse | RequestPermissionResponse
  > {
    switch (method) {
      case "fs/read_text_file":
        return this.#readTextFile(params as ReadTextFileParams);
      case "fs/write_text_file":
        return this.#writeTextFile(params as WriteTextFileParams);
      case "session/request_permission":
        return this.#requestPermission(params as RequestPermissionParams);
      default: {
        const err = new Error(`method not supported by this client: ${method}`);
        throw err;
      }
    }
  }

  #onNotification(msg: IncomingMessage): void {
    if (msg.method !== "session/update") return;
    const params = msg.params as { update?: SessionUpdate } | undefined;
    const update = params?.update;
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

  #guardPath(p: string, { write }: { write: boolean }): string {
    const abs = resolve(this.cwd, p);
    const inRoot = abs === this.cwd || abs.startsWith(this.cwd + sep);
    if (!inRoot && (write || !this.allowReadOutsideRoot)) {
      throw new Error(
        `path outside workspace root refused: ${abs} (root: ${this.cwd})`,
      );
    }
    return abs;
  }

  async #readTextFile({
    path,
    line,
    limit,
  }: ReadTextFileParams): Promise<ReadTextFileResponse> {
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

  async #writeTextFile({
    path,
    content,
  }: WriteTextFileParams): Promise<WriteTextFileResponse> {
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

  async #requestPermission({
    toolCall,
    options,
  }: RequestPermissionParams): Promise<RequestPermissionResponse> {
    const known = this.#toolCalls.get(toolCall?.toolCallId ?? "") ?? {};
    const detail: PolicyToolCall = {
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

  #failAll(err: Error): void {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  #log(m: string): void {
    if (this.verbose) process.stderr.write(`[${this.name}] ${m}\n`);
  }
}

/** Choose an optionId matching our allow/reject decision. */
function pickOption(
  options: PermissionOption[] = [],
  allow: boolean,
): PermissionOptionId {
  const want: PermissionOption["kind"][] = allow
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
export async function safePolicy({
  toolCall,
}: PolicyRequest): Promise<boolean> {
  return READ_ONLY_KINDS.has(toolCall.kind);
}

/** Everything allowed. Path guards still apply to fs/* requests. */
export async function autoPolicy(): Promise<boolean> {
  return true;
}

/** Read-only auto-approved; mutations prompt on the terminal. */
export function makeAskPolicy(): { close: () => void; policy: Policy } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  return {
    close: () => rl.close(),
    policy: async ({ agent, toolCall }: PolicyRequest) => {
      if (READ_ONLY_KINDS.has(toolCall.kind)) return true;
      const answer = await ask(
        `\n  ${agent} wants to run [${toolCall.kind}] ${toolCall.title}\n  allow? [y/N] `,
      );
      return /^y(es)?$/i.test(answer.trim());
    },
  };
}
