/**
 * The login check and the saved models (M9-4, #299): a check session against
 * `mock-agent.mjs`, each login signal, the time-out, the delete, which agents
 * are due, and a real session's update. `tests/daemon.test.ts` drives the
 * routes and a room with a fake `PATH`.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type TestContext, test } from "node:test";

import { MOCK_AGENT, tempDir, until } from "../../integration/helpers.ts";
import { AGENTS, type SetupSpec } from "../../protocol/registry.ts";
import {
  type AgentCheck,
  checkAgent,
  checkFields,
  dueForCheck,
  noteSession,
  readChecks,
  runChecks,
  stopChecks,
} from "../check.ts";
import type { Setup } from "../harnesses.ts";

const mock = (...args: string[]) => ({
  command: process.execPath,
  args: [MOCK_AGENT, ...args],
});
const setup = (loginSignal?: SetupSpec["loginSignal"]): SetupSpec => ({
  program: "mock",
  login: "mock login",
  ...(loginSignal && { loginSignal }),
});

test("a check reads the models, flat, and an open session is logged in", async () => {
  assert.deepEqual(await checkAgent(mock("--scenario", "models"), setup()), {
    models: [
      { id: "mock/fast", name: "Fast" },
      { id: "mock/smart", name: "Smart" },
    ],
    model: "mock/fast",
    login: "ok",
  });
});

test("-32000 on session/new is logged out", async () => {
  assert.deepEqual(
    await checkAgent(mock("--scenario", "auth-required"), setup()),
    { login: "logged_out" },
  );
});

test("claude's notice gives its state, and copilot's is unknown", async () => {
  assert.equal(
    (await checkAgent(mock("--scenario", "auth-none"), setup("notice"))).login,
    "logged_out",
  );
  assert.equal(
    (await checkAgent(mock("--scenario", "auth-account"), setup("notice")))
      .login,
    "ok",
  );
  // A notice that never comes is no answer.
  assert.equal(
    (await checkAgent(mock(), setup("notice"), 500)).login,
    "unknown",
  );
  assert.equal((await checkAgent(mock(), setup("none"))).login, "unknown");
});

test("a check that runs out of time, or cannot start, is unknown", async () => {
  const started = Date.now();
  assert.deepEqual(
    await checkAgent(mock("--scenario", "silent-session"), setup(), 300),
    { login: "unknown" },
  );
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(
    await checkAgent({ command: "/no/such/agent-acp", args: [] }, setup()),
    { login: "unknown" },
  );
});

test("a check deletes its session when the agent can", async (t) => {
  const store = await mkdtemp(join(tmpdir(), "check-store-"));
  t.after(() => rm(store, { recursive: true, force: true }));
  await checkAgent(mock("--scenario", "models", "--store", store), setup());
  assert.deepEqual(await readdir(store), []);
});

/** A find where every agent is ready at its measured version. */
const allReady = (): Setup => ({
  checkedAt: "2026-10-28T00:00:00.000Z",
  done: true,
  found: Object.fromEntries(
    Object.entries(AGENTS).map(([id, a]) => {
      const v = a.measured?.measuredOn.version;
      return [id, { program: true, version: v, acp: true, acpVersion: v }];
    }),
  ),
});

const fresh = (s: Setup): Record<string, AgentCheck> =>
  Object.fromEntries(
    Object.keys(AGENTS).map((id) => [
      id,
      {
        checkedAt: "2026-10-28T00:00:00.000Z",
        version: s.found[id]?.acpVersion,
        login: "ok",
        models: [],
      },
    ]),
  );

test("which ready agents are due: first start, a new version, no list, or a forced check", () => {
  const s = allReady();
  const ids = Object.keys(AGENTS);
  // The first start: nothing saved.
  assert.deepEqual(dueForCheck(s, {}, false), ids);
  const checks = fresh(s);
  assert.deepEqual(dueForCheck(s, checks, false), []);
  assert.deepEqual(dueForCheck(s, checks, true), ids);

  const pi = s.found.pi;
  assert.ok(pi);
  pi.acpVersion = "0.0.35";
  delete checks.opencode?.models;
  assert.deepEqual(dueForCheck(s, checks, false), ["opencode", "pi"]);

  // Never an agent that is not ready.
  pi.acp = false;
  assert.deepEqual(
    dueForCheck(s, {}, true),
    ids.filter((id) => id !== "pi"),
  );
});

