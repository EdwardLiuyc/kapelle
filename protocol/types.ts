/**
 * Hand-written protocol types for the subset of ACP (Agent Client Protocol)
 * this client touches — stories M1a-2.
 *
 * Sources, in priority order:
 *  1. What `acp.mjs` / `render.mjs` / `mock-agent.mjs` already do (the porting
 *     target — M1a-3/M1a-7 type against this file).
 *  2. What the harnesses actually sent on the wire during M0
 *     (`docs/FINDINGS.md`).
 *  3. The official schema
 *     (https://github.com/agentclientprotocol/agent-client-protocol,
 *     schema.json, v1, fetched 2026-08-30) for field lists of variants no
 *     harness has been observed to send.
 *
 * Conventions, decided on issue #10:
 *  - `_meta` sits on the base of every message type, both directions (#62 B4).
 *  - The `SessionUpdate` union is strict: no catch-all variant. Unknown wire
 *    values simply fall through the consumer's `default:`; adding a variant is
 *    a conscious edit that `tsc` then enforces at every unhandled switch.
 *  - Wire field names are camelCase exactly as observed in M0 captures.
 *  - Variants/fields no harness has been observed to send are marked
 *    "not observed in M0" so a reader knows the shape is schema-trusted, not
 *    wire-proven.
 *  - `Record<string, unknown>` is the deliberate contract for free-form wire
 *    fields; each site carries `// pi-lens-ignore: no-unsafe-dictionary-unknown`.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** The spec's extension channel — free-form, no assumptions about values. */
// pi-lens-ignore: no-unsafe-dictionary-unknown
export type Meta = { _meta?: Record<string, unknown> };

export type SessionId = string;
export type ToolCallId = string;
export type MessageId = string;
export type SessionModeId = string;
export type PermissionOptionId = string;
export type TerminalId = string;
/** Wire protocol version; the client hard-fails on mismatch (`protocol/agent.ts`). */
export type ProtocolVersion = number;

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

/** A request we send, or one the agent sends us (it answers by `id`). */
export interface JsonRpcRequest<P = unknown> extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: P;
}

/** One-way message; the agent's `session/update` stream arrives like this. */
export interface JsonRpcNotification<P = unknown> extends Meta {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

/** Success answer to a request, ours or the agent's. JSON-RPC 2.0 requires
 *  `result` on success (and forbids it on errors, see JsonRpcErrorResponse);
 *  `null` is a valid result value — fs/write_text_file's success is exactly
 *  that, so `R` must stay nullable-friendly. */
export interface JsonRpcResponse<R = unknown> extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  result: R;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Failure answer to a request (`-32602` mode not found, etc. — M0-1). */
export interface JsonRpcErrorResponse extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  error: JsonRpcError;
}

// ---------------------------------------------------------------------------
// Content blocks — appear in prompts we send and chunks we receive
// ---------------------------------------------------------------------------

/** Text is the only block this client renders today (`render.ts`). */
export interface TextContent extends Meta {
  type: "text";
  text: string;
}

/**
 * Named stubs — typed so the union is honest about what can arrive, but only
 * their required fields. Extend when a consumer first touches them (M0 never
 * saw them on the wire).
 */
export interface ImageContent extends Meta {
  type: "image";
  data: string;
  mimeType: string;
}

export interface AudioContent extends Meta {
  type: "audio";
  data: string;
  mimeType: string;
}

export interface ResourceLink extends Meta {
  type: "resource_link";
  name: string;
  uri: string;
}

export interface EmbeddedResource extends Meta {
  type: "resource";
  // Stub per decision 4 (issue #10): schema has TextResourceContents |
  // BlobResourceContents — type them when a consumer first touches this.
  // pi-lens-ignore: no-unsafe-dictionary-unknown
  resource: Record<string, unknown>;
}

/** Discriminated by `type`; MCP-compatible per the spec. */
export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;

