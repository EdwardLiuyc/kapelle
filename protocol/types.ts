/**
 * Hand-written protocol types for the subset of ACP (Agent Client Protocol)
 * this client touches — stories M1a-2.
 *
 * Sources, in priority order:
 *  1. What `acp.mjs` / `render.mjs` / `mock-agent.mjs` already do (the porting
 *     target — M1a-3/M1a-7 type against this file).
 *  2. What the harnesses actually sent on the wire during M0
 *     (`docs/M0-FINDINGS.md`).
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
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** The spec's extension channel — free-form, no assumptions about values. */
export type Meta = { _meta?: Record<string, unknown> };

export type SessionId = string;
export type ToolCallId = string;
export type MessageId = string;
export type SessionModeId = string;
export type PermissionOptionId = string;
export type TerminalId = string;
/** Wire protocol version; the client hard-fails on mismatch (`acp.mjs`). */
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

/** Success answer to a request, ours or the agent's. */
export interface JsonRpcResponse<R = unknown> extends Meta {
 jsonrpc: "2.0";
 id: number | string;
 result?: R;
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

/** Text is the only block this client renders today (`render.mjs`). */
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

/** `READ_ONLY_KINDS` in `acp.mjs` is the subset this client treats as safe. */
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

/** Content produced by a tool call. `diff` is what `render.mjs` prints. */
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
 *  deserializes defaults); `acp.mjs` already applies the `?? "other"` fallback. */
export interface ToolCall extends Meta {
 sessionUpdate: "tool_call";
 toolCallId: ToolCallId;
 title: string;
 kind?: ToolKind;
 status?: ToolCallStatus;
 content?: ToolCallContent[];
 locations?: ToolCallLocation[];
 rawInput?: Record<string, unknown>;
 rawOutput?: unknown;
}

/** Progress on an existing call — everything but `toolCallId` is optional,
 *  only changed fields travel. `acp.mjs` merges these into its toolCall map. */
export interface ToolCallUpdate extends Meta {
 sessionUpdate: "tool_call_update";
 toolCallId: ToolCallId;
 kind?: ToolKind;
 status?: ToolCallStatus;
 title?: string;
 content?: ToolCallContent[];
 locations?: ToolCallLocation[];
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

export interface AvailableCommand extends Meta {
 name: string;
 description: string;
 input?: Record<string, unknown>;
}

export interface SessionMode extends Meta {
 id: SessionModeId;
 name: string;
 description?: string;
}

/** Mode vocabulary does not align across harnesses — M1a-4's `modeMap` exists
 *  because of this shape (M0-FINDINGS.md, "What M1a-4 should put in registry"). */
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

export interface SessionConfigOption extends Meta {
 id: string;
 name: string;
 description?: string;
 category?: SessionConfigOptionCategory;
}

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

/** opencode: once, end of turn. claude-agent-acp: ~23 per long turn.
 *  `used` of `0` means unknown, not empty, on claude-agent-acp (M0-5). */
export interface UsageUpdate extends Meta {
 used: number;
 size: number;
 /** Cumulative session cost; shape not pinned by M0 — see §M0-5. */
 cost?: Record<string, unknown>;
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
// Client-originated synthetic events — the `_client_` convention (CLAUDE.md).
// Not protocol traffic; emitted by this client onto its own event stream.
// ---------------------------------------------------------------------------

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

/** Everything `render.mjs`'s switch must tolerate. */
export type AgentEvent =
 | SessionUpdate
 | ClientPermissionEvent
 | ClientWroteFileEvent
 | ClientCancelRequestedEvent;

/** The `session/update` notification as it arrives. */
export interface SessionNotification extends Meta {
 jsonrpc: "2.0";
 method: "session/update";
 params: { sessionId: SessionId; update: SessionUpdate };
}

// ---------------------------------------------------------------------------
// Outbound — what we send (typed per issue #10; `session/load` and
// `session/close` are typed only, the calls themselves are M1a-3+)
// ---------------------------------------------------------------------------

export interface FileSystemCapabilities extends Meta {
 readTextFile?: boolean;
 writeTextFile?: boolean;
}

/** We answer `fs/*` and never offer `terminal/*` (`acp.mjs`). */
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
 *  (`acp.mjs`). The schema carries more; extend when a consumer needs it. */
export interface AgentCapabilities extends Meta {
 loadSession?: boolean;
 promptCapabilities?: PromptCapabilities;
 /** Mode discovery must read BOTH `modes` and `configOptions` — opencode
  *  advertises no modes but honours set_mode (M0-FINDINGS.md §M0-1). */
 modes?: SessionModeState;
 configOptions?: SessionConfigOption[];
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
 * The whole response is kept per #62 B3 — `usage` is NOT in the current
 * official schema but M0-5 measured it on the wire (the only per-task token
 * count present on all three harnesses). Capture only; M1 renders nothing.
 */
export interface PromptResponse extends Meta {
 stopReason: StopReason;
 usage?: Record<string, unknown>;
}

export interface CancelNotification extends Meta {
 jsonrpc: "2.0";
 method: "session/cancel";
 params: { sessionId: SessionId } & Meta;
}

/** Typed only — not sent until M1a-3 lands `session/load` (issue #10). */
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
 modes?: SessionModeState;
 configOptions?: SessionConfigOption[];
}

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

/** Success is the empty object on the wire (`acp.mjs` returns null today). */
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
    | "_client_permission"
    | "_client_wrote_file"
    | "_client_cancel_requested" = u.sessionUpdate;
   void fallthrough;
   return false;
  }
 }
}
