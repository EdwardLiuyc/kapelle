/**
 * `chat/tui/sidebar.ts` — the full-screen chat's sidebar (M4-12).
 *
 * The list of rooms and their participants on the left, the `»` strip that
 * stands in for it while it is hidden, and the state marks (M7-3): `?` asks,
 * `!` stalls, `◐` busy, `⏸` paused, `✕` killed, `◌` exited, `●` unread, `○`
 * nothing new. An agent's row paints its mark and name in its colour, shows
 * the harness dim, and puts its busy timer on the right; an idle unread
 * agent's right side is its unread count instead. The changed-files block
 * sits under the rooms for the open thread.
 *
 * A room row takes its most urgent participant's mark, `?` > `!` > `✕` >
 * `⏸` > `◌` > `●` > `◐` > `○` (decided 2026-10-11). The strip shows the
 * open room's mark. Which rows there are is `chat/view.ts`; this file draws
 * them, draws the files, and reads a click.
 */

import { basename } from "node:path";

import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Diff } from "../../client/contract.ts";
import { changesOf, type FileChange } from "../../client/diff.ts";
import {
  needsAttention,
  questionOf,
  type RoomState,
  roster,
} from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { dim, fg, magenta, plain, yellow } from "../common.ts";
import { clock, colourOf, rows, same, type View } from "../view.ts";

/** The sidebar's width, in columns. */
const SIDEBAR_WIDTH = 26;
/** Below this many columns the sidebar starts hidden. */
const NARROW = 70;

/** One participant's state. */
type Participant = NonNullable<ReturnType<RoomState["participants"]["get"]>>;

/** A state mark: its glyph, how it paints what it is drawn on, and whether
 *  something new or waiting is behind it. */
interface Mark {
  glyph: "?" | "!" | "◐" | "⏸" | "✕" | "◌" | "●" | "○";
  paint: (s: string) => string;
  /** The hidden-sidebar room count in `chat/tui.ts` uses this. */
  waits: boolean;
}

/** The room row's urgency order (decided 2026-10-11). */
const URGENCY: readonly Mark["glyph"][] = [
  "?",
  "!",
  "✕",
  "⏸",
  "◌",
  "●",
  "◐",
  "○",
];

/** A participant's mark: asks, stalls, then its status, then unread. */
const mark = (state: RoomState, id: string): Mark => {
  const p = state.participants.get(id);
  if (!p) return { glyph: "○", paint: plain, waits: false };
  const waits = Boolean(p.unread) || needsAttention(state, id);
  if (questionOf(state, id)) return { glyph: "?", paint: magenta, waits: true };
  if (p.stalled) return { glyph: "!", paint: yellow, waits: true };
  const colour = colourOf(state, id);
  const tint = colour === undefined ? plain : fg(colour);
  if (p.status === "busy") return { glyph: "◐", paint: tint, waits };
  if (p.status === "paused") return { glyph: "⏸", paint: tint, waits };
  if (p.status === "killed") return { glyph: "✕", paint: yellow, waits };
  if (p.status === "exited") return { glyph: "◌", paint: tint, waits };
  return { glyph: p.unread ? "●" : "○", paint: tint, waits };
};

/** How a room row paints the glyph: why it waits, never an agent's colour. */
const roomPaint = (glyph: Mark["glyph"]) =>
  glyph === "?" ? magenta : glyph === "!" || glyph === "✕" ? yellow : plain;

/** A room's mark: its most urgent participant's (decided 2026-10-11). */
const roomMark = (state: RoomState): Mark => {
  const marks = roster(state).map((p) => mark(state, p.id));
  const at = (m: Mark) => URGENCY.indexOf(m.glyph);
  const first = marks.reduce<Mark | undefined>(
    (best, m) => (best && at(best) <= at(m) ? best : m),
    undefined,
  );
  if (!first) return { glyph: "○", paint: plain, waits: false };
  return {
    ...first,
    paint: roomPaint(first.glyph),
    waits: marks.some((m) => m.waits),
  };
};

/** The end of `path` that fits `room`, with a leading `…` when it was cut:
 *  a long path keeps its basename. */
const tailPath = (path: string, room: number) => {
  if (room <= 0) return "";
  if (visibleWidth(path) <= room) return path;
  let out = "";
  for (const ch of [...path].reverse()) {
    if (visibleWidth(`…${ch}${out}`) > room) break;
    out = `${ch}${out}`;
  }
  return `…${out}`;
};

/** A changed-file row: `M path +a −d`, the counts kept and the path cut at
 *  its front. The file the 512 KB cut goes through, and one with no hunk
 *  (binary, mode-only), has no counts (M7-3). */
const changeLine = (f: FileChange, inner: number) => {
  const counts =
    f.added === undefined ||
    f.removed === undefined ||
    (f.added === 0 && f.removed === 0)
      ? ""
      : ` +${f.added} −${f.removed}`;
  const room = Math.max(0, inner - 4 - visibleWidth(counts));
  const path = tailPath(f.path, room);
  const pad = " ".repeat(Math.max(0, room - visibleWidth(path)));
  return `  ${f.letter} ${path}${pad}${counts}`;
};

