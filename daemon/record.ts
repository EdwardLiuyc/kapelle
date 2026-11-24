/**
 * `daemon.json` and its `.identity` sidecar (M2-4, #34; M9-2): the claim that
 * makes one daemon the only one, the read that tells a live record from a
 * lost one, and the removal that leaves a replacement's files alone. Split
 * from `daemon.ts` (M12-7a): the boot claims and publishes, and the app reads
 * the record before it rewrites `children.json`.
 */

import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";

/** A private sidecar that ties `daemon.json`'s pid to this process start. */
function identityPath(file: string): string {
  return `${file}.identity`;
}

interface DaemonRecord {
  pid?: unknown;
  port?: unknown;
  token?: unknown;
}

/** Parse `daemon.json`'s shape; malformed JSON has no record. */
function parseDaemonRecord(text: string): DaemonRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      // The file is external JSON; this is its decode boundary.
      // pi-lens-ignore: no-runtime-typeof
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as DaemonRecord;
    }
  } catch {
    // Malformed: callers treat it as no record.
  }
  return undefined;
}

type DaemonRecordRead =
  | { state: "readable"; record: DaemonRecord }
  | { state: "missing" | "malformed" | "unreadable" };

/** Read and classify a record without treating an I/O failure as absence. */
export function readDaemonRecord(file: string): DaemonRecordRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return {
      state:
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unreadable",
    };
  }
  const record = parseDaemonRecord(text);
  return record === undefined
    ? { state: "malformed" }
    : { state: "readable", record };
}

/** Remove both files a live daemon owns. */
export function removeDaemonFiles(file: string): void {
  rmSync(file, { force: true });
  rmSync(identityPath(file), { force: true });
}

/** Remove the identity sidecar only while it still names this process. */
function removeIdentityIfMine(file: string): void {
  const path = identityPath(file);
  const identity = readDaemonRecord(path);
  if (identity.state === "unreadable") return;
  const pid = identity.state === "readable" ? identity.record.pid : undefined;
  if (pid !== undefined && pid !== process.pid) return;
  rmSync(path, { force: true });
}

/** A replacement record can belong to the daemon taking over as this one
 *  closes its port. Remove the record only while it still names this daemon,
 *  and remove our sidecar only while it still names this process. */
export function removeDaemonFilesIfMine(
  file: string,
  published: { port: number; token: string } | undefined,
): void {
  const read = readDaemonRecord(file);
  if (read.state === "unreadable") {
    // The sidecar has its own ownership check and does not need this record.
    removeIdentityIfMine(file);
    return;
  }
  const record = read.state === "readable" ? read.record : undefined;
  const mine =
    record === undefined ||
    (record.pid === process.pid &&
      (published === undefined ||
        (record.port === published.port && record.token === published.token)));
  if (mine) rmSync(file, { force: true });
  removeIdentityIfMine(file);
}

/**
 * Record what `ps` calls this process's start time, beside `daemon.json`.
 *
 * The pid alone cannot tell a live daemon from a later process that reused
 * the pid after a crash. A client compares this identity before it signals
 * the pid or decides that a start is still in progress (M9-2).
 *
 * `null` means `ps` could not answer. The file is then removed: an address
 * that answers is still enough for a client to verify the daemon, and a
 * missing identity is safer than an identity that does not match.
 */
function writeIdentity(file: string, startedAt: string | null): void {
  const path = identityPath(file);
  if (startedAt === null) {
    rmSync(path, { force: true });
    return;
  }
  const tmp = `${path}.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt }), {
      mode: 0o600,
    });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Publish the identity after the claim succeeds, or leave no files behind. */
function publish(file: string, fd: number, startedAt: string | null): number {
  try {
    writeIdentity(file, startedAt);
  } catch (err) {
    closeSync(fd);
    removeDaemonFiles(file);
    throw err;
  }
  return fd;
}

/** Is `pid` a live process? `EPERM` means it is, and is someone else's. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Creates `file` holding this pid, or throws `EEXIST`.
 *
 * Written to a private name first and then linked in, because `link` never
 * replaces and the file it publishes already has the pid in it. An exclusive
 * `open` published an empty file for an instant, and a second daemon reading
 * it then took it for stale.
 *
 * `replace` swaps a stale file out with `rename` instead, for `claim` under
 * its lock. The file then exists at every instant: removing it first left a
 * gap in which a reconnecting `attach` read "no file", which means a clean
 * stop, and gave up for good (M5-6, #172).
 */
function create(file: string, replace = false): number {
  const tmp = `${file}.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid }));
    if (replace) renameSync(tmp, file);
    else linkSync(tmp, file);
  } catch (err) {
    closeSync(fd);
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  return fd;
}

/**
 * Takes `daemon.json` for this process, or throws naming the daemon that has it.
 *
 * The file is the single-instance lock as well as the token's home. A second
 * daemon finds a live pid in it and refuses, rather than overwriting the token
 * every client of the first one is using. A pid that is dead was left by a
 * daemon that crashed or was stopped, and its file is replaced.
 */
export function claim(file: string, startedAt: string | null): number {
  let fd: number | undefined;
  try {
    fd = create(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  if (fd !== undefined) return publish(file, fd, startedAt);
  // Replacing a stale file is check-then-act, so two daemons starting in the
  // same instant could both see it stale and both replace it. `mkdir` is
  // atomic, so exactly one gets past here; the other refuses rather than
  // waits, because the winner's pid is about to be live (M2-4).
  const lock = `${file}.lock`;
  try {
    mkdirSync(lock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new Error(
      `another daemon is starting (${lock} exists). If none is, remove ` +
        `that directory and start again.`,
    );
  }
  try {
    let holder: { pid?: unknown; port?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      // A non-object (`null`, `[]`, `42`) names no pid either; it counts as
      // stale exactly like an unreadable file, and must not throw here.
      if (typeof parsed === "object" && parsed !== null) {
        holder = parsed as { pid?: unknown; port?: unknown };
      }
    } catch {
      // Unreadable: nothing live is vouching for it, so it counts as stale.
    }
    if (
      typeof holder.pid === "number" &&
      Number.isInteger(holder.pid) &&
      holder.pid > 0 &&
      alive(holder.pid)
    ) {
      throw new Error(
        `a daemon is already running: pid ${holder.pid}, port ${holder.port} ` +
          `(${file}).`,
      );
    }
    return publish(file, create(file, true), startedAt);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
