#!/usr/bin/env node
/**
 * The daemon — story M2-1, issue #31.
 *
 * **One daemon for all of the operator's repositories** (decided 2026-09-11,
 * #31). A repository is added once (`POST /repos`), and a run names the folder
 * it runs in (`POST /runs {cwd, run}`); a folder outside every added
 * repository is refused. One port, one token, and one place — M4's dashboard
 * — to watch every run. Run state lives in each repository's own workspace
 * under `stateDirFor(root)`, outside the repository.
 *
 * **Transport over `core/`, and nothing more.** It calls `stateDirRoot`,
 * `stateDirFor`, `validateRun`, `sweepBoot`, `runRun`,
 * `processIdentity` and the permission queue, and for chat rooms
 * `roomHarness` and `openRoom`; worktrees, policy and harnesses
 * stay behind them. If orchestration grew here, the scheduler would be
 * untestable without a server and the CLI would drift into a second
 * implementation (`docs/STORIES.md`, M2-1).
 *
 * **The token is not optional, even on 127.0.0.1.** Every account on the
 * machine can reach the loopback address, and a run file is a command line —
 * `cmd`, or any harness under `auto`. It lives in
 * `$XDG_RUNTIME_DIR/kapelle/daemon.json`: outside every repository, so git
 * never sees it, in a `0700` directory only the operator can enter, and wiped
 * at logout. It stops being enough the moment the daemon binds anywhere else,
 * which is also the trigger that re-opens sandboxing.
 *
 * **A `Host` outside loopback is refused before the token is read** (M2-8,
 * #38), which closes DNS rebinding — an attacker page gaining same-origin
 * access to this loopback daemon. The browser half, `?token=` on the SSE
 * endpoint, is retired with the browser dashboard (A3): no story serves a page.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  API_VERSION,
  CAPABILITIES,
  type ErrorCode,
  type ErrorReply,
  type MessageAccepted,
  type Notice,
  type PendingDecision,
  type PermissionAnswered,
  type RepoAdded,
  type RepoRoots,
  type RoomView,
  type RunAccepted,
  type RunDto,
  type RunListEntry,
  type RunStatus,
  type TaskDto,
  type VersionReply,
} from "./client/contract.ts";
import {
  readEnvConfig,
  readProjectConfig,
  readUserConfig,
  resolveRunDefaults,
  warnUnknownConfigEnv,
} from "./core/config.ts";
import { type EventLog, openEventLog } from "./core/eventlog.ts";
import { createEventBus } from "./core/events.ts";
import { newRoomId, newRunId } from "./core/ids.ts";
import { createPermissionQueue } from "./core/permissions.ts";
import { openRoom, type Room, roomHarness } from "./core/room.ts";
import { type RunReport, runRun, type TaskRun } from "./core/run.ts";
import { type Run, validateRun } from "./core/runfile.ts";
import {
  readRepos,
  runtimeDir,
  stateDirFor,
  writeRepos,
} from "./core/runtime.ts";
import { processIdentity, sweepBoot } from "./core/sweep.ts";
import { openWorktrees, stateDirRoot } from "./core/worktree.ts";
import { AGENTS } from "./protocol/registry.ts";

// M2-7: the user-level config is read once here, after the startup helpers
// below and before the port is claimed. `KAPELLE_*` is also read here for the
// daemon-wide knobs, then re-read for every run-default resolution and per
// repository by the boot sweep. Unknown `KAPELLE_*` names warn and are
// ignored (they may be secrets); a known name with a bad value refuses the
// start like any flag.
const DEFAULT_PORT = 4719;

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** A startup refusal is one line and exit 1, never a stack trace. */
function orExit<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    console.error(messageOf(err));
    process.exit(1);
  }
}

const userConfig = orExit(() => readUserConfig());
warnUnknownConfigEnv();
const configEnv = orExit(() => readEnvConfig());

const DEFAULT_PERMISSION_TIMEOUT_S = 120;

const { port, permissionTimeoutMs } = orExit(() => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      "permission-timeout": { type: "string" },
    },
  });
  const rawPort = values.port;
  const n =
    rawPort === undefined
      ? (configEnv.port ?? userConfig.port ?? DEFAULT_PORT)
      : Number(rawPort);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be a whole number 0-65535; got ${rawPort}`);
  }
  const raw = values["permission-timeout"];
  // The config values were validated where they were read (M2-7); the flag
  // is the one string path left.
  if (raw === undefined) {
    return {
      port: n,
      permissionTimeoutMs:
        configEnv.permissionTimeoutMs ??
        userConfig.permissionTimeoutMs ??
        DEFAULT_PERMISSION_TIMEOUT_S * 1000,
    };
  }
  const seconds = Number(raw);
  const permissionTimeoutMs = seconds * 1000;
  // No `0` meaning "wait forever": an unanswered decision must end (M2-3).
  // Node clamps a timer above 2^31-1 ms to 1 ms, so the ceiling is a refusal,
  // not a silent cap that would deny every decision at once.
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    permissionTimeoutMs > 2147483647
  ) {
    throw new Error(
      `--permission-timeout must be a number of seconds above 0 and at most ` +
        `2147483 (Node's 32-bit timer ceiling); got ${raw}`,
    );
  }
  return { port: n, permissionTimeoutMs };
});

/** Is `pid` a live process? `EPERM` means it is, and is someone else's. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Creates `file` holding this pid, or throws `EEXIST`.
 *
 * Written to a private name first and then linked in, because `link` never
 * replaces and the file it publishes already has the pid in it. An exclusive
 * `open` published an empty file for an instant, and a second daemon reading
 * it then took it for stale.
 */
