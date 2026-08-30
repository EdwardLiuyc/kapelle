# AGENTS.md

Instructions for any coding agent working in this repo. Harness-neutral by design — this
repo drives several harnesses, so a procedure only one of them can follow is a bug.

- Project context, architecture and invariants: **`CLAUDE.md`** (named for the tool that
  loads it automatically; the contents apply to every agent).
- Plan, stories and empirical findings: **`docs/`**.

## Git discipline

**Never commit, push, or create branches/PRs unless the user explicitly asks in that
instruction.** Keep edits in the working tree until then. When asked to commit, commit on
the story's branch — never directly on `master`.

## Markdown lint

All tracked `.md` files stay clean under `markdownlint-cli2` (config: `.markdownlint.json`,
the same rules pi-lens applies). After editing any Markdown, run:

```bash
npx -y markdownlint-cli2 --config .markdownlint.json $(git ls-files '*.md')
```

Fix findings before finishing. An inline `<!-- markdownlint-disable MD0xx -->` is allowed
only with a comment saying why.

## Skills

Reusable procedures live in `.agent/skills/<name>/SKILL.md` as plain Markdown, assuming
only a shell and the CLIs they name. There is no registry and no plugin: read the file and
follow it.

- **[`pickup-issue`](.agent/skills/pickup-issue/SKILL.md)** — run when asked to pick up,
  start, scope or break down a GitHub issue, before writing any code.
