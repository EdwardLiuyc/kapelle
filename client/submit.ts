/**
 * What a typed line is (M4-8): a command, or a message and its target.
 *
 * **Both screens read a line through here**, so they cannot differ (S8).
 * `parseLine` runs `parseCommand` first, then `resolveTarget`, and does no
 * I/O. Each screen then does its own part: the TUI opens a form or asks to
 * add a folder, and the piped screen prints the command to run or waits for
 * the turn to end. A refusal that names a key, such as `ctrl+o`, keeps its
 * words in the screen.
 *
 * A command refused and a target refused stay apart: the TUI shows the first
 * on the status line and the second as a line in the transcript. The TUI
 * checks "no room" and "no agents" itself, on a message, before it shows the
 * target's refusal: both name `ctrl+o`, and the piped screen has neither.
 *
 * A piped hall chat pins one participant (`direct`): a bare message or
 * participant command goes to that participant. An explicit `@name` on a
 * command still resolves against the room's roster; on a message it must be
 * the pin.
 */

import { CHAT_GONE, type Command, parseCommand } from "./command.ts";
import {
  fold,
  MENTION,
  type Named,
  resolveTarget,
  type Target,
} from "./mention.ts";

/** A typed line: a command, a command refused before any request, or a
 *  message with its target (or the reason it has none). */
export type Line =
  | Command
  | { error: string }
  | { verb: "message"; target: Target };

/** A message in a pinned chat. A mention of another real participant says
 *  how to open that chat instead of claiming the name does not exist. */
function directTarget(
  text: string,
  roster: readonly Named[],
  direct: string,
): Target {
  const pin = roster.find((p) => p.id === direct);
  if (!pin) return { error: CHAT_GONE };
  const m = MENTION.exec(text.trimStart());
  const wanted = m
    ? roster.find((p) => fold(p.name) === fold(m[1] ?? ""))
    : undefined;
  if (wanted && wanted.id !== pin.id) {
    return {
      error: `this chat is with @${pin.name}; to open @${wanted.name}, run: kapelle chat attach @${wanted.name}`,
    };
  }
  return resolveTarget(text, [pin], false);
}

/** What `text` is, with this roster. `hall` is the room's `hall` flag;
 *  `direct` pins a piped chat to one participant. */
export function parseLine(
  text: string,
  roster: readonly Named[],
  hall = false,
  direct?: string,
): Line {
  const command = parseCommand(text, roster, hall, direct);
  if (command) return command;
  return {
    verb: "message",
    target: direct
      ? directTarget(text, roster, direct)
      : resolveTarget(text, roster, hall),
  };
}
