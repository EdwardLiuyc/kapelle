/**
 * The typed room commands — `client/command.ts`, story M4-5 (#181).
 *
 * Only the parser: no daemon. `tests/daemon.test.ts` sends each command to
 * its route, and shows each refusal's message, against `mock-agent.mjs`.
 */

import assert from "node:assert/strict";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseCommand } from "../command.ts";
import { FOLDER_GONE } from "../folder.ts";

const roster = [
  { id: "p-a", name: "alice", role: "orchestrator" },
  { id: "p-b", name: "Bob" },
];
const parse = (s: string) => parseCommand(s, roster);

test("a line that is not a known command is a message", () => {
  for (const s of [
    "hello",
    "@bob hi",
    "/usr/bin is slow",
    "/dismiss the old plan",
    "@bob /leave now",
    "/term now",
  ]) {
    assert.equal(parse(s), undefined, s);
  }
});

test("room commands ignore a leading mention", () => {
  assert.deepEqual(parse("@bob /leave"), { verb: "leave" });
  assert.deepEqual(parse("/dismiss"), { verb: "dismiss" });
  assert.deepEqual(parse("@bob /help"), { verb: "help" });
  assert.deepEqual(parse("@bob /term"), { verb: "term" });
  assert.deepEqual(parse("@bob /add"), { verb: "form", form: "add" });
  assert.deepEqual(parse("/new"), { verb: "form", form: "new" });
});

test("/add takes a harness or --cmd, and quotes keep spaces", () => {
  assert.deepEqual(
    parse(
      `/add --cmd "node x.mjs --scenario remember" --name carol --role tester --mode ask --base @alice`,
    ),
    {
      verb: "add",
      agent: {
        agent: undefined,
        cmd: "node x.mjs --scenario remember",
        name: "carol",
        role: "tester",
        mode: "ask",
        base: "@alice",
      },
    },
  );
  // `none` is no role, as in `@name /role none`.
  assert.deepEqual(parse("/add pi --role none"), {
    verb: "add",
    agent: {
      agent: "pi",
      cmd: undefined,
      name: undefined,
      role: undefined,
      mode: undefined,
      base: undefined,
    },
  });
  const bad = parse("/add claude --colour red");
  assert.ok(bad && "error" in bad && /colour/.test(bad.error), String(bad));
  const two = parse("/add claude pi");
  assert.ok(two && "error" in two && /one harness/.test(two.error));
});

test("/new makes its harness the orchestrator, and resolves --cwd", () => {
  assert.deepEqual(parse("/new pi --name ann --cwd sub --title fix"), {
    verb: "new",
    body: {
      cwd: resolve("sub"),
      title: "fix",
      agents: [
        { agent: "pi", cmd: undefined, name: "ann", role: "orchestrator" },
      ],
    },
  });
  const empty = parse("/new --title x");
  assert.ok(empty && "body" in empty);
  assert.deepEqual(empty.body.agents, []);
  const named = parse("/new --name ann");
  assert.ok(named && "error" in named && /--name needs/.test(named.error));
});

test("an agent command needs @name, and never falls back to the orchestrator", () => {
  assert.deepEqual(parse("/remove"), {
    error: "name the agent: @name /remove",
  });
  assert.deepEqual(parse("@nobody /cancel"), {
    error: "no participant named @nobody",
  });
  assert.deepEqual(parse("@bob /remove"), {
    verb: "remove",
    id: "p-b",
    name: "Bob",
  });
  assert.deepEqual(parse("@BOB: /cancel"), {
    verb: "cancel",
    id: "p-b",
    name: "Bob",
  });
});

test("rename, role and mode are one PATCH each; role none clears it", () => {
  const patch = (change: object) => ({
    verb: "patch",
    id: "p-b",
    name: "Bob",
    change,
  });
  assert.deepEqual(parse("@bob /rename carol"), patch({ name: "carol" }));
  assert.deepEqual(parse("@bob /role tester"), patch({ role: "tester" }));
  assert.deepEqual(parse("@bob /role none"), patch({ role: null }));
  assert.deepEqual(parse("@bob /mode ask"), patch({ mode: "ask" }));
  // The daemon checks the value; the screen never guesses.
  assert.deepEqual(parse("@bob /mode loud"), patch({ mode: "loud" }));
  for (const s of ["@bob /rename", "@bob /mode ask safe", "@bob /cancel now"]) {
    const r = parse(s);
    assert.ok(r && "error" in r && /^usage:/.test(r.error), s);
  }
});

test("/title takes the rest of the line, and ignores a mention", () => {
  const title = (t: string) => ({ verb: "title", title: t });
  assert.deepEqual(parse("/title login bug"), title("login bug"));
  assert.deepEqual(parse('@bob /title "login bug"'), title("login bug"));
  assert.deepEqual(parse('/title Review "v2"'), title('Review "v2"'));
  assert.deepEqual(parse("/title a  b"), title("a  b"));
  // Two quoted words are not one quoted title.
  assert.deepEqual(parse('/title "a" and "b"'), title('"a" and "b"'));
  const r = parse("/title");
  assert.ok(r && "error" in r && /^usage:/.test(r.error));
});

test("/new in a removed folder is refused, unless --cwd is a full path", async (t) => {
  const gone = await mkdtemp(join(tmpdir(), "command-gone-"));
  const back = process.cwd();
  t.after(() => process.chdir(back));
  process.chdir(gone);
  await rmdir(gone);

  assert.deepEqual(parse("/new pi"), { error: FOLDER_GONE });
  assert.deepEqual(parse("/new pi --cwd sub"), { error: FOLDER_GONE });
  const full = parse("/new pi --cwd /tmp");
  assert.ok(full && "body" in full, JSON.stringify(full));
  assert.equal(full.body.cwd, "/tmp");
});

test("@name /diff asks for what is not committed, and /diff base for the whole branch", () => {
  assert.deepEqual(parse("@bob /diff"), {
    verb: "diff",
    id: "p-b",
    name: "Bob",
    against: "head",
  });
  assert.deepEqual(parse("@alice /diff base"), {
    verb: "diff",
    id: "p-a",
    name: "alice",
    against: "base",
  });
  assert.deepEqual(parse("/diff"), { error: "name the agent: @name /diff" });
  assert.deepEqual(parse("@bob /diff main"), {
    error: "usage: @name /diff [base]",
  });
});

test("@name /ff --from @name names the target and the source", () => {
  assert.deepEqual(parse("@bob /ff --from @alice"), {
    verb: "ff",
    id: "p-b",
    name: "Bob",
    from: { id: "p-a", name: "alice" },
  });
  assert.deepEqual(parse("@BOB /ff --from @ALICE"), {
    verb: "ff",
    id: "p-b",
    name: "Bob",
    from: { id: "p-a", name: "alice" },
  });
  for (const line of [
    "@bob /ff",
    "@bob /ff @alice",
    "@bob /ff --from @nobody",
    "/ff --from @alice",
  ]) {
    const r = parse(line);
    assert.ok(r && "error" in r, line);
  }
});
