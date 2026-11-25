/**
 * The repository routes (M12-7b): `POST` and `GET /repos`, and `GET`, `PATCH`
 * and `PUT /config`. Both are about one added repository: adding one checks
 * its config (M2-7), and the config routes answer only for an added one.
 * `refuseUnadded` is the check that every route taking a folder shares.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ConfigView,
  RepoAdded,
  RepoRoots,
} from "../../client/contract.ts";
import {
  InvalidConfig,
  PROJECT_KEYS,
  projectConfigView,
  readProjectConfig,
  replaceProjectConfig,
  saveProjectConfig,
} from "../../core/config.ts";
import { writeRepos } from "../../core/runtime.ts";
import {
  LinkPathError,
  stateDirRoot,
  validateWorktreeLinks,
} from "../../core/worktree.ts";
import { existingDir, type Route, readBody, refusal, send } from "../http.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * The repository root `cwd` belongs to, or a 403 for a folder outside every
 * added one. `stateDirRoot` never throws, so an unadded folder is told to add
 * itself rather than to fix something else. Shared by `POST /runs` and
 * `POST /rooms`, which refuse in the same order.
 */
export async function refuseUnadded(
  repos: ReadonlySet<string>,
  cwd: string,
): Promise<string> {
  const { root } = await stateDirRoot(cwd);
  if (!repos.has(root)) {
    throw refusal(
      403,
      "repo_not_added",
      `${root} has not been added to the daemon. POST /repos ` +
        `{"path": ${JSON.stringify(root)}} first.`,
    );
  }
  return root;
}

/** The routes for `repos`, the added roots. `POST /repos` adds to it. */
export function repoRoutes(repos: Set<string>): Route[] {
  async function postRepo(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req, ["path"]);
    // Since #129 a repository cannot be in a state that refuses a run, so this
    // only resolves the root. The 409 that used to live here — a tracked or
    // unignored `.kapelle/` — is gone with the state that caused it.
    const { root } = await stateDirRoot(existingDir(body.path, "path"));
    // M2-7: a config that does not load is refused at add time, naming the file
    // and key, rather than at the repository's first run.
    try {
      const config = readProjectConfig(root);
      await validateWorktreeLinks(root, config.linkPaths ?? []);
    } catch (err) {
      throw refusal(400, "invalid_config", messageOf(err));
    }
    // Persisted before the 200 and before the in-memory add: a caller told its
    // repository was added must not find it gone after a restart, and a failed
    // write must not leave memory ahead of disk. Hence the copy — it is what
    // lets the write happen first, and it dedups a repository added twice.
    const next = new Set(repos).add(root);
    writeRepos([...next]);
    repos.add(root);
    send(res, 200, { root } satisfies RepoAdded);
  }

  /** The config view of an added repository (M10-5): every project key, its
   *  value in use and its source. A safe file whose content is invalid is a
   *  200 with `invalid`; an unsafe path is the 400 the other config reads give. */
  function sendConfig(res: ServerResponse, root: string) {
    let view: ReturnType<typeof projectConfigView>;
    try {
      view = projectConfigView(root);
    } catch (err) {
      throw refusal(400, "invalid_config", messageOf(err));
    }
    send(res, 200, { root, ...view } satisfies ConfigView);
  }

  /** `PATCH /config?cwd=…` (M10-5) saves the changed project keys of an added
   *  repository, `null` to remove one (`saveProjectConfig`). `PUT /config?cwd=…`
   *  (#504) replaces the whole file after the complete new content passes the
   *  same value and git checks (`replaceProjectConfig`). Either answers the
   *  view, and writes only that repository's `.kapelle/config.json`. */
  const writeConfig =
    (
      save: (root: string, body: Record<string, unknown>) => Promise<unknown>,
    ): Route["handler"] =>
    async ({ req, res, query }) => {
      const body = await readBody(req, PROJECT_KEYS);
      const root = await refuseUnadded(
        repos,
        existingDir(query.get("cwd"), "cwd"),
      );
      try {
        await save(root, body);
      } catch (err) {
        if (err instanceof InvalidConfig || err instanceof LinkPathError) {
          throw refusal(400, "invalid_config", messageOf(err));
        }
        throw err;
      }
      sendConfig(res, root);
    };

  return [
    {
      method: "POST",
      pattern: /^\/repos$/,
      handler: ({ req, res }) => postRepo(req, res),
    },
    {
      method: "GET",
      pattern: /^\/repos$/,
      handler: ({ res }) => send(res, 200, [...repos] satisfies RepoRoots),
    },
    {
      method: "GET",
      pattern: /^\/config$/,
      handler: async ({ res, query }) => {
        const cwd = existingDir(query.get("cwd"), "cwd");
        sendConfig(res, await refuseUnadded(repos, cwd));
      },
    },
    {
      method: "PATCH",
      pattern: /^\/config$/,
      handler: writeConfig(saveProjectConfig),
    },
    {
      method: "PUT",
      pattern: /^\/config$/,
      handler: writeConfig(replaceProjectConfig),
    },
  ];
}
