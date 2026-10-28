/**
 * The login check and the saved models (M9-4, #299).
 *
 * **A check session** starts one ready agent in a new temporary folder:
 * `initialize` and `session/new`, with no prompt, so no tokens. It reads the
 * model list from the `configOptions` entry with `category: "model"`, works
 * out the login state, deletes the session when the agent can, and stops the
 * agent. Every check has a time limit. A temporary folder, so a project's own
 * settings (pi and opencode read them) show only in a real session there.
 *
 * **`login` means "this agent can open a session and use its models"**, not
 * "the person has an account" (decided by the person, 2026-10-28). So
 * opencode is `ok` whenever `session/new` opens, free models included.
 *
 * **The login state comes from each agent's own signal** (§Models and login,
 * `loginSignal` in the registry). `-32000` on `session/new` is "logged out"
 * for every agent: pi, codex and kimi send it. claude opens a session logged
 * out and says so in `_auth/status_update` with `kind: "none"`, so its check
 * waits for that notice. copilot never says: `unknown`. A check that fails
 * or runs out of time is `unknown` too.
 *
 * **A real room session keeps the file fresh at no cost** (decided
 * 2026-10-28): `noteSession` takes what its `session/new` and its notices
 * already said. Nothing waits for it.
 *
 * The file holds facts only, as `harnesses.json` does. The login hint comes
 * from today's registry when it is read. Never an account field: only the
 * notice's kind leaves `AcpAgent`, and only the state is saved.
 *
 * **The file is a cache.** A write that fails is dropped, in one place
 * (`saveCheck`): no check, route or room fails over it, and the next check
 * writes it again.
 */

import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpAgent, RpcError } from "../protocol/agent.ts";
import {
  AGENTS,
  type AgentEntry,
  resolveEnv,
  type SetupSpec,
} from "../protocol/registry.ts";
import type { SessionConfigOption } from "../protocol/types.ts";
import { describe, type Setup } from "./harnesses.ts";
import { stateDir } from "./runtime.ts";

type Login = "ok" | "logged_out" | "unknown";

interface Model {
  id: string;
  name: string;
}

/** One agent in `checks.json`. */
export interface AgentCheck {
  /** When a check or a real session last said something. */
  checkedAt: string;
  /** The ACP program's version the find saw at the last check. A real
   *  session keeps it. */
  version?: string;
  login: Login;
  models?: Model[];
  model?: string;
}

/** What a session said: a check's whole result, or part of one. */
export type Seen = Partial<Pick<AgentCheck, "login" | "models" | "model">>;

/** How long one check may take. claude's own login probe may take 5 s
 *  before its notice comes; the slowest start measured is 3.5 s. */
const CHECK_TIMEOUT_MS = 15_000;

/** `session/new` failed this way: log in first (§Models and login). */
const AUTH_REQUIRED = -32000;

const authRequired = (err: unknown) =>
  err instanceof RpcError && err.code === AUTH_REQUIRED;

/** The model list and the current model, from `session/new`'s options. A
 *  grouped list is made flat. Nothing when there is no model option. */
function modelsOf(options: SessionConfigOption[]): Seen {
  const o = options.find((x) => x.category === "model");
  if (o?.type !== "select" || !Array.isArray(o.options)) return {};
  const models = o.options
    .flatMap((x) => ("options" in x ? x.options : [x]))
    .map(({ value, name }) => ({ id: value, name }));
  return { models, model: o.currentValue };
}

/** The login state a notice's kind gives. */
const fromNotice = (kind: string): Login =>
  kind === "none" ? "logged_out" : "ok";

/** The login state an open session gives, with no notice: `ok` where a
 *  logged-out agent fails `session/new`, else nothing yet (claude's notice
 *  says it) or `unknown` (copilot). */
function fromSession(setup: SetupSpec): Login | undefined {
  if (setup.loginSignal === "notice") return undefined;
  return setup.loginSignal === "none" ? "unknown" : "ok";
}

/** Checks that are running, so the daemon's shutdown can stop them too. */
const runningChecks = new Set<{
  cancel: () => void;
  done: Promise<void>;
}>();

/** Bumped by `stopChecks`, so a canceled run does not save its unknown result. */
let checkGeneration = 0;

