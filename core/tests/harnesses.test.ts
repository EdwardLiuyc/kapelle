/**
 * The find (M9-3, #298): each state from a fake `PATH`, the version
 * warning, pi-acp's version from its `package.json`, and the saved file.
 */

import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { fakePath, tempDir } from "../../integration/helpers.ts";
import { describe, findAgents, readSetup, writeSetup } from "../harnesses.ts";

test("the find gives each agent its state from PATH, the agent first", async (t) => {
  const bin = await fakePath(t);
  const found = await findAgents(bin);
  const byId = new Map(
    describe({ checkedAt: "now", done: false, found }).map((a) => [a.id, a]),
  );

  // Its own ACP program, at the measured build: ready, no warning.
  assert.deepEqual(byId.get("opencode"), {
    id: "opencode",
    state: "ready",
    program: "opencode",
    version: "2.0.18",
    acpProgram: "opencode",
    acpVersion: "2.0.18",
  });
  assert.equal(byId.get("kimi")?.state, "ready");
  assert.equal(byId.get("kimi")?.warning, undefined);

  // pi-acp's version is read from its package, never by running it.
  const pi = byId.get("pi");
  assert.equal(pi?.state, "ready");
  assert.equal(pi?.version, "1.3.0");
  assert.equal(pi?.acpVersion, "0.0.33");
  assert.match(
    pi?.warning ?? "",
    /pi-acp 0\.0\.33 is not the build .*0\.0\.34/,
  );
  const pkg = dirname(dirname(realpathSync(join(bin, "pi-acp"))));
  assert.equal(existsSync(join(pkg, "pi-acp.ran")), false);

  // The agent without its ACP program: the command to install it.
  assert.equal(byId.get("claude")?.state, "main_only");
  assert.equal(
    byId.get("claude")?.install,
    "npm i -g @agentclientprotocol/claude-agent-acp",
  );
  // The main program's version is shown, never compared.
  assert.equal(byId.get("claude")?.warning, undefined);

  // An ACP program without its agent, and nothing at all.
  assert.equal(byId.get("codex")?.state, "not_installed");
  assert.equal(byId.get("codex")?.install, undefined);
  assert.equal(byId.get("copilot")?.state, "not_installed");
});

test("the saved find reads back, and a file missing an agent reads as none", async (t) => {
  const home = await tempDir(t);
  const before = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = home;
  t.after(() => {
    if (before === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = before;
  });

  assert.equal(readSetup(), undefined);
  const found = await findAgents(await fakePath(t));
  writeSetup({ checkedAt: "2026-10-22T00:00:00.000Z", done: true, found });
  assert.deepEqual(readSetup(), {
    checkedAt: "2026-10-22T00:00:00.000Z",
    done: true,
    // A version not found is left out of the file.
    found: JSON.parse(JSON.stringify(found)),
  });

  // An agent the registry gained since: the next ask finds again.
  const { kimi: _, ...older } = found;
  writeSetup({ checkedAt: "x", done: true, found: older });
  assert.equal(readSetup(), undefined);

  await writeFile(join(home, "kapelle", "harnesses.json"), "{not json");
  assert.equal(readSetup(), undefined);
});
