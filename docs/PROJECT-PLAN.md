# Multi-Harness Agent Supervisor — architecture plan

Companion to `PROJECT-BRIEF.md`. The brief says what we want; this says what we're
building and in what order. Draft — expect refinement.

> Reviewed against the code and sliced into stories in `STORIES.md`, which also records
> the gaps this document left open and how each is closed. Where the two disagree — M1 is
> split three ways, `--rebase` moves to M3, and `node:test` is used for pure functions
> (amended 2026-08-31 — plus behaviour whose subject is the wire) —
> the owning story carries the reasoning.

## Context

This plan was written when the project was a ~1,750-line ACP **client** (`protocol/agent.ts`, `protocol/registry.ts`, `run.mjs`, `fanout.mjs`). M1a, M1b and M1c have since ported it to TypeScript and added the supervisor-shaped pieces this plan called for: `cli.ts` and `core/run.ts` now execute N independent tasks from a JSON run file, each in its own worktree, returning parsed results and warnings. `PROJECT-BRIEF.md` describes a **supervisor**. The gap that remains is the daemon: worktrees, branches and stderr logs persist on disk, but no process owns a run record or crash recovery across invocations.

Intended outcome: a local daemon that executes a declarative run file — N harnesses in
isolated git worktrees, in parallel or as a dependency chain — enforcing one permission
policy across all of them and returning machine-readable results.

## Decisions

> Settled-vs-proposed status is tracked in `STORIES.md` with **`Decided <date>`** / **`Proposed`** markers. Here this table is the settled set; **Open, deliberately unresolved** (below) is the open set.