function create(file: string): number {
  const tmp = `${file}.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid }));
    linkSync(tmp, file);
  } catch (err) {
    closeSync(fd);
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  return fd;
}

/**
 * Takes `daemon.json` for this process, or throws naming the daemon that has it.
 *
 * The file is the single-instance lock as well as the token's home. A second
 * daemon finds a live pid in it and refuses, rather than overwriting the token
 * every client of the first one is using. A pid that is dead was left by a
 * daemon that crashed or was stopped, and its file is replaced.
 */
function claim(file: string): number {
  try {
    return create(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Replacing a stale file is check-then-act, so two daemons starting in the
  // same instant could both see it stale and both replace it. `mkdir` is
  // atomic, so exactly one gets past here; the other refuses rather than
  // waits, because the winner's pid is about to be live (M2-4).
  const lock = `${file}.lock`;
  try {
    mkdirSync(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new Error(
      `another daemon is starting (${lock} exists). If none is, remove ` +
        `that directory and start again.`,
    );
  }
  try {
    let holder: { pid?: unknown; port?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      // A non-object (`null`, `[]`, `42`) names no pid either; it counts as
      // stale exactly like an unreadable file, and must not throw here.
      if (typeof parsed === "object" && parsed !== null) {
        holder = parsed as { pid?: unknown; port?: unknown };
      }
    } catch {
      // Unreadable: nothing live is vouching for it, so it counts as stale.
    }
    if (typeof holder.pid === "number" && alive(holder.pid)) {
      throw new Error(
        `a daemon is already running: pid ${holder.pid}, port ${holder.port} ` +
          `(${file}).`,
      );
    }
    rmSync(file, { force: true });
    return create(file);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const dir = orExit(runtimeDir);
const file = join(dir, "daemon.json");
// Read before the claim, and through `orExit` like every other startup
// refusal: a state directory somebody else owns stops the daemon with one
// line rather than a stack, and stops it before `daemon.json` exists, so a
// start that refused leaves nothing behind for the next one to clear.
const addedRepos = orExit(readRepos);
const fd = orExit(() => claim(file));

const token = randomBytes(32).toString("hex");
// Compared as digests: `timingSafeEqual` needs equal lengths, and hashing
// both sides gives that without a length check that answers early.
const digest = (s: string) => createHash("sha256").update(s).digest();
const expected = digest(token);

/**
 * The names this daemon answers to — story M2-8, issue #38.
 *
 * DNS rebinding is the attack the token alone does not stop: a page on
 * `evil.example` re-resolves its own name to `127.0.0.1`, and the browser then
 * talks to this daemon while treating the reply as same-origin. The `Host`
 * line is the one field that attack cannot forge — it still says
 * `evil.example`, because that is the name the browser was told to fetch.
 *
 * The port is deliberately not matched: rebinding needs an attacker-chosen
 * DNS name to gain same-origin access. Direct cross-origin requests to a
 * loopback URL still arrive with a loopback Host, but without the bearer token
 * they are refused. Matching the port would add no protection against those.
 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost\.?|\[::1\])(:\d+)?$/i;

/**
 * The authority this request is addressed to, or `null` when there is no one
 * answer. Two fields can carry it, and the guard has to read the right one.
 *
 * RFC 9112 §3.2.2: with an absolute-form target (`GET http://host/path`) the
 * target's authority wins and `Host` is ignored. RFC 9110 §7.2: more than one
 * `Host` line is malformed — Node keeps the first for `req.headers.host`, so a
 * loopback line followed by a forged one would otherwise pass. `rawHeaders` is
 * where both survive. The match itself is case-insensitive and admits the
 * root-anchored `localhost.`, because a hostname is both (RFC 9110 §4.2.3) and
 * a rebinding page can put neither spelling on the wire; `/i` without `/u`, or
 * `localhoſt` would fold into a match.
 */
function authorityOf(req: IncomingMessage): string | null {
  const hosts = req.rawHeaders.filter(
    (h, i) => i % 2 === 0 && h.toLowerCase() === "host",
  );
  if (hosts.length > 1) return null;
  try {
    // Throws for an origin-form target, which is every ordinary request.
    return new URL(req.url ?? "/").host;
  } catch {
    return req.headers.host ?? "";
  }
}

function authorised(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(given), expected);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** An error that carries its HTTP status and contract code (M5-3). Only a
 *  `Refusal` is trusted by the server's catch; anything else is a 500
 *  `internal`, so a raw Node or `execFile` error cannot leak its own `code`
 *  into the envelope. */
class Refusal extends Error {
  status: number;
  code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function refusal(status: number, code: ErrorCode, message: string): Refusal {
  return new Refusal(status, code, message);
}

/** The largest request body read (J1): run files carry prompts. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * A write's JSON body, refused in order: not JSON by `Content-Type` (415),
 * too large (413), not a JSON object (400), a field outside `fields` (400,
 * C8). The size is checked on `Content-Length` before a byte is read, and
 * counted as it arrives for a body sent without one, so an oversized body is
 * never held in memory.
 */
async function readBody(
  req: IncomingMessage,
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (type.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw refusal(
      415,
      "unsupported_media_type",
      `send the body as Content-Type: application/json; got ${type || "none"}`,
    );
  }
  const tooLarge = () =>
    refusal(
      413,
      "body_too_large",
      `the body is larger than ${MAX_BODY_BYTES} bytes`,
    );
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  // Joined as bytes, then decoded once: a character split across two chunks
  // would otherwise decode as two replacement characters.
  const text = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw refusal(
      400,
      "invalid_request",
      `body is not JSON: ${messageOf(err)}`,
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw refusal(400, "invalid_request", "body must be a JSON object");
  }
  const unknown = Object.keys(body).find((key) => !fields.includes(key));
  if (unknown !== undefined) {
    throw refusal(
      400,
      "invalid_request",
      `unknown field "${unknown}"; this route takes ${fields.join(", ")}`,
    );
  }
  return body as Record<string, unknown>;
}

/** `value` as the real path of a folder that exists, or a 400 naming `field`. */
function existingDir(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw refusal(
      400,
      "invalid_request",
      `"${field}" must be an absolute path; got ${JSON.stringify(value)}`,
    );
  }
  if (!statSync(value, { throwIfNoEntry: false })?.isDirectory()) {
    throw refusal(
      400,
      "invalid_request",
      `"${field}": ${value} does not exist as a folder`,
    );
  }
  return realpathSync(value);
}

/** Every repository root added, restored from `repos.json` (M2-6, #36).
 *  Not re-checked here: a repository that has since moved is refused by
 *  `POST /runs`, which checks membership on use. */
const repos = new Set<string>(addedRepos);

const USAGE_SEMANTICS = new Set(["per-turn", "cumulative", "unknown"]);

/** The string fields `toTaskDto` copies, pinned to both sides of the edge:
 *  `TaskDto` in `client/contract.ts` and the live `TaskRun` in `core/run.ts`.
 *  A rename on either side fails `npm run check` instead of silently leaving
 *  the field off the wire. */
const STRING_KEYS = [
  "agent",
  "error",
  "summary",
  "branch",
  "baseSha",
  "sessionId",
] as const satisfies readonly (keyof TaskDto & keyof TaskRun)[];

/** The non-string fields, pinned the same way. The `Record`'s key set is
 *  the complement of `STRING_KEYS` plus `id`/`status`, so a field added to
 *  `TaskDto` fails `npm run check` until `toTaskDto` handles it. */
const TYPED_KEYS = {
  durationMs: "durationMs",
  usage: "usage",
  usageSemantics: "usageSemantics",
  warnings: "warnings",
  summarySynthesised: "summarySynthesised",
} as const satisfies Record<
  Exclude<keyof TaskDto, (typeof STRING_KEYS)[number] | "id" | "status">,
  keyof TaskDto & keyof TaskRun
>;

/** A `Usage` from a value of unknown provenance, rebuilt key by key so a
 *  hand-edited record cannot put a wrong-typed or unknown nested value on the
 *  wire. `_meta` is the one exception: C11 passes it through. `undefined`
 *  when the required numbers are not all finite. */
function usageOf(value: unknown): TaskDto["usage"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    !Number.isFinite(raw.inputTokens) ||
    !Number.isFinite(raw.outputTokens) ||
    !Number.isFinite(raw.totalTokens)
  ) {
    return undefined;
  }
  const usage: NonNullable<TaskDto["usage"]> = {
    inputTokens: raw.inputTokens as number,
    outputTokens: raw.outputTokens as number,
    totalTokens: raw.totalTokens as number,
  };
  for (const key of [
    "thoughtTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
  ] as const satisfies readonly (keyof NonNullable<TaskDto["usage"]>)[]) {
    const n = raw[key];
    if (Number.isFinite(n)) usage[key] = n as number;
  }
  if (
    typeof raw._meta === "object" &&
    raw._meta !== null &&
    !Array.isArray(raw._meta)
  ) {
    usage._meta = raw._meta as Record<string, unknown>;
  }
  return usage;
}

