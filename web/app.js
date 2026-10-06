/**
 * The chat page (spike/pwa): `chat/tui.ts`, in a browser.
 *
 * **The same client code as the TUI.** The streams, the reducers, the
 * question queue, the commands and the view rules are `client/` and
 * `chat/view.ts`, served as JavaScript by the daemon (`daemon/web.ts`).
 * This page only draws and handles keys and clicks.
 *
 * **Login.** `kapelle web` prints a link with a one-time code after `#`.
 * The page trades it for the token (`POST /session`), keeps the token in
 * `localStorage`, and sends it on every call. A daemon that restarts has a
 * new token: the page then asks for a new link.
 *
 * **Keys.** A browser keeps ctrl+t, ctrl+n, ctrl+w and others for itself,
 * so the TUI's keys move: ctrl+k is the menu (ctrl+o in the TUI), ctrl+b
 * the rooms (ctrl+t), alt+x the side view (ctrl+x), alt+h the history
 * (ctrl+r), alt+↑↓ the rows. Every one is a button or a click too.
 */

import { boxParts } from "./box.js";
import {
  banner,
  bell,
  dismissed,
  edited,
  opened,
  participantLeft,
  renamed,
  rows,
  same,
  seenIn,
  shows,
  step,
  waiting,
} from "./chat/view.ts";
import { runCommand } from "./client/command.ts";
import { call, checkVersion } from "./client/daemon.ts";
import { agentDiff } from "./client/diff.ts";
import { mentionsFor, targetOf } from "./client/mention.ts";
import { questionQueue } from "./client/questions.ts";
import {
  cleanDiff,
  nameOf,
  needsAttention,
  printable,
  roster,
  seen,
  thread,
} from "./client/room.ts";
import { roomSet } from "./client/roomset.ts";
import { parseLine } from "./client/submit.ts";
import { h } from "./dom.js";
import { paneParts } from "./pane.js";
import { endedLine, transcriptParts } from "./transcript.js";

const TOKEN_KEY = "kapelle-token";
const NO_AGENTS = "no agents: ctrl+k → add agent";
const NEW_LINK = "Run kapelle web in a terminal, and open the link it prints.";

const store = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      // A private window: the token lives as long as the page.
    }
  },
};

/** A whole-page message in place of the chat: a login hint or the end. */
function message(...lines) {
  document.getElementById("app").hidden = true;
  const el = document.getElementById("message");
  el.replaceChildren(
    ...lines.map((l) => h("p", {}, l)),
    h(
      "p",
      {},
      h(
        "button",
        { type: "button", onclick: () => location.reload() },
        "reload",
      ),
    ),
  );
  el.hidden = false;
}

/** The token: from a one-time code in the link, or the one kept. */
async function login() {
  const m = /^#code=([0-9a-f]+)$/.exec(location.hash);
  if (m) {
    // Off the address bar and out of the history at once.
    history.replaceState(null, "", location.pathname);
    const res = await fetch("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: m[1] }),
    });
    if (!res.ok) {
      message(
        "That link is spent or too old: a link works once, for 60 s.",
        NEW_LINK,
      );
      return undefined;
    }
    const { token } = await res.json();
    store.set(token);
    return token;
  }
  return store.get() ?? undefined;
}

async function main() {
  // `client/daemon.ts` calls 127.0.0.1: any other name is another origin.
  if (location.hostname !== "127.0.0.1") {
    const u = new URL(location.href);
    u.hostname = "127.0.0.1";
    return location.replace(u);
  }
  const token = await login();
  if (!token) {
    if (document.getElementById("message").hidden) message(NEW_LINK);
    return;
  }
  const d = { port: Number(location.port) || 80, token };
  const list = await call(d, "/rooms");
  if (!list.ok) {
    if (list.status === 401) {
      store.set(null);
      return message(
        "The daemon restarted, so this page's login is gone.",
        NEW_LINK,
      );
    }
    return message(`! ${list.error.message}`);
  }
  let warning;
  try {
    warning = await checkVersion(d);
  } catch (err) {
    return message(`! ${err.message}`);
  }
  // `client/folder.ts` reads `~` and a relative `/new --cwd` from home.
  const home = await call(d, "/folders?path=");
  globalThis.kapelleHome = home.ok ? home.body.home : "/";
  globalThis.process ??= { cwd: () => globalThis.kapelleHome };
  chat(
    d,
    list.body.filter((x) => x.status !== "dismissed"),
    warning,
  );
}

