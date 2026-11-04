import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import type {
  AgentCapabilities,
  AgentEvent,
  Implementation,
  InitializeResponse,
  JsonRpcError,
  LoadSessionResponse,
  McpServer,
  NewSessionResponse,
  PermissionOption,
  PermissionOptionId,
  PromptResponse,
  ReadTextFileResponse,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionId,
  SessionModeId,
  SessionUpdate,
  SetSessionConfigOptionResponse,
  SetSessionModeResponse,
  ToolCallContent,
  ToolCallId,
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
  "session/delete",
  "session/set_mode",
  "session/set_config_option",
]);

// M0-1 measured the slowest handshake step at 3.0s (copilot's session/new),
// so this is an order of magnitude above the worst observed.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// M2-4 measured every harness exiting within 1 s of stdin closing, mid shell
// command included (`docs/FINDINGS.md` §M2-4), so this is a safety net.
const DEFAULT_STOP_GRACE_MS = 5_000;

// How long a harness's stdio has to drain after the process exits before we
// close our ends ourselves. `close` waits on those streams, and a grandchild
// that inherited them can hold them open forever (M2-4, #34).
const STDIO_DRAIN_MS = 250;

/**
 * The longest stdout line this client will parse (M1b-6, issue #22).
 *
 * Counted in UTF-16 units rather than bytes — for JSON-RPC's ASCII-heavy
 * payloads the two are within a rounding error, and `Buffer.byteLength` on
 * every line of every turn is a cost paid for nothing. 32 MiB is far above any
 * real payload: the largest thing that legitimately crosses this wire is a
 * file's contents in an `fs/read_text_file` reply, which the harness asked for.
 *
 * ponytail: `readline` has already buffered the whole line by the time we see
 * it, so this refuses the payload rather than bounding the memory that held
 * it. A real bound means a manual chunk scanner over stdout in place of
 * `createInterface`; upgrade to one if this ever fires against a live harness.
 */
const MAX_LINE_LENGTH = 32 * 1024 * 1024;

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
  /** The files the call would write, inside the root (M4-6). */
  edits?: PolicyEdit[];
}

/**
 * One file a tool call would write, named after `#guardPath` (M4-6), so a
 * path outside the root never gets here. `core/` turns it into a diff for a
 * person; the policy never reads it.
 */
export interface PolicyEdit {
  /** The absolute path. */
  abs: string;
  /** The path from the root, as the diff names it. */
  path: string;
  /** The text before: `null` for a new file, absent to read it from disk. */
  oldText?: string | null;
  newText: string;
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
 * type by name. Since M1a-7 `render.ts` names it too.
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
  /** Where to mirror the harness's stderr, line by line, for the life of the
   * subprocess (M1b-7). Opened on `start()` whether or not the harness ever
   * writes: an empty log means it said nothing, a missing one means the task
   * never got this far. The caller owns the directory. */
  stderrLog?: string;
  /** Deadline for handshake and session-management calls. Never applied to
   * `session/prompt`. Defaults to 30s. */
  requestTimeoutMs?: number;
  /** How long `stop()` waits after closing stdin before SIGKILL. Defaults to 5s. */
  stopGraceMs?: number;
  /** Gets the `kind` of each `_auth/status_update` (M9-4): claude's login
   *  signal, `"none"` when logged out. Only the kind: the notice also holds
   *  the e-mail and the organisation, and they never leave this class. */
  onAuthStatus?: (kind: string) => void;
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
 * What we retain per `toolCallId`: only what `#requestPermission` reads, and
 * the status that says when the heavy part can go (#163). The entries are
 * never removed, and a title is kept whole, so a room still holds one small
 * entry per call for its life. That is the end state #163 chose.
 */
interface RememberedToolCall {
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  // As in PolicyToolCall above — the protocol's own shape for raw tool input.
  // pi-lens-ignore: no-unsafe-dictionary-unknown
  rawInput?: Record<string, unknown>;
}

/**
 * A call without its input and content (#163). A room keeps one session for
 * its whole life, so a full entry per call would hold every edit's text until
 * the room ends. A late ask for the call is still judged on its title and kind,
 * but it shows no diff, and its write asks again through `#guardWrite`.
 * A field added to `RememberedToolCall` is dropped here unless it is listed:
 * list it if a late ask needs it and it is small.
 */
function settled({ title, kind, status }: RememberedToolCall) {
  return { title, kind, status };
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

/** The harness answered a request with a JSON-RPC error. `code` tells a
 *  caller what it was: `-32000` on `session/new` is "log in first" (M9-4). */
export class RpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(`${message} (code ${code})`);
    this.code = code;
  }
}

/**
 * A single ACP agent subprocess.
 *
 * We are the CLIENT. We spawn the agent, own the workspace, answer its
 * requests for file access, and decide its permissions.
 *
 * It handles exactly three inbound requests — `fs/read_text_file`,
 * `fs/write_text_file` and `session/request_permission` — and two
 * notifications: `session/update`, which it forwards to `onEvent`, and
 * claude's `_auth/status_update`, whose kind alone goes to `onAuthStatus`
 * (M9-4). That one is not a `_client_*` event and never reaches a log.
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
  stderrLog: string | null;
  requestTimeoutMs: number;
  stopGraceMs: number;
  sessionId: SessionId | null;
  agentInfo: Implementation | null;
  agentCapabilities: AgentCapabilities | null;
  onAuthStatus: (kind: string) => void;
  /** The `configOptions` of the last `session/new` or `session/load`, where
   *  the models are (M9-4). Empty until then, after a delete, and when the
   *  harness sent none. */
  configOptions: SessionConfigOption[] = [];

