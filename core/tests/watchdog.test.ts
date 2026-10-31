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
  const texts: string[] = [];
  const resolves: string[] = [];
  const timeouts: string[] = [];
  const wd = createWatchdog({
    now: () => clock,
    onWarn: (id, kind, text) => {
      warns.push([id, kind]);
      texts.push(text);
    },
    onResolve: (id) => resolves.push(id),
    onTimeout: (id) => timeouts.push(id),
  });
  /** A call's `tool_call`, as claude and opencode send it: a generic title
   *  and no input (§M0-3, #240). */
  const call = (agent: string, id: string, title = "Terminal") =>
    wd.note({
      agent,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title,
        kind: "execute",
        rawInput: {},
      },
    });
  /** Its first update, with the command as the title and the input. */
  const update = (agent: string, id: string, command: string) =>
    wd.note({
      agent,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        title: command,
        rawInput: { command },
      },
    });
  let ids = 0;
  /** One whole operation: the call, then its first update. */
  const op = (agent: string, command: string) => {
    ids += 1;
    call(agent, `call-${ids}`);
    update(agent, `call-${ids}`, command);
  };
  return {
    wd,
    warns,
    texts,
    resolves,
    timeouts,
    call,
    update,
    op,
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

  h.op("a", "npm test");
  h.op("a", "npm test");
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "two is under the threshold");

  h.op("a", "npm test");
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]]);
  // It names the real command, not the generic first title.
  assert.match(h.texts[0], /^3× "npm test" in a row/);

  h.op("a", "npm test");
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]], "still the same streak");
});

test("eight distinct commands under one generic title do not warn (#354)", () => {
  // claude's shape: every shell call is `Terminal` until its update.
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));
  for (const c of ["ls", "grep x", "sed -n 1p f", "npm test", "biome", "tsc"]) {
    h.op("a", c);
  }
  h.wd.sweep();
  assert.deepEqual(h.warns, []);
});

test("eight reads of different files do not warn (#354)", () => {
  // pi's shape: the title stays `read`; the path tells the reads apart.
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));
  for (let i = 0; i < 8; i++) {
    const path = `/w/file${i}.ts`;
    h.wd.note({
      agent: "a",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `r${i}`,
        title: "read",
        kind: "read",
        rawInput: { path },
        locations: [{ path }],
      },
    });
    h.wd.note({
      agent: "a",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: `r${i}`,
        status: "completed",
      },
    });
  }
  h.wd.sweep();
  assert.deepEqual(h.warns, []);
});

test("the same command with another kind, location or line is another operation", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 2 }));
  h.op("a", "x");
  h.wd.note({
    agent: "a",
    update: { sessionUpdate: "tool_call", toolCallId: "k", title: "x" },
  });
  h.update("a", "k", "x");
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "a call with no kind differs from `execute`");

  const located = (id: string, line: number) => {
    h.call("a", id);
    h.wd.note({
      agent: "a",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        title: "x",
        rawInput: { command: "x" },
        locations: [{ path: "/w/a", line }],
      },
    });
  };
  located("l1", 1);
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "a location makes it another operation");
  located("l2", 2);
  h.wd.sweep();
  assert.deepEqual(
    h.warns,
    [],
    "the same path at another line is another operation",
  );
  located("l3", 2);
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]]);
});

test("the whole rawInput is compared by value, not by key order (#354)", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 2 }));
  const supplied = (id: string, rawInput: Record<string, unknown>) => {
    h.call("a", id);
    h.wd.note({
      agent: "a",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        title: "shell",
        rawInput,
      },
    });
  };
  supplied("o1", { command: "npm test", cwd: "/w" });
  supplied("o2", { cwd: "/w", command: "npm test" });
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]]);
});

test("a different operation resets the repeat counter", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));

  h.op("a", "grep");
  h.op("a", "grep");
  h.op("a", "read");
  h.op("a", "grep");
  h.op("a", "grep");
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "the streak restarted at `read`");

  h.op("a", "grep");
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]]);
});

test("a reset also re-arms the repeat warning for the next streak", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 2 }));

  h.op("a", "grep");
  h.op("a", "grep");
  h.wd.sweep();
  h.op("a", "read");
  h.op("a", "read");
  h.wd.sweep();
  assert.deepEqual(h.warns, [
    ["a", "repeat"],
    ["a", "repeat"],
  ]);
});

