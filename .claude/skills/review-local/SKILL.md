---
name: review-local
description: "Review local work on a GitHub issue before any pull request exists: take the issue's scope comment as the scope, snapshot the current branch (committed or not), run the offline gate and each role (developer, tester, security, and any role file added later) in a temporary worktree that links the main checkout's node_modules, prove each bug or test gap there, then apply the fixes in the working tree without committing and print one line per finding as comment -> fix. Nothing is committed or posted. Trigger: /review-local <issue-number> [--role a,b] [--base branch], or any request to review local work on an issue."
---

# review-local

This is a discovery shim, not the skill. The procedure is harness-neutral and lives at
`.agent/skills/review-local/SKILL.md`, so every agent runs the same one.

**Read `.agent/skills/review-local/SKILL.md` now and follow it**, passing through whatever
arguments came with the invocation (issue number, `--role`, `--base`, focus text).

Keep edits in that file. Anything harness-specific added here would apply to one agent and
silently not the others.
