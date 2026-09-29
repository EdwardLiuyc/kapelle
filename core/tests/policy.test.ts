/**
 * M1a-5 acceptance tests — issue #13.
 *
 * The resolver is a pure function, so it is tested as one: a truth table over
 * `task > run > harness > default`, the `maxMode` ceiling, and `safe`'s
 * override of `allowReadOutsideRoot`. Negotiation is tested against a stub
 * agent, because what is under test is *whether we call*, not what the call
 * looks like on the wire — that lives in `protocol/tests/agent.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AcpAgent } from "../../protocol/agent.ts";
import type { AgentEntry } from "../../protocol/registry.ts";
import {
  negotiateMode,
  negotiateSafeMode,
  policyFor,
  READ_ONLY_KINDS,
  resolvePolicy,
  safePolicy,
} from "../policy.ts";

// --- precedence --------------------------------------------------------------

const HARNESS = { name: "h", mode: "safe", maxMode: "auto" } as const;

test("mode resolves task > run > harness > default", () => {
  const cases: [string, Parameters<typeof resolvePolicy>[0], string][] = [
    [
      "task wins over everything",
      { task: { mode: "auto" }, run: { mode: "ask" }, harness: HARNESS },
      "auto",
    ],
    [
      "run wins with no task",
      { run: { mode: "ask" }, harness: HARNESS },
      "ask",
    ],
    ["harness wins with neither", { harness: HARNESS }, "safe"],
    ["default with no layers at all", {}, "ask"],
  ];

  for (const [why, layers, expected] of cases) {
    assert.equal(resolvePolicy(layers).mode, expected, why);
  }
});

test("allowReadOutsideRoot resolves down the same chain", () => {
  const layered = { harness: { ...HARNESS, allowReadOutsideRoot: true } };

  assert.equal(
    resolvePolicy({ ...layered, run: { mode: "auto" } }).allowReadOutsideRoot,
    true,
    "harness value survives when nothing above it asks",
  );
  assert.equal(
    resolvePolicy({
      ...layered,
      run: { mode: "auto", allowReadOutsideRoot: false },
    }).allowReadOutsideRoot,
    false,
    "run overrides the harness",
  );
  assert.equal(
    resolvePolicy({
      ...layered,
      task: { mode: "auto", allowReadOutsideRoot: false },
      run: { allowReadOutsideRoot: true },
    }).allowReadOutsideRoot,
    false,
    "task overrides the run",
  );
  assert.equal(
    resolvePolicy({}).allowReadOutsideRoot,
    false,
    "the default is the contained one",
  );
});

// --- safe's override ---------------------------------------------------------

test("safe forces allowReadOutsideRoot false however it was asked for", () => {
  for (const layers of [
    { task: { mode: "safe" as const, allowReadOutsideRoot: true } },
    { run: { mode: "safe" as const }, task: { allowReadOutsideRoot: true } },
    {
      harness: { ...HARNESS, allowReadOutsideRoot: true },
      run: { mode: "safe" as const },
    },
  ]) {
    const out = resolvePolicy(layers);
    assert.equal(out.mode, "safe");
    assert.equal(out.allowReadOutsideRoot, false);
  }

  // The override is `safe`'s alone — the other modes carry what was asked.
  assert.equal(
    resolvePolicy({ task: { mode: "ask", allowReadOutsideRoot: true } })
      .allowReadOutsideRoot,
    true,
  );
  assert.equal(
    resolvePolicy({ task: { mode: "auto", allowReadOutsideRoot: true } })
      .allowReadOutsideRoot,
    true,
  );
});

// --- the ceiling -------------------------------------------------------------

test("a mode above maxMode is an error naming both values, not a downgrade", () => {
  const harness = { name: "copilot", maxMode: "ask" as const };

  assert.throws(
    () => resolvePolicy({ run: { mode: "auto" }, harness }),
    (err: Error) => {
      assert.match(err.message, /"auto"/, "names what was asked for");
      assert.match(err.message, /"ask"/, "names the ceiling");
      assert.match(err.message, /copilot/, "names the harness");
      return true;
    },
  );

  // At the ceiling and below it, nothing is raised and nothing is rewritten.
  assert.equal(resolvePolicy({ run: { mode: "ask" }, harness }).mode, "ask");
  assert.equal(resolvePolicy({ run: { mode: "safe" }, harness }).mode, "safe");
});

test("an unknown mode is rejected rather than carried", () => {
  // The value arrives from a CLI flag or a JSON run file, so the compiler
  // never saw it. That is the whole reason for a runtime check — and it must
  // test own properties, or Object.prototype names like "toString" slip
  // through and silently run as safe.
  for (const mode of ["yolo", "toString", "constructor"]) {
    assert.throws(
      () => resolvePolicy({ run: { mode: mode as "safe" } }),
      new RegExp(`unknown mode "${mode}"`),
    );
  }
});

// --- policies ----------------------------------------------------------------

test("safe allows exactly the read-only kinds", async () => {
  for (const kind of READ_ONLY_KINDS) {
    assert.equal(
      await safePolicy({
        agent: "a",
        toolCall: { title: "t", kind },
        options: [],
      }),
      true,
      `${kind} is read-only`,
    );
  }
  for (const kind of ["edit", "delete", "move", "execute", "other"] as const) {
    assert.equal(
      await safePolicy({
        agent: "a",
        toolCall: { title: "t", kind },
        options: [],
      }),
      false,
      `${kind} mutates`,
    );
  }
});

test("ask falls back to safe, since a policy cannot invent a TTY", async () => {
  assert.equal(policyFor("ask"), policyFor("safe"));
  assert.equal(
    await policyFor("auto")({
      agent: "a",
      toolCall: { title: "t", kind: "delete" },
      options: [],
    }),
    true,
  );
});

// --- negotiation -------------------------------------------------------------

/** Only `name` and `setMode` are reachable from `negotiateSafeMode`. */
function stubAgent(setMode: (id: string) => Promise<unknown>): {
  agent: AcpAgent;
  calls: string[];
} {
  const calls: string[] = [];
  const agent = {
    name: "stub",
    setMode: (id: string) => {
      calls.push(id);
      return setMode(id);
    },
  } as unknown as AcpAgent;
  return { agent, calls };
}