test("a call counts once, at its first update", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 2 }));

  // A `tool_call` alone has no identity yet, so it does not count.
  h.call("a", "c1");
  h.call("a", "c2");
  h.wd.sweep();
  assert.deepEqual(h.warns, []);

  // Later updates are progress on a call already counted.
  h.update("a", "c1", "npm test");
  h.update("a", "c1", "npm test");
  h.wd.note(chunk("a"));
  h.wd.sweep();
  assert.deepEqual(h.warns, []);

  h.update("a", "c2", "npm test");
  h.wd.sweep();
  assert.deepEqual(h.warns, [["a", "repeat"]]);
});

test("a batch of calls before their updates warns once for one loop (#354)", () => {
  // pi's shape: several calls, then their updates.
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));
  for (let i = 0; i < 6; i++) h.call("a", `b${i}`);
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "nothing counted before an update");
  for (let i = 0; i < 6; i++) {
    h.update("a", `b${i}`, "npm test");
    h.wd.sweep();
  }
  assert.deepEqual(h.warns, [["a", "repeat"]]);
});

test("a batch of distinct calls does not warn (#354)", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 3 }));
  for (let i = 0; i < 6; i++) h.call("a", `b${i}`);
  for (let i = 0; i < 6; i++) h.update("a", `b${i}`, `step ${i}`);
  h.wd.sweep();
  assert.deepEqual(h.warns, []);
});

test("another operation after a repeat warning resolves it, once (#354)", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 2 }));
  h.wd.watch("b", limits({ stallRepeatCount: 2 }));

  h.op("a", "lint");
  assert.deepEqual(h.resolves, [], "no warning, nothing to resolve");
  h.op("a", "npm test");
  h.op("a", "npm test");
  h.wd.sweep();
  h.op("a", "npm test");
  // A generic `tool_call` is not yet another operation.
  h.call("a", "next");
  h.op("b", "other");
  assert.deepEqual(h.resolves, [], "the loop and another task go on");

  h.update("a", "next", "biome");
  assert.deepEqual(h.resolves, ["a"]);
  h.op("a", "tsc");
  assert.deepEqual(h.resolves, ["a"], "resolved once");
});

test("stallRepeatCount 0 disables the repeat signal", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 0 }));
  for (let i = 0; i < 50; i++) h.op("a", "grep");
  h.wd.sweep();
  assert.deepEqual(h.warns, []);
});

test("calls that never get an update are dropped past a cap", () => {
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 2 }));
  h.call("a", "lost");
  for (let i = 0; i < 64; i++) h.call("a", `x${i}`);
  h.update("a", "lost", "npm test");
  h.op("a", "npm test");
  h.wd.sweep();
  assert.deepEqual(h.warns, [], "the oldest waiting call was dropped");
});

test("a dropped call restarts the streak, so a hole cannot make a loop (#354)", () => {
  // Counted `npm test`, then a different call that is dropped before its
  // update: the two `npm test` runs were not in a row.
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 2 }));
  h.op("a", "npm test");
  h.call("a", "dropped");
  for (let i = 0; i < 64; i++) h.call("a", `x${i}`);
  h.op("a", "npm test");
  h.wd.sweep();
  assert.deepEqual(h.warns, []);
});

test("a pi-style batch as large as the cap still warns (#354)", () => {
  // pi's reads carry their identity on the `tool_call`, and each update only
  // a status. At most 6 calls waited at once in our logs; a full cap of them
  // must still count, and eight identical reads warn once.
  const h = harness();
  h.wd.watch("a", limits({ stallRepeatCount: 8 }));
  const total = 64;
  for (let i = 0; i < total; i++) {
    const path = i < 8 ? "/w/loop.ts" : `/w/other-${i}.ts`;
    h.wd.note({
      agent: "a",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `p${i}`,
        title: "read",
        kind: "read",
        rawInput: { path },
        locations: [{ path }],
      },
    });
  }
  for (let i = 0; i < total; i++) {
    h.wd.note({
      agent: "a",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: `p${i}`,
        status: "completed",
      },
    });
    h.wd.sweep();
  }
  assert.deepEqual(h.warns, [["a", "repeat"]]);
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
