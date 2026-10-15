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
 * **Tool runs fold** (M7-2). A tool row ends with `✓`, `✗`, or a spinner
 * while its turn is live, and an edit shows `+a −d`. When the agent's
 * next note comes, or its turn ends, its tool calls since the last note
 * fold into one line at the run's first place; `chat/view.ts` says which.
 * A click on the line opens the run, and a second folds it. A fold above
 * the rows the person reads keeps them where they are. A question never
 * folds.
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
  bold,
  cyan,
  dim,
  endedLine,
  fg,
  green,
  italic,
  magenta,
  red,
  revivedLine,
  sgr,
  underline,
  yellow,
} from "../common.ts";
import { colourOf, type Run, runs, runText, spin, type View } from "../view.ts";

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

/** The transcript: it keeps the width and the rows drawn last, to find a
 *  row, and to hold a fold above the view where it is. */
class Transcript extends Container {
  width = 80;
  /** Each child's rows at the last render, and the width it drew at. */
  rows: number[] = [];
  rowsWidth = 0;
  override render(width: number) {
    this.width = width;
    const out = super.render(width);
    // pi-tui's container keeps each child's height in its private mouse
    // layout. Read it rather than render every child a second time. If a
    // rename or a change of shape loses it, a fold measures each child
    // then: never a second render per frame. (M7-2)
    const layout = this as unknown as {
      mouseLayout?: { children: { height: number }[] };
    };
    const heights = layout.mouseLayout?.children.map((c) => c.height);
    this.rows =
      heights?.length === this.children.length &&
      heights.every((h) => typeof h === "number")
        ? heights
        : [];
    this.rowsWidth = width;
    return out;
  }
  override clear() {
    super.clear();
    this.rows = [];
    this.rowsWidth = 0;
  }
}

type Tool = Extract<Entry, { type: "tool" }>;

/** A tool call's rows: its title, its diff's `+a −d`, its mark, and its
 *  detail under it (M7-2). The spinner shows only while `live`: a call
 *  left open after its turn gets no mark. The bar before them is the
 *  agent's (M7-1). */
function toolLines(e: Tool, live: boolean, now: number) {
  const counts =
    e.added === undefined
      ? ""
      : ` ${green(`+${e.added}`)} ${red(`−${e.removed ?? 0}`)}`;
  const mark =
    e.status === "completed"
      ? green(" ✓")
      : e.status === "failed"
        ? red(" ✗")
        : live
          ? dim(` ${spin(now)}`)
          : "";
  const rows = [`${dim(`· ${e.title}`)}${counts}${mark}`];
  if (e.detail) rows.push(dim(`  ${e.detail}`));
  return rows;
}

/** A run's line (M7-2): `▸` folded, `▾` open, and its failed count in red. */
function runLine(run: Run, open: boolean) {
  const { text, failed } = runText(run.tools);
  return `${dim(`${open ? "▾" : "▸"} ${text}`)}${failed ? red(` · ${failed} failed`) : ""}`;
}

/** A `Text` set only when its text changes: `setText` drops the wrap. */
function line() {
  const t = new Text("", 1, 0);
  let was = "";
  return {
    render(width: number, s: string) {
      if (s !== was) {
        was = s;
        t.setText(s);
      }
      return t.render(width);
    },
  };
}

/** The transcript, its scroll view, and how to draw into them. The view is
 *  read at each redraw. */
