/**
 * How a client finds the daemon and talks to it — story M5-10a (#142).
 *
 * **No client in `client/` or `chat/` speaks HTTP to the daemon except through
 * this file.** It is the one transport, version check and connection-file
 * reader for every `cli.ts` verb that talks to the daemon, and for `chat.ts`;
 * `kapelle daemon start` imports `daemon.ts` directly.
 *
 * **The caller passes both paths.** `client.json` is a client-local setting
 * (M11-4): when it names a daemon, it wins over `daemon.json` and the runtime
 * folder is never touched. Without it, the caller passes `core/runtime.ts`'s
 * `daemon.json` path. These files are read again on every call that needs
 * them: a daemon that restarts has a new token, and maybe a new port.
 *
 * `call` answers the typed reply, or the `{code, message}` of the daemon's
 * refusal. `request` is the bare `Response`, for the event stream
 * (`stream.ts`) to read.
 *
 * `checkVersion` is B5: a different `major` is refused, a different `minor`
 * is a warning. It returns the warning rather than print it; printing is the
 * caller's. A client checks once per address: a restart brings a new token,
 * and a client setting can move the port under the same token. A restart is
 * exactly when a new version arrives.
 * A refusal names `kapelle daemon stop` (M9-2): the daemon a new client
 * cannot use has to go, and that is the command that does it.
 */

import { lstat, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { API_VERSION, type ErrorReply, type VersionReply } from "./contract.ts";
import { StreamClosed } from "./stream.ts";

/** Where the daemon listens, the token it wants, and which file named it. */
export interface DaemonAddress {
  port: number;
  token: string;
  /** True when `client.json` supplied this address, not `daemon.json`. */
  fromClient: boolean;
}

/** The client connection file: `$XDG_CONFIG_HOME/kapelle/client.json`. */
export function clientConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_CONFIG_HOME;
  const base =
    configured && isAbsolute(configured)
      ? configured
      : join(homedir(), ".config");
  return join(base, "kapelle", "client.json");
}

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** RFC 6750's bearer-token characters. A header value outside this set can make
 *  `Headers.set` throw with the value in its message, which would log the key. */
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const isBearerToken = (value: unknown): value is string =>
  typeof value === "string" && BEARER_TOKEN.test(value);

/** A configured address as a daemon address, or a strict refusal. */
function configuredAddress(
  value: unknown,
  key: unknown,
  where: string,
): DaemonAddress {
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `${where}: "daemonAddress" must be an absolute http://127.0.0.1:<port> address.`,
    );
  }
  // Parse the text, not a URL: WHATWG URL drops an explicit :80 and accepts
  // IPv4 shorthands such as 127.1, though this setting promises the exact form.
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  const port = match ? Number(match[1]) : undefined;
  if (port === undefined || port > 65535) {
    throw new Error(
      `${where}: "daemonAddress" must be exactly ` +
        `http://127.0.0.1:<port>, with no path, query, fragment or credentials.`,
    );
  }
  if (!isBearerToken(key)) {
    throw new Error(
      `${where}: "accessKey" must be a bearer token (letters, digits, ` +
        `-._~+/ and optional = padding).`,
    );
  }
  return { port, token: key, fromClient: true };
}

/**
 * The client-local daemon setting. A missing file or `{}` is no opinion.
 * Everything else is strict: keys, types, mode and address shape are checked
 * here so a typo cannot silently fall back to a local daemon.
 */
