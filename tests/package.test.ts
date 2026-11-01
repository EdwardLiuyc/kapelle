/**
 * The npm package (M9-7, #306): `prepack` builds `dist/`, the tarball holds
 * only that build and npm's mandatory files, and the unpacked package runs
 * without a network or a global install.
 *
 * The last test is the whole installed command, not a module in isolation: a
 * bare `kapelle` on a pseudo-terminal must start `dist/daemon.js` and reach
 * the chat. `--help` reaches marked, and the two chat imports reach pi-tui and
 * @xterm/headless.
 */

import assert from "node:assert/strict";
import { execFile as execFileCb, spawnSync } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  alive,
  noPty,
  ptyScreen,
  REPO,
  savedSetup,
  tempDir,
} from "../integration/helpers.ts";

const execFile = promisify(execFileCb);
const DIST = join(REPO, "dist");

interface PackResult {
  filename: string;
  files: { path: string }[];
}

const pack = async (args: string[], cwd: string): Promise<PackResult[]> => {
  const { stdout } = await execFile("npm", ["pack", ...args, "--json"], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  // npm 12 keys the JSON by package name; older npm returns an array.
  const parsed = JSON.parse(stdout) as
    | PackResult[]
    | Record<string, PackResult>;
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
};

const childEnv = (overrides: Record<string, string>): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("KAPELLE_")) delete env[name];
  }
  return { ...env, ...overrides };
};

test("the packed package runs from dist", { timeout: 120_000 }, async (t) => {
  await rm(DIST, { recursive: true, force: true });
  t.after(() => rm(DIST, { recursive: true, force: true }));
  // A stale build file must not survive prepack and reach the tarball.
  await mkdir(DIST, { recursive: true });
  await writeFile(join(DIST, "stale.js"), "stale\n");

  const packDir = await tempDir(t);
  const packed = await pack(["--pack-destination", packDir], REPO);
  assert.equal(packed.length, 1);
  const result = packed[0] as PackResult;
  const tarball = isAbsolute(result.filename)
    ? result.filename
    : join(packDir, result.filename);

  const emitted = await readdir(DIST, { recursive: true });
  assert.ok(!emitted.includes("stale.js"), "prepack removes a stale build");
  assert.ok(emitted.includes("cli.js"));
  assert.ok(emitted.includes("daemon.js"));
  assert.ok(emitted.includes(join("assets", "orchestrator.md")));
  assert.deepEqual(
    emitted.filter((file) => file.endsWith(".test.js")),
    [],
    "tests stay out of dist",
  );
  assert.deepEqual(
    emitted.filter((file) => file.startsWith("integration/")),
    [],
    "integration stays out of dist",
  );
  assert.match(
    await readFile(join(DIST, "cli.js"), "utf8"),
    /^#!\/usr\/bin\/env node\n/,
  );

  const packageDir = join(packDir, "node_modules", "kapelle");
  await mkdir(packageDir, { recursive: true });
  await execFile("tar", [
    "-xzf",
    tarball,
    "-C",
    packageDir,
    "--strip-components=1",
  ]);
  const pkg = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  ) as {
    version: string;
    private?: boolean;
    bin: { kapelle: string };
    files: string[];
    scripts: { prepack: string };
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.bin.kapelle, "./dist/cli.js");
  assert.deepEqual(pkg.files, ["dist"]);
  assert.match(pkg.scripts.prepack, /tsc -p tsconfig\.build\.json/);

  // Link only the runtime dependencies the package declares, not the
  // checkout's devDependencies: a missing declaration must fail here.
  await mkdir(join(packageDir, "node_modules"), { recursive: true });
  for (const name of Object.keys(pkg.dependencies)) {
    const dest = join(packageDir, "node_modules", name);
    await mkdir(dirname(dest), { recursive: true });
    await symlink(join(REPO, "node_modules", name), dest);
  }

  const cli = join(packageDir, "dist", "cli.js");
  const env = childEnv({});
  const help = spawnSync(process.execPath, [cli, "--help"], {
    cwd: packageDir,
    env,
    encoding: "utf8",
  });
  assert.match(help.stdout, /minimal Agent Client Protocol client/);
  assert.match(help.stdout, /kapelle --version/);

  const version = spawnSync(process.execPath, [cli, "--version"], {
    cwd: packageDir,
    env,
    encoding: "utf8",
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), pkg.version);

  const imports = [
    pathToFileURL(join(packageDir, "dist", "chat", "tui.js")).href,
    pathToFileURL(join(packageDir, "dist", "chat", "tui", "term.js")).href,
  ];
  const loaded = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(imports[0])});\nawait import(${JSON.stringify(imports[1])});`,
    ],
    { cwd: packageDir, env, encoding: "utf8" },
  );
  assert.equal(loaded.status, 0, loaded.stderr);

  // The loop skill is read beside the compiled module, not from the checkout.
  const loopRoot = await tempDir(t);
  await mkdir(join(loopRoot, ".git"), { recursive: true });
  await mkdir(join(loopRoot, ".kapelle", "loops"), { recursive: true });
  await writeFile(join(loopRoot, ".kapelle", "loops", "smoke.md"), "# smoke\n");
  const { loopMessage } = (await import(
    pathToFileURL(join(packageDir, "dist", "client", "loop.js")).href
  )) as typeof import("../client/loop.ts");
  const loop = await loopMessage({ recipe: "smoke", task: "306" }, loopRoot, {
    XDG_CONFIG_HOME: join(loopRoot, "config"),
  });
  assert.ok("text" in loop, JSON.stringify(loop));
  assert.match(loop.text, /^\[the orchestrator skill\]\n# The orchestrator\n/);

  const dry = await pack(["--dry-run"], REPO);
  const files = (dry[0] as PackResult).files.map((file) => file.path);
  const rootFiles = new Set(["README.md", "LICENSE", "package.json"]);
  for (const file of files) {
    assert.ok(
      rootFiles.has(file) || file === "dist" || file.startsWith("dist/"),
      `unexpected package file: ${file}`,
    );
  }
  assert.ok(files.includes("dist/assets/orchestrator.md"));
  assert.ok(!files.some((file) => file.endsWith(".test.js")));

  if (noPty) {
    t.diagnostic(noPty);
    return;
  }

  const runtime = await tempDir(t);
  const state = await tempDir(t);
  savedSetup(state);
  const screen = await ptyScreen(
    t,
    `stty cols 100 rows 30; "${process.execPath}" "${cli}"`,
    {
      XDG_RUNTIME_DIR: runtime,
      XDG_STATE_HOME: state,
      XDG_CONFIG_HOME: join(state, "config-home"),
      KAPELLE_PORT: "0",
    },
  );
  const daemon = JSON.parse(
    await readFile(join(runtime, "kapelle", "daemon.json"), "utf8"),
  ) as { pid: number };
  t.after(() => {
    try {
      process.kill(daemon.pid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  });
  assert.equal(alive(daemon.pid), true);
  assert.match(
    await readFile(join(state, "kapelle", "daemon.log"), "utf8"),
    /listening on /,
  );

  screen.child.stdin.write("/leave\r");
  await screen.seen("left the chat");
  assert.equal(await screen.exited, 0, screen.out());
  assert.equal(alive(daemon.pid), true, "leaving the chat keeps the daemon");
});
