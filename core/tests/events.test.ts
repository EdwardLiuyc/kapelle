/**
 * M1a-6 acceptance tests — issue #14.
 *
 * The bus is a pure function of its subscriptions, so it is tested as one.
 * Two properties matter and neither is obvious from reading the code: every
 * subscriber sees every event (that is the whole promise), and one throwing
 * subscriber does not cost the others theirs (a broken renderer must not take
 * the run down).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEventEnvelope } from "../../protocol/agent.ts";
import { createEventBus } from "../events.ts";

const event: AgentEventEnvelope = {
  agent: "mock-agent",
  update: { sessionUpdate: "_client_wrote_file", path: "/repo/foo.ts" },
};

test("every subscriber receives every event", () => {
  const bus = createEventBus();
  const seenA: AgentEventEnvelope[] = [];
  const seenB: AgentEventEnvelope[] = [];
  bus.addListener((e) => seenA.push(e));
  bus.addListener((e) => seenB.push(e));

  bus.emit(event);

  assert.deepEqual(seenA, [event]);
  assert.deepEqual(seenB, [event]);
});

test("the event arrives unchanged, _meta included (#62 B4)", () => {
  const bus = createEventBus();
  const withMeta: AgentEventEnvelope = {
    agent: "mock-agent",
    update: {
      sessionUpdate: "usage_update",
      used: 900,
      size: 200_000,
      _meta: { "_claude/rateLimit": { remaining: 3 } },
    },
  };
  let seen: AgentEventEnvelope | undefined;
  bus.addListener((e) => {
    seen = e;
  });

  bus.emit(withMeta);

  assert.equal(seen, withMeta);
  assert.deepEqual(seen?.update._meta, {
    "_claude/rateLimit": { remaining: 3 },
  });
});

test("a throwing subscriber does not stop the ones behind it", (t) => {
  const bus = createEventBus();
  // Scoped to this test and auto-restored, so nothing else in the file sees
  // a patched console.
  const errored = t.mock.method(console, "error", () => {});

  let reached = false;
  bus.addListener(() => {
    throw new Error("renderer is broken");
  });
  bus.addListener(() => {
    reached = true;
  });

  assert.doesNotThrow(() => bus.emit(event));

  assert.equal(reached, true);
  // The error object travels, not its message — a listener bug keeps its stack.
  const [, thrown] = errored.mock.calls[0].arguments;
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "renderer is broken");
});

test("emit detaches from the bus object, so it can be passed as onEvent", () => {
  const bus = createEventBus();
  const seen: AgentEventEnvelope[] = [];
  bus.addListener((e) => seen.push(e));

  const sink = bus.emit;
  sink(event);

  assert.deepEqual(seen, [event]);
});

test("emitting with no subscribers is a no-op, not a throw", () => {
  const bus = createEventBus();
  assert.doesNotThrow(() => bus.emit(event));
});
