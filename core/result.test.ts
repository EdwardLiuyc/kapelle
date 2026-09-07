/**
 * M1b-4 acceptance tests — issue #20.
 *
 * Two things the story asks for by name: the strictness matrix field by field,
 * and one fixture per warning class. Both are here because both are the whole
 * contract — extraction that is loose in one field turns a half-written report
 * into a confident summary, and a cross-check with an untested class is a
 * warning nobody has ever seen fire.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  crossCheck,
  extractResult,
  RESULT_PREAMBLE,
  synthesiseSummary,
  withResultPreamble,
} from "./result.ts";

const block = (body: string) =>
  `Did the thing.\n<task-result>${body}</task-result>`;
const FULL = `<status>success</status><summary>Did it.</summary><details>Edited one file.</details>`;

test("a complete block extracts every required field", () => {
  const r = extractResult(block(FULL));
  assert.deepEqual(r, {
    status: "success",
    summary: "Did it.",
    details: "Edited one file.",
  });
});

test("no wrapper is null", () => {
  assert.equal(extractResult("I finished the work. No block here."), null);
});

// The matrix, field by field: each required field missing, then each present
// but blank. Blank matters more than missing — a model that writes
// `<summary></summary>` has filled the shape and reported nothing.
for (const name of ["status", "summary", "details"]) {
  test(`a missing <${name}> is null`, () => {
    const body = FULL.replace(new RegExp(`<${name}>[^<]*</${name}>`), "");
    assert.equal(extractResult(block(body)), null);
  });

  test(`a blank <${name}> is null`, () => {
    const body = FULL.replace(
      new RegExp(`<${name}>[^<]*</${name}>`),
      `<${name}>   \n </${name}>`,
    );
    assert.equal(extractResult(block(body)), null);
  });
}

test("absent optional fields are undefined, not a rejection", () => {
  const r = extractResult(block(FULL));
  assert.equal(r?.files, undefined);
  assert.equal(r?.branch, undefined);
});

test("<files> splits on newlines and commas, and <branch> survives", () => {
  const r = extractResult(
    block(
      `${FULL}<files>\ncore/run.ts\nrun.ts, README.md\n</files><branch>agent-team/r1/t1</branch>`,
    ),
  );
  assert.deepEqual(r?.files, ["core/run.ts", "run.ts", "README.md"]);
  assert.equal(r?.branch, "agent-team/r1/t1");
});

test("a blank <files> is undefined rather than a list of nothing", () => {
  assert.equal(
    extractResult(block(`${FULL}<files>  </files>`))?.files,
    undefined,
  );
});

// The trap the preamble is written around: a model that echoes the shape
// before working leaves two blocks, and the first one describes nothing.
test("the last block wins when the agent echoed the shape first", () => {
  const echoed = block(
    `<status>failed</status><summary>Format I will use.</summary><details>none</details>`,
  );
  const real = block(
    `<status>success</status><summary>Real work.</summary><details>Edited one file.</details>`,
  );
  assert.equal(extractResult(`${echoed}\n${real}`)?.summary, "Real work.");
});

test("the preamble is appended after the task's own prompt", () => {
  const p = withResultPreamble("Fix the bug.");
  assert.match(p, /^Fix the bug\./);
  assert.ok(p.endsWith(RESULT_PREAMBLE));
});

test("a synthesised summary is the tail of the prose, marked as cut", () => {
  assert.equal(synthesiseSummary("  did\n  a thing  "), "did a thing");
  const long = synthesiseSummary("x".repeat(50) + "the end", 10);
  assert.equal(long, "…xxxthe end");
});

// One fixture per warning class.

const kinds = (...args: Parameters<typeof crossCheck>) =>
  crossCheck(...args).map((w) => w.kind);

test("no block at all warns, and says so differently when the tree changed", () => {
  assert.deepEqual(kinds({ result: null, diff: "", permissionCount: 1 }), [
    "noResultBlock",
  ]);
  const [w] = crossCheck({
    result: null,
    diff: " M core/run.ts",
    permissionCount: 1,
  });
  assert.equal(w?.kind, "noResultBlock");
  assert.match(w?.text ?? "", /working tree changed/);
});

test("success with an empty diff warns", () => {
  assert.deepEqual(
    kinds({ result: extractResult(block(FULL)), diff: "", permissionCount: 1 }),
    ["claimedSuccessNoDiff"],
  );
});

test("<files> naming a path the diff lacks warns, and names it", () => {
  const result = extractResult(
    block(`${FULL}<files>core/run.ts\nghost.ts</files>`),
  );
  const [w] = crossCheck({
    result,
    diff: " M core/run.ts",
    permissionCount: 1,
  });
  assert.equal(w?.kind, "filesNotInDiff");
  assert.match(w?.text ?? "", /ghost\.ts/);
  assert.doesNotMatch(w?.text ?? "", /core\/run\.ts/);
});

test("a changed tree with no permission request warns", () => {
  assert.deepEqual(
    kinds({
      result: extractResult(block(FULL)),
      diff: "?? new.ts",
      permissionCount: 0,
    }),
    ["policyNeverFired"],
  );
});

// The M0-1 revision: on opencode this is the normal case, on every mutating
// task. The registry already prints the containment line that says so, so
// repeating it per task is crying wolf.
test("a harness measured as never asking does not raise policyNeverFired", () => {
  assert.deepEqual(
    kinds({
      result: extractResult(block(FULL)),
      diff: "?? new.ts",
      permissionCount: 0,
      asksPermission: false,
    }),
    [],
  );
});

// An unknown diff is not an empty one. Outside a repository we have nothing to
// compare against, and a warning invented from that would fire on every task.
test("an unreadable working tree skips every check that needs one", () => {
  assert.deepEqual(
    kinds({
      result: extractResult(block(`${FULL}<files>ghost.ts</files>`)),
      permissionCount: 0,
    }),
    [],
  );
});

test("a clean, reported, permission-asking task warns about nothing", () => {
  assert.deepEqual(
    kinds({
      result: extractResult(block(`${FULL}<files>core/run.ts</files>`)),
      diff: " M core/run.ts",
      permissionCount: 2,
    }),
    [],
  );
});
