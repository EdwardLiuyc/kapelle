# merge-close

Merge a pull request only after every acceptance criterion is met — then clean up the
branch and verify a linked issue auto-closed.

**When to run this:** someone asks to merge-close a PR, check ACs and merge, complete the
PR, or merge after verifying all acceptance criteria.

**Requirements:** a shell, `gh` authenticated for the repo, push access to the PR's branch,
and a local checkout of the PR branch. Nothing agent-specific — no MCP server, no plugin,
no particular model.

**How to invoke:** there is no auto-discovery and none is needed — read this file and
follow it. Concretely:

| context | invocation |
| --- | --- |
| any agent with a prompt | paste this file, then: `Run this procedure for PR #<N> in <repo>.` |
| an agent working in this repo | `AGENTS.md` points here; ask for `"merge-close #<N>"` |
| this repo's ACP client | `node run.ts "$(cat .agent/skills/merge-close/SKILL.md; printf '\n\nRun this for PR #<N>.')" --agent opencode --mode ask` |

Arguments the procedure understands, however they arrive: the **PR number** (required
unless the current branch has exactly one open PR), `--repo owner/name` (defaults to the
`origin` remote), `--dry-run` (print what would happen, merge nothing).

## Procedure

### 1. Find the PR and an Acceptance criteria source

- Current branch names the PR head. Find the open PR:

```bash
git branch --show-current
gh pr list --head <branch> --state OPEN --json number,title,url
```

- If there is not exactly one open PR for this branch, stop and say so.
- The PR must have an explicit list of acceptance criteria somewhere the PR is connected
  to: the PR description, a PR comment, or a linked issue's description/comments. Look for
  an `Acceptance criteria` heading or an equivalent `*Done when*` list. If none exists,
  stop and report where the AC list is missing. Do not invent criteria.

### 2. Confirm the branch is synced to the remote

```bash
git fetch origin <branch>
git rev-parse HEAD
git rev-parse origin/<branch>
git status --porcelain
```

- Local `HEAD` must equal `origin/<branch>` and the working tree must be clean.
- If the branch is ahead, behind, or has uncommitted changes, stop and report the sync
  state. Do not push or commit as part of this skill.

### 3. Verify every acceptance criterion is met

- Read the AC list from step 1.
- For each AC, check the branch's actual code, tests, and CI result. Run the repo's full
  local gate (this repo: `npm test && npm run check && npm run fmt:check && npm run knip
  && npm run selftest`) and read `gh pr checks <N>` — do not claim a check you have not run
  or read.
- If any AC is not met, stop and report exactly which ACs are still unmet. Do not fix them
  here and do not merge.
- If all ACs are met, continue.

### 4. Post a short summary comment

Write one short PR comment saying all ACs are met. Keep it as short as possible; do not
repeat the whole AC list unless the developer asked for it.

```bash
cat > /tmp/merge-close-summary.md <<'EOF'
All acceptance criteria are met. Local gate and CI are green.
EOF
gh pr comment <N> --body-file /tmp/merge-close-summary.md
```

Under `--dry-run`, print the comment instead of posting it.

### 5. Merge and clean up

- Read CI one last time; if any check is red or pending in a required way, stop and report.
- Merge the PR with the repo's normal method. In this repo:

```bash
gh pr merge <N> --squash --delete-branch
```

- If `gh` does not remove the remote or local branch, clean up manually:

```bash
git checkout <default-branch>
git pull
git branch -D <branch>
git push origin --delete <branch>   # only if the remote branch still exists
git remote prune origin
```

- Confirm the working tree is clean and the local branch is gone.

### 6. Check linked issue auto-close

- Find any issue the PR is connected to, usually via `Closes #N`, `Fixes #N`, or the PR's
  linked-issue metadata.
- After merge, check whether it auto-closed:

```bash
gh issue view <N> --json state,closed,url
```

- If it is not closed, report that it is still open. **Do not close it manually unless the
  developer explicitly says so.**

## Rules

- Stop at the first unmet condition. Merge only when all ACs are met, the branch is synced,
  and CI is green.
- Do not fix code, push new commits, or widen the PR during merge-close. If an AC is unmet,
  stop and report it; fixing belongs to a normal implementation/review round.
- Never invent acceptance criteria.
- Never claim a local or CI green you have not read.
- Keep the summary comment short.
- If a linked issue is not auto-closed, report it and leave it open until the developer says
  otherwise.
