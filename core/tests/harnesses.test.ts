/**
 * The find (M9-3, #298): each state from a fake `PATH`, the version
 * warning, pi-acp's version from its `package.json`, and the saved file.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { fakePath, tempDir } from "../../integration/helpers.ts";
import { AGENTS } from "../../protocol/registry.ts";
import {
  describe,
  findAgents,
  installArgs,
  readSetup,
  runNpm,
  writeSetup,
} from "../harnesses.ts";

/** Whether `pid` is still running, portably on POSIX. `ps` reports nothing
 *  for a missing pid; a zombie has exited and is not running. */
function running(pid: number): boolean {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return false;
  const stat = result.stdout.trim();
  return stat !== "" && !stat.startsWith("Z");
}

async function waitGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (running(pid) && Date.now() < deadline) await delay(20);
  return !running(pid);
}

test("the find gives each agent its state from PATH, the agent first", async (t) => {
  const bin = await fakePath(t);
  const found = await findAgents(bin);
  const byId = new Map(
    describe({ checkedAt: "now", done: false, found }).map((a) => [a.id, a]),
  );

  // Its own ACP program, at the measured build: ready, no warning.
  assert.deepEqual(byId.get("opencode"), {
    id: "opencode",
    state: "ready",
    program: "opencode",
    version: "2.0.18",
    acpProgram: "opencode",
    acpVersion: "2.0.18",
  });
  assert.equal(byId.get("kimi")?.state, "ready");
  assert.equal(byId.get("kimi")?.warning, undefined);

  // pi-acp's version is read from its package, never by running it.
  const pi = byId.get("pi");
  assert.equal(pi?.state, "ready");
  assert.equal(pi?.version, "1.3.0");
  assert.equal(pi?.acpVersion, "0.0.33");
  assert.match(
    pi?.warning ?? "",
    /pi-acp 0\.0\.33 is not the build .*0\.0\.34/,
  );
  const pkg = dirname(dirname(realpathSync(join(bin, "pi-acp"))));
  assert.equal(existsSync(join(pkg, "pi-acp.ran")), false);

  // The agent without its ACP program: the command to install it.
  assert.equal(byId.get("claude")?.state, "main_only");
  assert.equal(
    byId.get("claude")?.install,
    "npm i -g @agentclientprotocol/claude-agent-acp@0.89.1",
  );
  // The main program's version is shown, never compared.
  assert.equal(byId.get("claude")?.warning, undefined);

  // An ACP program without its agent, and nothing at all.
  assert.equal(byId.get("codex")?.state, "not_installed");
  assert.equal(byId.get("codex")?.install, undefined);
  assert.equal(byId.get("copilot")?.state, "not_installed");
});

