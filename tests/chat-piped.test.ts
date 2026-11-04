/**
 * `chat.ts` with no terminal: one room as plain lines (`chat/piped.ts`),
 * the `list` and `dismiss` verbs, `kapelle chat` handing over to `chat.ts`,
 * and the rule that the chat reaches the daemon over HTTP only. Most tests
 * drive a real `daemon.ts`; a few stand up a fake one to send a reply the
 * real one never sends.
 *
 * Each daemon gets its own `XDG_RUNTIME_DIR` **and `XDG_STATE_HOME`**, so no
 * test ever meets another test's `daemon.json` or `repos.json` — or the
 * developer's real ones — even while the other files run at the same time.
 * The helpers more than one of these files needs live in
 * `integration/helpers.ts`.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import {
  API_VERSION,
  type HarnessesReply,
  type RoomDto,
  type RoomListEntry,
} from "../client/contract.ts";
import {
  addRepo as added,
  answersIn,
  api,
  bootDaemon as boot,
  bootFinding,
  commitAt,
  fakePath,
  gitRepo,
  MOCK_AGENT,
  only,
  REMEMBER,
  REPO,
  type RoomReply,
  roomIdle,
  roomLog,
  roomToRestart,
  runCli,
  spawnCli,
  tempDir,
  until,
  withAgent,
} from "../integration/helpers.ts";

// --- chat rooms (chat MVP) ------------------------------------------------------

test("chat.ts reports a daemon that went away instead of a dismissal, and exits non-zero", {
  // The screen waits 30 s for the daemon to come back (M6-7d).
  timeout: 60_000,
}, async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));

  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  await c.waitFor("type a message");

  // A daemon that goes away ends the SSE stream, the same wire shape a
  // dismissal has. The client must reconcile with `GET /rooms/:id` instead of
  // reporting a dismissal that never happened.
  process.kill(d.pid, "SIGKILL");
  const r = await c.done;

  assert.notEqual(r.code, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /the room was dismissed/);
  assert.match(r.stderr, /lost the daemon|lost the room stream/);
});

test("chat.ts new prints the daemon's refusal message, not an object", async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  const unadded = await tempDir(t);

  // The daemon refuses an unadded cwd with `{error:{code,message}}`; the chat
  // front end must show `error.message`, not stringify the object (M5-3,
  // #135).
  const refused = await spawnCli(
    t,
    ["new", "--cmd", REMEMBER, "--cwd", unadded],
    "chat.ts",
    { XDG_RUNTIME_DIR: runtime },
  ).done;
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /has not been added to the daemon/);
  assert.doesNotMatch(refused.stderr, /\[object Object\]/);
});

test("chat.ts in a removed folder says so, and still lists rooms", async (t) => {
  const runtime = await tempDir(t);
  await boot(t, runtime);
  // A child cannot start in a removed folder, so `sh` goes in, removes it,
  // then runs chat.ts there.
  const run = async (...args: string[]) =>
    spawnSync(
      "sh",
      [
        "-c",
        'cd "$1" && rmdir "$1" && shift && exec "$@"',
        "sh",
        await tempDir(t),
        process.execPath,
        join(REPO, "chat.ts"),
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env, XDG_RUNTIME_DIR: runtime } },
    );

  const made = await run("new", "--cmd", REMEMBER);
  assert.equal(made.status, 1, made.stderr);
  assert.match(made.stderr, /the current folder was removed/);
  assert.doesNotMatch(made.stderr, /uv_cwd/);

  const listed = await run("list");
  assert.equal(listed.status, 0, listed.stderr);
});

test("chat.ts names the status for a refusal with no JSON envelope", async (t) => {
  // Node's own 408 has an empty body, and a body of `null` is JSON with no
  // `error`: both used to print "error: undefined" or "not JSON".
  for (const body of ["", "null"]) {
    // `GET /version` is answered, so the refusal under test is the room's.
    const fake = createServer((req, res) => {
      if (req.url === "/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ apiVersion: API_VERSION }));
        return;
      }
      res.writeHead(408, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
    t.after(() => fake.close());
    const runtime = await tempDir(t);
    await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
    const { port } = fake.address() as AddressInfo;
    await writeFile(
      join(runtime, "kapelle", "daemon.json"),
      JSON.stringify({ pid: process.pid, port, token: "t" }),
      { mode: 0o600 },
    );
    const r = await spawnCli(t, ["attach", "room-x"], "chat.ts", {
      XDG_RUNTIME_DIR: runtime,
    }).done;
    assert.equal(r.code, 1, r.stderr);
    assert.equal(
      r.stderr.trim(),
      "error: HTTP 408",
      `body ${JSON.stringify(body)}`,
    );
  }
});

test("chat.ts new --name names an agent whose harness label is not a valid name", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const env = { XDG_RUNTIME_DIR: runtime };
  // A full path is the label, and a path breaks R22's name rule.
  const cmd = `${process.execPath} ${MOCK_AGENT}`;

  const unnamed = await spawnCli(
    t,
    ["new", "--cmd", cmd, "--cwd", cwd],
    "chat.ts",
    env,
  ).done;
  assert.equal(unnamed.code, 1);
  assert.match(unnamed.stderr, /give the agent a "name"/);

  const named = spawnCli(
    t,
    ["new", "--cmd", cmd, "--name", "bob", "--cwd", cwd],
    "chat.ts",
    env,
  );
  named.child.stdin.end("/dismiss\n");
  const r = await named.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /· bob \(/);
});

test("chat.ts new opens its agent as a developer (#333)", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("/leave\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  const [room] = (await api<RoomListEntry[]>(d, "GET", "/rooms")).body;
  assert.deepEqual(
    room?.participants.map((p) => [p.name, p.role]),
    [["mock-agent", "developer"]],
  );
});

test("chat.ts list prints each room's id, status, names and cwd (#431)", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const otherCwd = await added(d, await gitRepo(t));
  const empty = await api<RoomDto>(d, "POST", "/rooms", { cwd });
  assert.equal(empty.status, 201, JSON.stringify(empty.body));
  const pair = await api<RoomDto>(d, "POST", "/rooms", {
    cwd: otherCwd,
    agents: [
      { cmd: REMEMBER, name: "alice" },
      { cmd: REMEMBER, name: "bob" },
    ],
  });
  assert.equal(pair.status, 201, JSON.stringify(pair.body));
  const dismissed = await api<RoomDto>(
    d,
    "POST",
    `/rooms/${empty.body.id}/dismiss`,
  );
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));

  const r = await spawnCli(t, ["list"], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  }).done;
  assert.equal(r.code, 0, r.stderr);
  // A room with no participant prints "-" in the names column. Both sides
  // are sorted because `docs/CLIENT-API.md` promises no order for `GET /rooms`.
  assert.deepEqual(
    r.stdout.trimEnd().split("\n").sort(),
    [
      `${empty.body.id}  dismissed  -  ${empty.body.cwd}`,
      `${pair.body.id}  active  alice,bob  ${pair.body.cwd}`,
    ].sort(),
  );
});

test("chat.ts list prints the daemon's refusal and exits non-zero (#431)", async (t) => {
  // The real daemon does not refuse `GET /rooms`, so a fake one does.
  const fake = createServer((req, res) => {
    res.writeHead(req.url === "/version" ? 200 : 503, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url === "/version"
          ? { apiVersion: API_VERSION }
          : { error: { code: "shutting_down", message: "going away" } },
      ),
    );
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  t.after(() => fake.close());
  const runtime = await tempDir(t);
  await mkdir(join(runtime, "kapelle"), { mode: 0o700 });
  const { port } = fake.address() as AddressInfo;
  await writeFile(
    join(runtime, "kapelle", "daemon.json"),
    JSON.stringify({ pid: process.pid, port, token: "t" }),
    { mode: 0o600 },
  );

  const r = await spawnCli(t, ["list"], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  }).done;
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim(), "error: going away");
});

test("chat.ts dismiss stops a room, and prints the daemon's refusal or the usage (#431)", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const room = await api<RoomDto>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: REMEMBER }],
  });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  const id = room.body.id;
  const chat = (...args: string[]) =>
    spawnCli(t, args, "chat.ts", { XDG_RUNTIME_DIR: runtime }).done;

  const ok = await chat("dismiss", id);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, `dismissed ${id}\n`);
  const gone = await api<RoomDto>(d, "GET", `/rooms/${id}`);
  assert.equal(gone.body.status, "dismissed");

  const again = await chat("dismiss", id);
  assert.equal(again.code, 1);
  assert.equal(again.stderr.trim(), `error: room ${id} is already dismissed`);

  const unknown = await chat("dismiss", "room-x");
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stderr.trim(), "error: no room room-x");

  const bare = await chat("dismiss");
  assert.equal(bare.code, 1);
  assert.equal(bare.stdout, "");
  assert.match(bare.stderr, /^usage:\n/);
  assert.match(bare.stderr, /node chat\.ts dismiss <roomId>/);
});

test("chat.ts talks to a room end to end: messages in, answers out, /dismiss stops it", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));

  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("alpha\nbeta\n/dismiss\n");
  const r = await c.done;

  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /you → mock-agent: alpha\nmock-agent: previous: \(none\)\n/,
  );
  assert.match(
    r.stdout,
    /you → mock-agent: beta\nmock-agent: previous: alpha\n/,
  );
  assert.match(r.stdout, /the room was dismissed/);
  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  assert.deepEqual(
    rooms.body.map((room) => room.status),
    ["dismissed"],
  );
});

test("piped chat.ts prints an agent's tool calls under its name, and names it once per answer", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // The default mock turn: text, a tool call, text, a tool call, text.
  const c = spawnCli(
    t,
    ["new", "--cmd", `node ${MOCK_AGENT}`, "--cwd", cwd],
    "chat.ts",
    { XDG_RUNTIME_DIR: runtime },
  );
  c.child.stdin.end("go\n/dismiss\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /you → mock-agent: go\nmock-agent: Reading package\.json via the client… *\n {2}· Read package\.json\ngot \d+ chars\.\n {2}· Write ACP_TEST\.md\nWrote ACP_TEST\.md\./,
  );
  assert.equal(r.stdout.match(/^mock-agent:/gm)?.length, 1, r.stdout);
});

test("chat.ts prints an answer that comes in two chunks once", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));

  const c = spawnCli(
    t,
    ["new", "--cmd", `node ${MOCK_AGENT} --scenario split`, "--cwd", cwd],
    "chat.ts",
    { XDG_RUNTIME_DIR: runtime },
  );
  c.child.stdin.end("alpha\nbeta\n/dismiss\n");
  const r = await c.done;

  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /you → mock-agent: alpha\nmock-agent: previous: \(none\)\n/,
  );
  assert.match(
    r.stdout,
    /you → mock-agent: beta\nmock-agent: previous: alpha\n/,
  );
});

test("chat.ts and chat/ reach the daemon over HTTP only: client/, pi-tui and core/runtime.ts", async () => {
  // S8, widened by M4-1: chat.ts imports `client/`, pi-tui and
  // `core/runtime.ts` (the `daemon.json` path), type imports included.
  // M4-13 adds `@xterm/headless`, in `chat/tui/term.ts` alone.
  // Since M4-7 every file in chat/ holds the same rule, and the walk goes
  // into every subfolder, such as chat/tui/ (M4-12). They may import each
  // other, but never chat.ts: the arrow is chat.ts → chat/, and chat.ts
  // runs `main()` when it loads. A tests/ folder is not read: a test may
  // import anything. `client/` is then followed file by file, so a
  // `client/` file that reached `core/` or `protocol/` at runtime fails here
  // too. A type-only import there is allowed: it is erased before the code
  // runs.
  const root = join(import.meta.dirname, "..");
  const importsOf = async (file: string) => {
    const source = await readFile(join(root, file), "utf8");
    // `export … from` and a bare `import "x"` load a module too. A literal
    // `import("x")` loads one when it runs, so it gets the same check.
    const staticImports = [
      ...source.matchAll(
        /^(?:(?:import|export)( type)?[^;]*?from|import) "([^"]+)";/gms,
      ),
    ].map((m) => ({ spec: m[2] ?? "", typeOnly: Boolean(m[1]) }));
    const dynamicImports = [
      ...source.matchAll(/\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g),
    ].map((m) => ({ spec: m[2], typeOnly: false }));
    return [...staticImports, ...dynamicImports];
  };
  const screens = ["chat.ts"];
  for (const entry of await readdir(join(root, "chat"), {
    withFileTypes: true,
    recursive: true,
  })) {
    const file = relative(root, join(entry.parentPath, entry.name));
    if (file.split(sep).includes("tests")) continue;
    if (entry.isFile() && entry.name.endsWith(".ts")) screens.push(file);
  }
  const queue: string[] = [];
  for (const file of screens) {
    for (const { spec } of await importsOf(file)) {
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) {
        // One file of pi-tui by name: `decodePrintableKey` is not in its
        // main exports (M7-4). Another deep import is a new decision.
        // M4-13: the shell's screen, in the shell's file only.
        const term =
          spec === "@xterm/headless" && file === join("chat", "tui", "term.ts");
        assert.ok(
          spec === "@earendil-works/pi-tui" ||
            spec === "@earendil-works/pi-tui/dist/keys.js" ||
            term,
          `${file} imports ${spec}`,
        );
        continue;
      }
      const target = join(dirname(file), spec);
      if (target.startsWith(`client${sep}`)) queue.push(target);
      else {
        assert.ok(
          target === join("core", "runtime.ts") ||
            (target !== "chat.ts" && screens.includes(target)),
          `${file} imports ${spec}`,
        );
      }
    }
  }
  assert.ok(queue.length > 0, "chat.ts imports client/");
  // Every file directly in client/ too, not only what chat.ts imports: one
  // that nothing imports yet is under the same S8 boundary. client/tests/
  // is not swept: a test may import anything.
  for (const entry of await readdir(join(root, "client"), {
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      queue.push(`client/${entry.name}`);
    }
  }
  const seen = new Set<string>();
  for (const file of queue) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec, typeOnly } of await importsOf(file)) {
      if (typeOnly || spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("."), `${file} imports the package ${spec}`);
      const target = join(dirname(file), spec);
      assert.ok(
        target.startsWith(`client${sep}`),
        `${file} reaches ${spec} at runtime`,
      );
      queue.push(target);
    }
  }
});

test("chat.ts /leave keeps the room alive, and attach replays the conversation before the next turn", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const env = { XDG_RUNTIME_DIR: runtime };

  const first = spawnCli(
    t,
    ["new", "--cmd", REMEMBER, "--cwd", cwd],
    "chat.ts",
    env,
  );
  first.child.stdin.end("alpha\n/leave\n");
  assert.equal((await first.done).code, 0);

  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  assert.deepEqual(
    rooms.body.map((room) => room.status),
    ["active"],
    "leaving kept it",
  );
  const id = rooms.body[0]?.id as string;

  const again = spawnCli(t, ["attach", id], "chat.ts", env);
  again.child.stdin.end("beta\n/dismiss\n");
  const r = await again.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /you → mock-agent: alpha\nmock-agent: previous: \(none\)\n[\s\S]*you → mock-agent: beta\nmock-agent: previous: alpha\n/,
    "history first, then the new turn — on the same harness",
  );
});

test("chat.ts attributes an answer to the roster name, not the harness label", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const c = spawnCli(
    t,
    ["new", "--cmd", REMEMBER, "--name", "alice", "--cwd", cwd],
    "chat.ts",
    { XDG_RUNTIME_DIR: runtime },
  );
  c.child.stdin.end("alpha\n/dismiss\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /alice: previous: \(none\)/);
  assert.doesNotMatch(r.stdout, /mock-agent: previous/);
});

test("piped chat.ts with no orchestrator: no mention reaches the only agent, is refused with two, and @name reaches the participant", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  // Built through the API, so no participant has the orchestrator role.
  const piped = async (
    agents: { cmd: string; name: string }[],
    in_: string,
  ) => {
    const open = await api<RoomReply>(d, "POST", "/rooms", { cwd, agents });
    assert.equal(open.status, 201, open.body.error?.message);
    const c = spawnCli(t, ["attach", open.body.id], "chat.ts", {
      XDG_RUNTIME_DIR: runtime,
    });
    c.child.stdin.end(in_);
    const r = await c.done;
    assert.equal(r.code, 0, r.stderr);
    return r;
  };
  const bob = { cmd: REMEMBER, name: "bob" };
  // One agent (#333).
  const one = await piped([bob], "hi\n/dismiss\n");
  assert.doesNotMatch(one.stderr, /no orchestrator/);
  assert.match(one.stdout, /you → bob: hi\nbob: previous: \(none\)/);

  const two = await piped(
    [bob, { cmd: REMEMBER, name: "carol" }],
    "hi\n@Bob, hi\n/dismiss\n",
  );
  assert.match(two.stderr, /no orchestrator: start with @name/);
  assert.match(two.stdout, /you → bob: hi\nbob: previous: \(none\)/);
});

test("piped chat.ts sends a message with no mention to the orchestrator, and @name to that participant", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "alice", role: "orchestrator" },
      { cmd: REMEMBER, name: "bob" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const c = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("one\n@bob two\nthree\n@alice @bob four\n@bob\n/dismiss\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  // Each answers with its own previous prompt: two memories, one room.
  assert.match(r.stdout, /you → alice: one\nalice: previous: \(none\)/);
  assert.match(r.stdout, /you → bob: two\nbob: previous: \(none\)/);
  // Alice never ordered bob, so his answer sent her no copy (#333).
  assert.doesNotMatch(r.stdout, /\[copy\]/);
  assert.match(r.stdout, /you → alice: three\nalice: previous: one/);
  assert.match(r.stderr, /name one participant/);
  assert.match(r.stderr, /nothing to send/);
});

test("kapelle chat runs chat.ts", async (t) => {
  const r = await runCli(t, ["chat", "--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /node chat\.ts new --agent/);
});

test("kapelle chat takes a flag whose value is also a verb", async (t) => {
  // The dispatcher must remove the verb's own argv word, not the first
  // literal "chat", which here is `--name`'s value.
  const r = await runCli(t, [
    "--name",
    "chat",
    "--cwd",
    "/tmp",
    "chat",
    "--help",
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /node chat\.ts new --agent/);
});

test("piped chat.ts takes /leave after an @name, as the screen does", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("@mock-agent /leave\nnever sent\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /you → /);
});

test("kapelle chat takes the global --quiet and --verbose", async (t) => {
  const r = await runCli(t, ["chat", "--quiet", "--verbose", "--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /node chat\.ts new --agent/);
});

// --- room commands (M4-5) -----------------------------------------------------

test("the piped chat prints the setup list on /setup, and /setup done says done (M9-3)", async (t) => {
  // The fake agents, and only the tools the room needs: node for the mock
  // harness, git for the repository.
  const bin = await fakePath(t);
  await symlink(process.execPath, join(bin, "node"));
  await symlink(
    execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
    join(bin, "git"),
  );
  const { d, runtime } = await bootFinding(t, bin);
  const cwd = await added(d, await gitRepo(t));
  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  await c.waitFor("type a message");
  c.child.stdin.write("/setup\n");
  await c.waitFor("After an install");
  c.child.stdin.write("/setup done\n");
  await c.waitFor("setup done");
  c.child.stdin.end("/leave\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /^claude +claude 2\.1\.307; needs claude-agent-acp: npm i -g @agentclientprotocol\/claude-agent-acp@0\.89\.1$/m,
  );
  assert.match(r.stdout, /^opencode +ready \(opencode 2\.0\.18\)$/m);
  const after = await api<HarnessesReply>(d, "GET", "/harnesses");
  assert.equal(after.body.done, true);
});

test("piped chat.ts says how to add a folder that /new is refused for", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const other = await gitRepo(t);
  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end(`/new --cmd "${REMEMBER}" --cwd ${other}\n/leave\n`);
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /has not been added to the daemon/);
  assert.ok(
    r.stderr.includes(`add it first: kapelle daemon add ${other}`),
    r.stderr,
  );
});

test("piped chat.ts refuses a bare /new or /add, and /term: each needs a terminal", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const c = spawnCli(t, ["new", "--cmd", REMEMBER, "--cwd", cwd], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("/new\n/add\n/term\n/leave\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /! a form needs a terminal: \/new/);
  assert.match(r.stderr, /! a form needs a terminal: \/add </);
  assert.match(r.stderr, /! a shell needs the full-screen chat/);
});

test("piped /delete waits for the next line, then keeps a dismissed room open after 409", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const room = open.body;
  const dev = only(room);
  await commitAt(dev.worktree, "dev.txt");
  await writeFile(join(dev.worktree, "draft.txt"), "half a thought\n");

  const c = spawnCli(t, ["attach", room.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  let stderr = "";
  c.child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  c.child.stdin.write("/delete\n/delete\n");
  // The refusal is two writes to stderr: wait for the last, then check both.
  await until("the delete refusal", () =>
    stderr.includes("then type /delete again"),
  );
  assert.match(stderr, /draft\.txt/);
  assert.match(stderr, /commit or remove them, then type \/delete again/);
  const held = await api<RoomReply>(d, "GET", `/rooms/${room.id}`);
  assert.equal(held.status, 200);
  assert.equal(held.body.status, "dismissed");
  assert.ok(
    existsSync(join(dev.worktree, "draft.txt")),
    "the refused delete kept the file",
  );
  assert.equal(c.child.exitCode, null, stderr);

  await rm(join(dev.worktree, "draft.txt"));
  c.child.stdin.write("/delete\n/delete\n");
  c.child.stdin.end();
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /delete room-[^:]+: 1 branch/);
  assert.match(r.stdout, /1 unmerged commit/);
  assert.match(r.stdout, /dev\.txt/);
  assert.match(r.stdout, /the room is dismissed; \/delete to remove it/);
  assert.match(r.stdout, /deleted room-/);
  assert.equal((await api(d, "GET", `/rooms/${room.id}`)).status, 404);
});

test("piped attach of a dismissed room waits in read-only mode", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  assert.equal(
    (await api(d, "POST", `/rooms/${open.body.id}/dismiss`)).status,
    200,
  );

  const c = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  await c.waitFor(
    "the room is dismissed; /delete to remove it, /leave to exit",
  );
  c.child.stdin.end("/leave\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /the room is dismissed; \/delete to remove it/);
});

test("piped /delete changes nothing unless the next line is /delete", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(
    d,
    "POST",
    "/rooms",
    withAgent(cwd, REMEMBER),
  );
  assert.equal(open.status, 201, open.body.error?.message);
  const c = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end("/delete\n/help\n/leave\n");
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /type \/delete again to confirm/);
  assert.match(r.stdout, /\/setup \[done\]/);
  const still = await api<RoomReply>(d, "GET", `/rooms/${open.body.id}`);
  assert.equal(still.status, 200);
  assert.equal(still.body.status, "active");
});

test("piped chat.ts takes the room commands, and names the room /new or /loop opened", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(
    d,
    await gitRepo(t, { files: { ".kapelle/loops/fix.md": "steps\n" } }),
  );
  // Both participants are in the room the pipe reads at the start, so each
  // `@name` resolves without waiting for the stream to replay.
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [
      { cmd: REMEMBER, name: "alice", role: "orchestrator" },
      { cmd: REMEMBER, name: "bob" },
    ],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const c = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end(
    `/add --cmd "${REMEMBER}" --name carol\n` +
      "@bob /role tester\n" +
      "@bob /mode safe\n" +
      "@bob /remove\n" +
      `/new --cmd "${REMEMBER}" --title second --cwd ${cwd}\n` +
      `/loop fix 9 --cmd "${REMEMBER}" --cwd ${cwd}\n` +
      "/dismiss\n",
  );
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  for (const line of [
    "added carol (mock-agent, auto)",
    "bob is now tester",
    "bob is now in safe mode",
    "removed bob",
    "opened room second",
    "opened room fix-9; po has the start",
    "the room was dismissed",
  ]) {
    assert.ok(
      `${r.stdout}${r.stderr}`.includes(line),
      `${line} not in:\n${r.stdout}\n${r.stderr}`,
    );
  }
  // The pipe stays in the room it read; the new room is reached by attach.
  const rooms = await api<RoomReply[]>(d, "GET", "/rooms");
  const second = rooms.body.find((room) => room.title === "second");
  assert.ok(second, JSON.stringify(rooms.body));
  assert.ok(
    r.stdout.includes(`attach with: kapelle chat attach ${second.id}`),
    r.stdout,
  );
  const loop = rooms.body.find((room) => room.title === "fix-9");
  assert.ok(loop, JSON.stringify(rooms.body));
  assert.ok(
    r.stdout.includes(`attach with: kapelle chat attach ${loop.id}`),
    r.stdout,
  );
});

test("piped chat.ts lists an agent's live models, and changes its model (M9-6)", async (t) => {
  const runtime = await tempDir(t);
  const d = await boot(t, runtime);
  const cwd = await added(d, await gitRepo(t));
  const open = await api<RoomReply>(d, "POST", "/rooms", {
    cwd,
    agents: [{ cmd: `node ${MOCK_AGENT} --scenario models`, name: "alice" }],
  });
  assert.equal(open.status, 201, open.body.error?.message);
  const c = spawnCli(t, ["attach", open.body.id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  c.child.stdin.end(
    "@alice /model\n@alice /model mock/smart\n@alice /model\n/leave\n",
  );
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout;
  const at = (line: string, from = 0) => {
    const i = out.indexOf(line, from);
    assert.notEqual(i, -1, `${line} not after ${from} in:\n${out}`);
    return i;
  };
  const first = at('alice runs on "mock/fast"');
  at("* mock/fast  Fast", first);
  at("  mock/smart  Smart", first);
  const set = at('alice now runs on the model "mock/smart"', first);
  const again = at('alice runs on "mock/smart"', set);
  at("* mock/smart  Smart", again);
});

// --- a room across a restart (M6-7a, #151) ----------------------------------

test("chat.ts on a pipe rides out a restart: the participant reads paused, and a message is answered", async (t) => {
  const { first, cwd, id, again, runtime } = await roomToRestart(t, REMEMBER);
  const c = spawnCli(t, ["attach", id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  await c.waitFor("type a message");
  c.child.stdin.write("alpha\n");
  await c.waitFor("previous: (none)");

  // A clean stop pauses the room, ends its stream and removes `daemon.json`
  // (M6-7d): the screen waits for the next daemon instead of ending.
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  const second = await again();
  await c.waitFor("is paused; a message revives it");

  c.child.stdin.write("beta\n");
  await c.waitFor("is back with a fresh session");
  await roomIdle(second, id);
  c.child.stdin.end();
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /the daemon restarted/);
  assert.equal(r.stdout.match(/previous: \(none\)/g)?.length, 2, r.stdout);
  assert.deepEqual(answersIn(await roomLog(cwd, id)), [
    "previous: (none)",
    "previous: (none)",
  ]);
});

test("chat.ts on a pipe: a diff while the daemon is away says so, and the screen stays", async (t) => {
  const { first, id, again, runtime, alice } = await roomToRestart(t, REMEMBER);
  const c = spawnCli(t, ["attach", id], "chat.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  await c.waitFor("type a message");
  process.kill(first.pid, "SIGTERM");
  assert.equal((await first.done).code, 0);
  // A screen that ends fails here at once, not on the test's timeout.
  const ended = c.done.then((r) => {
    throw new Error(`the screen ended with ${r.code}: ${r.stderr}`);
  });
  ended.catch(() => {});
  c.child.stdin.write(`@${alice.name} /diff\n`);
  await again();
  await Promise.race([c.waitFor("is paused; a message revives it"), ended]);
  c.child.stdin.end();
  const r = await c.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /the daemon did not answer/);
});
