import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  gitRepo,
  isolateStateHome,
  scriptedGit,
  tempDir,
} from "../../integration/helpers.ts";
import {
  GitError,
  type GitOptions,
  git,
  gitLine,
  gitWithInput,
  tryGit,
  tryGitLine,
} from "../git.ts";
import { newRoomId } from "../ids.ts";
import { stateDirFor } from "../runtime.ts";
import { roomCheckouts } from "../sweep.ts";

isolateStateHome();

const GIT = { exitCodes: [0], maxBuffer: 1024 * 1024 } satisfies GitOptions;
const DIFF = { exitCodes: [0, 1], maxBuffer: 1024 * 1024 } satisfies GitOptions;

async function rejectedGit(run: () => Promise<unknown>): Promise<GitError> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof GitError);
    return err;
  }
  assert.fail("expected git to reject");
}

test("git keeps raw stdout and GitError carries the exit streams", async (t) => {
  const root = await gitRepo(t);
  await git(root, ["config", "test.raw", "  keep  "], GIT);

  assert.equal(
    await git(root, ["config", "--get", "test.raw"], GIT),
    "  keep  \n",
  );
  assert.equal(
    await gitLine(root, ["config", "--get", "test.raw"], GIT),
    "  keep  ",
  );

  await writeFile(join(root, "a.txt"), "a\n");
  await writeFile(join(root, "b.txt"), "b\n");
  await assert.rejects(
    git(root, ["diff", "--no-index", "a.txt", "b.txt"], GIT),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.exitCode, 1);
      assert.match(err.stdout, /^diff --git /);
      assert.equal(err.stderr, "");
      return true;
    },
  );

  const outside = await tempDir(t);
  await assert.rejects(
    git(outside, ["rev-parse", "--show-toplevel"], GIT),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(typeof err.exitCode, "number");
      assert.equal(err.stdout, "");
      assert.match(err.stderr, /not a git repository/);
      return true;
    },
  );
  assert.equal(
    await tryGit(outside, ["rev-parse", "--show-toplevel"], GIT),
    null,
  );
  assert.equal(
    await tryGitLine(outside, ["rev-parse", "--show-toplevel"], GIT),
    null,
  );
});

test("git accepts exit 1 only for the call that asks for it", async (t) => {
  const root = await gitRepo(t);
  await writeFile(join(root, "a.txt"), "a\n");
  await writeFile(join(root, "b.txt"), "b\n");

  assert.match(
    await git(root, ["diff", "--no-index", "a.txt", "b.txt"], DIFF),
    /^diff --git /,
  );
  await assert.rejects(
    git(root, ["grep", "no-such-pattern"], GIT),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.exitCode, 1);
      assert.equal(err.stdout, "");
      return true;
    },
  );
});

test("git returns output larger than execFile's default buffer", async (t) => {
  const root = await gitRepo(t);
  const big = "x".repeat(1024 * 1024 + 64);
  await writeFile(join(root, "big.txt"), big);
  await git(root, ["add", "big.txt"], GIT);
  await git(root, ["commit", "-m", "big"], GIT);

  const out = await git(root, ["show", "HEAD:big.txt"], {
    ...GIT,
    maxBuffer: big.length + 1024,
  });
  assert.equal(out.length, big.length);
});

test("git and gitWithInput reject a stream past maxBuffer", async (t) => {
  const root = await gitRepo(t);
  const big = "x".repeat(2048);
  await writeFile(join(root, "big.txt"), big);
  await git(root, ["add", "big.txt"], GIT);
  await git(root, ["commit", "-m", "big"], GIT);
  const tiny = { ...GIT, maxBuffer: 16 };

  await assert.rejects(
    git(root, ["show", "HEAD:big.txt"], tiny),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.exitCode, null);
      assert.equal(err.stdout.length, 16);
      assert.match(err.message, /16-byte stdout buffer/);
      return true;
    },
  );
  await assert.rejects(
    gitWithInput(root, ["show", "HEAD:big.txt"], "", tiny),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.exitCode, null);
      assert.equal(err.stdout.length, 16);
      assert.match(err.message, /16-byte stdout buffer/);
      return true;
    },
  );
});

test("git and gitWithInput name the stderr buffer", async (t) => {
  const root = await gitRepo(t);
  const tiny = { ...GIT, maxBuffer: 16 };

  for (const run of [
    () => git(root, ["worktree", "list", "--bogus"], tiny),
    () => gitWithInput(root, ["worktree", "list", "--bogus"], "", tiny),
  ]) {
    await assert.rejects(run(), (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.exitCode, null);
      assert.match(err.message, /16-byte stderr buffer/);
      return true;
    });
  }
});

test("both helpers require exit 0 to be accepted", async (t) => {
  const root = await gitRepo(t);
  const noSuccess = { ...GIT, exitCodes: [1] };

  for (const run of [
    () => git(root, ["rev-parse", "HEAD"], noSuccess),
    () => gitWithInput(root, ["rev-parse", "HEAD"], "", noSuccess),
  ]) {
    const err = await rejectedGit(run);
    assert.equal(err.exitCode, 0);
    assert.match(err.stdout, /^[0-9a-f]{40}\n$/);
  }
});

