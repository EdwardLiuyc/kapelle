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
} from "@earendil-works/pi-tui";
import {
  type Entry,
  nameOf,
  type RoomState,
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
  italic,
  magenta,
  revivedLine,
  sgr,
  underline,
  yellow,
} from "../common.ts";
import { colourOf, type View } from "../view.ts";

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
}
const barred = (c: Component, paint: (s: string) => string) =>
  new Barred(c, paint);

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

/** The transcript: it keeps the width it was drawn at, to find a row. */
class Transcript extends Container {
  width = 80;
  override render(width: number) {
    this.width = width;
    return super.render(width);
  }
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
  /** The component drawn for each entry of the current view that changes
   *  in place or can be jumped to. */
  let drawn = new WeakMap<Entry, Component>();
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
  const warn = (s: string) => add(new Text(yellow(s), 1, 0));

  /** The colour of the participant whose line `e` is. */
  const paint = (state: RoomState, e: Entry) =>
    fg(colourOf(state, e.participantId));
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
        speaker = undefined;
        // The gap above stays out of the bar and the background.
        const line = barred(
          new Text(`${bold(cyan(`you → ${name}`))}\n${e.text}`, 1, 0, YOU_BG),
          YOU_BAR,
        );
        drawn.set(e, line);
        add(new Spacer(1));
        add(line);
        return;
      }
      case "queued":
        note(`queued for ${name}: ${e.text}`);
        return;
      case "queue_cleared":
        warn(`! ${e.count} queued message(s) for ${name} dropped, unsent`);
        return;
      case "answer": {
        // The reducer joins the chunks. Markdown parses right only from a
        // block's start, so the finished blocks are cut off (`settled`).
        let a = answers.get(e);
        if (!a) {
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
      case "tool":
        heading(state, e, name);
        add(barred(new Text(dim(`· ${e.title}`), 1, 0), paint(state, e)));
        return;
      case "turn_ended":
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
        let line = drawn.get(e) as Text | undefined;
        if (!line) {
          line = new Text("", 1, 0);
          drawn.set(e, line);
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
    drawn = new WeakMap();
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
      for (const p of dto) for (const { text } of p.notices) warn(`! ${text}`);
      if (r.lost) warn(endedLine(r.lost, r.entry.id));
      const entries = id ? thread(r.state, id) : r.state.timeline;
      for (const e of entries) draw(r.state, e);
    } else {
      note("no rooms. ctrl+o → new room, or type /new <harness>.");
      note("ctrl+c leaves.");
    }
    scroll.scrollToEnd();
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
