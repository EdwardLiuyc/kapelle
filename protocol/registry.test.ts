/**
 * M1a-4 — the registry's measured half, and the env resolution it inherits.
 *
 * These are pure-function tests in the sense M1a-1 ratified: no subprocess,
 * no wire. The subject is the conservative-claim rule (an unverified harness
 * must not read as a contained one) and the two env properties that the M0-2
 * port and M2-8's secret strip pull in opposite directions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENTS,
  type AgentEntry,
  printableWarnings,
  resolveAgent,
  resolveEnv,
  warningsFor,
} from "./registry.ts";

/** A measured entry that asks permission and reports argv — silent in `auto`. */
const contained: AgentEntry = {
  launch: { command: "fake", args: [] },
  measured: {
    shell: "internal",
    argvChannel: "permission",
    asksPermission: true,
    modeMap: { safe: "plan", ask: "default", auto: "auto" },
    usage: "per-turn",
    measuredOn: { version: "1.0.0", date: "2026-08-21" },
  },
};

test("an unverified entry says so, in every mode", () => {
  const unverified: AgentEntry = { launch: { command: "fake", args: [] } };
  for (const mode of ["safe", "ask", "auto"] as const) {
    const lines = warningsFor("pi", unverified, mode);
    assert.ok(
      lines.some(
        (l) => l.kind === "unverified" && l.text.includes("no measured labels"),
      ),
      `expected the unverified notice in ${mode}, got ${JSON.stringify(lines)}`,
    );
  }
});

test("an unverified entry reads as internal/none, not as contained", () => {
  const unverified: AgentEntry = { launch: { command: "fake", args: [] } };
  const line = warningsFor("pi", unverified, "safe")
    .map((w) => w.text)
    .join("\n");
  // The conservative claim, not the optimistic one: an unmeasured harness reads
  // as the least-contained measured one — internal / none / never-asks.
  assert.ok(line.includes("commands run inside it"), "assumes internal");
  assert.ok(line.includes("never see the argv"), "assumes none");
  assert.ok(line.includes("no jurisdiction"), "assumes never-asks");
});

test("a harness that never asks permission warns even in auto", () => {
  const lines = warningsFor("opencode", AGENTS.opencode, "auto");
  assert.ok(
    lines.some(
      (l) =>
        l.kind === "containment" && l.text.includes("never asks permission"),
    ),
    `expected the no-jurisdiction warning in auto, got ${JSON.stringify(lines)}`,
  );
});

test("a harness that does ask permission stays quiet in auto", () => {
  assert.deepEqual(warningsFor("fake", contained, "auto"), []);
});

test("measuredOn warns when the live version differs", () => {
  const lines = warningsFor("fake", contained, "auto", "1.0.1");
  assert.ok(
    lines.some(
      (l) =>
        l.kind === "version" &&
        l.text.includes("1.0.0") &&
        l.text.includes("1.0.1"),
    ),
    `expected a staleness warning naming both builds, got ${JSON.stringify(lines)}`,
  );
});

test("measuredOn stays silent when the harness sends no version", () => {
  assert.deepEqual(warningsFor("fake", contained, "auto", undefined), []);
});

test("copilot's mode ids are the full canonical URLs, not the bare fragment", () => {
  // The bare `#plan` fragment returns -32602 (docs/M0-FINDINGS.md:63).
  for (const id of Object.values(AGENTS.copilot.measured?.modeMap ?? {})) {
    assert.ok(
      id.startsWith("https://"),
      `copilot mode id ${JSON.stringify(id)} must be a full URL`,
    );
  }
});

test("resolveEnv returns the base by identity when there is nothing to do", () => {
  const base = { PATH: "/usr/bin" };
  assert.equal(resolveEnv(undefined, base), base);
});

test("resolveEnv strips AGENT_TEAM_* even when the entry declares no env", () => {
  const base = { PATH: "/usr/bin", AGENT_TEAM_TOKEN: "secret" };
  const env = resolveEnv(undefined, base);
  assert.equal(env.AGENT_TEAM_TOKEN, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(base.AGENT_TEAM_TOKEN, "secret", "the base must not be mutated");
});

test("resolveEnv still applies an entry's own unset and set", () => {
  const base = { PATH: "/usr/bin", CLAUDECODE: "1" };
  const env = resolveEnv({ unset: ["CLAUDECODE"], set: { X: "1" } }, base);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.X, "1");
});

test("resolveAgent returns a known entry, id as the name", () => {
  const spec = resolveAgent("copilot");
  assert.equal(spec.name, "copilot");
  assert.equal(spec.launch.command, "copilot");
  assert.deepEqual(spec.launch.args, ["--acp"]);
  assert.equal(spec.measured?.asksPermission, true);
});

test("resolveAgent throws on an unknown id, and names the known ones", () => {
  assert.throws(
    () => resolveAgent("nope"),
    (err: Error) =>
      err.message.includes('unknown agent "nope"') &&
      err.message.includes("copilot"),
  );
});

test("a --cmd spec reads past the runtime for its label", () => {
  const spec = resolveAgent("opencode", "node mock-agent.mjs");
  assert.equal(spec.name, "mock-agent");
  assert.equal(spec.launch.command, "node");
  assert.deepEqual(spec.launch.args, ["mock-agent.mjs"]);
});

test("a padded --cmd resolves the same as an unpadded one", () => {
  // A shell strips this; a cmd read out of a JSON run file does not, and the
  // leading empty split element used to become the spawned command.
  const padded = resolveAgent("opencode", "  node mock-agent.mjs  ");
  assert.deepEqual(padded, resolveAgent("opencode", "node mock-agent.mjs"));
  assert.equal(padded.launch.command, "node");
});

test("a --cmd spec has no measured half, so it warns as unverified", () => {
  // --cmd overrides the id: nothing about `copilot` may leak into the spec.
  const spec = resolveAgent("copilot", "some-harness --acp");
  assert.equal(spec.name, "some-harness");
  assert.equal(spec.measured, undefined);
  assert.ok(
    warningsFor(spec.name, spec, "auto").some((l) =>
      l.text.includes("no measured labels"),
    ),
  );
});

test("--quiet drops the advisory lines and never the containment one", () => {
  // The #13 rule, asserted on a run that produces both at once: opencode never
  // asks permission (containment) and is reported on a build we did not
  // measure (version). An inversion or removal of the filter fails here.
  const both = warningsFor(
    "opencode",
    AGENTS.opencode,
    "safe",
    "0.0.0-not-the-measured-build",
  );
  assert.deepEqual(
    both.map((w) => w.kind),
    ["containment", "version"],
    "the fixture must produce one of each for this test to mean anything",
  );

  assert.deepEqual(
    printableWarnings(both, true).map((w) => w.kind),
    ["containment"],
    "quiet keeps containment and nothing else",
  );
  assert.deepEqual(
    printableWarnings(both, false),
    both,
    "without --quiet every line prints",
  );

  // A run with no containment line prints nothing at all when quieted — the
  // `--cmd` case the selftest exercises.
  const advisoryOnly = warningsFor(
    "mock-agent",
    { launch: { command: "x", args: [] } },
    "auto",
  );
  assert.deepEqual(
    advisoryOnly.map((w) => w.kind),
    ["unverified"],
  );
  assert.deepEqual(printableWarnings(advisoryOnly, true), []);
});
