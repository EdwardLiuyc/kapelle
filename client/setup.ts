/**
 * The setup list (M9-3, #298): the agents the daemon found, as lines.
 *
 * **Both chat screens and `kapelle setup` print it from here**, so they
 * cannot differ. Each line has a `tone`, and each screen colours it its own
 * way: an agent that is not installed is grey, a warning is yellow.
 *
 * The daemon does the find (`core/harnesses.ts`). `findAgain` asks it for a
 * new one, and `markDone` records the person's "done". The list opens with a
 * new find, so it has no "check again".
 *
 * `installAgents` (M9-3b) sends the checked ids, never a command: the
 * daemon builds each command from its registry and streams npm's output.
 */

import type {
  HarnessEntry,
  HarnessesReply,
  InstallLine,
  InstallResult,
} from "./contract.ts";
import {
  call,
  type DaemonAddress,
  type Reply,
  replyOf,
  request,
} from "./daemon.ts";
import { printable } from "./room.ts";

interface SetupLine {
  text: string;
  tone?: "dim" | "warn";
  /** The agent the TUI may install from this line (M9-3b). */
  install?: string;
}

const ORDER = ["ready", "main_only", "not_installed"];

/** What one agent's line says after its name. Every value comes from the
 *  daemon, so each is made printable before it reaches a terminal. */
function detail(h: HarnessEntry): string {
  const program = printable(h.program ?? "?");
  const version = printable(h.version ?? "?");
  if (h.state === "not_installed") {
    return `not installed: no ${program} on the daemon's PATH`;
  }
  if (h.state === "main_only") {
    // The main program's version is shown, never compared. Keep the install
    // command together at the end so it stays copyable.
    return (
      `${program} ${version}; needs ` +
      `${printable(h.acpProgram ?? "?")}: ${printable(h.install ?? "?")}`
    );
  }
  const versions = [`${program} ${version}`];
  if (h.acpProgram !== h.program) {
    versions.push(
      `${printable(h.acpProgram ?? "?")} ${printable(h.acpVersion ?? "?")}`,
    );
  }
  return `ready (${versions.join(", ")})`;
}

/** One line per agent, the ready ones first, then each warning, then what
 *  to do next. A daemon older than M9-3 sends no state: no lines. */
export function setupLines(r: HarnessesReply): SetupLine[] {
  // A pre-M9-3 daemon sends a bare list with no state: its contract is no
  // lines, not a misleading "No agent is ready".
  if (!r.harnesses.some((h) => h.state)) return [];
  const known = r.harnesses
    .filter((h) => h.state)
    .sort(
      (a, b) => ORDER.indexOf(a.state ?? "") - ORDER.indexOf(b.state ?? ""),
    );
  const width = Math.max(0, ...known.map((h) => printable(h.id).length));
  const lines: SetupLine[] = known.map((h) => ({
    text: `${printable(h.id).padEnd(width)}  ${detail(h)}`,
    ...(h.state === "not_installed" && { tone: "dim" as const }),
    ...(h.state === "main_only" && h.install && { install: h.id }),
  }));
  for (const h of known) {
    if (h.warning) {
      lines.push({ text: `! ${printable(h.warning)}`, tone: "warn" });
    }
  }
  if (!known.some((h) => h.state === "ready")) {
    lines.push({ text: "No agent is ready: install one.", tone: "warn" });
  }
  if (known.some((h) => h.state !== "ready")) {
    lines.push({
      text: "After an install, run /setup in the chat, or kapelle setup.",
      tone: "dim",
    });
  }
  return lines;
}

/** Whether the chat shows the list at start: until "done", and always
 *  while no agent is ready. Never for a daemon older than M9-3. */
export function needsSetup(r: HarnessesReply): boolean {
  if (!r.harnesses.some((h) => h.state)) return false;
  return !r.done || !r.harnesses.some((h) => h.state === "ready");
}

/** `GET /harnesses`. A daemon older than M9-3 sends the bare list. */
export async function readHarnesses(
  d: DaemonAddress,
): Promise<Reply<HarnessesReply>> {
  const r = await call<HarnessesReply | HarnessEntry[]>(d, "/harnesses");
  if (!r.ok) return r;
  const body = Array.isArray(r.body)
    ? { checkedAt: "", done: true, harnesses: r.body }
    : r.body;
  return { ...r, body };
}

/** The daemon finds the agents again. */
export function findAgain(d: DaemonAddress) {
  return call<HarnessesReply>(d, "/harnesses", { method: "POST" });
}

/** The person said "done": the list stops opening at start. */
export function markDone(d: DaemonAddress) {
  return call<HarnessesReply>(d, "/harnesses/done", { method: "POST" });
}

const reasonOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** A reply body that stopped or broke: not a fetch that could not connect. */
const brokenInstall = (err: unknown) =>
  new Error(`the daemon's install reply broke: ${reasonOf(err)}`, {
    cause: err,
  });

/** `POST /harnesses/install`: the daemon installs `ids`, and `on` gets each
 *  line as it comes. Answers the last line. A stream that ends before it
 *  throws: the next find shows what was installed. */
export async function installAgents(
  d: DaemonAddress,
  ids: string[],
  on: (l: Exclude<InstallLine, InstallResult>) => void,
): Promise<Reply<InstallResult>> {
  // A fetch TypeError here means no daemon answered; the caller maps it to
  // NO_DAEMON. A TypeError while reading the body is not the same thing.
  const res = await request(d, "/harnesses/install", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
  if (!res.ok || !res.body) {
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw brokenInstall(err);
    }
    const reply = replyOf<InstallResult>(res, text);
    if (!reply.ok) return reply;
    throw new Error("the daemon sent no install reply");
  }
  let rest = "";
  try {
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const text of lines) {
        if (!text) continue;
        const l = JSON.parse(text) as InstallLine;
        if ("failed" in l) return { ok: true, status: res.status, body: l };
        on(l);
      }
    }
  } catch (err) {
    throw brokenInstall(err);
  }
  throw new Error(
    "the daemon ended the install early: /setup shows the result",
  );
}
