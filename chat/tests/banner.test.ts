/**
 * The banner — `chat/tui/banner.ts`, story M4-4 (#50): how many rows it
 * draws, what a click opens, and that a row stays one row.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RoomEventLine } from "../../client/contract.ts";
import { applyLine, newRoomState } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { bannerPart } from "../tui/banner.ts";
import type { View } from "../view.ts";

/** A room `r1` where each of `names` asks one question, and a banner that
 *  looks at room `r2`, so every question is off screen. */
const setup = (names: string[]) => {
  const state = newRoomState();
  let seq = 0;
  const line = (participantId: string, update: RoomEventLine["update"]) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-05T00:00:00Z",
      roomId: "r1",
      participantId,
      update,
    });
  for (const name of names) {
    const id = `p-${name}`;
    line(id, {
      sessionUpdate: "_client_participant_added",
      name,
      harness: "mock",
      mode: "ask",
    });
    line(id, { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
    line(id, {
      sessionUpdate: "_client_permission_queued",
      id: `q-${name}`,
      title: `write ${name}.md`,
      kind: "edit",
    });
  }
  const rooms = new Map([
    ["r1", { entry: { id: "r1", title: "one" }, state } as unknown as Followed],
  ]);
  const opened: View[] = [];
  const asked: string[] = [];
  const part = bannerPart({
    rooms,
    view: () => ({ roomId: "r2" }),
    open: (v) => opened.push(v),
    question: (id) => asked.push(id),
  });
  return { part, line, opened, asked };
};

test("the banner shows 3 rows, and past 3 shows 2 rows and +N more", () => {
  assert.deepEqual(setup([]).part.render(80), [], "nothing waits: no row");
  assert.equal(setup(["ann", "bob", "cy"]).part.render(80).length, 3);
  const rows = setup(["ann", "bob", "cy", "dee"]).part.render(80);
  assert.equal(rows.length, 3);
  assert.match(rows[2] ?? "", /\+2 more/);
});

test("a click on a banner row opens that thread and its question", () => {
  const { part, opened, asked } = setup(["ann", "bob"]);
  part.handleMouse?.({ type: "click", button: "left", x: 0, y: 1 } as never);
  assert.deepEqual(opened, [{ roomId: "r1", participantId: "p-bob" }]);
  assert.deepEqual(asked, ["q-bob"]);
});

test("a stall row holds no control character from the harness", () => {
  const { part, line } = setup(["ann"]);
  line("p-ann", {
    sessionUpdate: "_client_permission_answered",
    id: "q-ann",
    allow: true,
    reason: "user",
  } as never);
  // A repeat warning quotes the harness's own tool title.
  line("p-ann", {
    sessionUpdate: "_client_stall_warning",
    kind: "repeat",
    text: '3× "a\nb\x1b[2J" in a row',
  });
  const rows = part.render(80);
  assert.equal(rows.length, 1);
  assert.ok(!rows[0]?.includes("\n"), "one row stays one row");
  assert.ok(!rows[0]?.includes("\x1b[2J"), "no escape from the harness");
});

test("the stall line in the timeline holds no control character either", () => {
  const { line } = setup(["ann"]);
  const e = line("p-ann", {
    sessionUpdate: "_client_stall_warning",
    kind: "repeat",
    text: '3× "a\nb\x1b[2J" in a row',
  });
  assert.equal(e?.type, "stall");
  assert.equal(e?.type === "stall" && e.text, '3× "a b [2J" in a row');
});
