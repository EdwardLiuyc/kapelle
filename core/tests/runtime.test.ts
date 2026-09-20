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
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
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

/**
 * A symlinked `XDG_STATE_HOME` base must resolve to the same directory as its
 * realpath, canonically spelled — otherwise `git worktree list --porcelain`
 * (which reports symlink-resolved paths) and `stateDirFor`'s own `<wt>` root
 * disagree, and `core/sweep.ts`'s `managedWorktrees()` treats every managed
 * checkout as unrelated (`relative()` returns `..`). This reproduces the
 * macOS shape without depending on `tmpdir()` being a symlink itself.
 */
test("stateDirFor is canonical even when XDG_STATE_HOME is a symlink", () => {
  // The link lives in its own mkdtemp, so a killed run can never leave a
  // stale path that makes `symlinkSync` throw EEXIST.
  const holder = mkdtempSync(join(realpathSync(tmpdir()), "kapelle-links-"));
  const real = join(holder, "real");
  const link = join(holder, "link");
  mkdirSync(real, { recursive: true, mode: 0o700 });
  symlinkSync(real, link);
  const before = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = link;
  let repo: string | undefined;
  try {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "linked-repo-")));
    const dir = stateDirFor(repo);
    assert.equal(
      dirname(dirname(dir)),
      join(real, "kapelle"),
      "the state dir must sit under the symlink's realpath, not its own spelling",
    );
    assert.ok(
      !dir.startsWith(link),
      "the returned path should not use the unresolved symlink spelling",
    );
  } finally {
    if (before === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = before;
    if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
    rmSync(holder, { recursive: true, force: true });
  }
});

/**
 * A `resolve(root)` keying (rather than `realpathSync(root)`) would give a
 * symlinked repository path and its realpath two different state dirs —
 * splitting one repository's worktrees across two folders.
 */
test("a symlinked repository path resolves to the same state dir as its realpath", () => {
  withStateHome(() => {
    // Its own mkdtemp, like the test above: a pid-named link in the shared
    // temp dir throws EEXIST once a killed run leaves one behind and the pid
    // comes round again — and `symlinkSync` sits before the `try`, so that
    // throw would leak the directory too.
    const holder = mkdtempSync(join(realpathSync(tmpdir()), "kapelle-links-"));
    try {
      const real = join(holder, "repo");
      const link = join(holder, "link");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, link);
      assert.equal(stateDirFor(link), stateDirFor(realpathSync(link)));
    } finally {
      rmSync(holder, { recursive: true, force: true });
    }
  });
});
