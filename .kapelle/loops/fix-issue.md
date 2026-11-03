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

The aim is that every round counts. Each fix is checked before it is pushed. Each round
also reads the previous round's fixes.

- **Trigger:** `dev` comments `@claude review` on the PR. From the second round on:
  `@claude review the update. Verify each earlier finding. Check only the new commits for regressions. Mark each point blocker or not blocker.`
- **The reviewed commit:** just before each trigger, `dev` records the PR's head:
  `gh pr view <pr> --json headRefOid --jq .headRefOid`. The bot reviews up to that
  commit. `dev` pushes nothing while it waits, and puts the commit in its report.
- **Waiting:** `dev` waits inside its own turn. Before it comments, it counts the bot's
  comments:
  `gh pr view <pr> --json comments --jq '[.comments[] | select(.author.login == "claude")] | length'`.
  Call that N. After it comments, it checks every 60 seconds until comment N + 1 exists
  and its body starts with `**Claude finished`. It gives up after 20 minutes and says
  so.
- **Reading it:** `dev` reads the bot's last comment and its link, for the report:
  `gh pr view <pr> --json comments --jq '[.comments[] | select(.author.login == "claude")] | last | .url, .body'`.
- **Sorting:** each finding is a blocker or not, as `AGENTS.md`, "Review triage", says.
  From round 2, the bot marks each point; `dev` takes the mark as a first guess and
  checks it against the code. A nit is "not a blocker". In the orchestrator skill's
  words, `real` is a blocker and `nit` is a nit; a `choice` stops the loop whatever its
  level.
- **Answer:** `dev` runs the `address-comment` skill for the PR, on the latest comment,
  with its self-checks before each push. When the order says the next round is the final
  one, `dev` first reads the findings of every round together and looks for a shared
  cause. It proves each fix: a test that fails before the fix and passes after it, or a
  reason from the code. No fix is a guess.
- **No next round** when no point is a blocker, or when `AGENTS.md`, "Review triage",
  says the round's fixes need none. `dev` still fixes the small points and pushes them;
  the final check reads them.
- **Rounds:** at most 3.

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
