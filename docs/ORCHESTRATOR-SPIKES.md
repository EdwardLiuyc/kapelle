# Orchestrator spikes

What three throwaway runs of an orchestrator agent showed, on 2026-10-11 and 2026-10-12.
They are the evidence for M8 in `docs/STORIES.md`. `docs/FINDINGS.md` measures what each
harness does on its own; this file measures a loop of agents in one room, so it is kept
apart. The last section holds the runs of the shipped skill (M8-4), from 2026-10-24.

## The question

The person runs one room per issue, and drives the same loop by hand each time: pick up,
build, commit, review with a second agent, land the review, open the PR, answer two or
three bot reviews, merge. Most of their messages are one word ("commit", "go"). Can an
agent drive that loop by giving the work to other agents in the room, while the person
only decides?

## The setup

Nothing in kapelle changed. The spikes used three files in
`.agent/skills/issue-loop/` on the branch `spike/issue-loop`. The branch is on GitHub for
reference, one commit per spike, and it will not be merged.

- `SKILL.md`: the loop for the orchestrator, `po`. It never edits, builds, tests, commits,
  pushes or comments; workers do all of that.
- `room.sh`: `info`, `hire`, `send`, `wait`, `ask`, `ff`, `diff` and `fire`, over the room
  routes of `docs/CLIENT-API.md`, with the operator's token from `daemon.json`.
- `relay.sh` (from spike 2): it follows the room's stream. When a worker's turn ends, it
  sends that turn's answer to `po` as a new message that starts with `[relay]`.

GitHub's bot reviewed each PR when a worker commented `@claude review`.

## The three runs

| | Spike 1 | Spike 2 | Spike 3 |
| --- | --- | --- | --- |
| Issue, size | #220, XS | #163, S | #251, M |
| PR | #259 | #262 | #263 |
| Room | `room-20261011-133305-l7ju` | `room-20261011-181745-q8ac` | `room-20261011-201223-ioz7` |
| `po` | claude | claude | claude |
| `dev`, `rev` | claude, pi | claude, pi | pi, pi |
| How `po` waited | inside its turn (`room.sh ask`) | short turns, woken by the relay | short turns; `dev` waits for the bot |
| Start to hand-over | 30 min | 69 min | 2 h 37 min, with a 22 min wait for the person |
| `po` turns, tool calls, cost | 1, 20, $0.62 | 11, 23, $0.91 | 14, 23, $1.17 |
| `dev` turns, tool calls, cost | 6, 32, $1.01 | 8, 77, $3.16 | 10, 336, none reported |
| `rev` turns, tool calls | 1, 36 | 2, 68 | 2, 125 |
| Bot rounds | 2 | 3 | 3 |
| Person messages before the hand-over | 0 | 0 | 2 (one to `po`, one to `dev`) |
| Relayed answers | none | 10 of 10 | 12 of 12 |

The three rooms were deleted after the runs. Their event logs, which hold every number
above, are not in the repository; the person keeps a copy outside it.

All three PRs merged after the person read them. In all three runs, `po` ran only reads,
`room.sh` and `gh` reads; every write was a worker's. No worker left its own checkout, and
the main checkout stayed clean.

## What each run tested

**Spike 1** ran the happy path: no choice at gate 1, no review finding, two bot rounds.
`po` ran the whole loop in **one 30-minute turn**. While it ran, a message from the person
to `po` would have waited in its queue until the end: the only way in was a cancel.

**Spike 2** moved the wait out of `po`'s turns. `po` sent one message, ended its turn, and
the relay woke it with the answer. Each relay arrived in under a second, and `po` was free
for about 78% of the run. Its only long turns were its own waits for the GitHub bot, 3 to
6 minutes each. The path where review fixes land worked: `rev` added two tests, `po`
fast-forwarded `dev` to `rev`'s commit, and `dev` checked each test by breaking the code.
The person's bot rule worked: round 2 had a missing test, so it was a real finding; round 3
had only a nit, so `po` stopped without `/address-comment`.

