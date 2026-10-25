/**
 * M1c-1, issue #25.
 *
 * No real timers here. `createWatchdog` takes a clock and exposes `sweep()`,
 * so every deadline in this file is reached by moving a number — which is the
 * only way to test an hour-long TTL in a suite that must stay fast.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEventEnvelope } from "../../protocol/agent.ts";
import {
  createWatchdog,
  type StallKind,
  sweepIntervalMs,
  WATCHDOG_DEFAULTS,
  type WatchdogLimits,
} from "../watchdog.ts";

const limits = (over: Partial<WatchdogLimits> = {}): WatchdogLimits => ({
  ...WATCHDOG_DEFAULTS,
  ...over,
});

let nextTool = 0;
const toolCall = (
  id: string,
  title: string,
  rawInput?: Record<string, unknown>,
  kind?: "execute" | "read" | "search",
  toolCallId = `${id}-tool-${++nextTool}`,
): AgentEventEnvelope => ({
  agent: id,
  update: {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    ...(rawInput && { rawInput }),
    ...(kind && { kind }),
  },
});

const toolUpdate = (
  id: string,
  toolCallId: string,
  rawInput?: Record<string, unknown>,
  kind?: "execute" | "read" | "search",
  title?: string,
): AgentEventEnvelope => ({
  agent: id,
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId,
    ...(rawInput && { rawInput }),
    ...(kind && { kind }),
    ...(title && { title }),
  },
});

const chunk = (id: string): AgentEventEnvelope => ({
  agent: id,
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "." },
  },
});

/** A watchdog with a clock the test drives, and the calls it made. */
function harness() {
  let clock = 1_000;
  const warns: Array<[string, StallKind]> = [];
  const timeouts: string[] = [];
  const wd = createWatchdog({
    now: () => clock,
    onWarn: (id, kind) => warns.push([id, kind]),
    onTimeout: (id) => timeouts.push(id),
  });
  return {
    wd,
    warns,
    timeouts,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

// --- sweepIntervalMs -------------------------------------------------------

test("the sweep interval is a quarter of the finest time limit", () => {
  assert.equal(sweepIntervalMs([limits({ stallIdleMs: 8_000 })]), 2_000);
  assert.equal(sweepIntervalMs([limits({ ttlMs: 20_000 })]), 5_000);
});

test("the sweep interval takes the smallest limit across all tasks", () => {
  const interval = sweepIntervalMs([
    limits({ stallIdleMs: 600_000 }),
    limits({ stallIdleMs: 12_000 }),
    limits({ stallIdleMs: 400_000 }),
  ]);
  assert.equal(interval, 3_000);
});

test("the sweep interval is clamped to 1s–60s", () => {
  // A knob far below the floor must not turn the sweep into a busy loop.
  assert.equal(sweepIntervalMs([limits({ stallIdleMs: 100 })]), 1_000);
  // The defaults are minute-scale, so they hit the ceiling.
  assert.equal(sweepIntervalMs([limits()]), 60_000);
});

test("the sweep interval ignores zeroed limits, and defaults with none left", () => {
  // `0` disables a signal, so it is not a deadline to keep pace with.
  assert.equal(
    sweepIntervalMs([limits({ stallIdleMs: 0, ttlMs: 40_000 })]),
    10_000,
  );
  // Every time limit off: nothing to watch for, so the ceiling.
  assert.equal(sweepIntervalMs([limits({ stallIdleMs: 0, ttlMs: 0 })]), 60_000);
  // `stallRepeatCount` is a count, not a duration — it must not be read here.
  assert.equal(
    sweepIntervalMs([
      limits({ stallIdleMs: 0, ttlMs: 0, stallRepeatCount: 4 }),
    ]),
    60_000,
  );
  assert.equal(sweepIntervalMs([]), 60_000);
});

// --- idle ------------------------------------------------------------------

test("a task with no events for stallIdleMs warns once, not once per sweep", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallIdleMs: 10_000 }));

  h.advance(9_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "not idle yet");

  h.advance(2_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "idle"]]);

  h.advance(60_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "idle"]], "still the same idle spell");
});

