/**
 * `chat/tui/panel.ts` — the full-screen chat's pop-up (M4-12).
 *
 * The box at the centre of the timeline (M4-5) and what it shows: the
 * ctrl+o menu, a pick list, a text box, the help, the setup list (M9-3),
 * and the two forms, new room and add agent. It owns the open pop-up. Esc
 * goes back one level, and a first-level menu closes it. A command it sends goes through the
 * screen's `run`; the question box is `chat/tui/question.ts`.
 *
 * Typed letters filter a pick list (M7-5). Each menu row shows its slash
 * command on the right, and the menu has an `open` row for each room and
 * agent, because the sidebar can be hidden.
 *
 * The box has a thick border, yellow for a question and cyan for the rest,
 * with the title as a chip. `Screen` in `chat/tui.ts` dims what is behind.
 */

import {
  type Component,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  type SelectListLayoutOptions,
  type SettingItem,
  SettingsList,
  type TuiAltScreen,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  HELP,
  participantNow,
  type RouteCommand,
} from "../../client/command.ts";
import type { HarnessesReply, RepoAdded } from "../../client/contract.ts";
import { call, type DaemonAddress } from "../../client/daemon.ts";
import {
  absoluteFolder,
  completeFolder,
  FOLDER_GONE,
} from "../../client/folder.ts";
import { nameOf, printable, roster } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import {
  findAgain,
  installAgents,
  markDone,
  needsSetup,
  readHarnesses,
  setupLines,
} from "../../client/setup.ts";
import { bold, cyan, dim, inverse, NO_DAEMON, yellow } from "../common.ts";
import { rows, same, type View } from "../view.ts";
import type { Queue } from "./question.ts";
import { SIDEBAR_WIDTH } from "./sidebar.ts";

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
/** Let a pick list size its label column to its widest row, so a command
 *  still fits on the right in the 80-column chat's pop-up. A label cut to
 *  fit ends with `…`, so a long name does not read as another name. */
const PICK_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 1,
  maxPrimaryColumnWidth: 22,
  truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…"),
};

/** The roles (R44) and modes (R12) the menu offers. The daemon checks
 *  them; an unknown one it adds later is typed as `@name /role x`. */
const ROLES = ["orchestrator", "developer", "tester", "architect", "reviewer"];
const MODES = ["auto", "ask", "safe"];
/** The last entry of the base and harness lists: it turns the list into a
 *  text box, for a git ref or a harness the daemon did not list. */
const OTHER_REF = "other ref…";
const OTHER_HARNESS = "other…";
const OTHER_MODEL = "other model…";
/** The setup list's title (M9-3). */
const SETUP = "agents";
const TYPE_IT = new Set([OTHER_REF, OTHER_HARNESS, OTHER_MODEL]);

/**
 * The pop-up (M4-5): the ctrl+o menu, a pick list, a text box or a form, in
 * a box at the centre of the timeline, where a folder or a command fits on
 * one line (decided 2026-09-30). While it is open it has the keys, and
 * `error` holds the daemon's refusal.
 */
interface Panel {
  title: string;
  /** Text at the right of the top border: a question's `n of m` (M7-4). */
  right?: string;
  body: Component;
  error?: string;
  /** Which setup opening owns this panel. Generic panels never have one. */
  setup?: number;
}

/**
 * The pop-up's top border, `width` wide, in `edge`'s colour: the corner,
 * the title, and `right` at the end (M7-4). The title is a chip in reverse
 * video, so it shows with `NO_COLOR` too. The title is cut with `…`, never
 * the corner. When the box is too narrow for both, `right` goes first: the
 * title says who wants what, and the status line still counts the
 * questions.
 */
function border(
  title: string,
  right: string | undefined,
  width: number,
  edge: (s: string) => string,
) {
  // `┏`, the chip's two spaces, at least one `━`, and `┓` take 5.
  const end = right ? ` ${right} ━` : "";
  const keep = width - 5 - visibleWidth(end) >= 4 ? end : "";
  const chip = ` ${truncateToWidth(title, Math.max(1, width - 5 - visibleWidth(keep)), "…")} `;
  const fill = "━".repeat(
    Math.max(0, width - 2 - visibleWidth(chip) - visibleWidth(keep)),
  );
  return `${edge("┏")}${inverse(edge(chip))}${edge(`${fill}${keep}┓`)}`;
}

