/**
 * What a typed line is — `client/submit.ts`, story M4-8 (#208). One test per
 * outcome both screens act on.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseLine } from "../submit.ts";

const ROSTER = [
  { id: "p-a", name: "alice", role: "orchestrator" },
  { id: "p-b", name: "Bob" },
];

test("a command that does not parse is refused", () => {
  assert.deepEqual(parseLine("/remove", ROSTER), {
    error: "name the agent: @name /remove",
  });
});

test("/leave, /help and a bare /new or /add are their own outcomes", () => {
  assert.deepEqual(parseLine("/leave", ROSTER), { verb: "leave" });
  assert.deepEqual(parseLine("/help", ROSTER), { verb: "help" });
  assert.deepEqual(parseLine("/new", ROSTER), { verb: "form", form: "new" });
  assert.deepEqual(parseLine("@bob /add", ROSTER), {
    verb: "form",
    form: "add",
  });
});

test("a command that calls a route", () => {
  assert.deepEqual(parseLine("@bob /cancel", ROSTER), {
    verb: "cancel",
    id: "p-b",
    name: "Bob",
  });
  assert.deepEqual(parseLine("/dismiss", []), { verb: "dismiss" });
});

test("a message carries its target", () => {
  assert.deepEqual(parseLine("look at this", ROSTER), {
    verb: "message",
    target: { id: "p-a", text: "look at this" },
  });
  assert.deepEqual(parseLine("@bob /usr/bin is slow", ROSTER), {
    verb: "message",
    target: { id: "p-b", text: "/usr/bin is slow" },
  });
});

test("a message with no target carries the target's refusal", () => {
  assert.deepEqual(parseLine("@carol hi", ROSTER), {
    verb: "message",
    target: { error: "no participant named @carol" },
  });
  assert.deepEqual(parseLine("@bob", ROSTER), {
    verb: "message",
    target: { error: "nothing to send" },
  });
});
