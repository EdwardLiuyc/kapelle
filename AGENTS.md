# AGENTS.md

Instructions for any coding agent working in this repo. Harness-neutral by design — this
repo drives several harnesses, so a procedure only one of them can follow is a bug.

- Project context, architecture and invariants: **`CLAUDE.md`** (named for the tool that
  loads it automatically; the contents apply to every agent).
- Plan, stories and empirical findings: **`docs/`**.

## Skills

Reusable procedures live in `.agent/skills/<name>/SKILL.md` as plain Markdown, assuming
only a shell and the CLIs they name. There is no registry and no plugin: read the file and
follow it.

| skill | run it when |
|---|---|
| [`pickup-issue`](.agent/skills/pickup-issue/SKILL.md) | asked to pick up, start, scope or break down a GitHub issue — before writing any code |