/** The contract's warnings, keeping only `{kind, text}` entries. `undefined`
 *  when nothing is left, so a junk array is omitted rather than served as
 *  `[]` — the same rule as every other gap (C2). */
function warningsOf(value: unknown): TaskDto["warnings"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const warnings = value.flatMap((w) =>
    typeof w?.kind === "string" && typeof w?.text === "string"
      ? [{ kind: w.kind, text: w.text }]
      : [],
  );
  return warnings.length > 0 ? warnings : undefined;
}

/** One task, live or restored, as the contract carries it (M2-6, M5-2). `id`
 *  and `status` are trusted — for a record, by the guard in `restoreRuns`.
 *  Every other field is copied only when the contract names it and its value
 *  has the contract's type: a `run.json` anyone can edit must not put an
 *  unknown key, or a known key with a wrong value, on the wire, and
 *  `"warnings": 5` crashed `attach`'s `printTask`. A field the source does
 *  not have, or has with the wrong type, is left out, never `null` (C2). */
function toTaskDto(task: { id: string; status: string }): TaskDto {
  const t: Record<string, unknown> = { ...task };
  const dto: TaskDto = { id: task.id, status: task.status };
  for (const key of STRING_KEYS) {
    const value = t[key];
    if (typeof value === "string") dto[key] = value;
  }
  const durationMs = t[TYPED_KEYS.durationMs];
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    dto.durationMs = durationMs;
  }
  const usage = usageOf(t[TYPED_KEYS.usage]);
  if (usage !== undefined) dto.usage = usage;
  const usageSemantics = t[TYPED_KEYS.usageSemantics];
  if (
    typeof usageSemantics === "string" &&
    USAGE_SEMANTICS.has(usageSemantics)
  ) {
    dto.usageSemantics = usageSemantics as TaskDto["usageSemantics"];
  }
  const warnings = warningsOf(t[TYPED_KEYS.warnings]);
  if (warnings !== undefined) dto.warnings = warnings;
  if (t[TYPED_KEYS.summarySynthesised] === true) dto.summarySynthesised = true;
  return dto;
}

/** One run as the daemon holds it. The wire reply is `RunDto`, built by
 *  `toRunDto`: a live run's `report` and the record-level fields stay off the
 *  wire. Live runs are built here; finished ones are read back from their
 *  `run.json` at boot (M2-6, #36). Notices keep every line, containment
 *  included: #13 says those are never suppressed, and with no terminal this
 *  record is where they survive. */
interface RunState {
  id: string;
  cwd: string;
  root: string;
  status: RunStatus;
  source: "live" | "restored";
  startedAt?: string;
  endedAt?: string;
  /** A live run's final report (`core/run.ts`). Flattened by `toRunDto`. */
  report?: RunReport;
  error?: string;
  cancelRequested?: true;
  notices: (Notice & { taskId: string })[];
  /** The record-level list: `queued`/`running` entries while live, the
   *  restored record after a boot. */
  tasks: TaskDto[];
}

/** The wire shape of one run: a live run's `report` flattened onto the same
 *  fields a restored record carries. A gap is omitted, never `null`. */
function toRunDto(state: RunState): RunDto {
  const dto: RunDto = {
    id: state.id,
    cwd: state.cwd,
    root: state.root,
    status: state.status,
    source: state.source,
    notices: state.notices,
    tasks: state.report ? state.report.tasks.map(toTaskDto) : state.tasks,
  };
  if (state.startedAt !== undefined) dto.startedAt = state.startedAt;
  if (state.endedAt !== undefined) dto.endedAt = state.endedAt;
  if (state.report) {
    dto.durationMs = state.report.durationMs;
    dto.turns = state.report.turns;
  }
  if (state.error !== undefined) dto.error = state.error;
  if (state.cancelRequested) dto.cancelRequested = true;
  return dto;
}