/** Base of the three chunk variants. */
interface ContentChunk extends Meta {
  content: ContentBlock;
  /** Chunks of one message share an id; a change means a new message. */
  messageId?: MessageId;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

/** `READ_ONLY_KINDS` in `core/policy.ts` is the subset this client treats as safe. */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** File a tool call is about, announced *before* it happens. Typed per the
 *  story decision; never rendered until a probe shows a harness sends it. */
export interface ToolCallLocation extends Meta {
  path: string;
  line?: number;
}

/** Content produced by a tool call. `diff` is what `render.ts` prints. */
export interface ToolCallContentDiff extends Meta {
  type: "diff";
  path: string;
  oldText?: string;
  newText: string;
}

export interface ToolCallContentTerminal extends Meta {
  type: "terminal";
  terminalId: TerminalId;
}

export interface ToolCallContentBlock extends Meta {
  type: "content";
  content: ContentBlock;
}

export type ToolCallContent =
  | ToolCallContentBlock
  | ToolCallContentDiff
  | ToolCallContentTerminal;

/** A new tool call. `kind`/`status` are optional on the wire (the schema
 *  deserializes defaults); `protocol/agent.ts` already applies the `?? "other"` fallback. */
export interface ToolCall extends Meta {
  sessionUpdate: "tool_call";
  toolCallId: ToolCallId;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  // Free-form by protocol design — the schema constrains rawInput to "object"
  // with no properties, so there is no shape to narrow to.
  // pi-lens-ignore: no-unsafe-dictionary-unknown
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
}

/** Progress on an existing call — everything but `toolCallId` is optional,
 *  only changed fields travel. `protocol/agent.ts` merges these into its toolCall map. */
export interface ToolCallUpdate extends Meta {
  sessionUpdate: "tool_call_update";
  toolCallId: ToolCallId;
  kind?: ToolKind;
  status?: ToolCallStatus;
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  // Free-form by protocol design — see the note on ToolCall.rawInput.
  // pi-lens-ignore: no-unsafe-dictionary-unknown
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
}

// ---------------------------------------------------------------------------
// Plan, commands, modes, config
// ---------------------------------------------------------------------------

export type PlanEntryPriority = "high" | "medium" | "low";
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

export interface PlanEntry extends Meta {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}

/** Schema def `UnstructuredCommandInput`: the leaf of AvailableCommandInput —
 *  text typed after the command name. */
interface UnstructuredCommandInput extends Meta {
  /** Required per schema — "a hint to display when the input hasn't been
   *  provided yet". */
  hint: string;
}

/** Schema def `AvailableCommandInput`: an extensible anyOf with exactly one
 *  variant today (`unstructured`, above). Kept as a schema-named alias so a
 *  second variant widens the alias without renaming the field. Official SDK
 *  generates the same alias; internal until a consumer needs it. */
type AvailableCommandInput = UnstructuredCommandInput;

export interface AvailableCommand extends Meta {
  name: string;
  description: string;
  input?: AvailableCommandInput;
}

export interface SessionMode extends Meta {
  id: SessionModeId;
  name: string;
  description?: string;
}

/** Mode vocabulary does not align across harnesses — M1a-4's `modeMap` exists
 *  because of this shape (FINDINGS.md, "What M1a-4 should put in registry"). */
export interface SessionModeState extends Meta {
  currentModeId: SessionModeId;
  availableModes: SessionMode[];
}

/** Copilot's model selection travels here; dropped silently today (M0-1). */
export type SessionConfigOptionCategory =
  | "mode"
  | "model"
  | "model_config"
  | "thought_level"
  | (string & {});

export interface SessionConfigSelectOption extends Meta {
  value: string;
  name: string;
  description?: string;
}

/** Grouped variant of the option list (schema: SessionConfigSelectGroup). */
export interface SessionConfigSelectGroup extends Meta {
  group: string;
  name: string;
  options: SessionConfigSelectOption[];
}

/** Flat list or grouped (schema: SessionConfigSelectOptions). */
export type SessionConfigSelectValues =
  | SessionConfigSelectOption[]
  | SessionConfigSelectGroup[];

interface SessionConfigOptionBase extends Meta {
  id: string;
  name: string;
  description?: string;
  category?: SessionConfigOptionCategory;
}

/**
 * Schema models a `select`/`boolean` discriminated union on `type` whose
 * branches REQUIRE the payload (schema defs SessionConfigOption,
 * SessionConfigSelect, SessionConfigBoolean). `currentValue` is the "which
 * model ran" channel — observed on all three harnesses under
 * `category: "model"` (FINDINGS.md §M0-5), consumed by M1a-4.
 */
export type SessionConfigOption =
  | (SessionConfigOptionBase & {
      type: "select";
      currentValue: string;
      options: SessionConfigSelectValues;
    })
  | (SessionConfigOptionBase & { type: "boolean"; currentValue: boolean });

// ---------------------------------------------------------------------------
// The session/update discriminated union — the point of the exercise
// ---------------------------------------------------------------------------

/** Base of every `session/update` variant (agent → client, one-way). */
export type SessionUpdate =
  | (ContentChunk & { sessionUpdate: "user_message_chunk" })
  | (ContentChunk & { sessionUpdate: "agent_message_chunk" })
  | (ContentChunk & { sessionUpdate: "agent_thought_chunk" })
  | ToolCall
  | ToolCallUpdate
  | (Plan & { sessionUpdate: "plan" })
  | (AvailableCommandsUpdate & { sessionUpdate: "available_commands_update" })
  | (CurrentModeUpdate & { sessionUpdate: "current_mode_update" })
  | (ConfigOptionUpdate & { sessionUpdate: "config_option_update" })
  | (SessionInfoUpdate & { sessionUpdate: "session_info_update" })
  | (UsageUpdate & { sessionUpdate: "usage_update" });

interface Plan extends Meta {
  entries: PlanEntry[];
}

/** Arrives from all three harnesses right after `session/new` (M0-1). */
interface AvailableCommandsUpdate extends Meta {
  availableCommands: AvailableCommand[];
}

/** Not observed in M0; shape from the official schema. */
interface CurrentModeUpdate extends Meta {
  currentModeId: SessionModeId;
}

/** Observed from copilot only (M0-1); reports session config incl. models. */
interface ConfigOptionUpdate extends Meta {
  configOptions: SessionConfigOption[];
}

/** Not observed in M0; shape from the official schema. */
interface SessionInfoUpdate extends Meta {
  title?: string;
  updatedAt?: string;
}

/** Cumulative session cost; §M0-5 and the schema's `Cost` def agree on the
 *  shape. Cumulative for the session, never per-turn. */
export interface SessionCost extends Meta {
  amount: number;
  currency: string;
}

/** opencode: once, end of turn. claude-agent-acp: ~23 per long turn.
 *  `used` of `0` means unknown, not empty, on claude-agent-acp (M0-5). */
export interface UsageUpdate extends Meta {
  used: number;
  size: number;
  cost?: SessionCost;
}

/** Why the agent stopped the turn. copilot answers `end_turn` for a turn it
 *  itself cancelled — M1b-2's status mapping keys on this unreliability. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

// ---------------------------------------------------------------------------
// Client-originated synthetic events — the `_client_` convention (AGENTS.md).
// Not protocol traffic; emitted by this client onto its own event stream.
// ---------------------------------------------------------------------------

/** A permission decision is about to be taken (M1c-4, issue #28). Emitted
 *  before the policy is consulted, so it fires in **every** mode and for
 *  **every** kind — `AcpAgent` cannot know which decisions will block. Under
 *  `safe` and `auto` none of them do, and even under `ask` a `READ_ONLY_KINDS`
 *  call is auto-approved without a prompt. So the event means "a decision is
 *  pending", not "a human is waiting": `core/notify.ts` narrows it to the
 *  second before it rings. M4-3 answers from the browser off this same event
 *  and will want the wider meaning. */
export interface ClientPermissionPendingEvent extends Meta {
  sessionUpdate: "_client_permission_pending";
  title: string;
  kind: ToolKind;
}

/** An `ask` decision is waiting for an API client (M2-3, #33). `id` is what
 *  `POST /permissions/:id` answers, so a client following the event stream
 *  can answer without polling `GET /permissions`. Emitted by the daemon's
 *  queue only; a terminal `ask` has no id to give. */
export interface ClientPermissionQueuedEvent extends Meta {
  sessionUpdate: "_client_permission_queued";
  id: string;
  title: string;
  kind: ToolKind;
  /** The tool's input as the harness sent it, each value as text, cut by
   *  `core/permissions.ts` (M4-3). Absent when the harness sent none. */
  input?: Record<string, string>;
  /** What the edit would change, as `git diff` text (M4-6). Absent for a
   *  tool that is not an edit, and for a path outside the checkout. */
  diff?: Diff;
}

/**
 * `git diff` text and its size (M4-6): a question's edit, or an agent's
 * checkout. `files`, `added` and `removed` are counted before the text is
 * cut, so they stay true when the text ends in `… N more lines`. The text
 * is the files' own: remove control characters before you draw it.
 */
export interface Diff {
  text: string;
  files: number;
  added: number;
  removed: number;
}

/** Why a queued decision closed (M5-4, #136): a client answered, nobody did
 *  in time, the run was cancelled, its task ended, or the run ended. A room
 *  participant's mode left `ask` (M6-5): `auto` allows, `safe` denies. */
export type PermissionReason =
  | "client"
  | "timeout"
  | "cancel"
  | "task_end"
  | "run_end"
  | "mode_change";

/** A queued decision closed (M5-4, #136). Same `id` as its
 *  `_client_permission_queued`, so every reader of the stream can match the
 *  answer to the question and say why it closed. Emitted by the daemon's
 *  queue only, once per id. */
export interface ClientPermissionAnsweredEvent extends Meta {
  sessionUpdate: "_client_permission_answered";
  id: string;
  allow: boolean;
  reason: PermissionReason;
}

export interface ClientPermissionEvent extends Meta {
  sessionUpdate: "_client_permission";
  allow: boolean;
  title: string;
  kind: ToolKind;
  optionId?: PermissionOptionId;
}

export interface ClientWroteFileEvent extends Meta {
  sessionUpdate: "_client_wrote_file";
  path: string;
}

/** Emitted at the moment `session/cancel` is sent (#62 R4, M1a-3). */
export interface ClientCancelRequestedEvent extends Meta {
  sessionUpdate: "_client_cancel_requested";
  sessionId: SessionId;
}

/** A supervisor cross-check disagreement for one task (M1b-4, issue #20).
 *  `kind` repeats the core result vocabulary because protocol may not depend
 *  on core; the bus carries the same words a persisted log or SSE stream will
 *  need to reconstruct the task's warning list. */
export interface ClientResultWarningEvent extends Meta {
  sessionUpdate: "_client_result_warning";
  kind:
    | "noResultBlock"
    | "filesNotInDiff"
    | "filesUnclaimed"
    | "policyNeverFired";
  text: string;
}

/** A watchdog stall signal for one task (M1c-1, issue #25). Advisory: the task
 *  is still running when this is emitted. The TTL rung sends a real
 *  `session/cancel` instead and shows up as `_client_cancel_requested`. */
export interface ClientStallWarningEvent extends Meta {
  sessionUpdate: "_client_stall_warning";
  kind: "idle" | "repeat";
  text: string;
}

/** A task left the queue and is about to acquire its worktree (M2-2, #32).
 *  The first of the three supervisor variants M1a-6's 2026-09-06 amendment
 *  left for the persisted log to widen: a replay has no other way to tell
 *  where one task's events begin. `harness` is the registry id or `--cmd`
 *  label — `agent` on the envelope is already the task id. */
export interface ClientTaskStartedEvent extends Meta {
  sessionUpdate: "_client_task_started";
  harness: string;
}

/** The task's own checkout exists. Absent in the shared-cwd fallback, where
 *  no worktree is made. `path` is the workspace the task ran in — the checkout
 *  root, or the `--cwd` subdirectory inside it; the same path the task reports
 *  as its `cwd`. */
export interface ClientWorktreeCreatedEvent extends Meta {
  sessionUpdate: "_client_worktree_created";
  path: string;
  branch: string;
  baseSha: string;
}

/** A task's verdict, after its worktree was released. Also sent for a task
 *  cancelled before it started, which has no `_client_task_started`. `status`
 *  repeats core's `TaskStatus` because protocol may not depend on core — the
 *  same rule `ClientResultWarningEvent.kind` follows. */
export interface ClientTaskFinishedEvent extends Meta {
  sessionUpdate: "_client_task_finished";
  status: "done" | "warned" | "cancelled" | "skipped" | "timed_out" | "failed";
  durationMs: number;
}

/** The run is over, and this is its verdict (M5-5, #137): the worst task
 *  status, the run's wall time and its prompt count. The last line of a run's
 *  log, written after every `_client_task_finished` and after the run record,
 *  so a client that reads it and then asks `GET /runs/:id` sees the same
 *  status. `agent` is `""` on its envelope: it belongs to no task, and a task
 *  id is never empty. A run that died with its daemon has no such line. */
export interface ClientRunFinishedEvent extends Meta {
  sessionUpdate: "_client_run_finished";
  status: ClientTaskFinishedEvent["status"];
  durationMs: number;
  turns: number;
}

/** A harness subprocess started, and the pid it runs as (M2-4). The daemon
 *  keeps the live ones in a file, so a harness that outlives a crash can be
 *  found by M2-5's sweep. */
export interface ClientHarnessSpawnedEvent extends Meta {
  sessionUpdate: "_client_harness_spawned";
  pid: number;
}

/** That harness subprocess is gone: it exited or was killed (M2-4). */
export interface ClientHarnessExitedEvent extends Meta {
  sessionUpdate: "_client_harness_exited";
  pid: number;
}

/** A message the operator sent into a chat room (`core/room.ts`). On the log
 *  so a client that attaches later replays both sides of the conversation,
 *  not only the harness's answers. It is logged when the turn starts, so a
 *  queued message is logged twice: `_client_message_queued` on arrival, and
 *  this when the harness gets it (M6-4). `turn` counts the participant's
 *  turns from 1; a queued decision names the same number (M6-5, S12). A room
 *  logs it on every new line, but a line written before M6-5 has none.
 *  `from` is the id of the participant that sent it; none means the person
 *  (M8-1). `text` never has the `[from <name>]` line the harness gets.
 *  `kind` marks a message the daemon sent (M8-2): a worker's reply to its
 *  sender, or the orchestrator's copy of a person's message and its answer.
 *  Its `from` is the worker, and `text` is all the harness reads, first line
 *  included. A turn that starts from one sends no reply or copy. */
export interface ClientUserMessageEvent extends Meta {
  sessionUpdate: "_client_user_message";
  text: string;
  turn?: number;
  from?: string;
  kind?: MessageKind;
}

/** A message the daemon sent at the end of a turn (M8-2). */
export type MessageKind = "reply" | "copy";

/** A message reached a busy participant and waits in its queue (M6-4, R32).
 *  `_client_user_message` follows when its turn starts. A queued message with
 *  no `_client_user_message` after it was dropped: by `_client_queue_cleared`,
 *  or by a daemon restart, which loses the queue (R41). `from` and `kind` as
 *  on `_client_user_message`. */
export interface ClientMessageQueuedEvent extends Meta {
  sessionUpdate: "_client_message_queued";
  text: string;
  from?: string;
  kind?: MessageKind;
}

/** A participant's queued messages were dropped, unsent: a cancel of its
 *  turn, its removal, or its harness gone (M6-4). `count` is how many. */
export interface ClientQueueClearedEvent extends Meta {
  sessionUpdate: "_client_queue_cleared";
  count: number;
}

/** A chat room's turn is over, and the room takes the next message.
 *  `stopReason` is the harness's own word; `error` is set instead when the
 *  prompt threw, which is what a harness that died mid-turn looks like. */
export interface ClientTurnEndedEvent extends Meta {
  sessionUpdate: "_client_turn_ended";
  stopReason?: string;
  error?: string;
}

/** A participant joined the room: a starter at open, or an add (M6-10). It
 *  follows the participant's `_client_harness_spawned`, and follows
 *  `_client_worktree_created` when the room gives it its own checkout. An
 *  add that fails never logs this, though it may have logged either of the
 *  other two. The roster is on the log, so a replay shows the roster as it
 *  was at each `seq`. */
export interface ClientParticipantAddedEvent extends Meta {
  sessionUpdate: "_client_participant_added";
  name: string;
  /** A label only (R44). A client shows a role it does not know as text. */
  role?: string;
  harness: string;
  mode: "ask" | "safe" | "auto";
}

/** A participant was renamed, or its role or mode changed (M6-10). Only the
 *  fields that changed are present; a `null` role cleared it. */
export interface ClientParticipantChangedEvent extends Meta {
  sessionUpdate: "_client_participant_changed";
  name?: string;
  role?: string | null;
  mode?: "ask" | "safe" | "auto";
}

/** A participant left the roster (M6-10). The last line it has: its
 *  harness is stopped and its turn is over first. A dismiss logs none; the
 *  stream ends instead (S11). */
export interface ClientParticipantRemovedEvent extends Meta {
  sessionUpdate: "_client_participant_removed";
}

/** The target participant's branch and checkout moved to the source
 *  participant's commit, from the TUI (M6-11a). `from` is the source's
 *  participant id; `branch` is the target's branch name and `sha` the commit
 *  it now points at. */
export interface ClientParticipantFastForwardedEvent extends Meta {
  sessionUpdate: "_client_participant_fast_forwarded";
  from: string;
  branch: string;
  sha: string;
}

/** A stopped participant has a new harness, in the same checkout (M6-7a).
 *  `paused`, `killed` and `exited` revive the same way, on the next message.
 *  `loaded`: the old session came back, so it remembers earlier turns
 *  (M6-7b). `fresh`: a new session, so it does not. It comes after the
 *  `_client_user_message` that revived it, and before its answer. */
export interface ClientParticipantRevivedEvent extends Meta {
  sessionUpdate: "_client_participant_revived";
  resumed: "loaded" | "fresh";
  sessionId: string;
  /** Only with `loaded`: it stopped during a turn, so what it remembers may
   *  be behind its files (§M0-9, R46). */
  memoryMayBeBehind?: true;
}

/** Everything `render.ts`'s switch must tolerate. */
export type AgentEvent =
  | SessionUpdate
  | ClientPermissionPendingEvent
  | ClientPermissionQueuedEvent
  | ClientPermissionAnsweredEvent
  | ClientPermissionEvent
  | ClientWroteFileEvent
  | ClientCancelRequestedEvent
  | ClientResultWarningEvent
  | ClientStallWarningEvent
  | ClientTaskStartedEvent
  | ClientWorktreeCreatedEvent
  | ClientTaskFinishedEvent
  | ClientRunFinishedEvent
  | ClientHarnessSpawnedEvent
  | ClientHarnessExitedEvent
  | ClientUserMessageEvent
  | ClientMessageQueuedEvent
  | ClientQueueClearedEvent
  | ClientTurnEndedEvent
  | ClientParticipantAddedEvent
  | ClientParticipantChangedEvent
  | ClientParticipantRemovedEvent
  | ClientParticipantFastForwardedEvent
  | ClientParticipantRevivedEvent;

/** The `session/update` notification as it arrives. */
export interface SessionNotification extends Meta {
  jsonrpc: "2.0";
  method: "session/update";
  params: { sessionId: SessionId; update: SessionUpdate } & Meta;
}

// ---------------------------------------------------------------------------
// Outbound — what we send (typed per issue #10; `session/close` is typed
// only, and a room revive sends `session/load`, M6-7b)
// ---------------------------------------------------------------------------

export interface FileSystemCapabilities extends Meta {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

/** We answer `fs/*` and never offer `terminal/*` (`protocol/agent.ts`). */
export interface ClientCapabilities extends Meta {
  fs?: FileSystemCapabilities;
  terminal?: boolean;
}

export interface Implementation extends Meta {
  name: string;
  version: string;
  title?: string;
}

/** Stub — we send `authMethods` back only in a log line today. */
export interface AuthMethod extends Meta {
  id?: string;
  name?: string;
}

export interface PromptCapabilities extends Meta {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/** What we read off the handshake today: `loadSession`, `promptCapabilities`
 *  (`protocol/agent.ts`). The schema carries more; extend when a consumer needs it. */
export interface AgentCapabilities extends Meta {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
}

export interface InitializeRequest extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: "initialize";
  params: {
    protocolVersion: ProtocolVersion;
    clientCapabilities?: ClientCapabilities;
    clientInfo?: Implementation;
  } & Meta;
}

export interface InitializeResponse extends Meta {
  protocolVersion: ProtocolVersion;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: Implementation;
  authMethods?: AuthMethod[];
}

/** Stub — `mcpServers` is always `[]` today (no M1 story injects one). */
// Deliberate stub: typing the schema's three McpServer variants would be types
// for code nothing calls (R2).
// pi-lens-ignore: no-unsafe-dictionary-unknown
export type McpServer = Record<string, unknown>;

export interface NewSessionRequest extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: "session/new";
  params: {
    cwd: string;
    mcpServers: McpServer[];
    additionalDirectories?: string[];
  } & Meta;
}

export interface NewSessionResponse extends Meta {
  sessionId: SessionId;
  /** Mode discovery must read BOTH `modes` and `configOptions` here — they
   *  come on the session/new response, not `agentCapabilities`, and opencode
   *  advertises no modes but honours set_mode (FINDINGS.md §M0-1). */
  modes?: SessionModeState;
  configOptions?: SessionConfigOption[];
}

export interface PromptRequest extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: "session/prompt";
  params: {
    sessionId: SessionId;
    prompt: ContentBlock[];
  } & Meta;
}

