---
name: merge-close
description: "Merge a pull request after verifying all acceptance criteria are met: find the PR for the current branch, confirm an AC list exists, confirm the branch is synced to remote, verify every AC is met, post a short all-ACs-met comment, merge and delete the branch, check whether a linked issue auto-closed, and move newly unblocked issues to Ready on the project board. Trigger: /skill:merge-close <pr-number>, or any request to 'merge close', 'check ACs and merge', or 'complete the PR'."
---

# merge-close

This is a discovery shim, not the skill. The procedure is harness-neutral and lives at
`.agent/skills/merge-close/SKILL.md` in the repository root.

**Read that file now and follow it** — resolve the path from the repository root, not from
this shim's directory — passing through whatever arguments came with the invocation
(PR number, `--repo`, `--dry-run`).

Keep edits in that file. Anything harness-specific added here would apply to pi and
silently not the other harnesses.
