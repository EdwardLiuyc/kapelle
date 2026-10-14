/**
 * The M2-7 config: two files and one environment namespace (issue #37).
 *
 * - **User level** — `$XDG_CONFIG_HOME/kapelle/config.json`, for the knobs
 *   that are properties of the daemon rather than of one repository: `port`
 *   and `permissionTimeoutMs`. One daemon serves every added repository
 *   (M2-1), so these cannot come from any one repository's file.
 * - **Project level** — `<root>/.kapelle/config.json`, for the run defaults
 *   (`stallIdleMs`, `stallRepeatCount`, `ttlMs`, `maxConcurrency`), the
 *   retention window and the paths a new worktree links.
 * - **`KAPELLE_*` environment** — above both files, below an explicit CLI flag
 *   or run-file value.
 *
 * **Both files are strict.** An unknown key or a wrong type is refused naming
 * the file and the key: a silently-ignored `stallIdleMs` typo is a watchdog
 * that never fires. A missing file means "no opinion", not an error, and
 * nothing here creates one.
 *
 * **Unknown `KAPELLE_*` names warn and are ignored** rather than refused: the
 * prefix is also the secret namespace (`protocol/registry.ts`'s
 * `SECRET_PREFIX`, stripped from every harness), so a name this module does
 * not know may be a secret rather than a typo. A known name with a bad value
 * is still a refusal.
 */

import { lstatSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { SECRET_PREFIX } from "../protocol/registry.ts";
import type { RunDefaults } from "./runfile.ts";
import { STATE_DIR } from "./worktree.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Every knob a file or a `KAPELLE_*` variable may carry. */
interface ConfigValues {
  port?: number;
  permissionTimeoutMs?: number;
  stallIdleMs?: number;
  stallRepeatCount?: number;
  ttlMs?: number;
  maxConcurrency?: number;
  retentionMs?: number;
  linkPaths?: string[];
}

/** A knob that is a number. `linkPaths` is the one project value that is not. */
type NumericConfigKey = Exclude<keyof ConfigValues, "linkPaths">;

/** The per-run defaults. `retentionMs` is the other repository-level knob;
 *  `PROJECT_KEYS` adds it just below. */
const RUN_DEFAULT_KEYS = [
  "stallIdleMs",
  "stallRepeatCount",
  "ttlMs",
  "maxConcurrency",
] as const satisfies readonly (keyof RunDefaults)[];

const USER_KEYS = ["port", "permissionTimeoutMs"] as const;
const PROJECT_KEYS = [...RUN_DEFAULT_KEYS, "retentionMs", "linkPaths"] as const;

/** The one place a `KAPELLE_*` name is given a meaning. Anything else under
 *  the prefix warns and stays out — it may be a secret. */
const ENV_KEYS = {
  KAPELLE_PORT: "port",
  KAPELLE_PERMISSION_TIMEOUT_MS: "permissionTimeoutMs",
  KAPELLE_STALL_IDLE_MS: "stallIdleMs",
  KAPELLE_STALL_REPEAT_COUNT: "stallRepeatCount",
  KAPELLE_TTL_MS: "ttlMs",
  KAPELLE_MAX_CONCURRENCY: "maxConcurrency",
  KAPELLE_RETENTION_MS: "retentionMs",
} as const satisfies Record<string, keyof ConfigValues>;

/**
 * `$XDG_CONFIG_HOME/kapelle/config.json`, or the `~/.config` default. An
 * empty or relative `XDG_CONFIG_HOME` means unset, the same rule `runtimeDir`
 * follows.
 */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_CONFIG_HOME;
  const base =
    configured && isAbsolute(configured)
      ? configured
      : join(homedir(), ".config");
  return join(base, "kapelle", "config.json");
}

/** `<root>/.kapelle/config.json`, beside the run state it defaults. */
function projectConfigPath(root: string): string {
  return join(root, STATE_DIR, "config.json");
}

// --- value rules -------------------------------------------------------------