/**
 * The sidebar and the strip. The view is read at each draw; `toggle` and
 * `open` are the screen's. `changes` is the open thread's last diff,
 * `openFile` opens one of its files in the side pane, and `now` is the
 * clock, for a test.
 */
function sidebarParts({
  rooms,
  view,
  toggle,
  open,
  changes = () => undefined,
  openFile = () => {},
  height = () => process.stdout.rows || 24,
  now = Date.now,
}: {
  rooms: ReadonlyMap<string, Followed>;
  view: () => View;
  toggle: () => void;
  open: (next: View) => void;
  changes?: () => Diff | undefined;
  openFile?: (f: FileChange) => void;
  height?: () => number;
  now?: () => number;
}) {
  /** A participant's one row. The mark and name are one painted piece, so
   *  a colour never splits them. */
  const agentLine = (
    state: RoomState,
    p: Participant,
    cursor: string,
    inner: number,
  ) => {
    const m = mark(state, p.id);
    const star = p.role === "orchestrator" ? " ★" : "";
    const start = Date.parse(p.turns.at(-1)?.start ?? "");
    const right =
      p.status === "busy" && !Number.isNaN(start)
        ? clock(now() - start)
        : p.unread
          ? String(p.unread)
          : "";
    const tail = right ? ` ${right}` : "";
    // The name's room: the row, less the cursor, the glyph, the star and
    // the timer.
    const room = Math.max(
      0,
      inner - 6 - visibleWidth(star) - visibleWidth(tail),
    );
    const name = truncateToWidth(p.name, room, "…");
    const head = `${cursor}   ${m.paint(`${m.glyph} ${name}`)}${star}`;
    // The harness gives way first.
    const harnessRoom = inner - visibleWidth(head) - visibleWidth(tail) - 1;
    const harness =
      harnessRoom >= 1
        ? ` ${dim(truncateToWidth(p.harness, harnessRoom, "…"))}`
        : "";
    const line = head + harness;
    return (
      line +
      " ".repeat(Math.max(0, inner - visibleWidth(line) - visibleWidth(tail))) +
      tail
    );
  };

  /** The parsed changed files, by diff identity: a frame must not
   *  re-parse a 512 KB text. */
  let parsed: { diff: Diff; all: FileChange[] } | undefined;

  /** Every sidebar row, the changed-files block included. Told with the
   *  file rows a click can open, and where the block starts. */
  const draw = (inner: number) => {
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
        const m = roomMark(r.state);
        const label = r.entry.title ?? r.entry.id;
        const lost = r.lost ? yellow(" lost") : "";
        const paused = r.entry.status === "paused" ? dim(" paused") : "";
        lines.push(
          fit(
            `${cursor} ${m.paint(m.glyph)} ${label} ${dim(basename(r.entry.cwd))}${paused}${lost}`,
          ),
        );
        continue;
      }
      const p = r.state.participants.get(row.participantId);
      if (!p) continue;
      lines.push(fit(agentLine(r.state, p, cursor, inner)));
    }
    // The changed files, under the rooms (M7-3). `more` is the route's own
    // `files` count, so a 512 KB cut still says how many it lost.
    const files: FileChange[] = [];
    let heading = -1;
    let last = -1;
    const d = changes();
    if (d?.text && d.files > 0) {
      // Parse once per diff: `draw` runs on every frame and click.
      if (parsed?.diff !== d) {
        parsed = { diff: d, all: changesOf(d.text.split("\n")) };
      }
      const all = parsed.all;
      // The heading and a `+n more` row are rows too: both come out of the
      // sidebar's visible height.
      const free = height() - lines.length;
      if (all.length && free >= 2) {
        heading = lines.length;
        lines.push(fit(dim("changed files")));
        const whole = d.files <= all.length && all.length <= free - 1;
        const show = whole ? all.length : Math.max(0, free - 2);
        files.push(...all.slice(0, show));
        for (const f of files) lines.push(fit(changeLine(f, inner)));
        const more = d.files - files.length;
        if (more > 0) lines.push(fit(dim(`  +${more} more`)));
        last = lines.length - 1;
      }
    }
    return { lines, heading, last, files };
  };

  const sidebar: Component = {
    render(width) {
      // pi-tui measures each part at the full width first, so this can be
      // any width, not only the sidebar's own 26.
      const inner = Math.max(0, width - 2);
      const { lines } = draw(inner);
      // Full height, so the border reaches the status line.
      while (lines.length < (process.stdout.rows || 24)) {
        lines.push(`${" ".repeat(inner)} ${dim("│")}`);
      }
      return lines;
    },
    handleMouse(e) {
      if (e.type !== "click" || e.button !== "left") return undefined;
      if (e.y === 0) {
        if (e.x >= e.width - 4) toggle();
        return { handled: true };
      }
      const { heading, last, files } = draw(SIDEBAR_WIDTH - 2);
      if (e.y > heading && heading >= 0 && e.y <= last) {
        const f = files[e.y - heading - 1];
        if (f) openFile(f);
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
    render: () => {
      const r = rooms.get(view().roomId);
      if (!r) return ["»"];
      const m = roomMark(r.state);
      return [`»${m.paint(m.glyph)}`];
    },
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
