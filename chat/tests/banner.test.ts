/**
 * The activity rows — `chat/tui/banner.ts`, stories M4-4 (#50) and M7-1:
 * how many rows it draws, what a click opens, that a row stays one row,
 * and what a busy row says.
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

test("the rows: 4, and past 4, 3 rows and +N more (M7-1)", () => {
  assert.deepEqual(setup([]).part.render(80), [], "nothing waits: no row");
  assert.equal(setup(["ann", "bob", "cy", "dee"]).part.render(80).length, 4);
  const rows = setup(["ann", "bob", "cy", "dee", "eve"]).part.render(80);
  assert.equal(rows.length, 4);
  assert.match(rows[3] ?? "", /\+2 more/);
  assert.match(rows[0] ?? "", /▌\? ann/, "a question's mark, not only magenta");
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
  assert.match(rows[0] ?? "", /▌! ann/, "a stall's mark, not only yellow");
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

/** Room `r1` with ann busy since 09:00, seen from `r1`'s timeline at
 *  09:01:05. */
const busySetup = () => {
  const state = newRoomState();
  let seq = 0;
  const line = (update: Record<string, unknown>) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-10T09:00:00Z",
      roomId: "r1",
      participantId: "p-ann",
      update: update as unknown as RoomEventLine["update"],
    });
  line({
    sessionUpdate: "_client_participant_added",
    name: "ann",
    harness: "claude",
    mode: "ask",
  });
  line({ sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", title: "one" }, state } as unknown as Followed],
  ]);
  const opened: View[] = [];
  const asked: string[] = [];
  const part = bannerPart({
    rooms,
    view: () => ({ roomId: "r1" }),
    open: (v) => opened.push(v),
    question: (id) => asked.push(id),
    now: () => Date.parse("2026-10-10T09:01:05Z"),
  });
  const text = () =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    part.render(120).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  return { part, line, text, opened, asked };
};

test("a busy row: thinking, then the last tool, then working, with its timer and the cancel command (M7-1)", () => {
  const { part, line, text, opened, asked } = busySetup();
  assert.deepEqual(text(), ["▌◓ ann working · 1m 05s · @ann /cancel"]);
  line({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "SECRET" },
  });
  assert.deepEqual(text(), ["▌◓ ann thinking · 1m 05s · @ann /cancel"]);
  assert.ok(!part.render(120).join("").includes("SECRET"), "never the text");
  line({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read File" });
  assert.deepEqual(text(), ["▌◓ ann Read File · 1m 05s · @ann /cancel"]);
  // An update sets the title in place (#240): the row follows it.
  line({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    title: "Read package.json",
  });
  assert.deepEqual(text(), [
    "▌◓ ann Read package.json · 1m 05s · @ann /cancel",
  ]);
  part.handleMouse?.({ type: "click", button: "left", x: 0, y: 0 } as never);
  assert.deepEqual(opened, [{ roomId: "r1", participantId: "p-ann" }]);
  // Its question is on screen: it waits for the person, so no cancel.
  line({
    sessionUpdate: "_client_permission_queued",
    id: "q1",
    title: "Write a.md",
    kind: "edit",
  });
  assert.deepEqual(text(), ["▌? ann asks: Write a.md · 1m 05s"]);
  assert.ok(part.render(120)[0]?.includes("\x1b[35m?"), "a magenta ?");
  part.handleMouse?.({ type: "click", button: "left", x: 0, y: 0 } as never);
  assert.deepEqual(asked, ["q1"], "a click opens its question");
  line({
    sessionUpdate: "_client_permission_answered",
    id: "q1",
    allow: true,
    reason: "user",
  });
  assert.deepEqual(text(), [
    "▌◓ ann Read package.json · 1m 05s · @ann /cancel",
  ]);
  line({ sessionUpdate: "_client_turn_ended", stopReason: "end_turn" });
  assert.deepEqual(text(), [], "idle: no row");
});

test("a busy row shows a multi-line tool title's first line only (#351)", () => {
  const { line, text } = busySetup();
  line({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "for n in 1 2; do echo $n; done",
    rawInput: { command: "for n in 1 2; do echo $n; done" },
  });
  assert.deepEqual(text(), ["▌◓ ann for n in 1 2;… · 1m 05s · @ann /cancel"]);
  assert.ok(!text().join("").includes("\n"), "one row stays one row");
  // A title that is one line already gets no `…`.
  line({ sessionUpdate: "tool_call_update", toolCallId: "t1", title: "ls" });
  assert.deepEqual(text(), ["▌◓ ann ls · 1m 05s · @ann /cancel"]);
});

test("NO_COLOR: the activity rows lose their colours (M7-1)", (t) => {
  const was = process.env.NO_COLOR;
  t.after(() => {
    if (was === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = was;
  });
  const { part } = busySetup();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const COLOUR = /\x1b\[(3[0-9]|4[0-9]|9[0-7]|10[0-7])[;m]/;
  delete process.env.NO_COLOR;
  assert.match(part.render(120).join(""), COLOUR, "a colour without it");
  process.env.NO_COLOR = "1";
  assert.doesNotMatch(part.render(120).join(""), COLOUR);
  assert.ok(part.render(120).join("").includes("\x1b[1m"), "bold stays");
});