**Spike 3** moved the bot wait into `dev`'s turn, so every `po` turn took under 30
seconds. Gate 1 worked: `dev` found a choice the person had to make (the order of the
marks on a room row), `po` stopped and put it in plain words, and passed the answer on 5
seconds after it came. The person also asked `dev` for sketches directly. The relay passed
that answer to `po` too, and `po` guessed, correctly, that the person had asked.

## Findings

### The loop

1. **An orchestrator that waits inside its turn shuts the person out.** One long turn means
   the person's messages queue behind it, and a turn cap on it means nothing (spike 1).
   Short turns plus a wake-up fix both (spike 2).
2. **A wake-up for every worker answer is too much.** The relay also woke `po` for a turn
   the person started (spike 3). `po` had to guess who started it. A reply should go to
   whoever sent the message, and `po` should get a labelled copy of what the person tells a
   worker.
3. **`po` needs the state, not the details.** When the person orders `dev` directly, `po`
   cannot see which step `dev` is on. The fix the person chose: `po` gives `dev` the plan
   of steps at the start, and `dev` ends every report with the board.
4. **The bot is not a room worker.** No relay comes for it. Waiting for it inside `po`'s
   turn shut the person out again for 3 to 6 minutes (spike 2). Waiting inside `dev`'s
   turn did not (spike 3).
5. **The nit rule can cost a round.** "Not sure, so treat it as real" sent two items the
   bot had marked optional back to `dev` (spike 3). The fix in that round caused a small
   bug, which round 3 found. With no round left, it went to the person, who chose to fix
   it without a bot review.
6. **A worker's skill asks the person things the loop already decides.** `review-local`
   ends with a choice for the person (keep the tests or drop them), and each worker ends
   with "what to do now", which can differ from the loop's next step.
7. **`po` will decide a choice inside the scope if nothing stops it.** In spike 3 it chose
   an option for an internal cache itself, then told the person they could change it.
   Nothing in the skill said whether it may.
8. **Safety-relevant changes passed without a gate.** PR #262 changed `protocol/agent.ts`
   and a rule in `AGENTS.md` about the `toolCallId` map, and no person approved the plan
   first. In spike 3, with a gate in the skill, `po` had to decide alone that an edit to
   `AGENTS.md`'s file map is not a rule change.
9. **Worktrees need `node_modules`.** Every worker in every room linked the main
   checkout's copy by hand. Before the spikes, one test run hung for 24 minutes without it.
10. **The full suite fails from a room worktree's long path.** A pty test in
    `tests/daemon.test.ts` clips the mock agent's command at 100 or 120 columns. Workers
    ran the suite from a short temporary worktree instead.
11. **The full suite ran three times on code that had not changed** (spike 1): at the
    build, in the review, and after a change to a comment only. Each run takes 4 to 5
    minutes.

### The API and the tools

1. **The event stream never ends by itself.** To read "everything so far", a script reads
   `GET /rooms/:id` for `seq`, then reads that many `data:` lines and stops. On this
   machine, `awk` is `mawk`, which buffers its input, so a pipe into it waited forever;
   `grep -m` exits at the last line and works. A reader that reads the whole 49 MB log of
   one pi room took 2.5 seconds.
2. **No message carries its sender.** A message `po` sends is saved as
   `_client_user_message`, the same as the person's, so the TUI shows it as the person's.
3. **Claude Code refuses a command that starts with `sleep`.** A wait loop must check
   first and sleep inside the loop.
4. **pi reports no cost.** claude reports USD on `usage_update`. `AGENTS.md` forbids adding
   up usage across harnesses, so a cost cap can only be per claude worker.
5. **pi's start-up banner** comes as `agent_message_chunk` before any message. It is not
   inside a turn, so a reader that starts at a `_client_user_message` skips it.

### GitHub

1. **Branch protection is not available.** The repository is private on the free plan:
   GitHub answers `Upgrade to GitHub Pro or make this repository public`.
2. **Every agent uses the person's own `gh` login.** So even with branch protection, GitHub
   could not tell an agent's merge from the person's. Only a separate account for agents
   would.
3. **The bot cannot run the checks.** Its job allows no `npm ci` and has Node 22; it
   reviews by reading the code, so CI is the only check that runs.

