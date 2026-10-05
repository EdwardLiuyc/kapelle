/**
 * Reading a `git diff` text for a screen — `client/diff.ts`, story M4-6
 * (#204). No daemon.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { diffLine, filesOf } from "../diff.ts";

const TEXT = [
  "diff --git a/cli.ts b/cli.ts",
  "index 1..2 100644",
  "--- a/cli.ts",
  "+++ b/cli.ts",
  "@@ -1 +1 @@",
  "-new file mode is only a header",
  "+x",
  "diff --git a/my notes.md b/my notes.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/my notes.md",
  "diff --git a/old.ts b/old.ts",
  "deleted file mode 100644",
].join("\n");

test("filesOf finds each file, its first line, and git's new or deleted, from the header only", () => {
  assert.deepEqual(filesOf(TEXT.split("\n")), [
    { path: "cli.ts", line: 0 },
    { path: "my notes.md", line: 7, tag: "new" },
    { path: "old.ts", line: 11, tag: "deleted" },
  ]);
  // A header whose halves differ is read from its last ` b/`.
  assert.deepEqual(filesOf(["diff --git a/from b/to"]), [
    { path: "to", line: 0 },
  ]);
});

test("diffLine names the first file, how many more, and the counts", () => {
  const d = { text: TEXT, files: 3, added: 12, removed: 4 };
  assert.equal(diffLine(d), "± cli.ts and 2 more files +12 −4");
  assert.equal(
    diffLine({ ...d, text: TEXT.split("\n").slice(7).join("\n"), files: 2 }),
    "± my notes.md (new) and 1 more file +12 −4",
  );
  assert.equal(
    diffLine({ text: "diff --git a/x b/x", files: 1, added: 1, removed: 0 }),
    "± x +1 −0",
  );
});
