/**
 * `chat/tui/transcript.ts` — the full-screen chat's transcript (M4-12).
 *
 * Draws the current view from its room's reducer: a heading per speaker,
 * each answer as markdown while it streams, a tool call, a question and how
 * it closed, and the notices. An agent's heading, answers and tool calls
 * get a `▎` bar in its colour, and its heading shows its harness, its role
 * and the time (M7-1). The person's own messages get a grey bar and a light
 * background. It owns the components drawn for the view, so
 * an answer's next chunk re-sets the same one, and the history list can
 * scroll to a message of the person's (M4-4).
 *
 * **Tool runs fold** (M7-2). A tool call gets a status background and a
 * coloured empty row above and below it: neutral while open, green when
 * completed, red when failed. Completed and failed calls end with `✓` or
 * `✗`, a live one gets a spinner, and an edit shows `+a −d`. Uncoloured
 * empty rows separate calls and follow the last one. When the agent's next
 * note comes, or its turn ends, its tool calls since the last note fold
 * into one line at the run's first place; `chat/view.ts` says which.
 * A click on the line opens the run, and a second folds it. A fold above
 * the rows the person reads keeps them where they are. A question never
 * folds.
 *
 * **The scrollbar is pi-tui's** (M7-6, pi-tui 1.1.0). `auto` paints it over
 * the last column while the person scrolls, then hides it, so no line
 * rewraps. pi-tui drags it and jumps on a track click. The track is dim and
 * the resting thumb inverse. A hover draws the thumb as `█`; that block
 * stays plain because inverse would paint it in the background colour. A
 * bump re-checks, in pi-tui's `dist/`: `getContentWidth()` and the 1000 ms
 * hide delay in `components/scroll-view.js`; `paintScrollbar()` in
 * `layout.js`, which picks the glyph and styles one cell per call; and
 * `handleScrollbarMouseEvent()` in `tui-alt-screen.js`, which sets hover.
 * The transcript also writes `Container`'s private `mouseLayout` in
 * `tui.js`; a shape change there silently stops every transcript click.
 * A status's mark changes with its background, so `setText` invalidates the
 * wrap. If those marks ever go, `line()` also relies on
 * `Text.setCustomBgFn()` in `components/text.js` invalidating it.
 *
 * **The transcript is virtual** (#323). `VirtualTranscriptModel` keeps one
 * item per drawn entry and a Fenwick tree of heights. Only the viewport and
 * its row margin get pi-tui parts; blank rows keep the `ScrollView`'s full
 * content height. `jump` and the history list use the model's top offset;
 * `entryAt` is its reverse row query. An answer outside the window is only
 * invalidated, never re-rendered, so a streamed chunk cannot re-parse it.
 * The reducer timeline still owns the data, so process memory still grows
 * with it. The model also keeps the ordered message items, so the M7-7 rail
 * reads their tops without walking the timeline. On exit `render(..., true)`
 * walks every item once for scrollback.
 */

import {
  type Component,
  Container,
  Markdown,
  type MarkdownTheme,
  ScrollView,
  Spacer,
  Text,
  type TuiAltScreen,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  type Entry,
  nameOf,
  printable,
  type RoomState,
  senderOf,
  thread,
} from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import {
  bg,
  bgRgb,
  bold,
  cyan,
  dim,
  endedLine,
  fg,
  green,
  inverse,
  italic,
  magenta,
  red,
  revivedLine,
  sgr,
  underline,
  yellow,
} from "../common.ts";
import {
  colourOf,
  isMessage,
  type Message,
  type Run,
  runs,
  runText,
  spin,
  type View,
} from "../view.ts";

const MARKDOWN_THEME: MarkdownTheme = {
  heading: (s) => bold(cyan(s)),
  link: (s) => underline(cyan(s)),
  linkUrl: dim,
  code: yellow,
  codeBlock: (s) => s,
  codeBlockBorder: dim,
  quote: italic,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic,
  strikethrough: sgr(9, 29),
  underline,
};

/**
 * Where a streamed answer's finished blocks end (M4-4): the start of the
 * last line at or after `from` that follows a blank line, is not indented,
 * and is outside a code fence and a `$$` math block. `from` when there is
 * none. Markdown cut there draws as it does whole, so the text before it is
 * parsed once, and a chunk re-parses only the rest: a whole 53k-char answer
 * took 13 to 23 ms per frame (§M4-4).
 *
 * Never right after a line with `$$`: pi-tui draws a math block with no
 * blank row after it when it ends a text, so the gap to the next block
 * would be lost.
 *
 * The scan starts at `from` with no fence or math block open. That holds
 * because `from` is always 0 or a cut, and a cut is never inside either.
 */
