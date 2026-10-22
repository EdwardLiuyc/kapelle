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
 */

import type { HarnessEntry, HarnessesReply } from "./contract.ts";
import { call, type DaemonAddress, type Reply } from "./daemon.ts";

interface SetupLine {
  text: string;
  tone?: "dim" | "warn";
}

const ORDER = ["ready", "main_only", "not_installed"];

/** What one agent's line says after its name. */
function detail(h: HarnessEntry): string {
  if (h.state === "not_installed") {
    return `not installed: no ${h.program} on the daemon's PATH`;
  }
  if (h.state === "main_only") return `needs ${h.acpProgram}: ${h.install}`;
  const versions = [`${h.program} ${h.version ?? "?"}`];
  if (h.acpProgram !== h.program) {
    versions.push(`${h.acpProgram} ${h.acpVersion ?? "?"}`);
  }
  return `ready (${versions.join(", ")})`;
}

/** One line per agent, the ready ones first, then each warning, then what
 *  to do next. A daemon older than M9-3 sends no state: no lines. */
export function setupLines(r: HarnessesReply): SetupLine[] {
  const known = r.harnesses
    .filter((h) => h.state)
    .sort(
      (a, b) => ORDER.indexOf(a.state ?? "") - ORDER.indexOf(b.state ?? ""),
    );
  const width = Math.max(0, ...known.map((h) => h.id.length));
  const lines: SetupLine[] = known.map((h) => ({
    text: `${h.id.padEnd(width)}  ${detail(h)}`,
    ...(h.state === "not_installed" && { tone: "dim" as const }),
  }));
  for (const h of known) {
    if (h.warning) lines.push({ text: `! ${h.warning}`, tone: "warn" });
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
