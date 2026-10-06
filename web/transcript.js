/**
 * The transcript (spike/pwa), as `chat/tui/transcript.ts` draws it: a
 * heading per speaker, each answer as markdown while it streams, a tool
 * call, a question and how it closed, and the notices.
 *
 * **Markdown is the one HTML the page sets.** `marked` escapes text and
 * code itself; raw HTML in an answer is escaped here, a link goes out only
 * for `http:` and `https:`, and an image is shown as its text. The CSP is
 * the second wall: no inline script runs even if one got through.
 *
 * An answer is parsed again whole on each chunk, at most once a frame.
 * ponytail: whole re-parse; cut the finished blocks off as the TUI does
 * (`settled` in `chat/tui/transcript.ts`) if a long answer lags.
 */

import { nameOf, thread } from "./client/room.ts";
import { h } from "./dom.js";
import { Marked } from "./vendor/marked.js";

const esc = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const md = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => esc(text),
    image: ({ text }) => esc(`[image: ${text}]`),
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!/^https?:\/\//i.test(href)) return label;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

/** Markdown as HTML, or the text itself if `marked` throws. */
export const markdown = (text) => {
  try {
    return md.parse(text);
  } catch {
    return `<pre>${esc(text)}</pre>`;
  }
};

/** The line for a room whose stream ended (`chat/common.ts`). */
export function endedLine(e, id) {
  switch (e.kind) {
    case "dismissed":
      return "the room was dismissed";
    case "alive":
      return `! lost the room stream; the room is still ${e.status} — reload to rejoin`;
    case "unknown":
      return `! the daemon no longer knows room ${id}; it may have restarted`;
    case "refused":
      return `! lost the room stream (HTTP ${e.status}); the room may still be alive`;
    case "gone":
      return `! lost the daemon: ${e.message}`;
  }
}

export function transcriptParts({ rooms, view, setStatus }) {
  const root = document.getElementById("transcript");
  /** The element drawn for each entry that changes in place or can be
   *  jumped to. */
  let drawn = new WeakMap();
  /** The participant whose name heads the lines drawn last. */
  let speaker;
  /** Answers to parse on the next frame. */
  const dirty = new Set();
  let frame = 0;

  const atEnd = () =>
    root.scrollHeight - root.scrollTop - root.clientHeight < 40;
  /** Adds `el`, and keeps the end in view if it was. */
  const add = (el) => {
    const follow = atEnd();
    root.append(el);
    if (follow) root.scrollTop = root.scrollHeight;
    return el;
  };
  const note = (s) => add(h("p", { class: "entry note" }, s));
  const warn = (s) => add(h("p", { class: "entry warn" }, s));
  const heading = (id, name) => {
    if (speaker === id) return;
    speaker = id;
    add(h("p", { class: "entry speaker" }, name));
  };

  const paint = () => {
    frame = 0;
    const follow = atEnd();
    for (const e of dirty) {
      const el = drawn.get(e);
      if (el) el.innerHTML = markdown(e.text);
    }
    dirty.clear();
    if (follow) root.scrollTop = root.scrollHeight;
  };

  const draw = (state, e) => {
    const name = nameOf(state, e.participantId);
    switch (e.type) {
      case "user": {
        speaker = undefined;
        const el = h(
          "div",
          { class: "entry user" },
          h("div", { class: "who" }, `you → ${name}`),
          h("div", { class: "text" }, e.text),
        );
        drawn.set(e, el);
        add(el);
        return;
      }
      case "queued":
        note(`queued for ${name}: ${e.text}`);
        return;
      case "queue_cleared":
        warn(`! ${e.count} queued message(s) for ${name} dropped, unsent`);
        return;
      case "answer": {
        if (!drawn.has(e)) {
          heading(e.participantId, name);
          drawn.set(e, add(h("div", { class: "entry answer" })));
        }
        dirty.add(e);
        if (!frame) frame = requestAnimationFrame(paint);
        return;
      }
      case "tool":
        heading(e.participantId, name);
        note(`· ${e.title}`).classList.replace("note", "tool");
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
        let el = drawn.get(e);
        if (!el) {
          el = add(h("p", { class: "entry ask" }));
          drawn.set(e, el);
        }
        const answer =
          e.allow === undefined
            ? ""
            : ` — ${e.allow ? "allowed" : "denied"} (${e.reason})`;
        el.textContent = `? ${name} asks: ${e.title}${answer}`;
        return;
      }
    }
  };

  /** Draws the current view from its reducer, from the start. */
  const redraw = () => {
    root.replaceChildren();
    drawn = new WeakMap();
    dirty.clear();
    speaker = undefined;
    const r = rooms.get(view().roomId);
    if (r) {
      const id = view().participantId;
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
      paint();
    } else {
      note("no rooms. ctrl+k → new room, or type /new <harness>.");
    }
    root.scrollTop = root.scrollHeight;
    setStatus();
  };

  /** Scrolls to the person's message `e`, and marks it for a moment. */
  const jump = (e) => {
    const el = drawn.get(e);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  };

  return { warn, draw, redraw, jump };
}
