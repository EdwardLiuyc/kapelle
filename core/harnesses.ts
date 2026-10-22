/**
 * Which agents are installed here (M9-3, #298).
 *
 * **The agent first, then its ACP program.** For each registry entry with a
 * `setup`, look on `PATH` for the agent's own program (`pi`), then for the
 * ACP program kapelle starts (`pi-acp`). opencode, copilot and kimi are their
 * own ACP program. Each version comes from `--version`, so no session
 * starts and no token is spent; pi-acp has no such flag, so its version
 * comes from its npm `package.json`.
 *
 * **The daemon's `PATH` is the one that counts** (decided 2026-10-15): the
 * daemon starts the agents. So the daemon runs this, never a client.
 *
 * **The saved file holds facts only**: found or not, and each version. The
 * state, the install command and the version warning are worked out when it
 * is read, from today's registry, so a new `measuredOn` needs no new find.
 * A file that lacks a registry entry reads as missing, and the next ask
 * finds again.
 *
 * `done` is the person's own "I have seen this, stop showing it" (#298). Only
 * `POST /harnesses/done` sets it; a find keeps it.
 */

import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { AGENTS } from "../protocol/registry.ts";
import { stateDir } from "./runtime.ts";

/** What the find saw for one agent. */
interface Found {
  program: boolean;
  version?: string;
  acp: boolean;
  acpVersion?: string;
}

/** `harnesses.json`. */
export interface Setup {
  checkedAt: string;
  done: boolean;
  found: Record<string, Found>;
}

/** One agent, as `GET /harnesses` shows it. */
export interface AgentSetup {
  id: string;
  state: "ready" | "main_only" | "not_installed";
  program: string;
  version?: string;
  acpProgram: string;
  acpVersion?: string;
  /** The command that installs the ACP program; on `main_only` only. */
  install?: string;
  /** The ACP program is not the build kapelle measured. */
  warning?: string;
}

/** How long one `--version` may take. */
const VERSION_TIMEOUT_MS = 5000;

/** The first `x.y.z` in a version line: `opencode v2.0.18`, `GitHub
 *  Copilot CLI 1.0.91.`, `@agentclientprotocol/codex-acp 2.2.2`. */
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?/;

/** The first executable file called `name` in `path`, as a shell finds it. */
function onPath(name: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // Not here; the next folder.
    }
  }
  return undefined;
}

/** What `file --version` says, or nothing. stdin is closed, so a program
 *  that ignores the flag reads its end and stops, and the time limit ends
 *  one that does not. */
function versionOf(file: string): Promise<string | undefined> {
  return new Promise((ok) => {
    const child = execFile(
      file,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, encoding: "utf8" },
      (_err, stdout, stderr) => ok(VERSION.exec(`${stdout}\n${stderr}`)?.[0]),
    );
    child.stdin?.end();
  });
}

/** The `version` of the npm package `file` is in: the nearest
 *  `package.json` above the file a bin link points at. */
function packageVersion(file: string): string | undefined {
  let dir: string;
  try {
    dir = dirname(realpathSync(file));
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      const pkg: unknown = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      );
      const v = (pkg as { version?: unknown }).version;
      return typeof v === "string" ? v : undefined;
    } catch {
      // No package here; one folder up.
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Looks for every registry agent on `path`, all at once. */
export async function findAgents(path: string): Promise<Setup["found"]> {
  const entries = Object.entries(AGENTS).flatMap(([id, a]) =>
    a.setup ? [{ id, command: a.launch.command, ...a.setup }] : [],
  );
  const found = await Promise.all(
    entries.map(async (e): Promise<[string, Found]> => {
      const program = onPath(e.program, path);
      const acp = e.command === e.program ? program : onPath(e.command, path);
      const [version, acpVersion] = await Promise.all([
        program ? versionOf(program) : undefined,
        !acp || acp === program
          ? undefined
          : e.versionFromPackage
            ? packageVersion(acp)
            : versionOf(acp),
      ]);
      return [
        e.id,
        {
          program: program !== undefined,
          version,
          acp: acp !== undefined,
          acpVersion: acp === program ? version : acpVersion,
        },
      ];
    }),
  );
  return Object.fromEntries(found);
}

function setupFile(): string {
  return join(stateDir(), "harnesses.json");
}

/** The saved find, or nothing when it is missing, unreadable, or lacks an
 *  agent the registry has now. */
export function readSetup(): Setup | undefined {
  const file = setupFile();
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Setup;
    if (typeof s.checkedAt !== "string" || typeof s.found !== "object") {
      return undefined;
    }
    for (const [id, a] of Object.entries(AGENTS)) {
      if (a.setup && !s.found[id]) return undefined;
    }
    return { ...s, done: s.done === true };
  } catch {
    return undefined;
  }
}

/** Replaces the saved find, atomically. */
export function writeSetup(s: Setup): void {
  const file = setupFile();
  const tmp = `${file}.tmp`;
  // The tmp+rename below is the atomic write; the repo has no JSON-store seam.
  // pi-lens-ignore: no-raw-json-store-write
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Each agent's state, from the saved facts and today's registry. */
export function describe(s: Setup): AgentSetup[] {
  return Object.entries(AGENTS).flatMap(([id, a]) => {
    const f = s.found[id];
    if (!a.setup || !f) return [];
    const state =
      f.program && f.acp ? "ready" : f.program ? "main_only" : "not_installed";
    const m = a.measured?.measuredOn;
    const acpProgram = a.launch.command;
    const warning =
      f.acp && m && f.acpVersion !== m.version
        ? `${acpProgram} ${f.acpVersion ?? "(version unknown)"} is not the ` +
          `build kapelle measured: ${m.version} (${m.date}).`
        : undefined;
    const install = state === "main_only" ? a.setup.install : undefined;
    return [
      {
        id,
        state,
        program: a.setup.program,
        ...(f.version && { version: f.version }),
        acpProgram,
        ...(f.acpVersion && { acpVersion: f.acpVersion }),
        ...(install && { install }),
        ...(warning && { warning }),
      },
    ];
  });
}
