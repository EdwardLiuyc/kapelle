/**
 * The composer's target (R43): a leading `@name` names the participant, and
 * no mention names the orchestrator. The rules are `docs/CLIENT-API.md`
 * § Addressing; this file is the one place a client applies them, so the
 * TUI and piped `chat.ts` cannot differ (S8).
 *
 * **Its own module**, never an export on `client/contract.ts`: `daemon.ts`
 * imports the contract's types, and the daemon parses no message text.
 */

/** A participant as the resolver needs it. The reducer's roster and a
 *  `RoomListEntry`'s participants both fit. */
export interface Named {
  id: string;
  name: string;
  role?: string;
}

/** The target and the text to send, with the mention removed. */
export type Target = { id: string; text: string } | { error: string };

/** A leading mention: `@`, the name, an optional end mark, and the
 *  whitespace after it, newlines included. */
const MENTION = /^@([^\s,:;.]*)[,:;.]?\s*/;

/** ASCII case folding only (R22): `@Alice` is `@alice`, and nothing else
 *  changes. */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The target while the person types. It never refuses empty text, so a
 * thread opened with `@name ` pre-filled shows its target, not an error.
 * `resolveTarget` adds that check at submit.
 */
export function targetOf(input: string, roster: readonly Named[]): Target {
  const text = input.trimStart();
  const m = MENTION.exec(text);
  if (!m) {
    const orchestrator = roster.find((p) => p.role === "orchestrator");
    if (!orchestrator) {
      return {
        error:
          "this room has no orchestrator: start with @name, " +
          "or give a participant the orchestrator role",
      };
    }
    return { id: orchestrator.id, text };
  }
  const rest = text.slice(m[0].length);
  if (rest.startsWith("@")) {
    return { error: "name one participant: a message has one target" };
  }
  const name = fold(m[1] ?? "");
  const p = roster.find((q) => fold(q.name) === name);
  if (!p) return { error: `no participant named @${m[1] ?? ""}` };
  return { id: p.id, text: rest };
}

/** The target at submit: `targetOf`, and nothing left to send is an error.
 *  The daemon would refuse empty text with `400`. */
export function resolveTarget(input: string, roster: readonly Named[]): Target {
  const t = targetOf(input, roster);
  if ("id" in t && !t.text.trim()) return { error: "nothing to send" };
  return t;
}
