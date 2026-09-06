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
  SessionModeId,
  SessionUpdate,
  SetSessionModeResponse,
  ToolCallContent,
  ToolCallId,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  WriteTextFileResponse,
} from "./types.ts";

const PROTOCOL_VERSION = 1;

/**
 * Methods that carry a per-request deadline (#62 B1, ratified 2026-08-23).
 *
 * An allowlist rather than "everything except session/prompt": a long-running
 * method added later should not inherit a deadline by accident. `session/load`
 * is listed because the story says to extend it there when that lands, and
 * `session/close` is the same class of call.
 *
 * `session/prompt` is deliberately absent — a turn is legitimately long, and
 * bounding it is the watchdog's job, not this layer's.
 */
const TIMED_METHODS = new Set([
  "initialize",
  "session/new",
  "session/load",
  "session/close",
  "session/set_mode",
]);

// M0-1 measured the slowest handshake step at 3.0s (copilot's session/new),
// so this is an order of magnitude above the worst observed.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The policy a caller who supplied none gets.
 *
 * It is not `safePolicy`: the policies live in `core/policy.ts` since M1a-5 and
 * the dependency runs core → protocol, never back. Refusing everything is the
 * right shape for the gap anyway — a client with no decider attached should be
 * the contained one, and every real caller passes a policy.
 */
const DENY_ALL: Policy = () => false;

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
 *
 * Exported at M1a-6: `core/events.ts` is the first consumer that needs the
 * type by name. Since M1a-7 `render.ts` names it too. `fanout.mjs` still
 * cannot import a type — it is `.mjs` until M1b-8 retires it — but it imports
 * the bus itself, which carries it.
 */
export interface AgentEventEnvelope {
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
  /** Deadline for handshake and session-management calls. Never applied to
   * `session/prompt`. Defaults to 30s. */
  requestTimeoutMs?: number;
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
 * Ported from `acp.mjs` (M1a-3), then grown one behaviour at a time. Landed so
 * far: the per-request timeout (#62 B1), the in-flight prompt guard (#62 R5),
 * the whole `PromptResponse` (#62 B3), the cancel-intent event (#62 R4) and
 * stderr capture on death. Nothing from the story is outstanding.
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
  requestTimeoutMs: number;
  sessionId: SessionId | null;
  agentInfo: Implementation | null;
  agentCapabilities: AgentCapabilities | null;

  #proc: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #pending = new Map<number | string, PendingRequest>();
  // Keyed by the id exactly as it arrives. `ToolCallId | undefined` rather
  // than `ToolCallId` because `toolCallId` is a cast off the wire, never
  // validated: a tool_call notification that omits it stores under `undefined`,
  // and the lookup in #requestPermission has to be able to miss in the same
  // way the pre-port code did.
  #toolCalls = new Map<ToolCallId | undefined, RememberedToolCall>();
  #closed = false;
  #promptInFlight = false;
  #stderr: string[] = [];

  constructor({
    name,
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    policy = DENY_ALL,
    onEvent = () => {},
    allowReadOutsideRoot = false,
    verbose = false,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
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
    this.requestTimeoutMs = requestTimeoutMs;
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

    // A harness that dies at spawn leaves its stdin a broken pipe, and the
    // write reports that **asynchronously** as an `error` event on the socket.
    // Node throws an unhandled `error` event, so without this listener a
    // harness that could not start takes the whole supervisor down with it —
    // every other task in the run included. `#send`'s try/catch cannot help:
    // the write returns normally and fails a tick later.
    //
    // Swallowed rather than propagated, because the reason is already covered:
    // `close` above fails every pending request with the real exit message and
    // the harness's own stderr, which is what the caller wants to read. Found
    // by CI on M1b-2 (#18) — a narrow race the local suite never lost.
    proc.stdin.on("error", (err: Error) => {
      if (this.verbose) {
        process.stderr.write(`[${this.name}:stdin] ${err.message}\n`);
      }
    });

    proc.on("close", (code: number | null) => {
      this.#closed = true;
      this.#failAll(new Error(this.#exitMessage(code)));
    });

    createInterface({ input: proc.stdout }).on("line", (line: string) => {
      this.#onLine(line);
    });

    // Retained unconditionally, not only under --verbose: when a harness dies
    // mid-handshake its own explanation is the only useful thing we have, and
    // #failAll would otherwise report a bare exit code. Measured 2026-08-31
    // (issue #11): every harness in the registry's configuration emits nothing
    // at all on stderr through a normal turn, so retaining it costs nothing.
    createInterface({ input: proc.stderr }).on("line", (line: string) => {
      this.#stderr.push(line);
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

  /**
   * Ask the harness to switch its own mode.
   *
   * The only surface M1 needs beyond M1a-2's typed subset, which is criterion
   * (1) recorded there for hand-extending rather than adopting the SDK's
   * generated types: one small addition, so the hand-written union and its
   * `assertNever` exhaustiveness stay (`docs/STORIES.md`, M1a-2, 2026-08-30).
   *
   * `modeId` is a harness-side id from the registry's `measured.modeMap`, not
   * one of ours — the vocabularies do not align, and copilot's ids are whole
   * URLs. The spec says the id must appear in `availableModes`; opencode
   * advertises none and honours the call anyway (§M0-1), so we do not check.
   * Who calls this, and in which modes, is `core/policy.ts`'s decision.
   */
  async setMode(modeId: SessionModeId): Promise<SetSessionModeResponse> {
    if (!this.sessionId)
      throw new Error("no session — call newSession() first");
    return this.request<SetSessionModeResponse>("session/set_mode", {
      sessionId: this.sessionId,
      modeId,
    });
  }

  /**
   * Send a prompt and resolve with the whole response once the turn ends.
   *
   * The entire `PromptResponse` is returned rather than just `stopReason`
   * (#62 B3). `usage` is the only per-task token count M0-5 found on all three
   * harnesses, and a count nobody recorded is not recoverable afterwards.
   * Capture only — M1 renders no token figure from it, because the field is
   * cumulative on copilot where it is per-turn on the other two, and M1a-4 is
   * where those semantics get written down.
   *
   * A second call while a turn is live throws rather than sending (#62 R5).
   * M0-4 measured why: all three harnesses accept a second `session/prompt`,
   * kill the running turn and answer `end_turn`; on opencode and copilot the
   * text lands in the running turn's context and reads as prompt injection,
   * and copilot aborts unconditionally even when idle
   * (github/copilot-cli#4555). The guard is checked before anything is
   * written, so a rejected second prompt puts no byte on the wire.
   */
  async prompt(text: string): Promise<PromptResponse> {
    if (!this.sessionId)
      throw new Error("no session — call newSession() first");
    if (this.#promptInFlight)
      throw new Error(
        `agent "${this.name}" is already running a turn; a second prompt() would kill it`,
      );

    this.#promptInFlight = true;
    try {
      return await this.request<PromptResponse>("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
    } finally {
      // Cleared on every exit, so a failed or cancelled turn does not wedge
      // the agent into refusing all later prompts.
      this.#promptInFlight = false;
    }
  }

  /**
   * Ask the agent to end the current turn.
   *
   * Emits `_client_cancel_requested` on the bus at the moment the notification
   * goes out (#62 R4). M1b-2's status keys on the triple (`stopReason`, did we
   * cancel, did the watchdog fire) because copilot answers `end_turn` for a
   * turn it cancelled — so our own record of having asked is the authoritative
   * term, and it has to be recorded here, where the asking happens.
   *
   * A cancel racing with or following the harness's death records nothing:
   * `#send` would silently drop the notification, and an authoritative record
   * of a cancel that never reached the harness is exactly the false entry
   * M1b-2 must not see.
   */
  cancel(): void {
    if (!this.sessionId || this.#closed) return;
    const sessionId = this.sessionId;
    this.notify("session/cancel", { sessionId });
    this.onEvent({
      agent: this.name,
      update: { sessionUpdate: "_client_cancel_requested", sessionId },
    });
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
      const budget = TIMED_METHODS.has(method) ? this.requestTimeoutMs : 0;
      let timer: NodeJS.Timeout | null = null;
      const disarm = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };

      this.#pending.set(id, {
        resolve: (value) => {
          disarm();
          resolve_(value as R);
        },
        reject: (reason) => {
          disarm();
          reject(reason);
        },
      });

      if (budget > 0) {
        timer = setTimeout(() => {
          // Drop the entry first: a late reply must be ignored rather than
          // resolve a promise this timer already rejected.
          if (this.#pending.delete(id)) {
            reject(
              new Error(
                `agent "${this.name}" did not answer "${method}" within ${budget}ms`,
              ),
            );
          }
        }, budget);
        // A pending deadline must not by itself keep the process alive.
        timer.unref();
      }

      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        // Rejects this promise. Clear the entry and the armed timer too,
        // rather than leaving both behind as the pre-port code did.
        disarm();
        this.#pending.delete(id);
        throw err;
      }
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
  // the decode point M1a-2 chose instead of a runtime validator. The
  // suppression sits on the parameter itself, which is where the rule reports.
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
    const known = this.#toolCalls.get(toolCall?.toolCallId) ?? {};
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
        optionId: optionId ?? undefined,
      },
    });

    // `cancelled` is the spec's turn-cancelled reply and it does not name this
    // case, so it is the fallback, never the first choice. Measured against
    // claude 0.49.0 and copilot 1.0.80: no file written, no protocol error, a
    // clean `end_turn`.
    if (optionId === null) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId } };
  }

