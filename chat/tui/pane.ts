/**
 * `chat/tui/pane.ts` — the full-screen chat's side view (M4-6).
 *
 * **A view beside the timeline, not a box** (decided 2026-10-05, #204).
 * `ctrl+x` shows and hides it, as `ctrl+t` does the sidebar, and what it
 * shows stays while it is hidden. Below `WIDE` columns it takes the
 * timeline's place. It shows any diff text: a question's edit, an agent's
 * checkout, and later the diff a merge hands in (M6-11a, M6-11b). Before
 * anything is put in it, it says how to fill it. M4-13 puts a terminal in
 * the same place.
 *
 * **Many files are one scroll.** The title names the file at the top of the
 * pane, `2 of 20`, and `]` and `[` jump between files. Each diff line is one
 * row, cut at the pane's width, so a file starts at a known row.
 *
 * **It has the keys when it is shown**: ↑↓ and page keys scroll, and the
 * content adds its own (`y` and `n` for a question; `b` and `r` for an
 * agent's changes). Esc and `ctrl+]` give the keys to the composer, and
 * `ctrl+]` takes them back, so a message goes out while the view stays; its
 * single-letter keys would otherwise type into both. The text it is given is
 * already drawable (`cleanDiff`).
 */

import {
  type Component,
  Key,
  matchesKey,
  ScrollView,
  type TuiAltScreen,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import type { Diff } from "../../client/contract.ts";
import { type DiffFile, filesOf, named } from "../../client/diff.ts";
import { bold, cyan, dim, green, red } from "../common.ts";

/** At this many columns the pane sits beside the timeline; below, it takes
 *  the timeline's place. */
const WIDE = 120;

/** What the pane shows, and the keys that act on it. */
interface PaneContent {
  /** What the diff is of, before the file: `bob · uncommitted`. */
  title: string;
  diff: Diff;
  /** The content's own keys, after scrolling, `]` and `[`. */
  keys: { key: string; hint: string; run: () => void }[];
  /** Esc, after the keys go back to the composer. */
  back?: () => void;
  /** The question it shows, while that question is open. */
  question?: string;
}

/** What the view says before anything is put in it. */
const EMPTY = [
  "nothing here yet",
  "/diff @name   what an agent changed",
  "view diff     in a question",
];

/** A diff line in git's colours. */
const paint = (line: string) => {
  if (line.startsWith("diff --git ")) return bold(line);
  if (line.startsWith("@@")) return cyan(line);
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return bold(line);
  if (line.startsWith("+")) return green(line);
  if (line.startsWith("-")) return red(line);
  if (line.startsWith("… ")) return dim(line);
  return line;
};

/** The side view, and how to fill, show and hide it. `editor` gets the
 *  keys back when it hides; `setStatus` is the screen's; `gutter` is how
 *  many columns the sidebar takes. */
function paneParts({
  tui,
  editor,
  setStatus,
  gutter,
}: {
  tui: TuiAltScreen;
  editor: Component;
  setStatus: () => void;
  gutter: () => number;
}) {
  const wide = () => (process.stdout.columns || 80) >= WIDE;
  /** The view's width in columns: half of what the sidebar leaves, or all
   *  of it on a narrow screen. The screen sets it as the view's size, so
   *  pi-tui never measures the lines to find it. */
  const columns = () => {
    const left = (process.stdout.columns || 80) - gutter();
    return Math.max(1, wide() ? Math.floor(left / 2) : left);
  };
  let content: PaneContent | undefined;
  let lines: string[] = EMPTY;
  let files: DiffFile[] = [];
  /** Whether the view is drawn, and whether it has the keys. */
  let shown = false;
  let focused = false;

  /** The file `]` or `[` picked, until the person scrolls: a diff that
   *  fits the pane cannot scroll to its next file. */
  let picked: number | undefined;
  /** The file the title names: the one picked, or the one at the top. */
  const current = () => {
    if (picked !== undefined) return picked;
    let at = 0;
    for (const [i, f] of files.entries())
      if (f.line <= scroll.scrollTop) at = i;
    return at;
  };
  const jump = (to: number) => {
    const f = files[to];
    if (!f) return;
    picked = to;
    scroll.scrollTo(f.line, { disableFollow: true });
    tui.requestRender();
  };

  /** The drawn lines and the width they were drawn at. A large diff takes
   *  half a second to draw (10,000 lines, measured), and the screen draws on
   *  every key and every streamed chunk, so only a new text or a new width
   *  draws it again. */
  let drawn: { lines: string[]; inner: number; out: string[] } | undefined;
  const body: Component = {
    render: (w) => {
      const inner = Math.max(1, w - 2);
      if (drawn?.lines === lines && drawn.inner === inner) return drawn.out;
      const draw = content ? paint : dim;
      const out = lines.map(
        (l) => `${dim("│")} ${draw(truncateToWidth(l, inner, "…"))}`,
      );
      drawn = { lines, inner, out };
      return out;
    },
    handleInput(key) {
      const page = Math.max(1, scroll.viewportHeight - 1);
      if (matchesKey(key, Key.escape)) {
        focus(false);
        return content?.back?.();
      }
      if (matchesKey(key, Key.up)) scroll.scrollBy(-1);
      else if (matchesKey(key, Key.down)) scroll.scrollBy(1);
      else if (matchesKey(key, Key.pageUp)) scroll.scrollBy(-page);
      else if (matchesKey(key, Key.pageDown)) scroll.scrollBy(page);
      else if (key === "]") return jump(current() + 1);
      else if (key === "[") {
        // Back to this file's start, or to the one before when there.
        const at = current();
        const inside =
          picked === undefined && (files[at]?.line ?? 0) < scroll.scrollTop;
        return jump(inside ? at : at - 1);
      } else {
        for (const k of content?.keys ?? []) if (key === k.key) return k.run();
        return;
      }
      picked = undefined;
      tui.requestRender();
    },
    invalidate() {},
  };
  const scroll = new ScrollView(body, { follow: "none" });
  const head: Component = {
    render: (w) => {
      if (!content) {
        return [dim(truncateToWidth(`┌ side view ${"─".repeat(w)}`, w, ""))];
      }
      const d = content.diff;
      const at = current();
      const f = files[at];
      const place = d.files > 1 ? ` (${at + 1} of ${d.files})` : "";
      const where = f ? ` · ${named(f)}${place}` : " · no changes";
      const size = f ? ` · +${d.added} −${d.removed}` : "";
      const title = `┌ ${content.title}${where}${size} ${"─".repeat(w)}`;
      return [dim(truncateToWidth(title, w, ""))];
    },
    invalidate() {},
  };
  const foot: Component = {
    render: (w) => {
      const hints = content ? ["↑↓ scroll"] : [];
      if (files.length > 1) hints.push("] [ file");
      for (const k of content?.keys ?? []) hints.push(k.hint);
      hints.push("ctrl+] type", "ctrl+x hide");
      // The composer has the keys: only the way back is named.
      if (!focused)
        hints.splice(0, Infinity, "ctrl+] keys here", "ctrl+x hide");
      const hint = `└ ${hints.join(" · ")} ${"─".repeat(w)}`;
      return [dim(truncateToWidth(hint, w, ""))];
    },
    invalidate() {},
  };
  const pane = new VStack([
    { component: head, basis: "auto", shrink: 0 },
    { component: scroll, basis: "auto", grow: 1, shrink: 1, minSize: 1 },
    { component: foot, basis: "auto", shrink: 0 },
  ]);

  /** Gives the keys to the view, or to the composer (`ctrl+]`, Esc). */
  const focus = (here: boolean) => {
    if (!shown) return;
    focused = here;
    tui.setFocus(here ? body : editor);
    setStatus();
    tui.requestRender();
  };
  /** Shows the view and gives it the keys, or hides it and gives them to
   *  the composer (`ctrl+x`). What it shows stays. */
  const toggle = (show = !shown) => {
    shown = show;
    focused = show;
    tui.setFocus(show ? body : editor);
    setStatus();
    tui.requestRender();
  };

  /** Puts `c` in the view, from its first line, and shows it. */
  const fill = (c: PaneContent) => {
    content = c;
    lines = c.diff.text ? c.diff.text.split("\n") : [];
    files = filesOf(lines);
    picked = undefined;
    scroll.scrollToStart();
    toggle(true);
  };
  /** The question it shows closed: its diff stays, with how it closed in
   *  the title, and its keys go. */
  const closed = (id: string, how: string) => {
    if (content?.question !== id) return;
    content = {
      ...content,
      title: `${content.title} · ${how}`,
      keys: [],
      question: undefined,
      back: undefined,
    };
    setStatus();
    tui.requestRender();
  };

  return {
    pane,
    fill,
    closed,
    toggle,
    focus,
    /** Whether the view is drawn. */
    get shown() {
      return shown;
    },
    /** Whether the view is drawn and has the keys. */
    get focused() {
      return shown && focused;
    },
    /** One key for the view. The screen sends it every key while the view
     *  has them: pi-tui's screen would take the page keys for the timeline. */
    key: (data: string) => body.handleInput?.(data),
    /** What the view shows, shown or hidden. */
    get content() {
      return content;
    },
    /** Whether the timeline is drawn beside the view. */
    wide,
    columns,
  };
}

export { paneParts };