| Area | Decision |
| --- | --- |
| Workflows | Parallel split **and** pipeline handoff — not competing variants of the same task. |
| Process shape | Daemon, with `core/` that has no knowledge of HTTP or of a TTY. |
| UI | **M4**, after the daemon. Read views plus permission answering. Designed to grow into a run-dispatch front end, so the daemon API must be complete — not observability-only. |
| Result contract | A `<task-result>` block in the final message. `git status` cross-checks it; disagreement raises a task **warning**, never a failure. MCP `report_result` deferred. |
| Worktrees | Supervisor owns fully — creates off a base ref, removes on success, **keeps worktree and branch on failure/timeout when the task left work, and rolls back a failed task that produced nothing**, reaps orphans only when the run is terminal and past the retention window. |
| Merge-back | Explicit `kapelle merge <runId>`; never automatic. `--squash` (default) lands changes **unstaged**; `--rebase` preserves per-stage commits. Aborts wholesale on overlap. |
| Liveness | Per-task **stall → warn** (idle, or the same tool repeating) and **TTL → `session/cancel`**. Each disabled by setting `0`. **Measured (M0-4): cancellation works and is fast — every harness ended its turn within 64 ms and stopped emitting, and the session stayed usable, so the TTL rung needs a 2 s grace and no kill. But the stop reason cannot classify the outcome: copilot reports `end_turn` for a turn it cancelled, so the supervisor's own record of *did I cancel* is the authoritative half.** |
| Crash recovery | Startup sweep plus transactional spawn. A partially-created task leaves nothing behind. |
| Run definition | `.json` file or the daemon's POST body, both converging on one runtime validator. `.ts`/`.mjs` run files are deliberately not supported: importing executes code in-process. |
| Handoff | Same worktree, sequential. Successor sees predecessor's changes on disk plus its result summary in-prompt. |
| Mode naming | **`safe` keeps its name (decided 2026-08-23, #62 R1).** After M1a-5's negotiate-then-filter, `safe` is defence in depth with no enforcement guarantee — against opencode the filter never fires, and the one refusal measured arrived as agent prose. Renaming it to `restricted` was considered and rejected in favour of familiarity. The consequence is owned in M1a-5: the containment notice becomes **non-suppressible**, because it is then the only thing carrying the caveat. |
| Sandboxing | **Deferred, with an event trigger rather than a judgement (decided 2026-08-23, #62 R2): M2's daemon accepting `POST /runs`.** Until dispatch can come from somewhere other than the operator's own terminal, `auto` is a watched human act; after it, `auto` plus an API is remote code execution as a service. M1's worktree isolation, containment label and silent-autonomy warning bound **nothing** about the harness's own shell, and the docs say so. |
| Token accounting | **Captured in M1, rendered only where measured (decided 2026-08-23, #62 B3).** `PromptResponse.usage` is the only per-task count present on all three harnesses (M0-5) and the client used to discard it; M1a-3 now keeps the whole response. No figure reaches a result block until M1a-4 records the per-harness semantics — it is `UNSTABLE` in schema 0.28.1 and **cumulative on copilot where it is per-turn elsewhere**. |
| Registry staleness | **Every entry stamps `measuredOn: { version, date }` (decided 2026-08-23, #62 B2)**, compared at startup, **warning only, never fatal**. M0-7 measured three copilot behaviours changing in three days, so every label is a claim about a build. Entries with no `measuredOn` are unverified by that absence — which is also how `omp` and `gemini` stay in the registry (B5) without their guessed labels reading as measured. `pi` gained a measured half 2026-09-09 (pi-acp 0.0.33 / pi v0.85.1), including the finding that its ACP modes are thinking-effort levels rather than safety modes, so its registry entry omits `modeMap`. |
| Policy scope | Per task, with run default, harness default, and a harness **ceiling**. Precedence `task > run > harness > default`; exceeding the ceiling fails validation rather than downgrading silently. |
| Cost | Duration and turn count roll up per run. Token counts stay per task, labelled with their harness, never summed across vendors. |
| Containment honesty | The registry records whether each harness routes commands through `terminal/*` or runs them internally, **and separately whether we ever see the command text** (`argvChannel`). `safe` warns when it cannot actually contain. **Measured (M0-1, M0-3): all three run internally and none calls `terminal/*` even when offered; opencode never asks permission and never shows us a command, so the policy has no jurisdiction over it; claude-agent-acp and copilot do show real argv, on `session/update` notifications. All three accept `session/set_mode`, so modes are a second containment channel.** |
| Unattended `ask` | Pending decision published on the event stream; **timeout → deny**. |
| Silent autonomy | Detect and warn — flag runs with a non-empty diff and zero permission requests. **Required, not optional: M0-1 found this is opencode's default behaviour, not an anomaly.** |
| Terminals | ~~Spike first (M0).~~ **Settled by M0-3: not implemented.** With `terminal: true` advertised, no harness called `terminal/create` — all three used their own shell. M3-5 is cut to per-harness documentation, and `terminal: false` on master is now a recorded decision rather than a default. **Capability axis measured too, 2026-08-23 — parked.** M0-3's `87cbfe3` advertised `_meta.terminal_output: true`; claude-agent-acp's Bash `tool_call` then carried a `terminal_id` and `{type:"terminal"}` block for a terminal never created, with still no `terminal/*` calls, no command output, and no exit code (`M0-FINDINGS.md`). It is a rendering convention, not visibility — `argvChannel` gains no fourth value, and no follow-up is scheduled. |
| Protocol `_meta` | **Retained end-to-end, both directions (decided 2026-08-23).** `_meta` on the base of M1a-2's message types and carried through M1a-6's bus as part of the wire object; nothing consumes it yet. Answers the retro's B4 (#62). It is preservation rather than addition — `protocol/agent.ts` already forwards the whole update object — and the cost of deferring is not a refactor but runs whose event log never recorded it. The fleet's only exhaustion warning (`_meta["_claude/rateLimit"]`, M0-5), and the capability flags M0-3 found harnesses gating on (measured for `terminal_output` via `87cbfe3`) all live there. |
| Language | TypeScript on Node 24, run directly via type stripping — **no build step**. Four devDependencies — `typescript`, `@types/node`, `biome`, `knip` (amended 2026-08-31, M1a-1; the story's original *"only devDependency"* is history). **Zero runtime deps until M1c-7 (2026-09-09), which ratified a presentation-only exception and took `marked`** — see `README.md` for the rule. |
| Harness targets | opencode, claude-agent-acp, copilot — all three verified end-to-end, with **pi-acp a measured fourth since 2026-09-09 (#99)**, re-confirmed by M0-1 (`M0-FINDINGS.md`): opencode 1.18.18, claude-agent-acp 0.49.0, copilot 1.0.78, all completing a turn at protocol v1. |
| CLI | **One front end, one core (amended 2026-09-06, M2-9).** `kapelle run <file>` drives in-process; `--detach` hands the same file to the daemon; `kapelle attach <run-id>` streams a detached run. The original "two front ends, `run` and `runs`" is dropped: `runs` leaked the `POST /runs` path into a name people type, read as "many runs" when the difference is *local versus detached*, and a second CLI is a second place to keep the flags, notice rules and SIGINT grace in step. |

### Notes on some of these

**Why daemon over library.** Parallel split and pipeline are both long-running batch —
4 agents × 20 minutes, or a 3-stage handoff over an hour. Those want a process that
outlives the launching terminal. The thing the `core/` split guards against is not the
daemon but *orchestration logic living in HTTP handlers*: if `POST /runs` is where
worktree creation and stage sequencing happen, the scheduler becomes untestable without
booting a server, and the CLI drifts into a second implementation.

**Why TypeScript doesn't cost a build step any more.** Node 22.18+/24 strips type
annotations at load and executes `.ts` directly. Checking types still needs the
`typescript` package — but so does the JSDoc alternative, so the dependency cost is a
wash. Zero *runtime* dependencies, the property the brief calls a survival trait, was
preserved either way; M1c-7 later spent it once, under a written exception that
keeps every dependency downstream of the bus. The Node 24 `engines` bump is for LTS, not for the language feature.

**Why an XML tag rather than a fenced JSON block.** Agents that write code emit fenced
blocks constantly, so "the last fenced JSON block in the final message" is ambiguous
exactly when the task went well. A unique `<task-result>` wrapper has a near-zero
false-positive rate and survives being nested inside a fence, which the fence-scan
approach cannot.

**Why merge is a separate command.** A run produces branches; landing them is a distinct
act with its own failure mode. Automatic merge on success is fine for a single task and
actively bad for a parallel split — the first overlapping file leaves you reasoning about
half-landed state. Preflighting the whole run and then merging, or refusing, keeps the
outcome binary.

**Why run files are JSON, not code.** Run files are data, never modules: `.json` files and the daemon's POST body both arrive through `JSON.parse` and converge on the same runtime validator. `.ts`/`.mjs` run files were dropped because `await import()` executes the file in-process, where it can read `KAPELLE_*` and mutate shared policy state before the exported object is ever validated. Multi-line prompts survive as `\n` in JSON strings, and `satisfies Run`-style authoring survives in a generator script that emits JSON.

**Why the diff only warns.** A read-only stage legitimately produces no diff, so the diff
cannot be the primary contract without breaking the plan and review stages the pipeline is
built on. Making disagreement fatal would turn every harness quirk into a hard stop.
Warning is the posture `policyNeverFired` already takes: surface the discrepancy, let the
human judge.

## Target architecture

```text
front ends    cli.ts  kapelle run <file>            direct, in-process, TTY ask
                      kapelle run <file> --detach   submits to the daemon
                      kapelle attach <run-id>       streams SSE, answers permissions
                      kapelle merge ...
              dashboard (M4 — read views + permission answering; a third subscriber)
                   │
daemon.ts     POST /runs · GET /runs/:id · GET /runs/:id/events (SSE+replay)
              GET/POST /permissions/:id · pidfile · child registry · persistence
                   │
core/         run.ts        scheduler.ts     worktree.ts
              Run/Task/     DAG: parallel    git worktree add/prune,
              Result state  where no needs   inherit-or-fork, retention
              policy.ts     result.ts        events.ts
              per-task,     <task-result>    typed bus — SSE, CLI render
              async decider + git status     and persistence all subscribe
              watchdog.ts   merge.ts         notify.ts
              idle/repeat   squash | rebase  bell + bus event on
              → warn        or refuse        permission / stall
              TTL → cancel
                   │  one AcpAgent per task
protocol/     agent.ts (JSON-RPC/stdio, fs/* + #guardPath, permission)
              types.ts (session/update discriminated union) · registry.ts
                   │
              opencode acp │ claude-agent-acp │ copilot --acp
              — each harness authenticates itself; we never hold a key —
```

### Run flow

```text
cli.ts ──▶ import, validate ──▶ Run created, tasks in DAG order
           (mode precedence + harness ceiling resolved here)
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          task: plan      task: impl      task: review
          (needs: —)      (needs: plan)   (needs: impl)
          mode: safe      mode: auto      mode: safe
              │               │               │
      worktree created   INHERITS plan's  INHERITS impl's
      off base ref       worktree         worktree
              │               │               │
      session/update ─────────┴───────────────┴──▶ events.ts
              │
              ├─▶ policy.ts ──▶ safe: deny mutations
              │                 auto: allow
              │                 ask:  publish pending,
              │                       await POST, 120s → deny
              │
              └─▶ watchdog.ts ─▶ idle / repeated tool → stall warning (task runs on)
                                 TTL exceeded         → session/cancel,
                                                        branch preserved,
                                                        status timed_out
              │
      final message ──▶ result.ts ──▶ TaskResult {
                          status, summary, details,
                          files?, branch?                    ← <task-result>
                          stopReason, duration, turns, tokens,
                          permCount, gitDiff, policyNeverFired,
                          warnings[]                         ← observed
                        }
              │
      TaskResult injected into successor's prompt
              │
      run completes ──▶ persisted; worktrees removed on success,
                        kept on failure/timeout; branches always left

      ──— later, operator-initiated, outside the run —──
      kapelle merge <runId> ──▶ preflight all branches
                                ──▶ --squash: combined, unstaged (default)
                                ──▶ --rebase: stage commits preserved
                                ──▶ or refuse, having changed nothing
```

### Three architecture invariants this shape exists to protect

1. **One core, three consumers.** Daemon, CLI and dashboard are transport. `mock-agent`
   drives the core with no transport at all — that is what keeps everything verifiable
   offline.
2. **The event bus is the single source of truth.** Nothing reads agent state directly.
   The M4 dashboard becomes purely additive — a third subscriber.
3. **Two independent safety layers stay separate.** `#guardPath` is unconditional and
   covers every `fs/*` call; policy is about intent and varies per task. The daemon adds
   a third concern: the API is itself an execution surface. **M0-1 qualifies the first
   layer: no target harness ever calls `fs/*`** — all three read and write in-process — so
   `#guardPath` is live only against `mock-agent.mjs` today. Keep it (a harness may use
   `fs/*` tomorrow) but rest no containment claim on it.

Known gap, deliberately named: **anything an agent runs through its own shell bypasses
all three layers.** It never becomes an `fs/*` call, so `#guardPath` never sees it; and
whether it becomes a `session/request_permission` at all is the harness's choice, not ours.
Even when it does, what we get to judge is an agent-authored *title string*, never the argv.
M0 determines whether `terminal/*` closes this — a harness that honours it hands us the real
command. If M0 says the harnesses ignore it, the gap is permanent, and the answer is honest
labelling rather than a boundary with holes in it: the registry records which harnesses are
uncontainable, and `safe` says so out loud instead of overclaiming.

**M0-1 already widened this gap in one direction and narrowed it in another.** Wider:
opencode never sends `session/request_permission` at all, so against it the policy has no
jurisdiction — `safe` and `ask` are both inert, and it wrote a file under `safe` in the
probe. That is not a leaky boundary, it is no boundary, and honest labelling is the only
available answer. Narrower: copilot does hand us the real argv, in
`rawInput.command`/`commands[]` on the permission request, while still executing
internally — so for that harness we judge more than a title string even without
`terminal/*`. The two facts are independent and the registry needs to express both.

---

## M0 — Reconnaissance (~½ day, builds nothing)

Agenda item #1 in the brief. Costs almost nothing and de-risks every design choice after.

> **Status: M0 is complete.** Item 1 — M0-1. Items 2 and 7 — M0-2, which also retired the
> `claude-code` registry entry. Items 3 and 4 — M0-3. Item 5 — M0-4. Item 6 — M0-5. Item 8 —
> M0-6, corrected again by M0-7 after copilot changed behaviour between builds. The findings
> note is assembled and carries a per-harness roll-up at the top: `M0-FINDINGS.md`.
>
> **One story added after that completion, and resolved rather than scheduled: M0-8**, from the AgentPool review
> (`docs/PRIOR-ART-AGENTPOOL.md`). M0-3's `87cbfe3` had already advertised `_meta.terminal_output`;
> the result (`M0-FINDINGS.md`) recorded no visibility and no exit code, so the story
> closed as a docs reconciliation. **Parked, no backlog entry** — see the Terminals row above.

1. ~~Run today's MVP against real **opencode** and **claude-agent-acp**.~~ **Done, and
   widened to all three targets.** All spawn, all complete a turn at protocol v1, none
   sends a method we reject in `#handleRequest` (`protocol/agent.ts`). Unhandled
   `session/update` variants: `available_commands_update` (all three) and
   `config_option_update` (copilot). The two results that move the plan are that **all
   three advertise `loadSession: true`** and that **none of them calls `fs/*`**.
2. ~~**Copilot's ACP invocation — already verified, and the registry is wrong.**~~
   **Fixed by M0-2.** It is `copilot --acp` (a flag), not `copilot acp` (a subcommand) as
   `agents.mjs` guessed; `opencode acp` confirmed correct. The registry now says `--acp`,
   verified against Copilot 1.0.78 completing a turn; the old arg exits 1.
3. ~~**Terminal spike.**~~ **Done by M0-3** (`docs/M0-FINDINGS.md` §M0-3, branch
   `spike/m0-3-terminal`, kept unmerged). **No harness called `terminal/create`** with
   `terminal: true` advertised — opencode, claude-agent-acp and copilot all ran the tests
   through their own shell. Two corrections to this item as written: a "logging stub" is
   not a legal answer (`terminal/create` must return a `terminalId`, so the spike really
   executed), and the runnable set is the three installed harnesses — `omp`, `pi` and
   `gemini` are **unknown by absence, not by test**. **M3-5 is cut to documentation.**
4. ~~**Shell routing — the spike's second output.**~~ **Done by M0-3, and the binary was
   wrong.** All three execute internally, but the command text still reaches us for two of
   them — on ordinary `session/update` notifications, a channel this plan never considered.
   Hence two fields: `shell` (where it runs) and `argvChannel`
   (`terminal | notification | permission | none`). opencode shows us nothing and cannot be
   gated by argv at all; claude-agent-acp's argv arrives late, on `tool_call_update`.
   **M3-6 therefore survives without M3-5.**
5. ~~**Cancellation probe.**~~ **Done by M0-4, and the expectation was wrong**
   (`docs/M0-FINDINGS.md` §M0-4). Cancellation itself is the easy half: all three end the
   turn within 64 ms, emit nothing afterwards, and leave the session reusable — so the TTL
   rung gets a 2 s grace and never needs to kill. Two results this plan did not anticipate.
   **Copilot answers `end_turn` for a turn it cancelled**, contrary to ACP's MUST, so
   `stopReason` alone cannot classify an outcome and the supervisor must carry its own
   cancel intent. And **every harness accepts a second `session/prompt` mid-turn** — none
   rejects it, the in-flight turn dies, both requests answer `end_turn`, and on opencode and
   copilot the text lands in the running turn's context rather than being served
   (`github/copilot-cli#4555` reports the mechanism: `session/prompt` aborts the session
   unconditionally, even when idle). There is no safe way to nudge a turn in flight.
6. ~~**Usage reporting.**~~ **Answered by M0-5, and refocused on the context window**
   (`docs/M0-FINDINGS.md` §M0-5). `usage_update` arrives from all three and `used` is
   occupancy and a snapshot, as assumed — but **`size` is not a usable denominator**:
   claude-agent-acp reports 200k for the whole of a session's first turn whatever the real
   window, and copilot's 200000 matches neither its own 264k window nor the ~175k it leaves
   usable. Cadence differs too — **opencode sends one update per turn, at the end**, so it
   gives no in-turn context signal at all — and compaction is announced only in prose.
   **On "running out", the protocol has nothing**: no quota, credit or threshold field exists
   in ACP, and `max_tokens` / `max_turn_requests` never appeared. Only claude-agent-acp warns,
   through a vendor `_meta` extension (`_claude/rateLimit`, carrying `allowed_warning`,
   `utilization`, `credits_required`) that `render.mjs` drops today. **The threshold is the
   supervisor's to compute, per harness.** Secondary findings: `cost` is a cumulative USD
   total on opencode and claude-agent-acp (opencode's `0` was an unmetered provider, not a
   dead field), a per-turn token count exists on all three via the `UNSTABLE`
   `PromptResponse.usage`, and all three name the model they ran.
7. ~~Bake `env -u CLAUDECODE` into the `claude` registry entry.~~ **Done by M0-2**, with
   all three of `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT` and `CLAUDE_CODE_ENTRYPOINT` scrubbed
   as M0-1 ran them. The list lives in a registry `env` field already shaped
   `{unset?, set?}` so M1a-4 absorbs it rather than redoing it. Two notes for M1a-4: the
   negative control **did not reproduce** — claude-agent-acp 0.49.0 completed a turn with
   `CLAUDECODE=1` inherited, so the scrub is now insurance against a regression rather
   than a fix for a live failure, and the `-32603` in the docs is no longer reproducible
   on that version. And M0-2 **dropped the `claude-code` entry** (deprecated
   `@zed-industries/claude-code-acp`), so `claude` is the single Claude harness id.
8. Correct the safety claim in `CLAUDE.md` **and the README**: "even `--mode auto` cannot
   write outside it" is true of `fs/*` only. A shelling agent bypasses `#guardPath`
   entirely. The permission policy does still fire on the `execute` tool call — but it
   judges an agent-supplied *title string*, not the actual command line.
   **M0-1 makes this correction bigger than a reword.** The positive claim drafted here —
   "`safe` blocks everything that crosses the protocol, and nothing that doesn't" — is
   still an overclaim, because against opencode *nothing* crosses the protocol: no `fs/*`,
   no permission request, and a file written under `safe`. The honest statement is
   per-harness, and it belongs next to the registry's containment label rather than in a
   single sentence.

**Output:** the findings note, `M0-FINDINGS.md` — all four survey sections filled, opened
by a per-harness roll-up that answers the M0 exit criterion below in one table, and closed
by an explicit list of what it does not cover. No production code beyond items 2, 7 and 8.
Spike tooling lives on four unmerged `spike/*` branches, named per section in the note.

---

## M1 — Core, TypeScript, worktrees, results (CLI only)

Ends somewhere genuinely useful: N harnesses, isolated worktrees, structured results,
driven from a run file, fully verifiable offline.

### Toolchain

- Node 24 LTS; bump `engines`.
- `tsconfig.json` — `strict`, `erasableSyntaxOnly`, `noEmit`, `allowImportingTsExtensions`
  (ratified on #9: type stripping requires `.ts`-suffixed imports, and `tsc` accepts those
  under `noEmit` only with this flag). Add `typescript` devDep and
  `npm run check` → `tsc --noEmit`. Files run as `node daemon.ts`; no compile step.
- Port the five existing files. Mechanical, but do it *after* M0 findings land.

### Modules

- **`protocol/types.ts`** — the item that earns the TypeScript decision. Hand-written defs
  for every message we touch, especially the `session/update` discriminated union.
  `update.sessionUpdate` was a bare string compared in two places (`acp.mjs`,
  `render.mjs`) with nothing keeping them in sync.
- **`protocol/agent.ts`** — today's `AcpAgent` essentially intact. Preserve both existing
  invariants: the `toolCallId → {title, kind, rawInput}` map (`protocol/agent.ts`) and
  `#guardPath` (`protocol/agent.ts`). Type the single `onEvent` callback
  (`EventSink`, over an envelope wrapping the `AgentEvent` union) — **amended 2026-08-31**:
  a typed callback, not a multi-listener emitter, which stays M1a-6's job.
- **`protocol/registry.ts`** — today's `AGENTS` map, plus three fields per entry beyond
  `{command, args}`: `defaultMode`, `maxMode`, and a containment label
  (`shell: "terminal" | "internal" | "unknown"`, filled in from M0) plus
  `argvChannel: "terminal" | "notification" | "permission" | "none"` — M0-3 found the
  command text arrives on `session/update` notifications, not through `terminal/*`, so
  where a command runs and whether we can see it are two facts. Mode ordering is the
  total order `safe < ask < auto`. Resolution is `task > run > harness > default` (the
  default is `"ask"`), then the `maxMode` ceiling applies — and exceeding it is a **validation error
  naming both values**, never a silent downgrade. Starting a task in `safe` or `ask` against
  a `shell: "internal"` harness emits a one-line containment warning as a bus event, so the
  CLI and the M4 dashboard both surface it.
  **M0-1 fills in the labels, and shows one field is not enough.** All three targets are
  `shell: "internal"`, but they differ on something the label does not capture: whether the
  harness asks permission at all. opencode never does — so it needs a second field, e.g.
  `asksPermission: false`, and a warning with real teeth (policy has *no* effect, not
  reduced effect). claude-agent-acp asks on writes; copilot asks on both reads and writes,
  and supplies real argv when it does.
  **Modes are the second containment channel, and change what `safe` should do.** All three
  accept `session/set_mode` — including opencode, which advertises no `modes` and exposes
  its ids only through `configOptions` with `category: "mode"`. Negotiating `plan` before
  the prompt stopped opencode writing a file that the identical run without negotiation
  wrote. So **`safe` should negotiate, then filter**: set the harness's nearest restrictive
  mode at session start, and apply `READ_ONLY_KINDS` to whatever still arrives. That needs a
  per-harness mode map in the registry (`modeMap: { safe, ask, auto }`), because the
  vocabularies do not align — copilot uses the spec's mode URLs, claude-agent-acp bare
  vendor ids, opencode `build`/`plan`. Negotiation is defence in depth, not a sandbox: the
  one refusal we measured arrived as agent prose, so compliance and enforcement are not
  distinguishable from outside. Note the third-order consequence for copilot:
  it shells out to *explore* (`ls`, `find`), so those arrive as `execute` kind and `safe`
  refuses them, killing any task that has to look around — silently, as a clean `end_turn`.
  Reading a file whose path is already known goes through a native `read` tool on 1.0.80
  and `safe` allows it, so the harness is crippled rather than wholly unusable. **This is
  build-specific**: on 1.0.78 copilot shelled `cat` for reads too, and `safe` refused those
  as well (`M0-FINDINGS.md` §M0-1, "What re-verification changed"). Either way it is an
  argument for `defaultMode` being per harness, which this design already allows.
- **`core/policy.ts`** — small in lines, load-bearing. Change the policy signature from
  `async () => boolean` to a form answerable by an external, asynchronous decider, so `ask`
  can work with no TTY in M2. Keep `READ_ONLY_KINDS`, `safePolicy`, `autoPolicy` semantics
  exactly as they are (`core/policy.ts`).
- **`core/run.ts`** — the new center of gravity. Run owns N Tasks; Task owns one agent, one
  worktree, one policy, one result. Lifecycle `pending → running → done | failed |
  timed_out | cancelled`. The run's roll-up is **duration and turn count** — the only units
  that mean the same thing across vendors. Token figures are stored per task, verbatim,
  tagged with the harness that produced them, and never summed across harnesses.
- **`core/events.ts`** — typed bus. Agent events plus supervisor events (task started,
  worktree created, permission pending, stall warning, task finished). Keep the `_client_`
  prefix convention for client-originated events (`render.mjs`).
- **`core/worktree.ts`** — `git worktree add` off a base ref into
  `.kapelle/wt/<runId>/<taskId>`; preflight (repo detection, dirty-tree refusal, base-ref
  resolution). Retention: remove the worktree on success, **keep worktree and branch on
  failure/timeout when the task left work**, and roll back a task that produced nothing.
  **Transactional spawn** — worktree creation, task registration and agent start either all
  succeed or are all rolled back, so a failed spawn never leaves an orphan worktree with no
  run record.
- **`core/result.ts`** — prompt preamble requesting a `<task-result>` block containing
  `<status>`, `<summary>`, `<details>`, and optional `<files>` and `<branch>`. Extraction is
  a regex for the wrapper, then one per field. Strictness: return `null` if the wrapper is
  absent, or if any of status/summary/details is missing or empty after trimming; a missing
  *optional* field is `undefined`, not a rejection. `TaskRun` carries the agent-reported fields beside the observed ones the run records
  (`stopReason`, duration, tokens/usage semantics, `warnings[]`); permission count and the
  git tree are cross-check inputs, not stored on the result.
  **Cross-check** — compare the block against the diff and record any disagreement in
  `warnings[]` (five since M1c-6): status `success` with an empty diff; a changed path
  `<files>` never names; `<files>` naming paths the diff does not
  contain; a non-empty diff with no `<task-result>` at all; plus the existing
  `policyNeverFired`. `<files>` is our extension to ensemble's schema and exists precisely to
  make this check possible. Warnings publish on the bus and never fail the task.
- **`core/watchdog.ts`** — one interval timer over all running tasks (default 60s). Two
  signals, both chosen because they port across vendors: **idle**, no events for
  `stallIdleMs`; and **repeat**, the same tool title firing `stallRepeatCount` times
  consecutively (default ~8) — the busy-loop case idle time structurally cannot see. Repeat
  reuses the `toolCallId → {title, kind, rawInput}` map already maintained as a protocol invariant, so
  it needs only a per-task "last title + consecutive count". Both signals emit a warning and
  the task keeps running; the separate, longer `ttlMs` calls `session/cancel`, preserves the
  branch and marks the task `timed_out`. **M0-4 supplies the missing number: wait 2 s after
  the cancel before force-killing** — thirty times the slowest cancel measured, and the same
  grace `run.mjs` already uses — and expect never to reach it. `timed_out` is set from the
  watchdog's own record, not from the stop reason, which may come back `end_turn`. Every
  knob disabled at `0`. Best-effort throughout — one task's failure must never halt the
  sweep. Two notes: there is no third rung, because
  ACP gives us no way to nudge a turn in flight, so detection reports rather than corrects;
  and a token-based signal was considered and dropped, because `usage_update` reports context
  occupancy in units that are not comparable between vendors.
- **`core/merge.ts`** — `kapelle merge <runId> --squash`, reading the run record at
  `.kapelle/runs/<runId>/run.json`. Preflight refuses if any task is not `done`/`warned`,
  if the working tree has modifications to any file a task branch touches, or if two task
  branches in the run touch the same file. All-or-nothing: preflight completely, then
  merge, so a run never half-lands. `--squash` (default) leaves the combined changes
  **unstaged**, nothing committed — right for a parallel split, where the branches are
  independent. `--rebase` moves to M3-4.
- **`core/notify.ts`** — attention signal for the two events a human needs while looking
  elsewhere: permission pending, and stall warning. Terminal bell plus a distinct stderr
  line; optionally shell out to `notify-send`/`osascript` when present, best-effort, never a
  dependency. The bus event is the real product — M4's toast subscribes to the same one.
- **`core/runfile.ts`** — exports the `Run` / `Task` types *and* a runtime validator. Schema
  is run-level defaults plus `tasks[]` (`id`, `agent`, `prompt`, `mode`, `needs[]`,
  `worktree`). **Amended 2026-09-05 (STORIES M1b-1): run files are JSON only** — the
  `.ts`/`.mjs` loader described here is dropped, because `await import()` executes the file
  inside the supervisor process, where it reaches the shared policy state and the
  `KAPELLE_*` secret. `.json` files are `JSON.parse`. Both remaining
  entry paths — JSON file, POST body — converge on the one validator, because
  `satisfies Run` erases at runtime and therefore checks nothing that arrives over the wire.
  Validation is also where the mode precedence chain and the harness ceiling are resolved, so
  a bad run file fails before any subprocess starts. DAG *execution* is M3; M1 runs the
  independent-tasks case only.
- **CLIs** — `cli.ts` keeps driving in-process (fast, TTY `ask` works, no daemon needed),
  plus the new `merge` subcommand. Retire `fanout.mjs`: its job becomes "a run file with N
  independent tasks." The file was renamed `cli.ts` at M1c-5, alongside the `bin` that makes
  `kapelle` — not a filename — the thing people type.
- **Testing** — extend `mock-agent` with multiple sessions, a permission timeout, a
  malformed `<task-result>`, a **stall mode** (accepts the prompt, emits nothing, never
  returns), and a **repeat mode** (the same tool title on a loop) — one per watchdog signal.
  Add fixtures that trip each cross-check warning, and a run file that violates a `maxMode`
  ceiling and must be rejected before anything spawns. Add `hostile-agent`: path escape,
  mutation without asking, protocol violation. **Landed 2026-09-08 (#22)** as
  `hostile-agent.mjs` — `.mjs`, not the `.ts` this line first guessed, because it is the
  sibling of `mock-agent.mjs` and neither is imported by anything typed. One attack per
  `--scenario`, and no default: a hostile agent with no attack selected is a worse mock.

---

## M2 — Daemon

- `daemon.ts` on `node:http`, no framework. `POST /runs`, `GET /runs`, `GET /runs/:id`,
  `DELETE /runs/:id` (cancel).
- `GET /runs/:id/events` — SSE with replay-from-cursor, so a client attaching late still
  sees history.
- **Permission-over-API** — pending decision list, `GET /permissions`,
  `POST /permissions/:id`, configurable timeout (default ~120s) → **deny**. Never wedges
  an unattended run.
- **Lifecycle** — pidfile, single-instance guard, live-child registry, kill-all on
  shutdown, SIGTERM handling. A daemon crash must not leak harness subprocesses holding
  write access.
- **Crash-recovery sweep at startup** — the fuller version of "run `git worktree prune`".
  On boot: mark tasks left in `running` as `errored`, kill or reap any registered child PIDs
  that survived, reconcile `git worktree list` against persisted run records, and reap only
  those worktrees whose run is terminal *and* past the retention window (default 7 days).
- **Persistence** — JSON per run under `.kapelle/runs/<id>/`, written on state
  transitions. For completed-run history, not live recovery.
  **The stated reason was wrong and M0-1 corrected it:** "ACP has no resume" is true of
  the base protocol but false of every harness we target. All three advertise
  `agentCapabilities.loadSession: true`; opencode and claude-agent-acp additionally
  advertise `sessionCapabilities.resume` and `.fork`. So reattaching an interrupted session
  is *available*, and history-only persistence is now a scope choice rather than a
  protocol limit. Treat real resume as a separate follow-on: persist the harness session id
  alongside the run record here (cheap, and useless if skipped), and gate any
  `session/load` call on the capability, since the registry still contains harnesses that
  lack it.
- **Config** — `.kapelle/config.json` with `KAPELLE_*` env override, layered
  env > project. Exists because the new knobs (watchdog thresholds, TTL, retention window,
  port, permission timeout) need a home other than the run file.
- **Auth** — localhost-only bind plus a shared-secret token file. Not optional: anything
  that can `POST /runs` with `mode: auto` executes commands as the user, and once the
  dashboard can dispatch runs *every* write endpoint is an execution surface, not just
  `POST /runs`.
- **Browser-compatible auth** — `EventSource` cannot set custom headers. The token must be
  acceptable as a query parameter on the SSE endpoint, or exchangeable for a cookie by a
  login POST. Decided here so M4 is not blocked; the localhost-only bind is unchanged.
- `kapelle run <file> --detach` and `kapelle attach <run-id>` — submit a run file, stream
  SSE, answer permissions interactively, print results. **Amended 2026-09-06 (M2-9): no
  `runs.ts`.** Same deliverable, reached through a flag and a second verb on the one CLI
  rather than a second binary whose name differed by one letter.

---

## M3 — Pipeline, DAG, terminals

- **`core/scheduler.ts`** — topological execution: parallel where no `needs`, sequential
  where there is.
- **Handoff** — predecessor's `TaskResult` injected into the successor's prompt. Worktree
  inheritance rule: **inherit if you are the only successor; fork from the predecessor's
  branch otherwise** (two tasks that both `needs: [plan]` cannot share one checkout).
- ~~**Terminals**~~ — **cut by M0-3**: nothing calls `terminal/create`. What remains of the
  idea is the honest per-harness label. The original scope, kept for the record, was
  `terminal/create | output | wait_for_exit |
  kill | release`, a Terminal class with a ring-buffered output cap, embedded-terminal
  rendering, and command-level policy gating now that we hold the actual argv rather than
  an agent-supplied title string. If M0 shows the harnesses ignore the capability,
  document that per harness instead of building a boundary with holes in it.

---

## M4 — Dashboard

The first thing here that is not a CLI. Design reference: `opencode-ensemble`'s dashboard.

- **Serving** — string-templated HTML/CSS/JS out of the daemon. No framework, no build
  step, and no runtime dependency outside presentation — the exception M1c-7 ratified (2026-09-09, #78) — the same constraint the rest of the project holds. Split
  across four modules (`dashboard-html`, `-js-core`, `-js-events`, `-js-render`) — that
  split is what keeps a zero-build dashboard readable past a few hundred lines.
- **Read views** — run list; per-run task cards with status, elapsed, token count and a
  stall indicator; the DAG rendered from `needs`; a live event timeline; the final
  `<task-result>` per task.
- **One write path** — answer pending permission prompts. This is what makes `ask` mode
  usable unattended, and it is why M4 is a control surface rather than a viewer.
- **Toasts** — subscribe to the same bus events `core/notify.ts` uses.
- **Deferred to M5+** — composing and dispatching runs from the browser. Named here because
  it is the stated trajectory and it is why M2's API has to be complete rather than
  observability-only. Not built at M4.

---

## Verification

**Offline, every milestone** — `mock-agent` and `hostile-agent` own end-to-end and
adversarial coverage; `node:test` covers pure functions in `core/` and `protocol/`
(ratified #62 B1, 2026-08-23 — the earlier "no unit-test framework" rule predates the
plan's own Node 24 decision and is superseded), **and, per the 2026-08-31 amendment
(`docs/STORIES.md`, M1a-1), behaviour whose subject is the wire** — what does or does not
reach the subprocess, which a pure function cannot express.

```bash
npm run check                    # tsc --noEmit
npm run selftest                 # existing end-to-end, must keep passing
node cli.ts "self test" --cmd "node mock-agent.mjs" --mode safe   # write refused
node cli.ts "escape"    --cmd "node hostile-agent.mjs --scenario path-escape" --mode auto # path guard blocks
```

**M0** — findings note recording, per harness: does it start, does it complete a turn,
does it emit unhandled update variants, does it ever call `terminal/create`, does it route
commands through `terminal/*` or internally, does it emit `usage_update` and what do the
fields mean, and how does it respond to `session/cancel` mid-turn.

**M1** — a run file with one independent task per measured harness — **four since #99 added
pi-acp**, where this line was written when three existed — each in
its own worktree, each returning a parsed `TaskResult`; `git worktree list` clean
afterwards. **Amended 2026-09-10 (M1c-6, #30): the reap is not M1's.** `kill -9` mid-run
leaves the worktree and the branch behind and a restart does not clear them (observed
2026-09-10); the sweep that would is M2-5, which needs a record written on state
transitions (M2-6). The `run.json` M1c-3's merge reads is written once, after every task
finishes (`core/run.ts:454`), so a crash mid-run leaves none. M1 leaves the surviving state
in place; the M1c-6 story documents what survives instead of reaping it.
A task against `mock-agent`'s stall mode produces a stall warning, then a `session/cancel`
at TTL, with the branch intact afterwards; repeat mode raises a warning and is *not*
cancelled. A JSON run file validates through `core/runfile.ts`, and the same run as a POST
body validates to the same object. A run file that exceeds a harness `maxMode` is rejected,
naming both values, before any subprocess starts.
`kapelle merge` on a two-task run lands both as unstaged changes; the same merge with a
conflicting local edit aborts having changed nothing; a run with an unfinished task is
refused. Kill a task mid-spawn and confirm no orphan worktree survives *with no run
record* — a worktree whose run record exists is kept on purpose, and reaping it is M2-5.

**M2** — start the daemon, `POST /runs` in `ask` mode with **no client attached**, confirm
the mutation is denied at timeout and the run completes rather than hanging. Attach
`curl -N` to the SSE endpoint mid-run and confirm replay-from-cursor delivers the history.
`kill -9` the daemon, restart, and confirm the sweep marks the task errored, reaps no
worktree still within retention, and leaves no harness subprocess alive.

**M3** — a three-stage pipeline (opencode plans `safe` → claude-agent-acp implements
`auto` → copilot reviews `safe`) in one inherited worktree, where stage B's prompt
demonstrably contains stage A's summary and stage C flags anything B got wrong.

**M4** — attach the dashboard to a run in `ask` mode, answer a permission from the browser,
and confirm the run proceeds and a CLI observer on the same run sees the same decision.

---

## Open, deliberately unresolved

The actionable form of these — with triggers and decisions — is `docs/STORIES.md`'s backlog; this section keeps the narrative of *why* each is still open.

- ~~A per-harness price table converting tokens to estimated spend.~~ **Unblocked and
  reshaped by M0-5.** All three harnesses name the model they selected (`configOptions`,
  `category: "model"`, on the `session/new` response), so the blocker is gone — but the
  table is no longer the cheapest route to a number: opencode and claude-agent-acp report
  cumulative USD themselves, and copilot cannot be priced in currency at all, since it
  meters premium requests (`_meta.copilotUsage`: `"1x"`, `"15x"`, `"0.33x"`) rather than
  tokens. The work that remains is recording each harness's self-reported unit, not
  converting tokens for all three. **Decided 2026-08-22: nice-to-have, not scheduled** — it
  would mostly add a second, worse number next to the one two harnesses already report. See
  the backlog entry.
- **Whether a context-occupancy signal can be trusted enough to act on.** M0-5 answers "not
  on `size`": the denominator is wrong on copilot and late on claude, and opencode reports
  only at end of turn. Left open because the remedy — per-harness trust flags, or asking each
  harness for its own accounting — is real work that no story needs yet. M1c-1's watchdog
  deliberately carries no context rung in the meantime.
- **A pluggable backend under the `fs/*` handlers — considered and refused, 2026-08-23.**
  AgentPool routes every client-served file operation through a swappable execution
  environment (local, docker, an E2B sandbox), and `docs/PRIOR-ART-AGENTPOOL.md` initially
  recommended taking the seam. It reversed itself against M0-1: **no harness calls `fs/*` at
  all**, so the indirection would sit beneath handlers nothing reaches. `#guardPath` stays as
  insurance; nothing is built under it until something calls `fs/*`. Recorded here so the
  idea is not rediscovered as new. Note it never addressed the real gap either — their
  sandbox contains only what the *client* serves, and the harness process itself is spawned
  plainly, exactly as ours is.
- Whether `stallRepeatCount` needs per-harness tuning or one default holds. A task that
  re-runs the same test command while iterating is a legitimate repeat; the default is
  deliberately generous, and repeats only ever warn.
- **Sandboxing (`bwrap` / `sandbox-exec`) as a later milestone.** Considered this round and
  deferred in favour of honest labelling. Recorded because it is the only option that
  actually closes the shell gap rather than documenting it, and because it would also bound
  `auto` mode's blast radius — which is where the real risk lives, and which labelling does
  nothing for.

---

## Prior art: what we took from `opencode-ensemble`, and what we didn't

[hueyexe/opencode-ensemble](https://github.com/hueyexe/opencode-ensemble) solves a similar
problem on the other side of the harness boundary — it is a plugin *inside* opencode, with
an LLM ("the lead") as orchestrator. We are a supervisor *outside* every harness, with code
as orchestrator. None of its code transfers; several of its failure modes do.

**Taken:** the explicit merge command with overlap-blocking preflight; two-signal stall
detection; preserving the branch before aborting on timeout; the startup crash-recovery
sweep and transactional spawn; the `<task-result>` contract and its strictness rule; the
notify-on-attention-needed event; and the four-file split for a zero-build dashboard.

**Not taken, deliberately:**

- **SQLite for state.** Ensemble needs it for concurrent plugin writers. Our daemon is
  single-process and single-writer; JSON per run stays, and the runtime-dependency rule
  of the day with it (presentation-only since M1c-7).
- **Peer messaging** (`team_message` / `team_broadcast`). `PROJECT-BRIEF.md` names A2A
  messaging as a non-goal. Ensemble's coordination model *is* inter-agent chat; ours is
  DAG plus handoff.
- **Team state injected into the system prompt.** Not available over ACP — we control the
  prompt text, not the harness's system prompt.
- **The lead-agent orchestrator.** Theirs is an LLM, ours is code. That buys them emergent
  coordination and buys us determinism and auditability. It is the load-bearing difference
  between the two projects.
- **Rate limiting.** Harnesses own their own auth and their own backoff.
