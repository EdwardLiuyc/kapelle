/**
 * The room record names the list that holds a bad participant (M12-8c).
 *
 * Both lists use the one participant check. The check names the field, and
 * `readRoomRecord` names the list, so a hand edit gets the same error wherever
 * the bad participant sits.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { tempDir } from "../../../integration/helpers.ts";
import { readRoomRecord } from "../record.ts";

const ROOM = {
  id: "r-1",
  cwd: "/repo",
  createdAt: "2026-11-26T00:00:00.000Z",
  updatedAt: "2026-11-26T00:00:00.000Z",
  status: "active",
};

const PARTICIPANT = {
  id: "p-1",
  name: "solo",
  agent: "claude",
  harness: "claude",
  worktree: "/tmp/w",
  sessionId: "s-1",
  mode: "auto",
  status: "idle",
};

async function badRecord(t: TestContext, where: "participants" | "tombstones") {
  const dir = await tempDir(t);
  const file = join(dir, "room.json");
  const record: Record<string, unknown> & {
    participants: unknown[];
    tombstones: unknown[];
  } = { ...ROOM, participants: [], tombstones: [] };
  record[where] = [{ ...PARTICIPANT, name: 7 }];
  await writeFile(file, JSON.stringify(record));
  return file;
}

test("a bad participant error names the list that holds it", async (t) => {
  for (const where of ["participants", "tombstones"] as const) {
    const file = await badRecord(t, where);
    assert.throws(
      () => readRoomRecord(file),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(
          `the ${where} list: a participant's "name" is not a string`,
        ),
    );
  }
});
