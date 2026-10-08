/**
 * The sidebar's marks after a restart — story M6-7a (#151). A participant
 * the daemon reports `paused` or `killed` says so beside its name, and so
 * does a paused room.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RoomDto, RoomEventLine } from "../../client/contract.ts";
import { applyLine, applyStatus, newRoomState } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { sidebarParts } from "../tui/sidebar.ts";

test("a paused room and its paused and killed participants are marked", () => {
  const state = newRoomState();
  let seq = 0;
  for (const [id, name] of [
    ["p-ana", "ana"],
    ["p-bob", "bob"],
  ]) {
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-08T00:00:00Z",
      roomId: "r1",
      participantId: id as string,
      update: {
        sessionUpdate: "_client_participant_added",
        name: name as string,
        harness: "mock",
        mode: "auto",
      },
    } satisfies RoomEventLine);
  }
  applyStatus(state, {
    participants: [
      { id: "p-ana", status: "paused" },
      { id: "p-bob", status: "killed" },
    ],
  } as unknown as RoomDto);
  const rooms = new Map([
    [
      "r1",
      {
        entry: { id: "r1", cwd: "/src/app", status: "paused" },
        state,
      } as unknown as Followed,
    ],
  ]);
  const { sidebar } = sidebarParts({
    rooms,
    view: () => ({ roomId: "r1" }),
    toggle() {},
    open() {},
  });
  const text = sidebar
    .render(40)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .join("\n");
  assert.match(text, /r1 app paused/);
  assert.match(text, /ana paused/);
  assert.match(text, /bob killed/);
});
