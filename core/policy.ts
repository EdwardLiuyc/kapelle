/**
 * What the client does when a harness asks — and what it asks for up front.
 *
 * Two halves, and they are not the same kind of thing:
 *
 * 1. **Negotiate.** Under `safe` we set the harness's own nearest restrictive
 *    mode with `session/set_mode` before the first prompt. This is the only
 *    half that reaches a harness which never asks us anything. A room sets
 *    the harness mode in every mode (`negotiateMode`); a run only in `safe`.
 * 2. **Filter.** `READ_ONLY_KINDS` decides every `session/request_permission`
 *    that still arrives.
 *
 * **Neither half is a sandbox. Neither one enforces anything.** They fail
 * differently, though, and the difference is worth keeping straight:
 *
 * - The **filter** has no jurisdiction wherever `measured.asksPermission` is
 *   false. opencode never sends `session/request_permission`, so no policy
 *   value is ever consulted and none changes what it does: it wrote the file
 *   under `safe`, over a denial (`docs/FINDINGS.md` §M0-1).
 * - **Negotiation** did change what opencode does — measured 2026-09-02, the
 *   same prompt wrote the file without it and was refused with it. What it
 *   does not do is *bind*: the refusal arrived as agent prose, so the harness
 *   chose to honour the mode and could have chosen otherwise.
 *
 * So `safe` is defence in depth, and the containment notice `warningsFor`
 * prints is the thing that says so out loud.
 *
 * `READ_ONLY_KINDS` is unchanged from the pre-M1a-5 client on purpose: `kind`
 * is the only thing the protocol hands us. The known cost is copilot, which
 * shells out to explore, so `ls`/`find` arrive as `execute` and `safe` refuses
 * them — safe mode does not make copilot cautious, it cripples it, and the
 * failure presents as a clean `end_turn` with no output. That is what
 * per-harness `defaultMode` is for, not a looser kind set.
 */

import { createInterface } from "node:readline";

import type { AcpAgent, Policy, PolicyRequest } from "../protocol/agent.ts";
import type { AgentEntry, ClientMode } from "../protocol/registry.ts";
import type { ToolKind } from "../protocol/types.ts";

/** Tool kinds treated as non-destructive. Used by `safe`, and by `ask`. */
export const READ_ONLY_KINDS = new Set<ToolKind>([
  "read",
  "search",
  "fetch",
  "think",
]);

/** Least contained last. The ceiling check is a comparison on this. */
const RANK: Record<ClientMode, number> = { safe: 0, ask: 1, auto: 2 };

// --- policies ----------------------------------------------------------------

/** Read-only work proceeds; anything that mutates is refused. */
export async function safePolicy({
  toolCall,
}: PolicyRequest): Promise<boolean> {
  return READ_ONLY_KINDS.has(toolCall.kind);
}

/**
 * Everything allowed. Path guards still apply to fs/* requests.
 *
 * Not exported: `policyFor` is the only way in, so there is one place that
 * maps a resolved mode to a decider and no second copy of that map to drift.
 */
async function autoPolicy(): Promise<boolean> {
  return true;
}

/** Read-only auto-approved; mutations prompt on the terminal. */
export function makeAskPolicy(): { close: () => void; policy: Policy } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // On a TTY readline reads ^C as a key, not a signal, and with no listener it
  // closes itself: the open question never answers and the process's own
  // SIGINT handler never runs, so a ^C at the prompt hung the run. Re-raising
  // it as a real signal hands it to whichever handler the caller installed.
  rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  return {
    close: () => rl.close(),
    policy: async ({ agent, toolCall }: PolicyRequest) => {
      if (READ_ONLY_KINDS.has(toolCall.kind)) return true;
      const answer = await ask(
        `\n  ${agent} wants to run [${toolCall.kind}] ${toolCall.title}\n  allow? [y/N] `,
      );
      return /^y(es)?$/i.test(answer.trim());
    },
  };
}

// --- resolution --------------------------------------------------------------

/** One layer of the `task > run > harness > default` chain. */
export interface PolicyLayer {
  mode?: ClientMode;
  allowReadOutsideRoot?: boolean;
}

/** The harness layer also carries the ceiling, which no other layer may raise. */
export interface HarnessLayer extends PolicyLayer {
  name?: string;
  maxMode?: ClientMode;
}

export interface ResolvedPolicy {
  mode: ClientMode;
  allowReadOutsideRoot: boolean;
}

