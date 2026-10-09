/**
 * `chat/tui/banner.ts` — the full-screen chat's banner (M4-4).
 *
 * **The TUI's attention signal** (decided 2026-10-05, #50): no desktop
 * pop-up, and the daemon does not ring. A row under the timeline, full width
 * (#242), for each participant that waits off screen: magenta for a
 * question, yellow for a stall, with who, which room and why. A click opens the thread, and the
 * question's box. Which rows there are is `chat/view.ts`; with none, the
 * banner takes no rows.
 */

import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { nameOf } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { dim, magenta, yellow } from "../common.ts";
import { banner, type View, type Wait } from "../view.ts";

/** At most this many rows; past it, one fewer and a `+N more` row. */
const MOST = 3;

/** The banner. The view is read at each draw; `open` and `question` are the
 *  screen's. */
function bannerPart({
  rooms,
  view,
  open,
  question,
}: {
  rooms: ReadonlyMap<string, Followed>;
  view: () => View;
  open: (next: View) => void;
  question: (id: string) => void;
}): Component {
  /** The rows drawn, and how many more wait. */
  const shown = () => {
    const all = banner(rooms, view());
    if (all.length <= MOST) return { rows: all, more: 0 };
    return { rows: all.slice(0, MOST - 1), more: all.length - MOST + 1 };
  };
  const line = (w: Wait) => {
    const r = rooms.get(w.roomId);
    const name = r ? nameOf(r.state, w.participantId) : w.participantId;
    const room = r?.entry.title ?? w.roomId;
    const why = w.why === "question" ? `asks: ${w.text}` : w.text;
    return {
      paint: w.why === "question" ? magenta : yellow,
      text: `▌● ${name} (${room}) ${why}`,
    };
  };
  return {
    render(width) {
      const { rows, more } = shown();
      const lines = rows.map((w) => {
        const { paint, text } = line(w);
        return paint(truncateToWidth(text, width, "…"));
      });
      if (more) lines.push(dim(`  +${more} more`));
      return lines;
    },
    handleMouse(e) {
      if (e.type !== "click" || e.button !== "left") return undefined;
      const w = shown().rows[e.y];
      if (w) {
        open({ roomId: w.roomId, participantId: w.participantId });
        if (w.question) question(w.question);
      }
      return { handled: true };
    },
    invalidate() {},
  };
}

export { bannerPart };
