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

import { spawn } from "node:child_process";
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

import { AGENTS, resolveEnv } from "../protocol/registry.ts";
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

/** The most stdout+stderr a version probe may collect. Ordinary version
 *  lines are tiny; a program that floods its output is not one we can read. */
const VERSION_OUTPUT_LIMIT = 64 * 1024;

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
 *  that ignores the flag reads its end and stops. A probe gets the same
 *  secret-free environment as a harness, and the timeout or output limit
 *  kills its whole process group: a child can ignore SIGTERM, and one that
 *  leaves a descendant holding stdout open must not hold the find forever. */
function versionOf(file: string): Promise<string | undefined> {
  return new Promise((ok) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const child = spawn(file, ["--version"], {
      env: resolveEnv(undefined),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      ok(VERSION.exec(`${out}\n${err}`)?.[0]);
    };
    const killGroup = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const collect = (stream: "stdout" | "stderr", data: Buffer) => {
      if (settled) return;
      const room = VERSION_OUTPUT_LIMIT - outputBytes;
      const kept = data.subarray(0, room);
      (stream === "stdout" ? stdout : stderr).push(kept);
      outputBytes += kept.length;
      if (kept.length === data.length) return;
      // Keep what fits so a version line at the start is still readable,
      // then kill the group and settle: a flood is already not a version.
      killGroup();
      finish();
    };
    child.stdout.on("data", (data: Buffer) => {
      collect("stdout", data);
    });
    child.stderr.on("data", (data: Buffer) => {
      collect("stderr", data);
    });
    child.once("error", finish);
    child.once("close", finish);
    child.stdin?.end();
    // Kill the whole group, then settle here regardless: descendants can
    // hold the pipes open after the direct child is gone.
    timer = setTimeout(() => {
      killGroup();
      finish();
    }, VERSION_TIMEOUT_MS);
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
      // Validate and extract, as `--version` does: package text is not ours
      // to print unchecked.
      return typeof v === "string" ? VERSION.exec(v)?.[0] : undefined;
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

/** The person's saved `done`, even when the rest of the file is incomplete
 *  and a new find will replace it. */
export function readSavedDone(): boolean {
  try {
    const s: unknown = JSON.parse(readFileSync(setupFile(), "utf8"));
    return (
      typeof s === "object" &&
      s !== null &&
      (s as { done?: unknown }).done === true
    );
  } catch {
    return false;
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
