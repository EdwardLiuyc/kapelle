/**
 * The side view (spike/pwa), as `chat/tui/pane.ts`: a diff (a question's
 * edit, or what an agent changed) or a list to pick from (your messages),
 * beside the timeline, or in its place on a narrow screen. Its keys are
 * buttons in its header; with the focus in it, the same letters work, and
 * `]` and `[` jump between files. Esc gives the focus back to the composer.
 */

import { filesOf, named } from "./client/diff.ts";
import { h, pickList } from "./dom.js";

const EMPTY = [
  "nothing here yet",
  "/diff @name — what an agent changed",
  "view diff — in a question",
  "history — your messages",
];

/** A diff line's class, in git's colours. */
const kind = (line) =>
  line.startsWith("diff --git ")
    ? "file"
    : line.startsWith("@@")
      ? "hunk"
      : line.startsWith("+++ ") || line.startsWith("--- ")
        ? "meta"
        : line.startsWith("+")
          ? "add"
          : line.startsWith("-")
            ? "del"
            : "";

export function paneParts({ composer, setStatus }) {
  const pane = document.getElementById("pane");
  const title = document.getElementById("pane-title");
  const keys = document.getElementById("pane-keys");
  const body = document.getElementById("pane-body");
  let content;
  let files = [];
  let rowsAt = [];

  const current = () => {
    let at = 0;
    for (const [i, el] of rowsAt.entries())
      if (el.offsetTop - body.offsetTop <= body.scrollTop + 4) at = i;
    return at;
  };
  const jump = (to) => {
    rowsAt[Math.max(0, Math.min(rowsAt.length - 1, to))]?.scrollIntoView({
      block: "start",
    });
    head();
  };

  /** The header: what it shows, which file, and its keys as buttons. */
  const head = () => {
    if (!content) {
      title.textContent = "side view";
      keys.replaceChildren();
      return;
    }
    let text = content.title;
    if (content.diff) {
      const d = content.diff;
      const at = current();
      const f = files[at];
      const place = d.files > 1 ? ` (${at + 1} of ${d.files})` : "";
      text += f
        ? ` · ${named(f)}${place} · +${d.added} −${d.removed}`
        : " · no changes";
    }
    title.textContent = text;
    title.title = text;
    keys.replaceChildren(
      ...(files.length > 1
        ? [
            h(
              "button",
              { type: "button", onclick: () => jump(current() - 1) },
              "[",
            ),
            h(
              "button",
              { type: "button", onclick: () => jump(current() + 1) },
              "]",
            ),
          ]
        : []),
      ...content.keys.map((k) =>
        h(
          "button",
          { type: "button", onclick: k.run, title: `key ${k.key}` },
          k.hint,
        ),
      ),
      ...(content.back
        ? [h("button", { type: "button", onclick: content.back }, "back")]
        : []),
    );
  };

  const draw = () => {
    files = [];
    rowsAt = [];
    if (!content) {
      body.replaceChildren(
        ...EMPTY.map((l) => h("p", { class: "empty dim" }, l)),
      );
    } else if (content.list) {
      const rows = content.list.rows();
      body.replaceChildren(
        rows.length
          ? pickList(rows, content.list.pick)
          : h("p", { class: "empty dim" }, content.list.empty),
      );
    } else {
      const lines = content.diff.text ? content.diff.text.split("\n") : [];
      files = filesOf(lines);
      const out = lines.map((l) => h("div", { class: kind(l) }, l));
      rowsAt = files.map((f) => out[f.line]);
      body.replaceChildren(h("div", { class: "diff" }, out));
    }
    head();
  };

  body.addEventListener("scroll", () => content?.diff && head());
  body.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      composer.focus();
      return content?.back?.();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "]") return jump(current() + 1);
    if (e.key === "[") return jump(current() - 1);
    const k = content?.keys.find((x) => x.key === e.key);
    if (k) {
      e.preventDefault();
      k.run();
    }
  });

  /** Shows the view and gives it the focus, or hides it. What it shows
   *  stays. */
  const toggle = (show = pane.hidden) => {
    pane.hidden = !show;
    if (show) body.focus();
    else composer.focus();
    setStatus();
  };

  /** Puts `c` in the view, from its top, and shows it. */
  const fill = (c) => {
    content = c;
    draw();
    body.scrollTop = 0;
    toggle(true);
  };

  /** The question it shows closed: its diff stays, says how, and its keys
   *  go. */
  const closed = (id, how) => {
    if (content?.question !== id) return;
    content = {
      ...content,
      title: `${content.title} · ${how}`,
      keys: [],
      question: undefined,
      back: undefined,
    };
    head();
    setStatus();
  };

  draw();
  document.getElementById("pane-close").onclick = () => toggle(false);

  return {
    fill,
    closed,
    toggle,
    /** A list that follows the view draws again. */
    refresh: () => content?.list && !pane.hidden && draw(),
    get shown() {
      return !pane.hidden;
    },
    get focused() {
      return !pane.hidden && pane.contains(document.activeElement);
    },
    get content() {
      return content;
    },
    /** Whether the timeline shows beside the view (`app.css`). */
    wide: () => window.innerWidth > 900,
  };
}
