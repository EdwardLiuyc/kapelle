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
 * on the status line and the second with a bell. The TUI checks "no room"
 * and "no agents" itself, on a message, before it shows the target's
 * refusal: both name `ctrl+o`, and the piped screen has neither.
 */

import { type Command, parseCommand } from "./command.ts";
import { type Named, resolveTarget, type Target } from "./mention.ts";

/** A typed line: a command, a command refused before any request, or a
 *  message with its target (or the reason it has none). */
export type Line =
  | Command
  | { error: string }
  | { verb: "message"; target: Target };

/** What `text` is, with this roster. */
export function parseLine(text: string, roster: readonly Named[]): Line {
  return (
    parseCommand(text, roster) ?? {
      verb: "message",
      target: resolveTarget(text, roster),
    }
  );
}
