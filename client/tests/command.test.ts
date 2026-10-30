/**
 * The typed room commands — `client/command.ts`, story M4-5 (#181).
 *
 * Only the parser: no daemon. `tests/daemon-rooms.test.ts` sends each command to
 * its route, and shows each refusal's message, against `mock-agent.mjs`.
 */

import assert from "node:assert/strict";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  deletePreviewLines,
  loopCommand,
  modelLines,
  parseCommand,
} from "../command.ts";
import type { ParticipantDto } from "../contract.ts";
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
        model: undefined,
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
      model: undefined,
      base: undefined,
    },
  });
  // M9-5: sent as typed; the harness checks it.
  const model = parse("/add claude --model opus");
  assert.ok(model && "agent" in model);
  assert.equal(model.agent.model, "opus");
  const bad = parse("/add claude --colour red");
  assert.ok(bad && "error" in bad && /colour/.test(bad.error), String(bad));
  const two = parse("/add claude pi");
  assert.ok(two && "error" in two && /one harness/.test(two.error));
});

test("/new makes its harness a developer, and resolves --cwd", () => {
  assert.deepEqual(parse("/new pi --name ann --cwd sub --title fix"), {
    verb: "new",
    body: {
      cwd: resolve("sub"),
      title: "fix",
      agents: [
        {
          agent: "pi",
          cmd: undefined,
          name: "ann",
          model: undefined,
          role: "developer",
        },
      ],
    },
  });
  const model = parse("/new pi --model deepseek/chat");
  assert.ok(model && "body" in model);
  assert.equal(model.body.agents?.[0]?.model, "deepseek/chat");
  const alone = parse("/new --model x");
  assert.ok(alone && "error" in alone && /--model needs/.test(alone.error));
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

test("@name /model <id> is a PATCH, and @name /model alone asks for the list (M9-6)", () => {
  assert.deepEqual(parse("@bob /model mock/smart"), {
    verb: "patch",
    id: "p-b",
    name: "Bob",
    change: { model: "mock/smart" },
  });
  assert.deepEqual(parse("@bob /model"), {
    verb: "models",
    id: "p-b",
    name: "Bob",
  });
  const r = parse("@bob /model a b");
  assert.ok(r && "error" in r && r.error === "usage: @name /model [id]");
  const bare = parse("/model x");
  assert.ok(bare && "error" in bare && /@name \/model/.test(bare.error));
});

test("the model list marks the one in use, and says why there is none (M9-6)", () => {
  const p = (over: Partial<ParticipantDto>): ParticipantDto => ({
    id: "p-b",
    name: "bob",
    harness: "mock-agent",
    mode: "auto",
    settings: { allowReadOutsideRoot: false },
    worktree: "/w",
    sessionId: "s",
    status: "idle",
    notices: [],
    ...over,
  });
  assert.deepEqual(
    modelLines(
      p({
        model: "mock/fast",
        models: [
          { id: "mock/fast", name: "Fast" },
          { id: "x", name: "x" },
        ],
      }),
    ),
    [
      'bob runs on "mock/fast"',
      "* mock/fast  Fast",
      "  x",
      "@bob /model <id> picks one",
    ],
  );
  assert.deepEqual(modelLines(p({})), ["bob lists no models"]);
  assert.deepEqual(modelLines(p({ status: "paused", model: "m" })), [
    "bob has no harness running; its list shows after its next start",
  ]);
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
  assert.deepEqual(parse("/loop fix 1"), { error: FOLDER_GONE });
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

test("/delete is a room command, exact, and works after a mention", () => {
  assert.deepEqual(parse("/delete"), { verb: "delete" });
  assert.deepEqual(parse("@bob /delete"), { verb: "delete" });
  assert.equal(parse("/delete now"), undefined);
});

test("the delete preview names every branch and only its unmerged commits", () => {
  assert.deepEqual(
    deletePreviewLines({
      branches: [
        {
          branch: "kapelle/room-1/p-a",
          participant: "alice",
          commits: [{ sha: "1234567890", subject: "fix it" }],
          total: 3,
        },
        {
          branch: "kapelle/room-1/p-old",
          commits: [],
          total: 0,
        },
      ],
    }),
    [
      "3 unmerged commits · alice",
      "  kapelle/room-1/p-a",
      "  12345678 fix it",
      "  … and 2 more commits",
      "all merged · no current participant",
      "  kapelle/room-1/p-old",
    ],
  );
  assert.deepEqual(deletePreviewLines({ branches: [] }), [
    "no room-owned branches would be removed",
  ]);
});

test("/setup opens the agent list, and /setup done says done (M9-3)", () => {
  assert.deepEqual(parse("/setup"), { verb: "setup", done: false });
  assert.deepEqual(parse("@bob /setup done"), { verb: "setup", done: true });
  assert.deepEqual(parse("/setup now"), { error: "usage: /setup [done]" });
  assert.deepEqual(parse("/setup done now"), {
    error: "usage: /setup [done]",
  });
});

test("/loop opens <recipe>-<task> with po in auto, on claude unless --agent or --cmd names another (M8-5)", () => {
  const po = { name: "po", role: "orchestrator", mode: "auto" };
  assert.deepEqual(parse(`@bob /loop fix 269 "only the CLI" --cwd sub`), {
    verb: "loop",
    recipe: "fix",
    task: "269",
    note: "only the CLI",
    body: {
      cwd: resolve("sub"),
      title: "fix-269",
      agents: [{ agent: "claude", ...po }],
    },
  });
  const pi = parse("/loop fix 269 --agent pi");
  assert.ok(pi && "body" in pi);
  assert.deepEqual(pi.body.agents, [{ agent: "pi", ...po }]);
  assert.ok(!("note" in pi), "no note");
  const cmd = parse(`/loop fix 269 --cmd "node x.mjs"`);
  assert.ok(cmd && "body" in cmd);
  assert.deepEqual(cmd.body.agents, [{ cmd: "node x.mjs", ...po }]);
  const usage = {
    error:
      'usage: /loop <recipe> <task> ["note"] [--agent h] [--cmd c] [--cwd dir]',
  };
  for (const s of [
    "/loop",
    "/loop fix",
    '/loop fix "   "',
    "/loop fix 1 note more",
  ]) {
    assert.deepEqual(parse(s), usage, s);
  }
  const bad = parse("/loop fix 1 --mode ask");
  assert.ok(bad && "error" in bad && /--mode/.test(bad.error));
});

test("/loop and loopCommand trim the task and the note, so the CLI and the screens agree (#368 review)", () => {
  const typed = parse(`/loop fix "  7  " "  a note  "`);
  assert.ok(typed && "verb" in typed && typed.verb === "loop");
  assert.equal(typed.task, "7");
  assert.equal(typed.note, "a note");
  assert.equal(typed.body.title, "fix-7");
  // The CLI's path: `loopCommand` itself.
  const cli = loopCommand({ recipe: "fix", task: " 7\n", note: " ", cwd: "/" });
  assert.equal(cli.task, "7");
  assert.equal(cli.body.title, "fix-7");
  assert.ok(!("note" in cli), "a blank note is no note");
});
