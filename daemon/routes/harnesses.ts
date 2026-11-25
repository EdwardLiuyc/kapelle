/**
 * The harness routes (M12-7b): the installed agents and their login checks
 * (`GET` and `POST /harnesses`, M9-3, M9-4), the person's "done", and the npm
 * install (`POST /harnesses/install`, M9-3b). The find, the check and the
 * install each run one at a time; their state lives here.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { HarnessesReply, InstallLine } from "../../client/contract.ts";
import {
  checkFields,
  dueForCheck,
  readChecks,
  runChecks,
  stopChecks,
} from "../../core/check.ts";
import {
  describe,
  findAgents,
  installArgs,
  installCommand,
  readSavedDone,
  readSetup,
  runNpm,
  type Setup,
  stopNpmInstalls,
  writeSetup,
} from "../../core/harnesses.ts";
import { AGENTS } from "../../protocol/registry.ts";
import { type Route, readBody, refusal, send } from "../http.ts";

/** `stopping` is true once a shutdown has begun: no new check or install may
 *  start. */
export function harnessRoutes(stopping: () => boolean) {
  /** The find in flight, so asks that meet share it. */
  let finding: Promise<Setup> | undefined;

  /**
   * The installed agents (M9-3): the saved find, or a new one when `again` is
   * set or none is saved. The first ask finds, not the boot, so a daemon
   * nobody asks spawns no `--version`. A new find keeps the person's `done`,
   * read once it ends, so a "done" during it is kept.
   */
  async function setupNow(again: boolean): Promise<Setup> {
    const saved = again ? undefined : readSetup();
    if (saved) return saved;
    // An install needs a find that began after npm wrote its program. A find
    // already in flight may have read PATH before that.
    if (again && finding) {
      await finding.catch(() => {});
      if (finding) return finding;
    }
    finding ??= findAgents(process.env.PATH ?? "")
      .then((found) => {
        const s = {
          checkedAt: new Date().toISOString(),
          done: readSavedDone(),
          found,
        };
        writeSetup(s);
        return s;
      })
      .finally(() => {
        finding = undefined;
      });
    return finding;
  }

  /** The check in flight (M9-4): one at a time, so two asks never start the
   *  same agents twice. */
  let checking: Promise<void> | undefined;

  /**
   * Checks the ready agents of find `s` that are due (`dueForCheck`): all of
   * them when `force`. The reply waits for it (decided 2026-10-28): about 5 s,
   * and the chat does not block on it. An ask that meets a check waits for it,
   * then checks only what is still due.
   */
  async function checkNow(s: Setup, force: boolean): Promise<void> {
    if (stopping()) return;
    while (checking) await checking.catch(() => {});
    if (stopping()) return;
    const ids = dueForCheck(s, readChecks(), force);
    if (ids.length === 0) return;
    checking = runChecks(ids, s.found).finally(() => {
      checking = undefined;
    });
    await checking;
  }

  function harnessesReply(s: Setup): HarnessesReply {
    const found = new Map(describe(s).map((a) => [a.id, a]));
    const checks = readChecks();
    return {
      checkedAt: s.checkedAt,
      done: s.done,
      harnesses: Object.entries(AGENTS).map(([id, a]) => ({
        id,
        measured: a.measured !== undefined,
        ...found.get(id),
        // A check describes a ready agent only.
        ...(found.get(id)?.state === "ready" && checkFields(id, checks[id])),
      })),
    };
  }

  /** Set while `POST /harnesses/install` runs: one install at a time. */
  let installing = false;

  /**
   * `POST /harnesses/install` (M9-3b): the person's checked agents, by id.
   * The body takes `ids` only, so a command never arrives here: the daemon
   * builds each one from its registry (`installArgs`). Each id must be an
   * agent the find now calls `main_only`. The reply streams NDJSON: each
   * install's command and npm's output, then the failures and a new find. A
   * chat that leaves does not stop npm; the next find sees what it did.
   */
  async function postInstall(req: IncomingMessage, res: ServerResponse) {
    const { ids } = await readBody(req, ["ids"]);
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) => typeof id === "string")
    ) {
      throw refusal(400, "invalid_request", "ids must be a list of agent ids");
    }
    if (stopping()) {
      throw refusal(503, "shutting_down", "the daemon is shutting down");
    }
    if (installing) {
      throw refusal(409, "install_running", "an install is already running");
    }
    installing = true;
    try {
      const state = new Map(
        describe(await setupNow(true)).map((a) => [a.id, a.state]),
      );
      const plan = [...new Set(ids as string[])].map((id) => {
        const args = installArgs(id);
        if (!args || state.get(id) !== "main_only") {
          throw refusal(
            400,
            "invalid_request",
            `${JSON.stringify(id)} is not an agent kapelle can install: ` +
              "only one whose own program is installed and its ACP program is not",
          );
        }
        return { id, args };
      });
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      const line = (l: InstallLine) => {
        if (!res.destroyed) res.write(`${JSON.stringify(l)}\n`);
      };
      const npmError = new Map<string, string>();
      for (const { id, args } of plan) {
        if (stopping()) break;
        line({ id, command: installCommand(args) });
        const error = await runNpm(args, (output) => line({ id, output }));
        if (stopping()) break;
        if (error) npmError.set(id, error);
      }
      // The daemon is going: no final find and no second agent. The stream's
      // client sees it end, and the next daemon finds what npm wrote.
      if (stopping()) {
        res.destroy();
        return;
      }
      // The find is the result, not npm's exit code (#374), both ways: npm
      // exits 0 when it installs into a global bin folder that is not on our
      // PATH, and a ready agent is no failure whatever npm said, unless it has
      // a warning too: then npm died after its link, and its error stays.
      // `command` is only for a failure that running it by hand can help.
      const setup = await setupNow(true);
      // A newly ready agent has no saved check, so it is due.
      await checkNow(setup, false);
      const now = new Map(describe(setup).map((a) => [a.id, a]));
      const failed = plan.flatMap(({ id, args }) => {
        const a = now.get(id);
        const error = npmError.get(id);
        if (a?.state === "ready" && !(a.warning && error)) return [];
        return [
          error
            ? { id, command: installCommand(args), error }
            : {
                id,
                error:
                  `npm finished, but ${a?.acpProgram} is still not on the ` +
                  "daemon's PATH: put npm's global bin folder on it, then " +
                  "restart the daemon",
              },
        ];
      });
      line({ failed, setup: harnessesReply(setup) });
      res.end();
    } finally {
      installing = false;
    }
  }

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/harnesses$/,
      handler: async ({ res }) => {
        const s = await setupNow(false);
        await checkNow(s, false);
        send(res, 200, harnessesReply(s));
      },
    },
    {
      method: "POST",
      pattern: /^\/harnesses$/,
      handler: async ({ res }) => {
        const s = await setupNow(true);
        await checkNow(s, true);
        send(res, 200, harnessesReply(s));
      },
    },
    {
      method: "POST",
      pattern: /^\/harnesses\/done$/,
      handler: async ({ res }) => {
        const s = { ...(await setupNow(false)), done: true };
        writeSetup(s);
        send(res, 200, harnessesReply(s));
      },
    },
    {
      method: "POST",
      pattern: /^\/harnesses\/install$/,
      handler: ({ req, res }) => postInstall(req, res),
    },
  ];

  /** The installs and checks are this module's in-flight work; shutdown ends
   *  it here rather than making `daemon/app.ts` reach into `core/`. */
  function stop(): Promise<void> {
    stopNpmInstalls();
    return stopChecks();
  }

  return { routes, stop };
}