/** One `GET /runs` entry: the shared run fields plus id/status per task. */
function toRunListEntry(state: RunState): RunListEntry {
  const entry: RunListEntry = {
    id: state.id,
    cwd: state.cwd,
    root: state.root,
    status: state.status,
    source: state.source,
    tasks: state.tasks.map(({ id, status }) => ({ id, status })),
  };
  if (state.startedAt !== undefined) entry.startedAt = state.startedAt;
  if (state.endedAt !== undefined) entry.endedAt = state.endedAt;
  return entry;
}

const runs = new Map<string, RunState>();
/** Every run still in flight, so a shutdown can wait for them to settle. */
const inFlight = new Set<Promise<void>>();
/** Kept beside the record rather than on it, so a `GET` never serialises one. */
const cancels = new Map<string, AbortController>();
/** Settles once `runRun` hands over the log, or with `undefined` when the run
 *  ended without one — a preflight that threw, or a state dir it could not
 *  make. A `GET /events` that arrives first waits here rather than 404ing a
 *  run that exists. */
const eventLogs = new Map<string, Promise<EventLog | undefined>>();
/** `events.jsonl` on disk, by run id, for runs restored at boot. Held as a
 *  path rather than an open log: opening one scans the whole file, and most
 *  restored runs are never asked for. */
const restoredLogs = new Map<string, string>();

/**
 * Read every added repository's finished runs back into memory (M2-6, #36).
 *
 * Run state lives in each repository's own workspace under
 * `stateDirFor(root)`, so the scan follows the repository list rather than a
 * second index. Anything unreadable is skipped with a notice naming the path
 * and the reason: a run whose
 * record is missing, truncated by a crash or not ours is exactly what M2-5's
 * sweep exists to reconcile, and a daemon that refused to boot over one
 * could not be reached by the request that fixes it. A repository whose
 * runs directory does not exist yet gets no notice — nothing was skipped.
 *
 * **Only terminal runs.** A record still saying `running` belongs to a
 * process that is gone; calling it live here would list a run nothing is
 * running and hand `DELETE` a canceller that does not exist. The M2-5 sweep
 * ran just before this scan and rewrote those to `failed`; the guard below is
 * for a record the sweep could not write.
 */
function restoreRuns(): void {
  for (const root of repos) {
    const dir = join(stateDirFor(root), "runs");
    let ids: string[];
    try {
      ids = readdirSync(dir);
    } catch (err) {
      // ENOENT is a runs directory that is simply not there (the repository
      // never ran, or the directory was removed): no records exist to skip,
      // so it stays quiet. Anything else (permission, not-a-directory) is a
      // real skip and gets the notice.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`skipping runs under ${dir}: ${messageOf(err)}`);
      }
      continue;
    }
    for (const id of ids) {
      const logDir = join(dir, id);
      const recordPath = join(logDir, "run.json");
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(readFileSync(recordPath, "utf8"));
      } catch (err) {
        console.error(`skipping ${recordPath}: ${messageOf(err)}`);
        continue;
      }
      if (record?.runId !== id) {
        console.error(`skipping ${recordPath}: runId is not ${id}`);
        continue;
      }
      const status = record.status;
      if (typeof status !== "string") {
        console.error(`skipping ${recordPath}: no status in the record`);
        continue;
      }
      // The sweep rewrote these to `failed` before this scan, so one left
      // here is a record it could not write; expected after a crash, silent.
      if (status === "running") continue;
      const state: RunState = {
        id,
        cwd: typeof record.cwd === "string" ? record.cwd : root,
        root: typeof record.root === "string" ? record.root : root,
        // The record is one we wrote, so its status is a `RunStatus`. A
        // hand-edited one reaches the API unaltered rather than failing a boot.
        status: status as RunStatus,
        source: "restored",
        notices: [],
        tasks: [],
      };
      if (
        typeof record.startedAt === "string" &&
        Number.isFinite(Date.parse(record.startedAt))
      ) {
        state.startedAt = record.startedAt;
      }
      if (
        typeof record.endedAt === "string" &&
        Number.isFinite(Date.parse(record.endedAt))
      ) {
        state.endedAt = record.endedAt;
      }
      if (Array.isArray(record.tasks)) {
        // Trusted for its runId and status, but a hand-edited `tasks` can
        // still hold junk, and the route destructures every element: one
        // `[null]` would 500 the whole list, and `{foo: "bar"}` would print
        // as `undefined undefined` in `kapelle ps`. Keep the run, drop any
        // element without a string id and status (M2-6: a boot answers anyway).
        state.tasks = record.tasks.flatMap((t) =>
          typeof t?.id === "string" && typeof t?.status === "string"
            ? [toTaskDto(t)]
            : [],
        );
      }
      runs.set(id, state);
      restoredLogs.set(id, join(logDir, "events.jsonl"));
    }
  }
}

// M2-5 (#35): reconcile the previous daemon's debris before anything is
// restored or served. This rewrites a record left `running` to `failed` with
// a fresh `endedAt`, so the scan below sees it as terminal; worktrees and runs
// inside the retention window are left alone.
// The real handlers are installed further down, once `server` and the run
// registry exist. Until then a ^C through a slow sweep — git across several
// repositories, half a second per surviving pid — would take the default kill
// and leave the claim file that `claim()` has already written, the one state
// M2-4 works to avoid. These two do that much and no more: there is no run to
// cancel yet.
const bailOut = () => {
  rmSync(file, { force: true });
  process.exit(0);
};
process.once("SIGTERM", bailOut);
process.once("SIGINT", bailOut);

/**
 * The boot sweep's one question, on a TTY (#129).
 *
 * Its own readline, opened and closed per question, because this runs once
 * before `listen` and nothing else on this process owns stdin yet —
 * `core/policy.ts`'s asker is for a live run and holds its interface open.
 */
function askBoot(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return rl
    .question(`${question} [y/N] `)
    .then((answer) => /^y(es)?$/i.test(answer.trim()))
    .finally(() => rl.close());
}

