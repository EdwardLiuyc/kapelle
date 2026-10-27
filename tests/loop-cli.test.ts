/**
 * `kapelle loop` (M8-5, #269), driven as a real subprocess on a pipe against
 * a daemon with mock agents: the room, its orchestrator and its first
 * message, `--agent`, a missing recipe and `list`. The lookup order and the
 * message's exact text are in `client/tests/loop.test.ts`; `/loop` in the
 * screens is in `tests/chat-piped.test.ts` and `tests/chat-tui-forms.test.ts`.
 *
 * Each test gets its own `XDG_CONFIG_HOME`, so the developer's own recipes
 * never show.
 */

import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RoomDto, RoomListEntry } from "../client/contract.ts";
import {
  addRepo,
  daemonApi as api,
  bootDaemon,
  gitRepo,
  REMEMBER,
  roomLog,
  spawnCli,
  tempDir,
} from "../integration/helpers.ts";

/** A daemon, a repository with the `fix` recipe, and an empty config home. */
async function fixture(t: TestContext) {
  const runtime = await tempDir(t);
  const d = await bootDaemon(t, runtime);
  const repo = await addRepo(
    d,
    // The real path: the lookup walks it (macOS links /var to /private/var).
    await realpath(
      await gitRepo(t, {
        files: { ".kapelle/loops/fix.md": "# fix\n\nsteps\n" },
      }),
    ),
  );
  const config = await realpath(await tempDir(t));
  const loop = (args: string[]) =>
    spawnCli(t, ["loop", ...args, "--cwd", repo], "cli.ts", {
      XDG_RUNTIME_DIR: runtime,
      XDG_CONFIG_HOME: config,
    }).done;
  return { d, repo, config, loop };
}

test("kapelle loop opens <recipe>-<task> with po in auto, and sends it the skill, the recipe, the task and the note", async (t) => {
  const { d, repo, loop } = await fixture(t);
  const r = await loop(["fix", "7", "a note", "--cmd", REMEMBER]);
  assert.equal(r.code, 0, r.stderr);
  const id = /attach with: kapelle chat attach (\S+)/.exec(r.stdout)?.[1];
  assert.ok(id, r.stdout);
  assert.match(r.stdout, /opened room fix-7; po has the start/);

  const room = (await api<RoomDto>(d, "GET", `/rooms/${id}`)).body;
  assert.equal(room.title, "fix-7");
  assert.deepEqual(
    room.participants.map((p) => [p.name, p.role, p.mode]),
    [["po", "orchestrator", "auto"]],
  );

  const readLog = async () => {
    try {
      return await roomLog(repo, id);
    } catch {
      return []; // the room may not have written its log yet
    }
  };
  let text = "";
  for (const until = Date.now() + 20_000; !text; ) {
    assert.ok(Date.now() < until, "the first message never reached the log");
    const lines = await readLog();
    const first = lines.find(
      (l) => l.update.sessionUpdate === "_client_user_message",
    );
    text = (first?.update.text as string | undefined) ?? "";
    if (!text) await new Promise((ok) => setTimeout(ok, 50));
  }
  const skillLabel = "[the orchestrator skill]\n";
  assert.equal(text.slice(0, skillLabel.length), skillLabel);
  const at = [
    "[the recipe: fix]",
    "# fix\n\nsteps",
    "[the task]\n7",
    "[the note]\na note",
  ].map((part) => text.indexOf(part));
  const recipeAt = at[0];
  assert.ok(
    recipeAt !== undefined && recipeAt > skillLabel.length,
    `the skill part is empty: ${JSON.stringify(text.slice(0, 120))}`,
  );
  assert.ok(
    at.every((i, n) => i >= 0 && (n === 0 || i > (at[n - 1] as number))),
    `the parts in order: ${at}`,
  );
});

test("kapelle loop --agent names the orchestrator's harness", async (t) => {
  const { d, loop } = await fixture(t);
  const r = await loop(["fix", "7", "--agent", "nosuch"]);
  assert.equal(r.code, 1);
  // The daemon's refusal: the value reached it as typed.
  assert.match(r.stderr, /unknown agent "nosuch".*\(invalid_request\)/);
  const rooms = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.deepEqual(rooms.body, [], "no room");
});

test("kapelle loop refuses an empty task and opens no room", async (t) => {
  const { d, loop } = await fixture(t);
  const r = await loop(["fix", "   ", "--cmd", REMEMBER]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: kapelle loop/);
  const rooms = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.deepEqual(rooms.body, [], "no room");
});

test("a missing recipe exits 1, names both folders, and opens no room", async (t) => {
  const { d, repo, config, loop } = await fixture(t);
  const r = await loop(["nope", "7", "--cmd", REMEMBER]);
  assert.equal(r.code, 1);
  assert.equal(
    r.stderr.trim(),
    `error: no recipe named nope: looked in ${join(repo, ".kapelle", "loops")} and ${join(config, "kapelle", "loops")} (no_recipe)`,
  );
  const rooms = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.deepEqual(rooms.body, [], "no room");
});

test("kapelle loop list names each recipe, its folder, and which one wins", async (t) => {
  const { repo, config, loop } = await fixture(t);
  const user = join(config, "kapelle", "loops");
  await mkdir(user, { recursive: true });
  await writeFile(join(user, "fix.md"), "mine\n");
  await writeFile(join(user, "solo.md"), "solo\n");
  const r = await loop(["list"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [
    `fix  ${join(repo, ".kapelle", "loops", "fix.md")}`,
    `fix  ${join(user, "fix.md")}  (hidden: the one above wins)`,
    `solo  ${join(user, "solo.md")}`,
  ]);
  const usage = await loop(["list", "one", "two", "three"]);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /usage: kapelle loop/);
});

test("kapelle loop starts a recipe named list when a task follows", async (t) => {
  const { d, repo, loop } = await fixture(t);
  await writeFile(
    join(repo, ".kapelle", "loops", "list.md"),
    "the list recipe\n",
  );
  const r = await loop(["list", "7", "--cmd", REMEMBER]);
  assert.equal(r.code, 0, r.stderr);
  const rooms = await api<RoomListEntry[]>(d, "GET", "/rooms");
  assert.ok(
    rooms.body.some((room) => room.title === "list-7"),
    JSON.stringify(rooms.body),
  );
});
