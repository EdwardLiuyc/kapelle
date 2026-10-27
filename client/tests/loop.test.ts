/**
 * Loop recipes — `client/loop.ts`, story M8-5 (#269): the lookup order, the
 * list, a missing recipe, and the first message's parts. No daemon:
 * `tests/loop-cli.test.ts` starts a loop end to end.
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { userConfigPath } from "../../core/config.ts";
import { listRecipes, loopFolders, loopMessage } from "../loop.ts";

/** A repository folder (a `.git` is enough) with a subfolder, and a config
 *  home, each with the recipes given. */
async function folders(
  t: TestContext,
  repo: Record<string, string>,
  user: Record<string, string>,
) {
  // The real path: the lookup walks it (macOS links /var to /private/var).
  const root = await realpath(await mkdtemp(join(tmpdir(), "kapelle-loop-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const top = join(root, "repo");
  const sub = join(top, "src");
  const home = join(root, "config");
  await mkdir(join(top, ".git"), { recursive: true });
  await mkdir(sub);
  const write = async (dir: string, files: Record<string, string>) => {
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(dir, name), text);
    }
  };
  await write(join(top, ".kapelle", "loops"), repo);
  await write(join(home, "kapelle", "loops"), user);
  return { root, top, sub, env: { XDG_CONFIG_HOME: home } };
}

test("the user folder follows core/config.ts's XDG_CONFIG_HOME rule", () => {
  for (const env of [
    { XDG_CONFIG_HOME: "/x/config" },
    { XDG_CONFIG_HOME: "" },
    { XDG_CONFIG_HOME: "relative" },
    {},
  ]) {
    const user = loopFolders("/", env).at(-1);
    assert.equal(
      user,
      join(dirname(userConfigPath(env)), "loops"),
      env.XDG_CONFIG_HOME,
    );
  }
});

test("the repository's folder comes first, found from a subfolder or a link to one, by the real path; outside a repository only the user's", async (t) => {
  const f = await folders(t, { "fix.md": "repo fix" }, {});
  const user = join(f.env.XDG_CONFIG_HOME, "kapelle", "loops");
  assert.deepEqual(loopFolders(f.sub, f.env), [
    join(f.top, ".kapelle", "loops"),
    user,
  ]);
  assert.deepEqual(loopFolders(f.root, f.env), [user]);

  // A --cwd through a symlink to a subfolder is still inside the repository.
  const link = join(f.root, "src-link");
  await symlink(f.sub, link);
  assert.deepEqual(loopFolders(link, f.env), [
    join(f.top, ".kapelle", "loops"),
    user,
  ]);
  const start = await loopMessage({ recipe: "fix", task: "7" }, link, f.env);
  assert.ok("text" in start && start.text.includes("repo fix"));
  // A link from another repository into this one names this one, as git
  // and the daemon do, not the repository the link sits in.
  const other = join(f.root, "other");
  await mkdir(join(other, ".git"), { recursive: true });
  await symlink(f.sub, join(other, "in"));
  assert.deepEqual(loopFolders(join(other, "in"), f.env), [
    join(f.top, ".kapelle", "loops"),
    user,
  ]);
});

test("the list names each recipe and its folder; for one name the repository's wins", async (t) => {
  const f = await folders(
    t,
    { "fix.md": "repo fix", "notes.txt": "not a recipe" },
    { "fix.md": "user fix", "mine.md": "mine" },
  );
  await mkdir(join(f.top, ".kapelle", "loops", "dir.md"));
  const repo = join(f.top, ".kapelle", "loops");
  const user = join(f.env.XDG_CONFIG_HOME, "kapelle", "loops");
  assert.deepEqual(await listRecipes(f.sub, f.env), [
    { name: "fix", path: join(repo, "fix.md"), wins: true },
    { name: "fix", path: join(user, "fix.md"), wins: false },
    { name: "mine", path: join(user, "mine.md"), wins: true },
  ]);
  // The start reads the one that wins.
  const start = await loopMessage({ recipe: "fix", task: "7" }, f.sub, f.env);
  assert.ok("text" in start && start.text.includes("repo fix"));
  assert.ok(!start.text.includes("user fix"));
  const mine = await loopMessage({ recipe: "mine", task: "7" }, f.sub, f.env);
  assert.ok("text" in mine && mine.text.includes("\nmine\n"));
});

test("a directory named like a recipe neither wins nor hides the user's file", async (t) => {
  const f = await folders(t, {}, { "fix.md": "user fix" });
  const repo = join(f.top, ".kapelle", "loops");
  const user = join(f.env.XDG_CONFIG_HOME, "kapelle", "loops");
  await mkdir(join(repo, "fix.md"));

  assert.deepEqual(await listRecipes(f.sub, f.env), [
    { name: "fix", path: join(user, "fix.md"), wins: true },
  ]);
  const start = await loopMessage({ recipe: "fix", task: "7" }, f.sub, f.env);
  assert.ok("text" in start && start.text.includes("user fix"));
});

test("a link to a recipe file counts by what it points to, and a broken one is skipped", async (t) => {
  const f = await folders(t, {}, { "fix.md": "user fix" });
  const repo = join(f.top, ".kapelle", "loops");
  const user = join(f.env.XDG_CONFIG_HOME, "kapelle", "loops");
  const target = join(f.root, "linked.md");
  await writeFile(target, "linked fix\n");
  await symlink(target, join(repo, "fix.md"));
  assert.deepEqual(await listRecipes(f.sub, f.env), [
    { name: "fix", path: join(repo, "fix.md"), wins: true },
    { name: "fix", path: join(user, "fix.md"), wins: false },
  ]);
  const start = await loopMessage({ recipe: "fix", task: "7" }, f.sub, f.env);
  assert.ok("text" in start && start.text.includes("linked fix"));

  await rm(target);
  assert.deepEqual(await listRecipes(f.sub, f.env), [
    { name: "fix", path: join(user, "fix.md"), wins: true },
  ]);
  const fallback = await loopMessage(
    { recipe: "fix", task: "7" },
    f.sub,
    f.env,
  );
  assert.ok("text" in fallback && fallback.text.includes("user fix"));
});

test("a missing recipe is refused by name, with every folder it looked in", async (t) => {
  const f = await folders(t, {}, {});
  const r = await loopMessage({ recipe: "nope", task: "7" }, f.sub, f.env);
  assert.deepEqual(r, {
    error: `no recipe named nope: looked in ${join(f.top, ".kapelle", "loops")} and ${join(f.env.XDG_CONFIG_HOME, "kapelle", "loops")}`,
  });
  // A name is a file name: no path out of the folder.
  const out = await loopMessage({ recipe: "../x", task: "7" }, f.sub, f.env);
  assert.ok(
    "error" in out && out.error.includes('no "/"'),
    JSON.stringify(out),
  );
});

test("the first message holds the skill, the recipe, the task and the note, in that order", async (t) => {
  const f = await folders(t, { "fix.md": "# fix\n\nthe steps\n" }, {});
  const r = await loopMessage(
    { recipe: "fix", task: "269", note: "skip the bot" },
    f.top,
    f.env,
  );
  assert.ok("text" in r);
  const skillLabel = "[the orchestrator skill]\n";
  const recipeAt = r.text.indexOf("\n\n[the recipe: fix]\n");
  assert.equal(r.text.slice(0, skillLabel.length), skillLabel);
  assert.ok(
    recipeAt > skillLabel.length,
    `the skill part is empty: ${JSON.stringify(r.text.slice(0, 120))}`,
  );
  assert.equal(
    r.text.slice(recipeAt + 2),
    [
      "[the recipe: fix]",
      "# fix\n\nthe steps",
      "",
      "[the task]",
      "269",
      "",
      "[the note]",
      "skip the bot",
    ].join("\n"),
  );
  // No note: no note part.
  const bare = await loopMessage({ recipe: "fix", task: "269" }, f.top, f.env);
  assert.ok("text" in bare && bare.text.endsWith("[the task]\n269"));
});