/**
 * The whole response is kept per #62 B3. `usage` is NOT in the current
 * official schema but M0-5 measured it on the wire (the only per-task token
 * count present on all three harnesses) — per-task on opencode and
 * claude-agent-acp, cumulative on copilot (FINDINGS.md §M0-5, "The per-task
 * token count has a source"). Capture only; M1 renders nothing.
 */
export interface Usage extends Meta {
  /** Observed on all three harnesses (same table). */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Absent on claude-agent-acp (same table). */
  thoughtTokens?: number;
  // Deliberately optional despite being observed on all three harnesses in
  // M0's turn-1 table — one turn of captures is thin evidence for a
  // required field; tighten only if a later probe confirms it everywhere.
  cachedReadTokens?: number;
  /** Absent on opencode (same table). */
  cachedWriteTokens?: number;
}

export interface PromptResponse extends Meta {
  stopReason: StopReason;
  usage?: Usage;
}

export interface CancelNotification extends Meta {
  jsonrpc: "2.0";
  method: "session/cancel";
  params: { sessionId: SessionId } & Meta;
}

/** Sent by `AcpAgent.loadSession`, for a room revive (M6-7b). */
export interface LoadSessionRequest extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: "session/load";
  params: {
    sessionId: SessionId;
    cwd: string;
    mcpServers: McpServer[];
    additionalDirectories?: string[];
  } & Meta;
}