/** A whole number, floored at `min`. `where` names the file key or env var. */
function integerAtLeast(value: unknown, where: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(
      `${where} must be a whole number ${min} or greater; ` +
        `got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function port(value: unknown, where: string): number {
  const n = integerAtLeast(value, where, 0);
  if (n > 65535) {
    throw new Error(`${where} must be a port 0-65535; got ${n}.`);
  }
  return n;
}

/** Any finite millisecond value above 0, capped at Node's 32-bit timer. */
function permissionTimeoutMs(value: unknown, where: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 2147483647
  ) {
    throw new Error(
      `${where} must be a number of milliseconds above 0 and at most ` +
        `2147483647; got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function checkKnob(key: NumericConfigKey, value: unknown, where: string) {
  switch (key) {
    case "port":
      return port(value, where);
    case "permissionTimeoutMs":
      return permissionTimeoutMs(value, where);
    case "maxConcurrency":
      return integerAtLeast(value, where, 1);
    default:
      return integerAtLeast(value, where, 0);
  }
}

/** The comparison key for `linkPaths`: separators and harmless `.` parts
 *  removed, so `folder_a/` and `folder_a` are one entry. */
function canonicalLinkPath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/**
 * `linkPaths`: relative paths inside the checkout the worktree linker may
 * mirror. The shape rules are here so every config reader refuses the same
 * list; whether a path is tracked or reaches outside the checkout needs git
 * and the filesystem, so `core/worktree.ts` checks those when it links.
 */
function linkPathList(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${where} "linkPaths" must be an array of relative paths; got ` +
        `${JSON.stringify(value)}.`,
    );
  }
  const seen: { original: string; key: string }[] = [];
  return value.map((entry, index) =>
    linkPathEntry(entry, `${where} "linkPaths[${index}]"`, seen),
  );
}

/** One `linkPaths` entry: shape, containment, and overlap with earlier ones. */
function linkPathEntry(
  entry: unknown,
  at: string,
  seen: { original: string; key: string }[],
): string {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(
      `${at} must be a non-empty string; got ${JSON.stringify(entry)}.`,
    );
  }
  if (entry.includes("\0")) {
    throw new Error(`${at} must not contain a NUL byte.`);
  }
  if (isAbsolute(entry)) {
    throw new Error(`${at} must be relative; got ${JSON.stringify(entry)}.`);
  }
  if (entry.split(/[\\/]+/).includes("..")) {
    throw new Error(
      `${at} must stay inside the checkout; got ${JSON.stringify(entry)}.`,
    );
  }
  const key = canonicalLinkPath(entry);
  if (
    key === "" ||
    key.toLowerCase() === ".git" ||
    key.toLowerCase().startsWith(".git/")
  ) {
    throw new Error(
      `${at} must not name .git or anything inside it; ` +
        `got ${JSON.stringify(entry)}.`,
    );
  }
  for (const other of seen) {
    if (
      key === other.key ||
      key.startsWith(`${other.key}/`) ||
      other.key.startsWith(`${key}/`)
    ) {
      throw new Error(
        `${at} overlaps ${JSON.stringify(other.original)}; ` +
          "each path must stand alone.",
      );
    }
  }
  seen.push({ original: entry, key });
  return entry;
}

// --- file readers ------------------------------------------------------------

/**
 * Parse one config file, refusing unknown keys and keys that belong to the
 * other layer. Missing reads as `{}` — a config file is an override, and the
 * built-in defaults are what an absent one means.
 *
 * The file is guarded the way `core/runtime.ts` guards the token directory,
 * and for the same reason: this one picks the daemon's port and how long an
 * unanswered permission waits before it is denied. `lstat`, so a symlink
 * planted where the config should be is refused rather than followed, and the
 * check is on the **file** rather than its directory — `~/.config` is
 * commonly 0755, and refusing that would be a guard nobody could satisfy.
 */
function readConfigFile(
  path: string,
  allowed: readonly string[],
  wrongLayer: (key: string) => string | undefined,
): Record<string, unknown> {
  let text: string;
  try {
    const st = lstatSync(path);
    const mode = st.mode & 0o777;
    if (!st.isFile() || st.uid !== userInfo().uid || (mode & 0o022) !== 0) {
      throw new Error(
        `${path} must be a plain file owned by you and not writable by ` +
          `anyone else. Fix or remove it, then try again.`,
      );
    }
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (err instanceof Error && err.message.startsWith(path)) throw err;
    throw new Error(`cannot read ${path}: ${messageOf(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${messageOf(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object.`);
  }

  const object = parsed as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    const hint = wrongLayer(key);
    if (hint !== undefined) throw new Error(`${path}: ${hint}`);
    if (!allowed.includes(key)) {
      throw new Error(
        `${path}: unknown key ${JSON.stringify(key)}. ` +
          `Known: ${allowed.join(", ")}.`,
      );
    }
  }
  return object;
}

/** The daemon-wide knobs: `port` and `permissionTimeoutMs`. */
export function readUserConfig(env: NodeJS.ProcessEnv = process.env) {
  const path = userConfigPath(env);
  const raw = readConfigFile(path, USER_KEYS, (key) =>
    (PROJECT_KEYS as readonly string[]).includes(key)
      ? `"${key}" is a per-repository knob; put it in ` +
        `<repo>/.kapelle/config.json.`
      : undefined,
  );

  const config: ConfigValues = {};
  if (raw.port !== undefined) {
    config.port = port(raw.port, `${path}: "port"`);
  }
  if (raw.permissionTimeoutMs !== undefined) {
    config.permissionTimeoutMs = permissionTimeoutMs(
      raw.permissionTimeoutMs,
      `${path}: "permissionTimeoutMs"`,
    );
  }
  return config;
}

/** The per-repository knobs, including the retention window. */
export function readProjectConfig(root: string): ConfigValues {
  const path = projectConfigPath(root);
  const raw = readConfigFile(path, PROJECT_KEYS, (key) =>
    (USER_KEYS as readonly string[]).includes(key)
      ? `"${key}" is daemon-wide; put it in ${userConfigPath()}.`
      : undefined,
  );

  const config: ConfigValues = {};
  for (const key of PROJECT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (key === "linkPaths") {
      config.linkPaths = linkPathList(value, `${path}:`);
      continue;
    }
    config[key] = checkKnob(key, value, `${path}: "${key}"`);
  }
  return config;
}

/** The project's worktree links; a missing key is no links, not an error. */
export function readProjectLinkPaths(root: string): string[] {
  return readProjectConfig(root).linkPaths ?? [];
}

// --- environment -------------------------------------------------------------

/** Parse the known `KAPELLE_*` variables; an unset one contributes nothing. */
export function readEnvConfig(env: NodeJS.ProcessEnv = process.env) {
  const config: ConfigValues = {};
  for (const [name, key] of Object.entries(ENV_KEYS)) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (raw.trim() === "") {
      throw new Error(`${name} is set but empty.`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`${name} must be a number; got ${JSON.stringify(raw)}.`);
    }
    config[key] = checkKnob(key, value, name);
  }
  return config;
}

/** `KAPELLE_*` names this module does not know — secrets or typos. */
function unknownConfigEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith(SECRET_PREFIX) && !(name in ENV_KEYS))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Warn about unknown `KAPELLE_*` names and leave them alone. Callers invoke
 * this once per process; there is no internal once-guard. They are not
 * refused: the prefix is also where secrets live, and a daemon must not fail
 * to start over one.
 */
export function warnUnknownConfigEnv(
  env: NodeJS.ProcessEnv = process.env,
  onNotice: (text: string) => void = (text) => console.error(text),
): void {
  const unknown = unknownConfigEnvNames(env);
  if (unknown.length === 0) return;
  onNotice(
    `! unknown KAPELLE_* env ignored as config: ${unknown.join(", ")}. ` +
      `Known: ${Object.keys(ENV_KEYS).join(", ")}.`,
  );
}

// --- layered resolution ------------------------------------------------------

/**
 * The run defaults below the run file: `env > project config > built-in`.
 * The built-in floor stays in `core/runfile.ts`; this returns only what the
 * two layers actually name. The run file itself wins over all of it.
 */
export function resolveRunDefaults(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): RunDefaults {
  const project = readProjectConfig(root);
  const fromEnv = readEnvConfig(env);
  // Built from `RUN_DEFAULT_KEYS`, never a hand-written literal. Every field
  // is optional, so a fifth knob added to the interface and the key list would
  // still type-check against a literal that never returned it — the silent
  // ignore this module exists to prevent, one layer up.
  const defaults: RunDefaults = {};
  for (const key of RUN_DEFAULT_KEYS) {
    const value = fromEnv[key] ?? project[key];
    if (value !== undefined) defaults[key] = value;
  }
  return defaults;
}

/**
 * The retention window for one repository: `env > project config`, or
 * `undefined` for the caller's built-in 30 days. Per repository because the
 * state being reaped is (M2-5).
 */
export function resolveRetentionMs(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  // The project file is read unconditionally: `??` on the env value would
  // short-circuit it, and then a bad repository file would not skip that
  // repository's sweep (issue #37 AC4) just because the env named a window.
  const project = readProjectConfig(root);
  return readEnvConfig(env).retentionMs ?? project.retentionMs;
}