// ponytail: a fence is any ``` or ~~~ line, and a reference link defined
// below its use is drawn as text in a finished block. Use marked's lexer if
// either shows up.
export function settled(text: string, from: number): number {
  let cut = from;
  let fenced = false;
  /** Inside a `$$` block: an odd count of `$$` opens or closes one. */
  let math = false;
  /** The last line that is not blank holds `$$`. */
  let afterMath = false;
  let blank = false;
  let at = from;
  for (const line of text.slice(from).split("\n")) {
    if (!fenced && !math && !afterMath && blank && /^\S/.test(line)) cut = at;
    if (!math && /^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && (line.split("$$").length - 1) % 2) math = !math;
    if (line.trim()) afterMath = !fenced && line.includes("$$");
    blank = line.trim() === "";
    at += line.length + 1;
  }
  return cut;
}

/** A part with a `▎` bar in `paint` before each of its rows (M7-1). */
// It inherits Container so click offsets stay in pi-tui's own mouse tree.
// pi-lens-ignore: large-class
class Barred extends Container {
  paint: (s: string) => string;
  constructor(c: Component, paint: (s: string) => string) {
    super();
    this.paint = paint;
    this.addChild(c);
  }
  override render(width: number) {
    const bar = this.paint("▎");
    return super.render(Math.max(1, width - 1)).map((l) => bar + l);
  }
  /** A click reaches the part at the width it was drawn at (M7-2). */
  override handleMouse(e: TuiMouseEvent) {
    return super.handleMouse({
      ...e,
      x: e.x - 1,
      width: Math.max(1, e.width - 1),
    });
  }
}
const barred = (c: Component, paint: (s: string) => string) =>
  new Barred(c, paint);

/** A copied selection without the bar each `Barred` row starts with, and
 *  the one cell of padding after it. Only once a line: a `▎` the person
 *  typed stays. A selection that starts after the bar, on text that starts
 *  with `▎`, loses that one `▎`. */
export const unbar = (text: string) => text.replace(/^▎ ?/gm, "");

/** A line's time, as `HH:MM` here; "" for a time that does not parse. */
const hhmm = (at: string) => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return Number.isNaN(d.getTime())
    ? ""
    : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The person's bar and background: grey, and one step lighter than a
 *  dark terminal. */
const YOU_BAR = fg(244);
const YOU_BG = bg(236);
/** Active calls deliberately reuse the person's neutral background. */
const TOOL_ACTIVE_BG = YOU_BG;
/** Match pi's dark-theme green and pi-tui's 256-colour fallback. */
const TOOL_SUCCESS_BG = bgRgb(37, 65, 49, 23);
const TOOL_FAILURE_BG = bg(52);

type Tool = Extract<Entry, { type: "tool" }>;

/** A tool call's rows: its title, its diff's `+a −d`, its mark, and its
 *  detail under it (M7-2). Completion colours all of them, not just the
 *  first line. The spinner shows only while `live`: a call left open after
 *  its turn gets no mark. The bar before them is the
 *  agent's (M7-1). A title or a detail can be several lines (#351); the
 *  counts and the mark stay on the first, and the rest line up under it.
 *  On the first by choice, not by constraint: they sit with the `$`, so a
 *  call reads the same whether its title is one line or four. `toolRow`
 *  joins these rows into one `Text`, so the last row would cost nothing
 *  either (#361 review). */
function toolLines(e: Tool, live: boolean, now: number) {
  const counts =
    e.added === undefined
      ? ""
      : ` ${green(`+${e.added}`)} ${red(`−${e.removed ?? 0}`)}`;
  let mark = "";
  if (e.status === "completed") mark = green(" ✓");
  else if (e.status === "failed") mark = red(" ✗");
  else if (live) mark = ` ${spin(now)}`;
  const under = (lines: string[]) => lines.map((l) => `  ${l}`);
  const [head = "", ...rest] = e.title.split("\n");
  const rows = [`${bold("$")} ${head}${counts}${mark}`, ...under(rest)];
  if (e.detail) rows.push(...under(e.detail.split("\n")));
  return rows;
}

/** A run summary's counts, rebuilt only when its calls change: `runText`
 *  walks every call, and the summary is drawn on every frame. */
const runSummaries = new WeakMap<Run, { text: string; failed: number }>();
const runSummary = (run: Run) => {
  let summary = runSummaries.get(run);
  if (!summary) {
    const { text, failed } = runText(run.tools);
    summary = { text, failed };
    runSummaries.set(run, summary);
  }
  return summary;
};
function runLine(run: Run, open: boolean) {
  const { text, failed } = runSummary(run);
  return `${dim(`${open ? "▾" : "▸"} ${text}`)}${failed ? red(` · ${failed} failed`) : ""}`;
}

/** A `Text` set only when its text or background changes: both setters drop
 *  the cached wrap. */
function line(paddingY = 0) {
  const t = new Text("", 1, paddingY);
  let was = "";
  let background: ((s: string) => string) | undefined;
  return {
    render(width: number, s: string, paint?: (s: string) => string) {
      if (paint !== background) {
        background = paint;
        t.setCustomBgFn(paint);
      }
      if (s !== was) {
        was = s;
        t.setText(s);
      }
      return t.render(width);
    },
  };
}

