/**
 * `chat/tui/panel.ts` — the full-screen chat's pop-up (M4-12).
 *
 * The box at the centre of the timeline (M4-5) and what it shows: the
 * ctrl+o menu, a pick list, a text box, the help, and the two forms, new
 * room and add agent. It owns the open pop-up. Esc goes back one level,
 * and a first-level menu closes it. A command it sends goes through the
 * screen's `run`; the question box is `chat/tui/question.ts`.
 */

import {
  type Component,
  Input,
  Key,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  type TuiAltScreen,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { HELP, type RouteCommand } from "../../client/command.ts";
import type { HarnessEntry, RepoAdded } from "../../client/contract.ts";
import { call, type DaemonAddress } from "../../client/daemon.ts";
import {
  absoluteFolder,
  completeFolder,
  FOLDER_GONE,
} from "../../client/folder.ts";
import { nameOf, roster } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { bold, cyan, dim, NO_DAEMON, yellow } from "../common.ts";
import type { View } from "../view.ts";
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
  /** Text at the right of the top border: a question's `n of m` (M7-4). */
  right?: string;
  body: Component;
  error?: string;
}

/**
 * The pop-up's top border, `width` wide: the corner, the title, and `right`
 * at the end (M7-4). The title is cut with `…`, never the corner. When the
 * box is too narrow for both, `right` goes first: the title says who wants
 * what, and the status line still counts the questions.
 */
function border(title: string, right: string | undefined, width: number) {
  // `┌ `, a space after the title, at least one `─`, and `┐` take 5.
  const end = right ? ` ${right} ─` : "";
  const keep = width - 5 - visibleWidth(end) >= 4 ? end : "";
  const head = `┌ ${truncateToWidth(title, Math.max(1, width - 5 - visibleWidth(keep)), "…")} `;
  const fill = "─".repeat(
    Math.max(0, width - 1 - visibleWidth(head) - visibleWidth(keep)),
  );
  return `${head}${fill}${keep}┐`;
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
  run: (c: RouteCommand) => Promise<boolean>;
  end: (code: number, ...last: string[]) => void;
  left: () => string;
}) {
  /** The pop-up, while one is open (M4-5), and pi-tui's handle on it. */
  let panel: Panel | undefined;
  let overlay: OverlayHandle | undefined;
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
      const lines = [dim(border(panel.title, panel.right, width))];
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
  ) => {
    const list = new SelectList(items, panelRoom(), EDITOR_THEME.selectList);
    const at = items.findIndex((i) => i.value === current);
    if (at > 0) list.setSelectedIndex(at);
    list.onSelect = ({ value }) => then(value);
    list.onCancel = back;
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
    if (p) {
      const forwardable = r
        ? roster(r.state).some((q) => q.id !== p.id)
        : false;
      items.push(
        { value: "cancel", label: "cancel turn" },
        // The value is in the label: the sidebar is too narrow for a
        // second column.
        { value: "mode", label: `mode · ${p.mode}` },
        { value: "role", label: `role · ${p.role ?? "none"}` },
        { value: "rename", label: "rename …" },
        { value: "diff", label: "view changes" },
      );
      if (forwardable) {
        items.push({ value: "forward", label: "fast-forward from …" });
      }
      items.push({ value: "remove", label: `remove ${p.name}` });
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
    const self = () => openMenu(pid, back);
    pickList(title, items, undefined, (value) => choose(value, p, self), back);
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
      pick?: string[];
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
      back,
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
    showHelp,
    newForm,
    addForm,
    askToAdd,
  };
}

export { border, EDITOR_THEME, panelParts };
