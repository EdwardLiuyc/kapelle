/**
 * Loop recipes (M8-5): where `kapelle loop` and `/loop` find one, and the
 * orchestrator's first message.
 *
 * A recipe is a Markdown file the person writes (D10). **No kapelle code reads
 * it**: this file finds it and pastes it, whole, into the first message,
 * after the orchestrator skill (`assets/orchestrator.md`) and before the task
 * and the note (D12). The skill is pasted, not named by its path: in run 3 a
 * path into another checkout led the orchestrator to `cd` there
 * (`docs/ORCHESTRATOR-SPIKES.md`).
 *
 * Two folders, and for one name the first wins: `<repo>/.kapelle/loops/`,
 * then `$XDG_CONFIG_HOME/kapelle/loops/`. The repository is the nearest
 * folder at or above the given one that holds a `.git`: a folder in a main
 * checkout, a file in a worktree. It is found on disk, with no git
 * subprocess. The `XDG_CONFIG_HOME` rule is a copy of `userConfigPath`'s
 * (`core/config.ts`), because `client/` never imports `core/`;
 * `client/tests/loop.test.ts` checks that they agree.
 *
 * It reads the local disk, as `client/folder.ts` does: the daemon listens on
 * loopback only, so the screen and the daemon share it.
 */

import { type Dirent, existsSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const SKILL = join(import.meta.dirname, "..", "assets", "orchestrator.md");

/** The nearest folder at or above `path` with a `.git`, or none. */
function gitTopAt(path: string): string | undefined {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The nearest folder at or above `cwd` with a `.git`, or none. A symlink to
 *  a folder inside a repository can hide the marker from the lexical walk, so
 *  retry on the real path. */
function gitTop(cwd: string): string | undefined {
  const direct = gitTopAt(cwd);
  if (direct) return direct;
  try {
    const real = realpathSync(cwd);
    return real === cwd ? undefined : gitTopAt(real);
  } catch {
    return undefined;
  }
}

/** The folders a recipe is looked for in, the one that wins first. Outside
 *  a repository, only the person's own. */
export function loopFolders(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // An empty or relative `XDG_CONFIG_HOME` means unset (`core/config.ts`).
  const configured = env.XDG_CONFIG_HOME;
  const base =
    configured && isAbsolute(configured)
      ? configured
      : join(homedir(), ".config");
  const top = gitTop(cwd);
  return [
    ...(top ? [join(top, ".kapelle", "loops")] : []),
    join(base, "kapelle", "loops"),
  ];
}

/** One recipe file. `wins` is false when one of the same name in an earlier
 *  folder is the one a start uses. */
export interface Recipe {
  name: string;
  path: string;
  wins: boolean;
}

/** Every regular recipe file in the folders, by name; for one name, the
 *  winner first. */
export async function listRecipes(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Recipe[]> {
  const found: Recipe[] = [];
  const seen = new Set<string>();
  for (const folder of loopFolders(cwd, env)) {
    let entries: Dirent[];
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.name.endsWith(".md")) continue;
      const path = join(folder, e.name);
      if (!e.isFile()) {
        if (e.isDirectory()) continue;
        try {
          const info = await stat(path);
          if (!info.isFile()) continue;
        } catch {
          continue; // a broken link, or an entry that vanished
        }
      }
      const name = e.name.slice(0, -".md".length);
      found.push({ name, path, wins: !seen.has(name) });
      seen.add(name);
    }
  }
  // A stable sort keeps the folder order inside one name.
  return found.sort((a, b) => {
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
}

/** The text of recipe `name`, from the folder that wins, or why not. */
async function readRecipe(
  name: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ text: string } | { error: string }> {
  if (!name || name.includes("/")) {
    return { error: `a recipe name is a file name, with no "/": ${name}` };
  }
  const folders = loopFolders(cwd, env);
  for (const folder of folders) {
    const path = join(folder, `${name}.md`);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      return { text: await readFile(path, "utf8") };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR")
        continue;
      return { error: `cannot read ${path}: ${(err as Error).message}` };
    }
  }
  return {
    error: `no recipe named ${name}: looked in ${folders.join(" and ")}`,
  };
}

/** The four parts of the first message, in order. The note is left out when
 *  there is none. */
const firstMessage = (p: {
  skill: string;
  recipe: string;
  name: string;
  task: string;
  note?: string;
}) =>
  [
    "[the orchestrator skill]",
    p.skill.trim(),
    "",
    `[the recipe: ${p.name}]`,
    p.recipe.trim(),
    "",
    "[the task]",
    p.task,
    ...(p.note ? ["", "[the note]", p.note] : []),
  ].join("\n");

/** The orchestrator's first message for a loop, or why there is none: the
 *  recipe is missing or cannot be read. */
export async function loopMessage(
  l: { recipe: string; task: string; note?: string },
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ text: string } | { error: string }> {
  const recipe = await readRecipe(l.recipe, cwd, env);
  if ("error" in recipe) return recipe;
  const skill = await readFile(SKILL, "utf8");
  return {
    text: firstMessage({
      skill,
      recipe: recipe.text,
      name: l.recipe,
      task: l.task,
      ...(l.note && { note: l.note }),
    }),
  };
}