/**
 * Settle mode and `allowReadOutsideRoot` from the layers that asked for them.
 *
 * Precedence is `task > run > harness > default`, and the two defaults are
 * `ask` and `false`. Two rules bend that chain, both deliberately:
 *
 * - **A mode above the harness's `maxMode` is a validation error naming both
 *   values, never a silent downgrade.** Silently running something more
 *   contained than asked for is the same class of lie as running something
 *   less contained: the caller believes a mode that is not the mode.
 * - **`safe` forces `allowReadOutsideRoot` to `false`, whatever asked for it.**
 *   What lives outside a workspace root is exactly `~/.aws/credentials`,
 *   `~/.ssh` and the parent repo's `.env`; `safe` claiming read-only while
 *   reading an SSH key is the overclaim M0-6 exists to stop.
 *
 * This binds nothing in production today for the same reason `#guardPath`
 * doesn't — no surveyed harness calls `fs/*` — and is correct the day one does.
 */
export function resolvePolicy({
  task,
  run,
  harness,
}: {
  task?: PolicyLayer;
  run?: PolicyLayer;
  harness?: HarnessLayer;
} = {}): ResolvedPolicy {
  const mode = task?.mode ?? run?.mode ?? harness?.mode ?? "ask";
  if (!Object.hasOwn(RANK, mode)) {
    throw new Error(
      `unknown mode "${mode}". Known: ${Object.keys(RANK).join(", ")}.`,
    );
  }

  const ceiling = harness?.maxMode;
  if (ceiling && RANK[mode] > RANK[ceiling]) {
    const who = harness?.name ? ` for "${harness.name}"` : "";
    throw new Error(
      `mode "${mode}" exceeds the ceiling${who}: maxMode is "${ceiling}".`,
    );
  }

  const asked =
    task?.allowReadOutsideRoot ??
    run?.allowReadOutsideRoot ??
    harness?.allowReadOutsideRoot ??
    false;

  return { mode, allowReadOutsideRoot: mode === "safe" ? false : asked };
}

/** The policy implementing a resolved mode. `ask` needs a TTY; callers check. */
export function policyFor(mode: ClientMode): Policy {
  return mode === "auto" ? autoPolicy : safePolicy;
}

// --- negotiation -------------------------------------------------------------

/**
 * Set the harness's own mode to match ours: `modeMap.safe` for `safe`, and
 * `modeMap.ask` for `ask` and `auto`. **Never `modeMap.auto`**: claude's is
 * `bypassPermissions`, where the harness stops asking us at all, so our
 * filter would see nothing. Under `ask` and `auto` the harness keeps asking,
 * and our filter answers.
 *
 * Measured: opencode wrote the file without `safe`'s id and declined with it,
 * so this is the only half of `safe` that reaches a harness which never asks
 * us anything. Sending `ask`'s id also moves a harness out of a start mode
 * set in its own settings, such as claude's `bypassPermissions`, and back out
 * of `safe`. claude accepts `default` (measured 2026-09-29).
 *
 * Mode ids come from the registry's `measured.modeMap` — they are a claim
 * about one build, so a harness with no `measured` half has no ids and
 * negotiation is skipped rather than guessed at. A measured harness can also
 * omit `modeMap` when its ACP modes are not safety/behaviour modes (pi-acp's
 * are thinking-effort levels); that is the same skip, not a guess.
 *
 * **A harness does not reliably keep its mode across `session/load`**
 * (`docs/FINDINGS.md` §Mode after load): after a load, call this again.
 *
 * Returns a line for the containment notice, or `null` when there is nothing
 * to say. It never throws: failing to negotiate makes the mode weaker, which
 * is a thing to say out loud, not a reason to stop.
 */
export async function negotiateMode(
  agent: AcpAgent,
  entry: AgentEntry,
  mode: ClientMode,
): Promise<string | null> {
  // The spec says modeId must be one of `availableModes`, but opencode
  // advertises no modes and honours set_mode anyway (§M0-1), so the registry's
  // measured ids are the source here, not the handshake.
  const modeId = entry.measured?.modeMap?.[mode === "safe" ? "safe" : "ask"];
  if (!modeId) {
    return `${agent.name}: no measured mode ids, so ${mode} mode was not negotiated — it filters only what this harness asks.`;
  }

  try {
    await agent.setMode(modeId);
    return null;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `${agent.name}: session/set_mode "${modeId}" failed (${why}) — ${mode} mode is filtering only.`;
  }
}

/**
 * A run's negotiation: `safe` only, so a run under `ask` or `auto` leaves the
 * harness in its start mode. #193 moves runs to `negotiateMode`.
 */
export async function negotiateSafeMode(
  agent: AcpAgent,
  entry: AgentEntry,
  mode: ClientMode,
): Promise<string | null> {
  return mode === "safe" ? negotiateMode(agent, entry, mode) : null;
}