/** Points the user state folder at a new temp folder for this test. */
async function stateHome(t: TestContext) {
  const home = await tempDir(t);
  const before = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = home;
  t.after(() => {
    if (before === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = before;
  });
  return home;
}

test("a real session replaces the models and the login, and keeps the version", async (t) => {
  await stateHome(t);
  assert.deepEqual(readChecks(), {});
  noteSession("pi", { login: "logged_out" });
  assert.equal(readChecks().pi?.login, "logged_out");

  noteSession("pi", {
    login: "ok",
    models: [{ id: "a", name: "A" }],
    model: "a",
  });
  noteSession("pi", { models: [{ id: "b", name: "B" }], model: "b" });
  const pi = readChecks().pi;
  assert.equal(pi?.login, "ok");
  assert.deepEqual(pi?.models, [{ id: "b", name: "B" }]);
  assert.equal(pi?.version, undefined);

  // A `--cmd` harness is not saved.
  noteSession("mock-agent", { login: "ok" });
  assert.equal(readChecks()["mock-agent"], undefined);
});

test("the route shows the hint only when the person may need it", () => {
  const c = (login: AgentCheck["login"]): AgentCheck => ({
    checkedAt: "2026-10-28T00:00:00.000Z",
    login,
  });
  assert.equal(checkFields("kimi", c("logged_out")).loginHint, "kimi login");
  assert.equal(checkFields("copilot", c("unknown")).loginHint, "copilot login");
  assert.equal(checkFields("kimi", c("ok")).loginHint, undefined);
  assert.deepEqual(checkFields("kimi", undefined), {});
});

test("a check uses a temporary folder, sends no prompt, and deletes its session (M9-4)", async (t) => {
  const dir = await tempDir(t);
  const record = join(dir, "requests.jsonl");
  assert.deepEqual(
    await checkAgent(mock("--scenario", "models", "--record", record), setup()),
    {
      models: [
        { id: "mock/fast", name: "Fast" },
        { id: "mock/smart", name: "Smart" },
      ],
      model: "mock/fast",
      login: "ok",
    },
  );

  const requests = (await readFile(record, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; cwd: string });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["initialize", "session/new", "session/delete"],
  );
  const cwd = requests[0]?.cwd;
  assert.ok(cwd);
  assert.match(basename(cwd), /^kapelle-check-/);
  assert.ok(requests.every((request) => request.cwd === cwd));
  await assert.rejects(readdir(cwd));
});

test("a real session during a check is not overwritten by the older check result (M9-4)", async (t) => {
  await stateHome(t);
  const launch = AGENTS.opencode.launch;
  AGENTS.opencode.launch = mock("--scenario", "silent-session");
  t.after(() => {
    AGENTS.opencode.launch = launch;
  });

  const checking = runChecks(
    ["opencode"],
    { opencode: { program: true, acp: true, acpVersion: "2.0.18" } },
    300,
  );
  noteSession("opencode", {
    login: "ok",
    models: [{ id: "fresh", name: "Fresh" }],
    model: "fresh",
  });
  await checking;

  const saved = readChecks().opencode;
  assert.equal(saved?.login, "ok");
  assert.deepEqual(saved?.models, [{ id: "fresh", name: "Fresh" }]);
  assert.equal(saved?.model, "fresh");
  // The version the check ran on is kept, so the agent is not due again.
  assert.equal(saved?.version, "2.0.18");
});

test("checks start all at once (M9-4)", async (t) => {
  await stateHome(t);
  const barrier = await tempDir(t);
  const launch = () =>
    mock("--scenario", "models", "--barrier", barrier, "--barrier-count", "2");
  const opencode = AGENTS.opencode.launch;
  const kimi = AGENTS.kimi.launch;
  AGENTS.opencode.launch = launch();
  AGENTS.kimi.launch = launch();
  t.after(() => {
    AGENTS.opencode.launch = opencode;
    AGENTS.kimi.launch = kimi;
  });

  await runChecks(
    ["opencode", "kimi"],
    {
      opencode: { program: true, acp: true, acpVersion: "2.0.18" },
      kimi: { program: true, acp: true, acpVersion: "2.3.0" },
    },
    10_000,
  );
  const checks = readChecks();
  assert.equal(checks.opencode?.login, "ok");
  assert.equal(checks.opencode?.version, "2.0.18");
  assert.equal(checks.kimi?.login, "ok");
  assert.equal(checks.kimi?.version, "2.3.0");
});

