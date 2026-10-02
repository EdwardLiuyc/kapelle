/**
 * The queue of open questions (M4-9): the rules M4-3 decided for which
 * question a screen shows, and when.
 *
 * - One queue over every room, oldest first.
 * - A question put aside (closed by the person, or answered here before the
 *   close came back) never opens by itself again. `open()` still lists it.
 * - A question closed elsewhere leaves the queue.
 * - Nothing opens while something is in the way.
 * - The question shown has a place: `n of m`.
 *
 * **In `client/`, though only the TUI uses it** (decided 2026-10-02, #206
 * review): a bridge to another chat app needs the same rules.
 *
 * **No I/O, and it does not know the reducer.** The reducers hold each
 * question; this keeps only their ids and their order. `lookup` says
 * whether a question is still open, so a close or a dismissed room takes it
 * out on the next read. The screen keeps the box, the timer that opens the
 * next one, and the one boolean that says something is in the way.
 */

export interface QuestionQueue<T> {
  /** A question came in this room. */
  add(id: string, roomId: string): void;
  /** The open questions, oldest first, the ones put aside included. */
  open(): T[];
  /** The question to open next: the oldest not put aside, unless
   *  `blocked`. */
  next(blocked: boolean): T | undefined;
  /** The question the box shows, while it does. */
  readonly asking: string | undefined;
  /** The box shows this question, or no longer shows one, as when another
   *  pop-up takes its place. Neither puts a question aside. */
  show(id: string | undefined): void;
  /** The person closed the box: its question is put aside. Returns that
   *  question's id, or `undefined` if the box held none. */
  away(): string | undefined;
  /** The shown question's place among the open ones, from 1. `undefined`
   *  when it has closed; then it is no longer shown, and not put aside. */
  place(): { at: number; of: number } | undefined;
}

export function questionQueue<T>(
  lookup: (roomId: string, id: string) => T | undefined,
): QuestionQueue<T> {
  /** Each question's room, in the order they came. */
  const waiting = new Map<string, string>();
  const aside = new Set<string>();
  let asking: string | undefined;
  /** The open questions with their ids. A closed one leaves the order. */
  const live = () => {
    const out: [string, T][] = [];
    for (const [id, roomId] of waiting) {
      const t = lookup(roomId, id);
      if (t !== undefined) out.push([id, t]);
      else {
        waiting.delete(id);
        aside.delete(id);
      }
    }
    return out;
  };
  return {
    add: (id, roomId) => void waiting.set(id, roomId),
    open: () => live().map(([, t]) => t),
    next: (blocked) =>
      blocked ? undefined : live().find(([id]) => !aside.has(id))?.[1],
    get asking() {
      return asking;
    },
    show: (id) => {
      asking = id;
    },
    away: () => {
      const id = asking;
      if (id) aside.add(id);
      asking = undefined;
      return id;
    },
    place: () => {
      const all = live();
      const at = all.findIndex(([id]) => id === asking);
      if (at >= 0) return { at: at + 1, of: all.length };
      // Not put aside: its id has already left the order, and nothing
      // would ever take it out of `aside`.
      asking = undefined;
      return undefined;
    },
  };
}
