/**
 * Shared plumbing for the real-harness integration suite.
 *
 * These tests drive the **actual CLI** as a subprocess against the **actual
 * harness binaries**, so they need credentials and they spend real tokens.
 * The `*.itest.ts` files stay out of CI: `node --test` does not discover the
 * suffix. The generic plumbing below (spawn helpers, temp dirs, `MOCK_AGENT`)
 * is shared with `tests/cli.test.ts`, which *does* run in CI — keep those parts
 * CI-safe. Run the opt-in files with `npm run test:harness`.
 *
 * **Assert on what we control, never on what the model says.** File on disk or
 * not, exit code, our own notice lines. A test that greps for the agent's prose
 * goes red on a model update and teaches everyone to ignore the suite.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

const REPO = join(import.meta.dirname, "..");

/**
 * Reason to skip, or `false` to run. Sync because `test(name, { skip })` is
 * decided when the file loads, not when the test runs. A machine missing one
 * harness skips its file and stays green — a partial install is not a failure.
 */
export function needs(bin: string): false | string {
  const found = spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
  return found ? false : `${bin} is not installed`;
}

/** A throwaway workspace the harness may write into. Removed with the test. */
export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acp-it-"));
  // Retry the recursive removal: harness extensions can still be writing into
  // the workspace for a moment after the CLI subprocess exits (pi-lens writes
  // `.pi-lens-probe-home/`), and a one-shot `rm` can fail on ENOTEMPTY.
  t.after(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  return dir;
}

/** A committed repository with `.kapelle/` ignored — the shape a run needs
 *  before `openWorktrees` will give each task a checkout of its own. */
export async function gitRepo(t: TestContext): Promise<string> {
  const cwd = await tempDir(t);
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd });
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Test");
  await writeFile(join(cwd, ".gitignore"), ".kapelle/\n");
  await git("add", "-A");
  await git("commit", "-m", "first");
  return cwd;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `cli.ts` as a real subprocess and collect everything it printed.
 *
 * No TTY is attached, so `--mode ask` resolves to `safe` here exactly as it
 * does in CI or a pipe. The kill in `t.after` matters: when the test runner's
 * timeout fires it does not reap our children, and a stranded harness holds a
 * session open.
 */
export function spawnCli(t: TestContext, args: string[], script = "cli.ts") {
  const child = spawn(process.execPath, [script, ...args], { cwd: REPO });
  t.after(() => void child.kill("SIGKILL"));

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d) => {
    stdout += d;
  });
  child.stderr.setEncoding("utf8").on("data", (d) => {
    stderr += d;
  });

  const done = new Promise<CliResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  /** Resolves once `stdout` contains `text`. For tests that signal mid-turn. */
  const waitFor = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const bail = setTimeout(
        () => reject(new Error(`never saw ${JSON.stringify(text)}`)),
        60_000,
      );
      const check = () => {
        if (!stdout.includes(text)) return;
        clearTimeout(bail);
        child.stdout.off("data", check);
        resolve();
      };
      child.stdout.on("data", check);
      check();
    });

  return { child, done, waitFor };
}

export function runCli(
  t: TestContext,
  args: string[],
  script?: string,
): Promise<CliResult> {
  return spawnCli(t, args, script).done;
}

/**
 * Absolute path to the offline harness.
 *
 * Absolute because `AcpAgent` spawns the harness **in the workspace root**
 * (`protocol/agent.ts`), not in the repo — so a relative `mock-agent.mjs`
 * vanishes the moment a test passes its own `--cwd`.
 */
export const MOCK_AGENT = join(REPO, "mock-agent.mjs");

/** Its opposite: the harness that attacks the client (M1b-6). Absolute for the same reason. */
export const HOSTILE_AGENT = join(REPO, "hostile-agent.mjs");

/** The prompt every write test uses. One file, one word, nothing to interpret. */
export const WRITE_PROMPT =
  "create a file called PROOF.md containing the single word hello";
