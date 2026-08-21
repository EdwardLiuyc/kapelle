# pickup-issue

Turn an issue into an agreed, written scope before any code is written.

**When to run this:** someone asks to pick up, start, scope, or break down issue `<N>`.

**Requirements:** a shell, `gh` authenticated for the repo, read access to the repo's docs.
Nothing agent-specific — no MCP server, no plugin, no particular model.

**How to invoke:** there is no auto-discovery and none is needed — read this file and
follow it. Concretely:

| context | invocation |
|---|---|
| any agent with a prompt | paste this file, then: `Run this procedure for issue #<N> in <repo>.` |
| an agent working in this repo | `AGENTS.md` points here; ask for "pickup-issue #<N>" |
| this repo's ACP client | `node run.mjs "$(cat .agent/skills/pickup-issue/SKILL.md)\n\nRun this for issue #<N>." --agent opencode --mode ask` |

Arguments the procedure understands, however they arrive: the **issue number** (required),
`--repo owner/name` (defaults to the `origin` remote), `--dry-run` (print the comment,
do not post it).

## Procedure

### 1. Verify the issue

```bash
gh issue view <N> --json number,title,body,state,labels,milestone,comments
```

- Not found, or not in this repo → stop and say so. Do not scope an issue you cannot read.
- `state: CLOSED` → stop and ask whether to reopen or pick a different issue.
- Record labels and milestone; they usually name the phase the issue belongs to.

### 2. Read the body **and every comment, in order**

The body is what planning wrote. Comments are what development learned since.
**Later comments outrank the body** where they conflict — that is normal refinement,
not an error. Build the current picture from body + comments merged, and note which
comment changed what.

Watch for: measurements that contradict an assumption in the body, scope the owner
already removed or added, decisions made in review, and links to sibling issues.

### 3. Cross-check against the repo's plan docs

Find them — typically `docs/*.md` (`PLAN`, `STORIES`, `ROADMAP`, `BRIEF`, `FINDINGS`,
`ARCHITECTURE`), else `README.md` or an `.md` the issue links to.

```bash
ls docs 2>/dev/null; grep -rn "<issue-id-or-title-keyword>" docs README.md
```

Read the matching story **and its neighbours** — the stories that depend on this one, and
the ones it can delete or unblock. Also open the source lines the issue cites, and confirm
they still say what the issue claims.

Classify every divergence:

- **Stale** — the docs predate a decision already recorded elsewhere. Note it; no question needed.
- **Under-specified** — the docs describe something that is not runnable as written. Propose the fix in the scope; no question needed.
- **Critical** — issue and docs point at genuinely different work, different acceptance,
  or different architecture, and picking wrong wastes the story. **Stop and ask the developer**
  which side is authoritative and which gets adjusted, before posting anything.

When in doubt whether a gap is critical, ask this: *would following the docs and following
the issue produce different deliverables?* If yes, ask.

### 4. Post the comment

One comment, as short as it can be while still deciding things. Structure:

```markdown
## Scope of work (story + <what the comments changed>)

**1. <imperative, one line>** — <one or two sentences, with file:line where it helps>
**2. …**   (aim for 3–7 items; if you need more, the issue is two issues)

## Acceptance criteria

- [ ] <checkable, observable, one line each>

**Out of scope:** <the neighbouring stories this is not>

## Gaps with `docs/<file>.md`

**1. <the gap in a phrase>** — <what the doc says, at file:line; what is actually true; what this issue should do about it>
```

Rules:
- Every acceptance criterion must be checkable by looking at something — a command's output, a file, a recorded verdict. "Works correctly" is not a criterion.
- Cite `file:line` for every claim about the code or the docs.
- Do not restate what an existing comment already established; reference it.
- Say what you checked and found *consistent* in one closing line, so silence is not mistaken for not-looking.
- Post with `gh issue comment <N> --body-file <tmpfile>` (a heredoc into a temp file — never inline, backticks and quotes will not survive).
- Under `--dry-run`, print instead of posting.

### 5. Print the work split — terminal only

**Not a file. Not a comment on the issue.** It is advice to the developer standing there,
and it goes stale the moment the work starts.

```
MANUAL (developer)          — needs a human: credentials, installs, paid/irreversible
                              actions, product judgement, anything whose output is a
                              decision rather than a diff
PREFER MANUAL (pairing)     — an agent can draft it, a human should drive or verify:
                              measurements someone will later rely on, changes to a
                              safety boundary, anything where "it ran" ≠ "it is right"
AGENT-SAFE                  — mechanical and verifiable: edits with a test, doc updates,
                              refactors, scaffolding, the write-up of a result already obtained
```

Give each line the reason in a few words. Close with the one thing that blocks the rest.

## Rules

- **Never scope silently around a critical gap.** Ask.
- **Never post a second comment that repeats the first.** If the issue already has a scope comment, update the picture and post only what changed — or say the existing one still stands.
- **Do not start the implementation.** This skill ends at a posted comment and a printed split.
- Keep the issue comment short. The value is in the decisions it forces, not its length.
