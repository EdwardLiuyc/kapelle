/**
 * `kapelle room` (M8-3, #267), driven as a real subprocess against a daemon
 * with mock agents. Each test opens its own room: `po` the orchestrator, and
 * workers whose first turn waits for `runs.go` in their checkout (the `runs`
 * scenario), so a test can look at a busy worker.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ParticipantDto, RoomDto } from "../client/contract.ts";
import {
  addRepo,
  daemonApi as api,
  bootDaemon,
  type Daemon,
  gitRepo,
  MOCK_AGENT,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";

interface Fixture {
  d: Daemon;
  runtime: string;
  repo: string;
  room: RoomDto;
  /** The participant by its name. */
  p: (name: string) => ParticipantDto;
}

/** A daemon, a repository and a room with `po`, `dev` and `rev`. */
async function fixture(t: TestContext): Promise<Fixture> {
  const runtime = await tempDir(t);
  const d = await bootDaemon(t, runtime);
  const repo = await addRepo(d, await gitRepo(t));
  const agent = (name: string, role: string, scenario: string) => ({
    cmd: `node ${MOCK_AGENT} --scenario ${scenario}`,
    name,
    role,
  });
  const made = await api<RoomDto>(d, "POST", "/rooms", {
    cwd: repo,
    agents: [agent("po", "orchestrator", "remember")],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  for (const [name, role] of [
    ["dev", "developer"],
    ["rev", "reviewer"],
  ] as const) {
    const r = await api(
      d,
      "POST",
      `/rooms/${made.body.id}/agents`,
      agent(name, role, "runs"),
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const room = (await api<RoomDto>(d, "GET", `/rooms/${made.body.id}`)).body;
  const p = (name: string) => {
    const found = room.participants.find((q) => q.name === name);
    assert.ok(found, name);
    return found;
  };
  return { d, runtime, repo, room, p };
}

/** `kapelle room <args>` from `cwd`, with `stdin` written and closed. */
function room(
  t: TestContext,
  runtime: string,
  cwd: string,
  args: string[],
  stdin = "",
) {
  const run = spawnCli(t, ["room", ...args, "--cwd", cwd], "cli.ts", {
    XDG_RUNTIME_DIR: runtime,
  });
  run.child.stdin.end(stdin);
  return run.done;
}

/** The participant as the daemon has it now, once `ok` holds for it. */
async function until(
  f: Fixture,
  name: string,
  ok: (p: ParticipantDto) => boolean,
): Promise<ParticipantDto> {
  for (let i = 0; i < 200; i++) {
    const r = await api<RoomDto>(f.d, "GET", `/rooms/${f.room.id}`);
    const p = r.body.participants.find((q) => q.name === name);
    if (p && ok(p)) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${name} never reached the state`);
}

test("from a participant's checkout, info and send find the room and the sender", async (t) => {
  const f = await fixture(t);
  const po = f.p("po");
  // A folder inside the checkout counts as the checkout.
  const sub = join(po.worktree, "sub");
  await mkdir(sub);

  const sent = await room(t, f.runtime, sub, [
    "send",
    "dev",
    "build",
    "step",
    "2",
  ]);
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(sent.stdout.trim(), "sent to dev");
  // `send` returned while the turn still runs: it never waits.
  const dev = await until(f, "dev", (p) => p.status === "busy");
  assert.equal(dev.turnFrom, po.id, "the folder named the sender");

  // A second message waits behind the live turn, and says so.
  const queued = await room(t, f.runtime, po.worktree, ["send", "dev", "next"]);
  assert.equal(queued.code, 0, queued.stderr);
  assert.equal(queued.stdout.trim(), "queued for dev, behind 1");
  const empty = await room(t, f.runtime, po.worktree, ["send", "dev"], " \n");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /the message is empty/);

  // The person, by `--room` from a folder that is no checkout, with stdin.
  const byPerson = await room(
    t,
    f.runtime,
    f.repo,
    ["send", "@rev", "--room", f.room.id],
    "check it\n",
  );
  assert.equal(byPerson.code, 0, byPerson.stderr);
  const rev = await until(f, "rev", (p) => p.status === "busy");
  assert.equal(rev.turnFrom, undefined, "no sender means the person");

  // Any participant may read: here `dev`, from its own checkout.
  const info = await room(t, f.runtime, dev.worktree, ["info"]);
  assert.equal(info.code, 0, info.stderr);
  assert.match(info.stdout, new RegExp(`^${f.room.id}  active`));
  assert.match(
    info.stdout,
    /^ {2}po {2}orchestrator {2}mock-agent {2}auto {2}idle$/m,
  );
  assert.match(info.stdout, /^ {2}dev {2}developer .* busy, from po$/m);
  assert.match(info.stdout, /^ {2}rev {2}reviewer .* busy, from the person$/m);

  // The turns end; the field goes with them.
  await writeFile(join(dev.worktree, "runs.go"), "");
  await writeFile(join(rev.worktree, "runs.go"), "");
  const done = await until(f, "dev", (p) => p.status === "idle");
  assert.equal(done.turnFrom, undefined);
});

test("a room opened in a repository subdirectory is found from its checkout, workspace and below", async (t) => {
  const runtime = await tempDir(t);
  const d = await bootDaemon(t, runtime);
  const repo = await addRepo(
    d,
    await gitRepo(t, { files: { "packages/app/README.md": "app\n" } }),
  );
  const opened = await api<RoomDto>(d, "POST", "/rooms", {
    cwd: join(repo, "packages", "app"),
    agents: [
      {
        cmd: `node ${MOCK_AGENT} --scenario remember`,
        name: "po",
        role: "orchestrator",
      },
    ],
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const po = opened.body.participants.find((p) => p.name === "po");
  assert.ok(po);
  // The recorded workspace is the checkout root plus the cwd prefix, not the
  // checkout root itself. Discovery has to allow that workspace and below it,
  // and the checkout root itself when the participant runs from there.
  const { stdout } = await promisify(execFile)(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: po.worktree },
  );
  const checkout = stdout.trim();
  const inside = join(po.worktree, "nested");
  await mkdir(inside);

  for (const cwd of [checkout, po.worktree, inside]) {
    const info = await room(t, runtime, cwd, ["info"]);
    assert.equal(info.code, 0, info.stderr);
    assert.match(info.stdout, new RegExp(`^${opened.body.id}  active`));
  }
});

test("a non-git folder at the recorded checkout path is refused", async (t) => {
  const f = await fixture(t);
  const po = f.p("po");
  const metadata = join(po.worktree, ".git");
  const aside = join(po.worktree, ".git.kapelle-test-aside");
  await rename(metadata, aside);
  try {
    const info = await room(t, f.runtime, po.worktree, ["info"]);
    assert.equal(info.code, 1);
    assert.match(info.stderr, /is not a room participant's checkout/);
  } finally {
    await rename(aside, metadata);
  }
});

test("a room add and info keep an ESC in a harness label off the terminal", async (t) => {
  const f = await fixture(t);
  const po = f.p("po");
  const evil = join(await tempDir(t), "mock\u001b[2J-agent.mjs");
  await copyFile(MOCK_AGENT, evil);

  const add = await room(t, f.runtime, po.worktree, [
    "add",
    "--cmd",
    `node ${evil}`,
    "--name",
    "esc",
  ]);
  assert.equal(add.code, 0, add.stderr);
  for (const output of [add.stdout, add.stderr]) {
    assert.ok(!output.includes("\u001b"), JSON.stringify(output));
  }

  // The display is sanitized, but the DTO still carries the label as sent.
  const roster = (await api<RoomDto>(f.d, "GET", `/rooms/${f.room.id}`)).body;
  const esc = roster.participants.find((p) => p.name === "esc");
  assert.ok(esc);
  assert.ok(esc.harness.includes("\u001b[2J"));

  const info = await room(t, f.runtime, po.worktree, ["info"]);
  assert.equal(info.code, 0, info.stderr);
  assert.match(info.stdout, new RegExp(`^${f.room.id}  active`));
  for (const output of [info.stdout, info.stderr]) {
    assert.ok(!output.includes("\u001b"), JSON.stringify(output));
  }
});

test("--role none adds a participant with no role", async (t) => {
  const f = await fixture(t);
  const add = await room(t, f.runtime, f.p("po").worktree, [
    "add",
    "--cmd",
    `node ${MOCK_AGENT}`,
    "--name",
    "plain",
    "--role",
    "none",
  ]);
  assert.equal(add.code, 0, add.stderr);
  assert.equal(add.stdout.trim(), "added plain (mock-agent, auto)");

  const roster = (await api<RoomDto>(f.d, "GET", `/rooms/${f.room.id}`)).body;
  const plain = roster.participants.find((p) => p.name === "plain");
  assert.ok(plain);
  assert.equal(Object.hasOwn(plain, "role"), false, "the role is omitted");
});

test("a folder that is no checkout, or not the participant's own, is refused", async (t) => {
  const f = await fixture(t);
  const po = f.p("po");

  const main = await room(t, f.runtime, f.repo, ["info"]);
  assert.equal(main.code, 1);
  assert.match(
    main.stderr,
    /is not a room participant's checkout; name the room with --room/,
  );

  // The right shape, but not the worktree the daemon recorded: a renamed or
  // copied checkout. The exact match refuses it rather than guess.
  const copy = join(await tempDir(t), "wt", f.room.id, po.id);
  await mkdir(copy, { recursive: true });
  const shaped = await room(t, f.runtime, copy, ["send", "dev", "hi"]);
  assert.equal(shaped.code, 1);
  assert.match(shaped.stderr, /is not a room participant's checkout/);

  const unknown = await room(t, f.runtime, f.repo, [
    "info",
    "--room",
    "room-nope",
  ]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /\(room_not_found\)/);

  const nobody = await room(t, f.runtime, po.worktree, [
    "info",
    "--as",
    "nobody",
  ]);
  assert.equal(nobody.code, 1);
  assert.match(nobody.stderr, /no participant named nobody/);
});

test("a worker's orders are refused, each by its code; --as overrides the sender", async (t) => {
  const f = await fixture(t);
  const dev = f.p("dev");

  const send = await room(t, f.runtime, dev.worktree, ["send", "po", "done"]);
  assert.equal(send.code, 1);
  assert.match(send.stderr, /\(invalid_sender\)/, "the daemon's refusal (D2)");

  for (const args of [
    ["add", "--cmd", `node ${MOCK_AGENT}`],
    ["ff", "dev", "--from", "rev"],
    ["remove", "rev"],
  ]) {
    const r = await room(t, f.runtime, dev.worktree, args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(
      r.stderr,
      /only the orchestrator may .*; dev is developer \(not_orchestrator\)/,
    );
  }
  const roster = (await api<RoomDto>(f.d, "GET", `/rooms/${f.room.id}`)).body;
  assert.equal(roster.participants.length, 3, "nothing changed");

  // `--as` names the sender, from any folder.
  const as = await room(t, f.runtime, f.repo, [
    "send",
    "rev",
    "go",
    "--room",
    f.room.id,
    "--as",
    "po",
  ]);
  assert.equal(as.code, 0, as.stderr);
  const rev = await until(f, "rev", (p) => p.status === "busy");
  assert.equal(rev.turnFrom, f.p("po").id);
  await writeFile(join(rev.worktree, "runs.go"), "");
});

test("the orchestrator adds a reviewer, moves a branch, reads a diff and removes", async (t) => {
  const f = await fixture(t);
  const po = f.p("po");
  const dev = f.p("dev");

  const add = await room(t, f.runtime, po.worktree, [
    "add",
    "--cmd",
    `node ${MOCK_AGENT}`,
    "--name",
    "qa",
    "--role",
    "reviewer",
  ]);
  assert.equal(add.code, 0, add.stderr);
  assert.equal(add.stdout.trim(), "added qa (mock-agent, reviewer, auto)");

  const bad = await room(t, f.runtime, po.worktree, [
    "add",
    "--cmd",
    `node ${MOCK_AGENT}`,
    "--role",
    "boss",
  ]);
  assert.equal(bad.code, 1);
  assert.match(
    bad.stderr,
    /invalid role "boss": .*reviewer.* \(invalid_request\)/,
  );

  const ff = await room(t, f.runtime, po.worktree, [
    "ff",
    "dev",
    "--from",
    "@qa",
  ]);
  assert.equal(ff.code, 0, ff.stderr);
  assert.equal(ff.stdout.trim(), "moved dev up to qa's commit");

  const clean = await room(t, f.runtime, dev.worktree, ["diff", "dev"]);
  assert.equal(clean.code, 0, clean.stderr);
  assert.equal(clean.stdout.trim(), "no changes");
  await writeFile(join(dev.worktree, "notes.txt"), "a line\n");
  const changed = await room(t, f.runtime, po.worktree, ["diff", "dev"]);
  assert.equal(changed.code, 0, changed.stderr);
  assert.match(changed.stdout, /\+a line/);
  // Committed, it leaves the plain diff and shows against the base.
  const git = (...args: string[]) =>
    promisify(execFile)("git", args, { cwd: dev.worktree });
  await git("add", "notes.txt");
  await git("commit", "-q", "-m", "notes");
  const head = await room(t, f.runtime, po.worktree, ["diff", "dev"]);
  assert.equal(head.stdout.trim(), "no changes", head.stderr);
  const base = await room(t, f.runtime, po.worktree, ["diff", "dev", "base"]);
  assert.equal(base.code, 0, base.stderr);
  assert.match(base.stdout, /\+a line/);

  const remove = await room(t, f.runtime, po.worktree, ["remove", "qa"]);
  assert.equal(remove.code, 0, remove.stderr);
  assert.equal(remove.stdout.trim(), "removed qa");
  const roster = (await api<RoomDto>(f.d, "GET", `/rooms/${f.room.id}`)).body;
  assert.deepEqual(
    roster.participants.map((p) => p.name),
    ["po", "dev", "rev"],
  );
});

test("a verb it does not know, or a wrong shape, prints the usage", async (t) => {
  // Refused before any daemon is looked for.
  const dir = await tempDir(t);
  for (const args of [
    [],
    ["nope"],
    ["send"],
    ["diff", "dev", "x"],
    ["ff", "dev"],
  ]) {
    const r = await room(t, dir, dir, args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /^usage: kapelle room <verb>/, args.join(" "));
  }
});
