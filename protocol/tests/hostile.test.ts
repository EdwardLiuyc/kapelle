/**
 * M1b-6 acceptance tests — issue #22 — plus #310's approval-binding attacks.
 *
 * Every case drives the real `hostile-agent.mjs` over real stdio, because the
 * subject is the wire: what a client does with a message no well-behaved
 * harness would send. `protocol/tests/agent.test.ts` covers the same guard from
 * the inside with an inline probe; this file covers it from the outside, the
 * way a harness would reach it.
 *
 * Two assertions in every case, and the second is the one people forget: the
 * attempt is refused **and** the turn still ends. A client that dies on hostile
 * input has not contained it.
 */

import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";

import { HOSTILE_AGENT, tempDir } from "../../integration/helpers.ts";
import type { Policy } from "../agent.ts";
import { AcpAgent } from "../agent.ts";

/**
 * `safePolicy`'s rule, restated in four words.
 *
 * Not imported from `core/policy.ts` on purpose: the dependency runs
 * core → protocol and never back, and a test under `protocol/` importing
 * upwards would be the first crack in that.
 */
const READ_ONLY: Policy = ({ toolCall }) =>
  ["read", "search", "fetch", "think"].includes(toolCall.kind);

const ALLOW_ALL: Policy = () => true;

interface Run {
  /** Everything the agent streamed, concatenated. */
  text: string;
  stopReason: string | undefined;
  cwd: string;
  /** `kind:title` for every call the policy was asked to judge, in order. */
  decisions: string[];
  /** The files each of those calls named for a diff (M4-6). */
  edits: unknown[];
}

/**
 * Run one attack to the end of its turn.
 *
 * `policy` defaults to allow-all so the path-guard cases prove the **guard**
 * refused rather than the policy refusing for it — the same reason the
 * documented command in `hostile-agent.mjs` says `--mode auto`.
 */
async function attack(
  t: TestContext,
  scenario: string,
  policy: Policy = ALLOW_ALL,
): Promise<Run> {
  const cwd = await tempDir(t);
  const chunks: string[] = [];
  const decisions: string[] = [];
  const edits: unknown[] = [];
  const agent = new AcpAgent({
    name: `hostile-${scenario}`,
    command: process.execPath,
    args: [HOSTILE_AGENT, "--scenario", scenario],
    cwd,
    // Wrapped rather than passed through: "how many times was the policy
    // asked" is the whole assertion for the reuse cases, and counting the
    // `_client_permission` events instead would miss a decision the client
    // took without emitting one.
    policy: (req) => {
      decisions.push(`${req.toolCall.kind}:${req.toolCall.title}`);
      edits.push(req.toolCall.edits);
      return policy(req);
    },
    requestTimeoutMs: 10_000,
    onEvent: ({ update }) => {
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      )
        chunks.push(update.content.text);
    },
  });
  // Registered before the first await: a failing assertion must still reap the
  // subprocess, or a red test leaves an orphan behind.
  t.after(() => agent.stop());

  await agent.start();
  await agent.newSession();
  const res = await agent.prompt("do your worst");
  return {
    text: chunks.join(""),
    stopReason: res.stopReason,
    cwd,
    decisions,
    edits,
  };
}

/** True when the file is absent — the shape every "and nothing was written" check wants. */
async function absent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

// --- path containment --------------------------------------------------------

test("an escaping ../ read is refused and the turn still ends", async (t) => {
  const run = await attack(t, "path-escape");
  assert.match(run.text, /OUTCOME=refused/);
  assert.match(run.text, /path outside workspace root refused/);
  assert.equal(run.stopReason, "end_turn");
});

test("an absolute path outside the root is refused", async (t) => {
  const run = await attack(t, "absolute-path");
  assert.match(run.text, /OUTCOME=refused/);
  assert.match(run.text, /path outside workspace root refused/);
  assert.equal(run.stopReason, "end_turn");
});