test("an event clears the idle warning, so a second spell warns again", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallIdleMs: 10_000 }));

  h.advance(11_000);
  h.wd.sweep();
  h.wd.note(chunk("a"));

  h.advance(11_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, [
    ["a", "idle"],
    ["a", "idle"],
  ]);
});

test("a question that waits for a person pauses the idle clock (#195)", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallIdleMs: 10_000, ttlMs: 0 }));

  h.wd.note({
    agent: "a",
    update: {
      sessionUpdate: "_client_permission_pending",
      title: "edit x",
      kind: "edit",
    },
  });
  h.advance(60_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "the harness waits for the answer");

  h.wd.note({
    agent: "a",
    update: {
      sessionUpdate: "_client_permission",
      allow: true,
      title: "edit x",
      kind: "edit",
    },
  });
  h.advance(9_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "the clock counts from the answer");

  h.advance(2_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "idle"]]);
});

test("stallIdleMs 0 disables the idle signal", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallIdleMs: 0 }));
  h.advance(10_000_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, []);
});

// --- repeat ----------------------------------------------------------------

test("the same operation stallRepeatCount times in a row warns once", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));

  h.wd.note(toolCall("a", "grep"));
  h.wd.note(toolCall("a", "grep"));
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "two is under the threshold");

  h.wd.note(toolCall("a", "grep"));
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]]);

  h.wd.note(toolCall("a", "grep"));
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]], "still the same streak");
});

test("a different tool title resets the repeat counter", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));

  h.wd.note(toolCall("a", "grep"));
  h.wd.note(toolCall("a", "grep"));
  h.wd.note(toolCall("a", "read"));
  h.wd.note(toolCall("a", "grep"));
  h.wd.note(toolCall("a", "grep"));
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "the streak restarted at `read`");

  h.wd.note(toolCall("a", "grep"));
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]]);
});

test("a reset also re-arms the repeat warning for the next streak", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 2 }));

  h.wd.note(toolCall("a", "grep"));
  h.wd.note(toolCall("a", "grep"));
  h.wd.sweep();
  h.wd.note(toolCall("a", "read"));
  h.wd.note(toolCall("a", "read"));
  h.wd.sweep();
  assert.deepEqual(h.warns, [
    ["a", "repeat"],
    ["a", "repeat"],
  ]);
});

test("only tool_call counts toward a repeat streak", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 2 }));

  // `tool_call_update` is progress on a call already counted, not a new one.
  h.wd.note(toolCall("a", "grep", undefined, undefined, "grep-1"));
  h.wd.note(toolUpdate("a", "grep-1"));
  h.wd.note(chunk("a"));
  h.wd.sweep();
  assert.deepEqual(h.warns, []);
});

test("distinct same-title operations do not make a repeat", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));

  h.wd.note(toolCall("a", "Terminal", { command: "python" }, "execute"));
  h.wd.note(toolCall("a", "Terminal", { command: "sed" }, "execute"));
  h.wd.note(toolCall("a", "Terminal", { command: "grep" }, "execute"));
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "the command is part of the identity");
});

test("distinct same-title operations with different kinds or locations do not warn", () => {
  const kinds = harness();
  kinds.wd.watch("a", limits({ stallRepeatCount: 3 }));
  for (const kind of ["read", "search", "execute"] as const) {
    kinds.wd.note({
      agent: "a",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `kind-${kind}`,
        title: "inspect",
        kind,
      },
    });
  }
  kinds.wd.sweep();
  assert.deepEqual(kinds.warns, [], "the kind is part of the identity");

  const places = harness();
  places.wd.watch("a", limits({ stallRepeatCount: 3 }));
  for (const path of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
    places.wd.note({
      agent: "a",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `place-${path}`,
        title: "read",
        kind: "read",
        locations: [{ path }],
      },
    });
  }
  places.wd.sweep();
  assert.deepEqual(places.warns, [], "the location is part of the identity");
});

test("the same command under one title still repeats", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));

  for (let i = 0; i < 3; i++) {
    h.wd.note(toolCall("a", "Terminal", { command: "pytest" }, "execute"));
  }
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]]);
});

test("late rawInput updates refine the operation identity", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));

  for (const [id, command] of [
    ["t1", "python"],
    ["t2", "sed"],
    ["t3", "grep"],
  ] as const) {
    h.wd.note(toolCall("a", "Terminal", undefined, "execute", id));
    h.wd.note(toolUpdate("a", id, { command }, "execute"));
  }
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "the late commands distinguish the calls");
});

