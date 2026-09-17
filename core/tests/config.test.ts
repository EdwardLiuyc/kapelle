/**
 * The M2-7 config — issue #37.
 *
 * The claims here are about the two files and the `KAPELLE_*` namespace:
 * strict validation, the layer order, and retention resolving per repository.
 */

import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  readEnvConfig,
  readProjectConfig,
  readUserConfig,
  resolveRetentionMs,
  resolveRunDefaults,
  userConfigPath,
  warnUnknownConfigEnv,
} from "../config.ts";
import { validateRun } from "../runfile.ts";
import { sweepBoot } from "../sweep.ts";
import { WATCHDOG_DEFAULTS } from "../watchdog.ts";

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kapelle-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeUser(xdg: string, config: unknown): Promise<void> {
  await mkdir(join(xdg, "kapelle"), { recursive: true });
  await writeFile(join(xdg, "kapelle", "config.json"), JSON.stringify(config));
}

async function writeProject(root: string, config: unknown): Promise<void> {
  await mkdir(join(root, ".kapelle"), { recursive: true });
  await writeFile(
    join(root, ".kapelle", "config.json"),
    JSON.stringify(config),
  );
}

/** `cmd`, so the registry is not part of what these tests measure. */
const minimal = {
  cmd: "node mock-agent.mjs",
  tasks: [{ id: "one", prompt: "do it" }],
};

test("a missing config is no opinion, not an error", async (t) => {
  const dir = await tempDir(t);
  assert.deepEqual(readUserConfig({ XDG_CONFIG_HOME: dir }), {});
  assert.deepEqual(readProjectConfig(dir), {});
});

test("a valid user config loads port and permission timeout", async (t) => {
  const dir = await tempDir(t);
  await writeUser(dir, { port: 5000, permissionTimeoutMs: 1500 });
  assert.deepEqual(readUserConfig({ XDG_CONFIG_HOME: dir }), {
    port: 5000,
    permissionTimeoutMs: 1500,
  });
});

test("an unknown user key is refused naming file and key", async (t) => {
  const dir = await tempDir(t);
  const path = userConfigPath({ XDG_CONFIG_HOME: dir });
  await writeUser(dir, { post: 5000 });
  assert.throws(
    () => readUserConfig({ XDG_CONFIG_HOME: dir }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(path) &&
      err.message.includes('unknown key "post"'),
  );
});

test("a per-repository key in the user config points at the project file", async (t) => {
  const dir = await tempDir(t);
  await writeUser(dir, { ttlMs: 1 });
  assert.throws(
    () => readUserConfig({ XDG_CONFIG_HOME: dir }),
    /"ttlMs" is a per-repository knob/,
  );
});

test("a wrong type in the user config is refused", async (t) => {
  const dir = await tempDir(t);
  await writeUser(dir, { port: "5000" });
  assert.throws(
    () => readUserConfig({ XDG_CONFIG_HOME: dir }),
    /"port" must be a whole number 0 or greater/,
  );
});

test("a valid project config loads every per-run knob", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, {
    stallIdleMs: 1,
    stallRepeatCount: 2,
    ttlMs: 3,
    maxConcurrency: 4,
    retentionMs: 5,
  });
  assert.deepEqual(readProjectConfig(root), {
    stallIdleMs: 1,
    stallRepeatCount: 2,
    ttlMs: 3,
    maxConcurrency: 4,
    retentionMs: 5,
  });
});

test("a daemon-wide key in the project config points at the user file", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, { port: 5000 });
  assert.throws(() => readProjectConfig(root), /"port" is daemon-wide/);
});

test("an unknown project key is refused naming file and key", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, { stallIdle: 1 });
  assert.throws(
    () => readProjectConfig(root),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(join(root, ".kapelle", "config.json")) &&
      err.message.includes('unknown key "stallIdle"'),
  );
});

test("structural failures are refused by path in both readers", async (t) => {
  const root = await tempDir(t);
  const projectPath = join(root, ".kapelle", "config.json");
  await mkdir(join(root, ".kapelle"), { recursive: true });

  await writeFile(projectPath, "{not json");
  assert.throws(() => readProjectConfig(root), /is not valid JSON/);

  await writeFile(projectPath, "null");
  assert.throws(() => readProjectConfig(root), /must be a JSON object/);

  await rm(projectPath);
  await mkdir(projectPath);
  assert.throws(() => readProjectConfig(root), /must be a plain file/);

  const xdg = await tempDir(t);
  await writeUser(xdg, []);
  assert.throws(
    () => readUserConfig({ XDG_CONFIG_HOME: xdg }),
    /must be a JSON object/,
  );
});

test("a config file anyone else can write, or a symlink, is refused", async (t) => {
  // This file picks the daemon's port and how long an unanswered permission
  // waits before it is denied, so it is guarded like the token beside it.
  const xdg = await tempDir(t);
  await writeUser(xdg, { port: 5000 });
  const path = join(xdg, "kapelle", "config.json");

  await chmod(path, 0o666);
  assert.throws(
    () => readUserConfig({ XDG_CONFIG_HOME: xdg }),
    /must be a plain file/,
  );

  await chmod(path, 0o600);
  assert.deepEqual(readUserConfig({ XDG_CONFIG_HOME: xdg }), { port: 5000 });

  // lstat, not stat: a symlink planted where the config belongs is refused
  // rather than followed, even when its target is a file we would accept.
  const elsewhere = await tempDir(t);
  const real = join(elsewhere, "planted.json");
  await writeFile(real, JSON.stringify({ port: 9999 }));
  await rm(path);
  await symlink(real, path);
  assert.throws(
    () => readUserConfig({ XDG_CONFIG_HOME: xdg }),
    /must be a plain file/,
  );
});

