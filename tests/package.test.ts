/**
 * The npm package (M9-7, #306): `prepack` builds `dist/`, the tarball holds
 * only that build and npm's mandatory files, and the unpacked package runs
 * without a network or a global install.
 *
 * The last test is the whole installed command, not a module in isolation: a
 * bare `kapelle` on a pseudo-terminal must start `dist/daemon.js` and reach
 * the chat. `--help` reaches marked, and the two chat imports reach pi-tui and
 * @xterm/headless. The extracted package gets its own version, so the version
 * test proves the CLI reads that file rather than printing a baked-in value.
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
  childEnv,
  noPty,
  ptyScreen,
  REPO,
  savedSetup,
  spawnCli,
  stopProcess,
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

test("the packed package runs from dist", { timeout: 120_000 }, async (t) => {
  await rm(DIST, { recursive: true, force: true });
  t.after(() => rm(DIST, { recursive: true, force: true }));
  // A stale build file must not survive prepack and reach the tarball.
  await mkdir(DIST, { recursive: true });
  await writeFile(join(DIST, "stale.js"), "stale\n");
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", "dist"], { cwd: REPO }).status,
    0,
    "dist/ stays ignored by git",
  );

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
  assert.ok(emitted.includes("demo-agent.mjs"));
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
  const packageJsonPath = join(packageDir, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version: string;
    private?: boolean;
    bin: { kapelle: string };
    files: string[];
    scripts: { prepack: string };
    dependencies: Record<string, string>;
    [key: string]: unknown;
  };
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.bin.kapelle, "./dist/cli.js");
  assert.deepEqual(pkg.files, ["dist"]);
  assert.equal(pkg.homepage, "https://kapelle.dev");
  assert.deepEqual(pkg.bugs, {
    url: "https://github.com/EdwardLiuyc/kapelle/issues",
  });
  assert.deepEqual(pkg.keywords, [
    "agent-client-protocol",
    "acp",
    "coding-agents",
    "ai-agents",
    "cli",
    "typescript",
    "nodejs",
  ]);
  assert.match(pkg.scripts.prepack, /tsc -p tsconfig\.build\.json/);
  // A real extraction keeps type: module and the other fields. The different
  // version proves --version reads this package.json, not a baked-in value.
  const packagedVersion = "9.8.7-review-2";
  await writeFile(
    packageJsonPath,
    `${JSON.stringify({ ...pkg, version: packagedVersion }, null, 2)}\n`,
  );

  // Link only the runtime dependencies the package declares, not the
  // checkout's devDependencies: a missing declaration must fail here.
  await mkdir(join(packageDir, "node_modules"), { recursive: true });
  for (const name of Object.keys(pkg.dependencies)) {
    const dest = join(packageDir, "node_modules", name);
    await mkdir(dirname(dest), { recursive: true });
    await symlink(join(REPO, "node_modules", name), dest);
  }

  const cli = join(packageDir, "dist", "cli.js");
  const env = childEnv();
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
  assert.equal(version.stdout.trim(), packagedVersion);

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

  // A valid package.json without a version reaches the refusal, rather than
  // printing the parent package's version or exiting 0.
  const withoutVersion: Record<string, unknown> = { ...pkg };
  delete withoutVersion.version;
  await writeFile(
    packageJsonPath,
    `${JSON.stringify(withoutVersion, null, 2)}\n`,
  );
  const noVersion = spawnSync(process.execPath, [cli, "--version"], {
    cwd: packageDir,
    env,
    encoding: "utf8",
  });
  assert.equal(noVersion.status, 1, noVersion.stderr);
  assert.equal(noVersion.stdout, "");
  assert.match(
    noVersion.stderr,
    /cannot read the kapelle version from package\.json/,
  );

  const dry = await pack(["--dry-run"], REPO);
  const files = (dry[0] as PackResult).files.map((file) => file.path);
  const rootFiles = new Set(["README.md", "LICENSE", "package.json"]);
  for (const file of files) {
    assert.ok(
      rootFiles.has(file) || file === "dist" || file.startsWith("dist/"),
      `unexpected package file: ${file}`,
    );
  }
  for (const file of rootFiles) {
    assert.ok(files.includes(file), `missing package file: ${file}`);
  }
  assert.ok(files.includes("dist/assets/orchestrator.md"));
  assert.ok(files.includes("dist/demo-agent.mjs"));
  assert.ok(!files.some((file) => file.endsWith(".test.js")));
  assert.ok(!files.some((file) => file.endsWith(".ts")));

  // The ignore is what keeps a generated build out of biome's fixes. Copy the
  // config so the probe cannot find an unrelated unformatted source file.
  const biomeRoot = await tempDir(t);
  await writeFile(
    join(biomeRoot, "biome.json"),
    await readFile(join(REPO, "biome.json"), "utf8"),
  );
  const notFormatted = join(biomeRoot, "dist", "not-formatted.js");
  await mkdir(dirname(notFormatted), { recursive: true });
  await writeFile(notFormatted, "export const answer=42\n");
  const biome = spawnSync(
    join(REPO, "node_modules", ".bin", "biome"),
    ["check", "--max-diagnostics=1", "."],
    { cwd: biomeRoot, encoding: "utf8" },
  );
  assert.equal(biome.status, 0, `${biome.stdout}${biome.stderr}`);

  // `kapelle demo` from the package (#463): it starts the packaged daemon
  // and the packaged demo agent, with no harness installed. A PATH with only
  // the programs the demo itself uses makes that condition real: a saved
  // find that says every harness is ready would hide a regression to a
  // registry agent on a machine where one is installed.
  const demoRuntime = await tempDir(t);
  const demoState = await tempDir(t);
  const demoBin = await tempDir(t);
  await symlink(process.execPath, join(demoBin, "node"));
  for (const program of ["git", "ps", "sh"]) {
    const found = spawnSync("sh", ["-c", `command -v ${program}`], {
      encoding: "utf8",
    });
    assert.equal(found.status, 0, found.stderr);
    await symlink(found.stdout.trim(), join(demoBin, program));
  }
  const demo = spawnCli(t, ["demo"], cli, {
    XDG_RUNTIME_DIR: demoRuntime,
    XDG_STATE_HOME: demoState,
    XDG_CONFIG_HOME: join(demoState, "config-home"),
    KAPELLE_PORT: "0",
    PATH: demoBin,
  });
  t.after(async () => {
    const record = await readFile(
      join(demoRuntime, "kapelle", "daemon.json"),
      "utf8",
    ).catch(() => undefined);
    if (record) await stopProcess((JSON.parse(record) as { pid: number }).pid);
  });
  await demo.waitFor("Now type a message");
  demo.child.stdin.write("/leave\n");
  const left = await demo.done;
  assert.equal(left.code, 0, left.stderr);
  assert.match(left.stdout, /demo-agent: no measured labels/);

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
  t.after(() => stopProcess(daemon.pid));
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
