# fix-issue

This repository's loop for one GitHub issue: pick it up, build it, review it, open the
PR, answer the bot, hand over. The task is the issue number.

## The team

| Name | Harness | Role | Joins |
| --- | --- | --- | --- |
| `dev` | claude | `developer`, the main developer | at the start |
| `rev1` | pi | `reviewer`, the first reviewer | after `dev` commits, from `dev`'s branch |
| `rev2` | pi | `reviewer`, the second reviewer | after `rev1` is removed, from `dev`'s branch |
| `rev3` | pi | `reviewer`, the final check | after the outside review, from `dev`'s branch, only if the final check needs it |

A skill starts with `/<name>` in claude and with `/skill:<name>` in pi. For example:
`/pickup-issue 268` for `dev`, and `/skill:review-local 268` for `rev1`, `rev2` and
`rev3`.

## The steps

1. **Pick up.** `dev` runs the `pickup-issue` skill for the issue. Its open decisions
   are choices for the person.
2. **Build.** After "go": `dev` builds it, runs the full gate as `AGENTS.md` says, and
   commits on its branch when the gate passes. It does not push yet. Check the report
   for a commit and a passing gate.
3. **Review 1.** `rev1` runs the `review-local` skill for the issue, as developer and
   tester: "The change is in the commits on your branch that are not on
   `origin/master`." Its report names the commit it reviewed and the commits it covered.
   Check them: the list is not empty, and it ends at `dev`'s last commit. If not, the
   review did not happen: send `rev1` back once. When it found problems, it commits its
   fixes and reports them as a list of `comment -> fix`. Only if `rev1` found no
   problem, remove it and go to step 5 (skip step 4).
4. **Land review 1.** As the orchestrator skill says.
5. **Review 2.** Add `rev2` from `dev`'s branch. This is a second full, independent
   review of the whole change, not only `rev1`'s fixes or the delta. `rev2` runs the
   `review-local` skill for the issue, as developer and tester: "The change is in the
   commits on your branch that are not on `origin/master`." Its report names the commit
   it reviewed and the commits it covered. Check them: the list is not empty, and it
   ends at `dev`'s last commit. If not, the review did not happen: send `rev2` back
   once. When it found problems, it commits its fixes and reports them as a list of
   `comment -> fix`. Only if `rev2` found no problem, remove it and go to step 7.
6. **Land review 2.** As the orchestrator skill says.
7. **PR.** `dev` pushes its branch, opens the PR with `Closes #<issue>` in its body,
   then starts the outside review. It fills the body from
   `.github/pull_request_template.md`, with one box ticked under "Docs".
8. **Outside review.** Below.
9. **Final check.** Below.
10. **Hand over.** The person reads the PR and runs `merge-close` with `dev`. With more
    than one commit, recommend a squash merge. The report lists every nit marked
    "separate issue"; the person picks which ones become issues.

## The outside review

The task note selects the bot. The default is Claude.

- `bot: claude` selects Claude.
- `bot: copilot; effort: balanced` selects Copilot. The effort is `lite`, `balanced`,
  `max` or `auto`; with none, it is `balanced`.
- An unknown bot or effort makes the orchestrator stop and ask the person.

The orchestrator states the selected bot and effort in the plan.

Each bot's section names its facts, not its commands: `dev` writes the `gh` calls.

### Common loop

The aim is that every round counts. Each fix is checked before it is pushed. Each round
also reads the previous round's fixes.

- **The reviewed commit:** just before each trigger, `dev` records the PR's head commit.
  The bot reviews up to that commit. `dev` pushes nothing while it waits, and puts the
  commit in its report.
- **Waiting:** `dev` waits inside its own turn, in the foreground, checking once and then
  every 60 seconds for up to 20 minutes. A timeout must say "timed out"; the turn must
  not end before the wait ends.
- **Reading:** `dev` reads the review that the wait found, and its link; reporting
  follows the orchestrator skill.
- **Sorting:** each finding is `real` (blocker), `nit` or `choice` as the orchestrator
  skill says. The bot's severity or approval label is a first guess; `dev` checks it
  against the code. "Approval recommended" does not mean there are no inline comments.
- **Answer:** `dev` runs the `address-comment` skill on that same review, and answers
  where the bot's section says. It proves each fix with a test that fails before and
  passes after, or a reason from the code. No fix is a guess. When the order says the
  next round is final, it first reads every round's findings together and looks for a
  shared cause.
- **No next round** when no point is a blocker, or when `AGENTS.md`, "Review triage",
  says the round's fixes need none. `dev` still fixes the nits and pushes them; the final
  check reads them.
- **Rounds:** at most 3.

### Claude

- **Trigger:** `dev` comments `@claude review` on the PR. From the second round:
  `@claude review the update. Verify each earlier finding. Check only the new commits for regressions. Mark each point blocker or not blocker.`
- **The review:** one PR conversation comment by `claude`, matched case-insensitively.
  The bot edits it while it works. Before the trigger, `dev` counts these comments. The
  review is done when one more exists and its body starts with `**Claude finished`.
- **Answer:** in the PR conversation.

### Copilot

- **Trigger:** the GraphQL mutation `requestCopilotCodeReview`, with the PR's node id
  and `reviewEffort` set to the selected effort in upper case. Ask for `success` and
  `failureReason`. `REQUEST_CONFLICT` means a request is already pending: keep waiting.
  Any other reason is a permissions or eligibility stop. Copilot takes no custom prompt,
  so from the second round `dev` checks the earlier findings itself.
- **The review:** a PR review, never a conversation comment, by `copilot` or
  `copilot-pull-request-reviewer`, matched case-insensitively. It counts only when it
  was submitted at or after the trigger and its commit is the recorded head. Any other
  review means keep waiting. Its findings are its body and the inline comments that
  carry its review id.
- **Answer:** summary findings on the PR, and a reply on every inline thread of that
  review.

## The final check

No bot reads the commits `dev` pushes after the final trigger. Call the commit `dev`
recorded at that trigger `X`. The commits after `X` get a local check, not another
round:

- **No commit after `X`:** nothing to check.
- **Only docs or comments change:** the orchestrator reads `git diff X <dev's branch>`.
  `dev` runs the checks `AGENTS.md` names for that diff and reads CI green with
  `gh pr checks <pr> --watch`.
- **Any code that runs differently**, a nit included: add `rev3` from `dev`'s branch. It
  runs the `review-local` skill for the issue, as developer and tester, with `--base X`:
  "The change is only the commits after X." Its report's `commits:` line names the
  commits it covered. Check them: they run from just after `X` to `dev`'s newest commit.
  If not, send `rev3` back once. Land it as the orchestrator skill says. Then `dev`
  pushes and reads CI green with `gh pr checks <pr> --watch`. Nothing checks after
  `rev3`, except CI.

## Protected paths

None.

## Rules for every worker

- Git: you may commit on your own branch, push it, open the PR and comment on it. This
  overrides the `AGENTS.md` rule on commits and PRs, and a skill's own rule against
  committing, such as `review-local`'s, for this loop only. Never merge. Never push to
  `master`.
- Run the full test suite at most once for each code change.
- A skill's own "what to do now" lines are advice to a person. Here the orchestrator
  decides the next step.
