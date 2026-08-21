# Multi-Harness Agent Supervisor — architecture plan

Companion to `PROJECT-BRIEF.md`. The brief says what we want; this says what we're
building and in what order. Draft — expect refinement.

> Reviewed against the code and sliced into stories in `STORIES.md`, which also records
> the gaps this document left open and how each is closed. Where the two disagree — M1 is
> split three ways, `--rebase` moves to M3, and `node:test` is used for pure functions —
> the owning story carries the reasoning.

## Context

`agent-team` is today a 770-line ACP **client** (`acp.mjs`, `agents.mjs`, `render.mjs`,
`run.mjs`, `fanout.mjs`). `PROJECT-BRIEF.md` describes a **supervisor**. The gap between
those two words is this plan.

Concretely: `run.mjs` and `fanout.mjs` each construct an `AcpAgent`, drive one turn, and
print. There is no task, no run, no result, and no state that outlives the process. Every
deferred P1 item (monitoring UI, graph topology) and most of the P0 open questions
(worktree lifecycle, structured results, cost tracking) are blocked on the same missing
thing: a supervisor core that owns run state.

Intended outcome: a local daemon that executes a declarative run file — N harnesses in
isolated git worktrees, in parallel or as a dependency chain — enforcing one permission
policy across all of them and returning machine-readable results.

## Decisions

| Area | Decision |
|---|---|
| Workflows | Parallel split **and** pipeline handoff. Not bakeoff. |
| Process shape | Daemon, with `core/` that has no knowledge of HTTP or of a TTY. |
| UI | **M4**, after the daemon. Read views plus permission answering. Designed to grow into a run-dispatch front end, so the daemon API must be complete — not observability-only. |
| Result contract | A `<task-result>` block in the final message. `git status` cross-checks it; disagreement raises a task **warning**, never a failure. MCP `report_result` deferred. |
| Worktrees | Supervisor owns fully — creates off a base ref, removes on success, **keeps worktree and branch on failure or timeout**, reaps orphans only when the run is terminal and past the retention window. |
| Merge-back | Explicit `agent-team merge <runId>`; never automatic. `--squash` (default) lands changes **unstaged**; `--rebase` preserves per-stage commits. Aborts wholesale on overlap. |
| Liveness | Per-task **stall → warn** (idle, or the same tool repeating) and **TTL → `session/cancel`**. Each disabled by setting `0`. |
| Crash recovery | Startup sweep plus transactional spawn. A partially-created task leaves nothing behind. |
| Run definition | A `.ts` module default-exporting the run object; `.json` also accepted; the daemon's POST body is the same shape. One validator behind all three. |
| Handoff | Same worktree, sequential. Successor sees predecessor's changes on disk plus its result summary in-prompt. |
| Policy scope | Per task, with run default, harness default, and a harness **ceiling**. Precedence `task > run > harness > safe`; exceeding the ceiling fails validation rather than downgrading silently. |
| Cost | Duration and turn count roll up per run. Token counts stay per task, labelled with their harness, never summed across vendors. |
| Containment honesty | The registry records whether each harness routes commands through `terminal/*` or runs them internally. `safe` warns when it cannot actually contain. **Measured (M0-1): all three run internally; opencode never asks permission, so the policy has no jurisdiction over it — but all three accept `session/set_mode`, so modes are a second containment channel.** |
| Unattended `ask` | Pending decision published on the event stream; **timeout → deny**. |
| Silent autonomy | Detect and warn — flag runs with a non-empty diff and zero permission requests. **Required, not optional: M0-1 found this is opencode's default behaviour, not an anomaly.** |
| Terminals | Spike first (M0). Implement only for harnesses that actually call `terminal/create`. **M0-1 baseline: none does under `terminal: false`** — M0-3 tests whether flipping it changes that. |
| Language | TypeScript on Node 24, run directly via type stripping — **no build step**. `typescript` as the only devDependency; zero runtime deps preserved. |
| Harness targets | opencode, claude-agent-acp, copilot — all three verified end-to-end, re-confirmed by M0-1 (`M0-FINDINGS.md`): opencode 1.18.18, claude-agent-acp 0.49.0, copilot 1.0.78, all completing a turn at protocol v1. |
| CLI | Two front ends, one core: `run` drives in-process, `runs` talks to the daemon. |

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
wash. Zero *runtime* dependencies, the property the brief calls a survival trait, is
preserved either way. Current runtime is Node v22.22.2, which already strips types at
load — so `.ts` runs today. The Node 24 bump is for LTS, not for the language feature.

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

