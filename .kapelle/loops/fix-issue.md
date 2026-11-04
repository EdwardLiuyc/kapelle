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
- `bot: copilot; effort: balanced` selects Copilot.
- Copilot effort defaults to `BALANCED`; lower-case `lite`, `balanced`, `max` and
  `auto` map to the GraphQL enum. An unknown bot or effort makes the orchestrator stop
  and ask the person.

The orchestrator states the selected bot and effort in the plan.

### Common loop

The aim is that every round counts. Each fix is checked before it is pushed. Each round
also reads the previous round's fixes.

- **The reviewed commit:** just before each trigger, `dev` records the PR's head:
  `gh pr view <pr> --json headRefOid --jq .headRefOid`. The bot reviews up to that
  commit. `dev` pushes nothing while it waits, and puts the commit in its report.
- **Waiting:** `dev` waits inside its own turn, in the foreground, checking once and then
  every 60 seconds for up to 20 minutes. A timeout must say "timed out"; the turn must
  not end before the wait ends.
- **Reading:** `dev` reads the new bot review and its link; reporting follows the
  orchestrator skill.
- **Sorting:** each finding is `real` (blocker), `nit` or `choice` as the orchestrator
  skill says. The bot's severity or approval label is a first guess; `dev` checks it
  against the code. "Approval recommended" does not mean there are no inline comments.
- **Answer:** `dev` runs the `address-comment` skill on the latest bot item named by the
  selected bot's section and proves each fix with a test that fails before and passes
  after, or a reason from the code. No fix is a guess. When the order says the next round
  is final, it first reads every round's findings together and looks for a shared cause.
- **No next round** when no point is a blocker, or when `AGENTS.md`, "Review triage",
  says the round's fixes need none. `dev` still fixes the nits and pushes them; the final
  check reads them.
- **Rounds:** at most 3.

### Claude

This is the default when the note names no bot.

- **Trigger:** `dev` comments `@claude review` on the PR. From the second round:
  `@claude review the update. Verify each earlier finding. Check only the new commits for regressions. Mark each point blocker or not blocker.`
- **Waiting:** before the trigger, count Claude's comments:
  `gh pr view <pr> --json comments --jq '[.comments[] | select((.author.login | ascii_downcase) == "claude")] | length'`.
  Call that N. After the trigger, poll until comment N + 1 exists and its body starts
  with `**Claude finished`.
- **Reading:** read the latest Claude comment:
  `gh pr view <pr> --json comments --jq '[.comments[] | select((.author.login | ascii_downcase) == "claude")] | last | .url, .body'`.
- **Answer target:** the latest Claude comment; answer it in the PR conversation.

### Copilot

Selected by `bot: copilot` in the note.

- **Trigger:** get the PR node id:
  `gh pr view <pr> --json id --jq .id`. Then call:

  ```bash
  gh api graphql -f query='mutation($id: ID!) { requestCopilotCodeReview(input: {pullRequestId: $id, reviewEffort: <EFFORT>}) { success failureReason } }' -f id="<PR_NODE_ID>"
  ```

  `<EFFORT>` is the selected effort, uppercased.
  `REQUEST_CONFLICT` means a request is already pending; keep waiting. Any other
  `failureReason` is a permissions or eligibility stop. Copilot accepts no custom
  prompt. On later rounds, `dev` independently verifies the previous round's findings;
  it cannot ask the bot to do that.
- **Waiting:** before the trigger, count completed Copilot reviews, matching the author
  case-insensitively as `copilot` or `copilot-pull-request-reviewer`, and call that N.
  After the trigger, poll for a completed review beyond the N already counted, with a
  submission time at or after the trigger and a reviewed commit equal to the recorded
  head. A commit mismatch means keep waiting. Do not use issue comments or an exact
  `Copilot` login.
- **Reading:** read the latest review body and its inline comments:
  `gh api repos/<owner>/<repo>/pulls/<pr>/reviews` and
  `gh api repos/<owner>/<repo>/pulls/<pr>/comments`. Keep only comments whose
  `pull_request_review_id` is that review's id, and use the review's `html_url`.
- **Answer target:** the latest Copilot review and its inline discussion threads; answer
  summary-only findings on the PR and reply on every inline thread.

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
