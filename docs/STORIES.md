# Story breakdown

`PROJECT-PLAN.md` reviewed against the code and sliced into deliverable stories.

## Where this came from

The plan was reviewed line by line against the source before being broken down. **It held
up.** The architecture is coherent, the decisions table records *why* rather than only
*what*, prior art is metabolised rather than copied, and every code reference in it
(`acp.mjs:9`, `:82`, `:196`, `:218-228`, `:235`, `:318-341`, `agents.mjs:22`, `:32`,
`render.mjs:20`, `:61-72`) checks out. It was written with the code open.

What it lacked was not architecture. It was a set of **contract-level decisions that
several modules each need and none of them owns** — identifiers, terminal-state mapping,
failure propagation — plus a few places where a milestone's scope and its own verification
checklist disagreed. Those are recorded here, inside the story that closes each one, so
that finishing the story clears the gap rather than deferring it.

Three structural deviations from the plan, each argued in the story that carries it:

1. **M1 is split into M1a / M1b / M1c.** The plan's M1 is ten modules, a toolchain
   migration, a five-file port, two test doubles and a merge command — coherent as a
   destination, unusable as a unit of work.
2. **`--rebase` moves from M1 to M3**, landing with the pipelines that give it meaning
   (M1c-3).
3. **`node:test` is the unit-test runner** for pure functions (M1a-1).

## Reading a story

- **Size** — `XS` under 2h · `S` half a day · `M` 1–2 days · `L` 3–5 days.
- **Needs** — hard ordering only. Anything unlisted can run in parallel.
- **Gap** — what the plan left undefined, contradictory, or unowned. Present only where
  there is one.
- **Done when** — the observable check. If it cannot be observed, it is not a criterion.

## Decide before M1a starts

Eleven of the stories below open with a decision rather than code. Settle those decision
halves first — it is about half a day of calls, and roughly three weeks of work queues
behind them:

**M1a-3** (request timeout) · **M1a-4** (registry `env` field) · **M1a-5**
(`allowReadOutsideRoot`) · **M1a-8** (ids and branch names) · **M1b-1** (`needs` rejected
at M1) · **M1b-2** (`stopReason` mapping, `skipped`, roll-up ordering) · **M1b-3**
(`.agent-team/` git-ignore) · **M1b-4** (missing result block) · **M1c-3** (`--rebase`
deferral) · **M1a-1** (`node:test`).

**M2-2**'s decision (event log shape and cursor semantics) can wait until M2 planning —
but not past it, because M2-2's *size* depends on the answer.

---

## M0 — Reconnaissance

Builds nothing except three papercut fixes. Every M1 default depends on its findings.

**M0-1 · Harness availability and handshake survey · S · DONE**
> Survey complete — `M0-FINDINGS.md`, M0-1 section. All three targets **available**
> (opencode 1.18.18, claude-agent-acp 0.49.0, copilot 1.0.78), none unavailable, none
> untested. `loadSession: true` on all three. No harness calls `fs/*`. opencode never
> sends `session/request_permission` and wrote a file under `safe`. The stories below
> marked *(revised by M0-1)* changed as a result.
Run the current MVP against `opencode acp`, `claude-agent-acp` and `copilot --acp`. Record
per harness: does it spawn, does it complete a turn, which `session/update` variants arrive
that `render.mjs:20` does not handle, which methods hit the `#handleRequest` default
(`acp.mjs:196`), and what `agentCapabilities` it advertises.
**Gap** — the plan's decisions table asserts all three harnesses are "verified end-to-end",
and every M0 story downstream assumes they are installed and authenticated. Nothing names
what happens if one is not. That is the single biggest schedule risk in the plan and it is
unwritten.
*Done when* the findings note has a row per harness, and any harness that could not be
installed or authenticated is recorded as **unavailable rather than untested** — the two
have very different consequences for M1a-4. Also record `agentCapabilities.loadSession`
per harness: the plan frames persistence as history-only "because ACP has no resume", which
is true of the protocol but not necessarily of every harness, and a harness that advertises
it is a cheap win later.