await sweepBoot({
  repos: addedRepos,
  childrenFile: join(dir, "children.json"),
  onNotice: (text) => console.error(text),
  // Only on a TTY — `kapelle daemon start` has one, a background daemon does
  // not, and a question nobody can answer would hang the boot. Without it
  // `sweepStranded` reports and keeps, which is the safe half (#129).
  ask: process.stdin.isTTY ? askBoot : undefined,
});

process.off("SIGTERM", bailOut);
process.off("SIGINT", bailOut);

// At import, before the port opens: a request must never meet a half-restored
// list. ponytail: synchronous and O(runs ever kept) — one `readdir` plus one
// small `readFile` per run, on the boot path only. Move it behind `listen` (or
// read the newest N) if a repository with thousands of kept runs makes the
// daemon slow to answer.
restoreRuns();

/** The log of a run that ended before this daemon started, opened on first
 *  ask and cached with the live ones. */
function restoredLog(id: string): Promise<EventLog | undefined> | undefined {
  const path = restoredLogs.get(id);
  if (path === undefined) return undefined;
  // A log that cannot be opened — never written, or removed since — settles
  // as `undefined`, which `getEvents` already answers as a 404.
  const opened = openEventLog(path).catch(() => undefined);
  eventLogs.set(id, opened);
  return opened;
}

/**
 * Every live harness, by pid (M2-4, #34), mirrored to `children.json` beside
 * `daemon.json` for M2-5's sweep to read after a crash.
 *
 * A crash is covered without it: every measured harness exits when its stdin
 * closes, and the kernel closes that pipe when the daemon dies. The file is
 * the record for a harness build that does not. Removed once nothing is live,
 * so a file that is there after a daemon died names only what was running.
 */
interface Child {
  pid: number;
  /** Which kind of owner spawned it: a run's task, or a room's participant.
   *  S14 renamed the two id fields so one file serves both; the sweep reads a
   *  legacy `{pid, runId, taskId}` entry as a run. */
  kind: "run" | "room";
  ownerId: string;
  unitId: string;
  /** `ps`'s start time, filled in once it answers; see the spawn listener. */
  startedAt?: string;
}

const children = new Map<number, Child>();
const childrenFile = join(dir, "children.json");

// Each entry carries the process's start time (M2-5): the sweep signals a pid
// only when `ps` still reports the same start, so a reused pid is left alone.
function recordChildren(): void {
  try {
    if (children.size === 0) {
      rmSync(childrenFile, { force: true });
      return;
    }
    const tmp = `${childrenFile}.tmp`;
    // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
    // pi-lens-ignore: no-raw-json-store-write
    writeFileSync(
      tmp,
      JSON.stringify({ pid: process.pid, children: [...children.values()] }),
      { mode: 0o600 },
    );
    renameSync(tmp, childrenFile);
  } catch (err) {
    console.error(
      `cannot record harness pids in ${childrenFile}: ${messageOf(err)}`,
    );
  }
}

/**
 * Every `ask` decision the daemon is waiting on, across all runs (M2-3, #33).
 * An unanswered one is denied after `--permission-timeout`, so an `ask` run
 * with nobody attached completes instead of hanging.
 */
const permissions = createPermissionQueue(permissionTimeoutMs);

/**
 * Mirrors a bus's harness pids into `children.json` for the next boot's sweep
 * (M2-4, #34). One listener for both owners: `kind` tells a run from a room,
 * `ownerId` is the run or room id and `unitId` the task or participant (S14).
 */
function trackChildren(
  bus: ReturnType<typeof createEventBus>,
  kind: Child["kind"],
  ownerId: string,
) {
  bus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "_client_harness_spawned") {
      // The start time is the sweep's proof that a surviving pid is still
      // this harness and not a recycled pid (M2-5). `undefined` when `ps`
      // cannot answer before the harness exits: the sweep then leaves the pid
      // alone rather than signal a stranger.
      const entry: Child = { pid: update.pid, kind, ownerId, unitId: agent };
      children.set(update.pid, entry);
      recordChildren();
      // Filled in after the fact, never inline: `processIdentity` shells out
      // to `ps`, and doing that synchronously here would stall every other
      // run's SSE writes and permission answers on each harness spawn. The
      // entry is filled in after the fact, so a crash inside that window is
      // the known no-identity outcome: the next boot cannot safely signal the
      // pid and can only name it in a notice, leaving it alive. Conservative,
      // not a free window; `_client_harness_exited` still drops the entry
      // when the harness exits normally.
      void processIdentity(update.pid).then((startedAt) => {
        if (startedAt === null || children.get(update.pid) !== entry) return;
        entry.startedAt = startedAt;
        recordChildren();
      });
    } else if (update.sessionUpdate === "_client_harness_exited") {
      children.delete(update.pid);
      recordChildren();
    }
  });
}

async function postRepo(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req, ["path"]);
  // Since #129 a repository cannot be in a state that refuses a run, so this
  // only resolves the root. The 409 that used to live here — a tracked or
  // unignored `.kapelle/` — is gone with the state that caused it.
  const { root } = await stateDirRoot(existingDir(body.path, "path"));
  // M2-7: a config that does not load is refused at add time, naming the file
  // and key, rather than at the repository's first run.
  try {
    readProjectConfig(root);
  } catch (err) {
    throw refusal(400, "invalid_config", messageOf(err));
  }
  // Persisted before the 200 and before the in-memory add: a caller told its
  // repository was added must not find it gone after a restart, and a failed
  // write must not leave memory ahead of disk. Hence the copy — it is what
  // lets the write happen first, and it dedups a repository added twice.
  const next = new Set(repos).add(root);
  writeRepos([...next]);
  repos.add(root);
  send(res, 200, { root } satisfies RepoAdded);
}

/**
 * The repository root `cwd` belongs to, or a 403 for a folder outside every
 * added one. `stateDirRoot` never throws, so an unadded folder is told to add
 * itself rather than to fix something else. Shared by `POST /runs` and
 * `POST /rooms`, which refuse in the same order.
 */