const MEASURED = {
  launch: { command: "x" },
  measured: { modeMap: { safe: "plan", ask: "build", auto: "build" } },
} as unknown as AgentEntry;

test("safe negotiates; ask and auto do not", async () => {
  const { agent, calls } = stubAgent(async () => ({}));

  assert.equal(await negotiateSafeMode(agent, MEASURED, "safe"), null);
  assert.deepEqual(calls, ["plan"], "the harness-side id, not our mode name");

  assert.equal(await negotiateSafeMode(agent, MEASURED, "ask"), null);
  assert.equal(await negotiateSafeMode(agent, MEASURED, "auto"), null);
  assert.deepEqual(calls, ["plan"], "no id is sent for the other two modes");
});

test("negotiateMode sends safe's id, or ask's for ask and auto, never auto's", async () => {
  const { agent, calls } = stubAgent(async () => ({}));
  const auto = {
    launch: { command: "x" },
    measured: { modeMap: { safe: "plan", ask: "default", auto: "bypass" } },
  } as unknown as AgentEntry;

  for (const mode of ["safe", "ask", "auto"] as const) {
    assert.equal(await negotiateMode(agent, auto, mode), null);
  }
  assert.deepEqual(calls, ["plan", "default", "default"]);
});

test("an unmeasured harness is skipped, loudly, and the run continues", async () => {
  const { agent, calls } = stubAgent(async () => ({}));
  const unmeasured = { launch: { command: "x" } } as AgentEntry;

  const warning = await negotiateSafeMode(agent, unmeasured, "safe");
  assert.match(String(warning), /not negotiated/);
  assert.deepEqual(calls, [], "nothing is guessed at");
});

test("a measured harness with no modeMap is skipped too", async () => {
  const { agent, calls } = stubAgent(async () => ({}));
  const noSafetyModes = {
    launch: { command: "pi-acp" },
    measured: {
      shell: "internal",
      argvChannel: "notification",
      asksPermission: false,
      usage: "absent",
      measuredOn: { version: "0.0.33", date: "2026-09-09" },
    },
  } as AgentEntry;

  const warning = await negotiateSafeMode(agent, noSafetyModes, "safe");
  assert.match(String(warning), /not negotiated/);
  assert.deepEqual(
    calls,
    [],
    "a thinking-effort mode must not be sent as if it were a safety mode",
  );
});

test("a failed set_mode warns rather than killing the run", async () => {
  const { agent } = stubAgent(async () => {
    throw new Error("-32602 invalid modeId");
  });

  const warning = await negotiateSafeMode(agent, MEASURED, "safe");
  assert.match(String(warning), /-32602/, "the harness's own reason survives");
  assert.match(String(warning), /filtering only/);
});
