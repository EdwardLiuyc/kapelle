# fix-issue

This repository's loop for one GitHub issue: pick it up, build it, review it, open the
PR, answer the bot, hand over. The task is the issue number.

## The team

| Name | Harness | Role | Joins |
| --- | --- | --- | --- |
| `dev` | claude | `developer`, the main developer | at the start |
| `rev1` | pi | `reviewer`, the first reviewer | after `dev` commits, from `dev`'s branch |
| `rev2` | pi | `reviewer`, the second reviewer | after `rev1` is removed and `dev` has checked it, from `dev`'s branch |

A skill starts with `/<name>` in claude and with `/skill:<name>` in pi. For example:
`/pickup-issue 268` for `dev`, and `/skill:review-local 268` for `rev1` and `rev2`.

## The steps

1. **Pick up.** `dev` runs the `pickup-issue` skill for the issue. Its open decisions
   are choices for the person.
2. **Build.** After "go": `dev` builds it, runs the full gate as `AGENTS.md` says, and
   commits on its branch when the gate passes. It does not push yet. Check the report for
   a commit and a passing gate.
3. **Review 1.** `rev1` runs the `review-local` skill for the issue, as developer and
   tester: "The change is in the commits on your branch that are not on
   `origin/master`." Its report names the commit it reviewed and the commits it covered.
   Check them: the list is not empty, and it ends at `dev`'s last commit. If not, the
   review did not happen: send `rev1` back once. When it found problems, it commits its
   fixes and reports them as a list of `comment -> fix`.
4. **Land review 1.** As the orchestrator skill says. Do this before `rev2` joins.
5. **Review 2.** Add `rev2` from `dev`'s branch after step 4. `rev2` runs the
   `review-local` skill for the issue, as developer
   and tester: "The change is in the commits on your branch that are not on
   `origin/master`." Its report names the commit it reviewed and the commits it covered.
   Check them: the list is not empty, and the commit it reviewed is the tip of `dev`'s
   branch when `rev2` was added. If not, the review did not happen: send `rev2` back
   once. When it found problems, it commits its fixes and reports them as a list of
   `comment -> fix`.
6. **Land review 2.** As the orchestrator skill says.
7. **PR.** `dev` pushes its branch, opens the PR with `Closes #<issue>` in its body,
   then starts the outside review.
8. **Outside review.** Below.
9. **Hand over.** The person reads the PR and runs `merge-close` with `dev`. With more
   than one commit, recommend a squash merge.

## The outside review

- **Trigger:** `dev` comments `@claude review` on the PR. From the second round on:
  `@claude review the update`.
- **Waiting:** `dev` waits inside its own turn. Before it comments, it counts the bot's
  comments:
  `gh pr view <pr> --json comments --jq '[.comments[] | select(.author.login == "claude")] | length'`.
  Call that N. After it comments, it checks every 60 seconds until comment N + 1 exists
  and its body starts with `**Claude finished`. It gives up after 20 minutes and says
  so.
- **Reading it:** the bot's last comment:
  `gh pr view <pr> --json comments --jq '[.comments[] | select(.author.login == "claude")] | last | .body'`.
- **Answer:** `dev` runs the `address-comment` skill for the PR, on the latest comment.
  When the order says the next round is the last one, `dev` first reads the findings of
  every round together and looks for a shared cause. It proves each fix: a test that fails before the fix and passes
  after it, or a reason from the code. No fix is a guess.
- **Rounds:** at most 3.

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