async function refuseUnadded(cwd: string): Promise<string> {
  const { root } = await stateDirRoot(cwd);
  if (!repos.has(root)) {
    throw refusal(
      403,
      "repo_not_added",
      `${root} has not been added to the daemon. POST /repos ` +
        `{"path": ${JSON.stringify(root)}} first.`,
    );
  }
  return root;
}

async function postRun(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req, ["cwd", "run"]);
  const cwd = existingDir(body.cwd, "cwd");
  const root = await refuseUnadded(cwd);

  // M2-7: project config and `KAPELLE_*` supply the run-file defaults. Two
  // codes for two 400s, because the fix is in a different file: the
  // repository's config, or the run file the client sent.
  let defaults: ReturnType<typeof resolveRunDefaults>;
  try {
    defaults = resolveRunDefaults(root);
  } catch (err) {
    throw refusal(400, "invalid_config", messageOf(err));
  }
  let run: Run;
  try {
    run = validateRun(body.run, AGENTS, defaults);
  } catch (err) {
    throw refusal(400, "invalid_run", messageOf(err));
  }

  // No preflight before the 202 any more (#129). It existed to answer the two
  // 409s — an unsafe `.kapelle/`, a dirty tree — that this daemon no longer
  // has, and it cost about ten git spawns per run to repeat what `runRun`
  // does anyway (measured on #107).
  const id = newRunId();

  // After the last await, so no run can start once a shutdown has begun.
  if (stopping) {
    throw refusal(503, "shutting_down", "the daemon is shutting down");
  }

  const state: RunState = {
    id,
    cwd,
    root,
    status: "running",
    source: "live",
    startedAt: new Date().toISOString(),
    notices: [],
    tasks: [],
  };
  const bus = createEventBus();
  trackChildren(bus, "run", id);
  bus.addListener(({ agent, update }) => {
    if (update.sessionUpdate === "_client_task_finished") {
      // A task the watchdog's TTL cut leaves decisions nobody can act on: its
      // harness is gone and the run-wide signal has not fired, because the
      // siblings are still running. The task's own end is the sturdy hook —
      // a cancelled harness asks again on its way out (measured against
      // `mock-agent.mjs`: a second request arrives after `session/cancel`),
      // so denying at the cancel would leave that one listed until the timeout.
      permissions.denyTask(id, agent);
    }
  });
  const canceller = new AbortController();
  runs.set(id, state);
  cancels.set(id, canceller);
  let settleLog: (log?: EventLog) => void = () => {};
  eventLogs.set(
    id,
    new Promise((ok) => {
      settleLog = ok;
    }),
  );
  const done = runRun(run, {
    cwd,
    runId: id,
    bus,
    signal: canceller.signal,
    onEventLog: settleLog,
    askPolicy: permissions.policyFor(id, bus, canceller.signal),
    onTasks: (tasks) => {
      state.tasks = tasks.map(toTaskDto);
    },
    onNotice: (taskId, text, kind) => {
      state.notices.push(kind ? { taskId, text, kind } : { taskId, text });
    },
  })
    .then(
      (report) => {
        state.status = report.status;
        state.report = report;
        state.endedAt = new Date().toISOString();
      },
      (err) => {
        state.status = "failed";
        state.error = messageOf(err);
        state.endedAt = new Date().toISOString();
      },
    )
    .finally(() => {
      // A task the watchdog cut can leave a decision behind; the run is over,
      // so deny it now rather than list it until the timer.
      canceller.abort();
      cancels.delete(id);
      inFlight.delete(done);
      settleLog(undefined);
    });
  inFlight.add(done);
  send(res, 202, { id } satisfies RunAccepted);
}

/**
 * `GET /runs/:id/events` — every event of the run, then the live tail, as SSE
 * (M2-2, #32). Each event's `id:` is its `seq`, so a reconnecting client's
 * `Last-Event-ID` resumes at the next one. The stream ends when the run does.
 */
async function getEvents(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  // Before any await: a client that leaves while the log is still pending
  // must not leave a reader behind for the rest of the run.
  const gone = new AbortController();
  res.on("close", () => gone.abort());

  const pending = eventLogs.get(id) ?? restoredLog(id);
  if (!pending) throw refusal(404, "run_not_found", `no run ${id}`);
  const log = await pending;
  if (!log) {
    throw refusal(404, "no_event_log", `run ${id} has no event log`);
  }
  await streamLog(log, req, res, gone.signal);
}

/** SSE over one event log: replay after `Last-Event-ID`, then the live tail,
 *  ending when the log closes. Shared by runs and rooms. */