export interface LoadSessionResponse extends Meta {
  // Mode discovery reads BOTH fields (see NewSessionResponse); session/load
  // returns the same shape (FINDINGS.md §M0-1).
  modes?: SessionModeState;
  configOptions?: SessionConfigOption[];
}

/**
 * Sent under `safe`, with a harness-side id from the registry's `modeMap`.
 *
 * Hand-extended at M1a-5 rather than replaced by the SDK's generated types:
 * this was the single untyped surface M1 turned out to need, which is the
 * recorded criterion for staying hand-written (M1a-2, 2026-08-30).
 */
export interface SetSessionModeRequest extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: "session/set_mode";
  params: { sessionId: SessionId; modeId: SessionModeId } & Meta;
}

/** Empty on the wire; `{}` rather than `null`, as with WriteTextFileResponse. */
export interface SetSessionModeResponse extends Meta {}

/** Typed only — not sent; all three harnesses support close (M0 roll-up). */
export interface CloseSessionRequest extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: "session/close";
  params: { sessionId: SessionId } & Meta;
}

export interface CloseSessionResponse extends Meta {}

// ---------------------------------------------------------------------------
// Inbound — what the agent asks us, and our answers
// ---------------------------------------------------------------------------

export interface ReadTextFileRequest extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: "fs/read_text_file";
  params: {
    sessionId: SessionId;
    path: string;
    line?: number;
    limit?: number;
  } & Meta;
}

