/**
 * The one place `core/` starts git.
 *
 * Stdout is returned exactly as git wrote it. A caller that wants one-line
 * text strips the line ending itself, and a path keeps its leading or trailing
 * spaces. A failed command is a `GitError` with the exit code and both streams.
 *
 * Every call states the exit codes it accepts and its output buffer. `0` is not
 * implied, so a caller that expects only success passes `[0]`; a diff passes
 * `[0, 1]`, because git uses 1 for "the sides differ".
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitOptions {
  /** Exit codes that answer the question rather than fail the call. */
  exitCodes: readonly number[];
  /** Largest stdout or stderr payload, in bytes. */
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
}

export class GitError extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    exitCode: number | null,
    stdout: string,
    stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "GitError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const commandName = (args: readonly string[]): string => args[0] ?? "command";

function failureMessage(
  args: readonly string[],
  exitCode: number | null,
  stderr: string,
  fallback?: string,
): string {
  const text = stderr.trim();
  if (text) return text;
  if (fallback) return fallback;
  return exitCode === null
    ? `git ${commandName(args)} failed`
    : `git ${commandName(args)} exited with code ${exitCode}`;
}

/** Run git and return raw stdout when the exit code is one the caller accepts. */
export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions,
): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      env: options.env,
      maxBuffer: options.maxBuffer,
      encoding: "utf8",
    });
    return stdout;
  } catch (err) {
    const failure = err as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: string;
    };
    const exitCode = typeof failure.code === "number" ? failure.code : null;
    const stdout =
      typeof failure.stdout === "string" ? failure.stdout : String();
    const stderr =
      typeof failure.stderr === "string" ? failure.stderr : String();
    if (exitCode !== null && options.exitCodes.includes(exitCode)) {
      return stdout;
    }
    throw new GitError(
      exitCode,
      stdout,
      stderr,
      failureMessage(args, exitCode, stderr, failure.message),
    );
  }
}

/** `git`, with any `GitError` treated as a negative answer. */
export async function tryGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions,
): Promise<string | null> {
  try {
    return await git(cwd, args, options);
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

/** Run git with `input` on stdin and return raw stdout. */
export function gitWithInput(
  cwd: string,
  args: readonly string[],
  input: string,
  options: GitOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: options.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;

    const stdout = () => Buffer.concat(out).toString("utf8");
    const stderr = () => Buffer.concat(err).toString("utf8");
    const fail = (error: GitError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const collect = (
      chunks: Buffer[],
      chunk: Buffer,
      stream: "stdout" | "stderr",
    ) => {
      if (settled) return;
      const size = (stream === "stdout" ? outBytes : errBytes) + chunk.length;
      if (size > options.maxBuffer) {
        fail(
          new GitError(
            null,
            stdout(),
            stderr(),
            `git ${commandName(args)} exceeded its ${options.maxBuffer}-byte ` +
              `${stream} buffer`,
          ),
        );
        child.kill();
        return;
      }
      if (stream === "stdout") outBytes = size;
      else errBytes = size;
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(out, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(err, chunk, "stderr"));
    child.on("error", (error) => {
      fail(
        new GitError(
          null,
          stdout(),
          stderr(),
          `git ${commandName(args)} could not start: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      const output = stdout();
      const errors = stderr();
      if (code !== null && options.exitCodes.includes(code)) {
        settled = true;
        resolve(output);
        return;
      }
      fail(
        new GitError(code, output, errors, failureMessage(args, code, errors)),
      );
    });
    // A git that exits before reading stdin makes this write fail.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
