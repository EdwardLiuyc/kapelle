/**
 * Permission answers and pure option selection.
 *
 * - **`pickOption` returns `null` rather than guess.** Never fall back to
 *   `options[0]` (#13): claude 0.49.0 listed `allow_always` first, so a
 *   denial could become a lasting grant.
 * - **Only a yes for the `session` may send `allow_always`** (M12-4). A
 *   plain `true` is a yes `once`, and `pickOption` then takes `allow_once`
 *   or nothing. `ask` and `safe` answer `once`; only `auto` answers
 *   `session`.
 */

import type { PermissionOption, PermissionOptionId } from "./types.ts";

/**
 * A policy's answer (M12-4). `true` is yes, `once`: `pickOption` takes only
 * `allow_once`. `{ allow: true, scope: "session" }` is yes, and the harness
 * may keep it: `pickOption` may take `allow_always` when no `allow_once` is
 * offered. Only `auto` answers `session`. Anything else is a denial; an
 * unknown answer never allows.
 */
export type PolicyAnswer = boolean | { allow: true; scope: "session" };

/**
 * What a policy answer means. Only an explicit yes allows, and only the
 * `session` answer may reach `allow_always`. Anything else — `false`, or a
 * value that fell through the type at runtime — is a denial, never a guess.
 */
type AnswerScope = "deny" | "once" | "session";

export function answerScope(answer: PolicyAnswer): AnswerScope {
  if (answer === true) return "once";
  // `answer &&` also stops a value that slipped past the type, such as
  // `undefined`, before it is read.
  return answer && answer.allow === true && answer.scope === "session"
    ? "session"
    : "deny";
}

/**
 * Choose an optionId matching our allow/reject decision, or `null`.
 *
 * `null` means the harness offered nothing that says what we decided. The
 * pre-M1a-5 tail returned `options[0]` there, which fails open: measured
 * 2026-09-02 (issue #13), claude orders its list `allow_always` first, so a
 * *denial* with no reject option would have selected "Always Allow all Write"
 * — a persisted grant. Every list the three harnesses actually send carries
 * `reject_once`, so the tail never fired; nothing in the protocol promises
 * that, and the failure would have been invisible because the denial is still
 * what `_client_permission` records.
 *
 * A yes `once` takes only `allow_once` (M12-4): the harness that hears
 * "always" may stop asking for that tool, and `ask` and `safe` never mean
 * that. Only a yes for the `session` may reach `allow_always`. An answer that
 * is neither an explicit yes nor an explicit no is a denial.
 */
export function pickOption(
  options: PermissionOption[] = [],
  scope: AnswerScope,
): PermissionOptionId | null {
  let want: PermissionOption["kind"][];
  if (scope === "deny") want = ["reject_once", "reject_always"];
  else if (scope === "once") want = ["allow_once"];
  else want = ["allow_once", "allow_always"];
  for (const kind of want) {
    const hit = options.find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  return null;
}
