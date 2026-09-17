---
name: address-comment
description: "Address open review comments on a pull request: judge each one against the code, fix the valid ones, reject the wrong ones with evidence, run the repo's full gate, push and confirm CI is green, then reply on every thread. Trigger: /skill:address-comment <pr-number>, or any request to 'address', 'handle', 'triage' or 'reply to' review comments."
---

# address-comment

This is a discovery shim, not the skill. The procedure is harness-neutral and lives at
`.agent/skills/address-comment/SKILL.md` in the repository root.

**Read that file now and follow it** — resolve the path from the repository root, not from
this shim's directory — passing through whatever arguments came with the invocation
(PR number, `--repo`, `--dry-run`).

Keep edits in that file. Anything harness-specific added here would apply to pi and
silently not the other harnesses.