## What the spikes did not test

- An orchestrator with a reply-to-sender daemon: the relay stood in for it.
- A stop button, a turn cap or a bell: none exists yet.
- A worker that fails twice, or `dev` and `rev` that disagree.
- More than one issue at a time.

## The skill's runs (M8-4)

Two runs of the shipped skill, `assets/orchestrator.md`, with this repository's recipe,
`.kapelle/loops/fix-issue.md`. They test the skill, not kapelle: the daemon's replies and
copies (M8-2) and `kapelle room` (M8-3) took the place of the spikes' scripts. Each run
started by hand: a room, `po` added as a claude orchestrator in `auto`, and one message
that pointed it at the skill and the recipe.

| | Run 1 | Run 2 |
| --- | --- | --- |
| Issue, size | #343, XS | #317, S |
| PR | #346 | #349 |
| Room | `room-20261024-214725-fewd`, "spike-343" | `room-20261025-104523-4usd`, "spike-317" |
| `po`, `dev`, `rev` | claude, claude, pi | claude, claude, pi |
| Start to hand-over | 1 h 47 min, with a 75 min wait for the person | 1 h 44 min, with about 50 min of waits for the person |
| Turns: `po`, `dev`, `rev` | 10, 6, 1 | 14, 10, 2 |
| Cost: `po`, `dev` | $1.19, $2.40; pi reports none | $1.07, $5.82; pi reports none |
| Bot rounds | 2 | 2 |
| Person messages before the hand-over | 2: "go", and the answer to one choice | 6: "go", two answers to `dev`, a question to `dev`, a cancel and a "continue" to `rev` |

**Run 1** had no choice at pick-up. `rev` found nothing, so no review landed and
`kapelle room ff` did not run. The bot's round 1 raised a real choice (fix only a code
comment, or also refuse a negative `turns`), and `po` stopped for it, as D6 says. The
person answered `po` with "go with A". Round 2 had only optional items, so the review loop
ended. After the hand-over the person told `dev` "merge close" directly, and `po`'s copy
of it led to a correct closing report.

What the run found:

1. **A worker waited in the background.** `dev` started the bot wait as a background
   command, and its turn ended at once. `po` saw it from the reply and sent it back to
   wait, at the cost of one turn. The skill now tells the worker to wait in the
   foreground, and tells `po` what to do when a reply says the worker still waits.
2. **`po` typed `node cli.ts room`, not `kapelle room`.** It read this repository's own
   command list. Both work here; only `kapelle` works in another repository, so the
   skill now says to type `kapelle`.
3. **`gh issue view --comments` failed** on `gh` 2.45 (#345). `po` tried again with
   `--json`.

**Run 2** stopped for a choice at pick-up: where to write the early record. The person
asked `dev` for diagrams, then answered `dev` directly: "let's pick A". `dev` recorded it
and went no further, as its first rules say; `po` read the copy and sent the order to
build. A failing test brought a second choice, which the person also answered on `dev`.
`rev` then went quiet for six minutes. The person cancelled it; `po` got the cancelled
reply and stopped to ask. The person told `rev` to go on, `rev` added one test, and `po`
landed it with `kapelle room ff`. `dev` kept the finding and wrote a simpler test. Round 2
of the bot said "Ship it", with only nits, and `po` handed over.

What the run found:

1. **The two run 1 fixes held.** `dev` waited for the bot inside its turn, and `po`
   typed `kapelle room` every time.
2. **A quiet worker wakes nobody.** The daemon's stall warning goes to the screen, not to
   `po`, so only the person saw that `rev` had stopped. The skill cannot react to it.
3. **"Found nothing" was not specific.** An empty or wrong range of commits would also
   find nothing. The recipe now asks `rev` to name the commits it reviewed, and `po` to
   check that they end at `dev`'s last commit.

**Decided 2026-10-25:** both runs pass. M8-4's first run asks for "no choice", but the bot
can raise a choice in any review, so no issue can promise none. The test is that `po`
stops only for a real choice, and in run 1 it did. Run 2 stopped for a choice and went on
after the person answered `dev` directly, as M8-4 asks.