test("a symlink pointing out of the root is refused", async (t) => {
  // The gap `protocol/tests/agent.test.ts` recorded until M1b-6: `resolve` is
  // string arithmetic, so an in-root link read as in-root and was followed.
  // `#guardPath` now realpaths first, and this is the test that goes red if
  // that call is removed.
  const run = await attack(t, "symlink-escape");
  assert.match(run.text, /OUTCOME=refused/);
  assert.match(run.text, /path outside workspace root refused/);
  assert.equal(run.stopReason, "end_turn");
});

test("a dangling symlink cannot create an outside file", async (t) => {
  const run = await attack(t, "dangling-symlink-escape");
  const target = `${run.cwd}-dangling-target`;
  t.after(() => rm(target, { force: true }));

  assert.match(run.text, /OUTCOME=refused/);
  assert.match(run.text, /unresolved symlink refused/);
  assert.equal(await absent(target), true);
  assert.equal(run.stopReason, "end_turn");
});

// --- mutation without asking -------------------------------------------------

test("a write with no permission request is refused under a read-only policy", async (t) => {
  const run = await attack(t, "write-no-ask", READ_ONLY);
  assert.match(run.text, /OUTCOME=refused/);
  assert.match(run.text, /write refused by policy/);
  assert.equal(
    await absent(join(run.cwd, "SNEAKY.md")),
    true,
    "the refusal must also mean no file",
  );
  assert.equal(run.stopReason, "end_turn");
});

test("the same write is allowed when the policy allows it", async (t) => {
  // The other half, and the reason this is a policy gate rather than a ban:
  // `auto` still writes. Without this case, deleting `#guardWrite` entirely
  // and refusing every fs write would pass the test above.
  const run = await attack(t, "write-no-ask", ALLOW_ALL);
  assert.match(run.text, /OUTCOME=allowed/);
  // Its text is named for a diff (M4-6), as an asked edit's is.
  assert.deepEqual(run.edits, [
    [
      {
        abs: join(run.cwd, "SNEAKY.md"),
        path: "SNEAKY.md",
        newText: "written without asking\n",
      },
    ],
  ]);
  assert.equal(await absent(join(run.cwd, "SNEAKY.md")), false);
  assert.equal(run.stopReason, "end_turn");
});

test("an allow-only menu grants one write, not the whole session", async (t) => {
  // `pickOption` never picks `allow_always` while an `allow_once` is on offer,
  // so an "always" answer only ever came from a harness that gave the client no
  // narrower choice. Keeping it as a standing grant let every later write to
  // that path skip the policy — the human said yes once, to one write.
  const run = await attack(t, "always-menu");

  assert.equal(
    run.decisions.length,
    2,
    "the approval is spent on the first write; the second is a new decision",
  );
  assert.match(run.decisions[0] ?? "", /^edit:Write notes\.md$/);
  assert.match(
    run.decisions[1] ?? "",
    /^edit:fs\/write_text_file .*notes\.md$/,
  );
  assert.equal(run.stopReason, "end_turn");
});

/** Says yes to every question the harness asks, and no to a write it did not. */
const ASKED_ONLY: Policy = ({ toolCall }) =>
  !toolCall.title.startsWith("fs/write_text_file");

test("different bytes land after the second approval", async (t) => {
  // D2: a mismatch asks about the bytes that will land; it is not a hard
  // refusal. This is the allow half of `swap-bytes`.
  const run = await attack(t, "swap-bytes", ALLOW_ALL);
  assert.equal(run.decisions.length, 2, "the swapped bytes are asked about");
  assert.match(
    run.decisions[1] ?? "",
    /^edit:fs\/write_text_file .*notes\.md$/,
  );
  assert.match(run.text, /OUTCOME=allowed DETAIL=allowed/);
  assert.equal(await readFile(join(run.cwd, "notes.md"), "utf8"), "swapped\n");
  assert.equal(run.stopReason, "end_turn");
});

