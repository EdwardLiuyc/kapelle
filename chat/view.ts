/**
 * `chat/view.ts` — what the full-screen chat shows, and what its composer
 * pre-fills (M4-10).
 *
 * - The rows: each room, then its roster, in the sidebar's order. The row
 *   keys step one row down or up.
 * - The pre-fill: in a thread, the composer holds `@name ` until the person
 *   types (R43, decided 2026-09-30). A pre-fill the person did not touch
 *   follows the view and a rename. Typed text stays.
 * - A thread whose participant left goes back to its room's timeline. A
 *   view in a dismissed room goes to the first row.
 * - What is on screen is seen: the timeline marks its whole room, and a
 *   thread marks its participant.
 * - Who waits on the person (M4-4): the banner shows the waits off screen,
 *   and the bell rings once when a participant starts to wait.
 *
 * **In `chat/`, not `client/`** (decided 2026-10-02): rows, the `@name`
 * pre-fill and seen marks are this screen's own rules.
 *
 * **Pure.** It reads the reducers and returns the next view, the pre-fill
 * and the ids seen. The screen sets the editor's text, calls `seen` and
 * draws. Set the pre-fill before the text: pi-tui's `setText` calls
 * `onChange` at once.
 */

import { nameOf, type RoomState, roster } from "../client/room.ts";

/** What the transcript shows: a room's timeline, or one participant's
 *  thread when `participantId` is set. It is also a sidebar row. */
export interface View {
  roomId: string;
  participantId?: string;
}

/** The rooms by id, in sidebar order. */
type Rooms = ReadonlyMap<string, { state: RoomState }>;

/** The composer after a change: the pre-fill, and the text to set, if the
 *  text changes. */
export interface Composer {
  prefill: string;
  text?: string;
}

export const same = (a: View, b: View) =>
  a.roomId === b.roomId && a.participantId === b.participantId;

/** Every row, in sidebar order: a room, then its roster. */
export const rows = (rooms: Rooms): View[] =>
  [...rooms].flatMap(([roomId, { state }]) => [
    { roomId },
    ...roster(state).map((p) => ({ roomId, participantId: p.id })),
  ]);

/** The row below `view`, or above it; `undefined` past the end. A view
 *  that is not a row, as `{ roomId: "" }` after the last room went, steps
 *  down to the first row and up to nothing. */
export function step(rooms: Rooms, view: View, down: boolean) {
  const all = rows(rooms);
  return all[all.findIndex((row) => same(row, view)) + (down ? 1 : -1)];
}

/** Whether the person typed in the composer: text that is not the
 *  pre-fill. */
export const touched = (text: string, prefill: string) =>
  text !== "" && text !== prefill;

/** The `@name ` a thread's composer holds, or "" in a timeline. */
const mention = (state: RoomState, view: View) =>
  view.participantId ? `@${nameOf(state, view.participantId)} ` : "";

/** The participants the person sees in `view`. The timeline marks every
 *  one, those off the roster too. */
export const seenIn = (state: RoomState, view: View) =>
  view.participantId ? [view.participantId] : [...state.participants.keys()];

/** The composer when `next` opens in a room with this state: an untouched
 *  pre-fill follows the view, and typed text stays. */
// With no room (`state` unset) an old `@name ` stays. Found at M4-10's
// pickup (#210); a move does not fix it.
export function opened(
  state: RoomState | undefined,
  next: View,
  text: string,
  prefill: string,
): Composer {
  if (!state || touched(text, prefill)) return { prefill };
  const p = mention(state, next);
  return { prefill: p, text: p };
}

/** The composer after the person edits it. Typed text drops the
 *  pre-fill. In a thread, an empty composer always holds `@name `: when
 *  the thread opens, after a send, and after a delete by hand. */
export function edited(
  state: RoomState | undefined,
  view: View,
  text: string,
  prefill: string,
): Composer {
  if (text === "" && view.participantId && state) {
    const p = mention(state, view);
    return { prefill: p, text: p };
  }
  return { prefill: text === prefill ? prefill : "" };
}

/** A line came in room `roomId`: an untouched thread pre-fill moves to the
 *  participant's new name. `undefined` when nothing changes. */
export function renamed(
  state: RoomState,
  roomId: string,
  view: View,
  text: string,
  prefill: string,
): Composer | undefined {
  if (roomId !== view.roomId || !view.participantId || !prefill) return;
  const next = mention(state, view);
  if (next !== prefill && text === prefill)
    return { prefill: next, text: next };
}

/** Whether a line from this participant in this room is on screen. */
export const shows = (view: View, roomId: string, participantId: string) =>
  roomId === view.roomId &&
  (!view.participantId || view.participantId === participantId);

/** A participant left the roster. When the open thread was theirs, the view
 *  to go back to: the room's timeline. Its `@name` can no longer resolve,
 *  and it has no row. */
export const participantLeft = (
  view: View,
  roomId: string,
  participantId: string,
) =>
  roomId === view.roomId && view.participantId === participantId
    ? { roomId }
    : undefined;

/** A room was dismissed. When the view was in it, the view to go to: the
 *  first row, or `{ roomId: "" }` when no room is left. `rooms` no longer
 *  holds it. */
export const dismissed = (rooms: Rooms, view: View, roomId: string) =>
  view.roomId === roomId ? (rows(rooms)[0] ?? { roomId: "" }) : undefined;

/** A thing a participant waits on the person for (M4-4): its oldest open
 *  question, or a stall warning in its live turn. A participant can have
 *  both. */
export interface Wait {
  roomId: string;
  participantId: string;
  why: "question" | "stall";
  /** The question's title, or the stall warning's text. */
  text: string;
  /** The question's id. */
  question?: string;
}

/** Every wait, seen or not, in sidebar order: a participant's question
 *  before its stall. */
export function waiting(rooms: Rooms): Wait[] {
  const out: Wait[] = [];
  for (const [roomId, { state }] of rooms) {
    for (const p of roster(state)) {
      const at = { roomId, participantId: p.id };
      const q = [...state.questions.values()].find(
        (x) => x.participantId === p.id,
      );
      const turn = p.turns.at(-1);
      if (q) {
        out.push({ ...at, why: "question", text: q.title, question: q.id });
      }
      if (turn?.state === "open" && turn.stall) {
        out.push({ ...at, why: "stall", text: turn.stall });
      }
    }
  }
  return out;
}

/** The banner's rows (M4-4): one per participant that waits off screen,
 *  its question first. A stall the person saw is gone; a question stays
 *  until it closes. */
export function banner(rooms: Rooms, view: View) {
  const rows = new Map<string, Wait>();
  for (const w of waiting(rooms)) {
    const key = `${w.roomId} ${w.participantId}`;
    if (rows.has(key) || shows(view, w.roomId, w.participantId)) continue;
    const p = rooms.get(w.roomId)?.state.participants.get(w.participantId);
    if (w.why === "question" || p?.stalled) rows.set(key, w);
  }
  return [...rows.values()];
}

/** The waits now, and whether one of them is new: the bell rings once for
 *  a question and once for a stall, on screen or not. A question after a
 *  stall the person saw rings; the stall left when the question closes
 *  does not. */
export function bell(before: ReadonlySet<string>, now: readonly Wait[]) {
  const keys = new Set(
    now.map((w) => `${w.roomId} ${w.participantId} ${w.why}`),
  );
  return { keys, ring: [...keys].some((k) => !before.has(k)) };
}
