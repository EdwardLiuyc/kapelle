# Story breakdown

`PROJECT-PLAN.md` sliced into deliverable stories. Companion to `PLAN-GAPS.md`, which
records the decisions this breakdown assumes.

## How to read this

- **Size** — `XS` under 2h · `S` half a day · `M` 1–2 days · `L` 3–5 days.
- **Needs** — hard ordering only. Anything unlisted can run in parallel.
- **Done when** — the observable check. If it cannot be observed, it is not a criterion.
- `G*` / `N*` refer to items in `PLAN-GAPS.md`.

Two structural changes from the plan, both argued in `PLAN-GAPS.md`:

1. **M1 is split into M1a / M1b / M1c.** The plan's M1 is ten modules, a toolchain
   migration, a five-file port, two test doubles and a merge command. Each sub-milestone
   here ends somewhere demonstrable.
2. **`node:test` is the unit-test runner.** Built into the runtime, so zero dependencies
   and no build step — the constraint the plan protects is untouched. It is why several
   stories below have a truth-table criterion rather than an end-to-end one.

---

## D — Decisions to take before M1a starts

Not stories. Half a day of decisions, most of which can be ratified as-recommended.

| # | Decision | Gap |
|---|---|---|
| D1 | Run/task id format and branch naming scheme | G1 |
| D2 | `stopReason` → task status table | G2 |
| D3 | Missing-result-block behaviour (retry, then warn) | G3 |
| D4 | Failure propagation, `skipped` state, run roll-up ordering | G4 |
| D5 | M1 rejects `needs` rather than ignoring it | G5 |
| D6 | `--rebase` moves to M3 | G6 |
| D7 | `.agent-team/` git-ignore preflight | G7 |
| D8 | `allowReadOutsideRoot` in the precedence chain, forced off under `safe` | G8 |
| D9 | Registry `env` field; daemon strips `AGENT_TEAM_*` | G9 |
| D10 | `maxConcurrency` default | G10 |
| D11 | Event log shape and cursor semantics | G11 |
| D12 | Handshake request timeout, `session/prompt` exempt | G12 |
| D13 | `node:test` for pure functions | — |

D11 can wait until M2 planning. The rest gate M1a.

---

## M0 — Reconnaissance

Builds nothing except three papercut fixes. Every M1 default depends on its findings.

**M0-1 · Harness availability and handshake survey · S**
Run the current MVP against `opencode acp`, `claude-agent-acp` and `copilot --acp`.
Record per harness: does it spawn, does it complete a turn, which `session/update`
variants arrive that `render.mjs:20` does not handle, which methods hit the
`#handleRequest` default (`acp.mjs:196`), and what `agentCapabilities` it advertises —
including `loadSession` (N9).
*Done when* the findings note has a row per harness, and any harness that could not be
installed or authenticated is recorded as unavailable rather than untested (N1).

**M0-2 · Registry papercut fixes · XS**
`copilot acp` → `copilot --acp` (`agents.mjs:32`). Bake `env -u CLAUDECODE` into the
`claude` entry (`agents.mjs:22`).
*Done when* both harnesses start from a clean shell with no manual env fiddling.
*Note* the `claude` fix needs the registry `env` field from D9, or a stopgap that D9 later
replaces.

**M0-3 · Terminal and shell-routing spike · M · needs M0-1**
Flip `clientCapabilities.terminal` to `true` (`acp.mjs:82`), stub `terminal/*` as logging
no-ops in `#handleRequest`, and run each harness on "run the tests" in a throwaway
workspace under `--mode auto` (under `safe` the `execute` permission is denied before any
terminal call would happen).
*Done when* each harness has a recorded verdict on two separate questions: does
`terminal/create` ever arrive (scopes M3-5), and does it route commands across our
boundary with real argv or run them internally (populates the containment label, and
outlives the terminal decision).

**M0-4 · Cancellation probe · S · needs M0-1**
Send `session/cancel` mid-turn to each harness. Record whether the turn ends promptly and
with what `stopReason`. Confirm the expectation that none accepts a second
`session/prompt` while a turn is in flight.
*Done when* the note states, per harness, the observed stop reason and the latency —
the TTL rung in M1c-1 is only as good as this.