test("an unaccepted exit 0 carries the same stderr from both helpers", async (t) => {
  const root = await gitRepo(t);
  await scriptedGit(
    t,
    () => `
if [ "$1" = "diagnostic" ]; then
  printf '%s\\n' "out"
  printf '%s\\n' "err" >&2
  exit 0
fi
`,
  );
  const noSuccess = { ...GIT, exitCodes: [1] };
  const fromGit = await rejectedGit(() => git(root, ["diagnostic"], noSuccess));
  const fromInput = await rejectedGit(() =>
    gitWithInput(root, ["diagnostic"], "", noSuccess),
  );

  for (const err of [fromGit, fromInput]) {
    assert.equal(err.exitCode, 0);
    assert.equal(err.stdout, "out\n");
    assert.equal(err.stderr, "err\n");
    assert.equal(err.message, fromGit.message);
    assert.equal(err.callerError, true);
  }
});

test("tryGit does not swallow an unaccepted-success caller error", async (t) => {
  const root = await gitRepo(t);
  await scriptedGit(
    t,
    () => `
if [ "$1" = "diagnostic" ]; then
  printf '%s\\n' "out"
  printf '%s\\n' "err" >&2
  exit 0
fi
`,
  );
  const noSuccess = { ...GIT, exitCodes: [1] };

  for (const run of [
    () => tryGit(root, ["diagnostic"], noSuccess),
    () => tryGitLine(root, ["diagnostic"], noSuccess),
  ]) {
    const err = await rejectedGit(run);
    assert.equal(err.callerError, true);
    assert.equal(err.stderr, "err\n");
  }
});

test("gitWithInput keeps a multibyte overflow prefix valid", async (t) => {
  const root = await gitRepo(t);
  await scriptedGit(
    t,
    () => `
if [ "$1" = "unicode" ]; then
  printf '\\303\\251x\\n'
  exit 0
fi
`,
  );

  const narrow = await rejectedGit(() =>
    gitWithInput(root, ["unicode"], "", { ...GIT, maxBuffer: 1 }),
  );
  assert.equal(narrow.stdout, "");
  assert.equal(narrow.stdout.includes("\uFFFD"), false);

  const partial = await rejectedGit(() =>
    gitWithInput(root, ["unicode"], "", { ...GIT, maxBuffer: 2 }),
  );
  assert.equal(partial.stdout, "é");
  assert.equal(partial.stdout.includes("\uFFFD"), false);

  assert.equal(
    await gitWithInput(root, ["unicode"], "", { ...GIT, maxBuffer: 4 }),
    "éx\n",
  );
});

test("gitWithInput sends stdin and keeps the raw answer", async (t) => {
  const root = await gitRepo(t);

  assert.match(
    await gitWithInput(root, ["hash-object", "--stdin"], "hello\n", GIT),
    /^[0-9a-f]{40}\n$/,
  );
});

test("gitWithInput refuses an exit it does not accept, with both streams", async (t) => {
  const root = await gitRepo(t);
  await writeFile(join(root, "a.txt"), "a\n");
  await writeFile(join(root, "b.txt"), "b\n");

  await assert.rejects(
    gitWithInput(root, ["diff", "--no-index", "a.txt", "b.txt"], "", GIT),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.exitCode, 1);
      assert.match(err.stdout, /^diff --git /);
      assert.equal(err.stderr, "");
      return true;
    },
  );
});

test("worktree listing keeps newline, spaces and non-ASCII paths", async (t) => {
  const root = await gitRepo(t);
  const roomId = newRoomId();
  const base = join(stateDirFor(root), "wt", roomId);
  const paths = [
    join(base, "line\nbreak"),
    join(base, "café folder"),
    join(base, " leading and trailing "),
  ];
  await mkdir(base, { recursive: true });
  for (const path of paths) {
    await git(root, ["worktree", "add", "--detach", path, "HEAD"], GIT);
  }

  assert.deepEqual(
    (await roomCheckouts(root, roomId)).toSorted(),
    paths.toSorted(),
  );
});

test("worktree reconciliation fails closed when git lacks -z", async (t) => {
  const root = await gitRepo(t);
  const roomId = newRoomId();
  await mkdir(join(stateDirFor(root), "wt", roomId), { recursive: true });
  const log = join(await tempDir(t), "calls");
  await scriptedGit(
    t,
    () => `
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ "$3" = "--porcelain" ] && [ "$4" = "-z" ]; then
  printf '%s\\n' "error: unknown option 'z'" >&2
  exit 129
fi
`,
  );

  await assert.rejects(roomCheckouts(root, roomId), /Git 2\.36 or newer/);
  const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  assert.ok(calls.includes("worktree list --porcelain -z"));
  assert.ok(!calls.includes("worktree prune"));
});

test("a non-repository does not read as an old-git refusal", async (t) => {
  const root = await tempDir(t);
  const roomId = newRoomId();
  await mkdir(join(stateDirFor(root), "wt", roomId), { recursive: true });

  await assert.rejects(roomCheckouts(root, roomId), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.exitCode, 128);
    assert.doesNotMatch(err.message, /Git 2\.36/);
    assert.match(err.stderr, /not a git repository/);
    return true;
  });
});

test("only core/git.ts starts git", async () => {
  const startsGit = (source: string): boolean =>
    /\b(?:run|execFile|execFileSync|spawn|spawnSync|exec|execSync)\s*\(\s*["']git["']/.test(
      source,
    );
  const core = join(import.meta.dirname, "..");
  for (const entry of await readdir(core, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name === "git.ts") continue;
    assert.equal(
      startsGit(await readFile(join(core, entry.name), "utf8")),
      false,
      `${entry.name} starts git directly`,
    );
  }
  assert.equal(startsGit('await run("git", [])'), true);
  assert.equal(startsGit('await run("ps", [])'), false);
});
