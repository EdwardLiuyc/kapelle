/**
 * `chat/tui/sidebar.ts` — the full-screen chat's sidebar (M4-12).
 *
 * The list of rooms and their participants on the left, the `»` strip that
 * stands in for it while it is hidden, and the marks: `●` when something
 * waits, magenta for a question and yellow for a stall. Which rows there are
 * is `chat/view.ts`; this file draws them and reads a click.
 */

import { basename } from "node:path";

import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
  needsAttention,
  questionOf,
  type RoomState,
  roster,
} from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { dim, magenta, plain, yellow } from "../common.ts";
import { rows, same, type View } from "../view.ts";

/** Whether a question from this participant waits. */
const asks = (state: RoomState, id: string) =>
  questionOf(state, id) !== undefined;

/** The sidebar's width, in columns. */
const SIDEBAR_WIDTH = 26;
/** Below this many columns the sidebar starts hidden. */
const NARROW = 70;

/** A participant's mark: `●` when something waits, coloured by why.
 *  Colour only says why a participant needs the person: magenta for a
 *  question, yellow for a stall. The circle says that something waits. */
const mark = (state: RoomState, id: string) => {
  const p = state.participants.get(id);
  const waits = Boolean(p?.unread) || needsAttention(state, id);
  const paint = asks(state, id) ? magenta : p?.stalled ? yellow : plain;
  return { circle: waits ? "●" : "○", paint };
};
/** A room's mark: its most urgent participant's. */
const roomMark = (state: RoomState) => {
  const ps = roster(state);
  const waits = ps.some((p) => mark(state, p.id).circle === "●");
  const paint = ps.some((p) => asks(state, p.id))
    ? magenta
    : ps.some((p) => p.stalled)
      ? yellow
      : plain;
  return { circle: waits ? "●" : "○", paint };
};

/** The sidebar and the strip. The view is read at each draw; `toggle` and
 *  `open` are the screen's. */
function sidebarParts({
  rooms,
  view,
  toggle,
  open,
}: {
  rooms: ReadonlyMap<string, Followed>;
  view: () => View;
  toggle: () => void;
  open: (next: View) => void;
}) {
  // ponytail: no scrolling in the sidebar; rows past the screen's height are
  // cut. Put it in a ScrollView when rooms outgrow a screen.
  const sidebar: Component = {
    render(width) {
      // pi-tui measures each part at the full width first, so this can be
      // any width, not only the sidebar's own 26.
      const inner = Math.max(0, width - 2);
      const fit = (s: string) =>
        `${truncateToWidth(s, inner, "…", true)} ${dim("│")}`;
      const lines = [
        fit(`${dim("rooms")}${" ".repeat(Math.max(0, inner - 6))}«`),
      ];
      for (const row of rows(rooms)) {
        const r = rooms.get(row.roomId);
        if (!r) continue;
        const cursor = same(row, view()) ? "▸" : " ";
        if (!row.participantId) {
          const { circle, paint } = roomMark(r.state);
          const label = r.entry.title ?? r.entry.id;
          const lost = r.lost ? yellow(" !") : "";
          const paused = r.entry.status === "paused" ? dim(" paused") : "";
          lines.push(
            fit(
              `${cursor} ${paint(`${circle} ${label}`)} ${dim(basename(r.entry.cwd))}${paused}${lost}`,
            ),
          );
          continue;
        }
        const p = r.state.participants.get(row.participantId);
        if (!p) continue;
        const { circle, paint } = mark(r.state, p.id);
        const star = p.role === "orchestrator" ? " ★" : "";
        // After a restart (M6-7a): `killed` stopped during a turn, so its
        // files and its memory may not match.
        let busy = "";
        if (p.status === "busy") busy = " …";
        else if (p.status === "paused") busy = dim(" paused");
        else if (p.status === "killed") busy = yellow(" killed");
        const unread = p.unread ? ` ${p.unread}` : "";
        lines.push(
          fit(
            `${cursor}   ${paint(`${circle} ${p.name}`)}${star}${busy}${unread}`,
          ),
        );
      }
      // Full height, so the border reaches the status line.
      while (lines.length < (process.stdout.rows || 24)) lines.push(fit(""));
      return lines;
    },
    handleMouse(e) {
      if (e.type !== "click" || e.button !== "left") return undefined;
      if (e.y === 0) {
        if (e.x >= e.width - 4) toggle();
        return { handled: true };
      }
      const row = rows(rooms)[e.y - 1];
      if (row) open(row);
      return { handled: true };
    },
    invalidate() {},
  };
  /** What stands in for the sidebar while it is hidden. */
  const strip: Component = {
    render: () => ["»"],
    handleMouse(e) {
      if (e.type !== "click" || e.button !== "left") return undefined;
      toggle();
      return { handled: true };
    },
    invalidate() {},
  };
  return { sidebar, strip };
}

export { NARROW, roomMark, SIDEBAR_WIDTH, sidebarParts };
