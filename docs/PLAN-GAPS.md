# Plan review — gaps to close before story planning

Review of `PROJECT-PLAN.md` (and `PROJECT-BRIEF.md`) against the code in this repo,
done before breaking the plan into stories.

## Verdict

**The plan is good enough to plan stories against.** It is unusually complete for a
draft: the architecture is coherent, the decisions table records *why* rather than only
*what*, prior art is metabolised rather than copied, and every line reference in it
(`acp.mjs:9`, `:82`, `:196`, `:218-228`, `:235`, `:318-341`, `agents.mjs:22`, `:32`,
`render.mjs:20`, `:61-72`) checks out against the actual source. That is rare and it means
the plan was written with the code open.

What it is missing is not architecture. It is a set of **contract-level decisions that
several M1 modules each need and none of them owns** — identifiers, terminal-state
mapping, failure propagation — plus a few internal contradictions where M1's scope and
M1's verification checklist disagree.

The twelve items under *Blocking* are the ones that would otherwise get decided
accidentally, by whoever writes the module first. They are all small decisions. Each has
a recommendation; adopting the recommendations as-is is a perfectly good outcome and is
what `STORIES.md` assumes.

---

## Blocking — decide before the first M1 line

### G1. Run/task identity and branch naming are undefined

`agent-team merge <runId>` operates on branches. Retention promises "the branch always
survives". Worktrees live at `.agent-team/wt/<runId>/<taskId>`. Yet no format is given for
`runId`, no charset constraint for `taskId`, and **no branch naming convention at all** —
so `merge` has no defined way to find the branches belonging to a run.

Three things depend on this: filesystem path safety, git ref legality, and merge's
branch discovery.

**Recommend**
- `runId` = `YYYYMMDD-HHMMSS-<4 char base36>` — sorts chronologically, readable in a path,
  collision-safe within a second.
- `taskId` — validator-enforced `^[a-z0-9][a-z0-9._-]{0,63}$`. Rejected at validation, not
  sanitised silently, so the id in the run file is the id everywhere.
- Branch = `agent-team/<runId>/<taskId>`. Merge discovers branches by **prefix scan of the
  run's own persisted record**, never by reconstructing names.

### G2. `stopReason` is stored but never mapped to task status

`core/run.ts` defines the lifecycle `pending → running → done | failed | timed_out |
cancelled`, and `TaskResult` records `stopReason`. Nothing says which stop reason produces
which status. ACP can end a turn with `end_turn`, `max_tokens`, `max_turn_requests`,
`refusal` or `cancelled`, and they mean very different things — `max_tokens` is a task that
stopped mid-edit with a half-written file on disk, and today it would be indistinguishable
from success.

This gates the pipeline: whether stage B runs at all depends on stage A's status.

**Recommend** a table in `core/run.ts`, one place:

| stopReason | status | note |
|---|---|---|
| `end_turn` | `done` | normal; result block expected |
| `max_tokens` | `failed` | truncated mid-turn; worktree kept for inspection |
| `max_turn_requests` | `failed` | hit the harness's own turn cap |
| `refusal` | `failed` | agent declined; `summary` carries its text |
| `cancelled` | `timed_out` if the watchdog fired, else `cancelled` | the supervisor knows which |

### G3. A missing `<task-result>` block has no defined outcome

`core/result.ts` is specified to "return `null` if the wrapper is absent". The cross-check
then records a warning when there is a non-empty diff and no block. But **what is the
task's status** when extraction returns `null`? And what does the pipeline hand the
successor when there is no summary to hand it?

Warning-only is the right posture (a read-only stage that forgot the block did not fail),
but it leaves `TaskResult.summary` undefined for exactly the handoff M3 is built on.

**Recommend**
1. On `null`, send **one** bounded follow-up prompt in the same session: *"Reply with only
   the `<task-result>` block."* ACP already supports a second `session/prompt`, this costs
   one turn, and it converts most misses into hits.
2. Still `null` → status stays whatever G2 says, `warnings += "noResultBlock"`, and
   `summary` is synthesised from the tail of the final message, explicitly flagged as
   synthesised.
3. A successor's injected prompt states plainly that the predecessor reported nothing
   structured, rather than presenting a synthesised summary as the agent's own words.

### G4. No failure propagation rule, and `skipped` is missing from the lifecycle

If stage A fails, nothing in the plan says what happens to B and C. Nor is there a rule for
rolling a run's task statuses up into a run status. The lifecycle list has no state for
"never started because its dependency failed" — and that state is unavoidable the moment
`needs` executes.

**Recommend**
- Add `skipped` to the terminal states.
- Default: a failed/timed-out/cancelled task marks every transitive dependent `skipped`.
- Run status = worst task status, ordered `done < warned < skipped < failed`.
- Per-task `continueOnFailure?: boolean` is the escape hatch — **defer it**, but reserve the
  field name now so adding it later is not a schema break.

