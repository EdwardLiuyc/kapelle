/**
 * `chat/tui/banner.ts` — the full-screen chat's activity rows (M4-4, M7-1).
 *
 * **The TUI's attention signal** (decided 2026-10-05, #50): no desktop
 * pop-up, and the daemon does not ring. A row under the timeline, full width
 * (#242), for each participant that waits off screen: magenta for a
 * question, yellow for a stall, with who, which room and why. A click
 * opens the thread, and the question's box.
 *
 * **A busy agent of the open room gets a row too** (M7-1): a spinner, then
 * `thinking`, its last tool title or `working`, then a timer from the turn's
 * start, and the command that cancels the turn. The screen redraws once a
 * second while such a row shows (`ticks`), and never else. Which rows there
 * are, at most four, is `chat/view.ts`; with none, the part takes no rows.
 */

import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { nameOf } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { bold, dim, fg, magenta, yellow } from "../common.ts";
import {
  type Activity,
  activity,
  clock,
  colourOf,
  type View,
} from "../view.ts";

/** One frame a second: the tick is the only thing that moves it. */
const SPINNER = ["◐", "◓", "◑", "◒"];

/** The activity rows. The view is read at each draw; `open` and `question`
 *  are the screen's. `now` is the clock, for a test. */
function bannerPart({
  rooms,
  view,
  open,
  question,
  now = Date.now,
}: {
  rooms: ReadonlyMap<string, Followed>;
  view: () => View;
  open: (next: View) => void;
  question: (id: string) => void;
  now?: () => number;
}): Component {
  const line = (a: Activity) => {
    const r = rooms.get(a.roomId);
    const name = r ? nameOf(r.state, a.participantId) : a.participantId;
    if (a.why !== "busy") {
      const room = r?.entry.title ?? a.roomId;
      const why = a.why === "question" ? `asks: ${a.text}` : a.text;
      return (a.why === "question" ? magenta : yellow)(
        `▌● ${name} (${room}) ${why}`,
      );
    }
    const p = r?.state.participants.get(a.participantId);
    const doing =
      p?.thinking !== undefined ? "thinking" : (p?.tool ?? "working");
    const start = Date.parse(p?.turns.at(-1)?.start ?? "");
    const timer = Number.isNaN(start) ? "" : ` · ${clock(now() - start)}`;
    const spin = SPINNER[Math.floor(now() / 1000) % SPINNER.length];
    const paint = r ? fg(colourOf(r.state, a.participantId)) : dim;
    return `${paint(`▌${spin}`)} ${bold(name)} ${doing}${dim(`${timer} · @${name} /cancel`)}`;
  };
  return {
    render(width) {
      const { rows, more } = activity(rooms, view());
      const lines = rows.map((a) => truncateToWidth(line(a), width, "…"));
      if (more) lines.push(dim(`  +${more} more`));
      return lines;
    },
    handleMouse(e) {
      if (e.type !== "click" || e.button !== "left") return undefined;
      const a = activity(rooms, view()).rows[e.y];
      if (a) {
        open({ roomId: a.roomId, participantId: a.participantId });
        if (a.why === "question" && a.question) question(a.question);
      }
      return { handled: true };
    },
    invalidate() {},
  };
}

export { bannerPart };