  #proc: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #pending = new Map<number | string, PendingRequest>();
  // Keyed by the id exactly as it arrives. `ToolCallId | undefined` rather
  // than `ToolCallId` because `toolCallId` is a cast off the wire, never
  // validated: a tool_call notification that omits it stores under `undefined`,
  // and the lookup in #requestPermission has to be able to miss in the same
  // way the pre-port code did.
  #toolCalls = new Map<ToolCallId | undefined, RememberedToolCall>();
  // Direct `fs/write_text_file` paths the client has already been asked about
  // through `session/request_permission`. A write that follows an approved
  // permission for the same path is the second half of that one decision, not a
  // new mutation to judge; a write with no entry is the hostile case and goes
  // through `#guardWrite`. Keyed by the resolved absolute path so a later write
  // to a different file still asks.
  //
  // An approval covers **one** write and is consumed by it. There is no
  // standing grant here even when the harness's menu was `allow_always`:
  // `pickOption` prefers `allow_once` and reaches `allow_always` only when the
  // harness offered nothing narrower, so an "always" entry would be a session
  // -long grant for a path nobody chose to grant that way. A denial is the one
  // sticky entry, so a harness that writes after being refused is refused
  // again without re-asking.
  //
  // An approval is bound to the text the person saw (#310). A request with
  // edits approves only the files its edits name, each with a sha256 of its
  // `newText`; a write with other bytes is a new decision and goes through
  // `#guardWrite`, so the person is asked about the bytes that will land.
  // `rawInput.path` grants only when the request carries no diff or file_text,
  // even when the path guard dropped every edit. That grant has no hash: the
  // person was shown no text, so the one write may hold any bytes (decided
  // 2026-11-04, one question per edit). A denial covers every path the request
  // names.
  #writeDecisions = new Map<string, "denied" | { sha256?: string }>();
  #closed = false;
  /** True while `session/load` is in flight: its updates are the replay. */
  #replaying = false;
  /** A load that failed. A harness can still replay it after the deadline,
   *  so its updates are dropped too. */
  #failedLoad: SessionId | null = null;
  #promptInFlight = false;
  #stderr: string[] = [];
  #stderrFile: WriteStream | null = null;
  #killTimer: NodeJS.Timeout | null = null;
  /** Closes our stdio ends once the process is gone but a pipe-holder lives. */
  #drainTimer: NodeJS.Timeout | null = null;
  /** Settles when the subprocess has closed; `stop()` hands it out. */
  #exited: Promise<void> = Promise.resolve();

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
    stderrLog,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    onAuthStatus = () => {},
  }: AcpAgentOptions) {
    this.onAuthStatus = onAuthStatus;
    this.name = name ?? command;
    this.command = command;
    this.args = args;
    this.cwd = resolve(cwd);
    this.env = env;
    this.policy = policy;
    this.onEvent = onEvent;
    this.allowReadOutsideRoot = allowReadOutsideRoot;
    this.verbose = verbose;
    this.stderrLog = stderrLog ?? null;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stopGraceMs = stopGraceMs;
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
    this.#exited = new Promise((ok) => proc.once("close", () => ok()));

    proc.on("error", (err: Error) => {
      // M1b-7: the rejection message is enough while a terminal is watching,
      // but the durable log is the daemon's only copy. The stream is assigned
      // below before this event can fire; `close` (which follows a failed
      // spawn on Node >=24) remains the place that ends it.
      const message = `failed to spawn "${this.command}": ${err.message}`;
      this.#stderr.push(message);
      this.#stderrFile?.write(`${message}\n`);
      this.#failAll(new Error(message));
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

    // M2-4: a pid the daemon can record, so a harness that outlives a crash
    // can be found again (M2-5). `undefined` means the spawn failed.
    const { pid } = proc;
    if (pid !== undefined) {
      this.onEvent({
        agent: this.name,
        update: { sessionUpdate: "_client_harness_spawned", pid },
      });
    }

    proc.on("close", (code: number | null) => {
      this.#closed = true;
      if (this.#killTimer) clearTimeout(this.#killTimer);
      if (this.#drainTimer) clearTimeout(this.#drainTimer);
      if (pid !== undefined) {
        this.onEvent({
          agent: this.name,
          update: { sessionUpdate: "_client_harness_exited", pid },
        });
      }
      this.#stderrFile?.end();
      this.#stderrFile = null;
      this.#failAll(new Error(this.#exitMessage(code)));
    });

    // `close` waits for the child's stdio streams, not just its exit, and a
    // harness that leaked a grandchild holding them open never produces one.
    // Once the process is gone, drain what it left, then close our ends so
    // `close` — and every cleanup that rides on it — still arrives: a stopped
    // harness must never leave `stop()` pending (M2-4, #34).
    proc.on("exit", () => {
      this.#drainTimer = setTimeout(() => {
        proc.stdin.destroy();
        proc.stdout.destroy();
        proc.stderr.destroy();
      }, STDIO_DRAIN_MS);
    });

    createInterface({ input: proc.stdout }).on("line", (line: string) => {
      this.#onLine(line);
    });

    // Retained unconditionally, not only under --verbose: when a harness dies
    // mid-handshake its own explanation is the only useful thing we have, and
    // #failAll would otherwise report a bare exit code. Measured 2026-08-31
    // (issue #11): every harness in the registry's configuration emits nothing
    // at all on stderr through a normal turn, so retaining it costs nothing.
    //
    // The file is the durable half of the same record (M1b-7): the retention
    // above dies with the process, and under a daemon nobody is reading a
    // terminal. Opened here rather than on the first line so that a harness
    // that said nothing still leaves a log.
    if (this.stderrLog !== null) {
      // `ax`, so one (runId, taskId) is written exactly once. Plain `a` mixes
      // two executions into one file and breaks the "empty means the harness
      // said nothing" reading above; `w` would silently destroy the earlier
      // run's only durable record, which is the worse half of the trade. The
      // EEXIST arrives on the handler below, so a re-run says so and keeps
      // what is already there.
      const file = createWriteStream(this.stderrLog, { flags: "ax" });
      // Unconditional, not `#log`: a log we cannot write is exactly the case
      // the operator has no other way to notice. It never fails the task —
      // the run is what matters, the log is how it is read afterwards.
      file.on("error", (err: Error) => {
        this.#stderrFile = null;
        process.stderr.write(
          `[${this.name}] stderr log ${this.stderrLog}: ${err.message}\n`,
        );
      });
      this.#stderrFile = file;
    }

    createInterface({ input: proc.stderr }).on("line", (line: string) => {
      this.#stderr.push(line);
      this.#stderrFile?.write(`${line}\n`);
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
        name: "kapelle",
        title: "Kapelle",
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
    this.configOptions = Array.isArray(res.configOptions)
      ? res.configOptions
      : [];
    return this.sessionId;
  }

  /** Removes the session from the harness's own history (M9-4), and
   *  forgets it here, so nothing more is sent to it. Only when
   *  `agentCapabilities.sessionCapabilities.delete` is set: copilot has no
   *  such method. */
  async deleteSession(): Promise<void> {
    if (!this.sessionId)
      throw new Error("no session — call newSession() first");
    await this.request("session/delete", { sessionId: this.sessionId });
    this.sessionId = null;
    this.configOptions = [];
  }

  /**
   * Load an earlier session into this process (M6-7b). The harness replays
   * the old conversation as ordinary `session/update` before it answers
   * (§M0-9). The caller already has that history, so the replay is dropped
   * here and never reaches `onEvent`. Whether to load at all is the caller's
   * call: `agentCapabilities.loadSession` is a claim, not a measurement.
   */
  async loadSession(
    sessionId: SessionId,
    { mcpServers = [] }: { mcpServers?: McpServer[] } = {},
  ): Promise<SessionId> {
    this.#replaying = true;
    let res: LoadSessionResponse;
    try {
      res = await this.request<LoadSessionResponse>("session/load", {
        sessionId,
        cwd: this.cwd,
        mcpServers,
      });
    } catch (err) {
      this.#failedLoad = sessionId;
      throw err;
    } finally {
      this.#replaying = false;
    }
    this.sessionId = sessionId;
    this.configOptions = Array.isArray(res?.configOptions)
      ? res.configOptions
      : [];
    return sessionId;
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
   * Set one of the session's options, such as the model (M9-5). `configId`
   * is the option's `id` from `configOptions`. A value the harness refuses
   * is a throw: pi and claude answer only `Internal error` (§Models and
   * login), so the caller words the message. `configOptions` here stays as
   * the session sent it: the reply may leave an option out.
   */
  async setConfigOption(
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    if (!this.sessionId)
      throw new Error("no session — call newSession() first");
    return this.request<SetSessionConfigOptionResponse>(
      "session/set_config_option",
      { sessionId: this.sessionId, configId, value },
    );
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
      // A cancelled turn leaves its calls `pending` for ever, so a turn's end
      // settles every call too (#163). Only the live ones: the rest already are.
      for (const [id, call] of this.#toolCalls) {
        if (call.rawInput === undefined && call.content === undefined) continue;
        this.#toolCalls.set(id, settled(call));
      }
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

  /**
   * Closes stdin, and SIGKILLs the harness only if it is still alive after
   * `stopGraceMs` (M2-4, #34).
   *
   * **Stdin first, never a signal first.** Every harness runs its shell
   * commands in a session of their own, so no kill from here reaches them;
   * only the harness's own shutdown does, and end of file is what starts it.
   * Measured 2026-09-15: SIGTERM left opencode's running command alive, and
   * SIGKILL left opencode's and copilot's; closing stdin left none on all four.
   * It is a convention, not an ACP guarantee, hence the SIGKILL behind it.
   * The same end of file is what a daemon crash delivers.
   *
   * Resolves once the subprocess is gone, so a caller that awaits it knows
   * the harness is not still writing to the workspace. Its stdio is given
   * `STDIO_DRAIN_MS` to drain after exit; a leaked grandchild holding the
   * pipes only delays this by that much, so it can never hang a stop.
   */
  stop(): Promise<void> {
    const proc = this.#proc;
    if (proc && !this.#closed && !this.#killTimer) {
      proc.stdin.end();
      this.#killTimer = setTimeout(
        () => proc.kill("SIGKILL"),
        this.stopGraceMs,
      );
    }
    return this.#exited;
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
    // Before `trim`, which would copy the whole thing. Unconditional, not
    // `#log`: a refusal is exactly the event a run must not be silent about,
    // and a harness that reaches this length is not having a normal turn.
    if (raw.length > MAX_LINE_LENGTH) {
      process.stderr.write(
        `[${this.name}] oversized stdout line dropped: ${raw.length} chars (max ${MAX_LINE_LENGTH})\n`,
      );
      return;
    }

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
      entry.reject(new RpcError(msg.error.message, msg.error.code));
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
    if (msg.method === "_auth/status_update") {
      // claude's login signal (§Models and login). Only the kind goes on: the
      // rest names the account.
      const kind: unknown = (
        msg.params as { authStatus?: { kind?: unknown } } | undefined
      )?.authStatus?.kind;
      // pi-lens-ignore: no-runtime-typeof
      if (typeof kind === "string") this.onAuthStatus(kind);
      return;
    }
    if (msg.method !== "session/update") return;
    const params = msg.params as
      | { sessionId?: SessionId; update?: SessionUpdate }
      | undefined;
    const update = params?.update;
    if (!update || this.#replaying) return;
    // A string only: an unchecked `null` on the wire would match "no
    // failed load" and drop every update. Never the live session's, even
    // when a harness gives the failed id out again (#238).
    const sid = params?.sessionId;
    if (
      typeof sid === "string" &&
      sid === this.#failedLoad &&
      sid !== this.sessionId
    )
      return;
    // Only this client makes a `_client_` event. One from the harness is a
    // forgery: the daemon, the room and the screens would trust it (#357).
    // The kind is unchecked on the wire. A kind that is not a string is
    // malformed, so it is dropped too, and only a string reaches `startsWith`.
    // The log line is `#log`, not unconditional like the oversized line: the
    // harness picks how often it forges, so it could flood the daemon's
    // stderr. It shows 80 characters at most, and `JSON.stringify` keeps
    // escape sequences off the terminal.
    const kind: unknown = update.sessionUpdate;
    // pi-lens-ignore: no-runtime-typeof
    if (typeof kind !== "string") return;
    if (kind.startsWith("_client_")) {
      this.#log(`dropped a forged ${JSON.stringify(kind.slice(0, 80))} update`);
      return;
    }

    // Permission requests only carry a toolCallId, so remember the details
    // announced here — otherwise the policy has nothing to judge. An update
    // changes only the fields it carries. A finished call keeps no input: a
    // call can announce itself already `completed`, so both kinds check.
    if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const prev: RememberedToolCall =
        update.sessionUpdate === "tool_call"
          ? { kind: "other" }
          : (this.#toolCalls.get(update.toolCallId) ?? {});
      const call: RememberedToolCall = {
        title: update.title ?? prev.title,
        kind: update.kind ?? prev.kind,
        status: update.status ?? prev.status,
        rawInput: update.rawInput ?? prev.rawInput,
        content: update.content ?? prev.content,
      };
      // A call cannot be live outside a turn, so a late update keeps no input
      // either (§Question 3 measured none on three harnesses; this holds on all).
      const done =
        !this.#promptInFlight ||
        call.status === "completed" ||
        call.status === "failed";
      this.#toolCalls.set(update.toolCallId, done ? settled(call) : call);
    }

    this.onEvent({ agent: this.name, update });
  }

  // ---------- client-side capabilities ----------

  /**
   * The absolute path to use, or a throw naming the root it left.
   *
   * The prefix check is on **realpaths** (M1b-6, issue #22). `resolve` is
   * string arithmetic and never touches the filesystem, so before this a
   * symlink sitting inside the root and pointing outside it read as in-root
   * and was followed — the hole `protocol/tests/agent.test.ts` recorded as a
   * documented gap rather than a pass.
   *
   * What is returned is still the resolved-but-not-realpathed path, so a write
   * lands where the harness asked and `_client_wrote_file` reports that name.
   * Following the link at write time is safe because it is the same link this
   * check just resolved.
   */
  async #guardPath(p: string, { write }: { write: boolean }): Promise<string> {
    const abs = resolve(this.cwd, p);
    const root = await realPathOrNearest(this.cwd);
    const real = await realPathOrNearest(abs);
    const inRoot = real === root || real.startsWith(root + sep);
    if (!inRoot && (write || !this.allowReadOutsideRoot)) {
      throw new Error(
        `path outside workspace root refused: ${real} (root: ${root})`,
      );
    }
    return abs;
  }

  async #readTextFile({
    path,
    line,
    limit,
  }: ReadTextFileParams): Promise<ReadTextFileResponse> {
    const abs = await this.#guardPath(path, { write: false });
    let content = await readFile(abs, "utf8");
    if (line != null || limit != null) {
      const lines = content.split("\n");
      const start = Math.max(0, (line ?? 1) - 1);
      const end = limit == null ? lines.length : start + limit;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }

  /**
   * Announce that a decision is about to be taken (M1c-4, issue #28).
   *
   * Before the await, never after: `_client_permission` records what was
   * decided, and by then any human who was going to be blocked has already
   * been blocked. The attention signal has to leave the process while the
   * prompt is still on screen.
   *
   * This fires in every mode. `AcpAgent` does not know the resolved mode —
   * it holds a `Policy`, not a `ClientMode` — and teaching it one to filter
   * here would put a run-layer concept in the protocol layer. The consumer
   * filters instead: `core/notify.ts` is only armed for `ask`.
   */
  #emitPending(toolCall: PolicyToolCall): void {
    this.onEvent({
      agent: this.name,
      update: {
        sessionUpdate: "_client_permission_pending",
        title: toolCall.title,
        kind: toolCall.kind,
      },
    });
  }

  /**
   * Put a write with no prior `session/request_permission` decision through the
   * same policy as a tool call the harness asks about (M1b-6, issue #22).
   *
   * Without this, `safe` refuses the *request* to edit and then performs the
   * edit for any harness that skips the request and calls the file service
   * directly — which is the whole of "mutation without asking". This is the
   * only mutation the client can see on the wire, so it is the only one it can
   * refuse; a harness editing through its own shell stays outside the policy's
   * jurisdiction and is inferred afterwards by `policyNeverFired`.
   *
   * A write that follows an approved `session/request_permission` for the same
   * path is not a new decision and is handled by `#writeDecisions` instead,
   * unless its bytes differ from the approved text (#310).
   *
   * `kind: "edit"` is the honest label, and it is what makes `safePolicy`
   * refuse: `READ_ONLY_KINDS` does not contain it. `options` is empty because
   * nothing offered any — this is our own decision point, not a reply to a
   * `session/request_permission`, so there is no option id to pick.
   */
  async #guardWrite(abs: string, content: string): Promise<void> {
    const toolCall: PolicyToolCall = {
      title: `fs/write_text_file ${abs}`,
      kind: "edit",
      rawInput: { path: abs },
      edits: [{ abs, path: relative(this.cwd, abs), newText: content }],
    };
    this.#emitPending(toolCall);
    const allow = await this.policy({
      agent: this.name,
      toolCall,
      options: [],
    });

    this.onEvent({
      agent: this.name,
      update: {
        sessionUpdate: "_client_permission",
        allow,
        title: toolCall.title,
        kind: toolCall.kind,
      },
    });

    if (!allow) throw new Error(`write refused by policy: ${abs}`);
  }

  async #writeTextFile({
    path,
    content,
  }: WriteTextFileParams): Promise<WriteTextFileResponse> {
    const abs = await this.#guardPath(path, { write: true });
    const decision = this.#writeDecisions.get(abs);
    if (decision === "denied") {
      throw new Error(`write refused by policy: ${abs}`);
    }
    if (decision === undefined) {
      await this.#guardWrite(abs, content);
    } else {
      // One approved write, not a standing grant. Consume it before attempting
      // the write so a later retry must ask again.
      this.#writeDecisions.delete(abs);
      if (decision.sha256 !== undefined && decision.sha256 !== sha256(content))
        await this.#guardWrite(abs, content);
    }
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

  /**
   * The files a tool call would write (M4-6): its `diff` blocks, when the
   * harness sent them before the ask; else copilot's `rawInput` with `path`
   * and `file_text`. A path the guard refuses is left out, so a question
   * about a file outside the root shows no diff.
   */
  async #editsOf(
    content: ToolCallContent[] | undefined | null,
    // As in PolicyToolCall: arbitrary agent-supplied JSON.
    // pi-lens-ignore: no-unsafe-dictionary-unknown
    rawInput: Record<string, unknown> | undefined,
  ): Promise<{ edits: PolicyEdit[]; hasEditContent: boolean }> {
    const wanted: { path: string; oldText?: string | null; newText: string }[] =
      [];
    let hasEditContent = false;
    for (const c of content ?? []) {
      if (c?.type !== "diff") continue;
      // A diff that the guard later drops still counts as edit content. Falling
      // back to a rawInput path grant would approve bytes the person never saw.
      hasEditContent = true;
      // Off the wire, unchecked: a block may lack its strings.
      // pi-lens-ignore: no-runtime-typeof
      if (typeof c.path !== "string") continue;
      // pi-lens-ignore: no-runtime-typeof
      if (typeof c.newText !== "string") continue;
      // No `oldText` is a new file (ACP). One that is not text is read from
      // disk instead, so a bad field costs the old side, not the whole diff.
      const old: unknown = c.oldText;
      wanted.push({
        path: c.path,
        // pi-lens-ignore: no-runtime-typeof
        oldText: old == null ? null : typeof old === "string" ? old : undefined,
        newText: c.newText,
      });
    }
    const path = rawInput?.path;
    const text = rawInput?.file_text;
    if (text !== undefined) hasEditContent = true;
    // pi-lens-ignore: no-runtime-typeof
    if (
      !wanted.length &&
      typeof path === "string" &&
      typeof text === "string"
    ) {
      wanted.push({ path, newText: text });
    }
    const edits: PolicyEdit[] = [];
    for (const w of wanted) {
      try {
        const abs = await this.#guardPath(w.path, { write: true });
        edits.push({ ...w, abs, path: relative(this.cwd, abs) });
      } catch {
        // Outside the root: no diff. The write itself is refused later.
      }
    }
    return { edits, hasEditContent };
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
    const { edits, hasEditContent } = await this.#editsOf(
      toolCall?.content ?? known.content,
      detail.rawInput,
    );
    if (edits.length > 0) detail.edits = edits;

    this.#emitPending(detail);
    const allow = await this.policy({
      agent: this.name,
      toolCall: detail,
      options,
    });
    const optionId = pickOption(options, allow);

    // Remember what this edit decision covers. The follow-up `fs/write_text_file`
    // that a well-behaved harness sends after an approved permission request is
    // not a second, unasked mutation: it is the same logical write, so it should
    // not re-enter the policy. What each entry covers is on `#writeDecisions`;
    // a direct write to a path not named here still goes through `#guardWrite`.
    if (detail.kind === "edit") {
      // `rawInput` is arbitrary agent-supplied JSON, so the only safe way to
      // learn whether it names a file is a runtime check at this decode point.
      const rawPath = detail.rawInput?.path;
      const rawAbs =
        // pi-lens-ignore: no-runtime-typeof
        typeof rawPath === "string" ? resolve(this.cwd, rawPath) : null;
      if (optionId === null || !allow) {
        for (const e of edits) this.#writeDecisions.set(e.abs, "denied");
        if (rawAbs !== null) this.#writeDecisions.set(rawAbs, "denied");
      } else if (edits.length > 0) {
        for (const e of edits)
          this.#writeDecisions.set(e.abs, { sha256: sha256(e.newText) });
      } else if (rawAbs !== null && !hasEditContent) {
        this.#writeDecisions.set(rawAbs, {});
      }
    }

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
 * The real path of `p`, following symlinks as far as the filesystem goes.
 *
 * `realpath` throws on a path that does not exist, which every write to a new
 * file is, so a plain missing tail is resolved against the nearest ancestor
 * that does exist and re-appended. An unresolved symlink is refused instead:
 * rejoining its name would hide its target from the guard, and a later write
 * would follow it (#309). Links that resolve normally return above. The
 * blanket refusal is intentional: it includes in-root targets and cycles,
 * without growing a second resolver for links no caller needs to follow.
 */
async function realPathOrNearest(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    let isSymlink = false;
    try {
      const stats = await lstat(p);
      isSymlink = stats.isSymbolicLink();
    } catch {
      // A plain missing tail is resolved through its parent below.
    }
    if (isSymlink) throw new Error(`unresolved symlink refused: ${p}`);
    return join(await realPathOrNearest(parent), basename(p));
  }
}

/** The hash an approved write's text is kept as (#310): small, unlike the text. */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
