/**
 * `chat/tui/rail.ts` — the history rail beside the transcript (M7-7).
 *
 * The rail has one equally spaced `●` per history message, between `▲` and
 * `▼`. It is deliberately not proportional: a long answer changes no mark's
 * place. The active mark is the last one at or above the viewport top, and
 * is a lighter dot than the dim marks around it. The visible marks form a
 * sliding window around it, pinned to the tail at the end unless that would
 * leave the active mark out. Clicking a mark jumps the transcript to that
 * entry. The chevrons move to the previous or next mark from the active one.
 *
 * Hover is mouse only. After 150 ms on a mark, a non-capturing card to its
 * left shows up to two wrapped lines from the same `historyRow()` text as
 * the side history list. Moving to another mark replaces it; leaving the
 * rail, scrolling, switching views or hiding the rail closes it. A terminal
 * that sends no move events simply never opens the card.
 *
 * **The virtual model is the only source of row positions.** The rail reads
 * the model's ordered message index and top offsets; it never walks the
 * reducer timeline, resolves components or sums rows per frame.
 */

import {
  type Component,
  type OverlayHandle,
  type ScrollView,
  type TuiAltScreen,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Entry } from "../../client/room.ts";
import { bold, dim, fg } from "../common.ts";
import {
  activeMark,
  historyPreview,
  type Message,
  type RailWindow,
  railHit,
  railNeighbour,
  railWindow,
} from "../view.ts";
import { NARROW } from "./sidebar.ts";
import type { TranscriptRailModel } from "./transcript.ts";

const UP = "▲ ";
const DOWN = "▼ ";
const MARK = "● ";
const CARD_WIDTH = 40;
const HOVER_MS = 150;

interface Screen {
  width: number;
  height: number;
}

interface DrawFrame {
  active: number;
  window: RailWindow;
  rows: number;
  count: number;
}

/** The rail's cursor for a preview card. */
interface Pointer {
  railLeft: number;
  screenY: number;
  row: number;
}

