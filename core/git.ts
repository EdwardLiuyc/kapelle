/**
 * The one place `core/` starts git.
 *
 * Stdout is returned exactly as git wrote it. A caller that wants one-line
 * text uses `gitLine` or `tryGitLine`, and a path keeps its leading or trailing
 * spaces. A failed command is a `GitError` with the exit code and both streams.
 *
 * Every call states the exit codes it accepts and its output buffer. Calls that
 * expect success list 0; a diff also lists 1, because git uses it for "the
 * sides differ".
 *
 * An incomplete trailing UTF-8 sequence is dropped rather than decoded as
 * U+FFFD. An exit 0 that `exitCodes` refuses is a caller error: `tryGit`
 * rethrows it instead of returning null.
 */

import { spawn } from "node:child_process";

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
  /** True when the caller's options, not git, made the call fail. */
  readonly callerError: boolean;

  constructor(
    exitCode: number | null,
    stdout: string,
    stderr: string,
    message: string,
    callerError = false,
  ) {
    super(message);
    this.name = "GitError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.callerError = callerError;
  }
}

const commandName = (args: readonly string[]): string => args[0] ?? "command";
const line = (text: string): string => text.replace(/\r?\n$/, "");

/** Drop an incomplete UTF-8 sequence left by a byte-boundary cut. */
function utf8Prefix(data: Buffer): Buffer {
  let start = data.length - 1;
  while (start >= 0) {
    const byte = data[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    start--;
  }
  if (start < 0) return data;
  const lead = data[start];
  if (lead === undefined) return data;
  const width =
    (lead & 0x80) === 0
      ? 1
      : (lead & 0xe0) === 0xc0
        ? 2
        : (lead & 0xf0) === 0xe0
          ? 3
          : (lead & 0xf8) === 0xf0
            ? 4
            : 1;
  return data.length - start < width ? data.subarray(0, start) : data;
}

function successNotAccepted(
  args: readonly string[],
  stdout: string,
  stderr: string,
): GitError {
  const detail = stderr.trim();
  const reason = detail
    ? `${detail} (git exited with code 0; exitCodes does not accept 0)`
    : `git ${commandName(args)} exited with code 0; exitCodes does not accept 0`;
  return new GitError(0, stdout, stderr, reason, true);
}

function bufferMessage(
  args: readonly string[],
  maxBuffer: number,
  stream: "stdout" | "stderr",
): string {
  return `git ${commandName(args)} exceeded its ${maxBuffer}-byte ${stream} buffer`;
}

function failureMessage(
  args: readonly string[],
  exitCode: number | null,
  stderr: string,
): string {
  const text = stderr.trim();
  if (text) return text;
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
  return gitWithInput(cwd, args, "", options);
}

/** `git`, with one trailing line ending removed. */
export async function gitLine(
  cwd: string,
  args: readonly string[],
  options: GitOptions,
): Promise<string> {
  return line(await git(cwd, args, options));
}

/** `git`, with its own failure treated as a negative answer. A caller error is rethrown. */
export async function tryGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions,
): Promise<string | null> {
  try {
    return await git(cwd, args, options);
  } catch (err) {
    if (err instanceof GitError && !err.callerError) return null;
    throw err;
  }
}

/** `tryGit`, with one trailing line ending removed. */
export async function tryGitLine(
  cwd: string,
  args: readonly string[],
  options: GitOptions,
): Promise<string | null> {
  const text = await tryGit(cwd, args, options);
  return text === null ? null : line(text);
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

    const stdout = () => utf8Prefix(Buffer.concat(out)).toString("utf8");
    const stderr = () => utf8Prefix(Buffer.concat(err)).toString("utf8");
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
      const used = stream === "stdout" ? outBytes : errBytes;
      const room = Math.max(0, options.maxBuffer - used);
      if (chunk.length > room) {
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          if (stream === "stdout") outBytes += room;
          else errBytes += room;
        }
        fail(
          new GitError(
            null,
            stdout(),
            stderr(),
            bufferMessage(args, options.maxBuffer, stream),
            true,
          ),
        );
        child.kill();
        return;
      }
      if (stream === "stdout") outBytes += chunk.length;
      else errBytes += chunk.length;
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
      if (code === 0) {
        fail(successNotAccepted(args, output, errors));
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