**Why the run file is code.** Node executes `.ts` directly, so a module costs no parser at
all, while YAML would cost either a runtime dependency — against the brief's zero-deps
survival trait — or ~150 lines of subset parser that becomes a permanent bug surface.
Template literals matter more than they sound: prompts are multi-line prose and they are
most of what a run file contains. `satisfies Run` gets the file type-checked by
`tsc --noEmit` before it ever runs. **One rule this makes non-negotiable:** the *CLI*
imports run files; the *daemon* never imports a path supplied over the API — it accepts
objects only. Importing is executing, and that boundary is the whole difference between a
convenience and a remote-code-execution hole.

**Why the diff only warns.** A read-only stage legitimately produces no diff, so the diff
cannot be the primary contract without breaking the plan and review stages the pipeline is
built on. Making disagreement fatal would turn every harness quirk into a hard stop.
Warning is the posture `policyNeverFired` already takes: surface the discrepancy, let the
human judge.

## Target architecture

```
front ends    run.ts  (direct, in-process, TTY ask)
              runs.ts (submits run file, streams SSE, answers permissions)
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

```
run.ts ──▶ import, validate ──▶ Run created, tasks in DAG order
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
      agent-team merge <runId> ──▶ preflight all branches
                                   ──▶ --squash: combined, unstaged (default)
                                   ──▶ --rebase: stage commits preserved
                                   ──▶ or refuse, having changed nothing
```

### Three invariants this shape exists to protect

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

> **Status:** item 1 is done — see `M0-FINDINGS.md`. Items 2 and 7 are done — M0-2, which
> also retired the `claude-code` registry entry. Items 3-6 and 8 are still open, and 3/5/6
> now start from the baseline that survey recorded rather than from nothing.

1. ~~Run today's MVP against real **opencode** and **claude-agent-acp**.~~ **Done, and
   widened to all three targets.** All spawn, all complete a turn at protocol v1, none
   sends a method we reject in `#handleRequest` (`acp.mjs:205`). Unhandled
   `session/update` variants: `available_commands_update` (all three) and
   `config_option_update` (copilot). The two results that move the plan are that **all
   three advertise `loadSession: true`** and that **none of them calls `fs/*`**.
2. ~~**Copilot's ACP invocation — already verified, and the registry is wrong.**~~
   **Fixed by M0-2.** It is `copilot --acp` (a flag), not `copilot acp` (a subcommand) as
   `agents.mjs` guessed; `opencode acp` confirmed correct. The registry now says `--acp`,
   verified against Copilot 1.0.78 completing a turn; the old arg exits 1.
3. **Terminal spike:** flip `clientCapabilities.terminal` to `true` (`acp.mjs:82`), add a
   logging stub for `terminal/*` in `#handleRequest`, run all three harnesses on a task
   that obviously needs a shell (`run the tests`) in a throwaway workspace under
   `--mode auto`. Record per harness whether `terminal/create` ever arrives.
   **This decides M3's terminal scope.** Note: it must be `auto`, because under `safe`
   the `execute` permission is denied before any terminal call would be made.
4. **Shell routing — the spike's second output.** For each harness, conclude one of
   `terminal` (commands cross our boundary, with real argv) or `internal` (they don't, and
   nothing we do can see them). This populates the registry's containment label and decides
   what `safe` is allowed to claim. Same experiment as item 3; it just needs recording
   separately, because it outlives the terminal decision.
5. **Cancellation probe.** Confirm the expected result — that no harness accepts a second
   `session/prompt` while a turn is in flight — and record what each one does with
   `session/cancel` mid-turn: does the turn end promptly, and with what `stopReason`?
   M1's TTL rung is only as good as this answer.
6. **Usage reporting.** Record, per harness, whether `usage_update` arrives at all and what
   its fields actually mean. `{used, size}` is context occupancy, not spend — check whether
   anything reports cumulative or billable counts, or names the model it selected. This is
   what the cost decision rests on, and today it is an assumption.
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

