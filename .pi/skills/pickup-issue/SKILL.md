---
name: pickup-issue
description: "Pick up a GitHub issue before writing code: read the issue and every comment, cross-check against the repo's plan/story docs, put the open decisions to the developer with context, options and a recommendation, post a short scope + acceptance-criteria comment that names the gaps and the decisions taken, and print a manual-vs-agent work split to the terminal. Trigger: /skill:pickup-issue <number>, or any request to 'pick up', 'start', 'scope', or 'break down' an issue."
---

# pickup-issue

This is a discovery shim, not the skill. The procedure is harness-neutral and lives at
`.agent/skills/pickup-issue/SKILL.md` in the repository root.

**Read that file now and follow it** — resolve the path from the repository root, not from
this shim's directory — passing through whatever arguments came with the invocation
(issue number, `--repo`, `--dry-run`).

Keep edits in that file. Anything harness-specific added here would apply to pi and
silently not the other harnesses.