async function streamLog(
  log: EventLog,
  req: IncomingMessage,
  res: ServerResponse,
  signal: AbortSignal,
) {
  const header = req.headers["last-event-id"];
  const after = header === undefined ? 0 : Number(header);
  if (!Number.isInteger(after) || after < 0 || after > log.size) {
    throw refusal(
      400,
      "invalid_request",
      `Last-Event-ID must be a whole number from 0 to ${log.size}; got ${header}`,
    );
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  // Headers go out now, not on the first write: a reconnecting client whose
  // `Last-Event-ID` is already the tail has no history to replay, and without
  // this it would sit in "connecting" until the next event.
  res.flushHeaders();
  try {
    await log.follow(
      after,
      (seq, line) => res.write(`id: ${seq}\ndata: ${line}\n\n`),
      signal,
    );
  } catch {
    // Headers are sent, so no error body can follow. A cut stream is what
    // tells an SSE client to reconnect with its `Last-Event-ID`.
    res.destroy();
    return;
  }
  res.end();
}

/** One chat room as the API reports it, less the live `status`. In memory
 *  only, like a run. */
type RoomState = Omit<RoomView, "status">;

const rooms = new Map<
  string,
  /** `dismissed` is set only once a `DELETE` has *finished* tearing the room
   *  down, so it tells a settled close from one still in flight. */
  { room: Room; state: RoomState; dismissed?: boolean }
>();

const roomView = ({
  room,
  state,
}: {
  room: Room;
  state: RoomState;
}): RoomView => ({
  ...state,
  status: room.status(),
});

/**
 * `POST /rooms {cwd, agent | cmd}` — a chat room: one harness, kept alive
 * until `DELETE` (chat MVP). The refusals keep `POST /runs`'s order — not
 * added (403), then a bad harness (400) — and the answer waits for the
 * harness's session, so a harness that cannot start is this request's error,
 * not a room that is silently dead.
 * Always `auto`: the MVP has no one to answer a permission prompt.
 */
async function postRoom(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req, ["cwd", "agent", "cmd"]);
  const cwd = existingDir(body.cwd, "cwd");
  await refuseUnadded(cwd);

  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  let spec: ReturnType<typeof roomHarness>;
  try {
    spec = roomHarness(str(body.agent), str(body.cmd));
  } catch (err) {
    throw refusal(400, "invalid_request", messageOf(err));
  }

  const id = newRoomId();
  // No 409 wrapper (#129): since the state directory moved out of the
  // repository, `openWorktrees` throws for nothing a repository can be in.
  const setup = await openWorktrees(cwd, id);
  if (stopping) {
    throw refusal(503, "shutting_down", "the daemon is shutting down");
  }

  const notices: RoomState["notices"] = [];
  const bus = createEventBus();
  trackChildren(bus, "room", id);
  let room: Room;
  try {
    room = await openRoom({
      roomId: id,
      cwd,
      spec,
      setup,
      bus,
      onNotice: (text, kind) => notices.push(kind ? { text, kind } : { text }),
    });
  } catch (err) {
    throw refusal(500, "room_open_failed", messageOf(err));
  }
  // A shutdown that began while the harness was starting has already closed
  // every room it knew of; this one must not outlive the daemon.
  if (stopping) {
    await room.close();
    throw refusal(503, "shutting_down", "the daemon is shutting down");
  }
  const state: RoomState = {
    id,
    cwd,
    harness: room.harness,
    workspace: room.workspace,
    notices,
  };
  const entry = { room, state };
  rooms.set(id, entry);
  send(res, 201, roomView(entry) satisfies RoomView);
}

/**
 * `POST /rooms/:id/messages {text}` — one turn. 202 once the message is on
 * the room's log; the answer arrives on `GET /rooms/:id/events`. `seq` is the
 * log's size before the message, so a client waits for the first
 * `_client_turn_ended` after it rather than one it is still replaying.
 */
async function postMessage(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const entry = rooms.get(id);
  if (!entry) throw refusal(404, "room_not_found", `no room ${id}`);
  const { text } = await readBody(req, ["text"]);
  if (typeof text !== "string" || !text.trim()) {
    throw refusal(400, "invalid_request", '"text" must be a non-empty string');
  }
  const seq = entry.room.eventLog?.size ?? 0;
  let turn: Promise<void>;
  try {
    turn = entry.room.send(text);
  } catch (err) {
    // `send` refuses a live turn (`busy`) or a room that is over; the status
    // is read after the throw, so the code names the refusal that happened.
    const code = entry.room.status() === "busy" ? "room_busy" : "room_closed";
    throw refusal(409, code, messageOf(err));
  }
  // Settles with the turn; a failed turn is already on the log as an event.
  turn.catch(() => {});
  send(res, 202, { seq } satisfies MessageAccepted);
}

/** `POST /permissions/:id {"allow": boolean}` — the first answer wins. */
async function postPermission(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const { allow } = await readBody(req, ["allow"]);
  if (typeof allow !== "boolean") {
    throw refusal(
      400,
      "invalid_request",
      `"allow" must be true or false; got ${allow}`,
    );
  }
  const result = permissions.answer(id, allow);
  if (result === "unknown") {
    throw refusal(404, "permission_not_found", `no permission ${id}`);
  }
  // A defined error, not an overwrite: someone else's answer, the timeout or
  // a cancel already decided it, and the harness has been told.
  if (result === "settled") {
    throw refusal(
      409,
      "already_decided",
      `permission ${id} was already decided`,
    );
  }
  send(res, 200, { id, allow } satisfies PermissionAnswered);
}

/** A parse base for `req.url`, which is a path, not a URL. Never fetched;
 *  named as a constant so it is not mistaken for a configurable endpoint. */
const REQUEST_URL_BASE = "http://daemon";

