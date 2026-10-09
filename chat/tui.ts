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
 * `client/questions.ts` (M4-9); the box is `chat/tui/question.ts` (M4-12),
 * and this file keeps the timer.
 *
 * **A wait off screen shows on top of the timeline** (M4-4): a banner row
 * per participant with a question or a stall (`chat/tui/banner.ts`), and
 * the terminal's bell when one starts to wait. No desktop pop-up: too noisy
 * (decided 2026-10-05, #50).
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

import {
  type Component,
  Editor,
  getKeybindings,
  HStack,
  isKeyRelease,
  Key,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TuiAltScreen,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { type RouteCommand, runCommand } from "../client/command.ts";
import type {
  MessageAccepted,
  RoomEventLine,
  RoomListEntry,
} from "../client/contract.ts";
import { call, type DaemonAddress } from "../client/daemon.ts";
import { agentDiff, agentForwardDiff } from "../client/diff.ts";
import { mentionsFor, targetOf } from "../client/mention.ts";
import { questionQueue } from "../client/questions.ts";
import {
  cleanDiff,
  type Entry,
  nameOf,
  printable,
  seen,
  thread,
} from "../client/room.ts";
import {
  codeOf,
  type End,
  type Ended,
  type Followed,
  roomSet,
} from "../client/roomset.ts";
import { parseLine } from "../client/submit.ts";
import {
  address,
  bold,
  dim,
  endedLine,
  magenta,
  NO_DAEMON,
  rosterOf,
  unpad,
  yellow,
} from "./common.ts";
import { bannerPart } from "./tui/banner.ts";
import { copySelection } from "./tui/clipboard.ts";
import { paneParts } from "./tui/pane.ts";
import { EDITOR_THEME, panelParts } from "./tui/panel.ts";
import { type Question, questionParts } from "./tui/question.ts";
import {
  NARROW,
  roomMark,
  SIDEBAR_WIDTH,
  sidebarParts,
} from "./tui/sidebar.ts";
import { transcriptParts } from "./tui/transcript.ts";
import {
  bell,
  type Composer,
  dismissed,
  edited,
  opened,
  participantLeft,
  renamed,
  seenIn,
  shows,
  step,
  type View,
  waiting,
  where,
} from "./view.ts";

/** What the screen says in a room with no participant (M4-5). */
const NO_AGENTS = "no agents: ctrl+o → add agent";

/**
 * The full-screen chat over every room the daemon holds. Resolves with the
 * exit code.
 *
 * **One stream per room, all the time** (M4-2). Each room's stream runs into
 * its own reducer whichever view is drawn, so switching rows only redraws
 * the transcript from a reducer; nothing reconnects, and a line for a room
 * off screen still marks its row. Which rooms are followed, and when the
 * screen ends, is `client/roomset.ts` (M4-11); this file says what happened.
 *
 * **Room commands** (M4-5): `ctrl+o` opens a menu, a pick list or a form
 * in a box at the centre of the timeline, and a typed command does the same
 * work through `client/command.ts`. A refusal stays in the box; a success
 * is one status line.
 *
 * **The side pane** (M4-6): a question's diff, or what an agent changed,
 * beside the timeline, or in its place on a narrow screen. `ctrl+x` shows
 * and hides it, and it keeps what it shows. It has the keys when shown;
 * `ctrl+]` gives them to the composer and back, so a message can go out
 * while the diff stays in view.
 *
 * **A fast-forward previews before it moves** (M6-11a). `@target /ff --from
 * @source`, or the target's `ctrl+o` menu, puts the commits the move would
 * bring in the side pane; Enter confirms. A line under the composer always
 * names the open view's checkout and branch.
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
  /** The screen's end, set where the screen's own end lives. */
  let quit = (_why: End) => {};
  const set = roomSet(d, address, {
    line: (roomId, line, e) => onLine(roomId, line, e),
    loaded: (roomId) => {
      if (view.roomId === roomId) redraw();
    },
    polled: () => tui.requestRender(),
    restarted: (warning) => {
      flash = warning ? `! ${warning}` : "the daemon restarted";
      setStatus();
    },
    closed: (id, ended, r) => onClosed(id, ended, r),
    end: (why) => quit(why),
  });
  const { rooms } = set;
  // A selection goes through the system's clipboard tool, not only OSC 52,
  // so "Copied!" is true under WSL (`chat/tui/clipboard.ts`).
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    copySelection: copySelection((data) => terminal.write(data)),
  });
  // pi-tui's screen reads keys before ours, and would take the page keys
  // for the timeline while the side view has the keys. Ours route them
  // (#228).
  const keys = getKeybindings();
  keys.setUserBindings({
    ...keys.getUserBindings(),
    "tui.altScreen.pageUp": [],
    "tui.altScreen.pageDown": [],
  });
  const status = new Text("", 1, 0);
  /** The one-line bar under the composer (M6-11a, 4a). Empty until the
   *  room set has something to show; `setWhere` fills it. */
  let whereText = "";
  const whereBar: Component = {
    render: (width) =>
      whereText ? [dim(truncateToWidth(whereText, width, "…", true))] : [],
    invalidate: () => {},
  };
  const editor = new Editor(tui, EDITOR_THEME, { paddingX: 1 });
  let view: View = { roomId: selected ?? list[0]?.id ?? "" };
  let shown = (process.stdout.columns || 80) >= NARROW;
  /** One line about a room that ended, until the next view change. */
  let flash = "";
  /** The `@name ` this screen put in the composer, while it is untouched. */
  let prefill = "";
  /** The open questions over every room, oldest first (M4-3). The reducers
   *  hold them; the queue keeps their order and the ones put aside. */
  const queue = questionQueue<{ r: Followed; q: Question }>((roomId, id) => {
    const r = rooms.get(roomId);
    const q = r?.state.questions.get(id);
    return r && q ? { r, q } : undefined;
  });
  /** Whether the screen ended, how it ends, and how it sends a command:
   *  set where the screen's own end lives. The pop-up and the question box
   *  call them. */
  let done = false;
  let end = (_code: number, ..._last: string[]) => {};
  let run = (_c: RouteCommand) => Promise.resolve(false);
  let changes = (
    _who: { id: string; name: string },
    _against: "head" | "base",
  ) => Promise.resolve(false);
  let forward = (
    _target: { id: string; name: string },
    _from: { id: string; name: string },
  ) => Promise.resolve(false);
  /** The daemon went away mid-request: say so, and wait for it, as the
   *  streams do (M6-7d). The set ends the screen if it does not come back. */
  const gone = (err: unknown) => {
    flash = `! ${(err as Error).message}`;
    setStatus();
  };
  const left = () =>
    view.roomId
      ? `left room ${view.roomId}; rejoin with: kapelle chat attach ${view.roomId}`
      : "left the chat";
  const say = (text: string) => {
    flash = text;
  };
  /** The participants that waited at the bell's last look (M4-4). */
  let waited = new Set<string>();
  let ringing = false;
  /** Rings the terminal's bell once a participant starts to wait. After
   *  this chunk of lines, as a question box opens: a replay rings only for
   *  what is still open at its end. A chunk that splits a question from its
   *  close still rings: cosmetic. */
  const ring = () => {
    if (ringing) return;
    ringing = true;
    setImmediate(() => {
      ringing = false;
      const b = bell(waited, waiting(rooms));
      waited = b.keys;
      if (b.ring && !done) process.stdout.write("\x07");
    });
  };

  // The parts of the screen (M4-12). A part calls back through an arrow,
  // as what it calls is set further down.
  const { transcript, scroll, warn, draw, redraw, jump } = transcriptParts({
    tui,
    rooms,
    view: () => view,
    setStatus: () => setStatus(),
  });
  const side = paneParts({
    tui,
    editor,
    setStatus: () => setStatus(),
    gutter: () => (shown ? SIDEBAR_WIDTH : 2),
  });
  const box = panelParts({
    d,
    tui,
    editor,
    queue,
    rooms,
    view: () => view,
    shown: () => shown,
    say,
    setStatus: () => setStatus(),
    offer: () => offer(),
    question: (id) => question(id),
    changes: (who) => void changes(who, "head").catch(gone),
    forward: (target, from) => void forward(target, from).catch(gone),
    run: (c) => run(c),
    end: (code, ...last) => end(code, ...last),
    left,
  });
  const { hidePanel, menu, showHelp, newForm, addForm, askToAdd } = box;
  const { question, offer, syncBox } = questionParts({
    d,
    queue,
    editor,
    box,
    side,
    setStatus: () => setStatus(),
    say,
    done: () => done,
    prefill: () => prefill,
  });
  const { sidebar, strip } = sidebarParts({
    rooms,
    view: () => view,
    toggle: () => toggle(),
    open: (next) => open(next),
  });
  const attention = bannerPart({
    rooms,
    view: () => view,
    open: (next) => open(next),
    question: (id) => question(id),
  });

  /**
   * The sidebar, the timeline and the side view. Every size is set, never
   * `auto`: an `auto` size makes pi-tui measure each line on every frame,
   * half a second for a 10,000-line diff (M4-6, measured). The banner is
   * `auto`: three rows at most. It sits over the timeline and the side
   * view both, so it shows when the side view takes the timeline's place.
   */
  const views = new HStack([
    {
      component: scroll,
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
      visible: () => !side.shown || side.wide(),
    },
  ]);
  const row = new HStack([
    {
      component: sidebar,
      basis: SIDEBAR_WIDTH,
      shrink: 0,
      visible: () => shown,
    },
    { component: strip, basis: 2, shrink: 0, visible: () => !shown },
    {
      component: new VStack([
        { component: attention, basis: "auto", shrink: 0 },
        { component: views, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      ]),
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
    },
  ]);
  /** Sets the side view's width: half of what the sidebar leaves, and on a
   *  narrow screen all of it, in the timeline's place (M4-6). A stack takes
   *  a size when an entry is added, so the entry is added again. */
  // ponytail: one grow entry and a set width, because pi-tui 0.85.1 gives
  // the first of two `grow` entries about two thirds of the space. Two
  // `grow: 1` entries will do once pi-tui shares evenly.
  const placeSide = () => {
    views.removeChild(side.pane);
    views.addChild(side.pane, {
      basis: side.columns(),
      shrink: 0,
      visible: () => side.shown,
    });
    tui.requestRender();
  };
  placeSide();
  process.stdout.on("resize", placeSide);

  tui.setLayoutRoot(
    new VStack([
      {
        component: row,
        basis: 0,
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
      // The bar under the composer: the open view's checkout and branch.
      { component: whereBar, basis: "auto", shrink: 0 },
    ]),
  );
  tui.setFocus(editor);

  // `@name` completion (M4-4): typing a leading `@`, or Tab after it, lists
  // the view's room's participants. Only a leading mention: `targetOf`
  // reads no other.
  editor.setAutocompleteProvider({
    triggerCharacters: ["@"],
    getSuggestions: async (lines, line, col) => {
      const r = rooms.get(view.roomId);
      const before = line === 0 ? (lines[0] ?? "").slice(0, col) : "";
      const roster = r ? rosterOf(r.state, r.entry.participants) : [];
      const names = mentionsFor(before, roster);
      if (!names?.length) return null;
      return {
        prefix: before.trimStart(),
        items: names.map((p) => ({
          value: p.name,
          label: `@${p.name}`,
          ...(p.role && { description: p.role }),
        })),
      };
    },
    applyCompletion: (lines, _line, col, item, prefix) => {
      const first = lines[0] ?? "";
      const head = `${first.slice(0, col - prefix.length)}@${item.value} `;
      return {
        lines: [head + first.slice(col).trimStart(), ...lines.slice(1)],
        cursorLine: 0,
        cursorCol: head.length,
      };
    },
  });

  const setWhere = () => {
    const r = rooms.get(view.roomId);
    whereText = r ? where(view, { cwd: r.entry.cwd, dto: r.dto }) : "";
  };

  const setStatus = () => {
    setWhere();
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
    // The question in the box or in the pane is not one that waits.
    if (asked && !queue.asking && !(side.focused && side.content?.question)) {
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
        box.panel
          ? "esc back · ctrl+o close"
          : side.focused
            ? "esc keys back · ctrl+] type · ctrl+x hide"
            : side.shown
              ? "enter to send · ctrl+] view · ctrl+x hide · ctrl+o menu"
              : "enter to send · ctrl+o menu · alt+↑↓ rows · ctrl+t rooms · ctrl+x view",
      ),
    );
    status.setText(parts.join(dim(" · ")));
    tui.requestRender();
  };
  const toggle = () => {
    shown = !shown;
    placeSide();
    setStatus();
  };

  /** The person's messages in the view, oldest first. */
  // ponytail: walks the view's entries on each frame while the list shows;
  // keep the list per view if a long room makes it lag.
  const sent = () => {
    const r = rooms.get(view.roomId);
    if (!r) return [];
    const id = view.participantId;
    const all = id ? thread(r.state, id) : r.state.timeline;
    return all.flatMap((e) => (e.type === "user" ? [{ r, e }] : []));
  };
  /** The history list (M4-4, `ctrl+r`): the person's messages in the view,
   *  one row each, in the side view. A pick scrolls the transcript to it;
   *  on a narrow screen the view hides first, so the transcript shows. It
   *  follows the view, and grows as messages are sent. */
  const history = () =>
    side.fill({
      title: "history",
      list: {
        rows: () =>
          sent().map(
            ({ r, e }) =>
              `→ ${nameOf(r.state, e.participantId)}: ${printable(e.text).replace(/\s+/g, " ").trim()}`,
          ),
        pick: (at) => {
          const s = sent()[at];
          if (!s) return;
          if (!side.wide()) side.toggle(false);
          jump(s.e);
        },
        empty: "nothing sent in this view yet",
      },
      keys: [],
    });

  /** Sets what `chat/view.ts` decided the composer holds. The pre-fill
   *  first: `setText` calls `onChange` at once. */
  const compose = (c: Composer) => {
    prefill = c.prefill;
    if (c.text !== undefined) editor.setText(c.text);
  };

  const open = (next: View) => {
    // A pop-up belongs to the view it opened on.
    if (box.panel) hidePanel();
    view = next;
    flash = "";
    const r = rooms.get(next.roomId);
    compose(opened(r?.state, next, editor.getText(), prefill));
    // The person looks at the view: its lines are seen.
    if (r) for (const id of seenIn(r.state, next)) seen(r.state, id);
    redraw();
  };

  const onLine = (roomId: string, line: RoomEventLine, e?: Entry) => {
    const r = rooms.get(roomId);
    if (!r) return;
    ring();
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
    // The question the side view shows closed: its diff stays, and says how.
    if (kind === "_client_permission_answered" && e?.type === "permission") {
      side.closed(u.id, `${e.allow ? "allowed" : "denied"} (${e.reason})`);
    }
    // A question came or closed behind the box.
    syncBox();
    // The open thread's participant left the roster: back to the room's
    // timeline.
    const back =
      kind === "_client_participant_removed"
        ? participantLeft(view, roomId, line.participantId)
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

  /** A room's stream ended and the screen goes on. With no room left it
   *  stays, so the person can open one (M4-5). */
  const onClosed = (id: string, ended: Ended, r?: Followed) => {
    const gone = ended.kind === "dismissed";
    if (gone) syncBox();
    const label = r?.entry.title ?? id;
    const next = gone ? dismissed(rooms, view, id) : undefined;
    if (next) open(next);
    flash = gone ? `${label} was dismissed` : endedLine(ended, id);
    setStatus();
  };

  return new Promise((finish) => {
    // The transcript is printed to the normal screen on exit, so the
    // conversation stays in scrollback. Not by `tui.stop()`'s own reprint:
    // that pads every line to the full width, and a terminal that wraps at
    // the last column at once (Windows ConPTY, some multiplexers) then shows
    // an empty line after each one. It would also copy the status line and
    // the editor. So only the transcript is printed, with the padding cut.
    end = (code: number, ...last: string[]) => {
      if (done) return;
      done = true;
      set.stop();
      // The screen is going: a later throw gets Node's default again, a
      // stack and a non-zero exit, instead of being swallowed here.
      process.off("uncaughtException", crash);
      process.stdout.off("resize", placeSide);
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

    quit = (why) => {
      if (why.kind === "gone") {
        end(
          1,
          why.message
            ? `! ${why.message}`
            : "! the daemon stopped: start it with kapelle daemon start, then run kapelle chat",
        );
        return;
      }
      const { roomId, ended, err } = why;
      const msg = err ? [`! ${(err as Error).message}`] : [];
      end(codeOf(ended), ...msg, endedLine(ended, roomId));
    };

    tui.addInputListener((data) => {
      // A terminal with the kitty keyboard protocol also sends each key's
      // release, and `matchesKey` matches it. pi-tui drops it before the
      // focused component; drop it here too, or a key acts twice.
      if (isKeyRelease(data)) return undefined;
      if (matchesKey(data, Key.ctrl("c"))) {
        end(0, left());
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("o"))) {
        if (box.panel) hidePanel();
        else {
          // The menu has the keys, and the composer after it.
          side.focus(false);
          menu();
        }
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("t"))) {
        toggle();
        return { consume: true };
      }
      // A pop-up keeps every key: switching rows would close it and drop
      // what was typed. Esc first. Both sets are one job: `alt+↑↓` is the
      // easy one, `ctrl+p/n` works where a terminal sends no alt+arrow.
      if (box.panel) return undefined;
      // The side view (decided 2026-10-05): ctrl+x shows and hides it, and
      // ctrl+] moves the keys between it and the composer.
      if (matchesKey(data, Key.ctrl("x"))) {
        side.toggle();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("r"))) {
        history();
        return { consume: true };
      }
      if (side.shown && matchesKey(data, Key.ctrl("]"))) {
        side.focus(!side.focused);
        return { consume: true };
      }
      if (side.focused) {
        side.key(data);
        return { consume: true };
      }
      // The page keys scroll what is drawn where the timeline goes. A page
      // keeps 4 lines, as pi-tui's did; the side view's keeps 1, as it did
      // since #204. `scrollBy` stops following above the end and follows
      // again at it, as pi-tui's page keys did.
      const page = matchesKey(data, Key.pageUp)
        ? -1
        : matchesKey(data, Key.pageDown)
          ? 1
          : 0;
      if (page) {
        if (side.shown && !side.wide()) side.key(data);
        else scroll.scrollBy(page * Math.max(1, scroll.viewportHeight - 4));
        tui.requestRender();
        return { consume: true };
      }
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
      // A text set above came back through this handler, which set the
      // status line then.
      if (c.text === undefined) setStatus();
      // A question that came while the person typed opens once the text is
      // sent or deleted.
      offer();
    };
    // pi-tui calls this and drops the promise, so a throw (the daemon gone
    // mid-request) must be caught here, or it crashes on the alt screen.
    editor.onSubmit = (text) => {
      submit(text).catch(gone);
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
      if (c.verb === "ff") {
        editor.addToHistory(text);
        if (!(await forward(c, c.from))) giveBack();
        return;
      }
      if (c.verb === "diff") {
        editor.addToHistory(text);
        if (!(await changes(c, c.against))) giveBack();
        return;
      }
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
      await set.fresh();
      let res: Awaited<ReturnType<typeof call<MessageAccepted>>>;
      try {
        res = await call<MessageAccepted>(
          d,
          `/rooms/${r.entry.id}/agents/${t.id}/messages`,
          { method: "POST", body: { text: t.text } },
        );
      } catch {
        // A restart: the screen waits for the daemon (M6-7d).
        warn(`! ${NO_DAEMON}`);
        return giveBack();
      }
      if (!res.ok) warn(`! ${res.error.message}`);
    };

    /**
     * What an agent changed, in the side pane (M4-6): what is not committed,
     * or the whole branch. `b` switches and `r` asks again; a refusal, such
     * as no branch, goes to the status line and leaves the pane as it was.
     * Answers whether the view was filled.
     */
    changes = async (
      who: { id: string; name: string },
      against: "head" | "base",
    ) => {
      const res = await agentDiff(d, view.roomId, who.id, against);
      if (!res.ok) {
        flash = `! ${res.error.message}`;
        setStatus();
        return false;
      }
      const other = against === "head" ? "base" : "head";
      side.fill({
        title: `${who.name} · ${against === "head" ? "uncommitted" : "whole branch"}`,
        diff: { ...res.body, text: cleanDiff(res.body.text) },
        keys: [
          {
            key: "b",
            hint: `b ${other === "head" ? "uncommitted" : "whole branch"}`,
            run: () => void changes(who, other).catch(gone),
          },
          {
            key: "r",
            hint: "r reload",
            run: () => void changes(who, against).catch(gone),
          },
        ],
      });
      // A menu close can open a waiting question: that box keeps the keys,
      // and the view lets go of them, so the composer gets them after it.
      if (box.panel) {
        side.focus(false);
        box.focusPanel();
      }
      return true;
    };

    /**
     * Sends a command from the composer or the pop-up. A refusal stays in
     * the open pop-up, with its values, or goes to the status line; a
     * success closes the pop-up and says so on the status line. The
     * transcript is never written. Answers whether it went through. One
     * at a time: a second Enter on a form would send it again.
     */
    let busy = false;
    run = async (c: RouteCommand): Promise<boolean> => {
      if (busy) {
        const wait = "wait: the last command is still running";
        if (box.panel) {
          box.panel.error = wait;
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
      await set.fresh();
      try {
        out = await runCommand(d, view.roomId || undefined, c);
      } catch {
        // A restart: the screen waits for the daemon (M6-7d).
        flash = `! ${NO_DAEMON}`;
        setStatus();
        return false;
      }
      if (!out.ok) {
        if (out.code === "repo_not_added" && c.verb === "new") {
          askToAdd(c);
          return true;
        }
        if (box.panel) {
          box.panel.error = out.message;
          tui.requestRender();
        } else {
          flash = `! ${out.message}`;
          setStatus();
        }
        return false;
      }
      if (box.panel) hidePanel();
      if (c.verb === "new" && out.room) {
        const { id, cwd, title, status, updatedAt, participants } = out.room;
        set.add({
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

    /** Shows what a fast-forward would bring in the side pane, and confirms
     *  the move on Enter (M6-11a, 3b). Answers whether the pane was filled. */
    forward = async (target, from) => {
      const res = await agentForwardDiff(d, view.roomId, target.id, from.id);
      if (!res.ok) {
        flash = `! ${res.error.message}`;
        setStatus();
        return false;
      }
      side.fill({
        title: `${target.name} ← ${from.name} · fast-forward`,
        diff: { ...res.body, text: cleanDiff(res.body.text) },
        keys: [
          {
            key: "enter",
            hint: `enter fast-forward ${target.name}`,
            run: () =>
              void run({
                verb: "forward",
                id: target.id,
                name: target.name,
                fromId: from.id,
                fromName: from.name,
              })
                .then((ok) => {
                  if (ok) side.toggle(false);
                })
                .catch(gone),
          },
        ],
      });
      setStatus();
      return true;
    };

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
    set.start(list);
    open(view);
  });
}

export { chatTui };
