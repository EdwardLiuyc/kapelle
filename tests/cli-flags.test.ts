/**
 * The CLI's hand-written argv parsing, pinned before M12-10b replaces it with
 * `parseArgs` (M12-10a, issue #543).
 *
 * Every command leaf in `kapelle --help`, plus `workspace`, gets the same
 * cases: a flag before the verb, a missing value, a repeated value flag, a
 * token after a boolean flag, `--`, and an unknown flag. The usage-error
 * section covers every argument refusal `cli.ts` owns before side effects.
 *
 * Unknown flags today:
 * - ignored, not named: one prompt, `--version`, `--help`, `run`, `attach`,
 *   `setup`, `ps`, `merge`, `workspace`, `workspace move`, `daemon stop`,
 *   `daemon add`;
 * - generic help or usage, not the unknown name: a bare `--bogus`, `demo`;
 * - refused by name: `loop`, `loop list`, each `room` verb, `daemon start`
 *   (through `daemon.ts`'s `parseArgs`) and `chat` (through `chat.ts`).
 *
 * `chat` subverbs are delegated to `chat.ts`; this file pins the handoff, not
 * that parser. `bare kapelle` has no flags by definition, so it is covered in
 * the handoff section only.
 *
 * Current parser quirks pinned here, and the cases M12-10b may change: the
 * first repeated value flag wins, a missing value is reported by `flag()`,
 * and `--` is not a separator: `positionalAt` skips it and the token after it.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { stateDirFor } from "../core/runtime.ts";
import {
  type CliResult,
  gitRepo,
  REPO,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";

const HELP = /minimal Agent Client Protocol client/;
const VERSION = /^\d+\.\d+\.\d+$/;
const CHAT_USAGE = /usage:\n {2}node chat\.ts/;
const NO_DAEMON = /no daemon is listening/;
const ROOM_USAGE = /^usage: kapelle room/m;
const DAEMON_USAGE = /^usage: kapelle daemon start/m;
const LOOP_USAGE = /^usage: kapelle loop/m;
const MOVE_USAGE = /^workspace move needs two paths/m;
const RUN_FILE_USAGE = /^run needs a run file/m;
const ATTACH_USAGE = /^attach needs one run id/m;
const MERGE_USAGE = /^merge needs one run id/m;
const SETUP_USAGE = /^usage: kapelle setup$/m;
const DEMO_USAGE = /^usage: kapelle demo$/m;
const NOT_A_REPO = /not a git repository, so it has no workspace to move to/;
const STARTER = /starter\s+.*assets\/loops\/starter\.md/;

type Expectation = {
  name: string;
  args: string[];
  code: number;
  stdout?: string | RegExp;
  stderr?: string | RegExp;
};

type Fixture = {
  root: string;
  env: Record<string, string>;
  markers: string;
  daemonRecord: string;
  repo1: string;
  repo2: string;
  missing1: string;
  missing2: string;
  notRepo: string;
  target: string;
};

/** A temp CLI environment, two repositories, and a fake default harness. */
async function fixture(t: TestContext): Promise<Fixture> {
  const root = await tempDir(t);
  const runtime = join(root, "runtime");
  const config = join(root, "config");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [runtime, config, home, bin]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  const markers = join(root, "markers");
  await mkdir(markers);
  await writeFile(
    join(bin, "pi-acp"),
    '#!/bin/sh\nprintf spawned > "$PI_MARKER"\nexit 1\n',
    { mode: 0o755 },
  );

  const notRepo = join(root, "not-a-repo");
  await mkdir(notRepo);

  return {
    root,
    env: {
      XDG_RUNTIME_DIR: runtime,
      XDG_CONFIG_HOME: config,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
    markers,
    daemonRecord: join(runtime, "kapelle", "daemon.json"),
    repo1: await gitRepo(t),
    repo2: await gitRepo(t),
    missing1: join(root, "missing1.json"),
    missing2: join(root, "missing2.json"),
    notRepo,
    target: join(root, "new-state"),
  };
}

async function absent(path: string, message: string): Promise<void> {
  await assert.rejects(access(path), { code: "ENOENT" }, message);
}

/** Run one case and prove it started neither a harness nor a daemon. */
async function invoke(
  t: TestContext,
  f: Fixture,
  args: string[],
): Promise<CliResult> {
  const marker = join(f.markers, randomUUID());
  const result = await spawnCli(t, args, "cli.ts", {
    ...f.env,
    PI_MARKER: marker,
  }).done;
  await absent(marker, "the harness started");
  await absent(f.daemonRecord, "a daemon record was written");
  return result;
}

function check(name: string, result: CliResult, expected: Expectation): void {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  assert.equal(result.code, expected.code, `${name}: ${result.stderr}`);
  if (expected.stdout === undefined) {
    assert.equal(stdout, "", `${name}: unexpected stdout`);
  } else if (typeof expected.stdout === "string") {
    assert.equal(stdout, expected.stdout, `${name}: stdout`);
  } else {
    assert.match(stdout, expected.stdout, `${name}: stdout`);
  }
  if (expected.stderr === undefined) {
    assert.equal(stderr, "", `${name}: unexpected stderr`);
  } else if (typeof expected.stderr === "string") {
    assert.equal(stderr, expected.stderr, `${name}: stderr`);
  } else {
    assert.match(stderr, expected.stderr, `${name}: stderr`);
  }
}

async function runCases(
  t: TestContext,
  f: Fixture,
  cases: Expectation[],
): Promise<void> {
  await Promise.all(
    cases.map((c) =>
      t.test(c.name, async (st) => {
        check(c.name, await invoke(st, f, c.args), c);
      }),
    ),
  );
}

test("a flag before the verb still selects the verb", {
  concurrency: 4,
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  await runCases(t, f, [
    {
      name: "prompt",
      args: ["--agent", "nope", "hi"],
      code: 1,
      stderr: /unknown agent "nope"/,
    },
    {
      name: "help",
      args: ["--cwd", f.repo1, "--help"],
      code: 0,
      stdout: HELP,
    },
    {
      name: "version",
      args: ["--cwd", f.repo1, "--version"],
      code: 0,
      stdout: VERSION,
    },
    {
      name: "demo",
      args: ["--quiet", "demo", "--bogus"],
      code: 1,
      stderr: DEMO_USAGE,
    },
    {
      name: "run",
      args: ["--file", f.missing1, "run"],
      code: 1,
      stderr: /cannot read run file .*missing1\.json/,
    },
    {
      name: "attach",
      args: ["--task", "x", "attach"],
      code: 1,
      stderr: ATTACH_USAGE,
    },
    {
      name: "setup",
      args: ["--cwd", f.repo1, "setup"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "ps",
      args: ["--cwd", f.repo1, "ps"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "merge",
      args: ["--cwd", f.repo1, "merge"],
      code: 1,
      stderr: MERGE_USAGE,
    },
    {
      name: "workspace",
      args: ["--cwd", f.repo1, "workspace"],
      code: 0,
      stdout: stateDirFor(f.repo1),
    },
    {
      name: "workspace move",
      args: ["--cwd", f.repo1, "workspace", "move"],
      code: 1,
      stderr: MOVE_USAGE,
    },
    {
      name: "loop",
      args: ["--cwd", f.repo1, "loop"],
      code: 1,
      stderr: LOOP_USAGE,
    },
    {
      name: "loop list",
      args: ["--cwd", f.repo1, "loop", "list"],
      code: 0,
      stdout: STARTER,
    },
    {
      name: "room info",
      args: ["--room", "r", "room", "info"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room send",
      args: ["--as", "x", "room", "send", "ann", "hi"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room add",
      args: ["--model", "m", "room", "add", "mock"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room ff",
      args: ["--from", "x", "room", "ff", "ann"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room diff",
      args: ["--room", "r", "room", "diff", "ann"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room remove",
      args: ["--room", "r", "room", "remove", "ann"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "daemon start",
      args: ["--permission-timeout", "nope", "daemon", "start"],
      code: 1,
      stderr: /--permission-timeout must be a number/,
    },
    {
      name: "daemon stop",
      args: ["--cwd", f.repo1, "daemon", "stop"],
      code: 0,
      stdout: "no daemon is running",
    },
    {
      name: "daemon add",
      args: ["--cwd", f.repo1, "daemon", "add", f.repo1],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "chat",
      args: ["--cwd", f.repo1, "chat", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
  ]);
});

test("a flag with no value records today's outcome", {
  concurrency: 4,
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  await runCases(t, f, [
    {
      name: "prompt",
      args: ["hi", "--agent"],
      code: 1,
      stderr: "--agent needs a value",
    },
    {
      name: "help",
      args: ["--cwd", "--help"],
      code: 0,
      stdout: HELP,
    },
    {
      name: "version",
      args: ["--cwd", "--version"],
      code: 1,
      stderr: "--cwd needs a value",
    },
    {
      name: "demo",
      args: ["demo", "--cwd"],
      code: 1,
      stderr: DEMO_USAGE,
    },
    {
      name: "run",
      args: ["run", "--file"],
      code: 1,
      stderr: "--file needs a value",
    },
    {
      name: "attach",
      args: ["attach", "abc", "--task"],
      code: 1,
      stderr: "--task needs a value",
    },
    {
      name: "setup",
      args: ["setup", "--cwd"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "ps",
      args: ["ps", "--cwd"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "merge",
      args: ["merge", "20260909-120000-abcd", "--cwd"],
      code: 1,
      stderr: "--cwd needs a value",
    },
    {
      name: "workspace",
      args: ["workspace", "--cwd"],
      code: 1,
      stderr: "--cwd needs a value",
    },
    {
      name: "workspace move",
      args: ["workspace", "move", "--cwd"],
      code: 1,
      stderr: MOVE_USAGE,
    },
    {
      name: "loop",
      args: ["loop", "recipe", "task", "--cwd"],
      code: 1,
      stderr: "--cwd needs a value",
    },
    {
      name: "loop list",
      args: ["loop", "list", "--cwd"],
      code: 1,
      stderr: "--cwd needs a value",
    },
    {
      name: "room info",
      args: ["room", "info", "--room"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room send",
      args: ["room", "send", "ann", "hi", "--as"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room add",
      args: ["room", "add", "mock", "--model"],
      code: 1,
      stderr: "--model needs a value",
    },
    {
      name: "room ff",
      args: ["room", "ff", "ann", "--from"],
      code: 1,
      stderr: "--from needs a value",
    },
    {
      name: "room diff",
      args: ["room", "diff", "ann", "--room"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room remove",
      args: ["room", "remove", "ann", "--room"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "daemon start",
      args: ["daemon", "start", "--port"],
      code: 1,
      stderr: "Option '--port <value>' argument missing",
    },
    {
      name: "daemon stop",
      args: ["daemon", "stop", "--cwd"],
      code: 0,
      stdout: "no daemon is running",
    },
    {
      name: "daemon add",
      args: ["daemon", "add", "--cwd"],
      code: 1,
      stderr: DAEMON_USAGE,
    },
    {
      name: "chat",
      args: ["chat", "--cwd"],
      code: 1,
      stderr: /error: Option '--cwd <value>' argument missing/,
    },
  ]);
});

test("a repeated value flag keeps today's first value", {
  concurrency: 4,
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  await runCases(t, f, [
    {
      name: "prompt",
      args: ["hi", "--agent", "nope", "--agent", "pi"],
      code: 1,
      stderr: /unknown agent "nope"/,
    },
    {
      name: "help",
      args: ["--help", "--help"],
      code: 0,
      stdout: HELP,
    },
    {
      name: "version",
      args: ["--version", "--version"],
      code: 0,
      stdout: VERSION,
    },
    {
      name: "demo",
      args: ["demo", "--quiet", "--quiet", "--bogus"],
      code: 1,
      stderr: DEMO_USAGE,
    },
    {
      name: "run",
      args: ["run", "--file", f.missing1, "--file", f.missing2],
      code: 1,
      stderr: /cannot read run file .*missing1\.json/,
    },
    {
      name: "attach",
      args: ["attach", "abc", "--task", "a", "--task", "b"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "setup",
      args: ["setup", "--quiet", "--quiet"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "ps",
      args: ["ps", "--quiet", "--quiet"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "merge",
      args: ["merge", "abc", "--cwd", f.repo1, "--cwd", f.repo2],
      code: 1,
      stderr: /invalid run id "abc"/,
    },
    {
      name: "workspace",
      args: ["workspace", "--cwd", f.repo1, "--cwd", f.repo2],
      code: 0,
      stdout: stateDirFor(f.repo1),
    },
    {
      name: "workspace move",
      args: [
        "workspace",
        "move",
        f.notRepo,
        f.target,
        "--cwd",
        f.repo1,
        "--cwd",
        f.repo2,
      ],
      code: 1,
      stderr: NOT_A_REPO,
    },
    {
      name: "loop",
      args: ["loop", "recipe", "task", "--cwd", f.repo1, "--cwd", f.repo2],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "loop list",
      args: ["loop", "list", "--cwd", f.repo1, "--cwd", f.repo2],
      code: 0,
      stdout: STARTER,
    },
    {
      name: "room info",
      args: ["room", "info", "--room", "a", "--room", "b"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room send",
      args: ["room", "send", "ann", "hi", "--as", "a", "--as", "b"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room add",
      args: ["room", "add", "mock", "--model", "a", "--model", "b"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room ff",
      args: ["room", "ff", "ann", "--from", "a", "--from", "b"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room diff",
      args: ["room", "diff", "ann", "--room", "a", "--room", "b"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room remove",
      args: ["room", "remove", "ann", "--room", "a", "--room", "b"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "daemon start",
      args: ["daemon", "start", "--port", "111111", "--port", "99999"],
      code: 1,
      stderr: "--port must be a whole number 0-65535; got 99999",
    },
    {
      name: "daemon stop",
      args: ["daemon", "stop", "--quiet", "--quiet"],
      code: 0,
      stdout: "no daemon is running",
    },
    {
      name: "daemon add",
      args: ["daemon", "add", f.repo1, "--cwd", f.repo1, "--cwd", f.repo2],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "chat",
      args: ["chat", "--cwd", f.repo1, "--cwd", f.repo2, "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
  ]);
});

test("a value after a boolean flag stays positional", {
  concurrency: 4,
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  await runCases(t, f, [
    {
      name: "prompt",
      args: ["--quiet", "hi", "--agent", "nope"],
      code: 1,
      stderr: /unknown agent "nope"/,
    },
    {
      name: "help",
      args: ["--help", "extra"],
      code: 0,
      stdout: HELP,
    },
    {
      name: "version",
      args: ["--version", "extra"],
      code: 1,
      stderr: "--version takes no other arguments",
    },
    {
      name: "demo",
      args: ["demo", "--quiet", "extra"],
      code: 1,
      stderr: DEMO_USAGE,
    },
    {
      name: "run",
      args: ["run", "--detach", "extra", "--file", f.missing1],
      code: 1,
      stderr: /a prompt does not apply with --file: .*Got "extra"/,
    },
    {
      name: "attach",
      args: ["attach", "abc", "--quiet", "extra"],
      code: 1,
      stderr: ATTACH_USAGE,
    },
    {
      name: "setup",
      args: ["setup", "--quiet", "extra"],
      code: 1,
      stderr: SETUP_USAGE,
    },
    {
      name: "ps",
      args: ["ps", "--quiet", "extra"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "merge",
      args: ["merge", "abc", "--squash", "extra"],
      code: 1,
      stderr: MERGE_USAGE,
    },
    {
      name: "workspace",
      args: ["workspace", "--quiet", "extra"],
      code: 1,
      stderr: /unknown workspace command "extra"/,
    },
    {
      name: "workspace move",
      args: ["workspace", "move", "--quiet", f.notRepo, f.target],
      code: 1,
      stderr: NOT_A_REPO,
    },
    {
      name: "loop",
      args: ["loop", "recipe", "task", "--quiet", "extra"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "loop list",
      args: ["loop", "list", "--quiet", "extra"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room info",
      args: ["room", "info", "--quiet", "extra"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room send",
      args: ["room", "send", "ann", "--quiet", "hi"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "room add",
      args: ["room", "add", "mock", "--quiet", "extra"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room ff",
      args: ["room", "ff", "ann", "--quiet", "extra"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room diff",
      args: ["room", "diff", "ann", "--quiet", "extra"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room remove",
      args: ["room", "remove", "ann", "--quiet", "extra"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "daemon start",
      args: ["daemon", "start", "--quiet", "extra", "--port", "99999"],
      code: 1,
      stderr:
        "Unexpected argument 'extra'. This command does not take positional arguments",
    },
    {
      name: "daemon stop",
      args: ["daemon", "stop", "--quiet", "extra"],
      code: 1,
      stderr: DAEMON_USAGE,
    },
    {
      name: "daemon add",
      args: ["daemon", "add", "--quiet", f.repo1, "extra"],
      code: 1,
      stderr: DAEMON_USAGE,
    },
    {
      name: "chat",
      args: ["chat", "--no-setup", "attach"],
      code: 1,
      stderr: /error: no daemon is listening/,
    },
  ]);
});

test("-- keeps today's non-separator behaviour", {
  concurrency: 4,
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  await runCases(t, f, [
    {
      name: "prompt",
      args: ["--", "hi", "--agent", "nope"],
      code: 1,
      stdout: HELP,
    },
    {
      name: "help",
      args: ["--", "--help"],
      code: 0,
      stdout: HELP,
    },
    {
      name: "version",
      args: ["--", "--version"],
      code: 1,
      stderr: "-- needs a value",
    },
    {
      name: "demo",
      args: ["demo", "--", "extra"],
      code: 1,
      stderr: DEMO_USAGE,
    },
    {
      name: "run",
      args: ["run", "--file", f.missing1, "--", "prompt"],
      code: 1,
      stderr: /cannot read run file .*missing1\.json/,
    },
    {
      name: "attach",
      args: ["attach", "--", "abc"],
      code: 1,
      stderr: ATTACH_USAGE,
    },
    {
      name: "setup",
      args: ["setup", "--", "extra"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "ps",
      args: ["ps", "--", "extra"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "merge",
      args: ["merge", "--", "20260909-120000-abcd"],
      code: 1,
      stderr: MERGE_USAGE,
    },
    {
      name: "workspace",
      args: ["workspace", "--", "extra"],
      code: 0,
      stdout: stateDirFor(REPO),
    },
    {
      name: "workspace move",
      args: ["workspace", "move", "--", f.notRepo, f.target],
      code: 1,
      stderr: MOVE_USAGE,
    },
    {
      name: "loop",
      args: ["loop", "recipe", "task", "--"],
      code: 1,
      stderr: /error: loop has no option --$/m,
    },
    {
      name: "loop list",
      args: ["loop", "list", "--"],
      code: 1,
      stderr: /error: loop has no option --$/m,
    },
    {
      name: "room info",
      args: ["room", "info", "--"],
      code: 1,
      stderr: /error: room info has no option --$/m,
    },
    {
      name: "room send",
      args: ["room", "send", "ann", "hi", "--"],
      code: 1,
      stderr: /error: room send has no option --; send such text on stdin/m,
    },
    {
      name: "room add",
      args: ["room", "add", "mock", "--"],
      code: 1,
      stderr: /error: room add has no option --$/m,
    },
    {
      name: "room ff",
      args: ["room", "ff", "ann", "--from", "x", "--"],
      code: 1,
      stderr: /error: room ff has no option --$/m,
    },
    {
      name: "room diff",
      args: ["room", "diff", "ann", "--"],
      code: 1,
      stderr: /error: room diff has no option --$/m,
    },
    {
      name: "room remove",
      args: ["room", "remove", "ann", "--"],
      code: 1,
      stderr: /error: room remove has no option --$/m,
    },
    {
      name: "daemon start",
      args: ["daemon", "start", "--", "--port", "99999"],
      code: 1,
      stderr:
        "Unexpected argument '--port'. This command does not take positional arguments",
    },
    {
      name: "daemon stop",
      args: ["daemon", "stop", "--", "extra"],
      code: 0,
      stdout: "no daemon is running",
    },
    {
      name: "daemon add",
      args: ["daemon", "add", "--", f.repo1],
      code: 1,
      stderr: DAEMON_USAGE,
    },
    {
      name: "chat",
      args: ["chat", "--", "--help"],
      code: 1,
      stderr: /error: no daemon is listening/,
    },
  ]);
});

test("an unknown flag records today's policy", {
  concurrency: 4,
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  await runCases(t, f, [
    {
      name: "prompt",
      args: ["hi", "--agent", "nope", "--bogus"],
      code: 1,
      stderr: /unknown agent "nope"/,
    },
    {
      name: "help",
      args: ["--help", "--bogus"],
      code: 0,
      stdout: HELP,
    },
    {
      name: "version",
      args: ["--version", "--bogus"],
      code: 0,
      stdout: VERSION,
    },
    {
      name: "demo",
      args: ["demo", "--bogus"],
      code: 1,
      stderr: DEMO_USAGE,
    },
    {
      name: "run",
      args: ["run", "--file", f.missing1, "--bogus"],
      code: 1,
      stderr: /cannot read run file .*missing1\.json/,
    },
    {
      name: "attach",
      args: ["attach", "abc", "--bogus"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "setup",
      args: ["setup", "--bogus"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "ps",
      args: ["ps", "--bogus"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "merge",
      args: ["merge", "abc", "--bogus"],
      code: 1,
      stderr: /invalid run id "abc"/,
    },
    {
      name: "workspace",
      args: ["workspace", "--bogus"],
      code: 0,
      stdout: stateDirFor(REPO),
    },
    {
      name: "workspace move",
      args: ["workspace", "move", f.notRepo, f.target, "--bogus"],
      code: 1,
      stderr: NOT_A_REPO,
    },
    {
      name: "loop",
      args: ["loop", "recipe", "task", "--bogus"],
      code: 1,
      stderr: "error: loop has no option --bogus",
    },
    {
      name: "loop list",
      args: ["loop", "list", "--bogus"],
      code: 1,
      stderr: "error: loop has no option --bogus",
    },
    {
      name: "room info",
      args: ["room", "info", "--bogus"],
      code: 1,
      stderr: "error: room info has no option --bogus",
    },
    {
      name: "room send",
      args: ["room", "send", "ann", "hi", "--bogus"],
      code: 1,
      stderr: "error: room send has no option --bogus; send such text on stdin",
    },
    {
      name: "room add",
      args: ["room", "add", "mock", "--bogus"],
      code: 1,
      stderr: "error: room add has no option --bogus",
    },
    {
      name: "room ff",
      args: ["room", "ff", "ann", "--from", "x", "--bogus"],
      code: 1,
      stderr: "error: room ff has no option --bogus",
    },
    {
      name: "room diff",
      args: ["room", "diff", "ann", "--bogus"],
      code: 1,
      stderr: "error: room diff has no option --bogus",
    },
    {
      name: "room remove",
      args: ["room", "remove", "ann", "--bogus"],
      code: 1,
      stderr: "error: room remove has no option --bogus",
    },
    {
      name: "daemon start",
      args: ["daemon", "start", "--bogus"],
      code: 1,
      stderr: "Unknown option '--bogus'",
    },
    {
      name: "daemon stop",
      args: ["daemon", "stop", "--bogus"],
      code: 0,
      stdout: "no daemon is running",
    },
    {
      name: "daemon add",
      args: ["daemon", "add", f.repo1, "--bogus"],
      code: 1,
      stderr: NO_DAEMON,
    },
    {
      name: "chat",
      args: ["chat", "--bogus"],
      code: 1,
      stderr: /error: Unknown option '--bogus'/,
    },
  ]);
});

test("every argument refusal owned by cli.ts is pinned", {
  concurrency: 4,
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  await runCases(t, f, [
    {
      name: "no command with an unknown flag",
      args: ["--bogus"],
      code: 1,
      stdout: HELP,
    },
    {
      name: "--version beside a positional",
      args: ["--version", "x"],
      code: 1,
      stderr: "--version takes no other arguments",
    },
    {
      name: "run without a file",
      args: ["run"],
      code: 1,
      stderr: RUN_FILE_USAGE,
    },
    {
      name: "bare --file",
      args: ["--file", f.missing1],
      code: 1,
      stderr: /^--file is a flag of the run verb now/,
    },
    {
      name: "run --file with --agent",
      args: ["run", "--file", f.missing1, "--agent", "pi"],
      code: 1,
      stderr: /^--agent does not apply with --file: .*"agent"/,
    },
    {
      name: "run --file with --cmd",
      args: ["run", "--file", f.missing1, "--cmd", "x"],
      code: 1,
      stderr: /^--cmd does not apply with --file: .*"cmd"/,
    },
    {
      name: "run --file with --mode",
      args: ["run", "--file", f.missing1, "--mode", "safe"],
      code: 1,
      stderr: /^--mode does not apply with --file: .*"mode"/,
    },
    {
      name: "run --file with a prompt",
      args: ["run", "--file", f.missing1, "prompt"],
      code: 1,
      stderr: /a prompt does not apply with --file: .*Got "prompt"/,
    },
    {
      name: "setup with an extra positional",
      args: ["setup", "extra"],
      code: 1,
      stderr: SETUP_USAGE,
    },
    {
      name: "merge without an id",
      args: ["merge"],
      code: 1,
      stderr: MERGE_USAGE,
    },
    {
      name: "merge with two ids",
      args: ["merge", "a", "b"],
      code: 1,
      stderr: MERGE_USAGE,
    },
    {
      name: "merge --rebase",
      args: ["merge", "a", "--rebase"],
      code: 1,
      stderr: "--rebase lands in M3-4; M1c-3 ships --squash only.",
    },
    {
      name: "workspace with an unknown subverb",
      args: ["workspace", "nope"],
      code: 1,
      stderr: /unknown workspace command "nope"/,
    },
    {
      name: "workspace move without paths",
      args: ["workspace", "move"],
      code: 1,
      stderr: MOVE_USAGE,
    },
    {
      name: "loop without arguments",
      args: ["loop"],
      code: 1,
      stderr: LOOP_USAGE,
    },
    {
      name: "loop with one argument",
      args: ["loop", "recipe"],
      code: 1,
      stderr: LOOP_USAGE,
    },
    {
      name: "loop with an empty task",
      args: ["loop", "recipe", ""],
      code: 1,
      stderr: LOOP_USAGE,
    },
    {
      name: "loop with too many positionals",
      args: ["loop", "r", "t", "note", "extra"],
      code: 1,
      stderr: LOOP_USAGE,
    },
    {
      name: "room without a verb",
      args: ["room"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room with an unknown verb",
      args: ["room", "nope"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room info with an extra positional",
      args: ["room", "info", "x"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room send without a name",
      args: ["room", "send"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room add with two positionals",
      args: ["room", "add", "a", "b"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room ff without a name",
      args: ["room", "ff"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room ff with an extra positional",
      args: ["room", "ff", "a", "b"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room ff without --from",
      args: ["room", "ff", "a"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room diff without a name",
      args: ["room", "diff"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room diff with too many positionals",
      args: ["room", "diff", "a", "base", "x"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room diff with a non-base second positional",
      args: ["room", "diff", "a", "head"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room remove without a name",
      args: ["room", "remove"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "room remove with an extra positional",
      args: ["room", "remove", "a", "b"],
      code: 1,
      stderr: ROOM_USAGE,
    },
    {
      name: "daemon without a verb",
      args: ["daemon"],
      code: 1,
      stderr: DAEMON_USAGE,
    },
    {
      name: "daemon with an unknown verb",
      args: ["daemon", "nope"],
      code: 1,
      stderr: DAEMON_USAGE,
    },
    {
      name: "daemon stop with an extra positional",
      args: ["daemon", "stop", "x"],
      code: 1,
      stderr: DAEMON_USAGE,
    },
    {
      name: "daemon add without a path",
      args: ["daemon", "add"],
      code: 1,
      stderr: DAEMON_USAGE,
    },
    {
      name: "daemon add with two paths",
      args: ["daemon", "add", "a", "b"],
      code: 1,
      stderr: DAEMON_USAGE,
    },
    {
      name: "attach without an id",
      args: ["attach"],
      code: 1,
      stderr: ATTACH_USAGE,
    },
    {
      name: "attach with two ids",
      args: ["attach", "a", "b"],
      code: 1,
      stderr: ATTACH_USAGE,
    },
    {
      name: "demo with an extra positional",
      args: ["demo", "x"],
      code: 1,
      stderr: DEMO_USAGE,
    },
  ]);
});

test("kapelle chat passes its arguments through to chat.ts", {
  concurrency: 4,
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  await runCases(t, f, [
    {
      name: "bare kapelle",
      args: [],
      code: 1,
      stdout: CHAT_USAGE,
    },
    {
      name: "bare chat",
      args: ["chat"],
      code: 1,
      stdout: CHAT_USAGE,
    },
    {
      name: "chat --help",
      args: ["chat", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
    {
      name: "a flag before chat",
      args: ["--cwd", f.repo1, "chat", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
    {
      name: "global presentation flags are removed",
      args: ["chat", "--quiet", "--verbose", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
    {
      name: "chat as a flag value survives",
      args: ["chat", "--cwd", "chat", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
    {
      name: "a value after --no-setup stays positional",
      args: ["chat", "--no-setup", "attach"],
      code: 1,
      stderr: /error: no daemon is listening/,
    },
    {
      name: "-- is passed to chat.ts",
      args: ["chat", "--", "--help"],
      code: 1,
      stderr: /error: no daemon is listening/,
    },
    {
      name: "an unknown flag reaches chat.ts",
      args: ["chat", "--bogus"],
      code: 1,
      stderr: /error: Unknown option '--bogus'/,
    },
    {
      name: "--quiet is removed before an unknown flag",
      args: ["chat", "--quiet", "--bogus"],
      code: 1,
      stderr: /error: Unknown option '--bogus'/,
    },
    {
      name: "chat new",
      args: ["chat", "new", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
    {
      name: "chat attach",
      args: ["chat", "attach", "x", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
    {
      name: "chat list",
      args: ["chat", "list", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
    {
      name: "chat dismiss",
      args: ["chat", "dismiss", "x", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
    {
      name: "chat scratch",
      args: ["chat", "scratch", "clean", "--help"],
      code: 0,
      stdout: CHAT_USAGE,
    },
  ]);
});
