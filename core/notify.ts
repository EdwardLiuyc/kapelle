/**
 * The attention signal — story M1c-4, issue #28.
 *
 * Two moments deserve a human who is looking somewhere else: a permission
 * prompt is waiting for an answer, and the watchdog thinks a task has gone
 * quiet. Everything else can wait for the task card.
 *
 * "Waiting for an answer" is narrower than "a decision is pending", which is
 * why this file filters on `kind` as well as on who is asking — see the
 * pending branch below.
 *
 * **The bus event exists independently of this file.** `core/run.ts` emits
 * `_client_stall_warning` and `protocol/agent.ts` emits
 * `_client_permission_pending` whether or not anything subscribes; M4-4's
 * toast subscribes to the same two. This file is one consumer, not the
 * producer, which is the whole of the story's *Done when*.
 *
 * **Neither signal is suppressed by `--quiet`.** `--quiet` asks for less
 * transcript, and both of these are the opposite of transcript: a prompt
 * nobody answers stalls the run outright, and a stall warning is only useful
 * while the task is still stalled. Same reasoning as #13's containment line.
 *
 * The desktop half is best-effort and deliberately unguarded: we spawn
 * `notify-send`/`osascript` and swallow whatever happens. Checking for the
 * binary first would cost a lookup on every event to learn what the failing
 * spawn tells us for free, and a missing notifier must never change an exit
 * code. macOS and Linux are the supported platforms (M1c-5); elsewhere the
 * spawn simply fails and the bell still rings.
 */

import { spawn } from "node:child_process";

import type { AgentEventEnvelope } from "../protocol/agent.ts";
import { READ_ONLY_KINDS } from "./policy.ts";

/** ASCII BEL. The terminal's own attention signal; no escape sequence, no
 *  colour, nothing `NO_COLOR` or a pipe has an opinion about. */
const BELL = "\x07";

/** Fire a desktop notification and forget it. */
function desktop(title: string, body: string): void {
  // ponytail: AppleScript string literals accept JSON's escaping for the
  // characters a tool title can contain. A body with a newline in it would
  // arrive literal rather than wrapped — swap in a real escaper if a producer
  // ever sends one; today every text on both events is a single line.
  const [command, args] =
    process.platform === "darwin"
      ? ([
          "osascript",
          [
            "-e",
            `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
          ],
        ] as const)
      : (["notify-send", [title, body]] as const);

  try {
    // `unref`: a notification is never a reason for the process to stay alive.
    spawn(command, [...args], { stdio: "ignore" })
      .on("error", () => {})
      .unref();
  } catch {
    // spawn throws synchronously on some argument errors. Same answer.
  }
}

export interface NotifyOptions {
  /** Is a human actually going to be asked? A boolean and not a `ClientMode`
   *  because the `--file` path has no single mode: there, the condition is
   *  whether one asker survived `canAsk` (`cli.ts`). `safe` and `auto` answer
   *  the same request with nobody reading it, so alerting would be noise. */
  asks: boolean;
  /** When provided, pending-permission alerts are restricted to these
   *  agent/task ids. The `--file` path has one asker when `asks` is true, so
   *  a mixed-mode run needs this to avoid ringing for `safe`/`auto` tasks
   *  whose decisions never wait on a human. Stall warnings are never filtered. */
  askIds?: ReadonlySet<string>;
  /** Seams for the test, real behaviour by default. */
  write?: (line: string) => void;
  notify?: (title: string, body: string) => void;
}

/**
 * The bus listener. Subscribe it with `bus.addListener(makeNotifier(…))`.
 *
 * Owns *both* halves of the stall line, not just the bell: `cli.ts` used to
 * print that line from a subscriber of its own, and two subscribers writing
 * about one event is how a run ends up saying it twice.
 */
export function makeNotifier({
  asks,
  askIds,
  write = (line) => process.stderr.write(line),
  notify = desktop,
}: NotifyOptions): (event: AgentEventEnvelope) => void {
  return ({ agent, update }) => {
    if (update.sessionUpdate === "_client_permission_pending") {
      if (!asks) return;
      if (askIds && !askIds.has(agent)) return;
      // The event is emitted before *every* policy await, because
      // `protocol/agent.ts` cannot know which ones will block. `makeAskPolicy`
      // returns on `READ_ONLY_KINDS` without touching readline, so those
      // decisions are over in microseconds with nobody waiting on them — a
      // bell there is a bell for nothing, and the fastest way to teach someone
      // to ignore the alert. The same constant both sides, so a change to what
      // `ask` auto-approves cannot leave the two out of step.
      if (READ_ONLY_KINDS.has(update.kind)) return;
      const text = `permission needed: [${update.kind}] ${update.title}`;
      write(`${BELL}! [${agent}] ${text}\n`);
      notify(`agent-team: ${agent}`, text);
      return;
    }

    if (update.sessionUpdate === "_client_stall_warning") {
      write(`${BELL}! [${agent}] ${update.text}\n`);
      notify(`agent-team: ${agent}`, update.text);
    }
  };
}