test("late updates do not erase a real repeat", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));

  for (const id of ["t1", "t2", "t3"]) {
    h.wd.note(toolCall("a", "Terminal", undefined, "execute", id));
    h.wd.note(toolUpdate("a", id, { command: "pytest" }, "execute"));
  }
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]]);
});

test("a late-refined loop warns once, not once per sweep", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));

  for (let i = 1; i <= 4; i++) {
    const id = `t${i}`;
    h.wd.note(toolCall("a", "Terminal", undefined, "execute", id));
    h.wd.sweep();
    h.wd.note(toolUpdate("a", id, { command: "pytest" }, "execute", "pytest"));
    h.wd.sweep();
  }
  assert.deepEqual(h.warns, [["a", "repeat"]]);
});

test("stallRepeatCount 0 disables the repeat signal", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 0 }));
  for (let i = 0; i < 50; i++) h.wd.note(toolCall("a", "grep"));
  h.wd.sweep();
  assert.deepEqual(h.warns, []);
});

// --- ttl -------------------------------------------------------------------

test("a task past ttlMs is cancelled once", () => {
  const h = harness();
  h.wd.watch("a", limits({ ttlMs: 30_000 }));

  h.advance(29_000);
  h.wd.sweep();
  assert.deepEqual(h.timeouts, []);

  h.advance(2_000);
  h.wd.sweep();
  assert.deepEqual(h.timeouts, ["a"]);

  h.advance(60_000);
  h.wd.sweep();
  assert.deepEqual(h.timeouts, ["a"], "cancelled once, not every sweep");
});

test("events do not extend ttlMs — it is wall time, not idle time", () => {
  const h = harness();
  h.wd.watch("a", limits({ ttlMs: 30_000 }));
  h.advance(20_000);
  h.wd.note(chunk("a"));
  h.advance(20_000);
  h.wd.sweep();
  assert.deepEqual(h.timeouts, ["a"]);
});

test("ttlMs 0 disables the TTL", () => {
  const h = harness();
  h.wd.watch("a", limits({ ttlMs: 0 }));
  h.advance(10_000_000);
  h.wd.sweep();
  assert.deepEqual(h.timeouts, []);
});

// --- the sweep is best-effort ---------------------------------------------

test("one task throwing inside the sweep does not stop the others", () => {
  let clock = 1_000;
  const seen: string[] = [];
  const wd = createWatchdog({
    now: () => clock,
    onWarn: (id) => {
      seen.push(id);
      if (id === "a") throw new Error("a broken consumer");
    },
    onTimeout: (id) => seen.push(`${id}:ttl`),
  });
  wd.watch("a", { stallIdleMs: 10_000, stallRepeatCount: 0, ttlMs: 0 });
  wd.watch("b", { stallIdleMs: 10_000, stallRepeatCount: 0, ttlMs: 0 });
  wd.watch("c", { stallIdleMs: 0, stallRepeatCount: 0, ttlMs: 10_000 });

  clock += 11_000;
  assert.doesNotThrow(() => wd.sweep());
  assert.deepEqual(seen, ["a", "b", "c:ttl"]);
});

// --- lifetime --------------------------------------------------------------

test("a closed task is no longer swept", () => {
  const h = harness();
  const watch = h.wd.watch("a", limits({ stallIdleMs: 10_000 }));
  watch.close();
  h.advance(60_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, []);
});

test("each task is judged by its own limits", () => {
  const h = harness();
  h.wd.watch("quick", limits({ stallIdleMs: 5_000, ttlMs: 0 }));
  h.wd.watch("slow", limits({ stallIdleMs: 500_000, ttlMs: 0 }));

  h.advance(6_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, [["quick", "idle"]]);
});

test("note() only feeds the task the event belongs to", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallIdleMs: 10_000, ttlMs: 0 }));
  h.wd.watch("b", limits({ stallIdleMs: 10_000, ttlMs: 0 }));

  h.advance(6_000);
  h.wd.note(chunk("a"));
  h.advance(6_000);
  h.wd.sweep();
  assert.deepEqual(h.warns, [["b", "idle"]]);
});
