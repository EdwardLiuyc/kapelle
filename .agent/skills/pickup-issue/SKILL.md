# pickup-issue

Turn an issue into an agreed, written scope — and a short list of decisions only the
developer can make — before any code is written.

**When to run this:** someone asks to pick up, start, scope, or break down issue `<N>`.

**Requirements:** a shell, `gh` authenticated for the repo, read access to the repo's docs.
Nothing agent-specific — no MCP server, no plugin, no particular model.

**How to invoke:** there is no auto-discovery and none is needed — read this file and
follow it. Concretely:

| context | invocation |
| --- | --- |
| any agent with a prompt | paste this file, then: `Run this procedure for issue #<N> in <repo>.` |
| an agent working in this repo | `AGENTS.md` points here; ask for `"pickup-issue #<N>"` |
| this repo's ACP client | `node cli.ts "$(cat .agent/skills/pickup-issue/SKILL.md; printf '\n\nRun this for issue #<N>.')" --agent opencode --mode ask` |

Arguments the procedure understands, however they arrive: the **issue number** (required),
`--repo owner/name` (defaults to the `origin` remote), `--dry-run` (print the comment,
do not post it).

## Procedure

### 1. Verify the issue

```bash
gh issue view <N> --json number,title,body,state,labels,milestone,comments
```

Use only this `--json` form. Never `gh issue view <N> --comments` or the plain-text view:
`gh` 2.45 asks there for `projectCards`, which GitHub turned off, so the call fails.

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

### 4. Put the open decisions to the developer

**Not the same as step 3's critical gap.** That one is a conflict between the issue and the
docs. These are choices the work needs and nothing has made yet — an order to build two
issues in, where a new flag lives, whether a value ships before it has a producer, what a
URL should point at. Nobody wrote them down because nobody had to until now.

A choice belongs on this list only if **both answers produce different work** — different
code, a different order, or a different deliverable. Everything else you decide yourself,
name in the comment as decided, and move on. A question with an obvious default is not a
decision, it is a delay.

Present each one as:

- **The question**, in one line.
- **Why it is open** — the context the developer needs to answer in seconds rather than
  reading the code. Name the file, story or measurement that makes it a fork.
- **At least two options**, each with its cost. Two is the usual shape. Add a third when a
  third answer is genuinely live — but do not pad: an option nobody would pick is a
  distractor, and a long menu is slower to answer than a short one.
- **A recommendation**, and the reason for it. An unrecommended list is work handed back.

**How long the list should be.** This is about the number of *decisions*, not the number of
options inside one. There is no hard limit on the number. Some have none — say "no open decisions"
rather than inventing one to look thorough. Some have more, usually zero to four per issue.
If you reach five, stop and report that instead: that many live forks means the issue was
never scoped, which is a bigger finding than any single one of them.

There could be some decisions that are trivial or obvious, and those do not need to be listed.
Just mention them briefly after the main list of open decisions, without going into the full
decision-making process.

**When to ask.** Before posting the comment, so the answers land in it as settled decisions
rather than as open questions. The comment says what was decided and when.

**If nobody answers — wait. This step is a gate.** Do not take your own recommendations and
carry on, and do not write them into the comment as assumptions. The list exists precisely
because each answer changes the work, and a scope nobody agreed to is not an agreed scope;
proceeding on a guess produces a comment that reads as settled while resting on nothing.

There are exactly two ways past the gate:

- the developer answers **every** decision on the list; or
- the developer says explicitly to take the recommendations and stop asking. That is a
  blanket answer and it covers the whole list, including a decision you find later in the
  same run — do not come back with the same list rephrased.

Anything else leaves it closed. Silence, an unrelated reply, or an answer to some but not
all: ask again, naming **only** the decisions still open. Waiting is cheap here; every
later step is built on these answers.

This is also why the list stays short. A gate you cannot pass quickly is one nobody reaches
— so hand over only the decisions that genuinely change the work, and decide the rest.

### 5. Post the comment

One comment. **Two sections are mandatory; the rest appear only when they have content.**
Budget: **200 words for an XS/S story, 350 for anything larger.** Over budget means the
comment is carrying prose that decides nothing — cut prose, never cut a criterion.

```markdown
## Scope (story + <what the comments changed>)

<A short paragraph, or one line per distinct decision. This section answers *why this
work and not the neighbouring stories* — the framing, the ordering, the thing a reader
would otherwise get wrong. It does not enumerate the deliverables; the criteria do that.>

## Acceptance criteria

- [ ] <checkable, observable, one line each>

## Out of scope        <- only if a real neighbour would otherwise be assumed in
<one line>

## Gaps with `docs/<file>.md`    <- only if a real divergence was found
**1. <the gap in a phrase>** — <what the doc says, at file:line; what is actually true; what this issue should do about it>
```

Rules:

- **Scope and criteria must not restate each other.** If a scope item's content is fully
  captured by a criterion, delete the scope item — the criterion is the one that gets
  checked. Prefer the whole scope section to be a paragraph rather than a numbered list;
  reach for the list only when the work has genuinely separable decisions.
- **As few items as the work has distinct decisions. One is a valid answer.** Never pad a
  list to look thorough. If the list passes ~7, the issue is two issues.
- **Drop a section rather than fill it.** No neighbouring story to disclaim → no *Out of
  scope*. No divergence → no *Gaps*, and say "docs consistent" in the closing line instead.
- Every acceptance criterion must be checkable by looking at something — a command's output, a file, a recorded verdict. "Works correctly" is not a criterion.
- Cite `file:line` for every claim about the code or the docs.
- Do not restate what an existing comment already established; reference it.
- Say what you checked and found *consistent* in one closing line, so silence is not mistaken for not-looking.
- Post with `gh issue comment <N> --body-file <tmpfile>` (a heredoc into a temp file — never inline, backticks and quotes will not survive).
- Under `--dry-run`, print instead of posting.

### 6. Print the work split — terminal only

**Not a file. Not a comment on the issue.** It is advice to the developer standing there,
and it goes stale the moment the work starts.

```text
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
- **Never hand back a decision you could have made.** The list in step 4 earns its place
  only when both answers change the work; padding it turns scoping into an interview — and
  because that list blocks, padding it blocks too.
- **Step 4 is a gate, not a suggestion.** Nothing after it happens until the developer has
  answered every decision, or has said to take the recommendations without asking again.
- **Never take a decision that was the developer's and leave it unwritten.** Whichever way
  it went, the posted comment says what was decided and when.
- **Never post a second comment that repeats the first.** If the issue already has a scope comment, update the picture and post only what changed — or say the existing one still stands.
- **Do not start the implementation.** This skill ends at an answered decision list, a posted comment and a printed split.
- Keep the issue comment short. The value is in the decisions it forces, not its length.