/** Extra rows above and below the viewport. */
const WINDOW_MARGIN = 8;

/** Rows a plain string is likely to take at `width`. The real component
 *  replaces this estimate as soon as its entry is in the window. */
const estimateRows = (text: string, width: number) => {
  const columns = Math.max(1, Math.floor(width));
  let rows = 0;
  for (const line of text.split("\n"))
    rows += Math.max(1, Math.ceil(visibleWidth(line) / columns));
  return rows;
};

/** A Fenwick tree of item heights. It gives an entry's top and the entry at
 *  a row in logarithmic time, without walking the entries above it. */
// The values and tree must stay together, or a prefix sum can drift.
// pi-lens-ignore: large-class
class HeightIndex {
  private values: number[] = [];
  private tree = [0];

  get total() {
    let sum = 0;
    for (let i = this.tree.length - 1; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  push(height: number) {
    this.values.push(height);
    this.tree.push(0);
    const at = this.values.length;
    const start = at - (at & -at);
    this.tree[at] = this.prefix(at - 1) - this.prefix(start) + height;
  }

  set(at: number, height: number) {
    const delta = height - (this.values[at] ?? 0);
    this.values[at] = height;
    for (let i = at + 1; i < this.tree.length; i += i & -i)
      this.tree[i] += delta;
  }

  rebuild(values: number[]) {
    this.values = values;
    this.tree = [0, ...values];
    for (let i = 1; i < this.tree.length; i++) {
      const parent = i + (i & -i);
      if (parent < this.tree.length) this.tree[parent] += this.tree[i];
    }
  }

  /** The number of rows before item `count`. */
  prefix(count: number) {
    let sum = 0;
    for (let i = count; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  /** The item at `row`, or -1 past the end. */
  at(row: number) {
    const total = this.total;
    if (row < 0 || row >= total) return -1;
    let step = 1;
    while (step * 2 <= this.values.length) step *= 2;
    let item = 0;
    let before = 0;
    for (; step > 0; step = Math.floor(step / 2)) {
      const next = item + step;
      if (next <= this.values.length && before + this.tree[next] <= row) {
        item = next;
        before += this.tree[next];
      }
    }
    return item;
  }
}

interface BuiltItem {
  parts: Component[];
  update?: () => void;
}

interface ItemSpec {
  make: () => BuiltItem;
  estimate: (width: number) => number;
  /** Rows before the entry's first clickable/history row, as in a user
   *  message's gap. */
  anchor?: number;
  /** Advances reducer state that is split into parts, such as an answer's
   *  settled Markdown blocks, even while the item is off screen. */
  advance?: () => void;
  run?: Run;
}

interface Item extends ItemSpec {
  entry?: Entry;
  index: number;
  height: number;
  measured: boolean;
  parts?: Component[];
  update?: () => void;
}

interface Anchor {
  item: Item;
  offset: number;
}

/** What the rail may read from the virtual model. The ordered message index
 *  is built with the items, so a rail frame does not walk the timeline. */
export interface TranscriptRailModel {
  readonly markCount: number;
  markTop(at: number): number | undefined;
  markEntry(at: number): Message | undefined;
}

/** The per-view height model. Items exist for every entry, but their pi-tui
 *  parts exist only for the current window. */
// The model owns order, heights, runs and counters as one invariant.
// pi-lens-ignore: large-class
class VirtualTranscriptModel implements TranscriptRailModel {
  readonly items: Item[] = [];
  readonly byEntry = new Map<Entry, Item>();
  readonly byRun = new Map<Run, Item[]>();
  private readonly marks: Item[] = [];
  readonly stats = {
    entriesBuilt: 0,
    entriesVisited: 0,
    markTops: 0,
    partsCreated: 0,
    partsRendered: 0,
  };
  width: number;
  private heights = new HeightIndex();

  constructor(width: number) {
    this.width = width;
  }

  add(entry: Entry, spec: ItemSpec) {
    const item: Item = {
      ...spec,
      entry,
      index: this.items.length,
      height: spec.estimate(this.width),
      measured: false,
    };
    this.items.push(item);
    this.byEntry.set(entry, item);
    if (spec.run) {
      const items = this.byRun.get(spec.run) ?? [];
      items.push(item);
      this.byRun.set(spec.run, items);
    }
    if (isMessage(entry)) this.marks.push(item);
    this.heights.push(item.height);
    this.stats.entriesBuilt += 1;
    return item;
  }

  addExtra(spec: ItemSpec) {
    const item: Item = {
      ...spec,
      index: this.items.length,
      height: spec.estimate(this.width),
      measured: false,
    };
    this.items.push(item);
    this.heights.push(item.height);
    return item;
  }

  invalidate(item: Item) {
    item.measured = false;
    item.height = item.estimate(this.width);
    this.heights.set(item.index, item.height);
  }

  measure(item: Item, height: number) {
    const changed = item.height !== height;
    item.measured = true;
    item.height = height;
    this.heights.set(item.index, height);
    return changed;
  }

  setWidth(width: number) {
    if (width === this.width) return false;
    this.width = width;
    const values = this.items.map((item) => {
      item.measured = false;
      item.height = item.estimate(width);
      return item.height;
    });
    this.heights.rebuild(values);
    return true;
  }

  get total() {
    return this.heights.total;
  }

  // The private tree stays behind this one row-coordinate method.
  // pi-lens-ignore: pass-through-wrappers
  prefix(count: number) {
    return this.heights.prefix(count);
  }

  at(row: number) {
    const index = this.heights.at(row);
    return index < 0 ? undefined : this.items[index];
  }

  entryAt(row: number) {
    return this.at(row)?.entry;
  }

  topOf(entry: Entry) {
    const item = this.byEntry.get(entry);
    return item ? this.prefix(item.index) + (item.anchor ?? 0) : undefined;
  }

  get markCount() {
    return this.marks.length;
  }

  markTop(at: number) {
    const item = this.marks[at];
    if (!item) return undefined;
    this.stats.markTops += 1;
    return this.prefix(item.index) + (item.anchor ?? 0);
  }

  markEntry(at: number) {
    const entry = this.marks[at]?.entry;
    return entry && isMessage(entry) ? entry : undefined;
  }

  anchorAt(row: number): Anchor | undefined {
    const item = this.at(row);
    return item ? { item, offset: row - this.prefix(item.index) } : undefined;
  }

  rowAt(anchor: Anchor) {
    return this.prefix(anchor.item.index) + anchor.offset;
  }

  /** The items that cover the viewport and its row margin. A folded run
   *  keeps the first call's summary and any later call's heading; its other
   *  hidden calls have no rows. The row probes skip those zero-height items
   *  instead of walking all of them. */
  window(top: number, viewport: number) {
    const count = this.items.length;
    if (count === 0) return { indices: [] as number[] };
    if (!Number.isFinite(viewport)) {
      this.stats.entriesVisited += count;
      return { indices: this.items.map((_, index) => index) };
    }
    const rows = Math.max(1, Math.floor(viewport));
    const total = this.total;
    const start = Math.max(0, Math.min(total, Math.floor(top) - WINDOW_MARGIN));
    const end = Math.max(
      0,
      Math.min(total, Math.floor(top) + rows + WINDOW_MARGIN),
    );
    const indices: number[] = [];
    let previous = -1;
    for (let row = start; row < end; row++) {
      const index = this.heights.at(row);
      if (index >= 0 && index !== previous) {
        indices.push(index);
        previous = index;
      }
    }
    this.stats.entriesVisited += indices.length;
    return { indices };
  }

  resetStats() {
    this.stats.entriesVisited = 0;
    this.stats.markTops = 0;
    this.stats.partsCreated = 0;
    this.stats.partsRendered = 0;
  }
}

/** A spacer whose rows the transcript emits directly. */
// It is the zero-content component the virtual mouse layout points at.
// pi-lens-ignore: large-class
class Blank implements Component {
  height = 0;
  render() {
    return [];
  }
  invalidate() {}
}

/** The transcript keeps only the window's pi-tui parts. It still returns
 *  blank rows for the whole height so pi-tui's ScrollView can scroll it. */
// ScrollView geometry, the mounted window and measured parts are one unit.
// pi-lens-ignore: large-class
class Transcript extends Container {
  width = 80;
  model?: VirtualTranscriptModel;
  private mounted = new Set<Item>();
  private readonly topBlank = new Blank();
  private readonly bottomBlank = new Blank();
  private scroll?: ScrollView;
  private readonly viewportRows: () => number;
  private readonly requestRender: () => void;

  constructor(viewportRows: () => number, requestRender: () => void) {
    super();
    this.viewportRows = viewportRows;
    this.requestRender = requestRender;
  }

  setScroll(scroll: ScrollView) {
    this.scroll = scroll;
  }

  setModel(model: VirtualTranscriptModel) {
    this.releaseAll();
    this.model = model;
  }

  /** Bring the scroll view's height up to the model before it clamps a new
   *  row. The next layout replaces this with the exact drawn height. */
  syncScroll() {
    const model = this.model;
    const scroll = this.scroll;
    if (!model || !scroll) return;
    scroll.updateLayout(model.total, scroll.viewportHeight, () =>
      this.requestRender(),
    );
  }

  private release(item: Item) {
    item.parts = undefined;
    item.update = undefined;
  }

  private releaseAll() {
    for (const item of this.mounted) this.release(item);
    this.mounted = new Set();
  }

  private ensure(item: Item) {
    if (!item.parts) {
      const built = item.make();
      item.parts = built.parts;
      item.update = built.update;
      if (this.model) this.model.stats.partsCreated += built.parts.length;
    }
    item.update?.();
    return item.parts;
  }

  /** Measures one changed item now, so a fold above the view can keep its
   *  top row. Visible panels are cached, so the next frame draws them. */
  measure(item: Item) {
    const model = this.model;
    if (!model) return;
    let rows = 0;
    for (const part of this.ensure(item)) {
      rows += part.render(this.width).length;
      model.stats.partsRendered += 1;
    }
    model.measure(item, rows);
    if (!this.mounted.has(item)) this.release(item);
  }

  // This coordinates ScrollView geometry, the window, and measured parts.
  // `all` is for the transcript printed to scrollback on exit.
  // pi-lens-ignore: high-complexity, high-fan-out
  override render(width: number, all = false) {
    this.width = width;
    const model = this.model;
    const scroll = this.scroll;
    if (!model || !scroll) return [];

    const following = scroll.isFollowingEnd;
    const anchor =
      all || following ? undefined : model.anchorAt(scroll.scrollTop);
    model.setWidth(width);
    const viewport = Math.max(
      0,
      Math.floor(Math.max(scroll.viewportHeight || 0, this.viewportRows())),
    );
    let rows = Infinity;
    if (!all && Number.isFinite(viewport)) rows = Math.max(1, viewport);
    const maxTop = Number.isFinite(rows) ? Math.max(0, model.total - rows) : 0;
    const top = all || following ? maxTop : Math.min(scroll.scrollTop, maxTop);
    const { indices } = model.window(top, rows);
    const visible: Item[] = [];
    const output: string[] = [];
    const mouseChildren: { component: Component; height: number }[] = [];
    let measured = false;

    for (const index of indices) {
      const item = model.items[index];
      if (!item) continue;
      visible.push(item);
      const parts = this.ensure(item);
      let itemRows = 0;
      for (const part of parts) {
        const lines = part.render(width);
        model.stats.partsRendered += 1;
        for (const line of lines) output.push(line);
        itemRows += lines.length;
        mouseChildren.push({ component: part, height: lines.length });
      }
      if (model.measure(item, itemRows)) measured = true;
    }

    const next = new Set(visible);
    for (const old of this.mounted) if (!next.has(old)) this.release(old);
    this.mounted = next;

    const first = indices[0];
    const last = indices.at(-1);
    const before = first === undefined ? 0 : model.prefix(first);
    const after =
      last === undefined ? model.total : model.total - model.prefix(last + 1);
    this.topBlank.height = before;
    this.bottomBlank.height = after;
    const visibleParts = visible.flatMap((item) => item.parts ?? []);
    // `children` is only the visible parts; mouseLayout below is the map
    // Container.handleMouse dispatches through.
    this.children = [this.topBlank, ...visibleParts, this.bottomBlank];
    const rowsBefore: { component: Component; height: number }[] = [
      { component: this.topBlank, height: before },
      ...mouseChildren,
      { component: this.bottomBlank, height: after },
    ];
    // SAFETY: Container's private mouseLayout is the runtime child map its
    // click handler reads; this is that exact shape for the virtual window.
    const layout = this as unknown as {
      mouseLayout?: { width: number; children: typeof rowsBefore };
    };
    layout.mouseLayout = { width, children: rowsBefore };

    const out = new Array<string>(before + output.length + after).fill("");
    for (let i = 0; i < output.length; i++)
      out[before + i] = output[i] as string;

    if (anchor) {
      const row = model.rowAt(anchor);
      if (row !== scroll.scrollTop) {
        // A new width can make the row past what the scroll view last held.
        this.syncScroll();
        scroll.scrollTo(row, { disableFollow: true });
        this.requestRender();
      }
    }
    if (measured) this.requestRender();
    return out;
  }

  override clear() {
    super.clear();
    this.releaseAll();
    this.model = undefined;
  }
}

/** The transcript, its scroll view, and how to draw into them. The view is
 *  read at each redraw. */
// The screen's one adapter from reducer entries to virtual items and parts.
// pi-lens-ignore: high-complexity, high-fan-out
function transcriptParts({
  tui,
  rooms,
  view,
  setStatus,
  viewportRows,
}: {
  tui: TuiAltScreen;
  rooms: ReadonlyMap<string, Followed>;
  view: () => View;
  setStatus: () => void;
  /** Live row count, or an explicit full-window sentinel in tests. */
  viewportRows: () => number;
}) {
  let scroll: ScrollView;
  const transcript = new Transcript(viewportRows, () => tui.requestRender());
  scroll = new ScrollView(transcript, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
    scrollbarTrackStyle: dim,
    scrollbarThumbStyle: (s) => (s === "█" ? s : inverse(s)),
  });
  transcript.setScroll(scroll);

  let model: VirtualTranscriptModel | undefined;
  /** Entries already given to the run fold or the line below them. */
  let processed = new WeakSet<Entry>();
  /** Sorts each new entry into runs. Reset with the view. */
  let see = runs();
  /** The participant whose name heads the lines drawn last; unset after
   *  the person's own message. */
  let speaker: string | undefined;
  /** The runs a click opened, by their first call: one stays open after a
   *  switch. */
  const opened = new WeakSet<Entry>();

  /** The colour of the participant whose line `e` is. */
  const paint = (state: RoomState, e: Entry) => {
    const colour = colourOf(state, e.participantId);
    return colour === undefined ? dim : fg(colour);
  };

  /** A participant's heading: harness, role and the time of that first
   *  line. */
  const headingInfo = (state: RoomState, e: Entry, name: string) => {
    const p = state.participants.get(e.participantId);
    const about = [p?.harness, p?.role, hhmm(e.at)].filter(Boolean);
    const rest = about.length ? dim(` · ${about.join(" · ")}`) : "";
    const colour = paint(state, e);
    return { text: `${bold(colour(name))}${rest}`, colour };
  };
  const headingRows = (text: string, width: number) =>
    1 + estimateRows(text, Math.max(1, width - 3));
  const headingParts = (info: {
    text: string;
    colour: (s: string) => string;
  }) => [new Spacer(1), barred(new Text(info.text, 1, 0), info.colour)];

  const textSpec = (
    text: string,
    style: (s: string) => string = dim,
  ): ItemSpec => ({
    make: () => ({ parts: [new Text(style(text), 1, 0)] }),
    estimate: (width) => estimateRows(text, Math.max(1, width - 2)),
  });
  const addExtra = (text: string, style?: (s: string) => string) => {
    model?.addExtra(textSpec(text, style));
  };

  /** A tool call's row in its run. The run's first call draws the run's
   *  line above its own row once the run folded, and only that line while
   *  it is shut; another call draws only its heading then. Plain empty rows
   *  separate the coloured blocks and follow the last one. */
  // The row's fold, live state, hit box, and wrapping share one component.
  // pi-lens-ignore: high-complexity
  const toolRow = (state: RoomState, e: Tool, run: Run): Component => {
    const head = line();
    const own = line(1);
    const first = () => run.tools[0] === e;
    const last = () => run.tools.at(-1) === e;
    const shut = () => run.folded && !opened.has(run.tools[0] as Entry);
    /** The rows the run's line took when drawn last: it can wrap. */
    let headRows = 0;
    return {
      render(width) {
        const out =
          first() && run.folded
            ? head.render(width, runLine(run, !shut()))
            : [];
        headRows = out.length;
        if (shut()) return out;
        const live =
          !run.over &&
          state.participants.get(e.participantId)?.status === "busy";
        let paint = TOOL_ACTIVE_BG;
        if (e.status === "completed") paint = TOOL_SUCCESS_BG;
        else if (e.status === "failed") paint = TOOL_FAILURE_BG;
        return [
          ...out,
          ...(first() ? [] : [""]),
          ...own.render(
            width,
            toolLines(e, live, Date.now()).join("\n"),
            paint,
          ),
          ...(last() ? [""] : []),
        ];
      },
      handleMouse(m: TuiMouseEvent) {
        if (m.type !== "click" || m.button !== "left") return undefined;
        if (!first() || !run.folded || m.y >= headRows) return undefined;
        const key = run.tools[0] as Entry;
        if (opened.has(key)) opened.delete(key);
        else opened.add(key);
        refreshRun(run);
        return { handled: true };
      },
      invalidate() {},
    };
  };

  /** The item's exact height now. Used after a fold or an update above the
   *  view, so the rows being read do not move. */
  const measureItem = (item: Item) => {
    const current = model;
    if (!current) return;
    current.invalidate(item);
    transcript.measure(item);
  };
  const refreshRun = (run: Run) => {
    const current = model;
    if (!current) return;
    const anchor = scroll.isFollowingEnd
      ? undefined
      : current.anchorAt(scroll.scrollTop);
    const items = current.byRun.get(run) ?? [];
    for (const item of items) current.invalidate(item);
    // The run's first item holds the line that was clicked. Opening or
    // shutting the rest changes no row above that line.
    const first = items[0];
    if (first) transcript.measure(first);
    if (anchor) {
      transcript.syncScroll();
      scroll.scrollTo(current.rowAt(anchor), { disableFollow: true });
    }
    tui.requestRender();
  };
  const foldRuns = (done: Run[], live: boolean) => {
    if (done.length === 0) return;
    const current = model;
    if (!current) return;
    for (const run of done) {
      run.folded = true;
      const items = current.byRun.get(run) ?? [];
      for (const item of items) current.invalidate(item);
      // A shut run draws its summary on the first item and later headings
      // at their places. Measure the summary; headings wait for the window.
      const first = items[0];
      if (live && first) transcript.measure(first);
    }
  };

  const userSpec = (
    state: RoomState,
    e: Entry & { type: "user" },
  ): ItemSpec => {
    const name = nameOf(state, e.participantId);
    const text = `${bold(cyan(`${senderOf(state, e.from)} → ${name}`))}\n${e.text}`;
    return {
      anchor: 1,
      make: () => ({
        parts: [new Spacer(1), barred(new Text(text, 1, 0, YOU_BG), YOU_BAR)],
      }),
      estimate: (width) => 1 + estimateRows(text, Math.max(1, width - 3)),
    };
  };

  const answerSpec = (
    state: RoomState,
    e: Entry & { type: "answer" },
    name: string,
    heading: boolean,
  ): ItemSpec => {
    const head = heading ? headingInfo(state, e, name) : undefined;
    const blocks: string[] = [];
    let done = 0;
    const advance = () => {
      const cut = settled(e.text, done);
      if (cut > done) {
        blocks.push(e.text.slice(done, cut));
        done = cut;
      }
    };
    advance();
    return {
      advance,
      make: () => {
        const parts = head ? headingParts(head) : [];
        const rest = new Markdown("", 1, 0, MARKDOWN_THEME);
        const box = new Container();
        for (const block of blocks)
          box.addChild(new Markdown(block, 1, 0, MARKDOWN_THEME));
        box.addChild(rest);
        parts.push(barred(box, paint(state, e)));
        let shown = blocks.length;
        let shownRest = "";
        return {
          parts,
          update() {
            for (const block of blocks.slice(shown)) {
              box.removeChild(rest);
              box.addChild(new Markdown(block, 1, 0, MARKDOWN_THEME));
              box.addChild(rest);
              shown += 1;
            }
            const text = e.text.slice(done);
            if (text !== shownRest) {
              shownRest = text;
              rest.setText(text);
            }
          },
        };
      },
      estimate: (width) =>
        (head ? headingRows(head.text, width) : 0) +
        estimateRows(e.text, Math.max(1, width - 3)),
    };
  };

  const toolSpec = ({
    state,
    e,
    name,
    heading,
    run,
  }: {
    state: RoomState;
    e: Tool;
    name: string;
    heading: boolean;
    run: Run;
  }): ItemSpec => {
    const head = heading ? headingInfo(state, e, name) : undefined;
    const first = () => run.tools[0] === e;
    const last = () => run.tools.at(-1) === e;
    const shut = () => run.folded && !opened.has(run.tools[0] as Entry);
    return {
      run,
      make: () => ({
        parts: [
          ...(head ? headingParts(head) : []),
          barred(toolRow(state, e, run), paint(state, e)),
        ],
      }),
      estimate: (width) => {
        const headRows = head ? headingRows(head.text, width) : 0;
        const summaryRows =
          first() && run.folded
            ? estimateRows(runLine(run, !shut()), Math.max(1, width - 3))
            : 0;
        if (shut()) return headRows + summaryRows;
        const own =
          estimateRows(
            toolLines(e, false, 0).join("\n"),
            Math.max(1, width - 3),
          ) + 2;
        return (
          headRows + summaryRows + (first() ? 0 : 1) + own + (last() ? 1 : 0)
        );
      },
    };
  };

  const permissionSpec = (
    state: RoomState,
    e: Entry & { type: "permission" },
  ): ItemSpec => {
    const name = nameOf(state, e.participantId);
    const text = () => {
      let answer = "";
      if (e.allow !== undefined) {
        answer = ` — ${e.allow ? "allowed" : "denied"} (${e.reason})`;
      }
      return `? ${name} asks: ${e.title}${answer}`;
    };
    return {
      make: () => {
        const line = new Text("", 1, 0);
        let shown = "";
        return {
          parts: [line],
          update: () => {
            const next = magenta(text());
            if (next !== shown) {
              shown = next;
              line.setText(next);
            }
          },
        };
      },
      estimate: (width) => estimateRows(text(), Math.max(1, width - 2)),
    };
  };

  /** Gives one entry its item, or advances the item that is already there.
   *  A fold is part of the entry that caused it, so it runs first. */
  // One reducer event maps to one item, with the run's fold first.
  // pi-lens-ignore: high-complexity
  const addEntry = (state: RoomState, e: Entry, live: boolean) => {
    const current = model;
    if (!current || processed.has(e)) return;
    processed.add(e);
    const name = nameOf(state, e.participantId);
    switch (e.type) {
      case "user":
        foldRuns(see(e).fold, live);
        speaker = undefined;
        current.add(e, userSpec(state, e));
        return;
      case "queued":
        current.add(
          e,
          textSpec(
            `queued for ${name}` +
              `${e.from ? ` from ${senderOf(state, e.from)}` : ""}: ${e.text}`,
          ),
        );
        return;
      case "queue_cleared":
        current.add(
          e,
          textSpec(
            `! ${e.count} queued message(s) for ${name} dropped, unsent`,
            yellow,
          ),
        );
        return;
      case "answer": {
        foldRuns(see(e).fold, live);
        const heading = speaker !== e.participantId;
        speaker = e.participantId;
        current.add(e, answerSpec(state, e, name, heading));
        return;
      }
      case "tool": {
        const run = see(e).run as Run;
        runSummaries.delete(run);
        // The call before this one loses its trailing gap when it is no
        // longer the run's last.
        const previous = current.byRun.get(run)?.at(-1);
        if (previous) {
          current.invalidate(previous);
          if (live && previous.parts) transcript.measure(previous);
        }
        const heading = speaker !== e.participantId;
        speaker = e.participantId;
        current.add(e, toolSpec({ state, e, name, heading, run }));
        return;
      }
      case "turn_ended": {
        foldRuns(see(e).fold, live);
        if (e.error)
          current.add(
            e,
            textSpec(`! ${name}'s turn failed: ${e.error}`, yellow),
          );
        else if (e.stopReason !== "end_turn")
          current.add(
            e,
            textSpec(`! ${name}'s turn ended: ${e.stopReason}`, yellow),
          );
        return;
      }
      case "exited":
        current.add(e, textSpec(`! ${name}'s harness exited`, yellow));
        return;
      case "revived":
        current.add(e, textSpec(revivedLine(name, e), e.behind ? yellow : dim));
        return;
      case "forward":
        current.add(
          e,
          textSpec(`↪ ${name} moved to ${nameOf(state, e.from)}'s commit`),
        );
        return;
      case "stall":
        current.add(e, textSpec(`! ${name}: ${e.text}`, yellow));
        return;
      case "permission":
        see(e);
        current.add(e, permissionSpec(state, e));
        return;
      default: {
        const never: never = e;
        return never;
      }
    }
  };

  /** Draws the current view from its reducer, from the start. */
  const redraw = () => {
    transcript.clear();
    // At the end before the replay: a replayed fold then skips its anchor,
    // which would measure every part once per run (M7-2).
    scroll.scrollToEnd();
    model = new VirtualTranscriptModel(transcript.width);
    transcript.setModel(model);
    processed = new WeakSet();
    see = runs();
    speaker = undefined;
    const r = rooms.get(view().roomId);
    if (r) {
      const id = view().participantId;
      // `r.dto` is read when a participant joins, not when one leaves: the
      // reducer says who left, so a removed one's notices are not drawn.
      const dto =
        r.dto?.participants.filter(
          (p) =>
            (!id || p.id === id) && !r.state.participants.get(p.id)?.removed,
        ) ?? [];
      if (id) {
        const p = r.state.participants.get(id);
        const where = dto[0]?.worktree ? ` · ${dto[0].worktree}` : "";
        addExtra(`${p?.name ?? id} (${p?.harness ?? "?"})${where}`);
      } else {
        addExtra(`room ${r.entry.id} · ${r.entry.cwd}`);
      }
      // A notice can quote the harness: its version, or its own error (#229).
      for (const p of dto)
        for (const { text } of p.notices) addExtra(`! ${printable(text)}`);
      if (r.lost) addExtra(endedLine(r.lost, r.entry.id));
      const entries = id ? thread(r.state, id) : r.state.timeline;
      for (const e of entries) addEntry(r.state, e, false);
    } else {
      addExtra("no rooms. ctrl+o → new room, or type /new <harness>.");
      addExtra("ctrl+c twice leaves.");
    }
    setStatus();
  };

  const warn = (text: string) => {
    addExtra(text, yellow);
    tui.requestRender();
  };

  const draw = (state: RoomState, e: Entry) => {
    const current = model;
    if (!current) return;
    const anchor = scroll.isFollowingEnd
      ? undefined
      : current.anchorAt(scroll.scrollTop);
    const item = current.byEntry.get(e);
    if (item) {
      if (item.run) runSummaries.delete(item.run);
      item.advance?.();
      // A shut run draws its one summary line on the first item, whatever
      // later call changed. Measure that line so its new wrap is in the model.
      const summary =
        item.run?.folded === true
          ? current.byRun.get(item.run)?.[0]
          : undefined;
      if (item.parts || summary === item) measureItem(item);
      else current.invalidate(item);
      if (summary && summary !== item) measureItem(summary);
    } else {
      addEntry(state, e, true);
    }
    if (anchor) {
      // The new row can be past what the scroll view last laid out.
      transcript.syncScroll();
      scroll.scrollTo(current.rowAt(anchor), { disableFollow: true });
    }
    tui.requestRender();
  };

  /** Scrolls the transcript so the person's message `e` is at the top
   *  (M4-4), from the model's cached rows. */
  const jump = (e: Entry) => {
    const row = model?.topOf(e);
    if (row === undefined) return;
    // New entries can make the model taller than the last drawn layout.
    transcript.syncScroll();
    scroll.scrollTo(row, { disableFollow: true });
    tui.requestRender();
  };

  return {
    transcript,
    scroll,
    warn,
    draw,
    redraw,
    jump,
    /** Test seam for the height/offset model assertions. */
    model: () => model,
  };
}

export { transcriptParts };