test("an approved file_text does not approve other bytes for its file", async (t) => {
  // The file_text shape is the other half of case 1, not a second copy of the
  // diff case: a change that kept only diffs bound would still pass every
  // same-bytes file-text test.
  const run = await attack(t, "swap-file-text", ASKED_ONLY);
  assert.equal(run.decisions.length, 2, "the swapped bytes are asked about");
  assert.match(run.decisions[0] ?? "", /^edit:Write notes\.md$/);
  assert.match(
    run.decisions[1] ?? "",
    /^edit:fs\/write_text_file .*notes\.md$/,
  );
  assert.deepEqual(run.edits[0], [
    {
      abs: join(run.cwd, "notes.md"),
      path: "notes.md",
      newText: "approved\n",
    },
  ]);
  assert.deepEqual(run.edits[1], [
    { abs: join(run.cwd, "notes.md"), path: "notes.md", newText: "swapped\n" },
  ]);
  assert.match(run.text, /OUTCOME=refused DETAIL=write refused by policy/);
  assert.equal(await absent(join(run.cwd, "notes.md")), true);
  assert.equal(run.stopReason, "end_turn");
});

test("a file_text that is not text does not turn rawInput.path into a path-only grant", async (t) => {
  // No diff is built from it, but the person can see it as the call's input.
  // A path-only grant would let any bytes land after that question.
  const run = await attack(t, "file-text-not-text", ASKED_ONLY);
  assert.equal(run.decisions.length, 2, "the unseen bytes are asked about");
  assert.equal(run.edits[0], undefined, "no diff is built from it");
  assert.match(run.text, /OUTCOME=refused DETAIL=write refused by policy/);
  assert.equal(await absent(join(run.cwd, "notes.md")), true);
  assert.equal(run.stopReason, "end_turn");
});

test("an approved diff does not approve other bytes for its file", async (t) => {
  // #310: the person approved the text they saw. Other bytes are a new
  // decision about those bytes, so a policy that refuses unasked writes
  // keeps them out.
  const run = await attack(t, "swap-bytes", ASKED_ONLY);
  assert.equal(run.decisions.length, 2, "the swapped bytes are asked about");
  assert.match(run.decisions[0] ?? "", /^edit:Write notes\.md$/);
  assert.match(
    run.decisions[1] ?? "",
    /^edit:fs\/write_text_file .*notes\.md$/,
  );
  assert.deepEqual(run.edits[1], [
    { abs: join(run.cwd, "notes.md"), path: "notes.md", newText: "swapped\n" },
  ]);
  assert.match(run.text, /OUTCOME=refused DETAIL=write refused by policy/);
  assert.equal(await absent(join(run.cwd, "notes.md")), true);
  assert.equal(run.stopReason, "end_turn");
});

test("an approved diff covers one write, not every write with those bytes", async (t) => {
  const run = await attack(t, "same-diff-twice", ASKED_ONLY);
  assert.equal(
    run.decisions.length,
    2,
    "the approved bytes are spent by the first write",
  );
  assert.match(run.decisions[0] ?? "", /^edit:Write notes\.md$/);
  assert.match(
    run.decisions[1] ?? "",
    /^edit:fs\/write_text_file .*notes\.md$/,
  );
  assert.equal(run.text.match(/OUTCOME=allowed/g)?.length, 1);
  assert.equal(run.text.match(/OUTCOME=refused/g)?.length, 1);
  assert.equal(
    await readFile(join(run.cwd, "notes.md"), "utf8"),
    "same\n",
    "the first write landed and the second did not",
  );
  assert.equal(run.stopReason, "end_turn");
});

test("an approved request binds every file in its diffs", async (t) => {
  const run = await attack(t, "two-diffs", ASKED_ONLY);
  assert.equal(
    run.decisions.length,
    1,
    "both matching writes reuse the one permission decision",
  );
  assert.deepEqual(run.edits[0], [
    {
      abs: join(run.cwd, "one.md"),
      path: "one.md",
      oldText: null,
      newText: "one\n",
    },
    {
      abs: join(run.cwd, "two.md"),
      path: "two.md",
      oldText: null,
      newText: "two\n",
    },
  ]);
  assert.equal(run.text.match(/OUTCOME=allowed/g)?.length, 2);
  assert.equal(await readFile(join(run.cwd, "one.md"), "utf8"), "one\n");
  assert.equal(await readFile(join(run.cwd, "two.md"), "utf8"), "two\n");
  assert.equal(run.stopReason, "end_turn");
});