// The ordered guards are one decode boundary: no value is used before it checks.
// pi-lens-ignore: high-complexity
export async function readClientDaemon(
  file: string,
): Promise<DaemonAddress | undefined> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${file}: ${messageOf(err)}`);
  }
  if (
    !st.isFile() ||
    st.uid !== userInfo().uid ||
    (st.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      `${file} must be a plain file owned by you with mode 0600. ` +
        `Fix or remove it, then try again.`,
    );
  }

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${messageOf(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Do not include the parser's message: Node quotes the nearby text, and a
    // malformed accessKey would then reach stderr.
    throw new Error(`${file} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON object.`);
  }
  const object = parsed as Record<string, unknown>;
  for (const name of Object.keys(object)) {
    if (name !== "daemonAddress" && name !== "accessKey") {
      throw new Error(
        `${file}: unknown key ${JSON.stringify(name)}. ` +
          `Known: daemonAddress, accessKey.`,
      );
    }
  }
  if (object.daemonAddress === undefined && object.accessKey === undefined) {
    return undefined;
  }
  if (object.daemonAddress === undefined || object.accessKey === undefined) {
    throw new Error(
      `${file}: "daemonAddress" and "accessKey" must be set together.`,
    );
  }
  return configuredAddress(object.daemonAddress, object.accessKey, `${file}`);
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
    record.address = { port, token, fromClient: false };
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

/**
 * The configured client daemon, or else `daemon.json`. The daemon-file path is
 * lazy so a configured client never touches the runtime folder it names.
 */
export async function resolveDaemonAddress(
  clientFile: string,
  daemonFile: () => string,
): Promise<DaemonAddress | "missing" | "unready"> {
  const configured = await readClientDaemon(clientFile);
  return configured ?? (await readDaemonFile(daemonFile()));
}

class InvalidAccessKey extends Error {}

/** One request, with the token on it. A body is JSON: the daemon refuses any
 *  other type with a 415 (M5-3). `init.headers` may take any form `fetch`
 *  takes: an object, a `Headers` or a list of pairs. */
export function request(
  d: DaemonAddress,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (!isBearerToken(d.token)) {
    throw new InvalidAccessKey(
      "the daemon access key is not a valid bearer token",
    );
  }
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
  return replyOf<T>(res, await res.text());
}

/** A reply's text as a `Reply`: the body, or the daemon's refusal. */
export function replyOf<T>(res: Response, text: string): Reply<T> {
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
 * a different `minor`. A daemon it cannot reach throws with the address it
 * tried; the token is never part of that address or message.
 */
export async function checkVersion(
  d: DaemonAddress,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ours = `${API_VERSION.major}.${API_VERSION.minor}`;
  const tried = `http://127.0.0.1:${d.port}`;
  const stopHint = d.fromClient
    ? "stop that daemon on the machine that runs it"
    : "stop it with: kapelle daemon stop";
  let r: Reply<Partial<VersionReply>>;
  try {
    r = await call<Partial<VersionReply>>(d, "/version", { signal });
  } catch (err) {
    if (err instanceof InvalidAccessKey) throw err;
    if (err instanceof UnreadableReply) {
      throw new VersionRefused(
        `the daemon at ${tried} has no readable API version ` +
          `(GET /version answered HTTP ${err.status} with a non-JSON body); ` +
          `this client speaks ${ours}; ${stopHint}`,
      );
    }
    throw new Error(
      `the daemon at ${tried} did not answer: ${messageOf(err)}`,
      {
        cause: err,
      },
    );
  }
  if (!r.ok) {
    // A 404 is a daemon older than M5-1, which has no `/version` route.
    // Every other status is the daemon's own refusal, normalized by `call`.
    if (r.status === 404) {
      throw new VersionRefused(
        `the daemon has no API version (this client speaks ${ours}); ${stopHint}`,
      );
    }
    throw new VersionRefused(
      `the daemon refused GET /version: ${r.error.message}; ${stopHint}`,
    );
  }
  const theirs = r.body?.apiVersion;
  if (
    !theirs ||
    !Number.isInteger(theirs.major) ||
    !Number.isInteger(theirs.minor)
  ) {
    throw new VersionRefused(
      `the daemon has no readable API version (this client speaks ${ours}); ${stopHint}`,
    );
  }
  const both = `the daemon speaks API ${theirs.major}.${theirs.minor} and this client ${ours}`;
  if (theirs.major !== API_VERSION.major) {
    throw new VersionRefused(
      `${both}; update the client or the daemon, then ${stopHint}`,
    );
  }
  if (theirs.minor !== API_VERSION.minor) {
    return `${both}; something was added or is missing`;
  }
  return undefined;
}
