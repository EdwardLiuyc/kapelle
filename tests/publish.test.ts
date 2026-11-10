/**
 * The publish workflow (M9-8, #307): a pushed tag must name the version in
 * `package.json`, and a version already on npm is skipped. Both decisions are
 * small shell scripts the workflow calls; these tests run them with a fake npm
 * so a release tag is not the first execution.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { childEnv, REPO, tempDir } from "../integration/helpers.ts";

const WORKFLOW = join(REPO, ".github", "workflows", "publish.yml");
const CHECK_TAG = join(REPO, ".github", "scripts", "check-tag.sh");
const PUBLISH_IF_NEW = join(REPO, ".github", "scripts", "publish-if-new.sh");

async function packageDir(
  t: TestContext,
  pkg: { name: string; version: string },
): Promise<string> {
  const dir = await tempDir(t);
  await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg)}\n`);
  return dir;
}

function runScript(script: string, cwd: string, env: Record<string, string>) {
  const result = spawnSync("bash", [script], {
    cwd,
    env: childEnv(env),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

/** A fake npm that records its argv and exits as the test configures. */
async function fakeNpm(dir: string): Promise<string> {
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  await mkdir(bin);
  const npm = join(bin, "npm");
  await writeFile(
    npm,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$NPM_CALLS"
if [ "$1" = view ]; then
  printf '%s' "$FAKE_VIEW"
  exit "$FAKE_VIEW_STATUS"
fi
if [ "$1" = publish ]; then
  exit 0
fi
exit 2
`,
  );
  await chmod(npm, 0o755);
  return calls;
}

function npmEnv(
  dir: string,
  calls: string,
  view: string,
  status: number,
): Record<string, string> {
  return {
    NPM_CALLS: calls,
    FAKE_VIEW: view,
    FAKE_VIEW_STATUS: String(status),
    PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
}

async function npmCalls(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).trim().split("\n");
}

test("the tag gate accepts a tag that names the package version", async (t) => {
  const dir = await packageDir(t, { name: "kapelle", version: "0.1.0" });
  const result = runScript(CHECK_TAG, dir, { GITHUB_REF_NAME: "v0.1.0" });
  assert.equal(result.status, 0, result.stderr);
});

test("the tag gate refuses a tag that names another version", async (t) => {
  const dir = await packageDir(t, { name: "kapelle", version: "0.1.0" });
  const result = runScript(CHECK_TAG, dir, { GITHUB_REF_NAME: "v0.1.1" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stdout,
    /::error::tag v0\.1\.1, but package\.json is 0\.1\.0/,
  );
});

test("the publish check skips the exact version npm already has", async (t) => {
  const dir = await packageDir(t, { name: "kapelle", version: "0.1.0" });
  const calls = await fakeNpm(dir);
  const result = runScript(PUBLISH_IF_NEW, dir, npmEnv(dir, calls, "0.1.0", 0));
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /::notice::kapelle@0\.1\.0 is on npm already; not published again/,
  );
  assert.deepEqual(await npmCalls(calls), ["view kapelle@0.1.0 version"]);
});

test("the publish check publishes when npm does not have that exact version", async (t) => {
  for (const scenario of [
    { name: "the version is missing", view: "", status: 1 },
    { name: "npm answers another version", view: "0.0.9\n", status: 0 },
  ]) {
    await t.test(scenario.name, async (t) => {
      const dir = await packageDir(t, { name: "kapelle", version: "0.1.0" });
      const calls = await fakeNpm(dir);
      const result = runScript(
        PUBLISH_IF_NEW,
        dir,
        npmEnv(dir, calls, scenario.view, scenario.status),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /on npm already/);
      assert.deepEqual(await npmCalls(calls), [
        "view kapelle@0.1.0 version",
        "publish",
      ]);
    });
  }
});

test("the workflow gates a v* tag and publishes with OIDC and no npm token", async () => {
  const workflow = await readFile(WORKFLOW, "utf8");
  const gateAt = workflow.indexOf("    gate:");
  const publishAt = workflow.indexOf("    publish:");
  assert.notEqual(gateAt, -1);
  assert.notEqual(publishAt, -1);
  const gate = workflow.slice(gateAt, publishAt);
  const publish = workflow.slice(publishAt);

  assert.match(workflow, /tags: \["v\*"\]/);
  assert.match(publish, /needs: gate/);
  assert.match(publish, /id-token: write/);
  assert.doesNotMatch(gate, /id-token: write/);
  assert.match(publish, /contents: read/);
  assert.doesNotMatch(workflow, /\b(NPM_TOKEN|NODE_AUTH_TOKEN)\b/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /--provenance/);

  for (const command of [
    "npm ci",
    "npm run fmt:check",
    "npm run check",
    "npm run test:adaptive",
    "npm run selftest",
    "npm run knip",
    "markdownlint-cli2@0.24.0",
  ]) {
    assert.ok(workflow.includes(command), `missing gate command: ${command}`);
  }
  assert.ok(gate.includes("bash .github/scripts/check-tag.sh"));
  assert.doesNotMatch(gate, /publish-if-new/);
  assert.ok(publish.includes("bash .github/scripts/publish-if-new.sh"));
});

test("the README carries a relative logo and no not-published note", async () => {
  const readme = await readFile(join(REPO, "README.md"), "utf8");
  assert.ok(readme.includes('<img src="assets/icon.svg"'));
  assert.doesNotMatch(readme, /not published yet/i);
});