**Output:** a short findings note — `M0-FINDINGS.md`, M0-1 section filled, 3/4/5 stubbed.
No production code beyond items 2, 7 and 8.

---

## M1 — Core, TypeScript, worktrees, results (CLI only)

Ends somewhere genuinely useful: N harnesses, isolated worktrees, structured results,
driven from a run file, fully verifiable offline.

**Toolchain**
- Node 24 LTS; bump `engines`.
- `tsconfig.json` — `strict`, `erasableSyntaxOnly`, `noEmit`. Add `typescript` devDep and
  `npm run check` → `tsc --noEmit`. Files run as `node daemon.ts`; no compile step.
- Port the five existing files. Mechanical, but do it *after* M0 findings land.

**Modules**
- **`protocol/types.ts`** — the item that earns the TypeScript decision. Hand-written defs
  for every message we touch, especially the `session/update` discriminated union.
  `update.sessionUpdate` is currently a bare string compared in two places (`acp.mjs:218`,
  `render.mjs:20`) with nothing keeping them in sync.
- **`protocol/agent.ts`** — today's `AcpAgent` essentially intact. Preserve both existing
  invariants: the `toolCallId → {title, kind, rawInput}` map (`acp.mjs:218-228`) and
  `#guardPath` (`acp.mjs:235`). Replace the single `onEvent` callback with a typed emitter.
- **`protocol/registry.ts`** — today's `AGENTS` map, plus three fields per entry beyond
  `{command, args}`: `defaultMode`, `maxMode`, and a containment label
  (`shell: "terminal" | "internal" | "unknown"`, filled in from M0). Mode ordering is the
  total order `safe < ask < auto`. Resolution is `task ?? run ?? harness.defaultMode ??
  "safe"`, then the `maxMode` ceiling applies — and exceeding it is a **validation error
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
  because it reads by shelling out, its reads are `execute` kind, so `safe` refuses them
  and the harness becomes unusable rather than cautious — an argument for `defaultMode`
  being per harness, which this design already allows.
- **`core/policy.ts`** — small in lines, load-bearing. Change the policy signature from
  `async () => boolean` to a form answerable by an external, asynchronous decider, so `ask`
  can work with no TTY in M2. Keep `READ_ONLY_KINDS`, `safePolicy`, `autoPolicy` semantics
  exactly as they are (`acp.mjs:9`, `:318-341`).
- **`core/run.ts`** — the new center of gravity. Run owns N Tasks; Task owns one agent, one
  worktree, one policy, one result. Lifecycle `pending → running → done | failed |
  timed_out | cancelled`. The run's roll-up is **duration and turn count** — the only units
  that mean the same thing across vendors. Token figures are stored per task, verbatim,
  tagged with the harness that produced them, and never summed across harnesses.
- **`core/events.ts`** — typed bus. Agent events plus supervisor events (task started,
  worktree created, permission pending, stall warning, task finished). Keep the `_client_`
  prefix convention for client-originated events (`render.mjs:61-72`).
- **`core/worktree.ts`** — `git worktree add` off a base ref into
  `.agent-team/wt/<runId>/<taskId>`; preflight (repo detection, dirty-tree refusal, base-ref
  resolution). Retention: remove the worktree on success, **keep worktree and branch on
  failure or timeout** so partial work stays inspectable; the branch always survives.
  **Transactional spawn** — worktree creation, task registration and agent start either all
  succeed or are all rolled back, so a failed spawn never leaves an orphan worktree with no
  run record.
- **`core/result.ts`** — prompt preamble requesting a `<task-result>` block containing
  `<status>`, `<summary>`, `<details>`, and optional `<files>` and `<branch>`. Extraction is
  a regex for the wrapper, then one per field. Strictness: return `null` if the wrapper is
  absent, or if any of status/summary/details is missing or empty after trimming; a missing
  *optional* field is `undefined`, not a rejection. `TaskResult` merges these agent-reported
  fields with supervisor-observed ones (`stopReason`, duration, turns, tokens from
  `usage_update`, permission count, `git status --porcelain`, `policyNeverFired`).
  **Cross-check** — compare the block against the diff and record any disagreement in
  `warnings[]`: status `success` with an empty diff; `<files>` naming paths the diff does not
  contain; a non-empty diff with no `<task-result>` at all; plus the existing
  `policyNeverFired`. `<files>` is our extension to ensemble's schema and exists precisely to
  make this check possible. Warnings publish on the bus and never fail the task.
