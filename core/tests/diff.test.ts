/**
 * M4-6, issue #204 — `git diff` text for a question and for a checkout.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { gitRepo, tempDir } from "../../integration/helpers.ts";
import {
  capDiff,
  checkoutDiff,
  editDiff,
  isAncestor,
  mergeBase,
  rangeDiff,
} from "../diff.ts";

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

test("editDiff cannot write through a path that leaves its temporary folder", async (t) => {
  const dir = await tempDir(t);
  const victim = join(dir, "victim.txt");
  await writeFile(victim, "VICTIM\n");

  const link = join(
    tmpdir(),
    `kapelle-edit-escape-${process.pid}-${Date.now()}`,
  );
  await symlink(victim, link);
  t.after(() => rm(link, { force: true }));
  // The actual per-edit folder is one level under the mkdtemp root. A path
  // that escapes it and reaches this symlink must be refused before a write.
  const placeholder = join(tmpdir(), "kapelle-diff-placeholder", "0");
  const escaped = join("..", relative(placeholder, link));

  await assert.rejects(
    editDiff([{ abs: link, path: escaped, newText: "NEW\n" }]),
    /leaves its temporary folder/,
  );
  assert.equal(await readFile(victim, "utf8"), "VICTIM\n");
  await assert.rejects(
    editDiff([{ abs: victim, path: "/etc/passwd", newText: "NEW\n" }]),
    /is absolute/,
  );
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

test("mergeBase finds the fork point, returns undefined only for a missing ref, and reports git failures", async (t) => {
  const cwd = await gitRepo(t);
  const fork = await git(cwd, "rev-parse", "HEAD");
  await git(cwd, "branch", "topic");
  await writeFile(join(cwd, "README.md"), "second\n");
  await git(cwd, "commit", "-qam", "second");

  assert.equal(await mergeBase(cwd, "refs/heads/main", "topic"), fork);
  assert.equal(await mergeBase(cwd, "refs/heads/missing", "topic"), undefined);

  // No shared history is a merge-base failure, not a deleted ref: a room must
  // return no_diff rather than fall back to a stale saved SHA.
  await git(cwd, "checkout", "-q", "--orphan", "orphan");
  await git(cwd, "rm", "-q", "-rf", ".");
  await writeFile(join(cwd, "orphan.txt"), "orphan\n");
  await git(cwd, "add", "orphan.txt");
  await git(cwd, "commit", "-qm", "orphan");
  await assert.rejects(mergeBase(cwd, "refs/heads/main", "orphan"));

  // A folder that is not a repository is a git failure, not a deleted ref.
  // Returning undefined would send a room down its saved-SHA fallback and
  // hide why the current base could not be read.
  await assert.rejects(mergeBase(await tempDir(t), "refs/heads/main", "HEAD"));
});

test("isAncestor distinguishes true, false, an unresolvable ancestor and git failures", async (t) => {
  const cwd = await gitRepo(t);
  const first = await git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "README.md"), "second\n");
  await git(cwd, "commit", "-qam", "second");

  assert.equal(await isAncestor(cwd, first, "HEAD"), true);
  assert.equal(await isAncestor(cwd, "HEAD", first), false);
  assert.equal(await isAncestor(cwd, "0".repeat(40), "HEAD"), false);
  await assert.rejects(isAncestor(await tempDir(t), "HEAD", "HEAD"));
});

test("rangeDiff shows only what the source adds, not the target's own commits", async (t) => {
  const cwd = await gitRepo(t);
  await git(cwd, "branch", "source");
  await writeFile(join(cwd, "late.txt"), "the target's own\n");
  await git(cwd, "add", "late.txt");
  await git(cwd, "commit", "-qm", "late");
  await git(cwd, "checkout", "-q", "source");
  await writeFile(join(cwd, "review.txt"), "review\n");
  await git(cwd, "add", "review.txt");
  await git(cwd, "commit", "-qm", "review");
  await git(cwd, "checkout", "-q", "-");

  const diff = await rangeDiff(cwd, "HEAD", "source");
  assert.equal(diff.files, 1, diff.text);
  assert.match(diff.text, /review\.txt/);
  assert.doesNotMatch(diff.text, /late\.txt/);
});
