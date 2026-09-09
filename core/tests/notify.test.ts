/**
 * M1c-4, issue #28.
 *
 * No real bell, no real subprocess, no real terminal. `makeNotifier` takes
 * `write` and `notify` as seams, so every assertion here is on what the
 * listener *decided to emit* — which is the whole of its logic. The one thing
 * a unit test cannot prove is that a human heard it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEventEnvelope } from "../../protocol/agent.ts";
import { makeNotifier, type NotifyOptions } from "../notify.ts";

const BELL = "\x07";

/** A notifier plus the two logs it wrote to. */
function harness(asks: boolean) {
  const lines: string[] = [];
  const desktop: Array<[string, string]> = [];
  const opts: NotifyOptions = {
    asks,
    write: (line) => lines.push(line),
    notify: (title, body) => desktop.push([title, body]),
  };
  return { desktop, lines, notify: makeNotifier(opts) };
}

const pending: AgentEventEnvelope = {
  agent: "t1",
  update: {
    sessionUpdate: "_client_permission_pending",
    title: "write src/app.ts",
    kind: "edit",
  },
};

const stall: AgentEventEnvelope = {
  agent: "t1",
  update: {
    sessionUpdate: "_client_stall_warning",
    kind: "idle",
    text: "no events for 120s",
  },
};

test("a pending permission rings and names the tool call when asking", () => {
  const h = harness(true);
  h.notify(pending);
  assert.deepEqual(h.lines, [
    `${BELL}! [t1] permission needed: [edit] write src/app.ts\n`,
  ]);
  assert.deepEqual(h.desktop, [
    ["agent-team: t1", "permission needed: [edit] write src/app.ts"],
  ]);
});

test("a pending permission is silent when nobody will be asked", () => {
  // `safe` and `auto` answer the same request without a human reading it, so
  // alerting there would beep on every tool call of a fully automatic run.
  const h = harness(false);
  h.notify(pending);
  assert.deepEqual(h.lines, []);
  assert.deepEqual(h.desktop, []);
});

test("a stall warning rings whether or not anyone is asking", () => {
  for (const asks of [true, false]) {
    const h = harness(asks);
    h.notify(stall);
    assert.deepEqual(h.lines, [`${BELL}! [t1] no events for 120s\n`]);
    assert.deepEqual(h.desktop, [["agent-team: t1", "no events for 120s"]]);
  }
});

test("the stall line is written once, not once per half", () => {
  // `run.ts` used to print this line from a subscriber of its own. The
  // notifier owns it now; two owners is how a run says it twice.
  const h = harness(true);
  h.notify(stall);
  assert.equal(h.lines.length, 1);
});

test("every other event is ignored", () => {
  const h = harness(true);
  for (const update of [
    { sessionUpdate: "agent_message_chunk", content: { text: "hi" } },
    {
      sessionUpdate: "_client_permission",
      allow: true,
      title: "x",
      kind: "read",
    },
    { sessionUpdate: "_client_wrote_file", path: "/tmp/x" },
    {
      sessionUpdate: "_client_result_warning",
      kind: "noResultBlock",
      text: "x",
    },
  ] as const) {
    h.notify({ agent: "t1", update } as AgentEventEnvelope);
  }
  assert.deepEqual(h.lines, []);
  assert.deepEqual(h.desktop, []);
});

test("the real desktop half never throws when no notifier is installed", async () => {
  // The default `notify` spawns `notify-send`/`osascript`. With an empty PATH
  // neither exists, and a missing notifier must change nothing: no throw, no
  // unhandled `error` event, no exit code.
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    const lines: string[] = [];
    makeNotifier({ asks: true, write: (l) => lines.push(l) })(stall);
    // The `error` event fires on a later tick; an unhandled one would kill the
    // process, so give it one before declaring the run survived.
    await new Promise((r) => setImmediate(r));
    assert.equal(lines.length, 1);
  } finally {
    process.env.PATH = path;
  }
});
