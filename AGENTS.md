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

## Format and lint (TS/JS)

`biome` (config: `biome.json`) is the formatter and linter for all tracked TS/JS. After
editing any `.ts`/`.mts`/`.cts`/`.mjs`/`.js`/`.cjs` file, run:

```bash
npx biome check --write .
```

Fix findings before finishing. Biome findings use `// biome-ignore: <rule>: reason`;
pi-lens-native findings use `// pi-lens-ignore: <rule>` — the two do not read each
other's comments. `tsc` stays the type checker (`npm run check`), markdownlint stays for
`.md`.

## Diagnostics (pi-lens)

pi-lens is the deeper lint layer (per-edit dispatch + session scans). Before finishing a
change, clear every finding — no blockers, no warnings. Each finding is resolved one of
four ways: **fix** it (preferred; the fix is observed, not asserted), **suppress** it
inline with `// pi-lens-ignore: <rule>` (bare rule-id, comma-separate several; put the
reason in an adjacent comment — trailing text breaks the match), **disable** the rule
project-wide in `.pi-lens.json` (`rules.<id>.disable`), recording the reason in the commit
message, or **disprove** it (below). Check with `lens_diagnostics` (mode `full`); config
lives in `.pi-lens.json` and `knip.jsonc`.

**Disproving a finding.** pi-lens wraps other tools, and a wrapped tool can report
something the tool itself does not. When a finding names an underlying tool, run that tool
directly; if it disagrees, the finding is disproved rather than resolved. Record in the
commit message: the exact commands run, their exit codes, and why the finding cannot be
true (a line number that no longer exists, a symbol that is not exported, and so on).

Two rules make this a real branch rather than an escape hatch. **Never change code to
satisfy a finding you have not reproduced** — doing so once already introduced a genuine
defect in this repo (a type exported to silence a stale knip report, which then became a
real unused export). And **a disproved lane stops being a gate**: the failure is symmetric,
so a lane that serves a stale finding can equally serve a stale clean result and hide a
real one. Put the underlying tool in CI, where its verdict is reproducible — which is why
`npm run knip` runs there.

## Skills

Reusable procedures live in `.agent/skills/<name>/SKILL.md` as plain Markdown, assuming
only a shell and the CLIs they name. There is no registry and no plugin: read the file and
follow it.

- **[`pickup-issue`](.agent/skills/pickup-issue/SKILL.md)** — run when asked to pick up,
  start, scope or break down a GitHub issue, before writing any code.
- **[`address-comment`](.agent/skills/address-comment/SKILL.md)** — run when asked to
  address, handle, triage or answer review comments on a pull request. Ends with CI read
  and a reply on every thread, including the rejected ones.
- **[`merge-close`](.agent/skills/merge-close/SKILL.md)** — run when asked to merge-close
  a pull request after verifying all acceptance criteria are met. Merges, cleans up the
  branch, and checks whether a linked issue auto-closed without closing it manually.
