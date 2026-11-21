/**
 * Kept hall scratch folders, called directly — `daemon/scratch.ts`.
 *
 * These cases are slow to stage through a daemon: a symlink at the scratch
 * root, a symlink inside a folder, and a per-folder failure after the
 * preview. The route above this module is covered by `tests/daemon-rooms`.
 */

import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { tempDir } from "../../integration/helpers.ts";
import { cleanScratch, listScratch } from "../scratch.ts";

test("listScratch shows contents and live owners, and never follows symlinks", async (t) => {
  const base = await tempDir(t);
  const root = join(base, "scratch", "hall");
  await mkdir(root, { recursive: true });
  const liveId = "p-live0000";
  const staleId = "p-stale000";
  const linkId = "p-link0000";
  await mkdir(join(root, liveId));
  await writeFile(join(root, liveId, "keep.txt"), "keep\n");
  await mkdir(join(root, staleId, "sub"), { recursive: true });
  await writeFile(join(root, staleId, "notes.md"), "notes\n");
  await writeFile(join(root, staleId, "sub", "deep.txt"), "deep\n");
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(outside, join(root, linkId));
  await symlink(outside, join(root, staleId, "outside"));

  const folders = await listScratch(root, new Map([[liveId, "ann"]]));
  assert.deepEqual(
    folders.map((f) => [f.id, f.inUse, f.participant, f.kind]),
    [
      [linkId, false, undefined, "symlink"],
      [liveId, true, "ann", "directory"],
      [staleId, false, undefined, "directory"],
    ],
  );
  const live = folders.find((f) => f.id === liveId);
  assert.ok(live);
  assert.equal(live.files, 1);
  assert.equal(live.bytes, 5);
  assert.deepEqual(live.entries, ["keep.txt"]);
  const stale = folders.find((f) => f.id === staleId);
  assert.ok(stale);
  assert.equal(stale.files, 2);
  assert.equal(stale.bytes, 11);
  assert.deepEqual(stale.entries, ["notes.md", "outside@", "sub/"]);
  const link = folders.find((f) => f.id === linkId);
  assert.ok(link);
  assert.match(link.problem ?? "", /symbolic link/);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret\n");
});

test("cleanScratch protects live folders and reports each folder's failure", async (t) => {
  const base = await tempDir(t);
  const root = join(base, "scratch", "hall");
  await mkdir(root, { recursive: true });
  const liveId = "p-live0000";
  const staleId = "p-stale000";
  const linkId = "p-link0000";
  await mkdir(join(root, liveId));
  await mkdir(join(root, staleId));
  await writeFile(join(root, staleId, "notes.md"), "notes\n");
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(outside, join(root, linkId));
  await symlink(outside, join(root, staleId, "outside"));

  const results = await cleanScratch(
    root,
    [liveId, staleId, linkId, "p-missing0", "../escape"],
    new Map([[liveId, "ann"]]),
  );
  assert.deepEqual(
    results.map((r) => [r.id, r.removed]),
    [
      [liveId, false],
      [staleId, true],
      [linkId, false],
      ["p-missing0", false],
      ["../escape", false],
    ],
  );
  assert.equal(results[0]?.protected, true);
  assert.match(results[0]?.error ?? "", /in use by @ann/);
  assert.match(results[2]?.error ?? "", /symbolic link/);
  await lstat(join(root, liveId));
  await assert.rejects(lstat(join(root, staleId)), { code: "ENOENT" });
  await lstat(join(root, linkId));
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret\n");
});

test("a scratch root that is a symlink is refused, and a missing one is empty", async (t) => {
  const base = await tempDir(t);
  const real = join(base, "real");
  await mkdir(real, { recursive: true });
  await writeFile(join(real, "notes.md"), "notes\n");
  const link = join(base, "link");
  await symlink(real, link);
  await assert.rejects(listScratch(link, new Map()), /not a real folder/);
  assert.equal(await readFile(join(real, "notes.md"), "utf8"), "notes\n");
  assert.deepEqual(await listScratch(join(base, "missing"), new Map()), []);
  const cleaned = await cleanScratch(
    join(base, "missing"),
    ["p-missing0"],
    new Map(),
  );
  assert.equal(cleaned[0]?.removed, false);
  assert.match(cleaned[0]?.error ?? "", /does not exist/);
  await rm(real, { recursive: true });
});