### G5. `needs` and `worktree` are validated in M1 but only executed in M3

M1's `core/runfile.ts` schema includes `needs[]` and `worktree`, and M1 explicitly "runs
the independent-tasks case only". So a run file with `needs: ["plan"]` validates cleanly at
M1 and then runs its tasks in parallel — producing a plausible, wrong result silently. The
worst kind of gap: no error, no warning, just an incorrect answer.

**Recommend** M1's validator **rejects** a non-empty `needs` with an explicit
`"task dependencies land in M3"` error. The schema stays stable; the behaviour never lies.
Same for a `worktree` value that implies inheritance.

### G6. `--rebase` cannot exist at M1 — M1's own verification proves it

M1 ships `core/merge.ts` with `--squash` and `--rebase`, and `--rebase` is justified as
"right for a pipeline, where one inherited worktree carries several stages' commits". But
pipelines are M3. M1's verification checklist then asks for "`--rebase` on a pipeline run
preserves per-stage commits" — a run that cannot be authored at M1.

**Recommend** M1 ships the preflight (the load-bearing, hard part) plus `--squash` only.
`--rebase` moves to M3, landing with the pipelines that give it meaning. This also shrinks
M1, which needs shrinking.

### G7. `.agent-team/` lives inside the repo it operates on

Worktrees at `.agent-team/wt/<runId>/<taskId>` sit **inside the working tree** of the repo
being worked on. Three consequences, none addressed:

1. `worktree.ts`'s "dirty-tree refusal" preflight will refuse on the supervisor's own state
   directory, on the second run.
2. The `git status --porcelain` cross-check in `result.ts` will attribute supervisor files
   to the agent.
3. A worktree nested inside the parent tree is inside the parent's `#guardPath` root when a
   task runs from the repo root.

**Recommend** a preflight step that ensures `.agent-team/` is git-ignored — appending it if
absent, refusing to start if the path is *tracked* — plus explicitly excluding it from the
diff cross-check. Keeping state in-repo is right (discoverable, per-project); it just has to
be invisible to git.

### G8. `allowReadOutsideRoot` appears in the code and nowhere in the plan

`AcpAgent` takes `allowReadOutsideRoot` (`acp.mjs:32`, `:238`), which disables the read half
of the path guard. The plan's entire safety discussion — two layers, policy and
`#guardPath` — never mentions it. It is not in the run file schema, not in the precedence
chain, not under the harness ceiling. And what lives outside a workspace root is exactly
`~/.aws/credentials`, `~/.ssh`, and the parent repo's `.env`.

**Recommend** name it in the schema, resolve it through the same
`task > run > harness > default` chain, default `false`, and have `safe` mode force it
`false` regardless of what was asked for — `safe` claiming read-only while reading your
SSH key is precisely the overclaim M0 item 8 exists to stop.

### G9. Env is passed through wholesale, and the registry has no field to fix it

`AcpAgent` passes `process.env` to every subprocess. M0 item 7 requires baking
`env -u CLAUDECODE` into the `claude` registry entry — but `protocol/registry.ts`'s
specified fields are `{command, args, defaultMode, maxMode, shell}`. There is nowhere to
put it.

This gets sharper under the daemon: M2 introduces a shared-secret token, and a daemon that
holds that token in its environment hands it to every harness subprocess it spawns.

**Recommend** add `env?: { unset?: string[]; set?: Record<string,string> }` to registry
entries, and have the daemon strip `AGENT_TEAM_*` from the child environment
unconditionally before applying it.

### G10. Nothing bounds concurrency

A parallel-split run file with twelve tasks spawns twelve harnesses, twelve model
subscriptions, and twelve worktrees at once. There is no `maxConcurrency` anywhere in the
schema or config.

**Recommend** `maxConcurrency` on the run, default from config (suggest `4`), enforced by a
simple pool in M1 — where "no DAG" makes it about fifteen lines — rather than retrofitted
into `scheduler.ts` at M3.

### G11. SSE replay-from-cursor has no event log under it

M2 promises `GET /runs/:id/events` with "replay-from-cursor, so a client attaching late
still sees history". M2's persistence bullet describes only "JSON per run, written on state
transitions". Replay needs an ordered, durable, addressable event log — which is a
different thing, and it is unspecified: no cursor semantics, no bound, no statement of what
happens to per-token `agent_message_chunk` events, of which a single task produces
thousands.

This materially changes M2's size, so it should be decided before M2 is estimated.

**Recommend**
- Append-only `.agent-team/runs/<id>/events.jsonl`; monotonic per-run `seq` is the cursor;
  honour `Last-Event-ID`.
- In-memory ring (last ~1000) for hot replay, file for cold.
- Message chunks are **coalesced** into the log per message rather than logged per token —
  live subscribers get the stream, the log gets the message. Otherwise the log is 95%
  token fragments and replay is unusable.

