/**
 * `stateDirFor` — issue #129.
 *
 * Supervisor state used to live at `<repo>/.kapelle/`, which cost every
 * repository a `.gitignore` edit before its first run. It now hangs off the
 * state directory instead, keyed on the repository's path.
 *
 * Three properties are worth proving and none of them is visible in the
 * `join` call. The folder is **readable**, because the operator reads a failed
 * task's checkout by eye. It is **unique**, because `~/src/api` and
 * `~/work/api` are both called `api` and sharing a folder would put one run's
 * worktrees in the other's sweep. And it is **stable for a path that no longer
 * exists**, because that is exactly the case `core/sweep.ts` has to report on:
 * a repository the operator moved or deleted.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { stateDirFor } from "../runtime.ts";

/** A private `XDG_STATE_HOME`, so a test never meets the developer's own. */
function withStateHome<T>(fn: (home: string) => T): T {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kapelle-state-")));
  const before = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = home;
  try {
    return fn(home);
  } finally {
    if (before === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = before;
  }
}

test("a repository's state dir is named for the repository, under repos/", () => {
  withStateHome((home) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "myproject-")));
    const dir = stateDirFor(repo);

    assert.equal(dirname(dir), join(home, "kapelle", "repos"));
    assert.ok(
      basename(dir).startsWith(`${basename(repo)}-`),
      `${basename(dir)} should be named for ${basename(repo)}`,
    );
  });
});

test("two repositories with the same folder name do not collide", () => {
  withStateHome(() => {
    const parentA = mkdtempSync(join(tmpdir(), "kapelle-a-"));
    const parentB = mkdtempSync(join(tmpdir(), "kapelle-b-"));
    const a = stateDirFor(join(parentA, "api"));
    const b = stateDirFor(join(parentB, "api"));

    assert.notEqual(a, b);
    assert.equal(basename(a).split("-")[0], "api");
    assert.equal(basename(b).split("-")[0], "api");
  });
});

test("the same repository always resolves to the same state dir", () => {
  withStateHome(() => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "stable-")));
    assert.equal(stateDirFor(repo), stateDirFor(repo));
  });
});

test("a repository that no longer exists still resolves — sweep reports on it", () => {
  withStateHome(() => {
    // The path is never created. `core/sweep.ts` asks for the state dir of a
    // `repos.json` entry whose repository the operator has moved or deleted,
    // and a throw there would refuse the boot over debris.
    const gone = join(realpathSync(tmpdir()), "kapelle-deleted-repo");
    assert.equal(stateDirFor(gone), stateDirFor(gone));
    assert.equal(basename(stateDirFor(gone)).split("-")[0], "kapelle");
  });
});
