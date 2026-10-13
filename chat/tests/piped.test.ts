/**
 * The piped screen's tool lines — `makePrinter` in `chat/piped.ts`, #240.
 * A pipe cannot change a line, so a tool call prints again only when what
 * it shows changed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RoomEventLine } from "../../client/contract.ts";
import { applyLine, newRoomState } from "../../client/room.ts";
import { makePrinter } from "../piped.ts";

test("a tool call prints again only when its title, detail or failure changed", (t) => {
  const state = newRoomState();
  const printer = makePrinter(state);
  let out = "";
  t.mock.method(process.stdout, "write", (s: string) => {
    out += s;
    return true;
  });
  let seq = 0;
  const send = (update: Record<string, unknown>) => {
    const e = applyLine(state, {
      seq: ++seq,
      at: "2026-10-10T00:00:00Z",
      roomId: "r1",
      participantId: "p-ann",
      update: update as unknown as RoomEventLine["update"],
    });
    if (e) printer.show(e);
  };
  send({
    sessionUpdate: "_client_participant_added",
    name: "ann",
    harness: "mock",
    mode: "auto",
  });
  send({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Terminal" });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    title: "ls",
    rawInput: { path: "/w" },
  });
  // A status that draws nothing new prints nothing.
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
  });
  send({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "failed",
  });
  t.mock.restoreAll();
  assert.equal(
    out,
    "ann:\n  · Terminal\n  · ls\n    /w\n  · ls — failed\n    /w\n",
  );
});

test("a message from the orchestrator prints po → ann, live and queued (M8-1)", (t) => {
  const state = newRoomState();
  const printer = makePrinter(state);
  let out = "";
  t.mock.method(process.stdout, "write", (s: string) => {
    out += s;
    return true;
  });
  let seq = 0;
  const send = (update: Record<string, unknown>, participantId = "p-ann") => {
    const e = applyLine(state, {
      seq: ++seq,
      at: "2026-10-10T00:00:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
    if (e) printer.show(e);
  };
  for (const [id, name] of [
    ["p-ann", "ann"],
    ["p-po", "po"],
  ]) {
    send(
      {
        sessionUpdate: "_client_participant_added",
        name,
        harness: "mock",
        mode: "auto",
      },
      id,
    );
  }
  send({ sessionUpdate: "_client_user_message", text: "a", turn: 1 });
  send({ sessionUpdate: "_client_message_queued", text: "b", from: "p-po" });
  send({
    sessionUpdate: "_client_user_message",
    text: "b",
    turn: 2,
    from: "p-po",
  });
  t.mock.restoreAll();
  assert.equal(
    out,
    "you → ann: a\n  (queued for ann, from po) b\npo → ann: b\n",
  );
});