**M0-5 · Usage reporting survey · S · needs M0-1**
Per harness: does `usage_update` arrive, and what do its fields mean? `{used, size}` is
context occupancy, not spend. Check specifically for cumulative or billable counts, and
for anything naming the model actually selected.
*Done when* the note distinguishes occupancy from spend per harness, and states plainly
whether a price table is possible at all (it is what unblocks the plan's first open item).

**M0-6 · Correct the safety claims · XS**
`CLAUDE.md` and `README.md:143` both say "even `--mode auto` cannot write outside the
workspace root". True of `fs/*` only; a shelling agent never touches `#guardPath`. The
policy does still fire on the `execute` tool call, but it judges an agent-authored title
string, not argv.
*Done when* both files state it positively: **`safe` blocks everything that crosses the
protocol, and nothing that doesn't.**

**M0-7 · Findings note · XS · needs M0-1,3,4,5**
`docs/M0-FINDINGS.md`. The input to D9's env list, M1a-4's containment labels, M1c-1's TTL
default and M3-5's terminal scope.

---

## M1a — Toolchain and protocol core

Ends with: today's behaviour, in TypeScript, typed, with the safety layers intact and
`npm run selftest` still green.

**M1a-1 · Toolchain · S**
Node 24 in `engines`. `tsconfig.json` with `strict`, `erasableSyntaxOnly`, `noEmit`.
`typescript` as the only devDependency. `npm run check` → `tsc --noEmit`;
`npm run test` → `node --test`.
*Done when* both scripts pass on an empty test set, and no build step exists. Note the
current runtime is v22.22.2 and already strips types (see `PLAN-GAPS.md` corrections), so
this is smaller than the plan implies.

**M1a-2 · `protocol/types.ts` · M · needs M1a-1**
Hand-written definitions for every message we touch. The `session/update` discriminated
union is the point of the exercise: `update.sessionUpdate` is currently a bare string
compared in two places (`acp.mjs:218`, `render.mjs:20`) with nothing keeping them in sync.
*Done when* adding a variant to the union makes `tsc` fail at every unhandled `switch`.

**M1a-3 · Port `acp.mjs` → `protocol/agent.ts` · M · needs M1a-2**
Essentially intact. Both invariants preserved verbatim: the `toolCallId → {title, kind,
rawInput}` map (`acp.mjs:218-228`) and `#guardPath` (`acp.mjs:235`). Single `onEvent`
callback becomes a typed emitter. Adds: per-request timeout on handshake and session
methods, `session/prompt` exempt (D12); registry-driven env mutation (D9).
*Done when* `npm run selftest` passes unchanged against `mock-agent`; a mock that accepts
the pipe and never answers `initialize` fails the task in ~30s instead of hanging; and
`node:test` covers `#guardPath` — in-root, escaping `../`, absolute-outside, symlink,
and the read/write asymmetry under `allowReadOutsideRoot`.

**M1a-4 · `protocol/registry.ts` · S · needs M1a-3, M0-7**
Today's `AGENTS` map plus `defaultMode`, `maxMode`, containment label
(`shell: "terminal" | "internal" | "unknown"`, from M0-3) and `env` (D9). Mode ordering is
the total order `safe < ask < auto`.
*Done when* `unknown` behaves as `internal` for warning purposes (N1), so an unverified
harness produces the conservative claim.

**M1a-5 · `core/policy.ts` · S · needs M1a-3**
Signature changes from `async () => boolean` to a form an external asynchronous decider can
answer, so M2's `ask` works with no TTY. `READ_ONLY_KINDS`, `safePolicy` and `autoPolicy`
semantics unchanged (`acp.mjs:9`, `:318-341`). `allowReadOutsideRoot` joins the resolved
policy and is forced `false` under `safe` (D8).
*Done when* a `node:test` truth table covers precedence `task > run > harness > safe`, the
`maxMode` ceiling raising a **validation error naming both values** rather than downgrading
silently, and `safe` overriding a requested `allowReadOutsideRoot: true`.

**M1a-6 · `core/events.ts` · S · needs M1a-2**
Typed bus carrying agent events plus supervisor events (task started, worktree created,
permission pending, stall warning, task finished, containment warning). `_client_` prefix
convention retained for client-originated events (`render.mjs:61-72`).
*Done when* every consumer — CLI render, and later persistence and SSE — subscribes, and
nothing reads agent state directly.

**M1a-7 · Port `render.mjs` and `run.mjs` · S · needs M1a-6**
`run.ts` keeps driving in-process, TTY `ask` intact.
*Done when* `npm run selftest` runs `run.ts` and passes (N5), and the containment warning
from M1a-4 surfaces as a one-line notice when starting `safe`/`ask` against a
`shell: "internal"` harness.

**M1a-8 · `core/ids.ts` · XS · needs M1a-1**
Run ids, task id validation, branch names (D1).
*Done when* an illegal task id is a validation error, not a sanitised one, and branch names
round-trip through `git check-ref-format`.

---

## M1b — Runs, worktrees, results

Ends with: a run file of N independent tasks, each in its own worktree, each returning a
parsed `TaskResult`.

**M1b-1 · `core/runfile.ts` · M · needs M1a-5, M1a-8**
Types plus a **runtime** validator — `satisfies Run` erases at runtime and therefore checks
nothing arriving over the wire. Schema: run-level defaults plus `tasks[]` (`id`, `agent`,
`prompt`, `mode`, `needs[]`, `worktree`, `allowReadOutsideRoot`), and `maxConcurrency`
(D10). All three entry paths — `.ts`/`.mjs` module, `.json` file, POST body — converge on
the one validator. Mode precedence and the harness ceiling resolve here, before any
subprocess starts. Non-empty `needs` is **rejected** with "task dependencies land in M3"
(D5).
*Done when* each import failure mode has its own error (import throws / no default export /
default is not an object); a `.ts` run file and its `.json` equivalent validate to the same
object; and **the CLI imports run files while the daemon never imports a path supplied over
the API** — importing is executing, and that boundary is the whole difference between a
convenience and an RCE hole.

**M1b-2 · `core/run.ts` · M · needs M1b-1**
Run owns N Tasks; Task owns one agent, one worktree, one policy, one result. Lifecycle
`pending → running → done | failed | timed_out | cancelled | skipped` (D4). `stopReason`
mapping (D2). Run roll-up is **duration and turn count** only — the units that mean the same
thing across vendors; token figures stay per task, tagged with the harness that produced
them, never summed. Concurrency pool honouring `maxConcurrency` (D10).
*Done when* `node:test` covers the stop-reason table and the roll-up ordering, and a
six-task run file with `maxConcurrency: 2` never has three live subprocesses.

**M1b-3 · `core/worktree.ts` · M · needs M1a-8**
`git worktree add` off a base ref into `.agent-team/wt/<runId>/<taskId>`. Preflight: repo
detection, dirty-tree refusal, base-ref resolution, and the `.agent-team/` git-ignore check
(D7) — append if absent, refuse if tracked. Retention: remove on success, **keep worktree
and branch on failure or timeout**; the branch always survives. **Transactional spawn** —
worktree creation, task registration and agent start all succeed or all roll back.
*Done when* a run leaves `git worktree list` clean after success and populated after
failure; and killing a task mid-spawn leaves no orphan worktree without a run record.

**M1b-4 · `core/result.ts` · M · needs M1b-2**
Prompt preamble requesting a `<task-result>` block with `<status>`, `<summary>`,
`<details>`, optional `<files>` and `<branch>`. Extraction: regex for the wrapper, then one
per field. Strictness — `null` if the wrapper is absent or if any of status/summary/details
is missing or empty after trimming; a missing *optional* field is `undefined`, not a
rejection. On `null`, one bounded re-ask turn, then synthesise and warn (D3). `TaskResult`
merges agent-reported fields with observed ones: `stopReason`, duration, turns, tokens,
permission count, `git status --porcelain`, `policyNeverFired`. Cross-check writes
`warnings[]`: `success` with an empty diff; `<files>` naming paths the diff lacks; a
non-empty diff with no block; plus `policyNeverFired`. Excludes `.agent-team/` from the
diff (D7). **Warnings publish on the bus and never fail the task** — a read-only stage
legitimately produces no diff, and making disagreement fatal would break the review stages
the pipeline is built on.
*Done when* `node:test` covers the strictness matrix field by field, and a fixture exists
per warning class.

**M1b-5 · Extend `mock-agent` · S · needs M1b-4**
Multiple sessions, a permission timeout, a malformed `<task-result>`, a missing block that
answers the re-ask on the second turn, and fixtures tripping each cross-check warning.
*Done when* every new client path is exercisable with nothing installed — the property that
keeps this project verifiable offline.

**M1b-6 · `hostile-agent` · S · needs M1a-3**
Path escape (`../../etc/passwd`, absolute paths, symlink), mutation without asking,
malformed JSON-RPC, oversized payload, a method we do not implement.
*Done when* each attempt is refused with a specific error and the run continues.

**M1b-7 · Per-task stderr capture · XS · needs M1b-3**
`.agent-team/runs/<id>/<taskId>.stderr.log`, unconditionally (N2). `--verbose` continues to
mirror it to the terminal.
*Done when* a harness that fails to start leaves a log containing its real error rather
than only `Internal error (code -32603)`.

**M1b-8 · Retire `fanout.mjs` · S · needs M1b-2**
Its job becomes "a run file with N independent tasks". Port `tasks.json` to the new schema
as an example.
*Done when* `npm run fanout` is gone from `package.json` and the README shows the run file
instead.

---

## M1c — Watchdog, merge, and the M1 bar

**M1c-1 · `core/watchdog.ts` · M · needs M1b-2, M0-4**
One interval timer over all running tasks (default 60s). Two signals, both chosen because
they port across vendors: **idle** — no events for `stallIdleMs`; and **repeat** — the same
tool title firing `stallRepeatCount` times consecutively (default ~8), the busy-loop case
idle time structurally cannot see. Repeat reuses the `toolCallId → {title, kind}` map
already maintained as a protocol invariant, so it needs only a per-task last-title and
count. Both signals warn and the task keeps running; the separate, longer `ttlMs` calls
`session/cancel`, preserves the branch, and marks the task `timed_out`. Every knob disabled
at `0`. Best-effort throughout — one task's failure must never halt the sweep.
*Done when* `node:test` covers the repeat counter's reset behaviour, and one task throwing
inside the sweep does not stop the others being checked. There is deliberately no third
rung: ACP gives no way to nudge a turn in flight, so detection reports rather than corrects.

**M1c-2 · `mock-agent` stall and repeat modes · XS · needs M1c-1**
Stall: accepts the prompt, emits nothing, never returns. Repeat: the same tool title on a
loop. One per watchdog signal.
*Done when* stall produces a warning then a cancel at TTL with the branch intact, and
repeat produces a warning and is **not** cancelled.

**M1c-3 · `core/merge.ts` — preflight and `--squash` · M · needs M1b-3**
`agent-team merge <runId>`, never automatic. Preflight refuses if the working tree has
modifications to any file a task branch touches, and refuses if two task branches in the
run touch the same file. All-or-nothing: preflight completely, then merge, so a run never
half-lands. `--squash` (default) leaves the combined changes **unstaged**, nothing
committed — right for a parallel split, where the branches are independent. `--rebase` is
M3-4 (D6).
*Done when* a two-task run lands as unstaged changes; the same merge with a conflicting
local edit aborts having changed nothing; and `node:test` covers overlap detection on
branch file sets.

**M1c-4 · `core/notify.ts` · S · needs M1a-6**
Attention signal for the two events a human needs while looking elsewhere: permission
pending, and stall warning. Terminal bell plus a distinct stderr line; optionally
`notify-send`/`osascript` when present, best-effort, never a dependency.
*Done when* the bus event exists independently of the terminal output — M4's toast
subscribes to the same one.

**M1c-5 · Package identity · XS**
Rename to `agent-team`, drop `private`, add the `bin` entry the plan's `agent-team merge`
assumes (N4). State supported platforms: macOS and Linux (N6).

**M1c-6 · M1 acceptance · S · needs all M1c**
A run file with three independent tasks against three real harnesses, each in its own
worktree, each returning a parsed `TaskResult`; `git worktree list` clean afterwards. Kill
the process mid-run, restart, confirm orphans are reaped. A `.ts` run file type-checks under
`npm run check` and validates to the same object as its `.json` twin. A run file exceeding a
harness `maxMode` is rejected, naming both values, before any subprocess starts.

---

## M2 — Daemon

**M2-1 · Daemon skeleton · M · needs M1c-6** — `node:http`, no framework. `POST /runs`,
`GET /runs`, `GET /runs/:id`, `DELETE /runs/:id` (cancel). Objects only over the wire; the
daemon never imports a path (M1b-1). *Done when* `core/` still runs headless under
`node --test` with no server booted — the split exists to stop orchestration logic living
in HTTP handlers.

**M2-2 · Event log and SSE replay · M · needs M2-1, D11** — `GET /runs/:id/events`, SSE with
replay-from-cursor. Append-only `events.jsonl`, monotonic per-run `seq` as cursor,
`Last-Event-ID` honoured, in-memory ring for hot replay, message chunks coalesced per
message rather than logged per token (G11). *Done when* `curl -N` attached mid-run receives
the history and then the live tail, contiguously.

**M2-3 · Permission over API · M · needs M2-1, M1a-5** — pending list, `GET /permissions`,
`POST /permissions/:id`, configurable timeout (default ~120s) → **deny**. First writer wins;
a second answer to a settled decision is a defined error, not a silent overwrite.
*Done when* a run submitted in `ask` mode with **no client attached** denies at timeout and
completes rather than hanging.

**M2-4 · Daemon lifecycle · S · needs M2-1** — pidfile, single-instance guard, live-child
registry, kill-all on shutdown, SIGTERM. *Done when* a daemon crash leaves no harness
subprocess holding write access.

**M2-5 · Crash-recovery sweep · M · needs M2-4, M1b-3** — on boot: mark `running` tasks
`errored`, kill or reap surviving registered PIDs, reconcile `git worktree list` against
persisted records, reap only worktrees whose run is terminal **and** past the retention
window (default 7 days). *Done when* `kill -9` then restart marks the task errored, reaps
no worktree still within retention, and leaves nothing alive.

**M2-6 · Persistence · S · needs M2-1** — JSON per run under `.agent-team/runs/<id>/`,
written on state transitions. For completed-run history, not live recovery: ACP has no
resume, so an interrupted session cannot be reattached. Single-process, single-writer —
which is why this is JSON and not SQLite.

**M2-7 · Config · S · needs M2-1** — `.agent-team/config.json`, `AGENT_TEAM_*` env override,
layered env > project. Home for the knobs that do not belong in a run file: watchdog
thresholds, TTL, retention window, port, permission timeout, `maxConcurrency` default.
*Done when* unknown keys and type mismatches are rejected loudly (N7) — a silently ignored
`stallIdleMs` typo is a watchdog that never fires.

**M2-8 · Auth · S · needs M2-1** — localhost-only bind plus a shared-secret token file. Not
optional: anything that can `POST /runs` with `mode: auto` executes commands as the user,
and once the dashboard can dispatch runs *every* write endpoint is an execution surface.
`EventSource` cannot set headers, so the token must also work as a query parameter on the
SSE endpoint or be exchangeable for a cookie — decided here so M4 is not blocked. Daemon
strips `AGENT_TEAM_*` from child environments (D9).

**M2-9 · `runs.ts` CLI · M · needs M2-2, M2-3** — submit a run file, stream SSE, answer
permissions interactively, print results. Two front ends, one core: `run` drives
in-process, `runs` talks to the daemon.

---

## M3 — Pipeline, DAG, terminals

**M3-1 · `core/scheduler.ts` · M · needs M1b-2** — topological execution: parallel where no
`needs`, sequential where there is. Lifts M1b-1's rejection (D5). Cycle detection is a
validation error. *Done when* `node:test` covers toposort, cycles, and dependent-skipping
on failure (D4).

**M3-2 · Worktree inheritance · M · needs M3-1, M1b-3** — **inherit if you are the only
successor; fork from the predecessor's branch otherwise**, because two tasks that both
`needs: [plan]` cannot share one checkout. *Done when* a diamond DAG produces two forked
worktrees and a linear chain produces one inherited.

**M3-3 · Handoff · S · needs M3-2** — predecessor's `TaskResult` injected into the
successor's prompt; assembly order and any templating decided here (N3). An unreported
predecessor is stated as unreported, never presented as its own words (D3).

**M3-4 · `merge --rebase` · S · needs M3-2, M1c-3** — lands task commits on the current
branch with stage boundaries and messages intact — right for a pipeline, where one inherited
worktree carries several stages' commits on a single branch and flattening discards which
stage did what. Shares M1c-3's preflight (D6).

**M3-5 · Terminals · L · needs M0-3 · conditional** — `terminal/create | output |
wait_for_exit | kill | release`, a Terminal class with a ring-buffered output cap, and
embedded-terminal rendering. **Only build for harnesses M0-3 showed actually call
`terminal/create`.** If M0 shows they all ignore the capability, this story becomes
documentation per harness instead — an honest label beats a boundary with holes in it.

**M3-6 · Command-level policy gating · M · needs M3-5 · conditional** — the payoff: with
`terminal/*` we hold the actual argv rather than an agent-authored title string, so policy
can judge the command. Exists only if M3-5 does.

**M3-7 · M3 acceptance · S** — a three-stage pipeline (opencode plans `safe` →
claude-agent-acp implements `auto` → copilot reviews `safe`) in one inherited worktree,
where stage B's prompt demonstrably contains stage A's summary and stage C flags anything B
got wrong.

---

## M4 — Dashboard

**M4-1 · Serving · M · needs M2-8** — string-templated HTML/CSS/JS out of the daemon. No
framework, no build step, no runtime dependency. Split across `dashboard-html`,
`-js-core`, `-js-events`, `-js-render` — that split is what keeps a zero-build dashboard
readable past a few hundred lines.

**M4-2 · Read views · L · needs M4-1, M2-2** — run list; per-run task cards with status,
elapsed, token count and a stall indicator; the DAG rendered from `needs`; a live event
timeline; the final `<task-result>` per task.

**M4-3 · Permission answering · M · needs M4-2, M2-3** — the one write path, and what makes
M4 a control surface rather than a viewer. *Done when* answering from the browser lets the
run proceed and a CLI observer on the same run sees the same decision.

**M4-4 · Toasts · S · needs M4-2** — subscribes to the same bus events `core/notify.ts` uses
(M1c-4).

---

## Critical path

```
M0-1 ─┬─ M0-3 ─┬─ M0-7 ─┬─ M1a-4 ┐
      ├─ M0-4 ─┤        │        │
      └─ M0-5 ─┘        │        │
                    D1–D13       │
                        │        │
  M1a-1 ─ M1a-2 ─ M1a-3 ┴─ M1a-5 ┴─ M1b-1 ─ M1b-2 ─ M1b-4 ─┐
                        └─ M1a-6 ─ M1a-7      M1b-3 ─┬──────┤
                                                     │      │
                                     M1c-1 ─ M1c-3 ──┴─ M1c-6
                                                          │
                              M2-1 ─┬─ M2-2 ─┬─ M2-9 ─────┤
                                    ├─ M2-3 ─┘            │
                                    └─ M2-4 ─ M2-5        │
                                                          │
                              M3-1 ─ M3-2 ─┬─ M3-3 ───────┤
                                           └─ M3-4        │
                              M3-5 (conditional on M0-3) ─┘
                                                          │
                              M4-1 ─ M4-2 ─ M4-3 ─────────┘
```

Three things are worth pulling forward because everything queues behind them:

1. **M0-3.** It is the only story whose outcome deletes another story (M3-5/M3-6) and it
   also sets the containment labels M1a-4 ships with.
2. **M1a-2.** Every later module types against it, and it is the story that earns the
   TypeScript decision.
3. **D1–D12.** Half a day of decisions gating three weeks of work.

M3-5 and M3-6 are the only stories in this document that may evaporate entirely. Plan M3's
capacity assuming they might.

---

## Backlog — named, not scheduled

- **Sandboxing (`bwrap` / `sandbox-exec`).** The only option that actually closes the shell
  gap rather than documenting it, and the only thing that bounds `auto` mode's blast
  radius — which is where the real risk lives, and which labelling does nothing for.
- **Per-harness price table.** Blocked on M0-5: nothing reports which model a harness
  selected, and a confidently wrong dollar figure is worse than none.
- **`stallRepeatCount` per-harness tuning.** A task re-running the same test command while
  iterating is a legitimate repeat; the default is deliberately generous and repeats only
  ever warn.
- **`session/load` where a harness advertises it** (N9) — recorded in M0-1, cheap later.
- **Composing and dispatching runs from the browser.** M5+. Named because it is the stated
  trajectory and the reason M2's API has to be complete rather than observability-only.
- **`#send` write backpressure** (N8).
- **Windows support** (N6) — declared unsupported at M1c-5.