test("an approved diff for one file does not approve rawInput.path's file", async (t) => {
  const run = await attack(t, "swap-path", ASKED_ONLY);
  assert.equal(run.decisions.length, 2, "the unseen file is asked about");
  assert.match(
    run.decisions[1] ?? "",
    /^edit:fs\/write_text_file .*other\.md$/,
  );
  assert.deepEqual(run.edits[1], [
    {
      abs: join(run.cwd, "other.md"),
      path: "other.md",
      newText: "shown\n",
    },
  ]);
  assert.match(run.text, /OUTCOME=refused DETAIL=write refused by policy/);
  assert.equal(await absent(join(run.cwd, "other.md")), true);
  assert.equal(run.stopReason, "end_turn");
});

test("a guarded-away diff does not turn rawInput.path into a path-only grant", async (t) => {
  // The diff names a path outside the root, so `#editsOf` drops it before the
  // policy sees an edit. That must not make the in-root rawInput.path a
  // path-only request: the person still did not see the bytes for notes.md.
  const run = await attack(t, "outside-diff-path", ASKED_ONLY);
  assert.equal(run.decisions.length, 2, "the unseen write is asked about");
  assert.equal(run.edits[0], undefined, "the outside edit is not shown");
  assert.match(
    run.decisions[1] ?? "",
    /^edit:fs\/write_text_file .*notes\.md$/,
  );
  assert.match(run.text, /OUTCOME=refused DETAIL=write refused by policy/);
  assert.equal(await absent(join(run.cwd, "notes.md")), true);
  assert.equal(run.stopReason, "end_turn");
});

test("a denied diff keeps every path it named sticky", async (t) => {
  const run = await attack(t, "deny-diff-paths", () => false);
  assert.equal(
    run.decisions.length,
    1,
    "the initial denial covers both the diff and rawInput.path",
  );
  assert.equal(
    run.text.match(/OUTCOME=refused/g)?.length,
    2,
    "both follow-up writes are refused",
  );
  assert.equal(await absent(join(run.cwd, "shown.md")), true);
  assert.equal(await absent(join(run.cwd, "other.md")), true);
  assert.equal(run.stopReason, "end_turn");
});

test("an edit outside the root names no file for a diff, by diff block or by file_text", async (t) => {
  // The diff reads the old text from disk (M4-6), so a path the guard
  // refuses must never reach it: its text would land on a person's screen.
  const run = await attack(t, "diff-escape");
  assert.deepEqual(run.decisions, [
    "edit:Edit outside (d1)",
    "edit:Edit outside (d2)",
  ]);
  assert.deepEqual(run.edits, [undefined, undefined]);
  assert.equal(run.stopReason, "end_turn");
});

// --- malformed and oversized input -------------------------------------------

test("a non-JSON line on stdout is ignored and the turn still ends", async (t) => {
  const run = await attack(t, "malformed-json");
  assert.match(run.text, /OUTCOME=sent/);
  assert.equal(run.stopReason, "end_turn");
});

test("a line past the length cap is dropped and the turn still ends", async (t) => {
  const run = await attack(t, "oversized");
  // The flood is a well-formed `agent_message_chunk`, so nothing but the cap
  // can keep it out of the event stream. Raise MAX_LINE_LENGTH and this line
  // is the one that goes red.
  assert.doesNotMatch(
    run.text,
    /FLOOD/,
    "the oversized line must not be parsed",
  );
  assert.match(run.text, /OUTCOME=sent/, "and the turn carries on after it");
  assert.equal(run.stopReason, "end_turn");
});

// --- a method we do not implement --------------------------------------------

test("an unimplemented method is answered with an error, not a crash", async (t) => {
  const run = await attack(t, "unknown-method");
  assert.match(run.text, /OUTCOME=refused/);
  assert.match(run.text, /method not supported by this client/);
  assert.equal(run.stopReason, "end_turn");
});