export interface ReadTextFileResponse extends Meta {
  content: string;
}

export interface WriteTextFileRequest extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: "fs/write_text_file";
  params: { sessionId: SessionId; path: string; content: string } & Meta;
}

/** Success is the empty object on the wire (schema-faithful; `acp.mjs`
 *  historically returned null and was aligned to `{}` — M0 context on #69). */
export interface WriteTextFileResponse extends Meta {}

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface PermissionOption extends Meta {
  optionId: PermissionOptionId;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionRequest extends Meta {
  jsonrpc: "2.0";
  id: number | string;
  method: "session/request_permission";
  params: {
    sessionId: SessionId;
    toolCall?: ToolCallUpdate;
    options: PermissionOption[];
  } & Meta;
}

export type RequestPermissionOutcome =
  | ({ outcome: "cancelled" } & Meta)
  | ({ outcome: "selected"; optionId: PermissionOptionId } & Meta);

export interface RequestPermissionResponse extends Meta {
  outcome: RequestPermissionOutcome;
}

// ---------------------------------------------------------------------------
// Exhaustiveness helpers
// ---------------------------------------------------------------------------

/** For `default:` branches of switches that must stay exhaustive. */
export function assertNever(value: never): never {
  throw new Error(`unhandled protocol variant: ${JSON.stringify(value)}`);
}

/** Type guard separating protocol updates from client-synthetic events.
 *  Exhaustiveness is enforced by the assignment in the `default` branch:
 *  add a variant to `SessionUpdate` and this line fails to compile until the
 *  variant is classified here (and in every other unhandled switch). */
export function isSessionUpdate(u: AgentEvent): u is SessionUpdate {
  switch (u.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      return true;
    default: {
      // Only the `_client_` events may fall through; a new SessionUpdate
      // variant makes this assignment a type error.
      const fallthrough:
        | "_client_permission_pending"
        | "_client_permission_queued"
        | "_client_permission_answered"
        | "_client_permission"
        | "_client_wrote_file"
        | "_client_cancel_requested"
        | "_client_result_warning"
        | "_client_stall_warning"
        | "_client_task_started"
        | "_client_worktree_created"
        | "_client_task_finished"
        | "_client_run_finished"
        | "_client_harness_spawned"
        | "_client_harness_exited"
        | "_client_user_message"
        | "_client_message_queued"
        | "_client_queue_cleared"
        | "_client_turn_ended"
        | "_client_participant_added"
        | "_client_participant_changed"
        | "_client_participant_removed"
        | "_client_participant_fast_forwarded"
        | "_client_participant_revived" = u.sessionUpdate;
      void fallthrough;
      return false;
    }
  }
}
