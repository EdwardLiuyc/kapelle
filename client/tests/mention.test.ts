/**
 * The composer's resolver — `client/mention.ts`, story M4-2 (#48). One test
 * per rule in `docs/CLIENT-API.md` § Addressing, and one per refusal.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mentionsFor, resolveTarget, targetOf } from "../mention.ts";

const ROSTER = [
  { id: "p-a", name: "alice", role: "orchestrator" },
  { id: "p-b", name: "Bob" },
];
const NO_ORCHESTRATOR = [{ id: "p-b", name: "bob" }];

test("no mention goes to the orchestrator, text unchanged", () => {
  assert.deepEqual(resolveTarget("look at @bob's change", ROSTER), {
    id: "p-a",
    text: "look at @bob's change",
  });
});

test("a mention names the target and is removed with its end mark and whitespace", () => {
  for (const input of ["@bob look", "@bob, look", "@bob: look", "@bob\nlook"]) {
    assert.deepEqual(resolveTarget(input, ROSTER), { id: "p-b", text: "look" });
  }
  assert.deepEqual(resolveTarget("@bob; look", ROSTER), {
    id: "p-b",
    text: "look",
  });
  assert.deepEqual(resolveTarget("@bob. look", ROSTER), {
    id: "p-b",
    text: "look",
  });
});

test("names match with ASCII case folding", () => {
  assert.deepEqual(resolveTarget("@BOB hi", ROSTER), { id: "p-b", text: "hi" });
  assert.deepEqual(resolveTarget("@Alice hi", ROSTER), {
    id: "p-a",
    text: "hi",
  });
});

test("leading whitespace is removed first, so it is no escape", () => {
  assert.deepEqual(resolveTarget("  \n@bob hi", ROSTER), {
    id: "p-b",
    text: "hi",
  });
});

test("after the first word, an @ is text; a backtick escapes a leading one", () => {
  assert.deepEqual(resolveTarget("@alice ask @bob", ROSTER), {
    id: "p-a",
    text: "ask @bob",
  });
  assert.deepEqual(resolveTarget("`@property` is odd", ROSTER), {
    id: "p-a",
    text: "`@property` is odd",
  });
});

test("refused: an unknown name", () => {
  assert.deepEqual(resolveTarget("@carol hi", ROSTER), {
    error: "no participant named @carol",
  });
  assert.deepEqual(resolveTarget("@ hi", ROSTER), {
    error: "no participant named @",
  });
});

test("refused: two mentions, known names or not", () => {
  const error = { error: "name one participant: a message has one target" };
  assert.deepEqual(resolveTarget("@alice @bob hi", ROSTER), error);
  assert.deepEqual(resolveTarget("@alice @bab hi", ROSTER), error);
  assert.deepEqual(resolveTarget("@alice, @bob hi", ROSTER), error);
});

test("refused: no mention in a room with no orchestrator", () => {
  const r = resolveTarget("hi", NO_ORCHESTRATOR);
  assert.ok("error" in r);
  assert.match(r.error, /no orchestrator: start with @name/);
  assert.deepEqual(resolveTarget("@bob hi", NO_ORCHESTRATOR), {
    id: "p-b",
    text: "hi",
  });
});

test("refused at submit: nothing after the mention", () => {
  for (const input of ["@bob", "@bob, ", "@bob\n\n"]) {
    assert.deepEqual(resolveTarget(input, ROSTER), {
      error: "nothing to send",
    });
  }
});

test("while typing, a pre-filled mention shows its target, not an error", () => {
  assert.deepEqual(targetOf("@bob ", ROSTER), { id: "p-b", text: "" });
  assert.deepEqual(targetOf("", ROSTER), { id: "p-a", text: "" });
});

test("a leading @ completes to the names that start with what is typed, folded", () => {
  const names = (before: string) =>
    mentionsFor(before, ROSTER)?.map((p) => p.name);
  assert.deepEqual(names("@"), ["alice", "Bob"]);
  assert.deepEqual(names("@B"), ["Bob"]);
  assert.deepEqual(names("  @al"), ["alice"]);
  assert.deepEqual(names("@zed"), []);
  // Only a leading mention names a target, so nothing else completes.
  for (const before of ["hi @b", "@bob ", "@bob, ", "text"]) {
    assert.equal(mentionsFor(before, ROSTER), undefined, before);
  }
});
