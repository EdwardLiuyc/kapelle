---
name: address-comment
description: "Address open review comments on a pull request: judge each one against the code, fix the valid ones, reject the wrong ones with evidence, run the repo's full gate, push and confirm CI is green, then reply on every thread. Trigger: /address-comment <pr-number>, or any request to 'address', 'handle', 'triage' or 'reply to' review comments."
---

# address-comment

This is a discovery shim, not the skill. The procedure is harness-neutral and lives at
`.agent/skills/address-comment/SKILL.md`, so every agent runs the same one.

**Read `.agent/skills/address-comment/SKILL.md` now and follow it**, passing through
whatever arguments came with the invocation (PR number, `--repo`, `--dry-run`).

Keep edits in that file. Anything harness-specific added here would apply to one agent and
silently not the others.
