/**
 * M4-6, issue #204 — `git diff` text for a question and for a checkout.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { gitRepo, tempDir } from "../../integration/helpers.ts";
import { capDiff, checkoutDiff, editDiff } from "../diff.ts";

const git = (cwd: string, ...args: string[]) =>
  promisify(execFile)("git", args, { cwd }).then((r) => r.stdout.trim());

test("capDiff counts lines in hunks only, and cuts at a line end with how many are left", () => {
  // A removed line that reads `-- x` is `--- x` in the diff: inside a hunk
  // it counts, in a header it does not.
  const text = [
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    "@@ -1,2 +1,2 @@",
    "--- x",
    "+++ y",
    "diff --git a/z b/z",
    "--- a/z",
    "+++ b/z",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const all = capDiff(text, 10_000);
  assert.deepEqual(
    { files: all.files, added: all.added, removed: all.removed },
    { files: 2, added: 2, removed: 2 },
  );
  assert.equal(all.text, text.trimEnd());

  const cut = capDiff(text, 30);
  assert.equal(cut.text, "diff --git a/x b/x\n--- a/x\n… 10 more lines");
  assert.deepEqual([cut.added, cut.removed, cut.files], [2, 2, 2]);
});

test("editDiff reads the old text from disk, shows a missing file as new, and gives nothing for no change", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "old.ts"), "one\ntwo\n");
  const d = await editDiff([
    { abs: join(dir, "old.ts"), path: "src/old.ts", newText: "one\nTWO\n" },
    { abs: join(dir, "none.ts"), path: "none.ts", newText: "a\n" },
    {
      abs: join(dir, "x"),
      path: "given.ts",
      oldText: null,
      newText: "b\n",
    },
  ]);
  assert.ok(d);
  assert.deepEqual([d.files, d.added, d.removed], [3, 3, 1]);
  assert.match(d.text, /^diff --git a\/src\/old\.ts b\/src\/old\.ts\n/);
  assert.match(d.text, /\n-two\n\+TWO\n/);
  assert.match(
    d.text,
    /diff --git a\/none\.ts b\/none\.ts\nnew file mode[^\n]*\n[^\n]*\n--- \/dev\/null\n\+\+\+ b\/none\.ts/,
  );
  assert.match(d.text, /diff --git a\/given\.ts b\/given\.ts\nnew file mode/);

  const same = await editDiff([
    { abs: join(dir, "old.ts"), path: "old.ts", newText: "one\ntwo\n" },
  ]);
  assert.equal(same, undefined);
});

test("editDiff cuts a large edit at the question's cap", async () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const d = await editDiff([
    { abs: "/nowhere", path: "big.txt", oldText: null, newText: `${big}\n` },
  ]);
  assert.ok(d);
  assert.equal(d.added, 5000);
  assert.ok(Buffer.byteLength(d.text) <= 32 * 1024 + 40);
  assert.match(d.text, /\n… \d+ more lines$/);
});

test("checkoutDiff shows uncommitted edits and untracked files, leaves the index alone, and reaches the base", async (t) => {
  const cwd = await gitRepo(t, { ignore: "ignored.txt\n" });
  const base = await git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "README.md"), "second\n");
  await git(cwd, "commit", "-qam", "second");
  await writeFile(join(cwd, "README.md"), "third\n");
  await mkdir(join(cwd, "sub"));
  await writeFile(join(cwd, "sub", "new.txt"), "fresh\n");
  await writeFile(join(cwd, "ignored.txt"), "never\n");
  const status = await git(cwd, "status", "--porcelain");

  // From a subdirectory: the whole checkout, as git names it.
  const head = await checkoutDiff(join(cwd, "sub"), "HEAD");
  assert.equal(head.files, 2);
  assert.match(head.text, /diff --git a\/README\.md b\/README\.md\n/);
  assert.match(head.text, /-second\n\+third/);
  assert.match(
    head.text,
    /diff --git a\/sub\/new\.txt b\/sub\/new\.txt\nnew file mode/,
  );
  assert.doesNotMatch(head.text, /ignored/);
  assert.equal(await git(cwd, "status", "--porcelain"), status);

  const whole = await checkoutDiff(cwd, base);
  assert.match(whole.text, /-first\n\+third/);
});

test("checkoutDiff throws outside a git checkout and for a ref that does not resolve", async (t) => {
  await assert.rejects(checkoutDiff(await tempDir(t), "HEAD"));
  const cwd = await gitRepo(t);
  await assert.rejects(checkoutDiff(cwd, "no-such-ref"));
  // And a clean checkout is an empty diff, not an error.
  const clean = await checkoutDiff(cwd, "HEAD");
  assert.deepEqual(clean, { text: "", files: 0, added: 0, removed: 0 });
  assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "first\n");
});
