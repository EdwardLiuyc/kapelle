/**
 * `chat/tui/question.ts` — the full-screen chat's question box (M4-3, M4-12).
 *
 * When an `ask` participant waits on a permission, the box shows who wants
 * to do what, the room, the turn and the tool's input, with `deny` first,
 * so a stray Enter says no, as the timeout would. Its rows have numbers
 * (M7-4): a key only moves the cursor, and Enter answers. It sends the
 * answer, and names who won a lost race. Which question opens, and when,
 * is `client/questions.ts`; this file opens the box in the pop-up of
 * `chat/tui/panel.ts`.
 */

import {
  SelectList,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
// Not in pi-tui's main exports. Its editor uses it, so a shifted key reads
// the same under Kitty and under modifyOtherKeys (xterm, tmux).
import { decodePrintableKey } from "@earendil-works/pi-tui/dist/keys.js";
import type {
  PermissionAnswered,
  PermissionDecision,
} from "../../client/contract.ts";
import { call, type DaemonAddress } from "../../client/daemon.ts";
import { diffLine } from "../../client/diff.ts";
import type { QuestionQueue } from "../../client/questions.ts";
import { type Entry, nameOf } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { dim, NO_DAEMON } from "../common.ts";
import { pickRow, touched } from "../view.ts";
import type { paneParts } from "./pane.ts";
import { EDITOR_THEME, type panelParts } from "./panel.ts";

/** An open question, as the reducer keeps it. */
type Question = Extract<Entry, { type: "permission" }>;
/** The open questions over every room, oldest first. */
type Queue = QuestionQueue<{ r: Followed; q: Question }>;

/** The question box, in the pop-up `box`, and its diff in the pane `side`
 *  (M4-6). `say` sets the status line's message; `done` and `prefill` are
 *  read when a question may open. */
function questionParts({
  d,
  fresh,
  queue,
  editor,
  box,
  side,
  setStatus,
  say,
  done,
  prefill,
}: {
  d: DaemonAddress;
  /** `daemon.json` read again, so an answer after a restart has the new
   *  token (M6-7d). */
  fresh: () => Promise<void>;
  queue: Queue;
  editor: { getText(): string };
  box: ReturnType<typeof panelParts>;
  side: ReturnType<typeof paneParts>;
  setStatus: () => void;
  say: (text: string) => void;
  done: () => boolean;
  prefill: () => string;
}) {
  const { showPanel, hidePanel } = box;
  /** Keeps an open question box true: its count follows the open
   *  questions, and the box goes when its question left without a close
   *  line, as when its room was dismissed elsewhere. */
  const syncBox = () => {
    if (!queue.asking || !box.panel) return;
    const at = queue.place();
    if (!at) hidePanel();
    else box.panel.right = `${at.at} of ${at.of}`;
  };
  /**
   * One question in the pop-up (M4-3): who wants to do what in the title,
   * the room, the turn, the action, and the tool's input. `deny` comes
   * first, so a stray Enter says no, as the timeout would. A key only moves
   * the cursor (`pickRow`, M7-4): a box that opens by itself must not take
   * an answer from a person who was typing. Esc puts it aside, open.
   */
  const question = (id: string) => {
    const found = queue.open().find(({ q }) => q.id === id);
    // Picked from a menu drawn before it closed elsewhere.
    if (!found) {
      say("! that question already closed");
      return hidePanel();
    }
    const { r, q } = found;
    // `view diff` last: deny stays first (M4-6).
    const rows = q.diff ? ["deny", "allow", "view diff"] : ["deny", "allow"];
    const items = rows.map((v, i) => ({ value: v, label: `${i + 1} ${v}` }));
    const list = new SelectList(items, 3, EDITOR_THEME.selectList);
    list.onSelect = ({ value }) => {
      if (value === "view diff") return showDiff(q);
      void answer(q.id, value === "allow");
    };
    list.onCancel = hidePanel;
    const turn = q.turn === undefined ? "" : ` · turn ${q.turn}`;
    const who = [`room   ${r.entry.title ?? r.entry.id}${turn}`];
    const name = nameOf(r.state, q.participantId);
    const { kind } = q;
    const title =
      kind === "other"
        ? `${name} asks`
        : `${name} wants to ${kind.replaceAll("_", " ")}`;
    showPanel(title, {
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
        // One line for the diff, never cut, and one more row to pick it;
        // the pane shows the rest (M4-6).
        const diff = q.diff ? [truncateToWidth(diffLine(q.diff), w, "…")] : [];
        const fits = room - action.length - 2 * diff.length;
        if (input.length > 0 && input.length > fits) {
          input.splice(Math.max(0, fits - 1), Infinity, dim("…"));
        }
        return [
          ...who,
          ...action,
          ...input,
          ...diff,
          "",
          ...list.render(w),
          dim(`1-${rows.length} ↑↓ pick · enter answer · esc later`),
        ];
      },
      handleInput: (key) => {
        const row = pickRow(decodePrintableKey(key) ?? key, rows.length);
        if (row === undefined) list.handleInput(key);
        else list.setSelectedIndex(row);
      },
      invalidate: () => list.invalidate(),
    });
    queue.show(q.id);
    syncBox();
    setStatus();
  };
  /**
   * The question's diff in the side view (M4-6). The box closes, and its
   * question is put aside, so none opens while the view has the keys; `y`
   * and `n` answer, and Esc brings the box back. The diff stays in the view
   * after the question closes.
   */
  const showDiff = (q: Question) => {
    const at = queue.place();
    hidePanel();
    if (!q.diff) return;
    // The keys go back to the composer, so the next question can open.
    const answerHere = (allow: boolean) => () => {
      side.focus(false);
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
  /** Sends the answer. A lost race names who won: the reply to a late
   *  answer is `409`, and `GET /permissions/:id` says why it closed. */
  const answer = async (id: string, allow: boolean) => {
    hidePanel();
    offer();
    const path = `/permissions/${encodeURIComponent(id)}`;
    await fresh();
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
      say(`! ${why}`);
      setStatus();
    } catch {
      // A restart: the screen waits for the daemon (M6-7d).
      say(`! ${NO_DAEMON}`);
      setStatus();
    }
  };
  // Decided 2026-10-01 (#49): a question opens by itself, but never over
  // another pop-up or over text the person typed.
  const offer = () => {
    const text = editor.getText();
    const next = queue.next(
      box.panel !== undefined ||
        side.focused ||
        done() ||
        touched(text, prefill()),
    );
    if (next) question(next.q.id);
  };

  return { question, offer, syncBox };
}

export type { Question, Queue };
export { questionParts };