- **`core/watchdog.ts`** — one interval timer over all running tasks (default 60s). Two
  signals, both chosen because they port across vendors: **idle**, no events for
  `stallIdleMs`; and **repeat**, the same tool title firing `stallRepeatCount` times
  consecutively (default ~8) — the busy-loop case idle time structurally cannot see. Repeat
  reuses the `toolCallId → {title, kind}` map already maintained as a protocol invariant, so
  it needs only a per-task "last title + consecutive count". Both signals emit a warning and
  the task keeps running; the separate, longer `ttlMs` calls `session/cancel`, preserves the
  branch and marks the task `timed_out`. Every knob disabled at `0`. Best-effort throughout —
  one task's failure must never halt the sweep. Two notes: there is no third rung, because
  ACP gives us no way to nudge a turn in flight, so detection reports rather than corrects;
  and a token-based signal was considered and dropped, because `usage_update` reports context
  occupancy in units that are not comparable between vendors.
- **`core/merge.ts`** — `agent-team merge <runId> [--squash|--rebase]`. Preflight refuses if
  the working tree has modifications to any file a task branch touches, and refuses if two
  task branches in the run touch the same file. All-or-nothing: preflight completely, then
  merge, so a run never half-lands. The two modes share that preflight and differ in what
  lands. `--squash` (default) leaves the combined changes **unstaged**, nothing committed —
  right for a parallel split, where the branches are independent. `--rebase` lands the task
  commits on the current branch with their stage boundaries and messages intact — right for
  a pipeline, where one inherited worktree carries several stages' commits on a single
  branch and flattening them discards which stage did what.
- **`core/notify.ts`** — attention signal for the two events a human needs while looking
  elsewhere: permission pending, and stall warning. Terminal bell plus a distinct stderr
  line; optionally shell out to `notify-send`/`osascript` when present, best-effort, never a
  dependency. The bus event is the real product — M4's toast subscribes to the same one.
- **`core/runfile.ts`** — exports the `Run` / `Task` types *and* a runtime validator. Schema
  is run-level defaults plus `tasks[]` (`id`, `agent`, `prompt`, `mode`, `needs[]`,
  `worktree`). Loading a `.ts`/`.mjs` run file is `await import(pathToFileURL(abs))` then
  `.default`, with real errors for each way that fails: the import throws, there is no
  default export, the default is not an object. `.json` files are `JSON.parse`. All three
  entry paths — module, JSON file, POST body — converge on the one validator, because
  `satisfies Run` erases at runtime and therefore checks nothing that arrives over the wire.
  Validation is also where the mode precedence chain and the harness ceiling are resolved, so
  a bad run file fails before any subprocess starts. DAG *execution* is M3; M1 runs the
  independent-tasks case only.
- **CLIs** — `run.ts` keeps driving in-process (fast, TTY `ask` works, no daemon needed),
  plus the new `merge` subcommand. Retire `fanout.mjs`: its job becomes "a run file with N
  independent tasks."
- **Testing** — extend `mock-agent` with multiple sessions, a permission timeout, a
  malformed `<task-result>`, a **stall mode** (accepts the prompt, emits nothing, never
  returns), and a **repeat mode** (the same tool title on a loop) — one per watchdog signal.
  Add fixtures that trip each cross-check warning, and a run file that violates a `maxMode`
  ceiling and must be rejected before anything spawns. Add `hostile-agent`: path escape,
  mutation without asking, protocol violation.

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
- **Persistence** — JSON per run under `.agent-team/runs/<id>/`, written on state
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
- **Config** — `.agent-team/config.json` with `AGENT_TEAM_*` env override, layered
  env > project. Exists because the new knobs (watchdog thresholds, TTL, retention window,
  port, permission timeout) need a home other than the run file.