test("a check leaves a session the agent cannot delete (M9-4)", async (t) => {
  const dir = await tempDir(t);
  const record = join(dir, "requests.jsonl");
  assert.deepEqual(await checkAgent(mock("--record", record), setup()), {
    login: "ok",
  });
  const methods = (await readFile(record, "utf8"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { method: string }).method);
  assert.deepEqual(methods, ["initialize", "session/new"]);
});

test("a temporary folder that cannot be made is unknown, not a throw", async (t) => {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = join(await tempDir(t), "missing");
  t.after(() => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  });

  assert.deepEqual(await checkAgent(mock(), setup(), 100), {
    login: "unknown",
  });
});

// `chmod` does not stop root, so as root the folder is removed after all.
test("a temporary folder that cannot be removed does not fail the check", {
  skip: process.getuid?.() === 0 && "root can remove any folder",
}, async (t) => {
  const dir = await tempDir(t);
  const record = join(dir, "requests.jsonl");
  assert.deepEqual(
    await checkAgent(
      mock("--scenario", "models", "--record", record, "--lock-cwd"),
      setup(),
    ),
    {
      models: [
        { id: "mock/fast", name: "Fast" },
        { id: "mock/smart", name: "Smart" },
      ],
      model: "mock/fast",
      login: "ok",
    },
  );

  const requests = (await readFile(record, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { cwd: string });
  const cwd = requests[0]?.cwd;
  assert.ok(cwd);
  // Best effort means the check still answers, even when cleanup could not.
  assert.equal(existsSync(cwd), true);
  for (const path of [join(cwd, "locked"), cwd]) {
    try {
      await chmod(path, 0o700);
    } catch {
      // The locked folder or the check folder may already be gone.
    }
  }
  await rm(cwd, { recursive: true, force: true });
});

test("stopping checks cancels them without saving an unknown result", async (t) => {
  await stateHome(t);
  noteSession("opencode", {
    login: "ok",
    models: [{ id: "kept", name: "Kept" }],
    model: "kept",
  });
  const dir = await tempDir(t);
  const record = join(dir, "requests.jsonl");
  const launch = AGENTS.opencode.launch;
  AGENTS.opencode.launch = mock(
    "--scenario",
    "silent-session",
    "--record",
    record,
  );
  t.after(() => {
    AGENTS.opencode.launch = launch;
  });

  const checking = runChecks(
    ["opencode"],
    { opencode: { program: true, acp: true, acpVersion: "2.0.18" } },
    10_000,
  );
  await until("the check to start", () => existsSync(record));
  await stopChecks();
  await checking;

  const saved = readChecks().opencode;
  assert.equal(saved?.login, "ok");
  assert.deepEqual(saved?.models, [{ id: "kept", name: "Kept" }]);
  assert.equal(saved?.model, "kept");
});

test("a logged-out or unknown agent with no model list settles; one logged in is due (M9-4)", () => {
  const s = allReady();
  const checks = fresh(s);
  for (const id of ["pi", "kimi", "copilot"]) delete checks[id]?.models;
  const kimi = checks.kimi;
  const copilot = checks.copilot;
  assert.ok(kimi && copilot);
  kimi.login = "logged_out";
  copilot.login = "unknown";
  // pi says ok with no list: its list is what is missing.
  assert.deepEqual(dueForCheck(s, checks, false), ["pi"]);
});

test("a checks.json that cannot be written never fails a check or a session (M9-4)", async (t) => {
  const home = await stateHome(t);
  // The write goes through `checks.json.tmp`: a folder there makes it fail,
  // for root too.
  await mkdir(join(home, "kapelle"), { mode: 0o700 });
  await mkdir(join(home, "kapelle", "checks.json.tmp"));
  const launch = AGENTS.opencode.launch;
  AGENTS.opencode.launch = mock("--scenario", "models");
  t.after(() => {
    AGENTS.opencode.launch = launch;
  });
  await runChecks(
    ["opencode"],
    { opencode: { program: true, acp: true, acpVersion: "2.0.18" } },
    10_000,
  );
  noteSession("opencode", { login: "ok" });
  assert.deepEqual(readChecks(), {});
});