function transcriptParts({
  tui,
  rooms,
  view,
  setStatus,
}: {
  tui: TuiAltScreen;
  rooms: ReadonlyMap<string, Followed>;
  view: () => View;
  setStatus: () => void;
}) {
  const transcript = new Transcript();
  const scroll = new ScrollView(transcript, { follow: "end", primary: true });
  /** The part drawn for each message to an agent, to jump to. */
  let drawn = new WeakMap<Entry, Component>();
  /** The line drawn for each question, which its answer sets again. */
  let lines = new WeakMap<Entry, Text>();
  /** The tool calls with a row (M7-2). A row works out its text as it is
   *  drawn, so an update only asks for a frame. */
  let tools = new WeakSet<Entry>();
  /** Sorts the view's entries into runs; a new one per redraw. */
  let see = runs();
  /** The runs a click opened, by their first call: one stays open after a
   *  switch. */
  const opened = new WeakSet<Entry>();
  /** Each answer's blocks: the finished ones, drawn once, then the rest,
   *  which each chunk sets again. `done` is where the rest starts. */
  let answers = new WeakMap<
    Entry,
    { box: Container; rest: Markdown; done: number }
  >();
  /** The participant whose name heads the lines drawn last; unset after
   *  the person's own message. */
  let speaker: string | undefined;

  const add = (c: Component) => {
    transcript.addChild(c);
    tui.requestRender();
  };
  const note = (s: string) => add(new Text(dim(s), 1, 0));

  /** A tool call's row in its run. The run's first call draws the run's
   *  line above its own row once the run folded, and only that line while
   *  it is shut; the others draw nothing then. */
  const toolRow = (state: RoomState, e: Tool, run: Run): Component => {
    const head = line();
    const own = line();
    const first = () => run.tools[0] === e;
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
        return [
          ...out,
          ...own.render(width, toolLines(e, live, Date.now()).join("\n")),
        ];
      },
      handleMouse(m: TuiMouseEvent) {
        if (m.type !== "click" || m.button !== "left") return undefined;
        if (!first() || !run.folded || m.y >= headRows) return undefined;
        const key = run.tools[0] as Entry;
        if (opened.has(key)) opened.delete(key);
        else opened.add(key);
        tui.requestRender();
        return { handled: true };
      },
      invalidate() {},
    };
  };

  /** The rows the last frame drew: what a fold moves from. A part added
   *  after it has no drawn rows yet, so render that one now. */
  const cached = () => {
    const width = transcript.width;
    const rows = transcript.rowsWidth === width ? transcript.rows : [];
    return transcript.children.map((c, i) =>
      i < rows.length ? (rows[i] as number) : c.render(width).length,
    );
  };

  /** Folds these runs. When the person reads above the end, the rows above
   *  the view may shrink: the view moves up by as much, so the rows it
   *  shows stay where they are. */
  const fold = (done: Run[]) => {
    if (done.length === 0) return;
    const heights = () =>
      transcript.children.map((c) => c.render(transcript.width).length);
    const follow = scroll.isFollowingEnd;
    const before = follow ? [] : cached();
    for (const r of done) r.folded = true;
    tui.requestRender();
    if (follow) return;
    const after = heights();
    const top = scroll.scrollTop;
    let y = 0;
    let moved = 0;
    for (const [i, h] of before.entries()) {
      // A part the view's top cuts through is not counted: its rows in
      // view move.
      if (y + h > top) break;
      moved += (after[i] ?? 0) - h;
      y += h;
    }
    if (moved) scroll.scrollTo(top + moved, { disableFollow: true });
  };
  const warn = (s: string) => add(new Text(yellow(s), 1, 0));

  /** The colour of the participant whose line `e` is. */
  const paint = (state: RoomState, e: Entry) => {
    const colour = colourOf(state, e.participantId);
    return colour === undefined ? dim : fg(colour);
  };
  /** A participant's name, before the first of its lines, tool calls
   *  included, since someone else's: with its harness, its role and the
   *  time of that first line. */
  const heading = (state: RoomState, e: Entry, name: string) => {
    if (speaker === e.participantId) return;
    speaker = e.participantId;
    const p = state.participants.get(e.participantId);
    const about = [p?.harness, p?.role, hhmm(e.at)].filter(Boolean);
    const rest = about.length ? dim(` · ${about.join(" · ")}`) : "";
    const colour = paint(state, e);
    add(new Spacer(1));
    add(barred(new Text(`${bold(colour(name))}${rest}`, 1, 0), colour));
  };
  const draw = (state: RoomState, e: Entry) => {
    const name = nameOf(state, e.participantId);
    switch (e.type) {
      case "user": {
        // A new turn: a cut one's runs fold.
        fold(see(e).fold);
        speaker = undefined;
        // The gap above stays out of the bar and the background.
        const line = barred(
          new Text(
            `${bold(cyan(`${senderOf(state, e.from)} → ${name}`))}\n${e.text}`,
            1,
            0,
            YOU_BG,
          ),
          YOU_BAR,
        );
        drawn.set(e, line);
        add(new Spacer(1));
        add(line);
        return;
      }
      case "queued":
        note(
          `queued for ${name}` +
            `${e.from ? ` from ${senderOf(state, e.from)}` : ""}: ${e.text}`,
        );
        return;
      case "queue_cleared":
        warn(`! ${e.count} queued message(s) for ${name} dropped, unsent`);
        return;
      case "answer": {
        // The reducer joins the chunks. Markdown parses right only from a
        // block's start, so the finished blocks are cut off (`settled`).
        let a = answers.get(e);
        if (!a) {
          // A note: the agent's runs before it fold.
          fold(see(e).fold);
          heading(state, e, name);
          const rest = new Markdown("", 1, 0, MARKDOWN_THEME);
          const box = new Container();
          box.addChild(rest);
          a = { box, rest, done: 0 };
          answers.set(e, a);
          add(barred(box, paint(state, e)));
        }
        const cut = settled(e.text, a.done);
        if (cut > a.done) {
          const blocks = e.text.slice(a.done, cut);
          a.box.removeChild(a.rest);
          a.box.addChild(new Markdown(blocks, 1, 0, MARKDOWN_THEME));
          a.box.addChild(a.rest);
          a.done = cut;
        }
        a.rest.setText(e.text.slice(a.done));
        tui.requestRender();
        return;
      }
      case "tool": {
        // Its updates come back as the same entry: one row, drawn again
        // (#240).
        if (!tools.has(e)) {
          const { run } = see(e);
          heading(state, e, name);
          tools.add(e);
          add(barred(toolRow(state, e, run as Run), paint(state, e)));
        }
        tui.requestRender();
        return;
      }
      case "turn_ended":
        fold(see(e).fold);
        if (e.error) warn(`! ${name}'s turn failed: ${e.error}`);
        else if (e.stopReason !== "end_turn") {
          warn(`! ${name}'s turn ended: ${e.stopReason}`);
        }
        return;
      case "exited":
        warn(`! ${name}'s harness exited`);
        return;
      case "revived":
        (e.behind ? warn : note)(revivedLine(name, e));
        return;
      case "forward":
        note(`↪ ${name} moved to ${nameOf(state, e.from)}'s commit`);
        return;
      case "stall":
        warn(`! ${name}: ${e.text}`);
        return;
      case "permission": {
        // The TUI answers in its pop-up (M4-3); this line shows the question
        // and, once it closes, how.
        let line = lines.get(e);
        if (!line) {
          // It ends the run before it, and never folds.
          see(e);
          line = new Text("", 1, 0);
          lines.set(e, line);
          add(line);
        }
        let answer = "";
        if (e.allow !== undefined) {
          answer = ` — ${e.allow ? "allowed" : "denied"} (${e.reason})`;
        }
        line.setText(magenta(`? ${name} asks: ${e.title}${answer}`));
        tui.requestRender();
        return;
      }
    }
  };

  /** Draws the current view from its reducer, from the start. */
  // ponytail: a switch rebuilds every component of the view; keep one
  // transcript per view if a long history makes switching slow.
  const redraw = () => {
    transcript.clear();
    // At the end before the replay: a replayed fold then skips its anchor,
    // which would measure every part once per run (M7-2).
    scroll.scrollToEnd();
    drawn = new WeakMap();
    lines = new WeakMap();
    tools = new WeakSet();
    see = runs();
    answers = new WeakMap();
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
        note(`${p?.name ?? id} (${p?.harness ?? "?"})${where}`);
      } else {
        note(`room ${r.entry.id} · ${r.entry.cwd}`);
      }
      // A notice can quote the harness: its version, or its own error (#229).
      for (const p of dto)
        for (const { text } of p.notices) warn(`! ${printable(text)}`);
      if (r.lost) warn(endedLine(r.lost, r.entry.id));
      const entries = id ? thread(r.state, id) : r.state.timeline;
      for (const e of entries) draw(r.state, e);
    } else {
      note("no rooms. ctrl+o → new room, or type /new <harness>.");
      note("ctrl+c leaves.");
    }
    setStatus();
  };

  /** Scrolls the transcript so the person's message `e` is at the top
   *  (M4-4). It stays there while lines come, until the person scrolls to
   *  the end. Each part above it is measured at the width drawn last;
   *  pi-tui keeps what it drew, so only a new width costs a parse. */
  const jump = (e: Entry) => {
    const line = drawn.get(e);
    if (!line) return;
    let row = 0;
    for (const c of transcript.children) {
      if (c === line) break;
      row += c.render(transcript.width).length;
    }
    // The message's first row is its name; the gap above is its own part.
    scroll.scrollTo(row, { disableFollow: true });
    tui.requestRender();
  };
  return { transcript, scroll, warn, draw, redraw, jump };
}

export { transcriptParts };