test("an update with a null sessionId is not dropped as a failed load's (#238)", async (t) => {
  const run = await attack(t, "null-session");
  assert.match(run.text, /NULLSID/);
  assert.equal(run.stopReason, "end_turn");
});

test("a failed load's id does not hide a live session that reuses it (#238)", async (t) => {
  const chunks: string[] = [];
  const agent = new AcpAgent({
    name: "hostile-reused-id",
    command: process.execPath,
    args: [HOSTILE_AGENT, "--scenario", "reused-id"],
    cwd: await tempDir(t),
    requestTimeoutMs: 10_000,
    onEvent: ({ update }) => {
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      )
        chunks.push(update.content.text);
    },
  });
  t.after(() => agent.stop());
  await agent.start();
  await assert.rejects(agent.loadSession("hostile-1"));
  assert.equal(await agent.newSession(), "hostile-1");
  await agent.prompt("go");
  assert.match(chunks.join(""), /Running the reused-id attack/);
});

// --- forged client events ----------------------------------------------------

test("a harness's _client_ updates never reach onEvent; the client's own still do (#357)", async (t) => {
  const kinds: string[] = [];
  const pids: string[] = [];
  const agent = new AcpAgent({
    name: "hostile-forge-client",
    command: process.execPath,
    args: [HOSTILE_AGENT, "--scenario", "forge-client"],
    cwd: await tempDir(t),
    requestTimeoutMs: 10_000,
    onEvent: ({ update }) => {
      kinds.push(update.sessionUpdate);
      if (
        update.sessionUpdate === "_client_harness_spawned" ||
        update.sessionUpdate === "_client_harness_exited"
      )
        pids.push(`${update.sessionUpdate}:${update.pid}`);
    },
  });
  t.after(() => agent.stop());
  await agent.start();
  await agent.newSession();
  const res = await agent.prompt("forge");
  // `stop()` settles on `close`, so the client's own exit is in by then.
  await agent.stop();

  assert.equal(res.stopReason, "end_turn");
  assert.match(kinds.join(), /agent_message_chunk/, "the turn carried on");
  assert.equal(kinds.includes("_client_user_message"), false);
  // The client's spawn and exit, of one pid. The forged spawn named this
  // test's pid, the harness's parent; the forged exit came mid-turn.
  const [spawned, exited, ...rest] = pids;
  const pid = spawned?.split(":")[1];
  assert.deepEqual(
    [spawned, exited, rest],
    [`_client_harness_spawned:${pid}`, `_client_harness_exited:${pid}`, []],
  );
  assert.notEqual(pid, String(process.pid));
});

test("a non-string sessionUpdate is dropped before it can crash the turn (#357)", async (t) => {
  const kinds: unknown[] = [];
  const chunks: string[] = [];
  const agent = new AcpAgent({
    name: "hostile-malformed-kind",
    command: process.execPath,
    args: [HOSTILE_AGENT, "--scenario", "malformed-kind"],
    cwd: await tempDir(t),
    requestTimeoutMs: 10_000,
    onEvent: ({ update }) => {
      kinds.push(update.sessionUpdate);
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      )
        chunks.push(update.content.text);
    },
  });
  t.after(() => agent.stop());
  await agent.start();
  await agent.newSession();
  const res = await agent.prompt("malformed");
  await agent.stop();

  assert.equal(res.stopReason, "end_turn");
  assert.equal(
    kinds.some((kind) => typeof kind !== "string"),
    false,
    "the malformed kind never reaches onEvent",
  );
  assert.match(chunks.join(""), /ATTACK=malformed-kind OUTCOME=sent/);
});

// --- the scenario picker -----------------------------------------------------

test("hostile-agent refuses to run without a scenario", async () => {
  const { spawnSync } = await import("node:child_process");
  const bare = spawnSync(process.execPath, [HOSTILE_AGENT], {
    encoding: "utf8",
  });
  assert.equal(bare.status, 2, "no default path: a bare run must not attack");

  const typo = spawnSync(
    process.execPath,
    [HOSTILE_AGENT, "--scenario", "not-a-scenario"],
    { encoding: "utf8" },
  );
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /Known: /);
});