const SETTINGS_THEME = {
  label: (s: string, on: boolean) => (on ? bold(s) : s),
  value: (s: string, on: boolean) => (on ? cyan(s) : dim(s)),
  description: dim,
  cursor: cyan("▸ "),
  hint: dim,
};

/** The pop-up over the screen. `say` sets the status line's message; the
 *  rest are the screen's. */
function panelParts({
  d,
  fresh,
  tui,
  editor,
  queue,
  rooms,
  view,
  shown,
  say,
  setStatus,
  offer,
  question,
  changes,
  forward,
  deleteRoom,
  open,
  run,
  end,
  left,
}: {
  d: DaemonAddress;
  /** `daemon.json` read again, so a request after a restart has the new
   *  token (M6-7d). */
  fresh: () => Promise<void>;
  tui: TuiAltScreen;
  editor: Component;
  queue: Queue;
  rooms: ReadonlyMap<string, Followed>;
  view: () => View;
  shown: () => boolean;
  say: (text: string) => void;
  setStatus: () => void;
  offer: () => void;
  question: (id: string) => void;
  /** Opens what an agent changed in the side pane (M4-6). */
  changes: (who: { id: string; name: string }) => void;
  /** Opens the fast-forward preview in the side pane (M6-11a, 3b). */
  forward: (
    target: { id: string; name: string },
    from: { id: string; name: string },
  ) => void;
  /** Opens the delete preview in the side pane (#352). */
  deleteRoom: () => void;
  /** Opens a room or a thread, as a sidebar row does (M7-5). */
  open: (next: View) => void;
  run: (c: RouteCommand) => Promise<boolean>;
  end: (code: number, ...last: string[]) => void;
  left: () => string;
}) {
  /** The pop-up, while one is open (M4-5), and pi-tui's handle on it. */
  let panel: Panel | undefined;
  let overlay: OverlayHandle | undefined;
  /** Each opening of the setup list, and whether the person has opened or
   *  dismissed it. The startup response must not reopen it after a close. */
  let setupGeneration = 0;
  let setupTouched = false;
  /** How many rows a list in the pop-up may show. */
  const panelRoom = () =>
    Math.max(3, Math.min(12, (process.stdout.rows || 24) - 12));
  /** The pop-up's box: the title in its top border, then the body, a key
   *  hint for a list, and the refusal. The border is yellow for a question
   *  and cyan for the rest. */
  const frame: Component = {
    render(width) {
      if (!panel) return [];
      const edge = queue.asking ? yellow : cyan;
      const inner = Math.max(1, width - 4);
      const side = (l: string) =>
        `${edge("┃")} ${truncateToWidth(l, inner, "…", true)} ${edge("┃")}`;
      const lines = [border(panel.title, panel.right, width, edge)];
      for (const l of panel.body.render(inner)) lines.push(side(l));
      if (panel.error) {
        for (const l of wrapTextWithAnsi(yellow(`! ${panel.error}`), inner)) {
          lines.push(side(l));
        }
      }
      lines.push(edge(`┗${"━".repeat(Math.max(0, width - 2))}┛`));
      return lines;
    },
    handleInput: (key) => panel?.body.handleInput?.(key),
    invalidate: () => panel?.body.invalidate(),
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

  /** The measured harnesses the daemon found ready (#367), from the last
   *  harnesses reply. Unset until `GET /harnesses` answers, and for good
   *  when this daemon has no such route or the ask failed: then the harness
   *  row is a text box. */
  let ready: string[] | undefined;
  /** Each harness's saved model ids (M9-4), from the same reply. */
  const models = new Map<string, string[]>();
  /** Replies can take seconds while the daemon checks agents, so one asked
   *  for earlier can land after a newer find or install. Remember the order,
   *  and never let an older reply put the row back. */
  let harnessAsked = 0;
  let harnessLearned = 0;
  /** Takes the harness row and the models from a harnesses reply, if it is
   *  at least as new as the last one learned: the one at start, a new find,
   *  or an install's. So an agent installed from `/setup` shows in the forms
   *  with no restart. An entry with no `state` is left out: there is no
   *  fallback for a daemon older than M9-3. */
  const learn = (r: HarnessesReply, order: number) => {
    if (order < harnessLearned) return;
    harnessLearned = order;
    const ids: string[] = [];
    models.clear();
    for (const h of r.harnesses) {
      if (h.measured && h.state === "ready") ids.push(h.id);
      if (h.models?.length)
        models.set(
          h.id,
          h.models.map((m) => m.id),
        );
    }
    ready = ids.sort((a, b) => a.localeCompare(b));
  };
  /** Asks `GET /harnesses` once, when the screen is up, and does not wait.
   *  Its answer fills `ready`, and opens the setup list when the person
   *  has not said "done" or no agent is ready (M9-3), unless a pop-up, a
   *  question or `busy` (the side view) came first. */
  const atStart = async (busy: () => boolean = () => false) => {
    const order = ++harnessAsked;
    const res = await readHarnesses(d).catch(() => undefined);
    if (!res?.ok) return;
    learn(res.body, order);
    // A manual /setup, or its close, while this GET was pending is the
    // person's answer: the late startup reply must not reopen the list.
    // The side view too: a list over the shell the person just opened
    // would take the keys they are typing.
    if (
      needsSetup(res.body) &&
      !setupTouched &&
      !panel &&
      !queue.asking &&
      !busy()
    ) {
      await showSetup(res.body);
    }
  };

  /** Shows `body` in the pop-up. A new body replaces the last one in
   *  the same box, as the menu gives way to a pick list. */
  const showPanel = (title: string, body: Component, setup?: number) => {
    panel = { title, body, ...(setup !== undefined && { setup }) };
    queue.show(undefined);
    if (!overlay) {
      // Centred on the timeline, not the terminal: pi-tui centres on
      // the terminal, so move right by half the sidebar.
      // ponytail: placed once; a resize or ctrl+t while it is open
      // leaves it where it was, until it closes.
      const cols = process.stdout.columns || 80;
      const gutter = shown() ? SIDEBAR_WIDTH : 2;
      overlay = tui.showOverlay(frame, {
        anchor: "center",
        offsetX: Math.floor(gutter / 2),
        width: Math.max(10, Math.min(80, cols - gutter - 4)),
        maxHeight: "80%",
      });
    }
    tui.setFocus(frame);
    setStatus();
  };
  /** Gives an open pop-up the keys back after another view took them. */
  const focusPanel = () => {
    if (panel) tui.setFocus(frame);
  };
  /** A filterable list. Typed letters filter the rows (M7-5), fuzzy over
   *  the label and the description, which holds a row's slash command, best
   *  match first. pi-tui's `setFilter` is not used: it matches only the
   *  start of the hidden `value`. Esc first clears the filter, then calls
   *  `back`. */
  // Its calls are one component's render, input and list plumbing.
  // pi-lens-ignore: high-fan-out
  const picker = (
    items: SelectItem[],
    current: string | undefined,
    then: (value: string) => void,
    back: () => void,
  ): Component => {
    const filter = textBox("");
    const listOf = (shown: SelectItem[]) => {
      const l = new SelectList(
        shown,
        panelRoom(),
        EDITOR_THEME.selectList,
        PICK_LAYOUT,
      );
      l.onSelect = ({ value }) => then(value);
      // The full list starts on the current value, also after the filter
      // is cleared, so Enter on it keeps the value. A filtered list starts
      // on its best match.
      const at =
        shown === items ? items.findIndex((i) => i.value === current) : -1;
      if (at > 0) l.setSelectedIndex(at);
      return l;
    };
    let list = listOf(items);
    const narrow = () => {
      const q = filter.getValue().trim();
      list = listOf(
        q
          ? fuzzyFilter(items, q, (i) => `${i.label} ${i.description ?? ""}`)
          : items,
      );
    };
    const LIST_KEYS = [
      "tui.select.up",
      "tui.select.down",
      "tui.select.pageUp",
      "tui.select.pageDown",
      "tui.select.confirm",
    ] as const;
    // SelectList draws descriptions only above 40 columns. The default
    // 80-column chat's pop-up body is 40, so render at 41 and crop the
    // result. The narrow label column leaves the command inside that line.
    const listLines = (w: number) =>
      list
        .render(Math.max(w, 41))
        .map((line) => truncateToWidth(line, w, "…", true));
    return {
      render: (w) => [
        ...(filter.getValue() ? filter.render(w) : []),
        ...listLines(w),
        dim(
          filter.getValue()
            ? "↑↓ Enter · Esc clear"
            : "type to filter · ↑↓ Enter · Esc back",
        ),
      ],
      handleInput(key) {
        const kb = getKeybindings();
        if (kb.matches(key, "tui.select.cancel")) {
          if (!filter.getValue()) return back();
          filter.setValue("");
          narrow();
        } else if (LIST_KEYS.some((k) => kb.matches(key, k))) {
          list.handleInput(key);
        } else {
          const was = filter.getValue();
          filter.handleInput(key);
          if (filter.getValue() !== was) narrow();
        }
        tui.requestRender();
      },
      invalidate: () => {
        filter.invalidate();
        list.invalidate();
      },
    };
  };
  /** A pick list in the pop-up. `back` is where Esc goes: the parent menu
   *  on a second-level list, and the whole pop-up closes by default. */
  // The fifth parameter is the optional Esc fallback, not a required input.
  // pi-lens-ignore: long-parameter-list
  const pickList = (
    title: string,
    items: SelectItem[],
    current: string | undefined,
    then: (value: string) => void,
    back: () => void = hidePanel,
  ) => showPanel(title, picker(items, current, then, back));
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

  /** `@name /model` (M9-6): the live session's models, the cursor on the
   *  one in use, then `other model…` to type one; a text box when it lists
   *  none. The change goes through `run`, as `/mode` does. */
  const pickModel = async (
    who: { id: string; name: string },
    back: () => void = hidePanel,
  ) => {
    const roomId = view().roomId;
    await fresh();
    const r = await participantNow(d, roomId, who.id).catch(() => undefined);
    if (!r?.ok) {
      say(`! ${r ? r.message : NO_DAEMON}`);
      setStatus();
      return;
    }
    const title = `${who.name} · model`;
    const { id, name } = who;
    const set = (model: string) =>
      void run({ verb: "patch", id, name, change: { model: model.trim() } });
    const type = () => {
      const input = textBox("");
      // Enter on nothing is Esc: an empty id is no model to ask for.
      input.onSubmit = (model) => (model.trim() ? set(model) : back());
      input.onEscape = back;
      showPanel(title, input);
    };
    const { models, model } = r.p;
    if (!models?.length) return type();
    pickList(
      title,
      [
        ...models.map((m) => ({
          value: m.id,
          label: printable(m.id),
          ...(m.name && m.name !== m.id && { description: printable(m.name) }),
        })),
        { value: OTHER_MODEL, label: OTHER_MODEL },
      ],
      model,
      (v) => (v === OTHER_MODEL ? type() : set(v)),
      back,
    );
  };

  /** The commands, short, in the pop-up. Esc goes back; Enter closes. */
  const showHelp = (back: () => void = hidePanel) =>
    showPanel("commands", {
      render: (w) => HELP.flatMap((l) => wrapTextWithAnsi(l, w)),
      handleInput(key) {
        if (matchesKey(key, Key.escape)) back();
        else if (matchesKey(key, Key.enter)) hidePanel();
      },
      invalidate() {},
    });

  /** `/setup done`, or Enter in the setup list: the list stops opening at
   *  start. A refusal stays in the list when it is open. */
  const setupDone = async () => {
    setupTouched = true;
    // Capture the opening, not the title: a late answer for this one must
    // not close a newer /setup, and an unrelated "agents" panel is not ours.
    const target = panel?.setup;
    await fresh();
    const r = await markDone(d).catch(() => undefined);
    const error = !r ? NO_DAEMON : !r.ok ? r.error.message : undefined;
    const stillOurs = target !== undefined && panel?.setup === target;
    if (error && stillOurs && panel) {
      panel.error = error;
      return tui.requestRender();
    }
    if (stillOurs) hidePanel();
    say(error ? `! ${error}` : "setup done: /setup shows the list again");
    setStatus();
  };

  /** One setup line, in its tone. */
  const toned = (l: { text: string; tone?: "dim" | "warn" }) =>
    l.tone === "dim"
      ? dim(l.text)
      : l.tone === "warn"
        ? yellow(l.text)
        : l.text;

  /** The setup list's body: the lines `before` (an install's result), then
   *  one line per agent. A "main program only" agent has a check box
   *  (M9-3b): ↑↓ move, Space checks, and Enter installs the checked ones,
   *  or is "done" when none is. Esc closes it, and it opens again at the
   *  next start. `checked` and `focus` outlive one body, so the new find
   *  keeps a checked box and the cursor on the agent the person chose. */
  const setupList = (
    r: HarnessesReply | undefined,
    before: { text: string; tone?: "dim" | "warn" }[] = [],
    checked = new Set<string>(),
    focus?: { id?: string },
  ): Component => {
    const lines = r
      ? setupLines(r)
      : [{ text: "looking for agents…", tone: "dim" as const }];
    const boxes = lines.flatMap((l) => (l.install ? [l.install] : []));
    for (const id of checked) if (!boxes.includes(id)) checked.delete(id);
    let at = focus?.id === undefined ? 0 : Math.max(0, boxes.indexOf(focus.id));
    if (focus) focus.id = boxes[at];
    return {
      render: (w) => [
        ...before.flatMap((l) => wrapTextWithAnsi(toned(l), w)),
        ...(before.length ? [""] : []),
        ...lines.flatMap((l) => {
          if (!boxes.length) return wrapTextWithAnsi(toned(l), w);
          const box = l.install
            ? `${boxes[at] === l.install ? cyan("›") : " "} [${checked.has(l.install) ? "x" : " "}] `
            : "      ";
          return wrapTextWithAnsi(`${box}${toned(l)}`, w);
        }),
        "",
        dim(
          checked.size
            ? "Enter setup · Space check · Esc later"
            : boxes.length
              ? "Space check · Enter done · Esc later"
              : "Enter done · Esc later",
        ),
      ],
      handleInput(key) {
        if (matchesKey(key, Key.escape)) hidePanel();
        else if (matchesKey(key, Key.up)) {
          at = Math.max(0, at - 1);
          if (focus) focus.id = boxes[at];
        } else if (matchesKey(key, Key.down)) {
          at = Math.min(boxes.length - 1, at + 1);
          if (focus) focus.id = boxes[at];
        } else if (matchesKey(key, Key.space) && boxes[at]) {
          const id = boxes[at] as string;
          if (!checked.delete(id)) checked.add(id);
        } else if (matchesKey(key, Key.enter)) {
          void (checked.size ? setupInstall([...checked]) : setupDone());
        }
        tui.requestRender();
      },
      invalidate() {},
    };
  };

  /** The setup list (M9-3): a new find each time it opens, then one line
   *  per agent. `inHand` shows while the daemon looks, so the start draws
   *  the reply it already has; the new find then catches an install made
   *  since that find was saved. */
  const showSetup = async (inHand?: HarnessesReply) => {
    setupTouched = true;
    const generation = ++setupGeneration;
    const checked = new Set<string>();
    const focus: { id?: string } = {};
    showPanel(SETUP, setupList(inHand, [], checked, focus), generation);
    await fresh();
    const order = ++harnessAsked;
    const r = await findAgain(d).catch(() => undefined);
    if (r?.ok) learn(r.body, order);
    // Closed, or replaced, while the daemon looked.
    if (panel?.setup !== generation) return;
    if (r?.ok)
      showPanel(SETUP, setupList(r.body, [], checked, focus), generation);
    else panel.error = r ? r.error.message : NO_DAEMON;
    tui.requestRender();
  };

  /** The "setup" button (M9-3b): the daemon installs the checked agents,
   *  and the list shows npm's output as it comes, then the new find. A
   *  failed install shows its error and the command to run by hand. Esc
   *  hides the output; the install goes on, and the status line says how
   *  it ended. */
  const setupInstall = async (ids: string[]) => {
    const generation = ++setupGeneration;
    const out: string[] = [];
    // Only the last ten lines ever draw. npm can write for three minutes, so
    // keep the list from growing with its whole output.
    const remember = (line: string) => {
      out.push(line);
      if (out.length > 10) out.splice(0, out.length - 10);
    };
    showPanel(
      SETUP,
      {
        render: (w) => [
          dim(`installing ${ids.map(printable).join(", ")}…`),
          ...out.flatMap((l) => wrapTextWithAnsi(dim(l), w)),
          "",
          dim("Esc hides this; the install goes on"),
        ],
        handleInput(key) {
          if (matchesKey(key, Key.escape)) hidePanel();
        },
        invalidate() {},
      },
      generation,
    );
    await fresh();
    const r = await installAgents(d, ids, (l) => {
      const text = "command" in l ? `$ ${l.command}` : l.output;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) remember(printable(line));
      }
      if (panel?.setup === generation) tui.requestRender();
    }).catch((err: unknown) =>
      // `fetch` throws a TypeError when no daemon answers. A broken reply is
      // another Error, so it keeps its message.
      err instanceof TypeError
        ? NO_DAEMON
        : err instanceof Error
          ? err.message
          : String(err),
    );
    const ours = panel?.setup === generation;
    if (typeof r === "string" || !r.ok) {
      const error = typeof r === "string" ? r : r.error.message;
      if (ours && panel) panel.error = error;
      else {
        say(`! setup: ${error}`);
        setStatus();
      }
      return tui.requestRender();
    }
    const { failed, setup } = r.body;
    learn(setup, ++harnessAsked);
    if (!ours) {
      say(
        failed.length
          ? `! setup: ${failed.map((f) => printable(f.id)).join(", ")} failed: /setup`
          : `setup: installed ${ids.map(printable).join(", ")}`,
      );
      setStatus();
      return tui.requestRender();
    }
    // The command on its own line, so it does not wrap and stays copyable.
    // A failure with no command is one a hand run cannot help (#374).
    const before = failed.flatMap((f) =>
      f.command
        ? [
            {
              text: `! ${printable(f.id)}: ${printable(f.error)}. Run it yourself:`,
              tone: "warn" as const,
            },
            { text: `  ${printable(f.command)}`, tone: "warn" as const },
          ]
        : [
            {
              text: `! ${printable(f.id)}: ${printable(f.error)}.`,
              tone: "warn" as const,
            },
          ],
    );
    if (failed.length) {
      for (const l of out.slice(-6)) before.push({ text: l, tone: "warn" });
    }
    showPanel(SETUP, setupList(setup, before), generation);
    tui.requestRender();
  };

  /** Opens the ctrl+o menu. `pid` is the agent whose commands it lists;
   *  `back` is where Esc goes. It reopens itself as `self`, so a menu or
   *  form it opens can return here. */
  const openMenu = (pid: string | undefined, back: () => void) => {
    const r = rooms.get(view().roomId);
    const p = pid ? r?.state.participants.get(pid) : undefined;
    const items: SelectItem[] = queue.open().map(({ r: qr, q }) => ({
      value: `?${q.id}`,
      label: `? ${nameOf(qr.state, q.participantId)} asks: ${q.title}`,
    }));
    // Each command row shows its slash command on the right, so the person
    // learns it (M7-5).
    const row = (value: string, label: string, command: string) => ({
      value,
      label,
      description: command,
    });
    if (p) {
      const forwardable = r
        ? roster(r.state).some((q) => q.id !== p.id)
        : false;
      // Only the command: `@name ` before it would push it out of a narrow
      // box when the name is long. The title names the agent (M7-5).
      items.push(
        row("cancel", "cancel turn", "/cancel"),
        // The value is in the label: the right column holds the command.
        row("mode", `mode · ${p.mode}`, "/mode"),
        row("model", "model …", "/model"),
        row("role", `role · ${p.role ?? "none"}`, "/role"),
        row("rename", "rename …", "/rename"),
        row("diff", "view changes", "/diff"),
      );
      if (forwardable) {
        items.push(row("forward", "fast-forward from …", "/ff"));
      }
      items.push(row("remove", `remove ${p.name}`, "/remove"));
    } else if (r && roster(r.state).length > 0) {
      items.push({ value: "agent", label: "agent …" });
    }
    if (r) items.push(row("add", "add agent …", "/add"));
    if (r) items.push(row("title", "rename room …", "/title"));
    items.push(row("new", "new room …", "/new"));
    if (r) items.push(row("dismiss", "dismiss room", "/dismiss"));
    if (r) items.push(row("delete", "delete room …", "/delete"));
    // A row for each room and agent, as the sidebar has, because the
    // sidebar can be hidden. The view the person is on is left out.
    const opens = rows(rooms).filter((v) => !same(v, view()));
    opens.forEach((v, i) => {
      const f = rooms.get(v.roomId);
      if (!f) return;
      const room = f.entry.title ?? f.entry.id;
      items.push(
        v.participantId
          ? {
              value: `>${i}`,
              label: `open @${nameOf(f.state, v.participantId)}`,
              description: room,
            }
          : { value: `>${i}`, label: `open ${room}` },
      );
    });
    items.push(row("help", "help", "/help"));
    items.push(row("leave", "leave", "/leave"));
    let title = "menu";
    if (p) title = `${p.name} · ${p.harness}${p.role ? ` · ${p.role}` : ""}`;
    else if (r) title = r.entry.title ?? r.entry.id;
    const self = () => openMenu(pid, back);
    pickList(
      title,
      items,
      undefined,
      (value) => {
        const next = value.startsWith(">") && opens[Number(value.slice(1))];
        if (next) open(next);
        else choose(value, p, self);
      },
      back,
    );
  };

  /** The first-level menu for the open view: an agent's commands in a
   *  thread, the room's menu otherwise. Esc closes the pop-up. */
  const menu = () => openMenu(view().participantId, hidePanel);

  const choose = (
    value: string,
    p: ReturnType<typeof roster>[number] | undefined,
    self: () => void,
  ) => {
    const r = rooms.get(view().roomId);
    if (value.startsWith("?")) return question(value.slice(1));
    if (value === "leave") return end(0, left());
    if (value === "help") return showHelp(self);
    if (value === "new") return newForm(self);
    if (value === "add") return addForm(self);
    if (value === "dismiss") return void run({ verb: "dismiss" });
    if (value === "delete") {
      hidePanel();
      deleteRoom();
      return;
    }
    if (value === "title" && r) {
      const input = textBox(r.entry.title ?? "");
      // An empty title is the daemon's refusal, shown in the pop-up.
      input.onSubmit = (title) =>
        void run({ verb: "title", title: title.trim() });
      input.onEscape = self;
      return showPanel(`rename ${r.entry.title ?? r.entry.id}`, input);
    }
    if (value === "agent" && r) {
      const ps = roster(r.state);
      const items = ps.map((q) => ({
        value: q.id,
        label: q.name,
        ...(q.role && { description: q.role }),
      }));
      return pickList(
        "pick an agent",
        items,
        undefined,
        (id) => openMenu(id, self),
        self,
      );
    }
    if (!p) return;
    const who = { id: p.id, name: p.name };
    if (value === "diff") {
      hidePanel();
      return changes(who);
    }
    if (value === "forward" && r) {
      const ps = roster(r.state).filter((q) => q.id !== p.id);
      const items = ps.map((q) => ({
        value: q.id,
        label: q.name,
        ...(q.role && { description: q.role }),
      }));
      return pickList(
        `fast-forward ${p.name} from`,
        items,
        undefined,
        (id) => {
          const from = ps.find((q) => q.id === id);
          if (!from) return;
          hidePanel();
          forward({ id: p.id, name: p.name }, { id: from.id, name: from.name });
        },
        self,
      );
    }
    if (value === "cancel") return void run({ verb: "cancel", ...who });
    if (value === "remove") return void run({ verb: "remove", ...who });
    if (value === "mode") {
      return pickList(
        `${p.name} · mode`,
        words(MODES),
        p.mode,
        (mode) => run({ verb: "patch", ...who, change: { mode } }),
        self,
      );
    }
    if (value === "model") return void pickModel(who, self);
    if (value === "role") {
      const roles = words(["none", ...ROLES]);
      return pickList(
        `${p.name} · role`,
        roles,
        p.role ?? "none",
        (role) =>
          run({
            verb: "patch",
            ...who,
            change: { role: role === "none" ? null : role },
          }),
        self,
      );
    }
    if (value === "rename") {
      const input = textBox(p.name);
      input.onSubmit = (name) =>
        void run({ verb: "patch", ...who, change: { name: name.trim() } });
      input.onEscape = self;
      showPanel(`rename ${p.name}`, input);
    }
  };

  /**
   * A form in the pop-up: one row per field, then the row that sends it.
   * Enter on a row opens a text box, or a pick list for a field with
   * `pick`. A refusal keeps the form open with its values. `back` is where
   * Esc goes; by default the pop-up closes.
   */
  // The fifth parameter is the optional Esc fallback, not a required input.
  // pi-lens-ignore: long-parameter-list
  const form = (
    title: string,
    fields: {
      id: string;
      label: string;
      value: string;
      /** A pick list, or one worked out from the form's values when the row
       *  opens; none there makes the row a text box. */
      pick?: string[] | ((v: Record<string, string>) => string[] | undefined);
      /** Tab completes a folder path. */
      folder?: true;
    }[],
    go: string,
    command: (v: Record<string, string>) => RouteCommand | { error: string },
    back: () => void = hidePanel,
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
        const pick = typeof f.pick === "function" ? f.pick(values) : f.pick;
        if (!pick)
          return f.folder ? folderField(value, done) : field(value, done);
        // The last pick can turn the list into a text box: a git ref.
        let now: Component;
        now = picker(
          words(pick),
          value,
          (v) => {
            if (!TYPE_IT.has(v)) return done(v);
            now = field("", done);
            tui.requestRender();
          },
          () => done(),
        );
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
      back,
    );
    showPanel(title, list);
  };

  /** The harness row: a pick list of the ready harnesses (#367), then
   *  `other…` to type a name. A text box while `ready` is unset: the daemon
   *  has no `GET /harnesses`, or it has not answered. `–` is no harness: an
   *  empty room, or `command` instead. */
  const harnessField = () => ({
    id: "agent",
    label: "harness",
    value: "",
    // Read when the row opens, not when the form opens: a find or install
    // can land while the form is already on screen (#367).
    pick: () => ready && ["–", ...ready, OTHER_HARNESS],
  });

  /** The model row (M9-5): the chosen harness's saved models, then
   *  `other model…` to type one. A text box when it has none saved, such as
   *  a `command`. `–` is the harness's own model. */
  const modelField = () => ({
    id: "model",
    label: "model",
    value: "",
    pick: (v: Record<string, string>) => {
      const saved = v.cmd ? undefined : models.get(v.agent ?? "");
      return saved && ["–", ...saved, OTHER_MODEL];
    },
  });

  /**
   * `/new` or `/loop` in a folder the daemon has not added: ask, in the pop-up, and
   * on yes add its repository and open the room in one step. The question
   * is ours, from the code: the daemon's message is advice for a program.
   */
  const askToAdd = (c: Extract<RouteCommand, { verb: "new" | "loop" }>) => {
    const back = panel;
    const toForm = () => {
      if (back) showPanel(back.title, back.body);
      else hidePanel();
    };
    const items = [
      { value: "add", label: "add and open" },
      { value: "back", label: back ? "back to the form" : "cancel" },
    ];
    pickList(
      "folder not added",
      items,
      undefined,
      async (v) => {
        if (v !== "add") return toForm();
        let added: Awaited<ReturnType<typeof call<RepoAdded>>>;
        await fresh();
        try {
          added = await call<RepoAdded>(d, "/repos", {
            method: "POST",
            body: { path: c.body.cwd },
          });
        } catch {
          // A restart: the screen waits for the daemon (M6-7d).
          if (panel) panel.error = NO_DAEMON;
          else say(`! ${NO_DAEMON}`);
          tui.requestRender();
          return;
        }
        if (!added.ok) {
          if (panel) panel.error = added.error.message;
          tui.requestRender();
          return;
        }
        await run(c);
      },
      toForm,
    );
    if (panel)
      // The daemon adds the whole repository the folder is in.
      panel.error = `${c.body.cwd} is not added to the daemon. Add its repository?`;
    tui.requestRender();
  };

  const addForm = (back: () => void = hidePanel) => {
    const r = rooms.get(view().roomId);
    if (!r) {
      say("! no room: open one first");
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
        modelField(),
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
          model: v.model || undefined,
          base: v.base === "HEAD" ? undefined : v.base,
        },
      }),
      back,
    );
  };

  const newForm = (back: () => void = hidePanel) =>
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
        modelField(),
      ],
      "open",
      (v) => {
        const cwd = absoluteFolder(v.cwd || ".");
        if (!cwd) return { error: FOLDER_GONE };
        // As `/new --model` alone is refused: an empty room has no agent
        // to set it on.
        if (v.model && !v.agent && !v.cmd) {
          return { error: "a model needs a harness or a command" };
        }
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
                      model: v.model || undefined,
                      role: "developer",
                    },
                  ]
                : [],
          },
        };
      },
      back,
    );

  return {
    get panel() {
      return panel;
    },
    hidePanel,
    showPanel,
    focusPanel,
    words,
    menu,
    pickModel,
    showHelp,
    showSetup,
    setupDone,
    atStart,
    newForm,
    addForm,
    askToAdd,
  };
}

export { border, EDITOR_THEME, panelParts };