test("env config parses known names and refuses bad values", () => {
  assert.deepEqual(
    readEnvConfig({ KAPELLE_TTL_MS: "5", KAPELLE_MAX_CONCURRENCY: "3" }),
    { ttlMs: 5, maxConcurrency: 3 },
  );
  assert.throws(
    () => readEnvConfig({ KAPELLE_TTL_MS: "soon" }),
    /KAPELLE_TTL_MS must be a number/,
  );
  assert.throws(
    () => readEnvConfig({ KAPELLE_PORT: "70000" }),
    /KAPELLE_PORT must be a port/,
  );
  assert.throws(
    () => readEnvConfig({ KAPELLE_MAX_CONCURRENCY: "0" }),
    /KAPELLE_MAX_CONCURRENCY must be a whole number 1 or greater/,
  );
  assert.throws(
    () => readEnvConfig({ KAPELLE_TTL_MS: "  " }),
    /KAPELLE_TTL_MS is set but empty/,
  );
});

test("unknown KAPELLE_* names warn and are ignored, known ones do not", () => {
  const notices: string[] = [];
  warnUnknownConfigEnv(
    { KAPELLE_PORT: "1", KAPELLE_FOO: "2", KAPELLE_TOKEN: "secret" },
    (text) => notices.push(text),
  );
  assert.equal(notices.length, 1);
  assert.match(
    notices[0] ?? "",
    /ignored as config: KAPELLE_FOO, KAPELLE_TOKEN\./,
  );

  notices.length = 0;
  warnUnknownConfigEnv({ KAPELLE_TTL_MS: "1" }, (text) => notices.push(text));
  assert.deepEqual(notices, []);
});

test("run file > env > project config > built-in", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, { ttlMs: 111, maxConcurrency: 2 });

  const fromProject = validateRun(minimal, {}, resolveRunDefaults(root, {}));
  assert.equal(fromProject.tasks[0].ttlMs, 111);
  assert.equal(fromProject.maxConcurrency, 2);

  const env = { KAPELLE_TTL_MS: "222", KAPELLE_MAX_CONCURRENCY: "3" };
  const fromEnv = validateRun(minimal, {}, resolveRunDefaults(root, env));
  assert.equal(fromEnv.tasks[0].ttlMs, 222);
  assert.equal(fromEnv.maxConcurrency, 3);

  const explicit = validateRun(
    { ...minimal, ttlMs: 333, maxConcurrency: 5 },
    {},
    resolveRunDefaults(root, env),
  );
  assert.equal(explicit.tasks[0].ttlMs, 333);
  assert.equal(explicit.maxConcurrency, 5);

  const floor = validateRun(minimal, {}, {});
  assert.equal(floor.tasks[0].ttlMs, WATCHDOG_DEFAULTS.ttlMs);
  assert.equal(floor.tasks[0].stallIdleMs, WATCHDOG_DEFAULTS.stallIdleMs);
  assert.equal(floor.maxConcurrency, 4);
});

test("stall knobs flow from project and env into the resolved task", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, { stallIdleMs: 111, stallRepeatCount: 2 });

  const fromProject = validateRun(minimal, {}, resolveRunDefaults(root, {}));
  assert.equal(fromProject.tasks[0].stallIdleMs, 111);
  assert.equal(fromProject.tasks[0].stallRepeatCount, 2);

  const env = {
    KAPELLE_STALL_IDLE_MS: "222",
    KAPELLE_STALL_REPEAT_COUNT: "3",
  };
  const fromEnv = validateRun(minimal, {}, resolveRunDefaults(root, env));
  assert.equal(fromEnv.tasks[0].stallIdleMs, 222);
  assert.equal(fromEnv.tasks[0].stallRepeatCount, 3);
});

test("retention resolves per repository, env above it", async (t) => {
  const one = await tempDir(t);
  const two = await tempDir(t);
  const bare = await tempDir(t);
  await writeProject(one, { retentionMs: 1000 });
  await writeProject(two, { retentionMs: 2000 });

  assert.equal(resolveRetentionMs(one, {}), 1000);
  assert.equal(resolveRetentionMs(two, {}), 2000);
  assert.equal(resolveRetentionMs(bare, {}), undefined);
  assert.equal(resolveRetentionMs(one, { KAPELLE_RETENTION_MS: "500" }), 500);
  // The env is process-wide, so it beats each repo's own value.
  assert.equal(resolveRetentionMs(two, { KAPELLE_RETENTION_MS: "500" }), 500);
});

test("retention env override still validates the repository's file", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, { stallIdle: 1 });
  assert.throws(
    () => resolveRetentionMs(root, { KAPELLE_RETENTION_MS: "1000" }),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(join(root, ".kapelle", "config.json")) &&
      err.message.includes('unknown key "stallIdle"'),
  );
});

test("a bad project config skips that repo's sweep with a notice", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, { ttlMs: "soon" });
  const notices: string[] = [];
  await sweepBoot({
    repos: [root],
    childrenFile: join(root, "children.json"),
    onNotice: (text) => notices.push(text),
  });
  assert.ok(
    notices.some((text) => text.includes(root) && text.includes('"ttlMs"')),
    notices.join("\n"),
  );
});