**M0-2 · Registry papercut fixes · XS**
`copilot acp` → `copilot --acp` (`agents.mjs:32`). Bake `env -u CLAUDECODE` into the
`claude` entry (`agents.mjs:22`) — a two-line fix for a papercut `CLAUDE.md` documents at
length.
**Revised by M0-1** — `copilot --acp` confirmed against `copilot --help` (1.0.78), and the
env scrub is three variables, not one: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`,
`CLAUDE_CODE_ENTRYPOINT`. That is what M0-1 ran with successfully.
*Done when* both harnesses start from a clean shell with no manual env fiddling.
*Note* the `claude` fix needs the registry `env` field from M1a-4, or a stopgap that M1a-4
replaces.
**DONE** — both verified end-to-end (copilot 1.0.78, claude-agent-acp 0.49.0, each
completing a turn from inside a Claude Code session with no `env -u` prefix). The env list
went straight into a registry `env` field shaped `{unset?, set?}`, so M1a-4 inherits it
rather than replacing a stopgap. Two things the story did not anticipate: the negative
control **did not reproduce** — 0.49.0 tolerates an inherited `CLAUDECODE`, so the scrub is
regression insurance, not a live fix — and the deprecated `claude-code` entry was
**removed** rather than fixed alongside `claude`, leaving one Claude harness id.

**M0-3 · Terminal and shell-routing spike · M · needs M0-1**
Flip `clientCapabilities.terminal` to `true` (`acp.mjs:82`), stub `terminal/*` as logging
no-ops in `#handleRequest`, and run each harness on "run the tests" in a throwaway
workspace under `--mode auto` — under `safe` the `execute` permission is denied before any
terminal call would happen.
*Done when* each harness has a recorded verdict on two **separate** questions: does
`terminal/create` ever arrive (scopes M3-5), and does it route commands across our boundary
with real argv or run them internally (populates the containment label). The second
outlives the first, which is why it is recorded separately.
**Done 2026-08-21** (`docs/M0-FINDINGS.md` §M0-3). Two corrections to this text as written:
the stub cannot be a "logging no-op" — `terminal/create` must return a `terminalId` or the
turn dies, so it really executes; and the answer to question 2 is not binary. **No harness
called `terminal/create`** even with the capability advertised, and the command text
reaches us on ordinary `session/update` notifications — a channel neither this story nor
the plan anticipated.

**M0-4 · Cancellation probe · S · needs M0-1**
Send `session/cancel` mid-turn to each harness. Record whether the turn ends promptly and
with what `stopReason`. Confirm the expectation that none accepts a second `session/prompt`
while a turn is in flight.
*Done when* the note states the observed stop reason and latency per harness — M1c-1's TTL
rung is only as good as this answer.
**Done 2026-08-21** (`docs/M0-FINDINGS.md` §M0-4). Three corrections to this text as
written. The probe could not be a `run.mjs` run: its SIGINT path kills at 2 s
(`run.mjs:81-88`) and `#failAll` (`acp.mjs:62-64`) would have turned any slower cancel into
an exit error, so the answer needed tooling that cancels and waits — plus an **uninterrupted
control run**, without which "the turn ended" cannot be told from "the turn was ending
anyway". The expectation about a second `session/prompt` is **false on all three**: none
rejects it, the in-flight turn dies, and both requests answer `end_turn`. And latency turned
out not to be the interesting number — everything landed inside 64 ms — while
**copilot reports `end_turn` for a turn it cancelled**, which is what actually moves M1b-2.

**M0-5 · Usage reporting survey · S · needs M0-1**
Per harness: does `usage_update` arrive, and what do its fields mean? `{used, size}` is
context occupancy, not spend. Check specifically for cumulative or billable counts, and for
anything naming the model actually selected.
*Done when* the note distinguishes occupancy from spend per harness, and states plainly
whether a price table is possible at all — it is what unblocks the plan's first open item.

**M0-6 · Correct the safety claims · S** *(was XS; revised by M0-1)*
`CLAUDE.md` and `README.md:143` both say "even `--mode auto` cannot write outside the
workspace root". True of `fs/*` only; a shelling agent never touches `#guardPath`. The
policy does still fire on the `execute` tool call, but it judges an agent-authored title
string, not argv.
**Revised by M0-1 — this is no longer XS, and the drafted wording is itself an
overclaim.** The survey found that against opencode *nothing* crosses the protocol: no
`fs/*` call, no `session/request_permission`, and a file written to disk while running
under `safePolicy`. "`safe` blocks everything that crosses the protocol" is true and
useless there, because it reads as a guarantee to anyone who has not measured what crosses.
It also found `#guardPath` protects nothing in production — no harness calls `fs/*` at all —
so the sentence it is correcting is wrong in a second way the story did not anticipate.
**Decision: the claim becomes per-harness and points at the registry**, along the lines of
*`safe` blocks what a harness routes through the protocol; a harness that routes nothing —
opencode today — is uncontained, and the registry says which is which.*
*Done when* `CLAUDE.md` and `README.md:143` both carry the per-harness claim, name opencode
as uncontained, and no longer imply `#guardPath` bounds `--mode auto`.

**M0-7 · Findings note · XS · needs M0-1, M0-3, M0-4, M0-5**
`docs/M0-FINDINGS.md`. The input to M1a-4's containment labels and env list, M1c-1's TTL
default, and M3-5's terminal scope.
**Partially landed with M0-1** — the file exists, the M0-1 section is complete, and the
M0-3/4/5 sections are stubbed with the partial input that survey already produced (no
`terminal/*` traffic under `terminal: false`; copilot supplying real argv on the permission
request; `usage_update` shapes, including `cost` on opencode alone).
**M0-3 and M0-4 filled 2026-08-21.** One section remains: M0-5.

---

## M1a — Toolchain and protocol core

Ends with: today's behaviour, in TypeScript, typed, both safety layers intact, and
`npm run selftest` still green.

**M1a-1 · Toolchain · S**
Node 24 in `engines`. `tsconfig.json` with `strict`, `erasableSyntaxOnly`, `noEmit`.
`typescript` as the only devDependency. `npm run check` → `tsc --noEmit`; `npm run test` →
`node --test`.
**Gap** — the plan states there is no unit-test framework and that it does not add one.
That rule predates the plan's own Node 24 decision. `node:test` and `node:assert` are
**built into the runtime**: using them adds no dependency, no devDependency and no build
step, so the zero-runtime-dependency survival trait the brief names is untouched. M1
introduces exactly the code end-to-end runs verify badly — mode precedence and ceiling
resolution, `<task-result>` extraction strictness, DAG toposort, merge overlap detection,
the watchdog's consecutive-repeat counter. Each is a pure function with a truth table, and
driving one through a subprocess handshake to check a boundary condition is slow and covers
little. **Decision: `node:test` for pure functions in `core/` and `protocol/`;
`mock-agent` and `hostile-agent` keep owning end-to-end and adversarial coverage.** It is
why several stories below have a truth-table criterion rather than an end-to-end one.
*Done when* both scripts pass on an empty test set and no build step exists. Note the
current runtime is v22.22.2 and already strips types, so this is a smaller lift than the
plan's Node 24 framing implies — the bump is for LTS, not for the language feature.

**M1a-2 · `protocol/types.ts` · M · needs M1a-1**
Hand-written definitions for every message we touch. The `session/update` discriminated
union is the point of the exercise: `update.sessionUpdate` is currently a bare string
compared in two places (`acp.mjs:218`, `render.mjs:20`) with nothing keeping them in sync.
*Done when* adding a variant to the union makes `tsc` fail at every unhandled `switch`.

**M1a-3 · Port `acp.mjs` → `protocol/agent.ts` · M · needs M1a-2**
Essentially intact. Both invariants preserved verbatim: the `toolCallId → {title, kind,
rawInput}` map (`acp.mjs:218-228`) and `#guardPath` (`acp.mjs:235`). The single `onEvent`
callback becomes a typed emitter. Applies the registry's env mutation (M1a-4).
**Gap** — `AcpAgent.request()` never times out, and `#failAll` fires only on process close.
A harness that spawns, accepts the pipe and never answers `initialize` hangs the task
forever. The watchdog's TTL rung covers *running* tasks, so it structurally cannot see a
task stuck before it started — and under a daemon there is no `^C` to fall back on.
**Decision: a per-request timeout on the handshake and session-management methods, default
30s, explicitly not on `session/prompt`**, which is legitimately long-running and is what
the watchdog is for.
*Done when* `npm run selftest` passes unchanged; a mock that accepts the pipe and never
answers `initialize` fails the task in ~30s instead of hanging; and `node:test` covers
`#guardPath` — in-root, escaping `../`, absolute-outside, symlink, and the read/write
asymmetry under `allowReadOutsideRoot`.

**M1a-4 · `protocol/registry.ts` · S · needs M1a-3, M0-7**
Today's `AGENTS` map plus `defaultMode`, `maxMode` and the containment label
(`shell: "terminal" | "internal" | "unknown"`, from M0-3). Mode ordering is the total order
`safe < ask < auto`.
**Gap** — `AcpAgent` passes `process.env` wholesale to every subprocess, and M0-2 needs
`env -u CLAUDECODE` baked into a registry entry that has nowhere to put it. This sharpens
under the daemon: M2-8 introduces a shared secret, and a daemon holding that token in its
environment would hand it to every harness it spawns. **Decision: add
`env?: { unset?: string[]; set?: Record<string,string> }` to registry entries**; M2-8 also
strips `AGENT_TEAM_*` unconditionally.
**Revised by M0-1** — the labels are measured, and one field turns out to be too few. All
three targets are `shell: "internal"`, but they differ on something `shell` cannot express:
whether the harness asks permission at all. opencode never does. **Add a second field,
`asksPermission: boolean`** (opencode `false`, the other two `true`), because the warning
text differs in kind: against opencode the policy has *no* jurisdiction rather than reduced
reach.
**Revised again by M0-3** — record per-harness `_meta` capability flags too: harnesses gate
behaviour on extensions we do not advertise (`terminal_output` for claude-agent-acp,
`terminal-auth` for opencode), and a probe that tests only standard fields under-reports.
And `shell` alone cannot express what we measured, so add
**`argvChannel: "terminal" | "notification" | "permission" | "none"`** beside it. `shell`
says where the command runs, `argvChannel` says whether the text reaches us and by which
route; the two are independent. Measured: opencode `internal`/`none`, claude-agent-acp
`internal`/`notification` (**late**, on `tool_call_update`), copilot
`internal`/`notification` (also on the permission request). `unknown` reads as
`internal`/`none`. **And add a third, `modeMap: { safe, ask, auto }`** — all three harnesses accept
`session/set_mode`, negotiating `plan` is what actually stops opencode writing, and the mode
vocabularies do not align (copilot uses spec URLs, claude-agent-acp vendor ids, opencode
`build`/`plan` discoverable only via `configOptions`). Note opencode advertises no `modes`
yet honours `session/set_mode`, so mode discovery must read both fields. Env list confirmed as `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`
for claude-agent-acp. No harness M0-1 surveyed needs `unknown`; `omp`, `pi` and
`gemini` are uninstalled here and keep it. (`claude-code` was too; M0-2 removed the entry.)
*Done when* `unknown` behaves as `internal` for warning purposes, so a harness M0-1 could
not verify produces the **conservative** claim rather than the optimistic one — and an
`asksPermission: false` harness warns even in `auto`, where the containment warning would
otherwise be silent but the silent-autonomy risk is highest.

**M1a-5 · `core/policy.ts` · S · needs M1a-3**
Small in lines, load-bearing. The signature changes from `async () => boolean` to a form an
external asynchronous decider can answer, so M2-3's `ask` works with no TTY.
`READ_ONLY_KINDS`, `safePolicy` and `autoPolicy` semantics are unchanged (`acp.mjs:9`,
`:318-341`).
**Gap** — `AcpAgent` takes `allowReadOutsideRoot` (`acp.mjs:32`, `:238`), which disables the
read half of the path guard, and the plan's entire safety discussion never mentions it: not
in the schema, not in the precedence chain, not under the harness ceiling. What lives
outside a workspace root is exactly `~/.aws/credentials`, `~/.ssh`, and the parent repo's
`.env`. **Decision: name it in the schema, resolve it through the same
`task > run > harness > default` chain, default `false`, and have `safe` force it `false`
regardless of what was asked for** — `safe` claiming read-only while reading an SSH key is
precisely the overclaim M0-6 exists to stop.
**Revised by M0-1 — `safe` gains a second half: negotiate, then filter.** Setting the
harness's nearest restrictive mode via `session/set_mode` at session start is what gives
`safe` any effect at all on a harness that never asks (measured: opencode wrote the file
without negotiation, declined with it). Filtering by kind stays exactly as specified and
runs on whatever still arrives. Mode ids come from M1a-4's `modeMap`. Defence in depth, not
a sandbox — the refusal we measured was agent prose, so enforcement is not verifiable from
our side.
Two further measured facts bear directly on `READ_ONLY_KINDS`. First,
copilot *reads* by shelling `cat`, so its reads arrive as `execute` kind and `safe` refuses
them: safe mode does not make copilot cautious, it makes it unusable. Second, opencode
asks nothing, so no policy value changes its behaviour at all. Keep `READ_ONLY_KINDS` as
it is — kind is the only thing the protocol gives us — and let M1a-4's `defaultMode` carry
the per-harness adjustment, but say plainly in the docs that mode is advisory against a
harness that never asks.
*Done when* a `node:test` truth table covers precedence `task > run > harness > safe`, the
`maxMode` ceiling raising a **validation error naming both values** rather than downgrading
silently, and `safe` overriding a requested `allowReadOutsideRoot: true`.

**M1a-6 · `core/events.ts` · S · needs M1a-2**
Typed bus carrying agent events plus supervisor events (task started, worktree created,
permission pending, stall warning, task finished, containment warning). The `_client_`
prefix convention is retained for client-originated events (`render.mjs:61-72`).
*Done when* every consumer — CLI render, and later persistence and SSE — subscribes, and
nothing reads agent state directly. This is the invariant that makes M4 purely additive.

**M1a-7 · Port `render.mjs` and `run.mjs` · S · needs M1a-6**
`run.ts` keeps driving in-process, TTY `ask` intact.
*Done when* `npm run selftest` runs `run.ts` and passes — the plan's verification section
requires it stay green across the port, and it currently invokes `run.mjs` — and the
containment warning from M1a-4 surfaces as a one-line notice when starting `safe`/`ask`
against a `shell: "internal"` harness.

**M1a-8 · `core/ids.ts` · XS · needs M1a-1**
**Gap** — `agent-team merge <runId>` operates on branches, retention promises "the branch
always survives", and worktrees live at `.agent-team/wt/<runId>/<taskId>` — yet the plan
gives no format for `runId`, no charset constraint for `taskId`, and **no branch naming
convention at all**, so merge has no defined way to find the branches belonging to a run.
Three things depend on it: filesystem path safety, git ref legality, and branch discovery.
**Decision:** `runId` = `YYYYMMDD-HHMMSS-<4 char base36>` (sorts chronologically, readable
in a path, collision-safe within a second); `taskId` validator-enforced
`^[a-z0-9][a-z0-9._-]{0,63}$`; branch = `agent-team/<runId>/<taskId>`. Merge discovers
branches by reading the run's own persisted record, **never** by reconstructing names.
*Done when* an illegal task id is a validation error rather than a silently sanitised one —
the id in the run file is the id everywhere — and branch names round-trip through
`git check-ref-format`.

---

## M1b — Runs, worktrees, results

Ends with: a run file of N independent tasks, each in its own worktree, each returning a
parsed `TaskResult`.

**M1b-1 · `core/runfile.ts` · M · needs M1a-5, M1a-8**
Types plus a **runtime** validator — `satisfies Run` erases at runtime and therefore checks
nothing arriving over the wire. Schema: run-level defaults plus `tasks[]` (`id`, `agent`,
`prompt`, `mode`, `needs[]`, `worktree`, `allowReadOutsideRoot`) and `maxConcurrency`. All
three entry paths — `.ts`/`.mjs` module, `.json` file, POST body — converge on the one
validator. Mode precedence and the harness ceiling resolve here, before any subprocess
starts.
**Gap 1** — the plan puts `needs[]` in the M1 schema while stating M1 "runs the
independent-tasks case only". So a run file with `needs: ["plan"]` validates cleanly and
then runs its tasks in parallel: no error, no warning, just a plausible wrong answer. The
worst failure shape available. **Decision: M1 rejects a non-empty `needs` with an explicit
"task dependencies land in M3" error**, and likewise a `worktree` value implying
inheritance. The schema stays stable; the behaviour never lies. M3-1 lifts the rejection.
**Gap 2** — nothing in the plan bounds concurrency. A parallel-split run file with twelve
tasks spawns twelve harnesses, twelve model subscriptions and twelve worktrees at once.
**Decision: `maxConcurrency` on the run, default from config (suggest 4)**, enforced by
M1b-2.
*Done when* each import failure mode has its own error (import throws / no default export /
default is not an object); a `.ts` run file and its `.json` equivalent validate to the same
object; and **the CLI imports run files while the daemon never imports a path supplied over
the API** — importing is executing, and that boundary is the whole difference between a
convenience and a remote-code-execution hole.

**M1b-2 · `core/run.ts` · M · needs M1b-1**
The new centre of gravity. Run owns N Tasks; Task owns one agent, one worktree, one policy,
one result. The run's roll-up is **duration and turn count** — the only units that mean the
same thing across vendors; token figures stay per task, verbatim, tagged with the harness
that produced them, never summed. Concurrency pool honouring `maxConcurrency` — cheap here,
where there is no DAG, and awkward to retrofit into M3-1.
**Gap 1** — `TaskResult` records `stopReason` and nothing maps it to a status. ACP can end
a turn with `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` or `cancelled`, and
they mean very different things: `max_tokens` is a task that stopped mid-edit with a
half-written file on disk, and today it is indistinguishable from success. The pipeline
gates on this. **Decision — one table, in this module:**

| stopReason | status | note |
|---|---|---|
| `end_turn` | `done` | normal; result block expected |
| `max_tokens` | `failed` | truncated mid-turn; worktree kept for inspection |
| `max_turn_requests` | `failed` | hit the harness's own turn cap |
| `refusal` | `failed` | agent declined; `summary` carries its text |
| `cancelled` | `timed_out` if the watchdog fired, else `cancelled` | the supervisor knows which |

**Revised by M0-4** — the table stands; its input does not. `cancelled` may never arrive:
copilot answers `end_turn` for a turn it cancelled (both samples, against a control run
proving the turn was cut short), contrary to ACP's MUST. And `end_turn` is now known to mean
*finished*, *I was cancelled*, or *someone sent a second prompt and killed my turn*.
**Key the status on the triple (`stopReason`, did we send a cancel, did the watchdog fire)**,
with the supervisor's own record authoritative and `stopReason` consulted only where the two
agree. A cancelled turn is also truncated mid-tool-call, so the "stopped mid-edit" hazard
recorded above for `max_tokens` applies to `timed_out` too.

**Gap 2** — the plan gives no rule for what happens to dependents when a dependency fails,
no rule for rolling task statuses into a run status, and its lifecycle
(`pending → running → done | failed | timed_out | cancelled`) has no state for "never
started because its dependency failed" — which is unavoidable the moment `needs` executes.
**Decision: add `skipped` to the terminal states**; a failed, timed-out or cancelled task
marks every transitive dependent `skipped` (M3-1); run status = worst task status, ordered
`done < warned < skipped < failed`. Reserve the field name `continueOnFailure?: boolean`
now — **defer the behaviour** — so adding the escape hatch later is not a schema break.
*Done when* `node:test` covers the stop-reason table and the roll-up ordering, and a
six-task run file with `maxConcurrency: 2` never has three live subprocesses.

**M1b-3 · `core/worktree.ts` · M · needs M1a-8**
`git worktree add` off a base ref into `.agent-team/wt/<runId>/<taskId>`. Preflight: repo
detection, dirty-tree refusal, base-ref resolution. Retention: remove the worktree on
success, **keep worktree and branch on failure or timeout** so partial work stays
inspectable; the branch always survives. **Transactional spawn** — worktree creation, task
registration and agent start either all succeed or are all rolled back, so a failed spawn
never leaves an orphan worktree with no run record.
**Gap** — `.agent-team/` sits **inside the working tree of the repo being worked on**, and
the plan never reconciles that with its own rules. Three consequences: the dirty-tree
refusal above will refuse on the supervisor's own state directory from the second run
onward; M1b-4's `git status --porcelain` cross-check will attribute supervisor files to the
agent; and a worktree nested inside the parent tree is inside the parent's `#guardPath`
root when a task runs from the repo root. **Decision: a preflight step that ensures
`.agent-team/` is git-ignored** — appending it if absent, refusing to start if the path is
*tracked* — plus explicit exclusion from the diff cross-check (M1b-4). Keeping state
in-repo is right, discoverable and per-project; it just has to be invisible to git.
*Done when* a run leaves `git worktree list` clean after success and populated after
failure, and killing a task mid-spawn leaves no orphan worktree without a run record.

**M1b-4 · `core/result.ts` · M · needs M1b-2**
Prompt preamble requesting a `<task-result>` block with `<status>`, `<summary>`,
`<details>`, optional `<files>` and `<branch>`. Extraction is a regex for the wrapper, then
one per field. Strictness: `null` if the wrapper is absent, or if any of
status/summary/details is missing or empty after trimming; a missing *optional* field is
`undefined`, not a rejection. `TaskResult` merges these agent-reported fields with observed
ones: `stopReason`, duration, turns, tokens, permission count, `git status --porcelain`,
`policyNeverFired`. Cross-check writes `warnings[]` — status `success` with an empty diff;
`<files>` naming paths the diff does not contain; a non-empty diff with no block at all;
plus `policyNeverFired`. `<files>` is our extension to ensemble's schema and exists
precisely to make this check possible.
**Revised by M0-1: `policyNeverFired` is now a required check, not a nicety.** The survey
found opencode produces a non-empty diff with zero permission requests *by default* — the
exact signature this warning exists to catch — so on the most-used harness it fires on
every mutating task. Two consequences: the warning text must not read as an anomaly report,
and it should be paired with M1a-4's `asksPermission: false` so a run says "this harness
never asks" once, rather than crying wolf per task. Excludes `.agent-team/` from the diff (M1b-3).
**Warnings publish on the bus and never fail the task** — a read-only stage legitimately
produces no diff, and making disagreement fatal would turn every harness quirk into a hard
stop and break the review stages the pipeline is built on.
**Gap** — the plan specifies extraction returning `null` but never says what the task's
*status* then is, nor what M3-3 hands a successor when there is no summary to hand it.
Warning-only is the right posture, but it leaves `TaskResult.summary` undefined for exactly
the handoff M3 is built on. **Decision, three steps:** (1) on `null`, send **one** bounded
follow-up prompt in the same session — *"Reply with only the `<task-result>` block"* — which
costs one turn and converts most misses into hits; (2) still `null` → status stays whatever
the stop-reason table says, `warnings += "noResultBlock"`, and `summary` is synthesised from
the tail of the final message and explicitly flagged as synthesised; (3) a successor's
prompt states plainly that the predecessor reported nothing structured, rather than passing
a synthesised summary off as the agent's own words (M3-3).
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
**Gap** — harness stderr is discarded unless `--verbose` (`acp.mjs:73`), while `CLAUDE.md`
documents at length that stderr is the first place to look when a spawn fails and that the
real error is invisible without the flag. Under a daemon nobody is watching a terminal.
**Decision: capture to `.agent-team/runs/<id>/<taskId>.stderr.log` unconditionally**;
`--verbose` continues to mirror it to the terminal.
*Done when* a harness that fails to start leaves a log containing its real error rather than
only `Internal error (code -32603)`.

**M1b-8 · Retire `fanout.mjs` · S · needs M1b-2**
Its job becomes "a run file with N independent tasks". Port `tasks.json` to the new schema
as a worked example.
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
`session/cancel`, preserves the branch and marks the task `timed_out`. Every knob disabled
at `0`. Best-effort throughout — one task's failure must never halt the sweep.
**M0-4 fills in the TTL rung** (`docs/M0-FINDINGS.md` §M0-4): every harness ended its turn
within 64 ms of `session/cancel`, sent nothing afterwards, and accepted a further prompt — so
**wait 2 s after cancelling, then force-kill**, and expect never to reach it. Mark
`timed_out` from the watchdog's own record: copilot's cancelled turns come back `end_turn`.
*Done when* `node:test` covers the repeat counter's reset behaviour and one task throwing
inside the sweep does not stop the others being checked. There is deliberately no third
rung: ACP gives no way to nudge a turn in flight, so detection reports rather than corrects.
**M0-4 turned that into a hard rule.** A second `session/prompt` is accepted by all three
harnesses and kills the running turn; on opencode and copilot its text is merged into that
turn's context, where both models read it as a possible prompt injection. Copilot aborts the
session on *any* prompt, even one sent while idle
([github/copilot-cli#4555](https://github.com/github/copilot-cli/issues/4555)). One prompt
per session per task.
A token-based signal was considered and dropped — `usage_update` reports context occupancy
in units that are not comparable between vendors.

**M1c-2 · `mock-agent` stall and repeat modes · XS · needs M1c-1**
Stall: accepts the prompt, emits nothing, never returns. Repeat: the same tool title on a
loop. One per watchdog signal.
*Done when* stall produces a warning then a cancel at TTL with the branch intact, and repeat
produces a warning and is **not** cancelled.

**M1c-3 · `core/merge.ts` — preflight and `--squash` · M · needs M1b-3**
`agent-team merge <runId>`, never automatic. A run produces branches; landing them is a
distinct act with its own failure mode. Preflight refuses if the working tree has
modifications to any file a task branch touches, and refuses if two task branches in the run
touch the same file. All-or-nothing: preflight completely, then merge, so a run never
half-lands. `--squash` (default) leaves the combined changes **unstaged**, nothing
committed — right for a parallel split, where the branches are independent.
**Gap** — the plan ships `--rebase` in M1 and justifies it as "right for a pipeline, where
one inherited worktree carries several stages' commits". Pipelines are M3. M1's own
verification checklist then asks for "`--rebase` on a pipeline run preserves per-stage
commits" — a run that cannot be authored at M1. **Decision: M1 ships the preflight (the
load-bearing, hard part) plus `--squash` only; `--rebase` moves to M3-4.** This also shrinks
M1, which needs shrinking.
*Done when* a two-task run lands as unstaged changes; the same merge with a conflicting
local edit aborts having changed nothing; and `node:test` covers overlap detection on branch
file sets.

**M1c-4 · `core/notify.ts` · S · needs M1a-6**
Attention signal for the two events a human needs while looking elsewhere: permission
pending, and stall warning. Terminal bell plus a distinct stderr line; optionally
`notify-send`/`osascript` when present, best-effort, never a dependency.
*Done when* the bus event exists independently of the terminal output — M4-4's toast
subscribes to the same one.

**M1c-5 · Package identity · XS**
**Gap** — the plan invokes `agent-team merge`, but `package.json` is `private`, named
`acp-mvp`, and has no `bin`; and no document states which platforms are supported, while
M1c-4 shells to `notify-send`/`osascript` and `git worktree`, paths and `sep` all behave
differently on Windows. **Decision: rename to `agent-team`, drop `private`, add the `bin`
entry, and declare macOS and Linux supported with Windows explicitly unsupported** — rather
than discovering it.

**M1c-6 · M1 acceptance · S · needs all M1c**
A run file with three independent tasks against three real harnesses, each in its own
worktree, each returning a parsed `TaskResult`; `git worktree list` clean afterwards. Kill
the process mid-run, restart, confirm orphans are reaped. A `.ts` run file type-checks under
`npm run check` and validates to the same object as its `.json` twin. A run file exceeding a
harness `maxMode` is rejected, naming both values, before any subprocess starts.

---

## M2 — Daemon

**M2-1 · Daemon skeleton · M · needs M1c-6**
`node:http`, no framework. `POST /runs`, `GET /runs`, `GET /runs/:id`, `DELETE /runs/:id`
(cancel). Objects only over the wire; the daemon never imports a path (M1b-1).
*Done when* `core/` still runs headless under `node --test` with no server booted. The
`core/` split guards against orchestration logic living in HTTP handlers: if `POST /runs` is
where worktree creation and stage sequencing happen, the scheduler becomes untestable
without booting a server and the CLI drifts into a second implementation.

**M2-2 · Event log and SSE replay · M · needs M2-1**
`GET /runs/:id/events`, SSE with replay-from-cursor, so a client attaching late still sees
history.
**Gap** — replay needs an ordered, durable, addressable event log, and the plan's only
persistence bullet describes "JSON per run, written on state transitions", which is a
different thing. No cursor semantics, no bound, and no statement of what happens to
per-token `agent_message_chunk` events, of which a single task produces thousands.
**Decision:** append-only `.agent-team/runs/<id>/events.jsonl`; monotonic per-run `seq` as
the cursor; `Last-Event-ID` honoured; in-memory ring (last ~1000) for hot replay and the
file for cold; **message chunks coalesced into the log per message rather than logged per
token** — live subscribers get the stream, the log gets the message, otherwise the log is
95% token fragments and replay is unusable. Settle this at M2 planning, not during M2-2:
the story's *size* depends on it.
*Done when* `curl -N` attached mid-run receives the history and then the live tail,
contiguously.

**M2-3 · Permission over API · M · needs M2-1, M1a-5**
Pending decision list, `GET /permissions`, `POST /permissions/:id`, configurable timeout
(default ~120s) → **deny**, so an unattended run never wedges.
**Gap** — from M2 onward `ask` has two possible deciders (a TTY and the API), and from M4
three. The plan never says what happens when two clients answer the same pending decision.
**Decision: first writer wins; a second answer to a settled decision is a defined error, not
a silent overwrite.**
*Done when* a run submitted in `ask` mode with **no client attached** denies at timeout and
completes rather than hanging.

**M2-4 · Daemon lifecycle · S · needs M2-1**
Pidfile, single-instance guard, live-child registry, kill-all on shutdown, SIGTERM.
*Done when* a daemon crash leaves no harness subprocess alive holding write access.

**M2-5 · Crash-recovery sweep · M · needs M2-4, M1b-3**
The fuller version of "run `git worktree prune`". On boot: mark tasks left in `running` as
`errored`, kill or reap any registered child PIDs that survived, reconcile
`git worktree list` against persisted run records, and reap only those worktrees whose run
is terminal **and** past the retention window (default 7 days).
*Done when* `kill -9` then restart marks the task errored, reaps no worktree still within
retention, and leaves no harness subprocess alive.

**M2-6 · Persistence · S · needs M2-1**
JSON per run under `.agent-team/runs/<id>/`, written on state transitions. For completed-run
history, not live recovery.
**Revised by M0-1 — the stated reason was wrong.** "ACP has no resume" holds for the base
protocol but not for any harness we target: all three advertise
`agentCapabilities.loadSession: true`, and opencode and claude-agent-acp also advertise
`sessionCapabilities.resume` and `.fork`. History-only is therefore a scope choice, not a
protocol limit. **Persist the harness `sessionId` on the run record here** — it costs one
field, and without it the backlog's `session/load` item cannot be picked up later without a
migration. Actual reattachment stays out of scope and stays capability-gated. Single-process and single-writer, which is why this is JSON and not the SQLite
ensemble needs for concurrent plugin writers — and zero runtime dependencies stays with it.

**M2-7 · Config · S · needs M2-1**
`.agent-team/config.json`, `AGENT_TEAM_*` env override, layered env > project. Home for the
knobs that do not belong in a run file: watchdog thresholds, TTL, retention window, port,
permission timeout, `maxConcurrency` default.
**Gap** — the plan introduces the file but says nothing about validating it. A
silently-ignored `stallIdleMs` typo is a watchdog that never fires.
*Done when* unknown keys and type mismatches are rejected loudly at load.

**M2-8 · Auth · S · needs M2-1**
Localhost-only bind plus a shared-secret token file. Not optional: anything that can
`POST /runs` with `mode: auto` executes commands as the user, and once M4 can dispatch runs
*every* write endpoint is an execution surface, not just `POST /runs`. `EventSource` cannot
set custom headers, so the token must also be acceptable as a query parameter on the SSE
endpoint or exchangeable for a cookie by a login POST — decided here so M4 is not blocked;
the localhost-only bind is unchanged. Strips `AGENT_TEAM_*` from child environments before
spawn (M1a-4).

**M2-9 · `runs.ts` CLI · M · needs M2-2, M2-3**
Submit a run file, stream SSE, answer permissions interactively, print results. Two front
ends, one core: `run` drives in-process, `runs` talks to the daemon.

---

## M3 — Pipeline, DAG, terminals

**M3-1 · `core/scheduler.ts` · M · needs M1b-2**
Topological execution: parallel where no `needs`, sequential where there is. Lifts M1b-1's
rejection. Cycle detection is a validation error.
*Done when* `node:test` covers toposort, cycles, and the dependent-skipping rule from
M1b-2's `skipped` decision.

**M3-2 · Worktree inheritance · M · needs M3-1, M1b-3**
**Inherit if you are the only successor; fork from the predecessor's branch otherwise** —
two tasks that both `needs: [plan]` cannot share one checkout.
*Done when* a diamond DAG produces two forked worktrees and a linear chain produces one
inherited.

**M3-3 · Handoff · S · needs M3-2**
Predecessor's `TaskResult` injected into the successor's prompt; the successor also sees the
predecessor's changes on disk. An unreported predecessor is stated as unreported, never
presented as its own words (M1b-4).
**Gap** — nothing says in what order the result preamble, the injected summary and the
user's prose are assembled, with what separator, or whether run files can template
(`${needs.plan.summary}`). Decide it here, and note that the preamble's position relative to
user prose affects how reliably harnesses honour it.

**M3-4 · `merge --rebase` · S · needs M3-2, M1c-3**
Lands the task commits on the current branch with their stage boundaries and messages
intact — right for a pipeline, where one inherited worktree carries several stages' commits
on a single branch and flattening them discards which stage did what. Shares M1c-3's
preflight; the two modes differ only in what lands.

**M3-5 · Terminals · L · needs M0-3 · conditional — CUT by M0-3**
**M0-3 measured zero `terminal/*` calls from all three harnesses with `terminal: true`
advertised**, and confirmed why: opencode bundles the SDK's `createTerminal()` with no call
site, claude-agent-acp does not read `clientCapabilities.terminal` at all, copilot is
statically opaque and documents no terminal support. This story is now the documentation
alternative its own text names: an honest per-harness label, and `terminal: false` recorded
as a decision. Reopen only if a harness we add later actually calls `terminal/create`.
**Salvage:** under the vendor flag `_meta.terminal_output`, claude-agent-acp emits ACP
`type: "terminal"` tool-call content. If embedded-terminal *rendering* is ever wanted, that
is the path, and `render.mjs` drops that content type today.


`terminal/create | output | wait_for_exit | kill | release`, a Terminal class with a
ring-buffered output cap, and embedded-terminal rendering. **Only build for harnesses M0-3
showed actually call `terminal/create`.** If M0-3 shows they all ignore the capability, this
story becomes documentation per harness instead — an honest label beats a boundary with
holes in it.

**M3-6 · Command-level policy gating · M · ~~needs M3-5~~ · conditional — SURVIVES, rebased by M0-3**
The payoff: policy judges the actual argv rather than an agent-authored title string.
**M0-3 removes the dependency on M3-5.** We already hold real argv for claude-agent-acp and
copilot, from `rawInput` on `session/update` notifications rather than from `terminal/*`.
Two constraints M0-3 adds: claude-agent-acp's argv arrives **late**, on `tool_call_update`,
so the policy must not read at `tool_call` time; and opencode supplies no command text at
all, so it cannot be gated this way and needs the mode channel instead.

**M3-7 · M3 acceptance · S**
A three-stage pipeline (opencode plans `safe` → claude-agent-acp implements `auto` → copilot
reviews `safe`) in one inherited worktree, where stage B's prompt demonstrably contains
stage A's summary and stage C flags anything B got wrong.

---

## M4 — Dashboard

The first thing here that is not a CLI. Design reference: `opencode-ensemble`'s dashboard.

**M4-1 · Serving · M · needs M2-8**
String-templated HTML/CSS/JS out of the daemon. No framework, no build step, no runtime
dependency — the same constraint the rest of the project holds. Split across
`dashboard-html`, `-js-core`, `-js-events`, `-js-render`; that split is what keeps a
zero-build dashboard readable past a few hundred lines.

**M4-2 · Read views · L · needs M4-1, M2-2**
Run list; per-run task cards with status, elapsed, token count and a stall indicator; the
DAG rendered from `needs`; a live event timeline; the final `<task-result>` per task.

**M4-3 · Permission answering · M · needs M4-2, M2-3**
The one write path, and what makes M4 a control surface rather than a viewer — it is what
makes `ask` mode usable unattended.
*Done when* answering from the browser lets the run proceed and a CLI observer on the same
run sees the same decision.

**M4-4 · Toasts · S · needs M4-2**
Subscribes to the same bus events `core/notify.ts` uses (M1c-4).

---

## Critical path

```
M0-1 ─┬─ M0-3 ─┬─ M0-7 ──── M1a-4 ┐
      ├─ M0-4 ─┤                  │
      └─ M0-5 ─┘                  │
                                  │
  M1a-1 ─ M1a-2 ─ M1a-3 ─┬─ M1a-5 ┴─ M1b-1 ─ M1b-2 ─ M1b-4 ─┐
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

Three things are worth pulling forward, because everything queues behind them:

1. ~~**M0-3.**~~ **Done 2026-08-21.** It did delete one story and rescue the other: M3-5 is
   cut to documentation, M3-6 survives without it. The containment label M1a-4 ships is now
   two fields, `shell` and `argvChannel`.
2. **M1a-2.** Every later module types against it, and it is the story that earns the
   TypeScript decision.
3. **The eleven decision halves** listed under *Decide before M1a starts*.

~~M3-5 and M3-6 are the only stories here that may evaporate entirely.~~ **Settled:** M3-5
evaporated, M3-6 did not — it now depends on `argvChannel` rather than on M3-5. M3's
capacity is one large story lighter.

---

## Backlog — named, not scheduled

Each carries its trigger, so none of these is waiting to become a blocker by accident:

- **Sandboxing (`bwrap` / `sandbox-exec`).** The only option that actually closes the shell
  gap rather than documenting it, and the only thing that bounds `auto` mode's blast
  radius — which is where the real risk lives, and which labelling does nothing for.
  *Trigger:* a judgement call on `auto`'s blast radius, not an event.
- **Per-harness price table.** *Trigger:* M0-5 reporting that any harness names the model it
  selected. Nothing does today, and a confidently wrong dollar figure is worse than none.
- **`stallRepeatCount` per-harness tuning.** *Trigger:* an observed false positive. Safe to
  wait — a task re-running the same test command while iterating is a legitimate repeat, the
  default is deliberately generous, and repeats only ever warn.
- **`session/load` where a harness advertises it.** *Trigger:* M0-1 recording a harness with
  `agentCapabilities.loadSession`. **Trigger fired — all three advertise it**, and opencode
  and claude-agent-acp also advertise `sessionCapabilities.resume`/`.fork`. Still not
  scheduled, but it is now a known-available feature rather than a hypothetical, it must
  stay behind a per-harness capability check, and it depends on M2-6 persisting the harness
  `sessionId`.
- **`#send` write backpressure.** `#send` ignores the return value of `write()`
  (`acp.mjs:151`). *Trigger:* fan-out moving large file contents. The one item here that is
  genuinely "fix it when it bites" — Node buffers, so it degrades to memory growth rather
  than corruption.
- **Composing and dispatching runs from the browser.** M5+. Named because it is the stated
  trajectory and the reason M2's API has to be complete rather than observability-only.