/**
 * Cancels every check in flight and resolves once each has stopped its harness
 * and finished its own cleanup. The daemon calls this on shutdown, as it does
 * `stopNpmInstalls`, so no check outlives the process.
 */
export async function stopChecks(): Promise<void> {
  checkGeneration += 1;
  const active = [...runningChecks];
  for (const check of active) check.cancel();
  await Promise.all(active.map(({ done }) => done));
}

/** Runs one check session. Never throws: what went wrong is `unknown`. */
export async function checkAgent(
  launch: AgentEntry["launch"],
  setup: SetupSpec,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<Seen & { login: Login }> {
  let cwd: string;
  try {
    cwd = mkdtempSync(join(tmpdir(), "kapelle-check-"));
  } catch {
    return { login: "unknown" };
  }
  let notice: string | undefined;
  let heard: (kind: string) => void = () => {};
  const noticed = new Promise<string>((ok) => {
    heard = ok;
  });
  const agent = new AcpAgent({
    name: setup.program,
    command: launch.command,
    args: launch.args,
    env: resolveEnv(launch.env),
    cwd,
    requestTimeoutMs: timeoutMs,
    onAuthStatus: (kind) => {
      notice ??= kind;
      heard(kind);
    },
  });
  let cancel!: () => void;
  const cancelled = new Promise<undefined>((ok) => {
    cancel = () => ok(undefined);
  });
  let finish!: () => void;
  const done = new Promise<void>((ok) => {
    finish = ok;
  });
  const active = { cancel, done };
  runningChecks.add(active);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((ok) => {
    timer = setTimeout(() => ok(undefined), timeoutMs);
  });
  const work = async (): Promise<Seen & { login: Login }> => {
    const init = await agent.start();
    try {
      await agent.newSession();
    } catch (err) {
      if (authRequired(err)) return { login: "logged_out" };
      throw err;
    }
    const seen = modelsOf(agent.configOptions);
    if (init.agentCapabilities?.sessionCapabilities?.delete) {
      await agent.deleteSession().catch(() => {});
    }
    // claude's notice comes after `initialize`, from a probe of its own.
    if (setup.loginSignal === "notice") {
      notice ??= await Promise.race([noticed, late]);
    }
    const login = notice ? fromNotice(notice) : fromSession(setup);
    return { ...seen, login: login ?? "unknown" };
  };
  // The stop below fails what a late `work` still waits on: not unhandled.
  const working = work();
  working.catch(() => {});
  try {
    return (
      (await Promise.race([working, late, cancelled])) ?? { login: "unknown" }
    );
  } catch {
    return { login: "unknown" };
  } finally {
    clearTimeout(timer);
    try {
      await agent.stop();
    } finally {
      // Cleanup is best effort: a harness can make its temporary folder
      // undeletable, but that must not turn the check into a throw.
      await rm(cwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }).catch(() => {});
      runningChecks.delete(active);
      finish();
    }
  }
}

const checksFile = () => join(stateDir(), "checks.json");

/** Real-session writes per agent, so a check that started earlier can tell
 *  that its result is now older and must not replace one. */
const sessionWrites = new Map<string, number>();

/** The saved checks, by agent id. Empty when the file is missing or bad. */
export function readChecks(): Record<string, AgentCheck> {
  try {
    const c: unknown = JSON.parse(readFileSync(checksFile(), "utf8"));
    return typeof c === "object" && c !== null && !Array.isArray(c)
      ? (c as Record<string, AgentCheck>)
      : {};
  } catch {
    return {};
  }
}

/** Changes one agent's entry, atomically. Read and write are synchronous,
 *  so a check and a room session in the same daemon never lose a write.
 *  False when the write failed: the file is a cache, so that is dropped. */
