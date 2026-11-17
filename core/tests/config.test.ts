/**
 * The M2-7 config — issue #37 — and its view and writer (M10-5, #494).
 *
 * The claims here are about the two files and the `KAPELLE_*` namespace:
 * strict validation, the layer order, retention resolving per repository,
 * and a save that writes only what changed and never a refused file.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  InvalidConfig,
  projectConfigView,
  readEnvConfig,
  readProjectConfig,
  readProjectLinkPaths,
  readUserConfig,
  resolveOrchestratorTurnCap,
  resolveRetentionMs,
  resolveRunDefaults,
  saveProjectConfig,
  userConfigPath,
  warnUnknownConfigEnv,
} from "../config.ts";
import { validateRun } from "../runfile.ts";
import { sweepBoot } from "../sweep.ts";
import { WATCHDOG_DEFAULTS } from "../watchdog.ts";
import { LinkPathError } from "../worktree.ts";

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kapelle-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeUser(xdg: string, config: unknown): Promise<void> {
  await mkdir(join(xdg, "kapelle"), { recursive: true });
  await writeFile(join(xdg, "kapelle", "config.json"), JSON.stringify(config), {
    mode: 0o644,
  });
}

async function writeProject(root: string, config: unknown): Promise<void> {
  await mkdir(join(root, ".kapelle"), { recursive: true });
  // 0o644, not the umask's default: a group-writable config is refused
  // (core/config.ts), and umask 0002 would make one.
  await writeFile(
    join(root, ".kapelle", "config.json"),
    JSON.stringify(config),
    { mode: 0o644 },
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

test("a valid project config loads every numeric project knob", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, {
    stallIdleMs: 1,
    stallRepeatCount: 2,
    ttlMs: 3,
    maxConcurrency: 4,
    retentionMs: 5,
    orchestratorTurnCap: 6,
  });
  assert.deepEqual(readProjectConfig(root), {
    stallIdleMs: 1,
    stallRepeatCount: 2,
    ttlMs: 3,
    maxConcurrency: 4,
    retentionMs: 5,
    orchestratorTurnCap: 6,
  });
});

test("a valid linkPaths list loads, and readProjectLinkPaths returns it", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, {
    linkPaths: ["node_modules", "vendor/cache"],
  });

  assert.deepEqual(readProjectConfig(root), {
    linkPaths: ["node_modules", "vendor/cache"],
  });
  assert.deepEqual(readProjectLinkPaths(root), [
    "node_modules",
    "vendor/cache",
  ]);
});

test("linkPaths shape refusals name the file and entry", async (t) => {
  const root = await tempDir(t);
  const path = join(root, ".kapelle", "config.json");
  const refused = (expected: RegExp) => {
    assert.throws(
      () => readProjectConfig(root),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(path) &&
        expected.test(err.message),
    );
  };

  await writeProject(root, { linkPaths: "node_modules" });
  refused(/must be an array/);

  await writeProject(root, { linkPaths: [42] });
  refused(/linkPaths\[0\]" must be a non-empty string/);

  await writeProject(root, { linkPaths: ["/etc/passwd"] });
  refused(/must be relative/);

  await writeProject(root, { linkPaths: ["../outside"] });
  refused(/must stay inside the checkout/);

  await writeProject(root, { linkPaths: ["folder_a", "folder_a/sub"] });
  refused(/overlaps "folder_a"/);

  await writeProject(root, { linkPaths: [".git"] });
  refused(/must not name \.git/);

  await writeProject(root, { linkPaths: ["sub/.git"] });
  refused(/must not name \.git/);

  const xdg = await tempDir(t);
  await writeUser(xdg, { linkPaths: ["node_modules"] });
  assert.throws(
    () => readUserConfig({ XDG_CONFIG_HOME: xdg }),
    /"linkPaths" is a per-repository knob/,
  );
});

test("a daemon-wide key in the project config points at the user file", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, { port: 5000 });
  assert.throws(() => readProjectConfig(root), /"port" is daemon-wide/);
});

test("an unknown project key is refused naming file, key and the known keys", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, { stallIdle: 1 });
  assert.throws(
    () => readProjectConfig(root),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(join(root, ".kapelle", "config.json")) &&
      err.message.includes('unknown key "stallIdle"') &&
      err.message.includes("orchestratorTurnCap"),
  );
});

test("structural failures are refused by path in both readers", async (t) => {
  const root = await tempDir(t);
  const projectPath = join(root, ".kapelle", "config.json");
  await mkdir(join(root, ".kapelle"), { recursive: true });

  await writeFile(projectPath, "{not json", { mode: 0o644 });
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
    readEnvConfig({
      KAPELLE_TTL_MS: "5",
      KAPELLE_MAX_CONCURRENCY: "3",
      KAPELLE_ORCHESTRATOR_TURN_CAP: "12",
    }),
    { ttlMs: 5, maxConcurrency: 3, orchestratorTurnCap: 12 },
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
    () => readEnvConfig({ KAPELLE_ORCHESTRATOR_TURN_CAP: "0" }),
    /KAPELLE_ORCHESTRATOR_TURN_CAP must be a whole number 1 or greater/,
  );
  assert.throws(
    () => readEnvConfig({ KAPELLE_TTL_MS: "  " }),
    /KAPELLE_TTL_MS is set but empty/,
  );
});

test("unknown KAPELLE_* names warn and are ignored, known ones do not", () => {
  const notices: string[] = [];
  warnUnknownConfigEnv(
    {
      KAPELLE_PORT: "1",
      KAPELLE_LINK_PATHS: '["node_modules"]',
      KAPELLE_FOO: "2",
      KAPELLE_TOKEN: "secret",
    },
    (text) => notices.push(text),
  );
  assert.equal(notices.length, 1);
  assert.match(
    notices[0] ?? "",
    /ignored as config: KAPELLE_FOO, KAPELLE_LINK_PATHS, KAPELLE_TOKEN\./,
  );

  notices.length = 0;
  warnUnknownConfigEnv(
    { KAPELLE_TTL_MS: "1", KAPELLE_ORCHESTRATOR_TURN_CAP: "12" },
    (text) => notices.push(text),
  );
  assert.deepEqual(notices, []);
});

test("the orchestrator turn cap resolves from env above project config", async (t) => {
  const root = await tempDir(t);
  assert.equal(resolveOrchestratorTurnCap(root, {}), undefined);
  await writeProject(root, { orchestratorTurnCap: 12 });
  assert.equal(resolveOrchestratorTurnCap(root, {}), 12);
  assert.equal(
    resolveOrchestratorTurnCap(root, { KAPELLE_ORCHESTRATOR_TURN_CAP: "13" }),
    13,
  );
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

// --- the view and the writer (M10-5) ----------------------------------------

/** A git repository with one tracked file, for the `linkPaths` git check. */
async function repo(t: TestContext): Promise<string> {
  const root = await tempDir(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  await writeFile(join(root, "README.md"), "hi\n");
  git("add", "README.md");
  git(
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "user.name=T",
    "commit",
    "-qm",
    "first",
  );
  return root;
}

const projectFile = (root: string) => join(root, ".kapelle", "config.json");
const fileText = (root: string) => readFile(projectFile(root), "utf8");

test("the view lists every project key with its value in use and source", async (t) => {
  const root = await tempDir(t);
  const empty = projectConfigView(root, {});
  assert.deepEqual(
    empty.rows.map((r) => [r.key, r.source]),
    [
      ["stallIdleMs", "default"],
      ["stallRepeatCount", "default"],
      ["ttlMs", "default"],
      ["maxConcurrency", "default"],
      ["retentionMs", "default"],
      ["orchestratorTurnCap", "default"],
      ["linkPaths", "default"],
    ],
  );
  assert.equal(empty.path, projectFile(root));
  const ttl = empty.rows.find((r) => r.key === "ttlMs");
  assert.deepEqual(ttl, {
    key: "ttlMs",
    default: WATCHDOG_DEFAULTS.ttlMs,
    value: WATCHDOG_DEFAULTS.ttlMs,
    source: "default",
  });

  await writeProject(root, { ttlMs: 60000, linkPaths: ["node_modules"] });
  const env = { KAPELLE_TTL_MS: "5000" };
  const rows = projectConfigView(root, env).rows;
  assert.deepEqual(
    rows.find((r) => r.key === "ttlMs"),
    {
      key: "ttlMs",
      default: WATCHDOG_DEFAULTS.ttlMs,
      file: 60000,
      value: 5000,
      source: "env",
      env: "KAPELLE_TTL_MS",
    },
    "the env wins, and the row keeps the file's value",
  );
  assert.deepEqual(
    rows.find((r) => r.key === "linkPaths"),
    {
      key: "linkPaths",
      default: [],
      file: ["node_modules"],
      value: ["node_modules"],
      source: "config",
    },
  );
});

test("a save writes the changed keys only, keeps the rest in place, and resets with null", async (t) => {
  const root = await repo(t);
  await writeProject(root, { ttlMs: 60000, stallIdleMs: 1000, retentionMs: 5 });

  await saveProjectConfig(root, {
    stallIdleMs: 2000,
    retentionMs: null,
    linkPaths: ["node_modules"],
  });
  assert.equal(
    await fileText(root),
    `${JSON.stringify(
      { ttlMs: 60000, stallIdleMs: 2000, linkPaths: ["node_modules"] },
      null,
      2,
    )}\n`,
    "the untouched key keeps its value and its place; no default is written",
  );

  // Removing every key leaves an empty object, not a deleted file.
  await saveProjectConfig(root, {
    ttlMs: null,
    stallIdleMs: null,
    linkPaths: null,
  });
  assert.equal(await fileText(root), "{}\n");
});

test("a save writes nothing when nothing changes", async (t) => {
  const root = await tempDir(t);
  await saveProjectConfig(root, {});
  await saveProjectConfig(root, { ttlMs: null });
  await assert.rejects(stat(join(root, ".kapelle")), { code: "ENOENT" });
});

test("a new file is 0644 whatever the umask, and an existing file keeps its mode", async (t) => {
  const root = await tempDir(t);
  const before = process.umask(0o002);
  try {
    await saveProjectConfig(root, { maxConcurrency: 2 });
  } finally {
    process.umask(before);
  }
  assert.equal((await stat(projectFile(root))).mode & 0o777, 0o644);
  // The strict reader accepts what the writer wrote.
  assert.deepEqual(readProjectConfig(root), { maxConcurrency: 2 });

  await chmod(projectFile(root), 0o600);
  await saveProjectConfig(root, { maxConcurrency: 3 });
  assert.equal((await stat(projectFile(root))).mode & 0o777, 0o600);
});

test("the temporary file is never group-writable, even for a moment, under umask 0002", async (t) => {
  // Seen at the chmod: until then a file made with 0666 & ~umask is open to
  // the group, and an fd opened then could write the config after the rename.
  const seen: number[] = [];
  const realChmod = fs.chmodSync;
  t.mock.method(fs, "chmodSync", (path: fs.PathLike, mode: fs.Mode) => {
    seen.push(fs.statSync(path).mode & 0o777);
    realChmod(path, mode);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const root = await tempDir(t);
  const before = process.umask(0o002);
  try {
    await saveProjectConfig(root, { maxConcurrency: 2 });
    realChmod(projectFile(root), 0o600);
    await saveProjectConfig(root, { maxConcurrency: 3 });
  } finally {
    process.umask(before);
  }
  assert.deepEqual(seen, [0o644, 0o600]);
});

test("a refused save leaves the file as it was", async (t) => {
  const root = await repo(t);
  await writeProject(root, { ttlMs: 60000 });
  const was = await fileText(root);

  await assert.rejects(saveProjectConfig(root, { port: 1 }), InvalidConfig);
  await assert.rejects(
    saveProjectConfig(root, { ttlMs: -1 }),
    (err: Error) => err instanceof InvalidConfig && /"ttlMs"/.test(err.message),
  );
  await assert.rejects(
    saveProjectConfig(root, { linkPaths: "node_modules" }),
    InvalidConfig,
  );
  // D1: the git check too, as `POST /repos` runs it.
  await assert.rejects(
    saveProjectConfig(root, { linkPaths: ["README.md"] }),
    LinkPathError,
  );
  assert.equal(await fileText(root), was);
});

test("a save checks the linkPaths the file will hold, even when the patch names another key", async (t) => {
  const root = await repo(t);
  await writeProject(root, { ttlMs: 60000, linkPaths: ["README.md"] });
  const was = await fileText(root);

  await assert.rejects(
    saveProjectConfig(root, { ttlMs: 120000 }),
    (err: Error) =>
      err instanceof LinkPathError && /is tracked by git/.test(err.message),
  );
  assert.equal(await fileText(root), was);
});

test("an invalid or symlinked file, or a linked .kapelle, is never written", async (t) => {
  const root = await tempDir(t);
  await writeProject(root, { stallIdle: 1 });
  await assert.rejects(
    saveProjectConfig(root, { ttlMs: 1 }),
    (err: Error) =>
      err instanceof InvalidConfig && /unknown key/.test(err.message),
  );
  assert.equal(await fileText(root), JSON.stringify({ stallIdle: 1 }));

  const elsewhere = await tempDir(t);
  const planted = join(elsewhere, "planted.json");
  await writeFile(planted, "{}", { mode: 0o644 });
  await rm(projectFile(root));
  await symlink(planted, projectFile(root));
  await assert.rejects(
    saveProjectConfig(root, { ttlMs: 1 }),
    /must be a plain file/,
  );
  assert.equal(await readFile(planted, "utf8"), "{}");

  const linked = await tempDir(t);
  await symlink(elsewhere, join(linked, ".kapelle"));
  await rm(projectFile(root));
  await assert.rejects(saveProjectConfig(linked, { ttlMs: 1 }), InvalidConfig);
  await assert.rejects(stat(join(elsewhere, "config.json")), {
    code: "ENOENT",
  });
});
