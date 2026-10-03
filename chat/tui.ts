/**
 * `chat/tui.ts` — the full-screen chat, for a terminal (M4-7).
 *
 * On a TTY, `chat.ts` is a full-screen `pi-tui` app over every room the
 * daemon holds (M4-2): a sidebar of rooms and their participants, a
 * transcript with each answer rendered as markdown while it streams, and an
 * editor below it.
 *
 * **A question opens its own box** (M4-3): when an `ask` participant waits
 * on a permission, the TUI shows the room, the agent, the turn and the tool's
 * input, with `deny` first, so a stray Enter says no, as the timeout would.
 * It never opens over another pop-up or over typed text; then the status
 * line counts it and `ctrl+o` lists it. Which question opens, and when, is
 * `client/questions.ts` (M4-9); this file keeps the box and the timer.
 *
 * **pi-tui is ratified under M1c-7's rule (M4-1).** It is presentation only,
 * so its worst failure is a broken screen, never a changed decision; it is
 * pinned exactly; its nested `marked` is overridden to ours, so one copy is
 * installed; and a throw from it leaves the screen before the process exits,
 * with the command to rejoin the room, which lives on in the daemon. It ships two native helpers, both loaded lazily inside a
 * try/catch: `darwin-modifiers.node` reads Shift for Shift+Enter in Apple
 * Terminal only, and `win32-console-mode.node` runs on Windows only, which
 * `package.json`'s `os` leaves out. Linux never loads either.
 */

import { basename } from "node:path";

import {
  type Component,
  Container,
  Editor,
  HStack,
  Input,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  ScrollView,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { HELP, type RouteCommand, runCommand } from "../client/command.ts";
import type {
  HarnessEntry,
  MessageAccepted,
  PermissionAnswered,
  PermissionDecision,
  RepoAdded,
  RoomDto,
  RoomEventLine,
  RoomListEntry,
} from "../client/contract.ts";
import { call, type DaemonAddress } from "../client/daemon.ts";
import {
  absoluteFolder,
  completeFolder,
  FOLDER_GONE,
} from "../client/folder.ts";
import { targetOf } from "../client/mention.ts";
import { questionQueue } from "../client/questions.ts";
import {
  applyLine,
  type Entry,
  nameOf,
  needsAttention,
  newRoomState,
  type RoomState,
  roster,
  seen,
  thread,
} from "../client/room.ts";
import { parseLine } from "../client/submit.ts";
import {
  bold,
  cyan,
  dim,
  green,
  italic,
  magenta,
  plain,
  readRoom,
  reconcile,
  rosterOf,
  sgr,
  underline,
  unpad,
  yellow,
} from "./common.ts";
import {
  type Composer,
  dismissed,
  edited,
  left,
  opened,
  renamed,
  rows,
  same,
  seenIn,
  shows,
  step,
  touched,
  type View,
} from "./view.ts";

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

const EDITOR_THEME = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};

/** One room the screen follows: its stream runs into its own reducer for as
 *  long as the screen is up, whichever view is drawn. */
interface Followed {
  entry: RoomListEntry;
  state: RoomState;
  /** From `GET /rooms/:id`: each participant's checkout and notices. */
  dto?: RoomDto;
  /** Set when its stream ended and the room did not: the reason. */
  lost?: string;
}

/** An open question, as the reducer keeps it. */
type Question = Extract<Entry, { type: "permission" }>;

/** What the screen says in a room with no participant (M4-5). */
const NO_AGENTS = "no agents: ctrl+o → add agent";

/** Whether a question from this participant waits. */
const asks = (state: RoomState, id: string) =>
  [...state.questions.values()].some((q) => q.participantId === id);

/** Colour only says why a participant needs the person: magenta for a
 *  question, yellow for a stall. The circle says that something waits. */
const SIDEBAR_WIDTH = 26;
/** Below this many columns the sidebar starts hidden. */
const NARROW = 70;
/** The roles (R44) and modes (R12) the menu offers. The daemon checks
 *  them; an unknown one it adds later is typed as `@name /role x`. */
const ROLES = ["orchestrator", "developer", "tester", "architect"];
const MODES = ["auto", "ask", "safe"];
/** The last entry of the base and harness lists: it turns the list into a
 *  text box, for a git ref or a harness the daemon did not list. */
const OTHER_REF = "other ref…";
const OTHER_HARNESS = "other…";
const TYPE_IT = new Set([OTHER_REF, OTHER_HARNESS]);

/**
 * The pop-up (M4-5): the ctrl+o menu, a pick list, a text box or a form, in
 * a box at the centre of the timeline, where a folder or a command fits on
 * one line (decided 2026-09-30). While it is open it has the keys, and
 * `error` holds the daemon's refusal.
 */
interface Panel {
  title: string;
  body: Component;
  error?: string;
}

const SETTINGS_THEME = {
  label: (s: string, on: boolean) => (on ? bold(s) : s),
  value: (s: string, on: boolean) => (on ? cyan(s) : dim(s)),
  description: dim,
  cursor: cyan("▸ "),
  hint: dim,
};