function saveCheck(
  id: string,
  change: (old?: AgentCheck) => AgentCheck,
): boolean {
  const all = readChecks();
  all[id] = change(all[id]);
  try {
    // `stateDir` throws too, on a state folder that is not safe.
    const file = checksFile();
    const tmp = `${file}.tmp`;
    // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
    // pi-lens-ignore: no-raw-json-store-write
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ready agents to check: all of them when `force` (every
 * `POST /harnesses`, decided 2026-10-28), else each one with no saved
 * check (the first start), a new version, or a list missing from an agent
 * that can open a session. One logged out, or unknown, settles: else each
 * chat start would start it again. `POST /harnesses` or a real session
 * updates it. `ok` with no list cannot loop today: every measured harness
 * sends the model option, and an empty one still saves `models: []`.
 */
export function dueForCheck(
  s: Setup,
  checks: Record<string, AgentCheck>,
  force: boolean,
): string[] {
  return describe(s)
    .filter((a) => a.state === "ready")
    .map((a) => a.id)
    .filter((id) => {
      const c = checks[id];
      return (
        force ||
        !c ||
        c.version !== s.found[id]?.acpVersion ||
        (c.login === "ok" && !c.models)
      );
    });
}

/** Checks `ids`, all at the same time, and saves each result whole. */
export async function runChecks(
  ids: string[],
  found: Setup["found"],
  timeoutMs?: number,
): Promise<void> {
  const generation = checkGeneration;
  // A real session can report while a check runs. Remember how many writes
  // each agent had at the start, so the check does not replace a newer one
  // when it finishes.
  const writesAtStart = new Map(
    ids.map((id) => [id, sessionWrites.get(id) ?? 0]),
  );
  const results = await Promise.all(
    ids.map(async (id) => {
      const a = AGENTS[id];
      return [
        id,
        a?.setup ? await checkAgent(a.launch, a.setup, timeoutMs) : undefined,
      ] as const;
    }),
  );
  // A shutdown canceled these checks: its unknown answers are not new facts.
  if (generation !== checkGeneration) return;
  const checkedAt = new Date().toISOString();
  for (const [id, r] of results) {
    if (!r) continue;
    const version = found[id]?.acpVersion;
    const newer = (sessionWrites.get(id) ?? 0) !== writesAtStart.get(id);
    // A newer real session keeps its facts. The version this check ran on is
    // still kept, so the agent is not due again for it.
    saveCheck(id, (old) =>
      newer && old
        ? { ...old, ...(version && { version }) }
        : { checkedAt, ...(version && { version }), ...r },
    );
  }
}

/**
 * What a real room session said (3A, decided 2026-10-28): its models replace
 * the saved ones, and its login state replaces the saved one. The version
 * stays the last check's. An agent kapelle does not look for is skipped.
 */
export function noteSession(id: string, seen: Seen): void {
  if (!Object.hasOwn(AGENTS, id) || !AGENTS[id]?.setup) return;
  if (Object.keys(seen).length === 0) return;
  const saved = saveCheck(id, (old) => ({
    login: "unknown",
    ...old,
    ...seen,
    checkedAt: new Date().toISOString(),
  }));
  if (saved) sessionWrites.set(id, (sessionWrites.get(id) ?? 0) + 1);
}

/** What a room needs to report its session: the models in it, and the
 *  state an open session gives. Only for `session/new`: whether a
 *  `session/load` works logged out is not measured (§Models and login), so
 *  a `loaded` session gives no login state. */
export function sessionSeen(
  setup: SetupSpec,
  options: SessionConfigOption[],
  loaded: boolean,
): Seen {
  const login = loaded ? undefined : fromSession(setup);
  return { ...modelsOf(options), ...(login && { login }) };
}

/** The state a notice gives, for a room. */
export const noticeSeen = (kind: string): Seen => ({ login: fromNotice(kind) });

/** `-32000` on a room's `session/new`: logged out. Nothing for another
 *  error. */
export const failureSeen = (err: unknown): Seen | undefined =>
  authRequired(err) ? { login: "logged_out" } : undefined;

/** The fields a check adds to `GET /harnesses`'s entry. */
interface CheckFields {
  login?: Login;
  loginHint?: string;
  models?: Model[];
  model?: string;
  loginCheckedAt?: string;
}

/** One agent's saved check, as `GET /harnesses` shows it. The hint only
 *  when the person may need it. */
export function checkFields(
  id: string,
  c: AgentCheck | undefined,
): CheckFields {
  if (!c) return {};
  const hint = AGENTS[id]?.setup?.login;
  return {
    login: c.login,
    ...(c.login !== "ok" && hint && { loginHint: hint }),
    ...(c.models && { models: c.models }),
    ...(c.model !== undefined && { model: c.model }),
    loginCheckedAt: c.checkedAt,
  };
}
