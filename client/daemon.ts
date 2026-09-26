/**
 * How a client finds the daemon and talks to it — story M5-10a (#142).
 *
 * **The caller passes the `daemon.json` path.** The folder it sits in is
 * `core/runtime.ts`'s to pick and to guard (`ours()`), and this folder imports
 * nothing from `core/`, so the rule keeps one copy. The file is read again on
 * every call that needs it: a daemon that restarts has a new token, and maybe
 * a new port.
 *
 * `call` answers the typed reply, or the `{code, message}` of the daemon's
 * refusal. `request` is the bare `Response`, for the event stream
 * (`stream.ts`) to read.
 *
 * `checkVersion` is B5: a different `major` is refused, a different `minor`
 * is a warning. It returns the warning rather than print it; printing is the
 * caller's. A client checks once per daemon — per token, since a restart
 * brings a new one — and a restart is exactly when a new version arrives.
 */

import { readFile } from "node:fs/promises";
import { API_VERSION, type ErrorReply, type VersionReply } from "./contract.ts";
import { StreamClosed } from "./stream.ts";

/** Where the daemon listens, and the token it wants. */
export interface DaemonAddress {
  port: number;
  token: string;
}

/**
 * `daemon.json`'s port and token. `"missing"` when there is no file — no
 * daemon, or one that stopped cleanly and removed it — and `"unready"` when
 * the file has no port or token: a daemon between its claim and its listen,
 * or a malformed file.
 */
export async function readDaemonFile(
  file: string,
): Promise<DaemonAddress | "missing" | "unready"> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return "missing";
  }
  let holder: { port?: unknown; token?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(text);
    // A non-object (`null`, `[]`, `42`) is as unready as a missing port: it
    // must fall through to the check below, not throw on destructuring.
    if (typeof parsed === "object" && parsed !== null) holder = parsed;
  } catch {
    // Malformed: unready, below.
  }
  const { port, token } = holder;
  if (
    typeof port !== "number" ||
    !port ||
    typeof token !== "string" ||
    !token
  ) {
    return "unready";
  }
  return { port, token };
}

/** One request, with the token on it. A body is JSON: the daemon refuses any
 *  other type with a 415 (M5-3). */
export function request(
  d: DaemonAddress,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${d.port}${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      authorization: `Bearer ${d.token}`,
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
  });
}

export type Reply<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error: ErrorReply["error"] };

/** A request with a JSON reply. `body`, when given, is sent as JSON. */
export async function call<T>(
  d: DaemonAddress,
  path: string,
  {
    method,
    body,
    signal,
  }: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<Reply<T>> {
  const res = await request(d, path, {
    method,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    if (res.ok) throw new Error(`HTTP ${res.status}: response was not JSON`);
  }
  if (res.ok) return { ok: true, status: res.status, body: parsed as T };
  // A refusal Node sends itself — a 408, a 400 for malformed HTTP — has no
  // envelope, so the status stands in for the message.
  const error = (parsed as Partial<ErrorReply> | undefined)?.error ?? {
    code: "",
    message: `HTTP ${res.status}`,
  };
  return { ok: false, status: res.status, error };
}

/** The daemon speaks a different `major`, or no version at all. A
 *  `StreamClosed`, so a stream that meets it stops rather than retries. */
export class VersionRefused extends StreamClosed {}

/**
 * Asks `GET /version` and compares it with `API_VERSION`. Throws
 * `VersionRefused` for a different `major`, and answers a warning for a
 * different `minor`. A daemon it cannot reach throws as `fetch` does.
 */
export async function checkVersion(
  d: DaemonAddress,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const r = await call<Partial<VersionReply>>(d, "/version", { signal });
  const theirs = r.ok ? r.body?.apiVersion : undefined;
  const ours = `${API_VERSION.major}.${API_VERSION.minor}`;
  if (!theirs) {
    throw new VersionRefused(
      `the daemon has no API version (this client speaks ${ours}); ` +
        "update the daemon",
    );
  }
  const both = `the daemon speaks API ${theirs.major}.${theirs.minor} and this client ${ours}`;
  if (theirs.major !== API_VERSION.major) {
    throw new VersionRefused(`${both}; update the client or the daemon`);
  }
  if (theirs.minor !== API_VERSION.minor) {
    return `${both}; something was added or is missing`;
  }
  return undefined;
}
