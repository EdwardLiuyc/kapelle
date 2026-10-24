# address-comment

Turn a pull request's open review comments into fixes, reasoned rejections, and a reply on
every thread — with CI read, not assumed, before any of it is claimed.

**When to run this:** someone asks to address, handle, triage or answer review comments on
PR `<N>`.

**Requirements:** a shell, `gh` authenticated for the repo, push access to the PR's branch,
and the repo's own test and lint commands. Nothing agent-specific — no MCP server, no
plugin, no particular model.

**How to invoke:** there is no auto-discovery and none is needed — read this file and
follow it. Concretely:

| context | invocation |
| --- | --- |
| any agent with a prompt | paste this file, then: `Run this procedure for PR #<N> in <repo>.` |
| an agent working in this repo | `AGENTS.md` points here; ask for `"address-comment #<N>"` |
| this repo's ACP client | `node cli.ts "$(cat .agent/skills/address-comment/SKILL.md; printf '\n\nRun this for PR #<N>.')" --agent opencode --mode ask` |

Arguments the procedure understands, however they arrive: the **PR number** (required
unless the current branch has exactly one open PR), `--repo owner/name` (defaults to the
`origin` remote), `--dry-run` (print the fixes and replies, change and post nothing).

## Procedure

### 1. Find the threads that are actually open

```bash
gh pr view <N> --json number,title,state,isDraft,headRefName,mergeable
gh pr checks <N>
```

- `state: MERGED` or `CLOSED` → stop and ask. A merged PR can still take replies, but a fix
  belongs on a new branch and the developer decides that, not you.
- Check out the PR's `headRefName` before touching anything. Fixing on the wrong branch is
  the one mistake this procedure cannot undo for you.

**An open thread is a top-level review comment with no reply under it** — not "a comment
newer than some timestamp". Timestamps drift, get re-fetched, and cannot tell you whether
anyone answered. Replies are recorded, so use them:

```bash
gh api repos/{owner}/{repo}/pulls/<N>/comments \
  --jq '[.[] | select(.in_reply_to_id != null) | .in_reply_to_id] as $answered
        | .[] | select(.in_reply_to_id == null)
        | select(.id as $i | $answered | index($i) | not)
        | "=== id=\(.id) \(.path):\(.line // .original_line) by \(.user.login)\n\(.body)\n"'
```

Read the review summaries too — they carry the reviewer's overall verdict and sometimes a
finding that is attached to no line at all:

```bash
gh api repos/{owner}/{repo}/pulls/<N>/reviews \
  --jq '.[] | "=== \(.user.login) \(.state)\n\(.body)\n"'
```

### 2. Judge each comment against the code, not against its confidence

Open the lines it names and decide for yourself. A reviewer — human or bot — states
findings in the same tone whether they are right or wrong.

Each comment ends in exactly one of three verdicts:

- **Valid** — reproduce it, then fix it.
- **Valid finding, wrong fix** — the problem is real and the suggested change is not. Fix
  the real problem and say why the suggestion was not taken. This is the most common
  interesting case and the most valuable reply you will write.
- **Not valid** — reject it, with the evidence that disproves it.

What to watch for, each of which has bitten this repo:

- **A doc/code mismatch where the doc is the wrong half.** "This comment says X, the code
  does Y" is a real finding whose fix may be to correct the comment. Decide which half is
  right by what the behaviour *should* be, not by which is easier to edit.
- **A test that asserts the bug.** If fixing the code turns a test red, read that test
  before touching it. It may be holding the defect in place, in which case it is part of
  the fix — and its correction says so in a comment.
- **A finding you cannot reproduce locally.** Say so plainly. A race that only a loaded CI
  runner loses is still real; CI's own log is stronger evidence than a local probe, and
  "I could not reproduce this" belongs in the reply.
- **A correct fix that is out of this PR's scope.** Land it as its own commit and say why,
  or open an issue. Never fold it in silently, and never widen the PR without saying so.

**Never change code to satisfy a finding you have not reproduced.** A change made to
silence a report you did not verify is how a stale finding becomes a real defect.

### 3. Fix, gate, push, and read CI

Run the repo's gate before committing — not the one suite you think you touched.
Find the commands in `package.json`, `Makefile`, or the contributor docs. In this repo:

```bash
npm test && npm run check && npm run fmt:check && npm run knip && npm run selftest
```

If every changed file is Markdown, run only the Markdown lint that `AGENTS.md` names.

Then commit and push:

- One commit per distinct concern. A review round that touches one area is one commit; a
  bug in a different file, found while fixing, is its own.
- The message says which findings it closes, which were rejected, and why — that reasoning
  is the part that survives into the log.
- **Amend only a commit that has never been pushed.** Once it is on the remote, a follow-up
  is a new commit, so the history shows what review changed.

Then **wait for CI and read the result**:

```bash
gh pr checks <N> --watch
gh run view <run-id> --log-failed   # when something is red
```

**Local green is not CI green.** If CI fails, that failure is now part of this round: fix
it, push again, and record it in a commit message rather than hiding it in an amend. Do not
report a result you have not read.

### 4. Reply to every thread

One reply per thread, posted **into the thread** rather than as a new top-level comment:

```bash
gh api -X POST repos/{owner}/{repo}/pulls/<N>/comments/<comment-id>/replies \
  -F body=@reply.md
```

Every reply carries three things: the **verdict**, the **commit** that acts on it, and the
**evidence**. Weight them by outcome — an acceptance can be short, a rejection has to earn
itself, and a "valid finding, wrong fix" has to say both halves or it reads as a refusal.

Reply to rejected comments too. Silence reads as agreement or as an oversight, and nobody
can tell which when they come back to it.

Under `--dry-run`, print the replies instead of posting them.

### 5. Report the round — terminal only

Not a file, not a PR comment. One table for the developer standing there:

```text
comment              verdict                     lands in
cli.ts:120           valid                       <sha>
core/run.ts:320      valid finding, wrong fix    <sha> (doc corrected, not the code)
core/run.ts:408      valid                       <sha>
tests/cli.test.ts:44  rejected — <one line why>   —
```

Close with the CI state and the one thing that still blocks a merge.

## Rules

- **Every thread gets a reply.** A fixed comment with no reply looks unread.
- **Never claim a check you have not run, or a green you have not read.**
- **Reproduce before you fix, and say so when you could not.**
- **Do not fix past the comment.** Extra scope is its own commit, named as such.
- Write every reply to a file and post it with `-F body=@reply.md` — never inline, because
  backticks and quotes will not survive the shell. The file form keeps the body out of the
  shell entirely, so nothing has to survive it; it is also the form the Projects rule below
  already uses. (`-F body="$(cat reply.md)"` does keep newlines — quoted command
  substitution does not word-split — but it drops the trailing newline and puts the body
  back through the shell for no gain.)
- `gh pr edit` fails on some repos with Projects (classic) enabled. When updating a PR
  body, use `gh api -X PATCH repos/{owner}/{repo}/pulls/<N> -F body=@<file>` instead, then
  read it back to confirm it landed.
- If a comment is ambiguous enough that two readings produce different code, **ask** rather
  than guessing — a wrong fix plus a confident reply is worse than a question.
