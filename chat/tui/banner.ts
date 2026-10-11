/**
 * `chat/tui/banner.ts` — the full-screen chat's activity rows (M4-4, M7-1).
 *
 * **The TUI's attention signal** (decided 2026-10-05, #50): no desktop
 * pop-up, and the daemon does not ring. A row under the timeline, full width
 * (#242), for each participant that waits off screen: `?` and magenta for
 * a question, `!` and yellow for a stall, with who, which room and why, so
 * the two differ without colour too. A click opens the thread, and the
 * question's box.
 *
 * **A busy agent of the open room gets a row too** (M7-1): a spinner, then
 * `thinking`, its last tool title or `working`, then a timer from the turn's
 * start, and the command that cancels the turn. A busy agent whose question
 * is on screen waits for the person, not for its work: its row says what it
 * asks, with a magenta `?` after the bar in its own colour, and names no
 * cancel. A click on it opens the question, as on a wait row. The screen redraws once a
 * second while such a row shows (`ticks`), and never else. Which rows there
 * are, at most four, is `chat/view.ts`; with none, the part takes no rows.
 */

import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { nameOf, questionOf } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { bold, dim, fg, magenta, yellow } from "../common.ts";
import {
  type Activity,
  activity,
  clock,
  colourOf,
  spin,
  type View,
} from "../view.ts";

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
      return a.why === "question"
        ? magenta(`▌? ${name} (${room}) ${why}`)
        : yellow(`▌! ${name} (${room}) ${why}`);
    }
    const p = r?.state.participants.get(a.participantId);
    const asked = r && questionOf(r.state, a.participantId);
    const doing = asked
      ? `asks: ${asked.title}`
      : p?.thinking !== undefined
        ? "thinking"
        : (p?.tool?.title ?? "working");
    const start = Date.parse(p?.turns.at(-1)?.start ?? "");
    const timer = Number.isNaN(start) ? "" : ` · ${clock(now() - start)}`;
    const cancel = asked ? "" : ` · @${name} /cancel`;
    // The bar is the agent's colour; a question's `?` is magenta, as on
    // a wait row.
    const colour = r ? colourOf(r.state, a.participantId) : undefined;
    const paint = colour === undefined ? dim : fg(colour);
    const mark = asked ? magenta("?") : paint(spin(now()));
    return `${paint("▌")}${mark} ${bold(name)} ${doing}${dim(`${timer}${cancel}`)}`;
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
        // A busy row that asks opens its question too, as a wait row does.
        const r = rooms.get(a.roomId);
        const id =
          a.why === "busy"
            ? r && questionOf(r.state, a.participantId)?.id
            : a.question;
        if (id) question(id);
      }
      return { handled: true };
    },
    invalidate() {},
  };
}

export { bannerPart };