### G12. The protocol layer has no request timeout

`AcpAgent.request()` never times out. `#failAll` fires only on process close. A harness that
spawns, accepts the pipe, and never answers `initialize` hangs the task forever — and the
watchdog's TTL rung covers *running* tasks, so it never sees a task stuck before it started.
Under a daemon there is no `^C` to fall back on.

**Recommend** a per-request timeout on the handshake and session-management methods
(default 30s), explicitly **not** on `session/prompt`, which is legitimately long-running
and is what the watchdog is for.

---

## Blocking decision (not a gap): use `node:test`

The plan states there is no unit-test framework and that it does not add one, and the
verification strategy is end-to-end runs against `mock-agent`.

That rule was written before the plan's own Node 24 decision. `node:test` and `node:assert`
are **built into the runtime** — using them adds no dependency, no devDependency, and no
build step. The zero-dependency survival trait is untouched.

M1 introduces exactly the code that end-to-end runs verify badly: mode precedence and
ceiling resolution, `<task-result>` extraction strictness (a `null`-vs-`undefined`
distinction per field), DAG toposort, merge overlap detection, and the watchdog's
consecutive-repeat counter. Each is a pure function with a truth table. Driving them
through a subprocess handshake to check a boundary condition is slow and covers little.

**Recommend** `node --test` for pure functions in `core/` and `protocol/`; `mock-agent` and
`hostile-agent` keep owning end-to-end and adversarial coverage. This changes the
acceptance criteria of most M1 stories, so decide it first. `STORIES.md` assumes yes.

---

## Non-blocking — worth recording, decide in-milestone

**N1. Harness availability is the top schedule risk, and it is unnamed.** M0's outputs
assume opencode, claude-agent-acp and copilot are all installed and authenticated on the
dev machine. If one is not, its containment label stays `unknown` and M1's registry ships
with a hole. Make `shell: "unknown"` a legal shipping value with defined behaviour — treat
it as `internal` for warning purposes, so an unverified harness produces the *conservative*
claim rather than the optimistic one.

**N2. Harness stderr is discarded unless `--verbose`.** `CLAUDE.md` documents at length that
stderr is the first place to look when a spawn fails, and that the real error is invisible
without the flag. Under a daemon nobody is watching a terminal. Capture per-task stderr to
`.agent-team/runs/<id>/<taskId>.stderr.log` unconditionally — cheap, and it is the
difference between a diagnosable failure and `Internal error (code -32603)`.

**N3. Prompt assembly has no defined shape.** M1 prepends a result-contract preamble; M3
injects a predecessor's result. Nobody says in what order, with what separator, or whether
run files can template (`${needs.plan.summary}`). Decide when M3 is planned; note that the
preamble's position relative to user prose affects how reliably harnesses honour it.

**N4. Package identity.** The plan invokes `agent-team merge`, but `package.json` is
`private`, named `acp-mvp`, and has no `bin`. Small, but real work nobody has a story for.

**N5. `npm run selftest` invokes `run.mjs`.** The verification section requires it keep
passing across the M1 port. Name it in the port story.

**N6. Supported platforms are never stated.** `core/notify.ts` shells to
`notify-send`/`osascript`; paths, `sep` and `git worktree` behave differently on Windows.
Declare macOS + Linux supported and Windows unsupported, rather than discovering it.

**N7. Config file has no schema.** M2 adds `.agent-team/config.json` with env override, but
says nothing about validating it or rejecting unknown keys. A silently-ignored
`stallIdleMs` typo is a watchdog that never fires.

**N8. `#send` ignores write backpressure.** Not a correctness bug today; worth a line when
fan-out starts moving large file contents.

**N9. `session/load` where a harness advertises it.** Correctly out of scope — but the plan
frames persistence as "history only, because ACP has no resume", which is true of the
protocol and not necessarily of every harness. Check `agentCapabilities.loadSession` during
M0 and record it; it is a cheap future win.

---

## Corrections to the plan text

- **Node version.** The plan states "Current runtime is Node v20.20.2, EOL since April
  2026." This checkout runs **v22.22.2**, which already strips TypeScript types by default
  (22.18+). The Node 24 bump is still worth doing for LTS, but it is not a prerequisite for
  running `.ts` — the toolchain story is smaller than the plan assumes.
- **Line count.** Brief says ~760, plan says ~800. Actual is **770** across the six `.mjs`
  files. Immaterial, but the brief's figure is the accurate one.
- **M1 is oversized.** Ten new modules, a toolchain migration, a port of five files, two
  new test doubles and a merge command in one milestone. It is coherent as a *destination*
  and unusable as a *unit of work*. `STORIES.md` slices it into three shippable stages
  (M1a core, M1b worktrees + results, M1c watchdog + merge), each of which ends somewhere
  demonstrable.
