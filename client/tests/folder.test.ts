/**
 * Folder completion — `client/folder.ts`, story M4-5 (#181).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeFolder, expandHome } from "../folder.ts";

test("~ and ~/… are the home folder; nothing else changes", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/src"), `${homedir()}/src`);
  for (const p of ["~bob", "/a/~/b", "src"]) assert.equal(expandHome(p), p);
});

test("a bare ~ completes like ~/", () => {
  // The same folder, so the same value and the same names under it.
  assert.deepEqual(completeFolder("~", "/"), completeFolder("~/", "/"));
  assert.ok(completeFolder("~", "/").value.startsWith("~/"), "not ~/");
});

test("Tab completes folders only, as far as they agree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const d of ["agent-team", "agent-notes", "apps", ".hidden"]) {
    await mkdir(join(root, d));
  }
  await writeFile(join(root, "agent-file"), "");
  await symlink(join(root, "apps"), join(root, "apps-link"));
  await symlink(join(root, "gone"), join(root, "broken"));

  // Many: the shared part, and the folders that still match. Never a file.
  assert.deepEqual(completeFolder(`${root}/ag`, "/"), {
    value: `${root}/agent-`,
    options: ["agent-notes", "agent-team"],
  });
  // One: filled in, with a slash after it, ready for the next Tab.
  assert.deepEqual(completeFolder(`${root}/agent-t`, "/"), {
    value: `${root}/agent-team/`,
    options: [],
  });
  // A link to a folder counts; a broken one does not.
  assert.deepEqual(completeFolder(`${root}/app`, "/").options, [
    "apps",
    "apps-link",
  ]);
  assert.deepEqual(completeFolder(`${root}/br`, "/").options, []);
  // Hidden folders only when asked for.
  assert.deepEqual(completeFolder(`${root}/.h`, "/").value, `${root}/.hidden/`);
  assert.ok(!completeFolder(`${root}/`, "/").options.includes(".hidden"));
  // A relative path completes from `cwd`.
  assert.deepEqual(completeFolder("agent-t", root).value, "agent-team/");
  // No match, or no such folder: the text stays as typed.
  assert.deepEqual(completeFolder(`${root}/zz`, "/"), {
    value: `${root}/zz`,
    options: [],
  });
  assert.deepEqual(completeFolder(`${root}/nope/x`, "/"), {
    value: `${root}/nope/x`,
    options: [],
  });
});
