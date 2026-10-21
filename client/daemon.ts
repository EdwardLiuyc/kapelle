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
 * A refusal names `kapelle daemon stop` (M9-2): the daemon a new client
 * cannot use has to go, and that is the command that does it.
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
 * A `2xx` reply whose body is not JSON. Asking again gets the same body, so
 * `checkVersion` turns it into a `VersionRefused`: a stream stops rather than
 * retries.
 */
class UnreadableReply extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}: response was not JSON`);
    this.status = status;
  }
}

/** What `daemon.json` names, even before the daemon is listening. */
interface DaemonRecord {
  /** The daemon's process id, when the file names a usable one. */
  pid?: number;
  /** Where it listens, once the port and token are both there. */
  address?: DaemonAddress;
}

/**
 * `daemon.json`'s fields, or `"missing"` when there is no file.
 *
 * A daemon between its claim and its listen writes only `pid`, and a
 * malformed file names nothing. Both read as an empty record here, so a
 * caller can still see a live pid while it waits for the address (M9-2).
 */
export async function readDaemonRecord(
  file: string,
): Promise<DaemonRecord | "missing"> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return "missing";
  }
  let holder: { pid?: unknown; port?: unknown; token?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(text);
    // A non-object (`null`, `[]`, `42`) is as unready as a missing port: it
    // must fall through to the checks below, not throw on destructuring.
    if (typeof parsed === "object" && parsed !== null) holder = parsed;
  } catch {
    // Malformed: nothing usable, below.
  }
  const { pid, port, token } = holder;
  const record: DaemonRecord = {};
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    record.pid = pid;
  }
  if (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    typeof token === "string" &&
    token !== ""
  ) {
    record.address = { port, token };
  }
  return record;
}

/**
 * `daemon.json`'s port and token. `"missing"` when there is no file — no
 * daemon, or one that stopped cleanly and removed it — and `"unready"` when
 * the file has no usable address: a daemon between its claim and its listen,
 * or a malformed file.
 */
export async function readDaemonFile(
  file: string,
): Promise<DaemonAddress | "missing" | "unready"> {
  const record = await readDaemonRecord(file);
  if (record === "missing") return "missing";
  return record.address ?? "unready";
}

/** One request, with the token on it. A body is JSON: the daemon refuses any
 *  other type with a 415 (M5-3). `init.headers` may take any form `fetch`
 *  takes: an object, a `Headers` or a list of pairs. */
export function request(
  d: DaemonAddress,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${d.token}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${d.port}${path}`, { ...init, headers });
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
    if (res.ok) throw new UnreadableReply(res.status);
  }
  if (res.ok) return { ok: true, status: res.status, body: parsed as T };
  // A refusal Node sends itself — a 408, a 400 for malformed HTTP — has no
  // envelope, so the status stands in for the message. The same is true of
  // an envelope with no usable message, like `{error: {code: "x"}}`.
  const envelope = (parsed as Partial<ErrorReply> | undefined)?.error;
  const code = typeof envelope?.code === "string" ? envelope.code : "";
  const message =
    typeof envelope?.message === "string" && envelope.message !== ""
      ? envelope.message
      : `HTTP ${res.status}`;
  return { ok: false, status: res.status, error: { code, message } };
}

/** The daemon's version is not one this client can use: a different
 *  `major`, no readable `apiVersion`, or a refusal before the stream opens.
 *  A `StreamClosed`, so a stream that meets it stops rather than retries. */
export class VersionRefused extends StreamClosed {}

/**
 * Asks `GET /version` and compares it with `API_VERSION`. Throws
 * `VersionRefused` for a different `major`, an unreadable `apiVersion`, or a
 * non-404 refusal (with the daemon's own message), and answers a warning for
 * a different `minor`. A daemon it cannot reach throws as `fetch` does.
 */
export async function checkVersion(
  d: DaemonAddress,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ours = `${API_VERSION.major}.${API_VERSION.minor}`;
  let r: Reply<Partial<VersionReply>>;
  try {
    r = await call<Partial<VersionReply>>(d, "/version", { signal });
  } catch (err) {
    if (err instanceof UnreadableReply) {
      throw new VersionRefused(
        `the daemon has no readable API version (GET /version answered ` +
          `HTTP ${err.status} with a non-JSON body); this client speaks ` +
          `${ours}; stop it with: kapelle daemon stop`,
      );
    }
    throw err;
  }
  if (!r.ok) {
    // A 404 is a daemon older than M5-1, which has no `/version` route.
    // Every other status is the daemon's own refusal, normalized by `call`.
    if (r.status === 404) {
      throw new VersionRefused(
        `the daemon has no API version (this client speaks ${ours}); ` +
          "stop it with: kapelle daemon stop",
      );
    }
    throw new VersionRefused(
      `the daemon refused GET /version: ${r.error.message}`,
    );
  }
  const theirs = r.body?.apiVersion;
  if (
    !theirs ||
    !Number.isInteger(theirs.major) ||
    !Number.isInteger(theirs.minor)
  ) {
    throw new VersionRefused(
      `the daemon has no readable API version (this client speaks ${ours}); ` +
        "stop it with: kapelle daemon stop",
    );
  }
  const both = `the daemon speaks API ${theirs.major}.${theirs.minor} and this client ${ours}`;
  if (theirs.major !== API_VERSION.major) {
    throw new VersionRefused(`${both}; stop it with: kapelle daemon stop`);
  }
  if (theirs.minor !== API_VERSION.minor) {
    return `${both}; something was added or is missing`;
  }
  return undefined;
}