/**
 * The full-screen chat over every room the daemon holds. Resolves with the
 * exit code.
 *
 * **One stream per room, all the time** (M4-2). Each room's stream runs into
 * its own reducer whichever view is drawn, so switching rows only redraws
 * the transcript from a reducer; nothing reconnects, and a line for a room
 * off screen still marks its row. A room made elsewhere joins on the next
 * `GET /rooms`, every 5 s. A dismissed room leaves the list. The screen
 * exits when every room it holds lost its stream; with no room left it
 * stays open, so the person can open one (M4-5).
 *
 * **Room commands** (M4-5): `ctrl+o` opens a menu, a pick list or a form
 * in a box at the centre of the timeline, and a typed command does the same
 * work through `client/command.ts`. A refusal stays in the box; a success
 * is one status line.
 *
 * **The composer names the target** (R43), through `client/mention.ts`, and
 * the status line shows it while the person types. A sent line is read by
 * `client/submit.ts`, as the piped screen reads it. The sidebar only picks
 * what is drawn. The rows, the `@name ` pre-fill and what is seen are
 * `chat/view.ts` (M4-10); this file sets the text and draws.
 */
function chatTui(
  d: DaemonAddress,
  list: RoomListEntry[],
  selected?: string,
): Promise<number> {
  const rooms = new Map<string, Followed>();
  const tui = new TuiAltScreen(new ProcessTerminal());
  const transcript = new Container();
  const scroll = new ScrollView(transcript, { follow: "end", primary: true });
  const status = new Text("", 1, 0);
  const editor = new Editor(tui, EDITOR_THEME, { paddingX: 1 });
  let view: View = { roomId: selected ?? list[0]?.id ?? "" };
  let shown = (process.stdout.columns || 80) >= NARROW;
  /** One line about a room that ended, until the next view change. */
  let flash = "";
  /** The `@name ` this screen put in the composer, while it is untouched. */
  let prefill = "";
  /** The component drawn for each entry of the current view. */
  let drawn = new WeakMap<Entry, Markdown | Text>();
  /** The participant whose name heads the lines drawn last; unset after
   *  the person's own message. */
  let speaker: string | undefined;
  /** The pop-up, while one is open (M4-5), and pi-tui's handle on it. */
  let panel: Panel | undefined;
  let overlay: OverlayHandle | undefined;
  /** The open questions over every room, oldest first (M4-3). The reducers
   *  hold them; the queue keeps their order and the ones put aside. */
  const queue = questionQueue<{ r: Followed; q: Question }>((roomId, id) => {
    const r = rooms.get(roomId);
    const q = r?.state.questions.get(id);
    return r && q ? { r, q } : undefined;
  });
  /** Opens the next question when nothing is in the way; set where the
   *  pop-up's helpers live. */
  let offer = () => {};
  /** Keeps an open question box true: its count follows the open
   *  questions, and the box goes when its question left without a close
   *  line, as when its room was dismissed elsewhere. */
  const syncBox = () => {
    if (!queue.asking || !panel) return;
    const at = queue.place();
    if (!at) hidePanel();
    else panel.title = `question ${at.at} of ${at.of}`;
  };
  /** How many rows a list in the pop-up may show. */
  const panelRoom = () =>
    Math.max(3, Math.min(12, (process.stdout.rows || 24) - 12));
  /** The pop-up's box: the title in its top border, then the body, a key
   *  hint for a list, and the refusal. */
  const frame: Component = {
    render(width) {
      if (!panel) return [];
      const inner = Math.max(1, width - 4);
      const side = (l: string) =>
        `${dim("│")} ${truncateToWidth(l, inner, "…", true)} ${dim("│")}`;
      const lines = [
        dim(
          `${truncateToWidth(`┌ ${panel.title} ${"─".repeat(width)}`, width - 1, "")}┐`,
        ),
      ];
      for (const l of panel.body.render(inner)) lines.push(side(l));
      if (panel.body instanceof SelectList) {
        lines.push(side(dim("↑↓ Enter · Esc back")));
      }
      if (panel.error) {
        for (const l of wrapTextWithAnsi(yellow(`! ${panel.error}`), inner)) {
          lines.push(side(l));
        }
      }
      lines.push(dim(`└${"─".repeat(Math.max(0, width - 2))}┘`));
      return lines;
    },
    handleInput: (key) => panel?.body.handleInput?.(key),
    invalidate: () => panel?.body.invalidate(),
  };

  const add = (c: Component) => {
    transcript.addChild(c);
    tui.requestRender();
  };
  const note = (s: string) => add(new Text(dim(s), 1, 0));
  const warn = (s: string) => add(new Text(yellow(s), 1, 0));

  /** A participant's mark: `●` when something waits, coloured by why. */
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
        const cursor = same(row, view) ? "▸" : " ";
        if (!row.participantId) {
          const { circle, paint } = roomMark(r.state);
          const label = r.entry.title ?? r.entry.id;
          const lost = r.lost ? yellow(" !") : "";
          lines.push(
            fit(
              `${cursor} ${paint(`${circle} ${label}`)} ${dim(basename(r.entry.cwd))}${lost}`,
            ),
          );
          continue;
        }
        const p = r.state.participants.get(row.participantId);
        if (!p) continue;
        const { circle, paint } = mark(r.state, p.id);
        const star = p.role === "orchestrator" ? " ★" : "";
        const busy = p.status === "busy" ? " …" : "";
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

  tui.setLayoutRoot(
    new VStack([
      {
        component: new HStack([
          {
            component: sidebar,
            basis: SIDEBAR_WIDTH,
            shrink: 0,
            visible: () => shown,
          },
          { component: strip, basis: 2, shrink: 0, visible: () => !shown },
          { component: scroll, basis: "auto", grow: 1, shrink: 1, minSize: 1 },
        ]),
        basis: "auto",
        grow: 1,
        shrink: 1,
        minSize: 1,
      },
      // A gap between the conversation and the status line.
      { component: new Spacer(1), basis: 1, shrink: 0 },
      { component: status, basis: "auto", shrink: 0 },
      // Never shrinks: pi-tui's shrink takes at least one row from every
      // entry that may, so a full-height sidebar or a long conversation cut
      // the box's bottom border. The editor caps itself at 30% of the rows.
      { component: editor, basis: "auto", shrink: 0 },
    ]),
  );
  tui.setFocus(editor);

  const setStatus = () => {
    const r = rooms.get(view.roomId);
    const parts: string[] = [];
    if (r) {
      const roster = rosterOf(r.state, r.entry.participants);
      const t =
        roster.length > 0
          ? targetOf(editor.getText(), roster)
          : { error: NO_AGENTS };
      parts.push(
        "id" in t ? bold(`→ ${nameOf(r.state, t.id)}`) : yellow(`! ${t.error}`),
      );
    }
    const asked = queue.open().length;
    if (asked && !queue.asking) {
      parts.push(
        magenta(`? ${asked} question${asked > 1 ? "s" : ""} · ctrl+o`),
      );
    }
    if (flash) parts.push(flash.startsWith("!") ? yellow(flash) : flash);
    if (!shown) {
      const marked = [...rooms.values()].filter(
        ({ state }) => roomMark(state).circle === "●",
      ).length;
      if (marked) parts.push(`● ${marked} room${marked > 1 ? "s" : ""}`);
    }
    // A pop-up takes the row keys and turns ctrl+o into close: name the
    // keys that work there instead.
    parts.push(
      dim(
        panel
          ? "esc back · ctrl+o close"
          : "enter to send · ctrl+o menu · alt+↑↓ rows · ctrl+t rooms",
      ),
    );
    status.setText(parts.join(dim(" · ")));
    tui.requestRender();
  };
  const toggle = () => {
    shown = !shown;
    setStatus();
  };
  /** Closes the pop-up. A question box the person closes means "away", so
   *  the next question waits too; any other box makes way for one. An
   *  answer, or a close from elsewhere, opens the next itself. */
  const hidePanel = () => {
    const away = queue.away();
    panel = undefined;
    overlay?.hide();
    overlay = undefined;
    tui.setFocus(editor);
    setStatus();
    if (!away) offer();
  };

  // Each answer's component. The reducer joins the chunks, and the whole
  // text is re-set, because markdown only parses correctly as a whole.
  // ponytail: re-parses the whole answer per frame (~5 ms at 53k chars,
  // measured); split finished blocks into their own components if it lags.
  /** A participant's name, before the first of its lines, tool calls
   *  included, since someone else's. */
  const heading = (id: string, name: string) => {
    if (speaker === id) return;
    speaker = id;
    add(new Text(`\n${bold(green(name))}`, 1, 0));
  };
  const draw = (state: RoomState, e: Entry) => {
    const name = nameOf(state, e.participantId);
    switch (e.type) {
      case "user":
        speaker = undefined;
        add(new Text(`\n${bold(cyan(`you → ${name}`))}\n${e.text}`, 1, 0));
        return;
      case "queued":
        note(`queued for ${name}: ${e.text}`);
        return;
      case "queue_cleared":
        warn(`! ${e.count} queued message(s) for ${name} dropped, unsent`);
        return;
      case "answer": {
        let md = drawn.get(e) as Markdown | undefined;
        if (!md) {
          heading(e.participantId, name);
          md = new Markdown("", 1, 0, MARKDOWN_THEME);
          drawn.set(e, md);
          add(md);
        }
        md.setText(e.text);
        tui.requestRender();
        return;
      }
      case "tool":
        heading(e.participantId, name);
        note(`  · ${e.title}`);
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
    speaker = undefined;
    const r = rooms.get(view.roomId);
    if (r) {
      const id = view.participantId;
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
      if (r.lost) warn(r.lost);
      const entries = id ? thread(r.state, id) : r.state.timeline;
      for (const e of entries) draw(r.state, e);
    } else {
      note("no rooms. ctrl+o → new room, or type /new <harness>.");
      note("ctrl+c leaves.");
    }
    scroll.scrollToEnd();
    setStatus();
  };

  /** Sets what `chat/view.ts` decided the composer holds. The pre-fill
   *  first: `setText` calls `onChange` at once. */
  const compose = (c: Composer) => {
    prefill = c.prefill;
    if (c.text !== undefined) editor.setText(c.text);
  };

  const open = (next: View) => {
    // A pop-up belongs to the view it opened on.
    if (panel) hidePanel();
    view = next;
    flash = "";
    const r = rooms.get(next.roomId);
    compose(opened(r?.state, next, editor.getText(), prefill));
    // The person looks at the view: its lines are seen.
    if (r) for (const id of seenIn(r.state, next)) seen(r.state, id);
    redraw();
  };

  /** Reads the room again for each participant's checkout and notices. */
  const loadDto = (r: Followed) => {
    call<RoomDto>(d, `/rooms/${r.entry.id}`).then(
      (res) => {
        if (!res.ok) return;
        r.dto = res.body;
        if (view.roomId === r.entry.id) redraw();
      },
      // The stream says what happened to the daemon; a header can wait.
      () => {},
    );
  };

  const onLine = (roomId: string, line: RoomEventLine) => {
    const r = rooms.get(roomId);
    if (!r) return;
    const e = applyLine(r.state, line);
    const u = line.update;
    const kind = u.sessionUpdate;
    // After this chunk of lines: a replay can close a question in a later
    // line, and its box should not flash open first. A chunk that splits
    // the two lines still flashes it, then closes it: cosmetic.
    if (kind === "_client_permission_queued") {
      queue.add(u.id, roomId);
      setImmediate(offer);
    }
    // Closed elsewhere: another client, the timer, a cancel or a mode change.
    if (
      kind === "_client_permission_answered" &&
      queue.asking === u.id &&
      e?.type === "permission"
    ) {
      hidePanel();
      flash = `${nameOf(r.state, e.participantId)}'s question closed: ${e.allow ? "allowed" : "denied"} (${e.reason})`;
      offer();
    }
    // A question came or closed behind the box.
    syncBox();
    // A participant who joined after the room was read has no checkout or
    // notices in the header until the room is read again.
    if (
      kind === "_client_participant_added" &&
      r.dto &&
      !r.dto.participants.some((p) => p.id === line.participantId)
    ) {
      loadDto(r);
    }
    // The open thread's participant left the roster: back to the room's
    // timeline.
    const back =
      kind === "_client_participant_removed"
        ? left(view, roomId, line.participantId)
        : undefined;
    if (back) {
      // Our own remove may have set the status line already.
      const keep = flash;
      open(back);
      flash = keep;
      setStatus();
      return;
    }
    if (shows(view, roomId, line.participantId)) {
      seen(r.state, line.participantId);
      if (e) draw(r.state, e);
    }
    // A rename moves an untouched thread pre-fill to the new name.
    const c = renamed(r.state, roomId, view, editor.getText(), prefill);
    if (c) compose(c);
    // A roster line can rename the target, and any line can change the
    // count of rooms that wait while the sidebar is hidden.
    setStatus();
  };

  return new Promise((finish) => {
    let done = false;
    // The transcript is printed to the normal screen on exit, so the
    // conversation stays in scrollback. Not by `tui.stop()`'s own reprint:
    // that pads every line to the full width, and a terminal that wraps at
    // the last column at once (Windows ConPTY, some multiplexers) then shows
    // an empty line after each one. It would also copy the status line and
    // the editor. So only the transcript is printed, with the padding cut.
    const end = (code: number, ...last: string[]) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      // The screen is going: a later throw gets Node's default again, a
      // stack and a non-zero exit, instead of being swallowed here.
      process.off("uncaughtException", crash);
      process.off("unhandledRejection", crash);
      let lines: string[] = [];
      try {
        lines = transcript.render(process.stdout.columns || 80);
      } catch {
        // The transcript is what failed to draw: leave the screen without
        // it. `attach` replays the conversation.
      }
      tui.stop({ preserveScreen: true });
      for (const line of lines) console.log(unpad(line));
      for (const line of last) console.log(line);
      finish(code);
    };
    const left = () =>
      view.roomId
        ? `left room ${view.roomId}; rejoin with: kapelle chat attach ${view.roomId}`
        : "left the chat";

    /** A room's stream ended: ask the daemon why. The screen ends when
     *  every room it holds lost its stream. With no room left it stays, so
     *  the person can open one (M4-5). */
    const closed = async (id: string, err?: unknown) => {
      const { code, line } = await reconcile(id);
      const r = rooms.get(id);
      if (code === 0) {
        rooms.delete(id);
        syncBox();
      } else if (r) r.lost = line;
      const all = [...rooms.values()];
      if (all.length > 0 && !all.some((x) => !x.lost)) {
        const why = err ? [`! ${(err as Error).message}`] : [];
        end(code, ...why, line);
        return;
      }
      const label = r?.entry.title ?? id;
      const next = code === 0 ? dismissed(rooms, view, id) : undefined;
      if (next) open(next);
      flash = code === 0 ? `${label} was dismissed` : line;
      setStatus();
    };

    const follow = (entry: RoomListEntry) => {
      if (rooms.has(entry.id)) return;
      const r: Followed = { entry, state: newRoomState() };
      rooms.set(entry.id, r);
      loadDto(r);
      readRoom(entry.id, (line) => onLine(entry.id, line)).then(
        () => closed(entry.id),
        (err) => closed(entry.id, err),
      );
    };

    /** The measured harnesses, from `GET /harnesses`, asked once at the
     *  start and not awaited. Unset until it answers, and for good when this
     *  daemon has no such route or the ask failed: then the harness row is
     *  a text box. */
    let measured: string[] | undefined;
    call<HarnessEntry[]>(d, "/harnesses").then(
      (res) => {
        if (!res.ok) return;
        const ids: string[] = [];
        for (const h of res.body) if (h.measured) ids.push(h.id);
        measured = ids.sort((a, b) => a.localeCompare(b));
      },
      () => {},
    );

    // Rooms made in another terminal join here. While a room is open, a
    // failed poll changes nothing: a stream that ends says what happened.
    // With none open, no stream would: a daemon that is gone, or one that
    // came back with a new token (`401`), ends the screen (M4-5).
    // ponytail: exits rather than follows a restarted daemon; M6-7a makes
    // the screen ride out a restart, as `attach` does.
    const gone = () =>
      end(
        1,
        "! the daemon stopped: start it with kapelle daemon start, then run kapelle chat",
      );
    const poll = setInterval(() => {
      call<RoomListEntry[]>(d, "/rooms").then(
        (res) => {
          if (!res.ok) {
            if (res.status === 401 && rooms.size === 0) gone();
            return;
          }
          for (const entry of res.body) {
            const r = rooms.get(entry.id);
            if (r) r.entry = entry;
            else if (entry.status !== "dismissed") follow(entry);
          }
          tui.requestRender();
        },
        () => {
          if (rooms.size === 0) gone();
        },
      );
    }, 5000);

    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        end(0, left());
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("o"))) {
        if (panel) hidePanel();
        else menu();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("t"))) {
        toggle();
        return { consume: true };
      }
      // A pop-up keeps every key: switching rows would close it and drop
      // what was typed. Esc first. Both sets are one job: `alt+↑↓` is the
      // easy one, `ctrl+p/n` works where a terminal sends no alt+arrow.
      if (panel) return undefined;
      const down =
        matchesKey(data, Key.alt("down")) || matchesKey(data, Key.ctrl("n"));
      const up =
        matchesKey(data, Key.alt("up")) || matchesKey(data, Key.ctrl("p"));
      if (!down && !up) return undefined;
      const next = step(rooms, view, down);
      if (next) open(next);
      return { consume: true };
    });

    editor.onChange = (text) => {
      // In a thread, an empty composer refills with `@name `. The editor
      // has already cleared its state when it reports "".
      const c = edited(rooms.get(view.roomId)?.state, view, text, prefill);
      compose(c);
      if (c.text === undefined) setStatus();
      // A question that came while the person typed opens once the text is
      // sent or deleted.
      offer();
    };
    // pi-tui calls this and drops the promise, so a throw (the daemon gone
    // mid-request) must end the chat here, or it crashes on the alt screen.
    editor.onSubmit = (text) => {
      submit(text).catch((err) => end(1, `! ${(err as Error).message}`));
    };
    const submit = async (text: string) => {
      if (!text.trim()) return;
      flash = "";
      const r = rooms.get(view.roomId);
      const roster = r ? rosterOf(r.state, r.entry.participants) : [];
      /** Refused before any request: give the text back to fix. The editor
       *  trims what it submits, so a bare mention gets its space back, or
       *  the next letter would join the name (`@bobx`). In a thread the
       *  pre-fill put back on the clear is already this. */
      const giveBack = () => {
        const bare = "id" in targetOf(text, roster);
        const back = bare ? `${text} ` : text;
        if (editor.getText() !== back) editor.setText(back);
      };
      const c = parseLine(text, roster);
      if ("error" in c) {
        flash = `! ${c.error}`;
        setStatus();
        return giveBack();
      }
      if (c.verb === "leave") return end(0, left());
      if (c.verb === "help") return showHelp();
      if (c.verb === "form") return c.form === "new" ? newForm() : addForm();
      if (c.verb !== "message") {
        editor.addToHistory(text);
        if (!(await run(c))) giveBack();
        return;
      }
      if (!r) {
        flash = "! no room: ctrl+o → new room";
        setStatus();
        return giveBack();
      }
      if (roster.length === 0) {
        warn(`! ${NO_AGENTS}`);
        return giveBack();
      }
      const t = c.target;
      if ("error" in t) {
        warn(`! ${t.error}`);
        return giveBack();
      }
      editor.addToHistory(text);
      const res = await call<MessageAccepted>(
        d,
        `/rooms/${r.entry.id}/agents/${t.id}/messages`,
        { method: "POST", body: { text: t.text } },
      );
      if (!res.ok) warn(`! ${res.error.message}`);
    };

    /**
     * Sends a command from the composer or the pop-up. A refusal stays in
     * the open pop-up, with its values, or goes to the status line; a
     * success closes the pop-up and says so on the status line. The
     * transcript is never written. Answers whether it went through. One
     * at a time: a second Enter on a form would send it again.
     */
    let busy = false;
    const run = async (c: RouteCommand): Promise<boolean> => {
      if (busy) {
        const wait = "wait: the last command is still running";
        if (panel) {
          panel.error = wait;
          tui.requestRender();
        } else {
          flash = `! ${wait}`;
          setStatus();
        }
        return false;
      }
      busy = true;
      try {
        return await send(c);
      } finally {
        busy = false;
      }
    };
    const send = async (c: RouteCommand): Promise<boolean> => {
      if (c.verb === "dismiss") {
        const r = rooms.get(view.roomId);
        flash = `dismissing ${r?.entry.title ?? view.roomId}: stopping its harnesses…`;
        setStatus();
      }
      let out: Awaited<ReturnType<typeof runCommand>>;
      try {
        out = await runCommand(d, view.roomId || undefined, c);
      } catch (err) {
        // The daemon went away mid-request.
        end(1, `! ${(err as Error).message}`);
        return false;
      }
      if (!out.ok) {
        if (out.code === "repo_not_added" && c.verb === "new") {
          askToAdd(c);
          return true;
        }
        if (panel) {
          panel.error = out.message;
          tui.requestRender();
        } else {
          flash = `! ${out.message}`;
          setStatus();
        }
        return false;
      }
      if (panel) hidePanel();
      if (c.verb === "new" && out.room) {
        const { id, cwd, title, status, updatedAt, participants } = out.room;
        follow({
          id,
          cwd,
          title,
          status,
          updatedAt,
          participants: participants.map((p) => ({
            id: p.id,
            name: p.name,
            role: p.role,
            status: p.status,
          })),
        });
        open({ roomId: id });
      }
      // A dismiss ends the room's stream, and `closed` says so.
      if (c.verb !== "dismiss") flash = out.line;
      setStatus();
      return true;
    };

    /** Shows `body` in the pop-up. A new body replaces the last one in
     *  the same box, as the menu gives way to a pick list. */
    const showPanel = (title: string, body: Component) => {
      panel = { title, body };
      queue.show(undefined);
      if (!overlay) {
        // Centred on the timeline, not the terminal: pi-tui centres on
        // the terminal, so move right by half the sidebar.
        // ponytail: placed once; a resize or ctrl+t while it is open
        // leaves it where it was, until it closes.
        const cols = process.stdout.columns || 80;
        const left = shown ? SIDEBAR_WIDTH : 2;
        overlay = tui.showOverlay(frame, {
          anchor: "center",
          offsetX: Math.floor(left / 2),
          width: Math.max(10, Math.min(80, cols - left - 4)),
          maxHeight: "80%",
        });
      }
      tui.setFocus(frame);
      setStatus();
    };
    /** A pick list in the pop-up. */
    const pickList = (
      title: string,
      items: SelectItem[],
      current: string | undefined,
      then: (value: string) => void,
    ) => {
      const list = new SelectList(items, panelRoom(), EDITOR_THEME.selectList);
      const at = items.findIndex((i) => i.value === current);
      if (at > 0) list.setSelectedIndex(at);
      list.onSelect = ({ value }) => then(value);
      list.onCancel = hidePanel;
      showPanel(title, list);
    };
    const words = (values: string[]) =>
      values.map((v) => ({ value: v, label: v }));
    /** A text box holding `value`, with the cursor after it: pi-tui's
     *  `setValue` leaves it at the start, where typing would go in front. */
    const textBox = (value: string) => {
      const input = new Input();
      input.setValue(value);
      input.handleInput("\x05"); // ctrl+e: the line's end
      input.focused = true;
      return input;
    };

    /** The commands, short, in the pop-up. Esc or Enter closes it. */
    const showHelp = () =>
      showPanel("commands", {
        render: (w) => HELP.flatMap((l) => wrapTextWithAnsi(l, w)),
        handleInput(key) {
          if (matchesKey(key, Key.escape) || matchesKey(key, Key.enter)) {
            hidePanel();
          }
        },
        invalidate() {},
      });

    /**
     * One question in the pop-up (M4-3): the room, the agent, the turn, what
     * it wants to do, and the tool's input. `deny` comes first, so a stray
     * Enter says no, as the timeout would; letters do nothing. Esc puts it
     * aside, open.
     */
    const question = (id: string) => {
      const found = queue.open().find(({ q }) => q.id === id);
      // Picked from a menu drawn before it closed elsewhere.
      if (!found) {
        flash = "! that question already closed";
        return hidePanel();
      }
      const { r, q } = found;
      const list = new SelectList(
        words(["deny", "allow"]),
        2,
        EDITOR_THEME.selectList,
      );
      list.onSelect = ({ value }) => void answer(q.id, value === "allow");
      list.onCancel = hidePanel;
      const turn = q.turn === undefined ? "" : ` · turn ${q.turn}`;
      const who = [
        `room   ${r.entry.title ?? r.entry.id}`,
        `agent  ${nameOf(r.state, q.participantId)}${turn}`,
      ];
      showPanel("question", {
        render: (w) => {
          // Wrapped, not cut: the end of a command or a path is what the
          // person judges. Both share what the screen holds, so the answer
          // rows stay in the box (80% of the rows, less 8 for the box's
          // own). The action takes up to half, and always one line and its
          // `…`: a harness's title has no cap. The input gets the rest.
          const room = Math.floor((process.stdout.rows || 24) * 0.8) - 8;
          const action = wrapTextWithAnsi(`${q.kind} · ${q.title}`, w);
          const most = Math.max(2, Math.ceil(room / 2));
          if (action.length > most) {
            action.splice(most - 1, Infinity, "…");
          }
          const input = Object.entries(q.input ?? {})
            .slice(0, 8)
            .flatMap(([k, v]) => wrapTextWithAnsi(`${k}: ${v}`, w))
            .map(dim);
          const fits = room - action.length;
          if (input.length > 0 && input.length > fits) {
            input.splice(Math.max(0, fits - 1), Infinity, dim("…"));
          }
          return [
            ...who,
            ...action,
            ...input,
            "",
            ...list.render(w),
            dim("↑↓ pick · enter answer · esc later"),
          ];
        },
        handleInput: (key) => list.handleInput(key),
        invalidate: () => list.invalidate(),
      });
      queue.show(q.id);
      syncBox();
      setStatus();
    };
    /** Sends the answer. A lost race names who won: the reply to a late
     *  answer is `409`, and `GET /permissions/:id` says why it closed. */
    const answer = async (id: string, allow: boolean) => {
      hidePanel();
      offer();
      const path = `/permissions/${encodeURIComponent(id)}`;
      try {
        const res = await call<PermissionAnswered>(d, path, {
          method: "POST",
          body: { allow },
        });
        if (res.ok) return;
        let why = res.error.message;
        if (res.status === 409) {
          const got = await call<PermissionDecision>(d, path);
          if (got.ok && got.body.reason) {
            why = `already closed: ${got.body.reason}`;
          }
        }
        flash = `! ${why}`;
        setStatus();
      } catch (err) {
        // The daemon went away mid-request.
        end(1, `! ${(err as Error).message}`);
      }
    };
    // Decided 2026-10-01 (#49): a question opens by itself, but never over
    // another pop-up or over text the person typed.
    offer = () => {
      const text = editor.getText();
      const next = queue.next(
        panel !== undefined || done || touched(text, prefill),
      );
      if (next) question(next.q.id);
    };

    /** The ctrl+o menu. In a thread it is that agent's commands; `pid`
     *  names another one, picked from the room's list. The open questions
     *  come first, from every room. */
    const menu = (pid = view.participantId) => {
      const r = rooms.get(view.roomId);
      const p = pid ? r?.state.participants.get(pid) : undefined;
      const items: SelectItem[] = queue.open().map(({ r: qr, q }) => ({
        value: `?${q.id}`,
        label: `? ${nameOf(qr.state, q.participantId)} asks: ${q.title}`,
      }));
      if (p) {
        items.push(
          { value: "cancel", label: "cancel turn" },
          // The value is in the label: the sidebar is too narrow for a
          // second column.
          { value: "mode", label: `mode · ${p.mode}` },
          { value: "role", label: `role · ${p.role ?? "none"}` },
          { value: "rename", label: "rename …" },
          { value: "remove", label: `remove ${p.name}` },
        );
      } else if (r && roster(r.state).length > 0) {
        items.push({ value: "agent", label: "agent …" });
      }
      if (r) items.push({ value: "add", label: "add agent …" });
      items.push({ value: "new", label: "new room …" });
      if (r) items.push({ value: "dismiss", label: "dismiss room" });
      items.push({ value: "help", label: "help" });
      items.push({ value: "leave", label: "leave" });
      let title = "menu";
      if (p) title = `${p.name} · ${p.harness}${p.role ? ` · ${p.role}` : ""}`;
      else if (r) title = r.entry.title ?? r.entry.id;
      pickList(title, items, undefined, (value) => choose(value, p));
    };

    const choose = (
      value: string,
      p: ReturnType<typeof roster>[number] | undefined,
    ) => {
      const r = rooms.get(view.roomId);
      if (value.startsWith("?")) return question(value.slice(1));
      if (value === "leave") return end(0, left());
      if (value === "help") return showHelp();
      if (value === "new") return newForm();
      if (value === "add") return addForm();
      if (value === "dismiss") return void run({ verb: "dismiss" });
      if (value === "agent" && r) {
        const ps = roster(r.state);
        const items = ps.map((q) => ({
          value: q.id,
          label: q.name,
          ...(q.role && { description: q.role }),
        }));
        return pickList("pick an agent", items, undefined, (id) => menu(id));
      }
      if (!p) return;
      const who = { id: p.id, name: p.name };
      if (value === "cancel") return void run({ verb: "cancel", ...who });
      if (value === "remove") return void run({ verb: "remove", ...who });
      if (value === "mode") {
        return pickList(`${p.name} · mode`, words(MODES), p.mode, (mode) =>
          run({ verb: "patch", ...who, change: { mode } }),
        );
      }
      if (value === "role") {
        const roles = words(["none", ...ROLES]);
        return pickList(`${p.name} · role`, roles, p.role ?? "none", (role) =>
          run({
            verb: "patch",
            ...who,
            change: { role: role === "none" ? null : role },
          }),
        );
      }
      if (value === "rename") {
        const input = textBox(p.name);
        input.onSubmit = (name) =>
          void run({ verb: "patch", ...who, change: { name: name.trim() } });
        input.onEscape = hidePanel;
        showPanel(`rename ${p.name}`, input);
      }
    };

    /**
     * A form in the pop-up: one row per field, then the row that sends it.
     * Enter on a row opens a text box, or a pick list for a field with
     * `pick`. A refusal keeps the form open with its values.
     */
    const form = (
      title: string,
      fields: {
        id: string;
        label: string;
        value: string;
        pick?: string[];
        /** Tab completes a folder path. */
        folder?: true;
      }[],
      go: string,
      command: (v: Record<string, string>) => RouteCommand | { error: string },
    ) => {
      const values: Record<string, string> = Object.fromEntries(
        fields.map((f) => [f.id, f.value]),
      );
      const show = (v: string) => v || "–";
      /** A text box that hands its value to `done`, or nothing on Esc. */
      const field = (value: string, done: (v?: string) => void): Input => {
        const input = textBox(value);
        input.onSubmit = (v) => done(show(v.trim()));
        input.onEscape = () => done();
        return input;
      };
      /** A folder field: Tab completes the path, and the folders that still
       *  match are listed below the box. */
      const folderField = (
        value: string,
        done: (v?: string) => void,
      ): Component => {
        const input = field(value, done);
        let options: string[] = [];
        return {
          render(w) {
            const lines = input.render(w);
            if (!options.length) return lines;
            const shown = options.slice(0, 12).map((o) => `${o}/`);
            if (options.length > 12) shown.push("…");
            return [...lines, ...wrapTextWithAnsi(dim(shown.join("  ")), w)];
          },
          handleInput(key) {
            options = [];
            if (!matchesKey(key, Key.tab)) return input.handleInput(key);
            const c = completeFolder(input.getValue(), absoluteFolder());
            input.setValue(c.value);
            input.handleInput("\x05"); // ctrl+e: the line's end
            options = c.options;
            tui.requestRender();
          },
          invalidate: () => input.invalidate(),
        };
      };
      const items: SettingItem[] = fields.map((f) => ({
        id: f.id,
        label: f.label,
        currentValue: show(f.value),
        submenu: (_, done) => {
          const value = values[f.id] ?? "";
          if (!f.pick)
            return f.folder ? folderField(value, done) : field(value, done);
          // The last pick can turn the list into a text box: a git ref.
          let now: Component;
          const list = new SelectList(
            words(f.pick),
            panelRoom(),
            EDITOR_THEME.selectList,
          );
          const at = f.pick.indexOf(value);
          if (at > 0) list.setSelectedIndex(at);
          list.onCancel = () => done();
          list.onSelect = ({ value: v }) => {
            if (!TYPE_IT.has(v)) return done(v);
            now = field("", done);
            tui.requestRender();
          };
          now = list;
          return {
            render: (w) => now.render(w),
            handleInput: (k) => now.handleInput?.(k),
            invalidate: () => now.invalidate(),
          };
        },
      }));
      items.push({ id: "", label: go, currentValue: "", values: [""] });
      const list = new SettingsList(
        items,
        panelRoom(),
        SETTINGS_THEME,
        (id, v) => {
          if (id) values[id] = v === "–" ? "" : v;
          else {
            const c = command(values);
            if (!("error" in c)) void run(c);
            else if (panel) {
              panel.error = c.error;
              tui.requestRender();
            }
          }
        },
        hidePanel,
      );
      showPanel(title, list);
    };

    /** The harness row: a pick list of the measured harnesses the daemon
     *  sent, then `other…` to type a name. A text box while `measured` is
     *  unset: the daemon has no `GET /harnesses`, or it has not answered.
     *  `–` is no harness: an empty room, or `command` instead. */
    const harnessField = () => ({
      id: "agent",
      label: "harness",
      value: "",
      ...(measured && { pick: ["–", ...measured, OTHER_HARNESS] }),
    });

    /**
     * `/new` in a folder the daemon has not added: ask, in the pop-up, and
     * on yes add its repository and open the room in one step. The question
     * is ours, from the code: the daemon's message is advice for a program.
     */
    const askToAdd = (c: Extract<RouteCommand, { verb: "new" }>) => {
      const back = panel;
      const items = [
        { value: "add", label: "add and open" },
        { value: "back", label: back ? "back to the form" : "cancel" },
      ];
      pickList("folder not added", items, undefined, async (v) => {
        if (v !== "add") {
          if (back) showPanel(back.title, back.body);
          else hidePanel();
          return;
        }
        let added: Awaited<ReturnType<typeof call<RepoAdded>>>;
        try {
          added = await call<RepoAdded>(d, "/repos", {
            method: "POST",
            body: { path: c.body.cwd },
          });
        } catch (err) {
          end(1, `! ${(err as Error).message}`);
          return;
        }
        if (!added.ok) {
          if (panel) panel.error = added.error.message;
          tui.requestRender();
          return;
        }
        await run(c);
      });
      if (panel)
        // The daemon adds the whole repository the folder is in.
        panel.error = `${c.body.cwd} is not added to the daemon. Add its repository?`;
      tui.requestRender();
    };

    const addForm = () => {
      const r = rooms.get(view.roomId);
      if (!r) {
        flash = "! no room: open one first";
        return setStatus();
      }
      const others = roster(r.state).map((p) => `@${p.name}`);
      form(
        "add agent",
        [
          harnessField(),
          { id: "cmd", label: "command", value: "" },
          { id: "name", label: "name", value: "" },
          {
            id: "role",
            label: "role",
            value: "none",
            pick: ["none", ...ROLES],
          },
          { id: "mode", label: "mode", value: "auto", pick: MODES },
          {
            id: "base",
            label: "base",
            value: "HEAD",
            pick: ["HEAD", ...others, OTHER_REF],
          },
        ],
        "add",
        (v) => ({
          verb: "add",
          agent: {
            agent: v.agent,
            cmd: v.cmd,
            name: v.name,
            role: v.role === "none" ? undefined : v.role,
            mode: v.mode,
            base: v.base === "HEAD" ? undefined : v.base,
          },
        }),
      );
    };

    const newForm = () =>
      form(
        "new room",
        [
          {
            id: "cwd",
            label: "folder",
            value: absoluteFolder() ?? "",
            folder: true,
          },
          { id: "title", label: "title", value: "" },
          harnessField(),
          { id: "cmd", label: "command", value: "" },
          { id: "name", label: "name", value: "" },
        ],
        "open",
        (v) => {
          const cwd = absoluteFolder(v.cwd || ".");
          if (!cwd) return { error: FOLDER_GONE };
          return {
            verb: "new",
            body: {
              cwd,
              title: v.title || undefined,
              agents:
                v.agent || v.cmd
                  ? [
                      {
                        agent: v.agent,
                        cmd: v.cmd,
                        name: v.name,
                        role: "orchestrator",
                      },
                    ]
                  : [],
            },
          };
        },
      );

    // pi-tui draws off our call stack, so a bug in it is an uncaught throw
    // that would end the process on the alternate screen. Leave the screen
    // first: M1c-7 needs its worst failure to stay cosmetic.
    const crash = (err: unknown) =>
      end(
        1,
        `! the chat screen failed: ${err instanceof Error ? err.message : String(err)}`,
        left(),
      );
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
    try {
      tui.start();
    } catch (err) {
      crash(err);
      return;
    }
    for (const entry of list) follow(entry);
    open(view);
  });
}

export { chatTui };