- **Auth** — localhost-only bind plus a shared-secret token file. Not optional: anything
  that can `POST /runs` with `mode: auto` executes commands as the user, and once the
  dashboard can dispatch runs *every* write endpoint is an execution surface, not just
  `POST /runs`.
- **Browser-compatible auth** — `EventSource` cannot set custom headers. The token must be
  acceptable as a query parameter on the SSE endpoint, or exchangeable for a cookie by a
  login POST. Decided here so M4 is not blocked; the localhost-only bind is unchanged.
- `runs.ts` CLI — submit a run file, stream SSE, answer permissions interactively, print
  results.

---

## M3 — Pipeline, DAG, terminals

- **`core/scheduler.ts`** — topological execution: parallel where no `needs`, sequential
  where there is.
- **Handoff** — predecessor's `TaskResult` injected into the successor's prompt. Worktree
  inheritance rule: **inherit if you are the only successor; fork from the predecessor's
  branch otherwise** (two tasks that both `needs: [plan]` cannot share one checkout).
- **Terminals**, scoped by M0's findings: `terminal/create | output | wait_for_exit |
  kill | release`, a Terminal class with a ring-buffered output cap, embedded-terminal
  rendering, and command-level policy gating now that we hold the actual argv rather than
  an agent-supplied title string. If M0 shows the harnesses ignore the capability,
  document that per harness instead of building a boundary with holes in it.

---

## M4 — Dashboard

The first thing here that is not a CLI. Design reference: `opencode-ensemble`'s dashboard.

- **Serving** — string-templated HTML/CSS/JS out of the daemon. No framework, no build
  step, no runtime dependency; the same constraint the rest of the project holds. Split
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

**Offline, every milestone** — `mock-agent` and `hostile-agent` are the test suite; there
is no unit-test framework and this plan does not add one.

```bash
npm run check                    # tsc --noEmit
npm run selftest                 # existing end-to-end, must keep passing
node run.ts "self test" --cmd "node mock-agent.ts" --mode safe   # write refused
node run.ts "escape"    --cmd "node hostile-agent.ts" --mode auto # path guard blocks
```

**M0** — findings note recording, per harness: does it start, does it complete a turn,
does it emit unhandled update variants, does it ever call `terminal/create`, does it route
commands through `terminal/*` or internally, does it emit `usage_update` and what do the
fields mean, and how does it respond to `session/cancel` mid-turn.

**M1** — a run file with three independent tasks against three real harnesses, each in
its own worktree, each returning a parsed `TaskResult`; `git worktree list` clean
afterwards. Then kill the process mid-run and confirm the orphans are reaped at next start.
A task against `mock-agent`'s stall mode produces a stall warning, then a `session/cancel`
at TTL, with the branch intact afterwards; repeat mode raises a warning and is *not*
cancelled. A run file authored as a `.ts` module type-checks under `npm run check` and
validates to the same object as the equivalent `.json`. A run file that exceeds a harness
`maxMode` is rejected, naming both values, before any subprocess starts.
`agent-team merge` on a two-task run lands both as unstaged changes; the same merge with a
conflicting local edit aborts having changed nothing; `--rebase` on a pipeline run preserves
per-stage commits where `--squash` leaves one combined blob. Kill a task mid-spawn and
confirm no orphan worktree survives.

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

- A per-harness price table converting tokens to estimated spend. Blocked on knowing which
  model a harness actually selected — nothing reports that today, and a confidently wrong
  dollar figure is worse than none. M0 item 6 is what would unblock it.
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
  single-process and single-writer; JSON per run stays, and zero runtime dependencies
  with it.
- **Peer messaging** (`team_message` / `team_broadcast`). `PROJECT-BRIEF.md` names A2A
  messaging as a non-goal. Ensemble's coordination model *is* inter-agent chat; ours is
  DAG plus handoff.
- **Team state injected into the system prompt.** Not available over ACP — we control the
  prompt text, not the harness's system prompt.
- **The lead-agent orchestrator.** Theirs is an LLM, ours is code. That buys them emergent
  coordination and buys us determinism and auditability. It is the load-bearing difference
  between the two projects.
- **Rate limiting.** Harnesses own their own auth and their own backoff.