function chat(d, list, warning) {
  const $ = (id) => document.getElementById(id);
  const composer = $("composer");
  const address = async () => d;
  const set = roomSet(d, address, {
    line: (roomId, line, e) => onLine(roomId, line, e),
    loaded: (roomId) => {
      if (view.roomId === roomId) redraw();
    },
    polled: () => setStatus(),
    closed: (id, ended, r) => onClosed(id, ended, r),
    end: (why) => quit(why),
  });
  const { rooms } = set;
  let view = { roomId: list[0]?.id ?? "" };
  // Under 700 px the sidebar lies over the page (`app.css`), so it hides
  // when the window gets narrow and after a row is picked.
  const narrow = matchMedia("(max-width: 700px)");
  let shown = !narrow.matches;
  narrow.addEventListener("change", () => {
    shown = !narrow.matches;
    setStatus();
  });
  let flash = warning ? `! ${warning}` : "";
  let prefill = "";
  let done = false;
  const queue = questionQueue((roomId, id) => {
    const r = rooms.get(roomId);
    const q = r?.state.questions.get(id);
    return r && q ? { r, q } : undefined;
  });
  const say = (text) => {
    flash = text;
  };
  const left = () => "left the chat; reload to rejoin. The rooms stay alive.";
  const end = (...lines) => {
    if (done) return;
    done = true;
    set.stop();
    message(...lines);
  };
  const gone = (err) => end(`! ${err.message}`);
  const quit = (why) => {
    if (why.kind === "gone") {
      store.set(null);
      return end(
        "! the daemon stopped: start it with kapelle daemon start.",
        NEW_LINK,
      );
    }
    const msg = why.err ? [`! ${why.err.message}`] : [];
    end(...msg, endedLine(why.ended, why.roomId));
  };

  /** The participants that waited at the bell's last look. */
  let waited = new Set();
  let ringing = false;
  /** A notification once a participant starts to wait, while the page is
   *  not in view; the tab's title counts the waits. */
  const ring = () => {
    if (ringing) return;
    ringing = true;
    setTimeout(() => {
      ringing = false;
      const now = waiting(rooms);
      const b = bell(waited, now);
      waited = b.keys;
      document.title = now.length ? `(${now.length}) kapelle` : "kapelle";
      if (
        b.ring &&
        !done &&
        document.hidden &&
        globalThis.Notification?.permission === "granted"
      ) {
        const w = now.at(-1);
        const r = rooms.get(w.roomId);
        new Notification("kapelle", {
          body: `${r ? nameOf(r.state, w.participantId) : "an agent"} ${w.why === "question" ? `asks: ${w.text}` : w.text}`,
          tag: "kapelle",
        });
      }
    });
  };

  const rosterOf = (state, fallback) =>
    state.participants.size > 0 ? roster(state) : fallback;

  // The parts. Each calls back through an arrow, set further down.
  const { warn, draw, redraw, jump } = transcriptParts({
    rooms,
    view: () => view,
    setStatus: () => setStatus(),
  });
  const side = paneParts({ composer, setStatus: () => setStatus() });
  const box = boxParts({
    d: () => d,
    queue,
    rooms,
    view: () => view,
    composer,
    side,
    say,
    setStatus: () => setStatus(),
    run: (c) => run(c),
    changes: (who) => void changes(who, "head").catch(gone),
    end: (...lines) => end(...lines),
    left,
    prefill: () => prefill,
    done: () => done,
  });

  // The sidebar's marks: ● when something waits, magenta for a question,
  // yellow for a stall.
  const asks = (state, id) =>
    [...state.questions.values()].some((q) => q.participantId === id);
  const mark = (state, id) => {
    const p = state.participants.get(id);
    const waits = Boolean(p?.unread) || needsAttention(state, id);
    const paint = asks(state, id) ? "ask" : p?.stalled ? "stall" : "";
    return { circle: waits ? "●" : "○", paint };
  };
  const roomMark = (state) => {
    const ps = roster(state);
    const waits = ps.some((p) => mark(state, p.id).circle === "●");
    const paint = ps.some((p) => asks(state, p.id))
      ? "ask"
      : ps.some((p) => p.stalled)
        ? "stall"
        : "";
    return { circle: waits ? "●" : "○", paint };
  };

  const drawSidebar = () => {
    $("sidebar").hidden = !shown;
    $("strip").hidden = shown;
    $("rows").replaceChildren(
      ...rows(rooms).map((row) => {
        const r = rooms.get(row.roomId);
        const on = same(row, view) ? "on" : "";
        if (!row.participantId) {
          const { circle, paint } = roomMark(r.state);
          return h(
            "li",
            { class: on, onclick: () => open(row), title: r.entry.cwd },
            h("span", { class: paint }, circle),
            h("span", { class: "label" }, r.entry.title ?? r.entry.id),
            r.lost ? h("span", { class: "warn" }, "!") : undefined,
          );
        }
        const p = r.state.participants.get(row.participantId);
        const { circle, paint } = mark(r.state, p.id);
        return h(
          "li",
          { class: `agent ${on}`, onclick: () => open(row) },
          h("span", { class: paint }, circle),
          h("span", { class: "label" }, p.name),
          h(
            "span",
            { class: "dim" },
            [p.role, p.status !== "idle" ? p.status : ""]
              .filter(Boolean)
              .join(" · "),
          ),
        );
      }),
    );
  };

  const drawBanner = () => {
    const all = banner(rooms, view);
    const shownRows = all.length <= 3 ? all : all.slice(0, 2);
    $("banner").replaceChildren(
      ...shownRows.map((w) => {
        const r = rooms.get(w.roomId);
        const name = r ? nameOf(r.state, w.participantId) : w.participantId;
        const room = r?.entry.title ?? w.roomId;
        const why = w.why === "question" ? `asks: ${w.text}` : w.text;
        return h(
          "div",
          {
            class: w.why === "question" ? "ask" : "stall",
            onclick: () => {
              open({ roomId: w.roomId, participantId: w.participantId });
              if (w.question) box.question(w.question);
            },
          },
          `● ${name} (${room}) ${why}`,
        );
      }),
      ...(all.length > 3
        ? [h("div", { class: "dim" }, `+${all.length - 2} more`)]
        : []),
    );
  };

  const drawStatus = () => {
    const parts = [];
    const r = rooms.get(view.roomId);
    if (r) {
      const ros = rosterOf(r.state, r.entry.participants);
      const t =
        ros.length > 0 ? targetOf(composer.value, ros) : { error: NO_AGENTS };
      parts.push(
        "id" in t
          ? h("span", { class: "target" }, `→ ${nameOf(r.state, t.id)}`)
          : h("span", { class: "warn" }, `! ${t.error}`),
      );
    }
    const asked = queue.open().length;
    if (asked && !queue.asking && !(side.focused && side.content?.question)) {
      parts.push(
        h(
          "span",
          { class: "ask" },
          `? ${asked} question${asked > 1 ? "s" : ""} · ctrl+k`,
        ),
      );
    }
    if (flash)
      parts.push(
        h("span", { class: flash.startsWith("!") ? "warn" : "" }, flash),
      );
    if (!shown) {
      const marked = [...rooms.values()].filter(
        ({ state }) => roomMark(state).circle === "●",
      ).length;
      if (marked) parts.push(`● ${marked} room${marked > 1 ? "s" : ""}`);
    }
    parts.push(
      h(
        "span",
        { class: "dim" },
        box.panel
          ? "esc back"
          : side.focused
            ? "esc back to typing · alt+x hide"
            : "enter send · shift+enter new line · ctrl+k menu · alt+↑↓ rows · ctrl+b rooms · alt+x view · alt+h history",
      ),
    );
    $("status").replaceChildren(
      ...parts.flatMap((p, i) =>
        i ? [h("span", { class: "dim" }, " · "), p] : [p],
      ),
    );
  };

  /** The sidebar, the banner and the status line, once a frame. */
  let frame = 0;
  const setStatus = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawSidebar();
      drawBanner();
      drawStatus();
    });
  };
  const toggle = () => {
    shown = !shown;
    setStatus();
  };

  /** The person's messages in the view, oldest first. */
  const sent = () => {
    const r = rooms.get(view.roomId);
    if (!r) return [];
    const id = view.participantId;
    const all = id ? thread(r.state, id) : r.state.timeline;
    return all.flatMap((e) => (e.type === "user" ? [{ r, e }] : []));
  };
  /** The history list, in the side view: a pick scrolls to the message. */
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

  /** Sets what `chat/view.ts` decided the composer holds. */
  const compose = (c) => {
    prefill = c.prefill;
    if (c.text !== undefined) composer.value = c.text;
  };

  const open = (next) => {
    if (box.panel) box.hidePanel();
    if (narrow.matches) shown = false;
    view = next;
    flash = "";
    const r = rooms.get(next.roomId);
    compose(opened(r?.state, next, composer.value, prefill));
    if (r) for (const id of seenIn(r.state, next)) seen(r.state, id);
    redraw();
    side.refresh();
  };

  const onLine = (roomId, line, e) => {
    const r = rooms.get(roomId);
    if (!r) return;
    ring();
    const u = line.update;
    const kind = u.sessionUpdate;
    if (kind === "_client_permission_queued") {
      queue.add(u.id, roomId);
      setTimeout(box.offer);
    }
    if (
      kind === "_client_permission_answered" &&
      queue.asking === u.id &&
      e?.type === "permission"
    ) {
      box.hidePanel();
      flash = `${nameOf(r.state, e.participantId)}'s question closed: ${e.allow ? "allowed" : "denied"} (${e.reason})`;
      box.offer();
    }
    if (kind === "_client_permission_answered" && e?.type === "permission") {
      side.closed(u.id, `${e.allow ? "allowed" : "denied"} (${e.reason})`);
    }
    box.syncBox();
    const back =
      kind === "_client_participant_removed"
        ? participantLeft(view, roomId, line.participantId)
        : undefined;
    if (back) {
      const keep = flash;
      open(back);
      flash = keep;
      setStatus();
      return;
    }
    if (shows(view, roomId, line.participantId)) {
      seen(r.state, line.participantId);
      if (e) draw(r.state, e);
      if (e?.type === "user") side.refresh();
    }
    const c = renamed(r.state, roomId, view, composer.value, prefill);
    if (c) compose(c);
    setStatus();
  };

  const onClosed = (id, ended, r) => {
    const isGone = ended.kind === "dismissed";
    if (isGone) box.syncBox();
    const label = r?.entry.title ?? id;
    const next = isGone ? dismissed(rooms, view, id) : undefined;
    if (next) open(next);
    flash = isGone ? `${label} was dismissed` : endedLine(ended, id);
    setStatus();
  };

  // The composer: `@name` completion, the history of sent lines, Enter.

  const mentions = $("mentions");
  let picks = [];
  let pickAt = 0;
  const before = () => {
    const at = composer.selectionStart;
    const text = composer.value.slice(0, at);
    return text.includes("\n") ? "" : text;
  };
  const suggest = () => {
    const r = rooms.get(view.roomId);
    const ros = r ? rosterOf(r.state, r.entry.participants) : [];
    picks = mentionsFor(before(), ros) ?? [];
    pickAt = Math.min(pickAt, Math.max(0, picks.length - 1));
    mentions.hidden = picks.length === 0;
    mentions.replaceChildren(
      ...picks.map((p, i) =>
        h(
          "li",
          {
            class: i === pickAt ? "on" : "",
            onmousedown: (ev) => {
              ev.preventDefault();
              complete(i);
            },
          },
          `@${p.name}`,
          p.role ? h("span", { class: "dim" }, ` ${p.role}`) : undefined,
        ),
      ),
    );
  };
  const complete = (i) => {
    const p = picks[i];
    if (!p) return;
    const col = composer.selectionStart;
    const first = composer.value.split("\n")[0];
    const prefix = before().trimStart();
    const head = `${first.slice(0, col - prefix.length)}@${p.name} `;
    const rest = composer.value.slice(first.length);
    composer.value = head + first.slice(col).trimStart() + rest;
    composer.setSelectionRange(head.length, head.length);
    mentions.hidden = true;
    picks = [];
    changed();
  };

  /** Lines sent, for ↑ and ↓ in an empty composer. */
  const sentLines = [];
  let back = -1;
  const remember = (text) => {
    if (sentLines.at(-1) !== text) sentLines.push(text);
    back = -1;
  };

  const changed = () => {
    const c = edited(
      rooms.get(view.roomId)?.state,
      view,
      composer.value,
      prefill,
    );
    compose(c);
    setStatus();
    box.offer();
  };
  composer.addEventListener("input", () => {
    back = -1;
    changed();
    suggest();
  });
  composer.addEventListener("click", suggest);
  composer.addEventListener("keydown", (e) => {
    if (!mentions.hidden && picks.length) {
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        return complete(pickAt);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        pickAt =
          (pickAt + (e.key === "ArrowDown" ? 1 : picks.length - 1)) %
          picks.length;
        return suggest();
      }
      if (e.key === "Escape") {
        mentions.hidden = true;
        return;
      }
    }
    if (e.key === "Tab" && /^\s*@[^\s]*$/.test(before())) {
      e.preventDefault();
      return suggest();
    }
    const untouched =
      composer.value === "" || composer.value === prefill || back >= 0;
    if (
      e.key === "ArrowUp" &&
      untouched &&
      composer.selectionStart === 0 &&
      sentLines.length
    ) {
      e.preventDefault();
      back = back < 0 ? sentLines.length - 1 : Math.max(0, back - 1);
      composer.value = sentLines[back];
      return changed();
    }
    if (
      e.key === "ArrowDown" &&
      back >= 0 &&
      composer.selectionEnd === composer.value.length
    ) {
      e.preventDefault();
      back += 1;
      composer.value = back < sentLines.length ? sentLines[back] : "";
      if (back >= sentLines.length) back = -1;
      return changed();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = composer.value;
      composer.value = "";
      changed();
      submit(text.trim()).catch(gone);
    }
  });

  const submit = async (text) => {
    if (!text) return;
    flash = "";
    const r = rooms.get(view.roomId);
    const ros = r ? rosterOf(r.state, r.entry.participants) : [];
    /** Refused before any request: the text goes back to fix. */
    const giveBack = () => {
      const bare = "id" in targetOf(text, ros);
      composer.value = bare ? `${text} ` : text;
      changed();
    };
    const c = parseLine(text, ros);
    if ("error" in c) {
      flash = `! ${c.error}`;
      setStatus();
      return giveBack();
    }
    if (c.verb === "leave") return end(left());
    if (c.verb === "help") return box.showHelp();
    if (c.verb === "form")
      return c.form === "new" ? box.newForm() : box.addForm();
    if (c.verb === "diff") {
      remember(text);
      if (!(await changes(c, c.against))) giveBack();
      return;
    }
    if (c.verb !== "message") {
      remember(text);
      if (!(await run(c))) giveBack();
      return;
    }
    if (!r) {
      flash = "! no room: ctrl+k → new room";
      setStatus();
      return giveBack();
    }
    if (ros.length === 0) {
      warn(`! ${NO_AGENTS}`);
      return giveBack();
    }
    const t = c.target;
    if ("error" in t) {
      warn(`! ${t.error}`);
      return giveBack();
    }
    remember(text);
    const res = await call(d, `/rooms/${r.entry.id}/agents/${t.id}/messages`, {
      method: "POST",
      body: { text: t.text },
    });
    if (!res.ok) warn(`! ${res.error.message}`);
  };

  /** What an agent changed, in the side view: what is not committed, or
   *  the whole branch. Answers whether the view was filled. */
  const changes = async (who, against) => {
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
    return true;
  };

  /** Sends a command from the composer or the pop-up, one at a time. A
   *  refusal stays in the open pop-up or goes to the status line. */
  let busy = false;
  const run = async (c) => {
    if (busy) {
      const wait = "wait: the last command is still running";
      if (box.panel) box.setError(wait);
      else {
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
  const send = async (c) => {
    if (c.verb === "dismiss") {
      const r = rooms.get(view.roomId);
      flash = `dismissing ${r?.entry.title ?? view.roomId}: stopping its harnesses…`;
      setStatus();
    }
    let out;
    try {
      out = await runCommand(d, view.roomId || undefined, c);
    } catch (err) {
      gone(err);
      return false;
    }
    if (!out.ok) {
      if (out.code === "repo_not_added" && c.verb === "new") {
        box.askToAdd(c);
        return true;
      }
      if (box.panel) box.setError(out.message);
      else {
        flash = `! ${out.message}`;
        setStatus();
      }
      return false;
    }
    if (box.panel) box.hidePanel();
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
    if (c.verb !== "dismiss") flash = out.line;
    setStatus();
    return true;
  };

  // Buttons and keys.
  $("hide").onclick = toggle;
  $("strip").onclick = toggle;
  $("menu").onclick = () => box.menu();
  $("history").onclick = history;
  $("toggle-pane").onclick = () => side.toggle();
  const notify = $("notify");
  notify.hidden =
    !("Notification" in window) || Notification.permission !== "default";
  notify.onclick = () =>
    Notification.requestPermission().then(() => {
      notify.hidden = true;
    });

  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === "KeyK") {
      e.preventDefault();
      if (box.panel) box.hidePanel();
      else box.menu();
      return;
    }
    if (ctrl && e.code === "KeyB") {
      e.preventDefault();
      return toggle();
    }
    if (box.panel || !e.altKey) return;
    if (e.code === "KeyX") {
      e.preventDefault();
      return side.toggle();
    }
    if (e.code === "KeyH") {
      e.preventDefault();
      return history();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = step(rooms, view, e.key === "ArrowDown");
      if (next) open(next);
    }
  });

  document.getElementById("app").hidden = false;
  set.start(list);
  open(view);
  composer.focus();
}

main().catch((err) => message(`! ${err.message}`));
