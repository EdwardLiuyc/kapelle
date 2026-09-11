/**
 * The daemon — `daemon.ts`, M2-1 (#31) — driven as a real subprocess over
 * real HTTP.
 *
 * **None of this needs a harness**, so it runs in CI like `tests/cli.test.ts`:
 * every run points at `mock-agent.mjs`, and every refusal fails before a
 * subprocess starts. The plumbing is the same `spawnCli` the CLI suite uses,
 * given `daemon.ts` as its script.
 */

import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  gitRepo,
  MOCK_AGENT,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";

interface Daemon {
  url: string;
  token: string;
  cwd: string;
}

/** Boots `daemon.ts` on a free port in `cwd`, and reads back what it wrote. */
async function boot(t: TestContext, cwd: string): Promise<Daemon> {
  const d = spawnCli(t, ["--cwd", cwd, "--port", "0"], "daemon.ts");
  let out = "";
  d.child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  // A daemon that dies at startup must fail with its own words, not a timeout.
  const died = d.done.then((r) => {
    throw new Error(`daemon exited ${r.code}: ${r.stderr}`);
  });
  await Promise.race([d.waitFor("\n"), died]);
  died.catch(() => {});
  const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
  assert.ok(url, `no address in ${JSON.stringify(out)}`);
  const token = await readFile(join(cwd, ".kapelle", "daemon.token"), "utf8");
  return { url, token, cwd };
}

/** A run record, and the `{error}` every refusal sends, typed as the tests
 *  read them: each test asserts only the fields its reply carries. */
interface Reply {
  id: string;
  status: string;
  error: string;
  cancelRequested?: true;
  report: { tasks: { status: string }[] };
  notices: { taskId: string; text: string }[];
}

async function api<T = Reply>(
  d: Daemon,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = d.token,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(d.url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

// --- the token (decided at pickup, 2026-09-11) --------------------------------

test("a request without the right token is refused, and starts nothing", async (t) => {
  const d = await boot(t, await tempDir(t));
  const run = {
    mode: "auto",
    cmd: "node -e 0",
    tasks: [{ id: "a", prompt: "hi" }],
  };

  assert.equal((await api(d, "POST", "/runs", run, null)).status, 401);
  assert.equal(
    (await api(d, "POST", "/runs", run, "0".repeat(64))).status,
    401,
  );
  assert.equal((await api(d, "GET", "/runs", undefined, "short")).status, 401);

  const listed = await api(d, "GET", "/runs");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, []);
});

test("the token is 32 random bytes in a file only the owner can read", async (t) => {
  const d = await boot(t, await tempDir(t));
  const other = await boot(t, await tempDir(t));

  assert.match(d.token, /^[0-9a-f]{64}$/);
  assert.notEqual(d.token, other.token);
  const { mode } = await stat(join(d.cwd, ".kapelle", "daemon.token"));
  assert.equal(mode & 0o777, 0o600);
});

// --- POST /runs and GET --------------------------------------------------------

const mockRun = (
  tasks: Record<string, unknown>[],
  rest: Record<string, unknown> = {},
) => ({ cmd: `node ${MOCK_AGENT}`, mode: "auto", ...rest, tasks });

/** Polls `GET /runs/:id` until the run leaves `running`. */
async function settled(d: Daemon, id: string): Promise<Reply> {
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const r = await api(d, "GET", `/runs/${id}`);
    assert.equal(r.status, 200);
    if (r.body.status !== "running") return r.body;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`run ${id} never settled`);
}

test("POST /runs accepts a run, lists it, and reports it done", async (t) => {
  const d = await boot(t, await tempDir(t));

  const posted = await api(
    d,
    "POST",
    "/runs",
    mockRun([{ id: "one", prompt: "hi" }]),
  );
  assert.equal(posted.status, 202);
  assert.equal(typeof posted.body.id, "string");

  const listed = await api<{ id: string }[]>(d, "GET", "/runs");
  assert.deepEqual(
    listed.body.map((r) => r.id),
    [posted.body.id],
  );

  const run = await settled(d, posted.body.id);
  assert.equal(run.status, "done");
  assert.equal(run.report.tasks[0].status, "done");
});

test("an invalid run is 400 in validateRun's words, and creates no run", async (t) => {
  const d = await boot(t, await tempDir(t));

  const empty = await api(d, "POST", "/runs", { tasks: [] });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /non-empty "tasks" array/);

  const garbled = await fetch(`${d.url}/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${d.token}` },
    body: "{",
  });
  assert.equal(garbled.status, 400);

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("a run that would ask is refused naming M2-3, a bare file included", async (t) => {
  const d = await boot(t, await tempDir(t));

  // No mode anywhere: every registry entry defaults to `ask`, so this is the
  // run file people actually write, and it must not quietly run as `safe`.
  const bare = await api(d, "POST", "/runs", {
    cmd: `node ${MOCK_AGENT}`,
    tasks: [{ id: "one", prompt: "hi" }],
  });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /M2-3/);

  const mixed = await api(
    d,
    "POST",
    "/runs",
    mockRun([
      { id: "calm", prompt: "hi" },
      { id: "curious", prompt: "hi", mode: "ask" },
    ]),
  );
  assert.equal(mixed.status, 400);
  assert.match(mixed.body.error, /"curious"/);

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

test("a dirty tree is 409 in the preflight's words, and creates no run", async (t) => {
  const cwd = await gitRepo(t);
  await writeFile(join(cwd, "wip.txt"), "uncommitted\n");
  const d = await boot(t, cwd);

  const r = await api(
    d,
    "POST",
    "/runs",
    mockRun([{ id: "one", prompt: "hi" }]),
  );
  assert.equal(r.status, 409);
  assert.match(r.body.error, /uncommitted changes/);
  assert.match(r.body.error, /wip\.txt/);

  assert.deepEqual((await api(d, "GET", "/runs")).body, []);
});

// --- DELETE /runs/:id, and what the record carries ----------------------------

test("DELETE cancels a live run, and refuses a settled or unknown one", async (t) => {
  const d = await boot(t, await tempDir(t));
  const posted = await api(
    d,
    "POST",
    "/runs",
    mockRun([
      { id: "stuck", prompt: "hi", cmd: `node ${MOCK_AGENT} --scenario stall` },
    ]),
  );
  const { id } = posted.body;

  // Cancel is cooperative, so the answer is an acknowledgement, not a verdict.
  const cancel = await api(d, "DELETE", `/runs/${id}`);
  assert.equal(cancel.status, 202);
  assert.equal(cancel.body.status, "running");
  assert.equal(cancel.body.cancelRequested, true);

  assert.equal((await settled(d, id)).status, "cancelled");
  assert.equal((await api(d, "DELETE", `/runs/${id}`)).status, 409);
  assert.equal((await api(d, "DELETE", "/runs/nope")).status, 404);
  assert.equal((await api(d, "GET", "/runs/nope")).status, 404);
});

test("containment notices reach the run record, where nothing drops them", async (t) => {
  // #13: these lines are never suppressed. A daemon has no terminal, so the
  // record is the only place a caller can still read them.
  const d = await boot(t, await tempDir(t));
  const posted = await api(
    d,
    "POST",
    "/runs",
    mockRun([{ id: "one", prompt: "hi" }], { mode: "safe" }),
  );

  const { notices } = await settled(d, posted.body.id);
  const find = (re: RegExp) =>
    notices.find((n: { text: string }) => re.test(n.text));
  assert.equal(find(/safe mode was not negotiated/)?.taskId, "one");
  assert.equal(find(/is not a git repository/)?.taskId, "run");
});
