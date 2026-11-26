/** Direct tests for the disk-reading workspace path guard. */

import assert from "node:assert/strict";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { tempDir } from "../../integration/helpers.ts";
import { guardPathOnDisk } from "../path-guard.ts";

test("the root and a missing in-root tail are allowed", async (t) => {
  const root = await realpath(await tempDir(t));
  assert.equal(await guardPathOnDisk(root, ".", { write: false }), root);
  assert.equal(
    await guardPathOnDisk(root, "new/nested/file.txt", { write: true }),
    join(root, "new/nested/file.txt"),
  );
});

test("an outside read needs its explicit allowance", async (t) => {
  const root = await realpath(await tempDir(t));
  const outside = await realpath(await tempDir(t));
  const path = join(outside, "missing.txt");

  await assert.rejects(
    guardPathOnDisk(root, path, { write: false }),
    /path outside workspace root refused/,
  );
  assert.equal(
    await guardPathOnDisk(root, path, {
      write: false,
      allowReadOutsideRoot: true,
    }),
    path,
  );
});

test("a write outside the root is refused even when outside reads are allowed", async (t) => {
  const root = await realpath(await tempDir(t));
  const outside = await realpath(await tempDir(t));

  await assert.rejects(
    guardPathOnDisk(root, join(outside, "file.txt"), {
      write: true,
      allowReadOutsideRoot: true,
    }),
    /path outside workspace root refused/,
  );
});

test("a root-name prefix does not make a sibling path part of the root", async (t) => {
  const root = await realpath(await tempDir(t));
  await mkdir(`${root}-sibling`);
  t.after(() => rm(`${root}-sibling`, { recursive: true, force: true }));

  await assert.rejects(
    guardPathOnDisk(root, `${root}-sibling/file.txt`, { write: false }),
    /path outside workspace root refused/,
  );
});

test("a symlink escape is refused, while an in-root link keeps its requested name", async (t) => {
  const root = await realpath(await tempDir(t));
  const outside = await realpath(await tempDir(t));
  await symlink(outside, join(root, "escape"), "dir");
  await mkdir(join(root, "target"));
  await symlink(join(root, "target"), join(root, "inside"), "dir");

  await assert.rejects(
    guardPathOnDisk(root, "escape/file.txt", { write: true }),
    /path outside workspace root refused/,
  );
  assert.equal(
    await guardPathOnDisk(root, "inside/file.txt", { write: true }),
    join(root, "inside/file.txt"),
  );
});

test("an unresolved symlink is refused even when its target would be in-root", async (t) => {
  const root = await realpath(await tempDir(t));
  await symlink(join(root, "missing-target"), join(root, "dangling"), "file");

  await assert.rejects(
    guardPathOnDisk(root, "dangling", { write: true }),
    /unresolved symlink refused/,
  );
});