async function route(req: IncomingMessage, res: ServerResponse) {
  // Before the token and every route: a forged, duplicated or missing Host is
  // refused here. requireHostHeader: false lets this guard handle the last.
  const authority = authorityOf(req);
  if (authority === null || !LOOPBACK_HOST.test(authority)) {
    throw refusal(403, "host_not_allowed", "host not allowed");
  }
  if (!authorised(req)) {
    throw refusal(401, "unauthorized", "missing or wrong token");
  }
  const { pathname } = new URL(req.url ?? "/", REQUEST_URL_BASE);
  const one = /^\/runs\/([^/]+)$/.exec(pathname);
  const events = /^\/runs\/([^/]+)\/events$/.exec(pathname);
  const decision = /^\/permissions\/([^/]+)$/.exec(pathname);
  const room = /^\/rooms\/([^/]+)$/.exec(pathname);
  const roomSub = /^\/rooms\/([^/]+)\/(events|messages)$/.exec(pathname);

  if (req.method === "GET" && pathname === "/version") {
    send(res, 200, {
      apiVersion: API_VERSION,
      capabilities: [...CAPABILITIES],
    } satisfies VersionReply);
  } else if (req.method === "POST" && pathname === "/repos") {
    await postRepo(req, res);
  } else if (req.method === "GET" && pathname === "/repos") {
    send(res, 200, [...repos] satisfies RepoRoots);
  } else if (req.method === "POST" && pathname === "/runs") {
    await postRun(req, res);
  } else if (req.method === "GET" && pathname === "/runs") {
    send(
      res,
      200,
      [...runs.values()].map(toRunListEntry) satisfies RunListEntry[],
    );
  } else if (req.method === "POST" && pathname === "/rooms") {
    await postRoom(req, res);
  } else if (req.method === "GET" && pathname === "/rooms") {
    send(res, 200, [...rooms.values()].map(roomView) satisfies RoomView[]);
  } else if (req.method === "GET" && room) {
    const entry = rooms.get(room[1] as string);
    if (!entry) throw refusal(404, "room_not_found", `no room ${room[1]}`);
    send(res, 200, roomView(entry) satisfies RoomView);
  } else if (req.method === "POST" && roomSub?.[2] === "messages") {
    await postMessage(roomSub[1] as string, req, res);
  } else if (req.method === "GET" && roomSub?.[2] === "events") {
    const entry = rooms.get(roomSub[1] as string);
    if (!entry) throw refusal(404, "room_not_found", `no room ${roomSub[1]}`);
    const log = entry.room.eventLog;
    if (!log) {
      throw refusal(404, "no_event_log", `room ${roomSub[1]} has no event log`);
    }
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    await streamLog(log, req, res, gone.signal);
  } else if (req.method === "DELETE" && room) {
    // Synchronous, unlike a run's cancel: dismissing waits for the harness to
    // stop and the checkout to be released — kept, never committed (R37) —
    // which `stop()` bounds at 5 s.
    const entry = rooms.get(room[1] as string);
    if (!entry) {
      throw refusal(404, "room_not_found", `no room ${room[1]}`);
    } else if (entry.dismissed) {
      throw refusal(409, "room_closed", `room ${room[1]} is already dismissed`);
    } else {
      // **Not `status() === "closed"`**, which reads `closed` the instant a
      // close begins: a second DELETE arriving mid-teardown would then be told
      // the room was already dismissed while its harness was still alive and
      // its checkout unreleased, which is exactly what S6(a) promises does not
      // happen. `close()` hands every caller the same promise, so two racing
      // dismissals both wait for the one teardown and both get their 200.
      // `dismissed` is set after the await, so only a request that arrives
      // once the close has settled is refused.
      await entry.room.close();
      entry.dismissed = true;
      send(res, 200, roomView(entry) satisfies RoomView);
    }
  } else if (req.method === "GET" && events) {
    await getEvents(events[1] as string, req, res);
  } else if (req.method === "GET" && one) {
    const state = runs.get(one[1] as string);
    if (!state) throw refusal(404, "run_not_found", `no run ${one[1]}`);
    send(res, 200, toRunDto(state) satisfies RunDto);
  } else if (req.method === "GET" && pathname === "/permissions") {
    send(res, 200, permissions.list() satisfies PendingDecision[]);
  } else if (req.method === "POST" && decision) {
    await postPermission(decision[1] as string, req, res);
  } else if (req.method === "DELETE" && one) {
    // Asynchronous on purpose: cancel is cooperative, so the answer is an
    // acknowledgement and `GET` reports the verdict. `core/run.ts` stops a
    // harness 2 s after the abort, so no timer is needed here.
    const id = one[1] as string;
    const state = runs.get(id);
    const canceller = cancels.get(id);
    if (!state) {
      throw refusal(404, "run_not_found", `no run ${id}`);
    } else if (!canceller) {
      throw refusal(
        409,
        "run_ended",
        `run ${id} already ended: ${state.status}`,
      );
    } else {
      canceller.abort();
      state.cancelRequested = true;
      send(res, 202, toRunDto(state) satisfies RunDto);
    }
  } else {
    throw refusal(404, "no_route", `no route for ${req.method} ${pathname}`);
  }
}

/**
 * J3: a request not fully received in 30 s gets Node's own `408 Request
 * Timeout`, with an empty body, and its connection is closed. Node sends it,
 * not `route`, so it is the one exception to the envelope, with Node's reply
 * to malformed HTTP. It covers receiving the request only: a slow reply and an
 * SSE stream are never cut (measured 2026-09-23). Node checks every 30 s, so
 * the 408 lands between 30 and 60 s.
 */
const server = createServer(
  { requireHostHeader: false, requestTimeout: 30_000 },
  (req, res) => {
    route(req, res).catch((err) => {
      const { status, code } =
        err instanceof Refusal
          ? err
          : ({ status: 500, code: "internal" } as const);
      // A refusal sent before the body was read (a 413, a 415, a 404 on a
      // write) leaves the rest to Node, which reads and discards it, bounded
      // by `requestTimeout`. Never `connection: close`: the client is often
      // still uploading, and a close then reaches it as EPIPE instead of this
      // reply (measured 2026-09-23, 4 runs in 10 on one core).
      send(res, status, {
        error: { code, message: messageOf(err) },
      } satisfies ErrorReply);
    });
  },
);

let stopping = false;

/**
 * SIGTERM or SIGINT: cancel every run, wait for each to settle, then remove
 * `daemon.json` and exit 0 (M2-4, #34).
 *
 * No kill loop of its own. A cancelled task stops its harness through
 * `core/run.ts` (2 s after the abort), and `AcpAgent.stop()` closes stdin
 * before it ever signals — the only stop that also ends the shell commands a
 * harness started. Waiting on the runs is what waits on their harnesses, and
 * it is also what lets each worktree be released.
 */
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: cancelling ${inFlight.size} run(s), then exiting`);
  server.close();
  for (const canceller of cancels.values()) canceller.abort();
  await Promise.all([
    ...inFlight,
    ...[...rooms.values()].map(({ room }) => room.close()),
  ]);
  rmSync(file, { force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

server.on("error", (err) => {
  rmSync(file, { force: true });
  console.error(`cannot listen on 127.0.0.1:${port}: ${messageOf(err)}`);
  process.exit(1);
});

// The token is published only once the port is open, so a client never reads
// a token for a daemon that is not listening.
server.listen(port, "127.0.0.1", () => {
  const { port: bound } = server.address() as AddressInfo;
  // Published atomically: `rename` never exposes a half-written record, and
  // the claim file it replaces already names this live pid, so a second
  // starter reads a live pid at either end of the swap. Truncating this file
  // in place left it empty for an instant — the state `claim` treats as stale
  // — and let a second daemon take over a running one (M2-4, #34).
  const tmp = `${file}.tmp`;
  // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
  // pi-lens-ignore: no-raw-json-store-write
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, port: bound, token }), {
    mode: 0o600,
  });
  renameSync(tmp, file);
  closeSync(fd);
  console.log(`listening on http://127.0.0.1:${bound} (token in ${file})`);
});