  /**
   * What the death of the subprocess should say.
   *
   * The whole retained stderr is attached, deliberately unbounded (decided
   * 2026-08-31 on the measurement in issue #11): a normal turn produces zero
   * stderr bytes on every harness we ship, and the two reproducible
   * mid-handshake deaths produced 22 and 3 lines. Trimming this to a
   * head/tail window is on the backlog, not a live concern.
   *
   * Nothing here prefers the tail, because the measurement put the actionable
   * line near the *head* on both harnesses that die — node's MODULE_NOT_FOUND
   * banner leaves it 17 lines from the end.
   */
  #exitMessage(code: number | null): string {
    const base = `agent "${this.name}" exited with code ${code}`;
    if (this.#stderr.length === 0) return base;
    const captured = this.#stderr
      .map((line) => `  [stderr] ${line}`)
      .join("\n");
    return `${base}\n${captured}`;
  }

  #failAll(err: Error): void {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  #log(m: string): void {
    if (this.verbose) process.stderr.write(`[${this.name}] ${m}\n`);
  }
}

/**
 * Choose an optionId matching our allow/reject decision, or `null`.
 *
 * `null` means the harness offered nothing that says what we decided. The
 * pre-M1a-5 tail returned `options[0]` there, which fails open: measured
 * 2026-09-02 (issue #13), claude orders its list `allow_always` first, so a
 * *denial* with no reject option would have selected "Always Allow all Write"
 * — a persisted grant. Every list the three harnesses actually send carries
 * `reject_once`, so the tail never fired; nothing in the protocol promises
 * that, and the failure would have been invisible because the denial is still
 * what `_client_permission` records.
 */
function pickOption(
  options: PermissionOption[] = [],
  allow: boolean,
): PermissionOptionId | null {
  const want: PermissionOption["kind"][] = allow
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  for (const kind of want) {
    const hit = options.find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  return null;
}
