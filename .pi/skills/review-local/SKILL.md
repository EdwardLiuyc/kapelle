---
name: review-local
description: "Review local work on a GitHub issue before any pull request exists: take the issue's scope comment as the scope, snapshot the current branch (committed or not), run the offline gate and each role (developer, tester, security, and any role file added later) in a temporary worktree that links the main checkout's node_modules, prove each bug or test gap there, then apply the fixes in the working tree without committing and print one line per finding as comment -> fix. Nothing is committed or posted. Trigger: /skill:review-local <issue-number> [--role a,b] [--base branch], or any request to review local work on an issue."
---

# review-local

This is a discovery shim, not the skill. The procedure is harness-neutral and lives at
`.agent/skills/review-local/SKILL.md` in the repository root.

**Read that file now and follow it** — resolve the path from the repository root, not from
this shim's directory — passing through whatever arguments came with the invocation
(issue number, `--role`, `--base`, focus text).

Keep edits in that file. Anything harness-specific added here would apply to pi and
silently not the other harnesses.
