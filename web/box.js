/**
 * The pop-up (spike/pwa), as `chat/tui/panel.ts` and `chat/tui/question.ts`:
 * the menu, a pick list, a text box, the help, the new-room and add-agent
 * forms, and the question box. It is the browser's own `<dialog>`, so the
 * focus stays in it and Esc reaches it. Esc goes back one level; a
 * first-level box closes.
 *
 * The question rules are the TUI's (M4-3, `client/questions.ts`): a
 * question opens by itself, but never over another pop-up or over text
 * the person typed; `deny` comes first, so a stray Enter says no; Esc puts
 * it aside, open.
 */

import { touched } from "./chat/view.ts";
import { HELP } from "./client/command.ts";
import { call } from "./client/daemon.ts";
import { diffLine } from "./client/diff.ts";
import { nameOf, roster } from "./client/room.ts";
import { h, pickList as list } from "./dom.js";

const ROLES = ["orchestrator", "developer", "tester", "architect"];
const MODES = ["auto", "ask", "safe"];

export function boxParts({
  d,
  queue,
  rooms,
  view,
  composer,
  side,
  say,
  setStatus,
  run,
  changes,
  end,
  left,
  prefill,
  done,
}) {
  const dialog = document.getElementById("box");
  const titleEl = document.getElementById("box-title");
  const bodyEl = document.getElementById("box-body");
  const errorEl = document.getElementById("box-error");
  /** The open pop-up: its title, body and where Esc goes. */
  let panel;

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    panel?.back();
  });

  const setError = (text) => {
    errorEl.textContent = text ? `! ${text}` : "";
    errorEl.hidden = !text;
  };

  /** Closes the pop-up. A question box the person closes means "away", so
   *  the next question waits too; any other box makes way for one. */
  const hidePanel = () => {
    const away = queue.away();
    panel = undefined;
    if (dialog.open) dialog.close();
    composer.focus();
    setStatus();
    if (!away) offer();
  };

  /** Shows `body` in the pop-up, in place of what it showed. */
  const showPanel = (title, body, back = hidePanel) => {
    panel = { title, body, back };
    queue.show(undefined);
    titleEl.textContent = title;
    bodyEl.replaceChildren(body);
    setError("");
    if (!dialog.open) dialog.showModal();
    (
      body.querySelector("[autofocus], input, select, li, button") ?? body
    ).focus?.();
    setStatus();
  };

  /** The measured harnesses, asked once and not awaited. */
  let measured = [];
  call(d(), "/harnesses").then(
    (res) => {
      if (res.ok) {
        measured = res.body
          .filter((x) => x.measured)
          .map((x) => x.id)
          .sort((a, b) => a.localeCompare(b));
      }
    },
    () => {},
  );

  /** A pick list. `back` is where Esc goes. */
  const pickList = (title, items, current, then, back = hidePanel) => {
    const el = list(
      items.map((i) =>
        i.description ? `${i.label} · ${i.description}` : i.label,
      ),
      (at) => then(items[at].value),
    );
    showPanel(title, el, back);
    const at = items.findIndex((i) => i.value === current);
    if (at > 0) el.children[at]?.focus();
  };
  const words = (values) => values.map((v) => ({ value: v, label: v }));

  /** A text box holding `value`; Enter hands it to `then`. */
  const textBox = (title, value, then, back) => {
    const input = h("input", { class: "box-input", value });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        then(input.value);
      }
    });
    showPanel(title, input, back);
    input.setSelectionRange(value.length, value.length);
  };

  const showHelp = (back = hidePanel) =>
    showPanel(
      "commands",
      h(
        "pre",
        {},
        [
          ...HELP.slice(0, -1),
          "/new and /add alone open a form; ctrl+k opens the menu",
        ].join("\n"),
      ),
      back,
    );

  /** The menu: an agent's commands in a thread, the room's otherwise.
   *  It reopens itself as `self`, so a box it opens can come back. */
  const openMenu = (pid, back) => {
    const r = rooms.get(view().roomId);
    const p = pid ? r?.state.participants.get(pid) : undefined;
    const items = queue.open().map(({ r: qr, q }) => ({
      value: `?${q.id}`,
      label: `? ${nameOf(qr.state, q.participantId)} asks: ${q.title}`,
    }));
    if (p) {
      items.push(
        { value: "cancel", label: "cancel turn" },
        { value: "mode", label: `mode · ${p.mode}` },
        { value: "role", label: `role · ${p.role ?? "none"}` },
        { value: "rename", label: "rename …" },
        { value: "diff", label: "view changes" },
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
    const self = () => openMenu(pid, back);
    pickList(title, items, undefined, (v) => choose(v, p, self), back);
  };
  const menu = () => openMenu(view().participantId, hidePanel);

  const choose = (value, p, self) => {
    const r = rooms.get(view().roomId);
    if (value.startsWith("?")) return question(value.slice(1));
    if (value === "leave") return end(left());
    if (value === "help") return showHelp(self);
    if (value === "new") return newForm(self);
    if (value === "add") return addForm(self);
    if (value === "dismiss") return void run({ verb: "dismiss" });
    if (value === "agent" && r) {
      const items = roster(r.state).map((q) => ({
        value: q.id,
        label: q.name,
        description: q.role,
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
      return pickList(
        `${p.name} · role`,
        words(["none", ...ROLES]),
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
      textBox(
        `rename ${p.name}`,
        p.name,
        (name) =>
          void run({ verb: "patch", ...who, change: { name: name.trim() } }),
        self,
      );
    }
  };

  /**
   * A form: one row per field, then the button that sends it. A field with
   * `pick` is a list; with `suggest` it is a text box that offers those
   * words and takes any other (a git ref, a harness the daemon did not
   * list). A folder field completes with Tab. A refusal keeps the form
   * open with its values.
   */
  const form = (title, fields, go, command, back = hidePanel) => {
    const inputs = {};
    const rows = fields.flatMap((f) => {
      const id = `f-${f.id}`;
      let input;
      const extra = [];
      if (f.pick) {
        input = h(
          "select",
          { id },
          f.pick.map((v) =>
            h("option", { value: v, selected: v === f.value }, v),
          ),
        );
      } else {
        input = h("input", {
          id,
          value: f.value,
          list: f.suggest ? `${id}-list` : undefined,
          placeholder: f.placeholder,
          autocomplete: "off",
          spellcheck: "false",
        });
        if (f.suggest) {
          extra.push(
            h(
              "datalist",
              { id: `${id}-list` },
              f.suggest.map((v) => h("option", { value: v })),
            ),
          );
        }
        if (f.folder) {
          const options = h("div", { class: "options" });
          extra.push(options);
          input.addEventListener("keydown", async (e) => {
            options.textContent = "";
            if (e.key !== "Tab" || e.shiftKey) return;
            e.preventDefault();
            const res = await call(
              d(),
              `/folders?path=${encodeURIComponent(input.value)}`,
            );
            if (!res.ok) return;
            input.value = res.body.value;
            const shown = res.body.options.slice(0, 12).map((o) => `${o}/`);
            if (res.body.options.length > 12) shown.push("…");
            options.textContent = shown.join("  ");
          });
        }
      }
      inputs[f.id] = input;
      return [h("label", { for: id }, f.label), input, ...extra];
    });
    const el = h(
      "form",
      { class: "fields" },
      rows,
      h("button", { class: "go", type: "submit" }, go),
    );
    el.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = Object.fromEntries(
        Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]),
      );
      const c = command(values);
      if ("error" in c) setError(c.error);
      else void run(c);
    });
    showPanel(title, el, back);
  };

  /** `/new` in a folder the daemon has not added: ask, and on yes add its
   *  repository and open the room in one step. */
  const askToAdd = (c) => {
    const before = panel;
    const toForm = () => {
      if (before) showPanel(before.title, before.body, before.back);
      else hidePanel();
    };
    pickList(
      "folder not added",
      [
        { value: "add", label: "add and open" },
        { value: "back", label: before ? "back to the form" : "cancel" },
      ],
      undefined,
      async (v) => {
        if (v !== "add") return toForm();
        let added;
        try {
          added = await call(d(), "/repos", {
            method: "POST",
            body: { path: c.body.cwd },
          });
        } catch (err) {
          return end(`! ${err.message}`);
        }
        if (!added.ok) return setError(added.error.message);
        await run(c);
      },
      toForm,
    );
    setError(`${c.body.cwd} is not added to the daemon. Add its repository?`);
  };

  const addForm = (back = hidePanel) => {
    const r = rooms.get(view().roomId);
    if (!r) {
      say("! no room: open one first");
      return setStatus();
    }
    form(
      "add agent",
      [
        { id: "agent", label: "harness", value: "", suggest: measured },
        { id: "cmd", label: "command", value: "" },
        { id: "name", label: "name", value: "" },
        { id: "role", label: "role", value: "none", pick: ["none", ...ROLES] },
        { id: "mode", label: "mode", value: "auto", pick: MODES },
        {
          id: "base",
          label: "base",
          value: "HEAD",
          suggest: ["HEAD", ...roster(r.state).map((p) => `@${p.name}`)],
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
          base: v.base === "HEAD" || !v.base ? undefined : v.base,
        },
      }),
      back,
    );
  };

  const newForm = (back = hidePanel) => {
    const here = rooms.get(view().roomId)?.entry.cwd;
    form(
      "new room",
      [
        {
          id: "cwd",
          label: "folder",
          value: here ?? globalThis.kapelleHome ?? "",
          folder: true,
          placeholder: "Tab completes",
        },
        { id: "title", label: "title", value: "" },
        {
          id: "agent",
          label: "harness",
          value: "",
          suggest: measured,
          placeholder: "none: an empty room",
        },
        { id: "cmd", label: "command", value: "" },
        { id: "name", label: "name", value: "" },
      ],
      "open",
      (v) => {
        if (!v.cwd.startsWith("/") && !v.cwd.startsWith("~")) {
          return { error: "give the folder as a full path" };
        }
        const cwd = v.cwd.startsWith("~")
          ? `${globalThis.kapelleHome}${v.cwd.slice(1)}`
          : v.cwd;
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
  };

  // The question box (M4-3).

  /** Keeps an open question box true: its count follows the open
   *  questions, and it goes when its question left without a close line. */
  const syncBox = () => {
    if (!queue.asking || !panel) return;
    const at = queue.place();
    if (!at) hidePanel();
    else titleEl.textContent = `question ${at.at} of ${at.of}`;
  };

  const question = (id) => {
    const found = queue.open().find(({ q }) => q.id === id);
    if (!found) {
      say("! that question already closed");
      return hidePanel();
    }
    const { r, q } = found;
    const turn = q.turn === undefined ? "" : ` · turn ${q.turn}`;
    const body = h(
      "div",
      {},
      h(
        "div",
        { class: "info" },
        h("p", { class: "dim" }, `room   ${r.entry.title ?? r.entry.id}`),
        h(
          "p",
          { class: "dim" },
          `agent  ${nameOf(r.state, q.participantId)}${turn}`,
        ),
        h("p", {}, `${q.kind} · ${q.title}`),
        h(
          "div",
          { class: "input" },
          Object.entries(q.input ?? {})
            .slice(0, 8)
            .map(([k, v]) => `${k}: ${v}\n`),
        ),
        q.diff ? h("p", {}, diffLine(q.diff)) : undefined,
      ),
      h(
        "div",
        { class: "choices" },
        h(
          "button",
          {
            type: "button",
            autofocus: true,
            onclick: () => answer(q.id, false),
          },
          "deny",
        ),
        h(
          "button",
          { type: "button", onclick: () => answer(q.id, true) },
          "allow",
        ),
        q.diff
          ? h(
              "button",
              { type: "button", onclick: () => showDiff(q) },
              "view diff",
            )
          : undefined,
      ),
    );
    showPanel("question", body);
    queue.show(q.id);
    syncBox();
    setStatus();
  };

  /** The question's diff in the side view. The box closes and its question
   *  is put aside; `y` and `n` answer, and `back` brings the box back. */
  const showDiff = (q) => {
    const at = queue.place();
    hidePanel();
    if (!q.diff) return;
    const answerHere = (allow) => () => {
      composer.focus();
      void answer(q.id, allow);
    };
    side.fill({
      title: at ? `question ${at.at} of ${at.of}` : "question",
      diff: q.diff,
      question: q.id,
      keys: [
        { key: "y", hint: "y allow", run: answerHere(true) },
        { key: "n", hint: "n deny", run: answerHere(false) },
      ],
      back: () => question(q.id),
    });
  };

  /** Sends the answer. A lost race names who won. */
  const answer = async (id, allow) => {
    hidePanel();
    offer();
    const path = `/permissions/${encodeURIComponent(id)}`;
    try {
      const res = await call(d(), path, { method: "POST", body: { allow } });
      if (res.ok) return;
      let why = res.error.message;
      if (res.status === 409) {
        const got = await call(d(), path);
        if (got.ok && got.body.reason)
          why = `already closed: ${got.body.reason}`;
      }
      say(`! ${why}`);
      setStatus();
    } catch (err) {
      end(`! ${err.message}`);
    }
  };

  /** Opens the next question, unless something is in the way. */
  const offer = () => {
    const next = queue.next(
      panel !== undefined ||
        side.focused ||
        done() ||
        touched(composer.value, prefill()),
    );
    if (next) question(next.q.id);
  };

  return {
    get panel() {
      return panel;
    },
    setError,
    hidePanel,
    menu,
    showHelp,
    newForm,
    addForm,
    askToAdd,
    question,
    offer,
    syncBox,
  };
}