test("the saved find reads back, and a file missing an agent reads as none", async (t) => {
  const home = await tempDir(t);
  const before = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = home;
  t.after(() => {
    if (before === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = before;
  });

  assert.equal(readSetup(), undefined);
  const found = await findAgents(await fakePath(t));
  writeSetup({ checkedAt: "2026-10-22T00:00:00.000Z", done: true, found });
  assert.deepEqual(readSetup(), {
    checkedAt: "2026-10-22T00:00:00.000Z",
    done: true,
    // A version not found is left out of the file.
    found: JSON.parse(JSON.stringify(found)),
  });

  // An agent the registry gained since: the next ask finds again.
  const { kimi: _, ...older } = found;
  writeSetup({ checkedAt: "x", done: true, found: older });
  assert.equal(readSetup(), undefined);

  await writeFile(join(home, "kapelle", "harnesses.json"), "{not json");
  assert.equal(readSetup(), undefined);
});

test("a version probe gets the secret-free harness environment", async (t) => {
  const root = await tempDir(t);
  const bin = join(root, "bin");
  const seen = join(root, "env.txt");
  await mkdir(bin);
  await writeFile(
    join(bin, "opencode"),
    `#!/bin/sh
printf '%s|%s\n' "\${KAPELLE_TOKEN-<missing>}" "\${HARNESS_PROBE_VISIBLE-<missing>}" > ${JSON.stringify(seen)}
echo 1.2.3
`,
    { mode: 0o755 },
  );

  const beforeToken = process.env.KAPELLE_TOKEN;
  const beforeVisible = process.env.HARNESS_PROBE_VISIBLE;
  process.env.KAPELLE_TOKEN = "daemon-secret";
  process.env.HARNESS_PROBE_VISIBLE = "visible";
  t.after(() => {
    if (beforeToken === undefined) delete process.env.KAPELLE_TOKEN;
    else process.env.KAPELLE_TOKEN = beforeToken;
    if (beforeVisible === undefined) delete process.env.HARNESS_PROBE_VISIBLE;
    else process.env.HARNESS_PROBE_VISIBLE = beforeVisible;
  });

  const found = await findAgents(bin);
  assert.equal(found.opencode?.version, "1.2.3");
  assert.equal(
    (await readFile(seen, "utf8")).trim(),
    "<missing>|visible",
    "the probe must not see KAPELLE_TOKEN, but must keep ordinary env",
  );
});

test("a version probe that ignores TERM cannot wedge the find", async (t) => {
  const root = await tempDir(t);
  const bin = join(root, "bin");
  const pidFile = join(root, "probe.pid");
  const sleepPidFile = join(root, "sleep.pid");
  await mkdir(bin);
  await writeFile(
    join(bin, "opencode"),
    `#!/bin/sh
trap '' TERM
echo $$ > ${JSON.stringify(pidFile)}
sleep 30 &
echo $! > ${JSON.stringify(sleepPidFile)}
wait
`,
    { mode: 0o755 },
  );
  const pids = async () => {
    const result: number[] = [];
    for (const file of [pidFile, sleepPidFile]) {
      try {
        const pid = Number(await readFile(file, "utf8"));
        if (Number.isInteger(pid) && pid > 0) result.push(pid);
      } catch {
        // It may not have started if the assertion fails very early.
      }
    }
    return result;
  };
  t.after(async () => {
    for (const pid of await pids()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  const started = Date.now();
  const found = await findAgents(bin);
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 10_000,
    `findAgents must settle after its 5s version timeout; took ${elapsed}ms ` +
      "because a SIGTERM-ignoring child wedged the probe",
  );
  assert.equal(found.opencode?.program, true);
  assert.equal(
    found.opencode?.version,
    undefined,
    "a timed-out probe contributes no version",
  );

  for (const pid of await pids()) {
    assert.equal(
      await waitGone(pid),
      true,
      `the version probe left pid ${pid} running`,
    );
  }
});

test("a version probe stops reading and kills a child that floods stdout", async (t) => {
  const root = await tempDir(t);
  const bin = join(root, "bin");
  const pidFile = join(root, "probe.pid");
  const sleepPidFile = join(root, "sleep.pid");
  await mkdir(bin);
  await writeFile(
    join(bin, "opencode"),
    `#!/bin/sh
echo "opencode v2.0.18"
echo $$ > ${JSON.stringify(pidFile)}
sleep 30 &
echo $! > ${JSON.stringify(sleepPidFile)}
i=0
while [ "$i" -lt 128 ]; do
  printf '%1024s\\n' ''
  i=$((i + 1))
done
wait
`,
    { mode: 0o755 },
  );
  const pids = async () => {
    const result: number[] = [];
    for (const file of [pidFile, sleepPidFile]) {
      try {
        const pid = Number(await readFile(file, "utf8"));
        if (Number.isInteger(pid) && pid > 0) result.push(pid);
      } catch {
        // The probe was killed before this process started.
      }
    }
    return result;
  };
  t.after(async () => {
    for (const pid of await pids()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  const started = Date.now();
  const found = await findAgents(bin);
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 4_000,
    `findAgents must cap probe output instead of waiting for its timeout; ` +
      `took ${elapsed}ms`,
  );
  assert.equal(found.opencode?.program, true);
  assert.equal(
    found.opencode?.version,
    "2.0.18",
    "the valid version line before the flood is still seen",
  );
  const startedPids = await pids();
  assert.ok(startedPids.length > 0, "the fake opencode recorded its pid");
  for (const pid of startedPids) {
    assert.equal(
      await waitGone(pid),
      true,
      `the flooded version probe left pid ${pid} running`,
    );
  }
});

test("pi-acp's package version is extracted, not trusted as arbitrary text", async (t) => {
  const root = await tempDir(t);
  const bin = join(root, "bin");
  const pkg = join(root, "lib", "pi-acp");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(bin, "pi"), "#!/bin/sh\necho 1.3.0\n", {
    mode: 0o755,
  });
  await writeFile(join(pkg, "dist", "index.js"), "", { mode: 0o755 });
  await symlink(join(pkg, "dist", "index.js"), join(bin, "pi-acp"));

  const packageFile = join(pkg, "package.json");
  await writeFile(
    packageFile,
    JSON.stringify({ version: "0.0.33\u001b]52;c;evil\u0007" }),
  );
  assert.equal(
    (await findAgents(bin)).pi?.acpVersion,
    "0.0.33",
    "only the version-shaped part of package.json may reach setup output",
  );

  await writeFile(
    packageFile,
    JSON.stringify({ version: "\u001b]52;c;evil\u0007not-a-version" }),
  );
  assert.equal((await findAgents(bin)).pi?.acpVersion, undefined);
});

test("the warning compares the ACP version, never the main version", () => {
  const base = {
    checkedAt: "now",
    done: false,
    found: {
      opencode: {
        program: true,
        version: "99.0.0",
        acp: true,
        acpVersion: "2.0.18",
      },
    },
  };
  assert.equal(
    describe(base).find((a) => a.id === "opencode")?.warning,
    undefined,
    "a different main-program version must not warn",
  );

  const mismatched = {
    ...base,
    found: {
      opencode: { ...base.found.opencode, acpVersion: "1.0.0" },
    },
  };
  assert.match(
    describe(mismatched).find((a) => a.id === "opencode")?.warning ?? "",
    /opencode 1\.0\.0 is not the build kapelle measured: 2\.0\.18/,
  );
});

test("a version probe gets the entry's own env: claude's drops its parent session's variables", async (t) => {
  const root = await tempDir(t);
  const bin = join(root, "bin");
  const seen = join(root, "claudecode.txt");
  await mkdir(bin);
  const record = `#!/bin/sh
echo "\${CLAUDECODE-<missing>}" >> ${JSON.stringify(seen)}
echo 0.89.1
`;
  await writeFile(join(bin, "claude"), record, { mode: 0o755 });
  await writeFile(join(bin, "claude-agent-acp"), record, { mode: 0o755 });
  const before = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = before;
  });

  const found = await findAgents(bin);
  assert.equal(found.claude?.acpVersion, "0.89.1");
  assert.deepEqual((await readFile(seen, "utf8")).trim().split("\n"), [
    "<missing>",
    "<missing>",
  ]);
});

test("only a ready agent gets a version warning", () => {
  // codex-acp at a build kapelle did not measure, with no codex: the list
  // says "not installed", so a warning about its build would contradict it.
  const [codex] = describe({
    checkedAt: "now",
    done: false,
    found: { codex: { program: false, acp: true, acpVersion: "9.9.9" } },
  });
  assert.equal(codex?.state, "not_installed");
  assert.equal(codex?.warning, undefined);
});

test("a broken package.json gives pi-acp no version, never its parent's", async (t) => {
  const root = await tempDir(t);
  const bin = join(root, "bin");
  const pkg = join(root, "lib", "pi-acp");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(bin, "pi"), "#!/bin/sh\necho 1.3.0\n", { mode: 0o755 });
  await writeFile(join(pkg, "dist", "index.js"), "", { mode: 0o755 });
  await symlink(join(pkg, "dist", "index.js"), join(bin, "pi-acp"));
  await writeFile(join(pkg, "package.json"), "{broken");
  await writeFile(join(root, "lib", "package.json"), '{"version":"7.7.7"}');

  const found = await findAgents(bin);
  assert.equal(found.pi?.acp, true);
  assert.equal(found.pi?.acpVersion, undefined);
});

test("the install pins each npm package to the build kapelle measured (M9-3b)", () => {
  for (const [id, a] of Object.entries(AGENTS)) {
    if (!a.setup?.npm) {
      assert.equal(installArgs(id), undefined, id);
      continue;
    }
    assert.deepEqual(
      installArgs(id),
      ["i", "-g", `${a.setup.npm}@${a.measured?.measuredOn.version}`],
      id,
    );
  }
  assert.deepEqual(installArgs("pi"), ["i", "-g", "pi-acp@0.0.34"]);
  // An id that is not an entry, an inherited name included, installs nothing.
  for (const id of ["nope", "__proto__", "constructor", "npm i -g evil"]) {
    assert.equal(installArgs(id), undefined, id);
  }
});

/** Runs `runNpm` with `npm` as the script `body`, first on `PATH`. */
async function withNpm(
  t: import("node:test").TestContext,
  body: string | undefined,
  timeoutMs?: number,
) {
  const bin = await tempDir(t);
  if (body !== undefined) {
    await writeFile(join(bin, "npm"), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  }
  // The fake npm needs `sleep`; with no npm, PATH holds nothing else.
  const path = process.env.PATH;
  process.env.PATH = body === undefined ? bin : `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  let out = "";
  const error = await runNpm(
    ["i", "-g", "pi-acp@0.0.34"],
    (text) => {
      out += text;
    },
    timeoutMs,
  );
  return { error, out, bin };
}

test("runNpm passes npm's argv and output on, and names a failure (M9-3b)", async (t) => {
  const ok = await withNpm(t, 'echo "argv: $*"; echo warn >&2');
  assert.equal(ok.error, undefined);
  assert.match(ok.out, /argv: i -g pi-acp@0\.0\.34\n/);
  assert.match(ok.out, /warn/);

  const failed = await withNpm(t, "echo EACCES >&2; exit 243");
  assert.equal(failed.error, "npm exited with code 243");
  assert.match(failed.out, /EACCES/);

  const missing = await withNpm(t, undefined);
  assert.equal(missing.error, "no npm on the daemon's PATH");
});

test("runNpm kills an npm that takes too long, with its whole group (M9-3b)", async (t) => {
  const r = await withNpm(t, "sleep 30 & echo $! ; wait", 300);
  assert.equal(r.error, "npm took longer than 0.3 s");
  const pid = Number(r.out.trim());
  assert.ok(pid > 0, r.out);
  assert.ok(await waitGone(pid), "the child npm left behind is gone");
});

test("runNpm stops forwarding output once its time limit ends (M9-3b)", async (t) => {
  const bin = await tempDir(t);
  await writeFile(
    join(bin, "npm"),
    [
      `#!${process.execPath}`,
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", "setTimeout(() => console.log('late'), 600)"], { detached: true, stdio: ["ignore", 1, 2] });`,
      "setTimeout(() => {}, 30_000);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  let out = "";
  const error = await runNpm(
    ["i", "-g", "pi-acp@0.0.34"],
    (text) => {
      out += text;
    },
    200,
  );
  assert.equal(error, "npm took longer than 0.2 s");
  // A descendant the group kill did not reach still holds stdout. Its output
  // must not arrive after the timeout and be mistaken for the next agent's.
  await delay(1_000);
  assert.equal(out, "");
});

test("an agent with no measured build gets no install (M9-3b)", () => {
  const claude = AGENTS.claude;
  assert.ok(claude);
  const measured = claude.measured;
  assert.ok(measured);
  delete claude.measured;
  try {
    assert.equal(installArgs("claude"), undefined);
    const found = describe({
      checkedAt: "now",
      done: false,
      found: { claude: { program: true, version: "2.1.307", acp: false } },
    });
    assert.equal(found.find((a) => a.id === "claude")?.install, undefined);
  } finally {
    claude.measured = measured;
  }
});
