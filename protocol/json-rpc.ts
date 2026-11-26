/**
 * Newline-delimited JSON-RPC framing for one harness's stdio.
 *
 * This module only encodes and decodes lines. `AcpAgent` owns request
 * correlation, dispatch and the subprocess streams.
 */

import type { JsonRpcError } from "./types.ts";

export type OutgoingMessage =
  | { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | { jsonrpc: "2.0"; id: number | string; error: JsonRpcError };

/** A line off the agent's stdout, before we know which of the three it is. */
export interface IncomingMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

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
export const MAX_LINE_LENGTH = 32 * 1024 * 1024;

export type ParsedJsonRpcLine =
  | { kind: "message"; message: IncomingMessage }
  | { kind: "empty" }
  | { kind: "oversized"; length: number }
  | { kind: "malformed"; line: string };

/** Encode one message with the delimiter ACP's stdio transport requires. */
export function encodeJsonRpcLine(message: OutgoingMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Decode one stdout line, leaving its logging and dispatch to `AcpAgent`.
 * A JSON object is a message; primitives and arrays are malformed lines.
 */
export function parseJsonRpcLine(raw: string): ParsedJsonRpcLine {
  // Before `trim`, which would copy the whole oversized line.
  if (raw.length > MAX_LINE_LENGTH) {
    return { kind: "oversized", length: raw.length };
  }

  const line = raw.trim();
  if (!line) return { kind: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Agents MUST NOT put non-ACP data on stdout, but be forgiving.
    return { kind: "malformed", line };
  }

  // JSON is untrusted here: only a non-null, non-array object can be a message.
  // pi-lens-ignore: no-runtime-typeof
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed", line };
  }
  return { kind: "message", message: parsed as IncomingMessage };
}