// The render, hit test, hover timer, card and cleanup share one cursor and
// overlay, so splitting them would scatter that state.
// pi-lens-ignore: high-complexity, high-fan-out
function railParts({
  tui,
  scroll,
  model,
  viewportRows,
  jump,
  text,
  terminal = () => ({
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
  }),
  delay = HOVER_MS,
}: {
  tui: TuiAltScreen;
  scroll: ScrollView;
  model: () => TranscriptRailModel | undefined;
  viewportRows: () => number;
  jump: (entry: Entry) => void;
  text: (entry: Message) => string;
  terminal?: () => Screen;
  delay?: number;
}) {
  let draw: DrawFrame | undefined;
  let pending: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let preview: { at: number; overlay: OverlayHandle } | undefined;
  let pointer: Pointer | undefined;

  const rows = () => {
    const n = viewportRows();
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  };
  const shown = () => {
    const current = model();
    return (
      terminal().width >= NARROW &&
      rows() >= 3 &&
      (current?.markCount ?? 0) >= 2
    );
  };

  /** Hides the card and cancels a pending one. Returns whether anything
   *  changed, so a caller outside a render can ask for a frame. */
  const hide = () => {
    const had = pending !== undefined || timer !== undefined || preview;
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
    pointer = undefined;
    preview?.overlay.hide();
    preview = undefined;
    return Boolean(had);
  };
  const close = () => {
    if (hide()) tui.requestRender();
  };

  const card = (lines: string[]): Component => ({
    render(w) {
      const inner = Math.max(1, w - 2);
      const title = " history ";
      const top = truncateToWidth(title + "─".repeat(inner), inner, "─", true);
      const body = lines.map(
        (line) => `│${truncateToWidth(line, inner, "…", true)}│`,
      );
      return [`┌${top}┐`, ...body, `└${"─".repeat(inner)}┘`];
    },
    handleMouse(e) {
      close();
      if (e.type === "wheel" && e.wheelDelta) {
        scroll.scrollBy(e.wheelDelta);
        tui.requestRender();
      }
      // A pi-tui overlay hit already stops the event here, even when a
      // handler returns undefined, so the click cannot reach the transcript.
      return { handled: true };
    },
    invalidate() {},
  });

  const show = (at: number) => {
    const want = pending;
    timer = undefined;
    pending = undefined;
    if (want !== at || !shown()) return;
    const current = model();
    const entry = current?.markEntry(at);
    const where = pointer;
    if (!current || !entry || !where) return;
    const screen = terminal();
    const width = Math.min(CARD_WIDTH, Math.max(12, where.railLeft - 2));
    const lines = historyPreview(text(entry), Math.max(1, width - 2));
    const height = lines.length + 2;
    const overlay = tui.showOverlay(card(lines), {
      width,
      row: Math.max(0, Math.min(screen.height - height, where.screenY - 1)),
      col: Math.max(0, where.railLeft - width - 1),
      maxHeight: height,
      nonCapturing: true,
    });
    preview = { at, overlay };
    pending = undefined;
  };

  const schedule = (at: number, e: TuiMouseEvent) => {
    const next = {
      railLeft: e.screenX - e.x,
      screenY: e.screenY,
      row: e.y,
    };
    if (preview?.at === at || pending === at) {
      pointer = next;
      return;
    }
    close();
    pointer = next;
    pending = at;
    timer = setTimeout(() => show(at), delay);
  };

  const rail: Component = {
    render() {
      const current = model();
      const height = rows();
      if (!current || !shown()) {
        draw = undefined;
        hide();
        return [];
      }
      const count = current.markCount;
      const active = activeMark(
        count,
        (at) => current.markTop(at) ?? 0,
        scroll.scrollTop,
      );
      if (active === undefined) {
        draw = undefined;
        return [];
      }
      const window = railWindow(count, active, height, scroll.isFollowingEnd);
      const next = { active, window, rows: height, count };
      // A card names the mark under the pointer when it opened. If a new
      // message, a banner row, a resize or a scroll moves another mark under
      // that row, the card is stale: hide it until the pointer moves again.
      if (draw && pointer) {
        const before = railHit(draw.window, draw.rows, pointer.row);
        const after = railHit(next.window, next.rows, pointer.row);
        if (
          before?.kind !== "mark" ||
          after?.kind !== "mark" ||
          before.at !== after.at
        )
          // Remove it before this frame composites; close() would ask for
          // another render from inside the current one.
          hide();
      }
      draw = next;
      const lines = [dim(UP)];
      for (let at = window.start; at < window.end; at++) {
        lines.push(at === active ? bold(fg(255)(MARK)) : dim(MARK));
      }
      while (lines.length < height - 1) lines.push("  ");
      lines.push(dim(DOWN));
      return lines;
    },
    handleMouse(e) {
      if (e.type === "wheel") {
        close();
        // Unhandled, so pi-tui's primary ScrollView still gets the wheel.
        return undefined;
      }
      if (e.type !== "move" && e.type !== "click") return undefined;
      const frame = draw;
      const hit = frame && railHit(frame.window, frame.rows, e.y);
      if (!hit) {
        close();
        return { handled: true };
      }
      if (e.type === "move") {
        if (hit.kind === "mark") {
          schedule(hit.at, e);
        } else {
          close();
        }
        return { handled: true };
      }
      close();
      const at =
        hit.kind === "mark"
          ? hit.at
          : railNeighbour(frame.count, frame.active, hit.kind === "up");
      if (at !== undefined) {
        const entry = model()?.markEntry(at);
        if (entry) jump(entry);
      }
      return { handled: true };
    },
    invalidate() {},
  };

  /** A move or wheel outside the rail. The root layout calls this when no
   *  deeper component has taken the event. */
  const miss = (e: TuiMouseEvent) => {
    if (e.type === "move" || e.type === "wheel") close();
  };

  /** Closes the card as soon as the rail's visibility rules turn it off. */
  const sync = () => {
    if (!shown()) close();
  };

  return { rail, close, miss, shown, sync };
}

export { railParts };
