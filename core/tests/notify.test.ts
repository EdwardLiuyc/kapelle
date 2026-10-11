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
import { READ_ONLY_KINDS } from "../policy.ts";

const BELL = "\x07";

/** A notifier plus the two logs it wrote to. */
function harness(asks: boolean, askIds?: ReadonlySet<string>) {
  const lines: string[] = [];
  const desktop: Array<[string, string]> = [];
  const opts: NotifyOptions = {
    asks,
    askIds,
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
    ["kapelle: t1", "permission needed: [edit] write src/app.ts"],
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

test("a read-only pending permission is silent — nobody is ever prompted for it", () => {
  // `makeAskPolicy` returns on `READ_ONLY_KINDS` without reaching readline, so
  // the pending event for one is over before anybody could look up. Ringing
  // there is what trains a user to ignore the bell.
  for (const kind of [...READ_ONLY_KINDS]) {
    const h = harness(true);
    h.notify({
      agent: "solo",
      update: {
        sessionUpdate: "_client_permission_pending",
        title: `a ${kind} tool call`,
        kind,
      },
    });
    assert.deepEqual(h.lines, [], `${kind} must not ring`);
    assert.deepEqual(h.desktop, [], `${kind} must not pop up`);
  }
});

test("a mutation pending permission still rings — the filter is by kind, not off", () => {
  // The guard above must not swallow the case the story exists for. `edit` is
  // the kind `#guardWrite` always emits, so this covers the direct-write path
  // as well as a harness that asks first.
  for (const kind of ["edit", "delete", "execute", "move", "other"] as const) {
    const h = harness(true);
    h.notify({
      agent: "solo",
      update: {
        sessionUpdate: "_client_permission_pending",
        title: `a ${kind} tool call`,
        kind,
      },
    });
    assert.equal(h.lines.length, 1, `${kind} must ring`);
  }
});

test("a pending permission from a non-ask task is silent in a mixed run file", () => {
  // `--file` with one asker and another `safe`/`auto` task still emits the
  // pending event from both, but only the asker's decision can wait on a
  // human. `askIds` keeps the bell on that task rather than on every task.
  const h = harness(true, new Set(["asker"]));
  h.notify({ agent: "asker", update: pending.update });
  h.notify({ agent: "auto", update: pending.update });
  assert.deepEqual(h.lines, [
    `${BELL}! [asker] permission needed: [edit] write src/app.ts\n`,
  ]);
  assert.deepEqual(h.desktop, [
    ["kapelle: asker", "permission needed: [edit] write src/app.ts"],
  ]);
});

test("stall warnings from non-ask tasks are not filtered by askIds", () => {
  const h = harness(true, new Set(["asker"]));
  h.notify({ agent: "auto", update: stall.update });
  assert.deepEqual(h.lines, [`${BELL}! [auto] no events for 120s\n`]);
  assert.deepEqual(h.desktop, [["kapelle: auto", "no events for 120s"]]);
});

test("a stall warning rings whether or not anyone is asking", () => {
  for (const asks of [true, false]) {
    const h = harness(asks);
    h.notify(stall);
    assert.deepEqual(h.lines, [`${BELL}! [t1] no events for 120s\n`]);
    assert.deepEqual(h.desktop, [["kapelle: t1", "no events for 120s"]]);
  }
});

test("the stall line is written once, not once per half", () => {
  // `cli.ts` used to print this line from a subscriber of its own. The
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

test("the harness's title and a stall's text ring as one clean line each (#229)", () => {
  const h = harness(true);
  h.notify({
    agent: "t1",
    update: {
      ...pending.update,
      title: "write a\x1b]52;c;aGFja2Vk\x07\n! [t1] fake",
    },
  } as AgentEventEnvelope);
  h.notify({
    agent: "t1",
    update: { ...stall.update, text: '3× "a\x1b[2J\nb" in a row' },
  } as AgentEventEnvelope);

  assert.equal(h.lines.length, 2);
  for (const line of h.lines) {
    assert.ok(line.startsWith(`${BELL}! [t1] `), "the bell is ours, first");
    assert.equal(line.indexOf("\n"), line.length - 1, "one line");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the subject.
    assert.doesNotMatch(line.slice(1), /[\x1b\x07]/);
  }
  for (const [, body] of h.desktop) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the subject.
    assert.doesNotMatch(body, /[\x1b\x07\n]/);
  }
});
