# Story breakdown

`PROJECT-PLAN.md` reviewed against the code and sliced into deliverable stories.

## Where this came from

The plan was reviewed line by line against the source before being broken down. **It held
up.** The architecture is coherent, the decisions table records *why* rather than only
*what*, prior art is metabolised rather than copied, and every code reference in it
(`protocol/agent.ts`, `agents.mjs`, `render.mjs`) checks out. It was written with the code open.

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
3. **`node:test` is the unit-test runner** for pure functions (M1a-1), and — amended
   2026-08-31 — for behaviour whose subject is the wire itself.

## Reading a story

- **Size** — `XS` under 2h · `S` half a day · `M` 1–2 days · `L` 3–5 days.
- **Needs** — hard ordering only. Anything unlisted can run in parallel.
- **Gap** — what the plan left undefined, contradictory, or unowned. Present only where
  there is one.
- **Done when** — the observable check. If it cannot be observed, it is not a criterion.

## Decided before M1a starts

**Settled 2026-08-23 in the M0 retrospective (#62).** Eleven stories opened with a decision
rather than code: the ten below, plus **M2-2** (event log shape and cursor semantics), which
was and remains deferred to M2 planning — not past it, because M2-2's *size* depends on the
answer.

All ten are **ratified as written**, with four amendments found by walking them. They were
ratified rather than re-opened for a reason worth keeping: every one is a convention — a
timeout value, an id format, a status vocabulary, a git-ignore path — and M0's seven-for-seven
correction rate was entirely against claims about *what harnesses do*. Nothing M0 measured
touches any of these ten.

| story | outcome |
| --- | --- |
| **M1a-1** (`node:test`) | ratified |
| **M1a-3** (request timeout) | ratified, and the story grew three things: B3's usage capture, R4's cancel-intent event, R5's in-flight guard |
| **M1a-4** (registry `env` field) | ratified; gains `measuredOn` (B2) and the unverified-entry notice (B5) |
| **M1a-5** (`allowReadOutsideRoot`) | ratified; R1 resolved alongside it |
| **M1a-8** (ids and branch names) | ratified **with amendment** — the charset produced illegal git refs |
| **M1b-1** (`needs` rejected at M1) | ratified |
| **M1b-2** (`stopReason` mapping, `skipped`, roll-up ordering) | ratified **with amendment** — two statuses were unplaced in the ordering |
| **M1b-3** (`.kapelle/` git-ignore) | ratified **with amendment**, then **reversed 2026-09-20 (#129)** — state moved out of the repository |
| **M1b-4** (missing result block) | **decided** — the retro was right that only extraction had been settled, not disposition |
| **M1c-3** (`--rebase` deferral) | ratified |

**The labelling convention that stops this recurring:** text that has been decided reads
**`Decided <date>`**; text that is still a draft reads **`Proposed`**. B1 existed because the
two were indistinguishable. Each of the ten below now carries a date; story-local decisions
elsewhere in this file were not in the retro's scope and are unchanged.

---

## M0 — Reconnaissance

Builds nothing except three papercut fixes. Every M1 default depends on its findings.

### M0-1 · Harness availability and handshake survey · S · DONE

> Survey complete — `FINDINGS.md`, M0-1 section. All three targets **available**
> (opencode 1.18.18, claude-agent-acp 0.49.0, copilot 1.0.78), none unavailable, none
> untested. `loadSession: true` on all three. No harness calls `fs/*`. opencode never
> sends `session/request_permission` and wrote a file under `safe`. The stories below
> marked *(revised by M0-1)* changed as a result.
Run the current MVP against `opencode acp`, `claude-agent-acp` and `copilot --acp`. Record
per harness: does it spawn, does it complete a turn, which `session/update` variants arrive
that `render.mjs` does not handle, which methods hit the `#handleRequest` default
(`protocol/agent.ts`), and what `agentCapabilities` it advertises.
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
`copilot acp` → `copilot --acp` (`agents.mjs`). Bake `env -u CLAUDECODE` into the
`claude` entry (`agents.mjs`) — a two-line fix for a papercut `CLAUDE.md` documents at
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
Flip `clientCapabilities.terminal` to `true` (`protocol/agent.ts`), stub `terminal/*` as logging
no-ops in `#handleRequest`, and run each harness on "run the tests" in a throwaway
workspace under `--mode auto` — under `safe` the `execute` permission is denied before any
terminal call would happen.
*Done when* each harness has a recorded verdict on two **separate** questions: does
`terminal/create` ever arrive (scopes M3-5), and does it route commands across our boundary
with real argv or run them internally (populates the containment label). The second
outlives the first, which is why it is recorded separately.
**Done 2026-08-21** (`docs/FINDINGS.md` §M0-3). Two corrections to this text as written:
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
**Done 2026-08-21** (`docs/FINDINGS.md` §M0-4). Three corrections to this text as
written. The probe could not be a `run.mjs` run: its SIGINT path kills at 2 s
(`run.mjs`) and `#failAll` (`protocol/agent.ts`) would have turned any slower cancel into
an exit error, so the answer needed tooling that cancels and waits — plus an **uninterrupted
control run**, without which "the turn ended" cannot be told from "the turn was ending
anyway". The expectation about a second `session/prompt` is **false on all three**: none
rejects it, the in-flight turn dies, and both requests answer `end_turn`. And latency turned
out not to be the interesting number — everything landed inside 64 ms — while
**copilot reports `end_turn` for a turn it cancelled**, which is what actually moves M1b-2.

**M0-5 · Context window and usage reporting survey · S · needs M0-1**
*(refocused mid-story, 2026-08-22 — was "Usage reporting survey")*
Per harness: does `usage_update` arrive, and what do its fields mean? `{used, size}` is
context occupancy, not spend. **The focus is the context window: how much a task has left,
how reliable `size` and `used` are, and whether the harness marks "running out of tokens",
"no credits left" or a "90% used" warning at all.** Cumulative or billable counts and
anything naming the model actually selected are recorded too, but the price table they feed
is nice-to-have, not a deliverable.
*Done when* the note states, per harness, whether the context numbers can be trusted as a
budget and what exhaustion signal exists — and distinguishes occupancy from spend.
**Done 2026-08-22** (`docs/FINDINGS.md` §M0-5). Four corrections to this text as written.
The story's `{used, size}` shape is right but **incomplete**: `cost` (cumulative USD) rides
on the same notification from two of three harnesses, and `size` is per-model rather than the
constant M0-1 recorded. The **cumulative-or-billable count the story went looking for is not
on `usage_update` at all** — it is `usage` on the `session/prompt` response, populated by all
three, `UNSTABLE` in the schema and absent from the published docs, and **cumulative on
copilot where it is per-turn on opencode and claude-agent-acp**, which is the finding most
likely to produce a wrong number quietly. "Anything naming the model actually selected" is
**answered yes for all three**, in `configOptions` on the `session/new` response, not in
copilot's `config_option_update` — that notification only repeats what `session/new` said and
did not re-fire when we changed the model. And the survey needed a **second run per harness
on a different model**, not a longer turn: opencode's `cost.amount: 0` is the provider being
unmetered, proven only by switching it to a metered one, where the same field reported real
spend.
**The refocused question — can a supervisor see a task running out? — answers no on two of
three harnesses.** ACP has no quota, credit or threshold concept at all (schema 0.28.1), and
its only exhaustion stop reasons, `max_tokens` and `max_turn_requests`, appeared in none of
eleven sessions. **claude-agent-acp is the only harness that warns**, via a vendor `_meta`
extension (`_claude/rateLimit`: `allowed_warning`, `utilization`, `resetsAt`,
`credits_required`, `out_of_credits`) that `render.mjs` drops today and that we never saw
fire, being nowhere near a limit. copilot and opencode report consumption with nothing to
compare it against. So the threshold is **ours to compute** — and the survey found `size`
unfit for that denominator on two harnesses: claude reports 200k for the whole of a session's
first turn regardless of the real window, and copilot's 200000 matches neither its own
264k window nor the ~175k it leaves usable. Compaction is announced only in prose; on copilot
`used` drops silently one turn late, on claude it rose through one. **opencode emits
`usage_update` once per turn, at the end**, so it offers no in-turn context signal at all.

**M0-6 · Correct the safety claims · S** *(was XS; revised by M0-1)*
`CLAUDE.md` and `README.md` both say "even `--mode auto` cannot write outside the
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
*Done when* `CLAUDE.md` and `README.md` both carry the per-harness claim, name opencode
as uncontained, and no longer imply `#guardPath` bounds `--mode auto`.
**Done 2026-08-23** (`c4307f3`). One correction to the story as written: the claim lived at
**four** sites, not the two it names. And one thing nobody could have scoped — **the shipped
wording was measurably stale within hours.** M0-7 re-verified copilot on 1.0.80 and found it
now reads a named file through a native `read` tool that `safe` allows; the "shells `cat`,
so `safe` refuses its reads" half was true of 1.0.78 only. M0-7 carries the fix; this story
stays closed. The durable lesson is that a per-harness safety claim is a claim about a
**build**, and needs the version in the sentence.

**M0-7 · Findings note · XS · needs M0-1, M0-3, M0-4, M0-5**
`docs/FINDINGS.md`. The input to M1a-4's containment labels and env list, M1c-1's TTL
default, and M3-5's terminal scope.
**Partially landed with M0-1** — the file exists, the M0-1 section is complete, and the
M0-3/4/5 sections are stubbed with the partial input that survey already produced (no
`terminal/*` traffic under `terminal: false`; copilot supplying real argv on the permission
request; `usage_update` shapes, including `cost` on opencode alone).
**M0-3 and M0-4 filled 2026-08-21; M0-5 filled 2026-08-22. No sections remain — M0-7 is
unblocked**, and its assembly is now editorial: the note carries M0-1, M0-3, M0-4 and M0-5
in full, and the "incidental" usage paragraph under M0-1 is superseded by §M0-5 rather than
deleted, so the correction stays visible.
**Done 2026-08-23**, and it was not purely editorial. Assembly exposed that the note had no
cross-harness view — the plan's own M0 exit criterion (`PROJECT-PLAN.md`) asks its questions
per harness, and the answers were spread across four sections — so the note now opens with a
**roll-up table** (an index; the sections stay authoritative) plus a registry-evidence table
for M1a-4, and closes with what it does not cover. Two corrections beyond the plan:
copilot's column spanned **two builds** (M0-1 on 1.0.78, everything else on 1.0.80), which
M0-4's "pin the version next to every row" forbids, so this story **re-verified M0-1's
copilot checks on 1.0.80** (`spike/m0-7-reverify`) — finding three changed behaviours, one
of which falsified a safety sentence M0-6 had shipped the same day. And the mode ids the
M0-1 table abbreviates as `#agent`/`#plan`/`#autopilot` are **not the ids** — the full
canonical URL is, and the bare fragment returns `-32602`, which would have gone straight
into M1a-4's registry as a broken value.

**M0-8 · The `_meta.terminal_output` capability · S · needs M0-3 · DONE (resolved, not probed)**
**Added 2026-08-23, closed as docs reconciliation 2026-08-23** — `docs/PRIOR-ART-AGENTPOOL.md`
§8c found a second output channel that M0-3 could not have seen by varying only the
*method*, not the *capability*. AgentPool documents claude-agent-acp checking
`clientCapabilities._meta["terminal_output"] === true` at `initialize`. With it, a Bash
tool call was claimed to become a three-notification lifecycle carrying an **exit code**.
**Already measured — not a probe.** M0-3's own second commit, `87cbfe3` on
`spike/m0-3-terminal`, advertised `_meta.terminal_output: true`, and the result is recorded
at `docs/FINDINGS.md`: claude-agent-acp's Bash `tool_call` gains a `terminal_id`
and a `{type:"terminal"}` content block for a terminal that was **never created**, with
still zero `terminal/*` calls and **no command output crossing the wire**, and **no exit
code**. It is a rendering convention for a client that already draws the terminal, not the
visibility M0-3 called unobtainable. `argvChannel` therefore gains no fourth value, and
M1a-4 is not gated by this.
**Decision (2026-08-23): park, no further action.** The capability axis is settled for the
MVP; no backlog entry is scheduled. The record lives in §M0-3 (`FINDINGS.md`), which
already holds the finding, so no new §M0-8 is added to the findings note.

**M0-9 · `session/load` into a new harness process · S · needs M0-1**
**Added 2026-09-26.** M6-7b needs it. Every `loadSession: true` we hold
is a handshake claim (§M0-1). Nobody has loaded a session into a **new** harness process,
and pi-acp has no `loadSession` row at all (§pi-acp). For each installed harness: run a
turn that edits a file, stop the process, start a new one, `session/load` the session, and
ask about the earlier turn. Do it twice: once after a **clean stop** (cancel, then stop)
and once after a **kill during a turn**. The second case says what a `killed` participant
can reload: all of its memory, memory that is behind the files, or nothing.
*Done when* `docs/FINDINGS.md` §M0-9 records, per harness, whether the load works after
each of the two stops, and what the harness remembers after the kill.

---

## M1a — Toolchain and protocol core

Ends with: today's behaviour, in TypeScript, typed, both safety layers intact, and
`npm run selftest` still green.

**M1a-1 · Toolchain · S**
Node 24 in `engines`. `tsconfig.json` with `strict`, `erasableSyntaxOnly`, `noEmit`.
`typescript` as the only devDependency. `npm run check` → `tsc --noEmit`; `npm run test` →
`node --test`.
**Decided 2026-08-30 (ratified on #9): add `allowImportingTsExtensions` to the tsconfig
list.** Node type stripping requires imports to carry `.ts` extensions, and `tsc` only
accepts those under `noEmit` with this flag — without it the first ported file fails
`npm run check`. Scoped in the issue's comment (2026-08-23).
**Gap** — the plan states there is no unit-test framework and that it does not add one.
That rule predates the plan's own Node 24 decision. `node:test` and `node:assert` are
**built into the runtime**: using them adds no dependency, no devDependency and no build
step, so the zero-runtime-dependency survival trait the brief names is untouched. M1
introduces exactly the code end-to-end runs verify badly — mode precedence and ceiling
resolution, `<task-result>` extraction strictness, DAG toposort, merge overlap detection,
the watchdog's consecutive-repeat counter. Each is a pure function with a truth table, and
driving one through a subprocess handshake to check a boundary condition is slow and covers
little. **Decided 2026-08-23 (ratified, #62 B1): `node:test` for pure functions in `core/` and
`protocol/`; `mock-agent` and `hostile-agent` keep owning end-to-end and adversarial
coverage.** It is
why several stories below have a truth-table criterion rather than an end-to-end one.
**Amended 2026-08-31 (M1a-3, issue #11): subprocess-driven `node:test` is in scope where
the behaviour under test *is* the wire.** Some properties are statements about what does or
does not reach the subprocess, and a pure function cannot express them — M1a-3's own
ratified criteria require exactly that ("a second `prompt()` … throws **without a byte
reaching the subprocess**"), which is provable only by counting what a real harness
received. The pure-function rule stands everywhere else, and the boundaries are unchanged:
`mock-agent` still owns end-to-end runs (`npm run selftest`), and `hostile-agent` (M1b-6)
still owns adversarial coverage — M1a-3's `#guardPath` cases are the containment baseline it
builds on, not a replacement for it. The original justification does not hold for this
class: `protocol/tests/agent.test.ts` runs in about six seconds (measured 2026-08-31, most of it
deliberate waits proving deadlines fire), and every case is mutation-proven
(the mutant is recorded in the commit that added it) rather than merely green.
*Done when* both scripts pass on an empty test set and no build step exists. Note that Node 22.18+ and 24 already strip types, so this is a smaller lift than the
plan's Node 24 framing implies — the bump is for LTS, not for the language feature.
**DONE 2026-08-30** — `engines` `>=24`; `tsconfig.json` with `strict`, `erasableSyntaxOnly`,
`noEmit`, `allowImportingTsExtensions`; `typescript` the only devDependency; `npm run check`
and `npm run test` both green on the empty set; no build step. Two things the story did not
anticipate. **`tsc` cannot pass an empty input set** — `include` matching nothing is TS18003,
`files: []` is TS18002 — so `check` guards on file discovery and runs `tsc --noEmit` only when
a `.ts` file exists, printing the skip instead of failing; the mirror of `node --test`'s
empty-set pass. Verified with a throwaway smoke test: `node --test` discovers `core/tests/*.test.ts`
under `type: module`, and with files present `check` runs tsc and fails when it should.
**npm `latest` now resolves to TypeScript 7.0.2, the native (tsgo) compiler** — the flags
behave as ratified, the lockfile is new to the repo. **Open decision flagged on #9:** TS7
ships no Node globals, so the first real test file fails `check` until `@types/node` is
added — the "typescript as the only devDependency" rule never anticipated the checker
needing the runtime's types. M1a-2's `node:test` criteria trip on it; decide before that
story starts.
**Amended 2026-08-31 (#68): Biome format + lint lands on this toolchain.** `biome` devDep
(pinned via lockfile), `biome.json` (2-space, `recommended` preset), `fmt` → `biome check
--write .` and `fmt:check` → `biome check .`, an AGENTS.md rule, and CI running
`fmt:check` + `check` + `test` on push/PR. `tsc` stays the type checker, markdownlint stays
for `.md`, pi-lens stays the deeper session layer.
**Amended 2026-08-31 (M1a-3, issue #11): CI gained two steps and the repo a fourth
devDependency.** The push/PR job now runs `fmt:check` + `check` + `test` + `selftest` +
`knip`, with `timeout-minutes: 15` and `node --test --test-timeout=30000` so a subprocess
that goes silent fails the job instead of hanging it. `selftest` is there because
`npm test` alone never loads `protocol/agent.ts`, leaving the `.mjs` → `.ts` type-stripping
edge the whole client depends on with no automated cover. `knip` runs because it is the
tool pi-lens's knip lane merely reports, and that lane was observed serving stale findings
(see AGENTS.md, *Disproving a finding*) — the authoritative verdict belongs somewhere
reproducible. `knip` is pinned as a devDependency rather than fetched with `npx -y`, so an
upstream release cannot redden CI with no change here; the devDependency list is now
`typescript`, `@types/node`, `biome`, `knip`.

**M1a-2 · `protocol/types.ts` · M · needs M1a-1**
Hand-written definitions for every message we touch. The `session/update` discriminated
union is the point of the exercise: `update.sessionUpdate` was a bare string
compared in two places (`acp.mjs`, `render.mjs`) with nothing keeping them in sync.
**Decided 2026-08-23 (#62 B4): the types keep `_meta`, in both directions.**
`_meta?: Record<string, unknown>` on the **base** of the message types — inbound
notifications and responses, outbound requests alike — not on the variants that happen to
need it today. This answers the retro's B4. Three reasons it is decided here rather than
deferred. It is *preservation, not addition*: `protocol/agent.ts` already hands the whole update
object to `onEvent`, so `_meta` reaches consumers today and only `render.mjs` ignores it —
this port is where we would start losing it. The fleet's **only** exhaustion warning lives
there (`_meta["_claude/rateLimit"]`, `FINDINGS.md` §M0-5), M0-3 found harnesses gating
behaviour on `_meta` extensions we do not advertise, and M0-3's `87cbfe3` already recorded
the third (`terminal_output`). And
the cost of deferring is **not** a refactor — adding the field later is one line — it is
that every run recorded in the meantime has no `_meta` in its event log. Code is
recoverable; unrecorded data is not. Outbound is included so M1b-4 finds the door open when
it wants `_meta.claudeCode.options.systemPrompt.append`
(`docs/PRIOR-ART-AGENTPOOL.md`, §8d).
*Done when* adding a variant to the union makes `tsc` fail at every unhandled `switch`, and
a message carrying `_meta` round-trips through the types with it intact — dropping it fails
a `node:test`, rather than passing silently.
**Proposed, not decided** — `locations[]` on `tool_call` belongs in the union too
(`docs/PRIOR-ART-AGENTPOOL.md`, item 5). M0 never recorded whether any harness populates
it, so type it and let a probe decide whether `render` ever shows it.
**Decided 2026-08-30 (issue #10 review loop): the types stay a hand-written subset;
full-schema coverage is deferred, and the decision fires at M1a-5.**
`@agentclientprotocol/sdk` v1.4.0 (github.com/agentclientprotocol/typescript-sdk) ships
schema-generated types (`types.gen.d.ts`, ~6,150 lines), zod-backed runtime
deserialization and JSON-RPC framing — it is what `claude-agent-acp` is built on, and its
bundled `schema.json` was already M0's cross-check source. Within the subset we type,
everything is verified field-for-field against the schema as of the #10 review loop; the
remaining deviations are deliberate and recorded on the issue (`toolCall?` optional where
the schema requires it, `AvailableCommand.input` flattened, `usage` wire-measured and
absent from the schema). The strict union also **rejects the official modeling** on one
point: the schema's `SessionUpdate` is an extensible union with a custom catch-all, and we
keep no catch-all so `assertNever` exhaustiveness keeps working. Accepted risk, priced:
a harness on a newer schema sending an unlisted variant or enum value falls to `default:`
and is silently dropped — the same class as M0-1's dropped-variant finding. Criteria when
M1a-5 starts: (1) one small untyped surface (`session/set_mode`) argues for
hand-extension; three or more (elicitation, `terminal/*`, v2) for SDK-types-only or
codegen; (2) wholesale adoption costs the zero-runtime-dependency trait (zod peer dep);
(3) adopting the official types surrenders the `assertNever` pattern. Re-checkpoint at
M2-2 (event log) if M1a-5 hand-extends.
**Landed 2026-08-31 (#10).** The union is hand-written, `_meta` sits on the base of the
message types in both directions, and `assertNever` makes an unhandled variant a `tsc`
error. `locations[]` is typed on `tool_call` and `tool_call_update`
(`protocol/types.ts:201`, `:218`) but nothing reads it — the probe that would decide
whether `render` shows it never ran, and the type costs nothing while it waits.
**The types-coverage decision fired at M1a-5 and the answer was hand-extend.**
`session/set_mode` was the only surface M1 needed outside this file, which is criterion (1)
as written — one small addition, not three. It is typed at `protocol/types.ts:582`, the SDK
was not adopted, the zero-runtime-dependency trait is intact, and `assertNever` still works.
Per the rule above, this hand-extension re-opens the checkpoint at **M2-2**, the event log
(written as M2-1 before the stories were renumbered; corrected at M2-1's pickup, #31).
**Checkpoint closed at M2-2 (2026-09-14, #32): keep the hand-written types.** All three
criteria say keep: the event log adds no ACP surface (its three new variants are
`_client_` events), the SDK would add `zod`, and the log needs `assertNever` most. The log
does not depend on the types either — `protocol/agent.ts` forwards every `session/update`
as it arrived, unlisted variants included. The next checkpoint is a story that adds three
or more untyped protocol surfaces.

**M1a-3 · Port `acp.mjs` → `protocol/agent.ts` · M · needs M1a-2**
Essentially intact. Both invariants preserved verbatim: the `toolCallId → {title, kind,
rawInput}` map (`protocol/agent.ts`) and `#guardPath` (`protocol/agent.ts`). The single `onEvent`
callback becomes typed (`EventSink`, over an envelope wrapping the `AgentEvent` union)
rather than an
emitter — **amended 2026-08-31**: a multi-listener emitter has no consumer, and
the event bus proper is M1a-6's `core/events.ts`. Applies the registry's env
mutation (M1a-4).
**Gap** — `AcpAgent.request()` never times out, and `#failAll` fires only on process close.
A harness that spawns, accepts the pipe and never answers `initialize` hangs the task
forever. The watchdog's TTL rung covers *running* tasks, so it structurally cannot see a
task stuck before it started — and under a daemon there is no `^C` to fall back on.
**Decided 2026-08-23 (ratified, #62 B1): a per-request timeout on the handshake and
session-management methods, default 30s, explicitly not on `session/prompt`**, which is
legitimately long-running and is what the watchdog is for. M0-1 measured the slowest
handshake step at 3.0 s (copilot's `session/new`), so 30 s is an order of magnitude above
the worst observed. Extend it to `session/load` if that lands — same class of call.
**Decided 2026-08-31 (measured), the timeout's sibling** — the timeout catches a harness
that is *alive but silent*; nothing caught one that **dies mid-handshake**. `#failAll`
(`protocol/agent.ts`) reported a bare exit code, and the harness's own explanation went to a
stderr we discarded unless `--verbose`. AgentPool races every handshake RPC
against `process.wait()` and raises with the captured stderr
(`utils/subprocess_utils.py:126`, used at `acp_agent.py:278`). **We now retain stderr
unconditionally and attach all of it to the rejection.**

**The measurement moved this decision twice, and is why it is no longer a ring buffer.**
Run against all three harnesses on 2026-08-31 (raw captures on issue #11):

1. **The premise was wrong.** All three complete `initialize` with an *empty home
   directory* — credentials are not checked during the handshake, they are checked at turn
   time. "Dies mid-handshake because it is not authenticated" is not a reachable failure.
   The reproducible killers are a bad argv (copilot: exit 1, 3 lines) and a poisoned node
   environment (claude: exit 1, 22 lines) — the latter being the same class of problem as
   M0-2's `CLAUDE_PARENT_ENV` scrub. opencode survives both, being a native binary.
2. **`~20` and *tail* were both guesses, and tail was the wrong end.** claude's actionable
   line (`Error: Cannot find module …`) sits **17 lines from the end** of node's
   MODULE_NOT_FOUND banner; opencode answers a bad flag with an 18-line usage dump and *no
   error sentence at all*. A tail-10 window would have captured stack frames and
   `Node.js v24.20.0`. Nothing in the implementation prefers the tail.
3. **Bounding buys nothing today.** Through a complete turn, every harness in the
   registry's configuration emits **zero** stderr bytes. Only `opencode acp --print-logs
   --log-level DEBUG`, which we never pass, produces volume — 45 lines in 7.2 s, about
   11 MB per agent per four hours. So retention is unbounded for now and trimming it is on
   the backlog rather than in this story.

Note M0-2 retired the papercut that originally motivated this (the `-32603` does not
reproduce on 0.49.0), so the case rests on this gap alone, and on CI, where nobody is
watching a terminal.
*Done when* `npm run selftest` passes unchanged; a mock that accepts the pipe and never
answers `initialize` fails the task in ~30s instead of hanging; a mock that exits during
`initialize` fails with its own stderr in the message rather than an exit code; and
`node:test` covers `#guardPath` — in-root, escaping `../`, absolute-outside, symlink, and
the read/write asymmetry under `allowReadOutsideRoot`.
**On `#guardPath`'s tests, given R2** — M0-1 measured zero `fs/*` traffic, so the guard
binds nothing in production and the retro asks whether testing it is misplaced effort. Keep
them: the mock drives them for free, and the cost is minutes. What that same finding does
settle is that **no pluggable backend goes underneath it** — `docs/PRIOR-ART-AGENTPOOL.md`
item 7 considered one and reversed itself, because an abstraction under dead code is R2
exactly.

**Decided 2026-08-23 (#62 B3): keep the whole `session/prompt` response, not just
`stopReason`.** **Landed.** The client returned `res.stopReason` and discarded the rest — including
`PromptResponse.usage`, which M0-5 found is the **only per-task token count present on all
three harnesses**. Returning the whole response is one line, and a count nobody recorded is
not recoverable afterwards; this is the same argument as `_meta` in M1a-2. **Capture only —
M1 renders no token figure from it.** It is `UNSTABLE` in schema 0.28.1, absent from the
published docs, and **cumulative on copilot where it is per-turn on the other two**, so
M1a-4 records the semantics per harness (`usage: "per-turn" | "cumulative" | "absent"`) and
M1b-4 renders only what the registry vouches for.

**Decided 2026-08-23 (#62 R4): emit a cancel-intent event where the cancel is sent.**
M1b-2's status keys on the triple (`stopReason`, did we cancel, did the watchdog fire)
because copilot answers `end_turn` for a turn it cancelled — so the supervisor's own record
is the authoritative term. `cancel()` emits `_client_cancel_requested` on the bus at the
moment it sends `session/cancel`, using the existing `_client_` convention
(`render.mjs`). Without it, M1b-2 retrofits an event into an already-typed bus.

**Decided 2026-08-23 (#62 R5): a second prompt is made impossible, not discouraged.**
`AcpAgent` carries an in-flight flag; `prompt()` **throws** when a turn is running rather
than sending. M0-4 measured why: all three harnesses accept a second `session/prompt`, kill
the running turn and answer `end_turn`; on opencode and copilot the text lands in the
running turn's context and reads as prompt injection; copilot aborts unconditionally even
when idle (`github/copilot-cli#4555`). AgentPool has no such guard, so there is no prior art
to copy. **The API half is part of this decision:** M2 exposes no endpoint that messages a
running task.
**Scope, measured 2026-09-15 (`docs/FINDINGS.md` §Multi-turn).** The guard refuses a
prompt *during* a live turn, and only then. A second prompt sent after `end_turn`
completed on the same session on opencode, claude-agent-acp, copilot and pi-acp, with the
first turn's context intact. The API half reads the same way: no endpoint messages a
*running* task. Copilot's #4555 still aborts background work on any prompt, so the retry
above stays struck.
*Done when* (in addition to the criteria below) a second `prompt()` during a live turn
throws without a byte reaching the subprocess, covered by `node:test`.
**Landed 2026-09-02 (#11).** All five behaviours are in and each has a subprocess-driven
test in `protocol/tests/agent.test.ts`: the 30s deadline on the handshake and session-management
calls but never on `session/prompt`, unbounded stderr attached to a mid-handshake death,
the in-flight guard, the whole `PromptResponse`, and `_client_cancel_requested`.
**One `#guardPath` case did not pass, deliberately.** A symlink pointing out of the root was
followed: `path.resolve` is string arithmetic and never touches the filesystem, so
`link.txt` looked in-root. The test recorded what the guard did rather than what it
should do, and M1b-6 closed it on 2026-09-08 — `realpath` on both root and target before
the prefix check, and the assertion is now `refused`. The other four cases — in-root,
escaping `../`, absolute-outside, and the read/write asymmetry under
`allowReadOutsideRoot` — passed all along.

**M1a-4 · `protocol/registry.ts` · M · needs M1a-3, M0-7**
**Re-sized S → M, 2026-08-23.** The decision was ratified unchanged; the estimate was not.
This entry now carries `env`, `defaultMode`, `maxMode`, `shell`, `asksPermission`,
`argvChannel`, `modeMap`, `measuredOn` and `usage` — eight fields across six revisions, and
Split the launch spec from the measured labels
if it grows again.
Today's `AGENTS` map plus `defaultMode`, `maxMode` and the containment label
(`shell: "terminal" | "internal" | "unknown"`, from M0-3). Mode ordering is the total order
`safe < ask < auto`.
**Gap** — `AcpAgent` passes `process.env` wholesale to every subprocess, and M0-2 needs
`env -u CLAUDECODE` baked into a registry entry that has nowhere to put it. This sharpens
under the daemon: M2-8 introduces a shared secret, and a daemon holding that token in its
environment would hand it to every harness it spawns. **Decided 2026-08-23 (ratified, #62 B1): add `env?: { unset?: string[]; set?: Record<string,string> }` to registry entries**; M2-8 also
strips `KAPELLE_*` unconditionally.
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
**Decided 2026-08-23 (#62 B2 and B5), two additions from the AgentPool review.** First,
**`measuredOn: { version, date }` beside the labels**, compared at startup and **warning
only — never failing a run**. This is the retro's B2: every field here is a claim
about a *build*, and M0-7 watched three of them change in three days. AgentPool has no
equivalent — but it does resolve harnesses through the ACP registry with a **pinned**
distribution (`registry/model.py:126`, `registry/prepare.py:38`), and pinning is what would
turn a staleness *warning* into a property, since we would run the build we measured. The
auto-resolving half of that idea is explicitly **not** proposed — a launcher that silently
fetches "latest" from a CDN is the opposite of what a measured registry needs; it sits in the
backlog. Second, **name the `_meta` capability flags** the entries carry: AgentPool
catalogues `terminal_output` and `terminal-auth` on `ClientCapabilities`, with per-harness
consumers (`docs/PRIOR-ART-AGENTPOOL.md`, §8c–8d). Carry the provenance caveat with them —
those are their citations into source we have not read, and `87cbfe3` already put the
`terminal_output` one on the wire (see §M0-3).
**Check first whether `measuredOn` is nearly free:** `initialize` returns `agentInfo` and
`protocol/agent.ts` already stores it. If all three harnesses populate `agentInfo.version`, the
staleness check is a string comparison at handshake and needs no probe; if not, it needs a
`--version` call per harness. M0-1 captured `initialize` in full, so the answer is in the
spike logs — read them before designing the field.
**B5, decided the same day: `omp`, `pi` and `gemini` stay, and the absence of `measuredOn`
is what marks them unverified.** One mechanism, no second flag to drift out of sync. Their
*command lines* are real knowledge (`gemini --acp`, the `pi-acp` package); only the
containment labels are guesses, and dropping the entries would discard the first to disown
the second. `run` prints one line — "no measured labels for this harness" — when the
selected entry has no `measuredOn`, and the `unknown` → `internal`/`none` rule below keeps
the claim conservative.
**Amended 2026-09-09: `pi` now has a measured half** (pi-acp 0.0.33 / pi v0.85.1). The
B5 mechanism is unchanged — `omp` and `gemini` still stay unverified by absence — but pi's
measurement added a new shape: a measured entry can omit `modeMap` when the harness's ACP
modes are not safety/behaviour modes (pi exposes thinking-effort levels). `modeMap` is now
optional in `MeasuredLabels`; `safe` skips negotiation when it is absent.
**Also carries the `usage` field decided in M1a-3 (#62 B3)**: `"per-turn" | "cumulative" |
"absent"`, measured — copilot is cumulative, opencode and claude-agent-acp are per-turn.
*Done when* `unknown` behaves as `internal` for warning purposes, so a harness M0-1 could
not verify produces the **conservative** claim rather than the optimistic one — and an
`asksPermission: false` harness warns even in `auto`, where the containment warning would
otherwise be silent but the silent-autonomy risk is highest.
**Done 2026-09-02 (#12).** Three notes for whoever reads this next.
**The entry is split in two**, per the re-size note above: `launch` (`command`, `args`,
`env?`) is a recipe we choose; `measured` is a lab report about one build. The split is what
makes B5 free rather than a rule to remember — an unverified harness simply has no
`measured`, so it cannot be filled with plausible-looking `unknown`s, and every consumer is
forced by the type to handle its absence. A `--cmd` spec has no measured half either, and
warns as unverified for the same reason.
**The `measuredOn` "check first" could not be run.** It sends the reader to M0-1's captured
`initialize` for `agentInfo.version`; those captures are not in the repo (the `spike/m0-*`
branches kept only their probes) and `docs/FINDINGS.md` records the handshake without
`agentInfo`. So the literal comes from the version rows in that note, and the check compares
against `agentInfo.version` when the harness sends one and stays silent when it does not —
warning only, never failing a run, as B2 decided.
**M2-8's `KAPELLE_*` strip collides with M0-2's identity return**, and secrecy wins:
`resolveEnv` returns `base` by identity only when the entry declares no `env` **and** no such
variable is set. Both properties are asserted in `protocol/tests/registry.test.ts`.
`terminal-auth` was deliberately **not** recorded. It is not one flag but two directions —
opencode gates on it as a *client* capability we would have to advertise (untested, and we
advertise `terminal: false`), while copilot *sends* it on its auth method with a real
`copilot login` command. The second arrives fresh at every handshake, so recording it would
only let it go stale. It belongs to M2-8 / M4-3, where a daemon with no TTY needs it.
**The startup notice ships here, not in M1a-7.** `run.mjs` prints `warningsFor`'s lines to
stderr after the handshake — unconditionally, `--quiet` included. M1a-7's remaining work is
the shape, not the decision to surface — and per M1a-5's ratified decision (2026-09-02) the
containment line stays `--quiet`-blind there too; only the unverified-harness and
version-staleness lines may be quieted.

**M1a-5 · `core/policy.ts` · S · needs M1a-3**
**Decision trigger (2026-08-30, #10): this story is where the types-coverage decision
fires** — `safe`'s negotiate half needs `session/set_mode`, the first surface outside
M1a-2's types. Hand-extend if `set_mode` is the only addition M1 needs; otherwise apply
the criteria recorded under M1a-2 (2026-08-30).
Small in lines, load-bearing. The signature changes from `async () => boolean` to a form an
external asynchronous decider can answer, so M2-3's `ask` works with no TTY.
`READ_ONLY_KINDS`, `safePolicy` and `autoPolicy` semantics are unchanged (`core/policy.ts`).
**Gap (raised 2026-09-02, Copilot review of PR #72) — `pickOption`'s zero-match tail
fails open.** When the policy denies but the harness's option list carries no reject kind,
the tail `options[0]?.optionId` returns whatever sits first, which can be an
`allow_once`/`allow_always` id, turning a denial into approval on the wire. The behaviour is
verbatim from `acp.mjs` — the M1a-3 port preserved it — so it is not introduced there, but
unlike `#guardPath` this code is live: claude and copilot both send
`session/request_permission` (M0-1).
**Decided 2026-09-02 (measured, raw captures on issue #13): return `cancelled` when no
option matches, and `selected` only when one does.** Measured against claude-agent-acp
0.49.0, copilot 1.0.80 and opencode 1.18.18, one `edit` request each plus one `execute`
request from copilot:

1. **The tail does not fire today.** Both asking harnesses sent exactly three options and
   always included `reject_once`. opencode sent none at all — zero permission requests, and
   it wrote the file over our denial, as M0-1 found.
2. **Its worst case is worse than "allow".** claude orders the list `allow_always`,
   `allow_once`, `reject_once`, so a zero-match denial would select *Always Allow all
   Write* — a persisted grant, not a single approval. copilot orders it `allow_once`,
   `allow_always`, `reject_once`. Nothing in the protocol makes reject-presence or ordering
   a guarantee, so the tail is one harness build away from live.
3. **`cancelled` is accepted by both.** Answering `{outcome:"cancelled"}` produced no file,
   no protocol error, and a clean `end_turn` on claude and copilot alike. Note the spec
   frames `cancelled` as the *turn-cancelled* response
   (`agentclientprotocol.com/protocol/tool-calls`), so this reuses it for a case the spec
   does not name; the measurement is what justifies it, and a matching reject option is
   still preferred whenever one exists.
4. **`stopReason` stayed `end_turn` in every arm** — deny, cancel and allow alike. It
   carries no signal about refusal, which is M1b-2's premise measured a second time.
**Gap** — `AcpAgent` takes `allowReadOutsideRoot` (`protocol/agent.ts`), which disables the
read half of the path guard, and the plan's entire safety discussion never mentions it: not
in the schema, not in the precedence chain, not under the harness ceiling. What lives
outside a workspace root is exactly `~/.aws/credentials`, `~/.ssh`, and the parent repo's
`.env`. **Decided 2026-08-23 (ratified, #62 B1): name it in the schema, resolve it through the same
`task > run > harness > default` chain, default `false`, and have `safe` force it `false`
regardless of what was asked for** — `safe` claiming read-only while reading an SSH key is
precisely the overclaim M0-6 exists to stop. (Worth knowing it binds nothing in production
today for the same reason `#guardPath` doesn't — no harness calls `fs/*` — and is correct
the day one does.)
**Decided 2026-08-23 (#62 R1): the mode keeps the name `safe`; the notice carries the
honesty.** R1's objection stands on the evidence — after negotiation and filtering, `safe`
is defence in depth with no enforcement guarantee: against opencode the filter never fires
because it never asks, and the one refusal we measured arrived as agent prose. Renaming it
(`restricted` was the candidate) was considered and **rejected in favour of familiarity**.
That choice has a consequence this story owns: **the containment notice is now the only
thing carrying the caveat, so it must be non-suppressible** — no `--quiet` suppression, no
"seen it once" memory (re-affirmed 2026-09-02 on #13, and now recorded in M1a-4 and M1a-7 so
the port cannot quietly drop it) — and the docs' per-harness wording from M0-6 is load-bearing rather
than explanatory. If the notice ever becomes optional, R1 is back.
**Revised by M0-1 — `safe` gains a second half: negotiate, then filter.** Setting the
harness's nearest restrictive mode via `session/set_mode` at session start is what gives
`safe` any effect at all on a harness that never asks (measured: opencode wrote the file
without negotiation, declined with it). Filtering by kind stays exactly as specified and
runs on whatever still arrives. Mode ids come from M1a-4's `modeMap`. Defence in depth, not
a sandbox — the refusal we measured was agent prose, so enforcement is not verifiable from
our side.
Two further measured facts bear directly on `READ_ONLY_KINDS`. First,
copilot shells out to *explore*, so `ls`/`find` arrive as `execute` kind and `safe` refuses
them, killing any task that has to look around — while a read of an already-known path goes
through a native `read` tool that `safe` allows. Safe mode does not make copilot cautious;
it cripples it, and the failure presents as a clean `end_turn` with no output.
**Re-verified 2026-08-23 and build-specific** — on 1.0.78 copilot shelled `cat` for reads
too and `safe` refused those as well (`FINDINGS.md` §M0-1, "What re-verification
changed"), which is the strongest available argument that `argvChannel` and the kind
mapping must be *measured per build*, not assumed. Second, opencode
asks nothing, so no policy value changes its behaviour at all. Keep `READ_ONLY_KINDS` as
it is — kind is the only thing the protocol gives us — and let M1a-4's `defaultMode` carry
the per-harness adjustment, but say plainly in the docs that mode is advisory against a
harness that never asks.
*Done when* a `node:test` truth table covers precedence `task > run > harness > default`, the
`maxMode` ceiling raising a **validation error naming both values** rather than downgrading
silently, and `safe` overriding a requested `allowReadOutsideRoot: true`.
**Landed 2026-09-02.** Three deviations worth knowing. (1) `autoPolicy` is *not* exported —
`policyFor(mode)` is the only map from a mode to a decider, and a second copy of that map in
each entry point is what the move was meant to remove. (2) `AcpAgent`'s default policy is
deny-all, not `safePolicy`: `core/` imports `protocol/` and never the reverse, and a client
with no decider attached should be the contained one. (3) No `--allow-read-outside-root`
flag — the run layer resolves it, but the surface that sets it is M1b-1's run file, and a
CLI flag now would be a second place to keep in step. Verified end to end: opencode 1.18.18
wrote the file under `safe` before this story and declines after it, still as agent prose.

**M1a-6 · `core/events.ts` · S · needs M1a-2**
Typed bus carrying agent events plus supervisor events (task started, worktree created,
permission pending, stall warning, task finished, containment warning). The `_client_`
prefix convention is retained for client-originated events (`render.mjs`).
**Decided 2026-08-23 (#62 B4): the bus carries the wire object, not a rendered form** — `_meta`
included, per M1a-2. Consumers render *from* it; nothing renders *into* it. Two things
depend on this that are cheap now and awkward later: M2's persisted event log can only
replay what it recorded, and `session/load` — which all three harnesses turn out to support
(`loadSession: true`, two adding `resume` and `fork`) — needs a faithful record to replay
*from*. When replay lands, it also needs its own collection buffer rather than pushing into
the live queue; AgentPool's `is_loading` / `finish_load` split
(`agents/acp_agent/session_state.py:58`, `:91`) is the shape.
*Done when* every consumer — CLI render, and later persistence and SSE — subscribes, and
nothing reads agent state directly. This is the invariant that makes M4 purely additive.
**Landed 2026-09-03 (#14).** At the time both entry points subscribed and neither read agent
state: `run.ts` attached `render`, and `fanout.mjs` attached its own buffering listener
(`fanout.mjs` was retired in M1b-8). **Not
`node:events`** — `EventEmitter.emit` propagates a listener's throw and skips the listeners
behind it, so one broken renderer would take the run down; a `Set` and a `try` is less code
than wrapping every handler.
**None of the six supervisor variants landed, because five have no producer.** Task started,
worktree created, permission pending, stall warning and task finished are sent by files that
do not exist yet (M1b-2, M1b-3, M1c-1); each story widens the union when it lands its own
producer.
**Amendment 2026-09-06 (#19): the union is widened once, by the first consumer — not by
each producer.** M1b-2 landed its two producers without adding a variant, and M1b-3 landed
`worktree created` the same way, so "each story widens the union" had already stopped being
true twice. Widening it costs a supervisor/agent discriminated union plus every listener
that destructures `update` — five call sites at the time (two in `run.ts`, one in
`fanout.mjs`, two in `core/run.ts`; `fanout.mjs` is gone since M1b-8) — and buys nothing
while no consumer subscribes.
Landing one of the three would not have stopped that backlog accumulating, only shortened
it by one. The first real consumer (`core/notify.ts` M1c-4, M2's persisted log, M4's SSE
stream) pays the cost once for all three. The sixth, the containment warning, deliberately stays on stderr: routing it
through the bus would put it behind a sink `--quiet` can switch off, and #13 says that line
is never silenced.
**Renamed 2026-09-06 (M1b-2 review): `subscribe` → `addListener`.** Not a correction —
`bus.subscribe(fn)` is RxJS's shape and reads fine on its own. It reads *backwards* in a
sentence: `taskBus.subscribe(runBus.emit)` sounds like the task bus subscribing to the run
bus, when the run bus is the one being added as a listener. `addListener` also matches this
file's own `BusListener` type, which `subscribe` did not. Done now because the cost only
grows: five production call sites today, and M2's persisted log, M4's SSE stream and
`core/notify.ts` each add one. Mechanical — 14 sites, no behaviour change.
**Landed 2026-09-14 (M2-2, #32):** the persisted log widened the union with three
`_client_` variants — task started, worktree created, task finished — emitted by
`core/run.ts`. They joined the existing `_client_` events in `AgentEvent`, so no listener's
destructuring changed. Permission pending had already landed with M1c-4.

**M1a-7 · Port `render.mjs` and `run.mjs` · S · needs M1a-6**
`run.ts` keeps driving in-process, TTY `ask` intact.
**Proposed (2026-08-23): give `mock-agent` a `--emit <variant,…>` flag** so every branch of
the renderer has an offline driver. This is what makes M1a-2's discriminated union provable
at runtime as well as at compile time, and M0-1 named the gap precisely: `plan` is emitted
by **no** harness, while `available_commands_update` (all three) and `config_option_update`
(copilot) arrive and are dropped. Three render paths, one flag. AgentPool ships the same
idea as a web panel that fires any notification type at a client under test
(`src/acp/agent/implementations/debug_server/`); we need the capability, not the panel.
*Done when* `npm run selftest` runs `run.ts` and passes — the plan's verification section
requires it stay green across the port, and it currently invokes `run.mjs` — and the
notice M1a-4 already prints at startup (multi-line, `--quiet`-blind) is refined to a
one-line notice when starting `safe`/`ask` against a `shell: "internal"` harness.
**Decided 2026-09-02 (#13): that containment line is never silenced.** #62 R1 kept the name
`safe` and paid for it by making the notice the only carrier of the caveat, so `--quiet` must
not suppress it — no flag, no "seen it once" memory. `--quiet` may drop the other two lines
`warningsFor` can emit (unverified harness, stale `measuredOn` version). If the containment
line ever becomes optional, R1 is back and the mode needs renaming.
**Landed 2026-09-03.** The split above needed a mechanism: `warningsFor` returned an
untagged `string[]`, so the printing side saw three indistinguishable lines and could only
choose all or none. It now returns `{kind, text}` with `kind` one of `containment` /
`unverified` / `version`, and `run.ts` drops everything but `containment` under `--quiet`.
Keeping the rule inside `warningsFor` rather than splitting it into two functions is what
keeps "which line is silenceable" in one place. Verified both directions end to end:
`--cmd "node mock-agent.mjs" --mode auto --quiet` prints nothing, opencode 1.18.18 under
`--mode safe --quiet` still prints its never-asks line.
**Follow-up, 2026-09-04 — thinking is streamed, not one prefixed line per chunk.**
Found by hand against opencode, which is the only way it could have been found: the
renderer gave every `agent_thought_chunk` its own `[agent] thinking:` line and trimmed each
chunk, and a real harness sends one thought as a dozen small chunks. The result was a stack
of prefixes each cut mid-sentence, with the joining spaces deleted. `mock-agent.mjs` sends a
thought as a single chunk, so `npm run selftest` showed nothing wrong — the same blind spot
`--emit` was proposed for, arriving from the other direction.
Thinking now streams like prose, dim, with the prefix printed **once per run of thinking**
rather than once per chunk; the prefix is kept, since it is what separates thinking from
what the agent is actually saying. The renderer tracks which of the two streams is open so
either can close the other's line.
**This is the first `tests/render.test.ts`.** Every other branch of the renderer is eyeballed
through `selftest`, which is exactly why this shipped, so the state machine gets a real
check: many chunks produce one prefix, switching between thinking and speaking closes the
open line, and a `line()` event never lands mid-sentence. Mutation-proven — restoring the
one-line-per-chunk form fails three of the four.

**`--emit` did not land; the coverage it was for did.** The proposal's premise was checked
against the code and is partly stale: `plan` *is* driven offline (`mock-agent.mjs` emits it),
and `available_commands_update` / `config_option_update` have no branch in `render.ts` at
all, so driving them would assert only silence. The branches genuinely undriven were three
others — `agent_thought_chunk`, `tool_call_update` with `status: "failed"`, and the `diff`
content the `±` line is drawn from. All three are now in `mock-agent.mjs`'s ordinary script:
a thought chunk, an unconditional failing `t4`, and a `diff` on the write's completion when
the write actually happened. `npm run selftest` alone reaches every branch of `render.ts`
except the refusal colours, which `--mode safe` reaches. **A flag was not needed** — the
fixture had room, and M1b-5 rewrites this file anyway. The `--emit` proposal is therefore
closed as answered, not deferred.

**M1a-8 · `core/ids.ts` · XS · needs M1a-1**
**Gap** — `kapelle merge <runId>` operates on branches, retention promises "the branch
always survives", and worktrees live at `.kapelle/wt/<runId>/<taskId>` — yet the plan
gives no format for `runId`, no charset constraint for `taskId`, and **no branch naming
convention at all**, so merge has no defined way to find the branches belonging to a run.
Three things depend on it: filesystem path safety, git ref legality, and branch discovery.
**Decided 2026-08-23 (ratified with amendment, #62 B1):** `runId` =
`YYYYMMDD-HHMMSS-<4 char base36>` (sorts chronologically, readable in a path, collision-safe
within a second); `taskId` validator-enforced **`^[a-z0-9][a-z0-9_-]{0,63}$`**; branch =
`kapelle/<runId>/<taskId>`. Merge discovers branches by reading the run's own persisted
record, **never** by reconstructing names.
**Amendment — `.` removed from the task-id charset.** The original `[a-z0-9._-]` admitted
ids that are illegal as git refs, which the *done when* below explicitly requires to survive
`git check-ref-format`: `plan..impl` (refs may not contain `..`), `impl.` (may not end in a
dot) and `build.lock` (no component may end in `.lock`) all passed the validator and would
have failed at branch creation — after the worktree existed. Dropping the dot closes all
three with one character and keeps ids readable; underscore remains available.
*Done when* an illegal task id is a validation error rather than a silently sanitised one —
the id in the run file is the id everywhere — and branch names round-trip through
`git check-ref-format`.
**Landed 2026-09-04 (#16).** `newRunId`, `assertTaskId` and `branchName` in `core/ids.ts`,
with the amended charset. An illegal id throws and is never sanitised, and minted branch
names are fed to real `git check-ref-format` in the test rather than to a regex that agrees
with the validator by construction (`core/tests/ids.test.ts:69`). The three ids the dropped dot
was removed for — `plan..impl`, `impl.`, `build.lock` — are cases in that suite.

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
worst failure shape available. **Decided 2026-08-23 (ratified, #62 B1): M1 rejects a non-empty `needs` with an explicit
"task dependencies land in M3" error**, and likewise a `worktree` value implying
inheritance. The schema stays stable; the behaviour never lies. M3-1 lifts the rejection.
**Gap 2** — nothing in the plan bounds concurrency. A parallel-split run file with twelve
tasks spawns twelve harnesses, twelve model subscriptions and twelve worktrees at once.
**Decided 2026-08-23 (ratified, #62 B1): `maxConcurrency` on the run, default from config
(suggest 4)**, enforced by M1b-2.
**Amendment 2026-09-05 — run files are JSON only; the `.ts`/`.mjs` loader is dropped.**
Of the three entry paths, only the module form executes code: `await import()` runs every
line of the file before the validator ever sees the object it exports. Measured here against
this repo's own modules — an imported run file read `KAPELLE_*` out of `process.env` and
added `edit` to the shared `READ_ONLY_KINDS` Set (`core/policy.ts:41`), after which
`safePolicy` approved edits for every task in the run, while the object it exported still
validated cleanly. A `cmd` subprocess can do neither: `resolveEnv` strips the secret
(`protocol/registry.ts`) and it holds no reference to the client's own state. The two
things the module form bought — a loop over tasks, and `satisfies Run` while authoring —
survive without it, in a generator script the developer runs to emit the JSON; a benefit
available on both sides was never a reason to accept the risk. So the entry paths are
**`.json` file and POST body**, and **nothing in the tool imports a run file**. Three
consequences: the import failure modes in *done when* below no longer exist; the
`.ts`/`.json` twin criterion becomes file-vs-POST-body; and M1b-1 ships no loader, which
retires the CLI/daemon asymmetry rather than policing it. An optional `note` field on the
run and on each task carries what JSON comments cannot.
*Done when* a non-empty `needs`, and a `worktree` value implying inheritance, are rejected
with an error naming M3 — not ignored; a `.json` run file and the same run as a POST body
validate to the same object; mode and ids come from `resolvePolicy` and `assertTaskId`, and
duplicate task ids are rejected; a run file above a harness `maxMode` is rejected naming
both values, before any subprocess starts; `maxConcurrency` defaults to 4, and a non-integer
or a value `< 1` is a validation error; and a run file driving `mock-agent.mjs` validates
offline, so M1b tests stay offline. Nothing in the tool imports a run file: the CLI reads a
`.json` file and the daemon receives a POST body. Importing is executing, and that boundary
is the whole difference between a convenience and a remote-code-execution hole.

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
gates on this. **Decided 2026-08-23 (ratified, #62 B1) — one table, in this module:**

| stopReason | status | note |
| --- | --- | --- |
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
**Decided 2026-08-23 (ratified with amendment, #62 B1): add `skipped` to the terminal
states**; a failed, timed-out or cancelled task marks every transitive dependent `skipped`
(M3-1); run status = worst task status, ordered
**`done < warned < cancelled < skipped < timed_out < failed`**. Reserve the field name
`continueOnFailure?: boolean` now — **defer the behaviour** — so adding the escape hatch
later is not a schema break.
**Amendment — the ordering was missing two of its own statuses.** It read
`done < warned < skipped < failed`, while the lifecycle has five terminal states, so a run
whose only bad task timed out had no defined run status. The two are placed by how much they
should alarm someone reading a summary: `cancelled` is operator-intended and ranks mildest
of the bad states; `timed_out` means the supervisor cut a task off mid-tool-call, with the
same "half-written file on disk" hazard the table records for `max_tokens`, so it ranks just
below outright failure.
**Added 2026-09-05 — a JSON Schema for the run file, as an authoring aid only.** M1b-1
dropped the `.ts`/`.mjs` run file, and with it `satisfies Run` while writing one. A JSON
Schema gives that back: a `$schema` line at the top of a run file, and the editor completes
field names and marks bad ones as they are typed. It is **not** a second validator.
`validateRun` stays the only check that runs, because a schema cannot fill defaults, cannot
reach the agent registry for `resolvePolicy` and the `maxMode` ceiling, cannot apply
`assertTaskId` or spot a duplicate id, and cannot say "task dependencies land in M3" — and
checking one at runtime would need a library such as `ajv`, against the zero-runtime-
dependency trait. Nothing in the tool loads the schema file; only an editor reads it. It
lands here rather than in M1b-1 because this is where `--file` and the first real run file
arrive, and a schema with nothing pointing at it is a file nobody updates. Drift is the one
real cost, so `core/runfile.ts` exports `RUN_KEYS` and `TASK_KEYS` and one test asserts the
schema's property names equal those Sets — the validator stays the single source of truth.
**Amendment 2026-09-05 — the `$schema` line is deferred; the schema file is not.**
`schema/run.schema.json` ships and its drift test with it. The `$schema` line does not,
because it has nowhere honest to point yet: a repo-relative path breaks the moment a run
file sits in the repo being worked on, which is the normal case, and the raw URL for this
file 404s until the branch merges. The line is an editor convenience with no runtime effect,
so it costs nothing to add once a stable URL exists. One clause is struck from *done when*
below; the drift test — the only thing standing between the schema and a second, silently
wrong copy of the field list — is untouched.

**Amendment 2026-09-05 — `ask` inside a run file survives for exactly one asker.** Not
foreseen by the story. The limit is not "a run file", it is the **decider**: `makeAskPolicy`
owns a single readline over one stdin, so two tasks prompting at once would interleave two
questions on one line and attribute an answer to whichever asked last — the fail-open
shape #13 exists to prevent. So `ask` runs as asked when **one** task asks and a TTY exists;
otherwise every asking task re-resolves as `safe`, rather than renaming itself, so `safe`'s
own rules — including forcing `allowReadOutsideRoot` false — apply to what actually runs.
A notice on stderr says which case fired.

It is a downgrade often but not always, because every registry entry is `defaultMode: "ask"`
(`protocol/registry.ts`): a run file naming no mode has every task inherit one, and a
two-task file of that shape runs as `safe`. **M2-3's queue serves N askers in the daemon
only; M2-9's `attach` lifts the CLI's limit** (amended 2026-09-16, #33) — its recorded
decision (first writer wins; a second answer to a settled decision is a defined error) is
the same collision seen from the API side. `core/run.ts` takes the decider as
`RunOptions.askPolicy` and never builds one, so M2-3 supplies a different decider rather
than editing the pool.

The interactive half is **verified by hand, not by the suite**: a test runner has no TTY, the
same reason `docs/STORIES.md` already records `--mode ask` as untestable in CI. Measured
2026-09-05 against `mock-agent.mjs` under a pty — the prompt appeared, `y` was answered, and
`ACP_TEST.md` was written. What CI does cover is the two halves that need no TTY: the
downgrade notices, and a `node:test` case asserting `askPolicy` reaches the asking task and
no other.

**Amendment 2026-09-05 — `--agent`, `--cmd` and `--mode` are refused alongside `--file`.**
A run file has already resolved all three per task, against each harness's ceiling. A flag
would be a second, unresolved answer to a settled question, and either direction of silent
precedence runs something other than what was asked for — the failure `resolvePolicy` raises
on rather than downgrades.

*Done when* `node:test` covers the stop-reason table and the roll-up ordering, a six-task
run file with `maxConcurrency: 2` never has three live subprocesses, and the run-file JSON
Schema's property names are asserted equal to `RUN_KEYS` and `TASK_KEYS` by a test.

**M1b-3 · `core/worktree.ts` · M · needs M1a-8**
`git worktree add` off a base ref into `.kapelle/wt/<runId>/<taskId>`. Preflight: repo
detection, dirty-tree refusal, base-ref resolution. Retention: remove the worktree on
success, **keep worktree and branch on failure or timeout when the task left work** so
partial work stays inspectable; a task that produced nothing is rolled back entirely. **Transactional spawn** — worktree creation, task
registration and agent start either all succeed or are all rolled back, so a failed spawn
never leaves an orphan worktree with no run record.
**Gap** — `.kapelle/` sits **inside the working tree of the repo being worked on**, and
the plan never reconciles that with its own rules. Three consequences: the dirty-tree
refusal above will refuse on the supervisor's own state directory from the second run
onward; M1b-4's `git status --porcelain` cross-check will attribute supervisor files to the
agent; and a worktree nested inside the parent tree is inside the parent's `#guardPath`
root when a task runs from the repo root. **Decided 2026-08-23 (ratified with amendment, #62 B1): a preflight step that requires
`.kapelle/` to be git-ignored** — **refusing to start with an instruction if it is
neither ignored nor tracked**, refusing to start if the path is *tracked* — plus explicit
exclusion from the diff cross-check (M1b-4). Keeping state in-repo is right, discoverable
and per-project; it just has to be invisible to git.
**Amendment — the preflight cannot append it.** As written it appended `.kapelle/` to
`.gitignore` when absent, which dirties the working tree the same preflight refuses to start
on: the first run in a fresh repo would either refuse after having modified the user's file,
or need an exception carved for its own edit. It is also a write to someone's repository
that nobody asked for, on a tool whose entire posture is that it does not touch things
without permission. So it **refuses with the fix in the message** — *"add `.kapelle/` to
.gitignore and re-run"* — a one-time cost per repository, paid deliberately.

**Amendment 2026-09-20 (#129) — reversed. The state moves out of the repository, and
the dirty-tree refusal becomes a notice.** The decision above was ratified on the reading
that in-repo state is "right, discoverable and per-project", and the toll — one
`.gitignore` edit and a commit — was thought one-time and small. Using it said otherwise.
The `.gitignore` edit is paid per repository, by a tool whose whole posture is that it asks
nothing; and the dirty-tree refusal turned out to be the worse half, because a supervisor
whose purpose is to run agents while the operator works cannot also demand the operator's
tree be clean. It forced a stash-or-temp-commit decision, every run, on changes no task
would ever touch.

Neither refusal was load-bearing. `git worktree add` succeeds against a dirty main tree,
and a worktree is a separate checkout the operator's edits never reach; and M1c-3's merge
already refuses **per file** — only where a dirty path overlaps a path a task branch
touched — which is the one moment a dirty tree can cost work. The blunt refusal at run
start was a second, coarser copy of a check that already existed in the right place.

So: worktrees, run records, event logs and stderr logs move to
`$XDG_STATE_HOME/kapelle/repos/<name>-<hash>/` (`stateDirFor`, `core/runtime.ts`); both
ignore refusals and `checkStateDir` are deleted, with the two daemon 409s they raised; and
the dirty tree becomes one advisory line naming the count and the base commit, which
`--quiet` drops and which fires only on the worktree path, since the shared-cwd fallback
runs tasks *in* the dirty tree. **`<repo>/.kapelle/config.json` stays**, and may now be
committed: it is a per-project setting a team may want to share, and the only file the tool
reads from inside a repository.

The third consequence in the Gap above — a worktree nested inside the parent's
`#guardPath` root — **closes** rather than moving, since checkouts are no longer inside the
repository at all.

**The key is the repository's path**, which is the one cost this takes on: rename or move a
repository and its workspace is stranded. A marker file in `.git/` would survive the move
and was judged more machinery than the problem is worth (decided 2026-09-20, #129). The
boot sweep therefore **reports and keeps** a workspace whose repository is gone, and deletes
it only when an operator on a TTY answers yes — a path that is gone reads identically for a
rename, a move and a delete, and those want opposite answers. The notice names an exact
command for each ending, and the repair is a verb — `kapelle workspace move <old> <new>` —
rather than a printed `mv`: measured 2026-09-20, git keeps the old absolute path on both
sides of a worktree link, so `mv` alone leaves every checkout `prunable` and the next
`git worktree prune` deletes the work it has just moved. `moveWorkspace` does the
`git worktree repair` in the same call, so the two halves cannot be separated. The bare
`kapelle workspace` prints where a repository's state lives, which stopped being answerable
by looking once it left the repository.
*Done when* a run leaves `git worktree list` clean after success and populated after
failure, and killing a task mid-spawn leaves no orphan worktree without a run record.
**Landed 2026-09-06 (#19).** `core/worktree.ts`, driven by `core/run.ts`'s pool: one
`acquire` before the executor, one `release` after, and `taskCwd` deleted. Three decisions
were taken in scoping and are recorded on the issue. **(1) A cwd that cannot carry
worktrees falls back with a notice** rather than refusing — not a repository, or a
repository with no commit to branch from. Refusing would make a git repository a
precondition of the CLI's own suite, which drives `--file` runs in `mkdtemp` directories
(`integration/helpers.ts:36`); the notice is the containment variant and survives `--quiet`
(#13), because it says a safety property is absent. **(2) The spawn transaction is
in-memory.** A task whose worktree is untouched at release — no diff, HEAD still at the base
sha — has its checkout removed either way; the branch is removed only for a non-releasing
status, the shape a failed spawn takes today, while a `done`/`warned` task with an empty
diff leaves its branch at the base ref without an empty commit. A `kill -9` mid-spawn can
still orphan one; that is M2-5. The record it reconciles against is written on every task
transition as of M2-6 (#36); before that, `run.json` landed only after the run ended, so a
`kill -9` left nothing to reconcile. **(3) Teardown
covers the whole `TaskStatus` union now**, including `warned` (M1b-4) and `timed_out`
(M1c-1), which have no producer — the reason M1b-2 gave for shipping the whole severity
ordering early. `done` and `warned` release, matching the two statuses the CLI exits 0 for
(the CLI's exit-code rule for run files); everything below keeps its worktree, uncommitted, for reading.
**Review found three ways retention could act on the wrong thing (#85, all measured
2026-09-07, each with a test that is red without its fix).** (a) `git status --porcelain`
fixes the format, not the content: `status.showUntrackedFiles=no` empties it, so a task
whose entire output was new files read as *untouched* and had its checkout removed with the
work still in it. Every check now passes `--untracked-files=all`, which no config can
weaken. (b) `release` assumed the checkout was still on the task branch. An agent running
`git checkout -b` in its own worktree moved HEAD, and the commit then landed on that ref —
or dangled, on a detached HEAD — while the branch this run advertises stayed at its base
ref, so M1c-3 would merge nothing and call it success. It now verifies the symbolic ref and
**keeps the checkout with a warning** rather than acting. (c) A `--cwd` naming a
subdirectory was re-entered at the checkout *root*, handing the task the whole repository
and widening `#guardPath` from the requested subtree — a safety boundary moved by where a
worktree happens to live. The repo-relative prefix is preserved — subtracted from the **realpath** of both sides,
because `--show-toplevel` resolves symlinks while `--cwd` is the string that was typed, and
a second review round measured that mismatch putting one task inside *another task's*
checkout, its own branch left empty. A containment check on the joined path refuses
anything outside the checkout, and is unreachable by construction once the prefix is
honest — kept because this boundary has already moved once. Review also found that both
ignore refusals told the operator to do something the next preflight rejects: editing
`.gitignore` is itself an uncommitted change. They now say to commit it, and offer
`.git/info/exclude` for a tree that must stay clean.
**Gap found in review — nothing said who commits the work.** "Remove the worktree on
success" and "the branch always survives" only hold together if something commits first:
otherwise `git worktree remove` refuses on the dirty tree or discards the work, and M1c-3
would merge a branch sitting at its own base ref. `release` now commits onto
`kapelle/<runId>/<taskId>` before removing, and `--force`s the removal because ignored
files a task installed would otherwise block it.

**M1b-4 · `core/result.ts` · M · needs M1b-2**
Prompt preamble requesting a `<task-result>` block with `<status>`, `<summary>`,
`<details>`, optional `<files>` and `<branch>`. Extraction is a regex for the wrapper, then
one per field. Strictness: `null` if the wrapper is absent, or if any of
status/summary/details is missing or empty after trimming; a missing *optional* field is
`undefined`, not a rejection. `TaskRun` (the implementation of this story's `TaskResult`)
carries the agent-reported fields beside the observed ones the run already records:
`stopReason`, duration, tokens/usage semantics, and `warnings[]`. Permission count and the
git tree are internal cross-check inputs, not stored on the result. Cross-check writes
`warnings[]` — status `success` with an empty diff;
`<files>` naming paths the diff does not contain; a non-empty diff with no block at all;
plus `policyNeverFired`.
**Amended 2026-09-10 (M1c-6, #30): a fifth, `filesUnclaimed` — the diff holding a path
`<files>` never names.** The list above walks one way only, which the preamble does not:
it already asks for *"one repo-relative path per line, only if you changed files"*, so the
rule was written and never verified. A pi task exposed it. The `pi-lens` extension that pi
loads from `~/.pi/agent/settings.json` (4.1.5, `dist/index.js:2465`) wrote its telemetry
(`.pi-lens-probe-home/`, eight files) into the workspace root; the task claimed `NOTE-pi.md`
alone and finished `done` with nothing to read; `release` then committed all nine to the
task branch. It fires **only where `<files>` is present and non-empty** — omitting the
optional field is what an agent that forgot looks like, and warning on its absence would
fire on every task that never used it and double up with `policyNeverFired`, which is the
check that already speaks for a tree nobody described. `<files>` is our extension to ensemble's schema and exists
precisely to make this check possible.
**Amended 2026-09-18 (M2 retro, #119): `claimedSuccessNoDiff` is removed.** It fired on
status `success` plus an unchanged tree and never read `<files>`, so it warned on every
read-only task that worked — the claim ("no files") and the tree ("no change") agreed.
Measured on a real daemon run (opencode 1.18.30): a one-sentence summary task finished
`warned`. It broke this amendment's own rule that an absent `<files>` must not warn, and a
`<files>` that names paths is already covered by `filesNotInDiff`. What it alone caught — a
task meant to change something that changed nothing, listed nothing and said `success` — is
no longer detected by the cross-check. Its branch is left at its base ref with no commit, so
there is no commit that could pass for the work, but the report does not surface that and a
person must inspect git to see it. Four checks remain.
**Revised by M0-1: `policyNeverFired` is now a required check, not a nicety.** The survey
found opencode produces a non-empty diff with zero permission requests *by default* — the
exact signature this warning exists to catch — so on opencode it fires on
every mutating task. Two consequences: the warning text must not read as an anomaly report,
and it should be paired with M1a-4's `asksPermission: false` so a run says "this harness
never asks" once, rather than crying wolf per task. Excludes `.kapelle/` from the diff (M1b-3).
**Warnings publish on the bus and never fail the task** — a read-only stage legitimately
produces no diff, and making disagreement fatal would turn every harness quirk into a hard
stop and break the review stages the pipeline is built on.
**Revised by M0-5: `tokens` has a source, and it is not the one this story assumed.** The
per-turn count lives on the `session/prompt` **response** (`usage`), not on `usage_update`,
and `AcpAgent.prompt()` discarded it. **Landed in M1a-3 (#62 B3)** — `prompt()` now returns
the whole `PromptResponse`, so the count is already in hand and this story only has to
render it. Two constraints come with it: the field is `UNSTABLE` in the ACP schema and
absent from the published docs, so pin it with an M1b-5 `mock-agent.mjs` case; and it is
**cumulative on copilot where it is per-turn on opencode and claude-agent-acp**, so
`TaskResult` must record which semantics produced the number rather than typing a bare
`tokens`. `usage_update`'s `used` is context occupancy and cannot fill this field.
**Gap** — the plan specifies extraction returning `null` but never says what the task's
*status* then is, nor what M3-3 hands a successor when there is no summary to hand it.
Warning-only is the right posture, but it leaves `TaskResult.summary` undefined for exactly
the handoff M3 is built on. **Decided 2026-08-23 (#62 B1), two steps — the original first
step is struck:** (1) status stays whatever the stop-reason table says,
`warnings += "noResultBlock"`, and `summary` is synthesised from the tail of the final
message and **explicitly flagged as synthesised**; (2) a successor's prompt states plainly
that the predecessor reported nothing structured, rather than passing a synthesised summary
off as the agent's own words (M3-3). A missing block **never fails the task** — compliance
with a prompt preamble is not enforceable, and failing on it would make a non-compliant
harness unusable rather than noisy, which is the shape of overclaim R1 and M0-6 exist to
prevent.
**Struck: the retry.** The original step (1) sent *one* bounded follow-up prompt in the same
session — *"Reply with only the `<task-result>` block"* — on the reasoning that it costs one
turn and converts most misses into hits. **It cannot ship.** M0-4's own recorded consequence
is *"one prompt per session per task, and never a 'nudge'"*: on copilot the `session/prompt`
handler calls `session.abort()` unconditionally as its first action
([github/copilot-cli#4555](https://github.com/github/copilot-cli/issues/4555)), tearing down
background work **even when no turn is in flight**, and on opencode a second prompt lands in
the previous turn's context where the model reads it as a suspected prompt injection. The
retry would silently destroy the very work whose result it was trying to recover. The
structural half is narrower than this story assumed: #62's R5 refuses a prompt only during
a live turn (M1a-3), and a re-ask sent after `end_turn` would reach the harness
(`docs/FINDINGS.md` §Multi-turn, 2026-09-15). The retry stays struck as policy, not as
an impossibility: copilot's handler aborts background work on any prompt (#4555), so the
client must not send one. The conflict predates today: it was written into M1b-4 before
M0-4 measured the behaviour, and survived because nothing forced the two to be read together.
*Done when* `node:test` covers the strictness matrix field by field, and a fixture exists
per warning class.
**Landed 2026-09-07 (#20).** `core/result.ts` — preamble, extractor, cross-check, all pure —
called from `runTask`, with `runOne` merging the verdict onto `TaskRun`. `TaskRun` **is** the
story's `TaskResult`: the agent-reported half (`result`, `summary`, `summarySynthesised`,
`warnings`) beside the observed half it already carried. Two decisions were taken in scoping
and are recorded on the issue. **(1) A warning promotes `done` to `warned`** — the producer
that status has been waiting for since M1b-2 — and promotes nothing else, because reading
`warned` over a refusal would hide it behind a status the CLI exits 0 for. **(2) The preamble
goes on every prompt**, the single-agent path included, so there is one composer rather than
two answers to what a prompt looks like. Three things the build settled that the story did
not. `diff: undefined` is **unknown, never empty**: outside a repository every tree-shaped
check skips itself, or the no-repo fallback would warn on every task it ran. Result warnings
are published on the bus as `_client_result_warning` and never fail the task. `policyNeverFired`
does **not** fire where the registry already says `asksPermission: false` — `warningsFor`
marks that containment line with `onceKey`, so the run prints it once per harness instead of
once per task — a second per-task line would be the crying wolf M0-1 warned about rather than
a fix for it. The dedupe is keyed, not blanket: `tests/cli.test.ts:206` fixes the *advisory* line as
deliberately per task, and that line carries no `onceKey`, so it still repeats. And `<status>` is kept as the
agent's own word rather than a closed vocabulary: a harness that writes "ok" has still
reported, and rejecting the block over a synonym would throw away a good summary.
`mock-agent.mjs` now sends a compliant block, which is what keeps the happy path exercisable
offline; M1b-5 still owns the non-compliant fixtures.
**Review round (#88) moved the cross-check's input twice, both times measured.** The diff was
read as porcelain *text*, and `git()` trims — so `M run.ts`, the commonest shape there is,
lost its status column and read as the path `un.ts`, warning `filesNotInDiff` about a file
the agent had correctly reported. It is now `changedPaths`, over `git status -z`, which
writes paths verbatim and gives a rename's source its own entry: that deleted the unquoter
and the quote-state scan for ` -> ` along with the bug, and `core/tests/worktree.test.ts` proves
the reading against git itself rather than against fixtures. Second, the tree is read **only
for a task with its own worktree**. In the shared-cwd fallback every task sees every other
task's files, measured as a task that changed nothing being told it had changed the tree
without asking permission — so isolation absent means the tree is *unknown*, which is the
same rule the no-repository case already followed.

**M1b-5 · Extend `mock-agent` · S · needs M1b-4**
Multiple sessions, a permission timeout, a malformed `<task-result>`, a missing block that
answers the re-ask on the second turn, and fixtures tripping each cross-check warning.
*Done when* every new client path is exercisable with nothing installed — the property that
keeps this project verifiable offline.
**Landed 2026-09-08 (#21).** Fixtures are selected by `--scenario <name>` on **argv**, not
by a keyword in the prompt. The story's own `silent-session` case proves why: it fires during
the handshake, before any prompt exists, so no keyword could reach it. `refuse` moved to the
same surface with the rest, so prompt text is load-bearing nowhere now. An unknown name exits
2 instead of falling back to the compliant path — a typo that quietly ran the happy fixture
would make a test pass for the wrong reason. Five block-shaped fixtures cover the four
cross-check kinds **one at a time**, which is the property the suite asserts: each card
carries exactly one `!` line. That is why `files-not-in-diff` reported `partial` rather than
`success` at landing — a success claim over an unchanged tree would have tripped
`claimedSuccessNoDiff` too —
and why `unasked-write` writes through node's own `fs` rather than `fs/write_text_file`,
since `policyNeverFired` is about the mutation the client never sees.
Three of the story's five items were substituted in scoping, each recorded on the issue.
**Multiple sessions** is unreachable — `AcpAgent` holds one `sessionId` and each task gets
its own subprocess — so the cheap half landed instead: an id minted per `session/new`, and a
refusal for any id the mock never issued. **The permission timeout** is M2-3's clock, so the
handshake deadline stands in for it; the mock's silence on `session/new` replaced the inline
`node -e` script `protocol/tests/agent.test.ts` used to carry, which is a deletion rather
than a second fixture. **The re-ask** is gone from the client (#62 R5), so the missing block
is one turn only. Folded in as well: M0-5's pin of `usage` on the `session/prompt`
**response**, which the mock had never sent.
**Amended 2026-09-18 (#126): the `claimedSuccessNoDiff` check those `partial` choices
dodged is removed** (M1b-4's #119 amendment above). `files-not-in-diff` now reports
`success` and still trips only `filesNotInDiff`. The renamed `read-only` fixture is the
no-warning control, so those five block-shaped fixtures cover three warning kinds one at a
time plus that control, not the four kinds named at landing.

**M1b-6 · `hostile-agent` · S · needs M1a-3**
Path escape (`../../etc/passwd`, absolute paths, symlink), mutation without asking,
malformed JSON-RPC, oversized payload, a method we do not implement.
*Done when* each hostile attempt is handled — refused with a specific error where the
client has a request to answer, or safely dropped/ignored for malformed or oversized input —
and the run continues.
**Landed 2026-09-08 (#22).** `hostile-agent.mjs` beside `mock-agent.mjs`, one attack per
`--scenario` and **no default** — a bare run exits 2, because a hostile agent with no
attack selected is a worse mock and a typo that ran it would make a containment test pass
without containing anything. `protocol/tests/hostile.test.ts` drives all eight attack
scenarios, and every case asserts the attack was handled — refused, allowed, or dropped as
the scenario expects — **and** that the turn still ends. The second half is the one that
gets forgotten, and a client that dies on hostile input has not contained it.
**Two of the five were already handled** and needed only recording — a non-JSON line was
ignored, and an unimplemented method already answered with a named error rather than a
crash. **Three were live holes**, and each fix has a test that is red without it.
**(1) The symlink**, closed as M1a-3 said it would be. **(2) Mutation without asking** —
`fs/write_text_file` never consulted the policy, so `safe` refused the *request* to edit
and then performed the edit for any harness that skipped the request and called the file
service directly. Decided in scoping: `#guardWrite` puts it through the same policy under
the honest label `kind: "edit"`, which is what makes `safePolicy` refuse it. This widens
the sentence "the policy filters what a harness *asks*" by exactly one case, and no
further: a mutation through the harness's own shell is still outside the policy's reach
and still inferred afterwards by `policyNeverFired`. The allow-all case is tested too —
without it, deleting `#guardWrite` and banning every `fs` write outright would pass.
**Review round, 2026-09-08.** The first cut consulted the policy on *every*
`fs/write_text_file`, the follow-up write a well-behaved harness sends after its own
approved `session/request_permission` included — measured against `mock-agent`, one edit
became two `ask` prompts and two `_client_permission` events. A write that follows an
approved permission for the same resolved path now reuses that decision. **The approval
covers one write and is consumed by it**, and there is deliberately no standing grant even
for `allow_always`: `pickOption` prefers `allow_once` and reaches `allow_always` only when
the harness offered nothing narrower, so an "always" entry would be a session-long grant
for a path the human never chose to grant that way — `hostile-agent`'s `always-menu`
scenario is that shape, and its test counts two decisions for two writes. A *denial* is the
one sticky entry, so a harness that writes after being refused is refused again without
re-asking. Approval for one path never covers another: measured, a harness approved for
`ALLOWED.md` that then wrote `OTHER.md` was put back through the policy under the real
target's name.
**(3) Oversized payload** — there was no cap at all; `MAX_LINE_LENGTH` is 32 MiB, and the
line is dropped with a stderr notice while the turn carries on. The ceiling is recorded at
the constant: `readline` has already buffered the line by the time the check runs, so this
refuses the payload rather than bounding the memory that held it, and a real bound means a
manual chunk scanner over stdout. Two things the build settled. The flood the fixture
sends is a **well-formed** `agent_message_chunk` carrying a marker, not garbage — a
malformed flood would be dropped by `JSON.parse`'s own `catch` even with no cap, and the
test could not tell the two apart. And `guardAgent` in `protocol/tests/agent.test.ts` now
passes an allow-all policy: `AcpAgent`'s default is `DENY_ALL`, so after (2) that suite
would have gone green for the wrong reason, and keeping the path guard and the policy in
separate suites is the same separation the architecture note asks for.

**M1b-7 · Per-task stderr capture · XS · needs M1b-3**
**Gap, narrowed by M1a-3** — stderr was discarded unless `--verbose`. M1a-3 now retains it
in memory and attaches it to the rejection when a harness **dies**
(`docs/STORIES.md`, the `Decided 2026-08-31` block under M1a-3), which covers a harness that
**dies during the handshake**. What remains for this story is the **durable**
record: a harness that dies leaves nothing on disk, a *live* harness's stderr is still only
mirrored under `--verbose`, and under a daemon nobody is watching a terminal.
**Decision: capture to `.kapelle/runs/<id>/<taskId>.stderr.log` unconditionally**;
`--verbose` continues to mirror it to the terminal.
*Done when* a harness that fails to start leaves a log containing its real error rather than
only `Internal error (code -32603)`.
**Decided 2026-09-07 (issue #23), the two forks the file name left open.**
**Run files only** — the single-prompt CLI mints no run id and has no task id (the single-prompt path in `run.ts`),
and the operator who typed it is watching the terminal the story says nobody watches.
**A cwd that cannot carry worktrees still logs** — a non-repository cwd falls back to the
shared cwd, and that fallback is the CI shape this story exists for, so the log follows it
there. A repository with no commits falls back to the shared cwd too, but its log goes to
the repository's own workspace under `stateDirFor(root)`, beside where worktrees would have been (`.kapelle/` until #129).
`openWorktrees` now returns the `root` it chose, because worktrees are no longer the only
state under `stateDirFor(root)`: a caller guessing `cwd` would split the directory in two
whenever `--cwd` names a subdirectory.
**Landed 2026-09-07 (#23).** `core/run.ts` resolves the log path and `AcpAgent` opens the
file exclusively (`ax`) so a re-run never mixes two executions in one file. Run-file tasks
write `.kapelle/runs/<runId>/<taskId>.stderr.log` regardless of `--verbose`/`--quiet`;
the single-prompt CLI does not. A log directory that cannot be made is a notice, never a
status change. Spawn failures write the harness's own reason to the file, not only
`Internal error (code -32603)`.

**M1b-8 · Retire `fanout.mjs` · S · needs M1b-2**
Its job becomes "a run file with N independent tasks". Port `tasks.json` to the new schema
as a worked example.
*Done when* `npm run fanout` is gone from `package.json` and the README shows the run file
instead.
**Landed 2026-09-07 (#24).** `fanout.mjs` and the `npm run fanout` script are gone.
`tasks.json` is now the worked run-file example and README shows `node run.ts --file`
instead of the retired script.

---

## M1c — Watchdog, merge, and the M1 bar

**M1c-1 · `core/watchdog.ts` · M · needs M1b-2, M0-4**
One interval timer over all running tasks (default 60s). Two signals, both chosen because
they port across vendors: **idle** — no events for `stallIdleMs`; and **repeat** — the same
tool title firing `stallRepeatCount` times consecutively (default ~8), the busy-loop case
idle time structurally cannot see. Repeat reuses the `toolCallId → {title, kind, rawInput}` map
already maintained as a protocol invariant, so it needs only a per-task last-title and
count. Both signals warn and the task keeps running; the separate, longer `ttlMs` calls
`session/cancel`, preserves the branch and marks the task `timed_out`. Every knob disabled
at `0`. Best-effort throughout — one task's failure must never halt the sweep.
**M0-4 fills in the TTL rung** (`docs/FINDINGS.md` §M0-4): every harness ended its turn
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
**M0-5 makes that drop evidence-backed rather than cautious** (`docs/FINDINGS.md` §M0-5).
Occupancy *is* comparable as a fraction, but its denominator is not trustworthy: claude
reports `size: 200000` for the whole of a session's first turn whatever the real window, and
copilot's `size` matches neither its own reported window nor its usable space. And opencode
sends exactly one `usage_update` per turn, at the end, so a context-based rung would be blind
on the harness where turns run longest. If a context signal is ever wanted, it belongs behind
a per-harness trust flag, not in the vendor-neutral core.

**M1c-2 · `mock-agent` stall and repeat modes · XS · needs M1c-1**
Stall: accepts the prompt, emits nothing, never returns. Repeat: the same tool title on a
loop. One per watchdog signal.
*Done when* stall produces a warning then a cancel at TTL with the branch intact, and repeat
produces a warning and is **not** cancelled.
**Amended 2026-09-09 (#26).** Stall writes one file **at startup**, before the handshake. A
task that changed nothing is untouched, and `release` deletes the branch of an untouched task
that did not finish (`core/worktree.ts:382`) — so "with the branch intact" had nothing left to
check. At startup rather than on the prompt because `core/run.ts:535` starts the TTL clock
before the worktree and the spawn, so a slow machine could reach the TTL with the file still
unwritten and fail the test for the wrong reason.
Stall also *answers* `session/cancel` (M0-4's measured 64 ms); the harness that ignores a
cancel is already covered by the inline stubborn agent in `tests/cli.test.ts`.

**M1c-3 · `core/merge.ts` — preflight and `--squash` · M · needs M1b-3**
`kapelle merge <runId>`, never automatic. A run produces branches; landing them is a
distinct act with its own failure mode. Preflight refuses if the working tree has
modifications to any file a task branch touches, and refuses if two task branches in the run
touch the same file. All-or-nothing: preflight completely, then merge, so a run never
half-lands. `--squash` (default) leaves the combined changes **unstaged**, nothing
committed — right for a parallel split, where the branches are independent.
**Gap** — the plan ships `--rebase` in M1 and justifies it as "right for a pipeline, where
one inherited worktree carries several stages' commits". Pipelines are M3. M1's own
verification checklist then asks for "`--rebase` on a pipeline run preserves per-stage
commits" — a run that cannot be authored at M1. **Decided 2026-08-23 (ratified, #62 B1): M1 ships the preflight (the
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
**Landed 2026-09-10 (#28).** Half the story was already on the bus: `_client_stall_warning`
(M1c-1). The other half was missing and not obviously so — `_client_permission` is emitted
*after* the decision, and a record of what was decided cannot ring a bell for the human the
decision is waiting on. So this story added `_client_permission_pending`, emitted in
`protocol/agent.ts` immediately before **both** policy awaits (`#requestPermission` and
`#guardWrite`), rather than hanging a callback off `makeAskPolicy`: the *Done when* asks for
a bus event independent of the terminal, and M4-3's browser answering needs the same one.
**It therefore fires in every mode**, since `AcpAgent` holds a `Policy` and not a
`ClientMode` — pushing the mode into the protocol layer to filter there is the wrong
direction. The consumer filters instead: on the single-agent path `asks` is whether the
resolved mode is `ask`; on the `--file` path it is `canAsk` (did one asker survive?)
plus `askIds` naming that one surviving asker, so a `safe`/`auto` task in the same run
does not ring for a decision that never waits on a human. `makeNotifier` still takes
`asks: boolean` and not a mode.
**A second filter, found in review: `kind`.** The event means *a decision is pending*, not
*a human is waiting* — `makeAskPolicy` auto-approves `READ_ONLY_KINDS` without touching
readline, so a `read` or `search` under `ask` rang a bell nobody was needed for. The
notifier imports the set from `core/policy.ts` rather than restating it, so what `ask`
auto-approves and what the bell skips cannot drift apart. The review's own justification
overstated the volume — it cited M0-4's 443 events, which are opencode's, and opencode has
`asksPermission: false` and sends no permission requests at all — but the finding stands on
its own terms for claude and copilot, which do ask.
**This story did not pay M1a-6's deferred union widening** (task started, worktree created,
task finished). It consumes none of the three; M2's persisted log is their real first
consumer, and widening a union for a consumer that does not read it is the cost M1a-6's own
2026-09-06 amendment exists to defer.
Two smaller decisions, neither a fork: the bell survives `--quiet` — same reasoning as #13's
containment line, and the notifier took over the stall line `run.ts` used to print so the
run does not say it twice; and the desktop half is spawned unguarded, because a presence
check buys nothing a failing spawn does not already give.

**Amended (room model):** the second consumer of `_client_permission_pending` is the TUI overlay (M4-3), not a browser; the event and the notifier are unchanged.

**M1c-5 · Package identity · XS**
**Gap** — the plan invokes `kapelle merge`, but `package.json` is `private`, named
`acp-mvp`, and has no `bin`; and no document states which platforms are supported, while
M1c-4 shells to `notify-send`/`osascript` and `git worktree`, paths and `sep` all behave
differently on Windows. **Decision: rename, add the `bin` entry, and declare macOS and Linux
supported with Windows explicitly unsupported** — rather than discovering it.
**Amended 2026-09-10 at pickup — the planned name was taken, and `private` stays.** npm
`agent-team@0.2.0` is live, unrelated, describes itself as *"Multi-agent CLI orchestrator via
ACP protocol"*, and declares `bin: {"agent-team": …}`, so the collision is on the package name
**and** on the command a user types. **Decision: the package and the command are `kapelle`** —
the ensemble a *Kapellmeister* directs, the players rather than the conductor. **`private:
true` is kept**: it blocks `npm publish` alone, never `bin` and never `npm link`, so it costs
nothing while nothing here is ready to publish, and the day it is, the name is a two-line
edit. **The name reaches the disk as well as the command**, each with exactly one
definition: `STATE_DIR` (`core/worktree.ts:42`) is `.kapelle`, `BRANCH_PREFIX`
(`core/ids.ts:73`, extracted from an inline literal so the two cannot drift) is `kapelle`,
`SECRET_PREFIX` (`protocol/registry.ts:96`) is `KAPELLE_`, and the per-task commit subject
is `kapelle: <taskId> (<runId>)`, which has to match the branch it lands on. The one
identifier that does not follow is the schema `$id`: it is the repository's URL, so it
tracks the repository name rather than the tool's. The `bin`
wraps **today's argv** and adds no `run` subcommand — `cli.ts` already dispatches `merge`, so
`kapelle merge <runId>` works on day one, while `kapelle run <file>`, `attach` and `--detach`
stay M2-9's surface. `"os": ["darwin", "linux"]` is the whole of the Windows block: measured
2026-09-10 on Node 24.20.0, npm enforces it on the **root** package, so `npm install` there
fails `EBADPLATFORM` and installs nothing; `npm install --force` and running `node cli.ts` on
a populated checkout still bypass it, and both were left open rather than paying for a
`win32` guard no report has asked for. WSL is Linux.
**Added 2026-09-06 — this story also renames the front-end file, and is the only cheap
moment to do it.** `run.ts` (the CLI) and `core/run.ts` (the engine) share a name and differ
only by a directory. M1b-2 made that collision live rather than theoretical: `run.ts
--file` calls `runRun` from `core/run.ts`, so both names appear in one import block.
**Decision: the front end becomes `cli.ts`; `core/run.ts` keeps its name.** That direction
and not the other, for two reasons. `core/run.ts` is named as a deliverable in M1b-2 and in
`PROJECT-PLAN.md`'s architecture, so renaming it edits many documents to fix one file; and
`run.ts` is the one whose name stops being user-facing **here** — after the `bin` lands,
people type `kapelle run`, never a filename, so this story is the last moment the rename
is nearly free. It touches `package.json`, the README, `tests/cli.test.ts`,
`integration/helpers.ts`, `CLAUDE.md` and the `note` field of every file in
`assets/example/`; all mechanical, all covered by the suite except the last, which no test
reads. That last one is listed because it is the one that would rot quietly: the examples
must stay copy-pasteable, so their notes name the command that works **today**, and this is
the story that makes `node run.ts` stop being that command.
Also amended at pickup: the rename list gains `docs/PROJECT-PLAN.md`, this file
and the usage banner in `cli.ts`.
`fanout.mjs` needs no decision — M1b-8 deletes it.
Coordinate with the M2-9 amendment, which drops `runs.ts` entirely, so the end state is two
files with two jobs and two names: `cli.ts` for everything a person types, `core/run.ts` for
the engine.

**M1c-7 · `core/markdown.ts` — render agent text as Markdown · M · needs M1a-7**
Render `agent_message_chunk` text as Markdown in the terminal, by default, using an existing
package. Full CommonMark plus GFM — tables, nested lists, fenced code — not a subset.
**The schema is normative here and we do not follow it.** Schema 0.28.1, on the text variant
of `ContentBlock`: *"Text content. May be plain text or formatted with Markdown. All agents
MUST support text content blocks in prompts. **Clients SHOULD render this text as
Markdown.**"* We are the client and `render.ts` prints the source, so headers, tables and
fences reach the terminal as literal `##`, `|` and backticks. The protocol *website*
(`/protocol/content`, `/protocol/v1/content`) says nothing about markdown — only the schema
does, which is why this went unnoticed through M1a. Found by hand against opencode on
2026-09-04, in the same session as M1a-7's thought-chunk fix, and both bugs have one shape:
`mock-agent.mjs` is too tidy to show what a real harness sends.
**Gap — this is the project's first runtime dependency.** The rule is not a preference: it is
stated in `README.md`, `CLAUDE.md` and `docs/PROJECT-PLAN.md`, traced to the brief's
*"build thin, don't adopt a platform"* survival argument, and repeated verbatim at M4-1.
`package.json` has no `dependencies` key at all, and `npm run knip` fails in CI on a
dependency that is unused or unlisted. No document says when one may be added; the only
written conditions are M1a-2's SDK checkpoint, which priced the trait as **one cost among
three** rather than a veto, then declined on a different criterion.
**Proposed, to be ratified when this story is picked up:** a runtime dependency is acceptable
when it sits **entirely downstream of the bus, in presentation**, and its worst failure is
cosmetic — it cannot change a permission decision, a path guard, a policy, a mode
negotiation, or what reaches a subprocess. That mirrors the dependency direction the code
already enforces (`core/` may import `protocol/`, never the reverse). Two conditions ride
with it: the version is pinned exactly, and `core/markdown.ts` catches a renderer failure and
falls back to raw text, so a bad release costs the screen and never the run.
**Candidates, measured 2026-09-04 from the npm registry.** `md4x` 0.0.29, MIT, **zero own
dependencies**, ANSI and HTML from one parser, a `heal` option, 3.76 MB unpacked, first
published 2026-02-19 across 25 releases. `marked` 18.0.11, MIT, zero deps, parser only —
but `marked-terminal` 7.3.0 carries seven dependencies and peers on `marked >=1 <16`, so it
**cannot pair with marked 18** and was last published about two years ago. `cli-markdown` is
GPL-3.0-or-later with 14 dependencies, ruled out on licence. `markdown-it-terminal` depends
on the unmaintained `cardinal`.
**Recommended `md4x`; the choice is deliberately left to pickup.** It is itself
zero-dependency so the tree stays one package deep; it renders ANSI and HTML from one parser,
which is what the shared-renderer requirement below needs; and its `heal` option exists for
exactly our input — *"fixes incomplete markdown from streaming LLM output"*. Priced risk:
`0.0.x`, six months old. The fallback path is what makes that affordable, since its worst
outcome is the screen we have today.
**Decided at pickup, 2026-09-09 (issue #78).** The dependency exception is **ratified** as
proposed — "zero runtime dependencies" was a recorded status, not a rule — and `README.md`,
`CLAUDE.md`, `PROJECT-PLAN.md:47` and M4-1 above now say so. **`md4x` is dropped on
measurement**: 0.0.29, its latest release, renders `- one\n  - alpha` as `* one  * alpha`,
gluing the child onto the parent line, numbers a nested ordered list `1,2,3` straight through
the nesting, and joins table cells with tabs — it fails this story's own nested-list
criterion. Its Node entry also `require`s a prebuilt `.node` binary, so a native crash aborts
the process and the try/catch fallback cannot catch it, failing "worst failure is cosmetic"
as well. **`marked` 18.0.12 is taken alone** — MIT, zero own dependencies, 44 KB ESM, ships
its own types — with the ANSI paint written here, rather than `marked-terminal`, which pins
`marked` below 16 and pulls 40 packages. `earendil-works/pi` (MIT) was read as prior art and
makes the same choice: its whole TUI package declares `marked` 18.0.11 and
`get-east-asian-width`, and walks the tokens itself. Two shapes are taken from its
`packages/tui/src/components/markdown.ts` — a list drawn as a marker prefix plus a
continuation pad of equal width (:756), and a table that prints its own source rather than a
broken box when the terminal is too narrow (:842). Its streaming model does **not** transfer:
it re-parses the whole message per chunk and lets a full-screen layout engine repaint, where
this client writes into scrollback and can only erase the rows it drew. Its 1337-line
`utils.ts` (grapheme segmentation, emoji width, ANSI-aware wrapping) is declined, so nothing
in `core/markdown.ts` wraps text — the terminal does — and `width` reaches the table renderer
alone.

**One renderer for every surface.** `core/markdown.ts` is the only file that knows a markdown
library exists: `toAnsi(md, {width})` now, `toHtml(md)` when M4 wants it. `render.ts` calls
the first, M4-1's `dashboard-js-render` the second. M1a-6's rule is what forces this shape —
**the bus carries the wire object, never a rendered form** (#62 B4) — so every surface
renders from the same raw markdown string. The parser is shared; the paint is per surface.
**This amends M4-1**, whose *"no runtime dependency"* sentence must be revised rather than
quietly broken; with `md4x` the browser half is `md4x/standalone`, one ~140 KB self-contained
ESM served statically, and vendoring that single file is the fallback if the sentence is
judged load-bearing.
**Streaming — decided 2026-09-04. Draw raw live, repaint one markdown block at a time.**
Text arrives a few tokens at a time and markdown cannot be parsed until a construct closes,
so `render.ts` buffers only the **current, unfinished block** — one top-level unit:
paragraph, heading, list, table, fenced code. Chunks print raw as they arrive, exactly as
today, so the live feel is unchanged. A block closes on a blank line, tracking whether a
fence is open so a blank line inside one does not close it early; on close the lines just
drawn are erased and the rendered block replaces them. Blocks already drawn are finished and
never touched again. The repaint is **skipped** — raw printed, move on — when stdout is not a
TTY, when `NO_COLOR` is set, or when the drawn block is taller than `process.stdout.rows`;
non-TTY is the common case, since CI and `npm run selftest` both pipe. The open block flushes
before any `line()` event so a tool call never lands mid-paragraph, which the stream state
machine added in M1a-7's follow-up already owns, and the end of a turn flushes what is left.
**Single writer — a constraint, not an assumption.** The erase-and-redraw step moves the
cursor up over the lines it just drew, which is only correct while one thing owns the cursor.
`render.ts` is already a single-writer renderer: its stream state is module-level, one
variable per process rather than one per agent. Nothing is broken today because the
multi-agent path never subscribes it — `run.ts` drives one agent, and `fanout.mjs` keeps its
own listener that buffers each agent's prose and prints only milestones, because interleaved
token streams are unreadable. **Live markdown and concurrent agents on one terminal are
therefore mutually exclusive.** Whatever replaces `fanout.mjs` (M1b-2) keeps the
buffer-and-milestone shape, and a future multi-agent view renders per pane or after the fact.
Do not make the stream state per-agent and assume that settles it: that stops the output
corrupting and leaves it unreadable, which is the half that matters.
No new flag: `NO_COLOR` and non-TTY are the escape hatches until someone asks for more.
**Scope.** In: `agent_message_chunk`. Out: tool titles, plan entries, permission lines and
notices — those are our formatting, not agent markdown. **Decided out: `agent_thought_chunk`
stays raw**, being dim and terse, where repainting two interleaved streams would double the
state for little gain. Noted: the schema's UNSTABLE `PlanMarkdown` delivers a plan as raw
markdown, and if it ever arrives it is a second *consumer* of `core/markdown.ts`, not a
second renderer.
**Measurement to run at pickup** — does any harness populate `messageId` on chunks? It is
typed (`protocol/types.ts`, *"chunks of one message share an id"*) and **has never been
measured**; no M0 finding covers it. This design does not need it, since block detection uses
blank lines, but record the answer: it is the natural fallback key if blank-line detection
proves wrong against a real harness, and it costs one run per harness.
*Done when* a table, a nested list, a fenced code block and a header from a **real harness**
all render formatted in a TTY; the same run piped to a file carries no repaint escapes and
reads as plain markdown source; a fenced block containing a blank line is not split in two; a
tool call arriving mid-paragraph does not land inside the block; `npm run selftest` and
`npm run knip` stay green with the dependency listed; and `node:test` covers block-boundary
detection as a truth table, a pure function separate from the drawing, per M1a-1's rule.
*Note* `mock-agent.mjs` needs a message carrying a table, a nested list and a fence with a
blank line inside it — coordinate with M1b-5, which rewrites that file.

**Amended (room model):** the second consumer of `core/markdown.ts` is the TUI (`client/` plus pi-tui's `Markdown`), not `dashboard-js-render`; `toHtml` returns only if a browser client does.

**M1c-6 · M1 acceptance · M · needs all M1c**
A run file with three independent tasks against three real harnesses, each in its own
worktree, each returning a parsed `TaskResult`; `git worktree list` clean afterwards. Kill
the process mid-run, restart, confirm orphans are reaped. A `.json` run file and the same run
as a POST body validate to the same object (amended 2026-09-05, M1b-1: run files are JSON
only). A run file exceeding a harness `maxMode` is rejected, naming both values, before any
subprocess starts.
**Amended 2026-09-10 (#30): the orphan-reap clause is dropped, and the story grew an M1
stage retrospective.** Nothing reaps today and nothing was meant to — the sweep is M2-5,
which needs a record written on state transitions (M2-6); this story documents the surviving
state instead.
Measured 2026-09-10 on the fixture that stalls: `kill -9` mid-run leaves the checkout at
`.kapelle/wt/<runId>/<taskId>` **and** its branch, a second run adds a second one beside it
rather than clearing the first, and in this fixture the harness exits when its stdin closes
with the parent, so the state observed surviving a crash is on disk. A real harness that
outlives the supervisor stays M2-4's registry to track and M2-5's sweep to reap. The
retrospective is the second half and is the reason the story is no longer S.
**DONE 2026-09-10 (#30). Four harnesses, not the three the story asked for** — pi-acp has
been a measured fourth since #99, and "three" here dates the story rather than bounding it.
One run, `maxConcurrency: 4`: opencode 1.18.30 9.1 s, claude-agent-acp 0.75.1 8.4 s,
copilot 1.0.83 8.2 s, pi-acp 11.7 s, each `done` with a parsed `<task-result>`,
`git worktree list` back to one entry, four `kapelle/<runId>/<taskId>` branches and four
`.kapelle/runs/<runId>/<taskId>.stderr.log` files beside a `run.json`, and
`kapelle merge <runId>` through the linked `bin` landing all four as unstaged additions.
**The fourth harness is what found the gap below.** pi loads the `pi-lens` extension from
`~/.pi/agent/settings.json` on this machine, and pi-lens 4.1.5 writes its telemetry —
`.pi-lens-probe-home/`, eight files — into the workspace root it is given
(`dist/index.js:2465`). That is this machine's pi setup, not pi-acp: a pi without the
extension would not show it, and any extension that logs to its cwd would. The client
committed them with the task's real output, merged them into the developer's tree, and said
`done` with no warning: pi's `<files>` named `NOTE-pi.md` alone, and `crossCheck`
(`core/result.ts`) only walks *claimed → diff* (`filesNotInDiff`). The reverse — a diff
holding paths the result never claimed — has no check, and M1b-4 above enumerates four
warnings without ever ruling it out. A three-harness run cannot see this: the other three
touch only what they were asked to.
The version-drift warning fired for opencode and copilot and stayed silent for claude,
which is the one build whose `measuredOn` still matches. The ceiling rejection was observed
end-to-end by lowering opencode's `maxMode` to `safe` behind a PATH shim that records an
exec: the run printed `task "a": mode "auto" exceeds the ceiling for "opencode": maxMode is
"safe".` and the shim was never touched. Every shipped entry is `maxMode: "auto"`
(`protocol/registry.ts:103`), so the committed cover for it stays the injected-entry test
at `core/tests/runfile.test.ts:127`.

---

## M2 — Daemon

**M2-1 · Daemon skeleton · M · needs M1c-6**
`node:http`, no framework. `POST /runs`, `GET /runs`, `GET /runs/:id`, `DELETE /runs/:id`
(cancel). Objects only over the wire; the daemon never imports a path (M1b-1).
*Done when* `core/` still runs headless under `node --test` with no server booted. The
`core/` split guards against orchestration logic living in HTTP handlers: if `POST /runs` is
where worktree creation and stage sequencing happen, the scheduler becomes untestable
without booting a server and the CLI drifts into a second implementation.
**Amended at pickup 2026-09-11 (#31).** The *done when* above checks nothing — `core/`
already ran headless — so the issue's criteria replace it: `node:http` stays out of `core/`
and `protocol/`, and `daemon.ts` calls no `resolvePolicy`, `AcpAgent` or `acquire`.
**One daemon for all of the operator's repositories.** `POST /repos` adds one, checked once
by `stateDirRoot` (`core/worktree.ts`); the tracked/unignored 409 is gone with #129;
`POST /runs {cwd, run}` refuses a folder outside every added repository with a 403. One
port, one token, one dashboard; run state lives in each repository's own workspace under
`stateDirFor(root)`, and the repository list is in memory until M2-6. **M2-8's token ships here**, because every account
on the machine reaches `127.0.0.1` and a run file is a command line. It lives with the port
and pid in `$XDG_RUNTIME_DIR/kapelle/daemon.json` — a `0700` directory, a `0600` file,
outside every repository — and is published only once the port is open. That file is also
the **single-instance lock**: a second daemon finds a live pid and exits without touching
it, and a dead pid's file is replaced. **The sandboxing trigger fires with this story, and
sandboxing stays deferred** (see the backlog). **`ask` is refused with a 400 naming M2-3**:
with no decider `runRun` gives an `ask` task `safePolicy`, but `negotiateSafeMode` skips a
task that still says `ask` and `safe`'s `allowReadOutsideRoot` rule never runs, so on a
harness that never asks there is no containment at all. **The worktree preflight answers
before the 202**, as a 409; `openWorktrees` is read-only until `acquire`, and `runRun`
repeats it. `DELETE` is asynchronous — 202 with `cancelRequested`, the verdict on `GET` —
because `core/run.ts` already stops a harness 2 s after the abort.

**Amended (room model):** the daemon also serves `/rooms` (M6); the one-dashboard line now means one client surface, the TUI. Rooms are another execution surface behind the same loopback + token and the same sandboxing trigger.

**M2-2 · Event log and SSE replay · M · needs M2-1**
`GET /runs/:id/events`, SSE with replay-from-cursor, so a client attaching late still sees
history.
**Gap** — replay needs an ordered, durable, addressable event log, and the plan's only
persistence bullet describes "JSON per run, written on state transitions", which is a
different thing. No cursor semantics, no bound, and no statement of what happens to
per-token `agent_message_chunk` events, of which a single task produces thousands.
**Decision:** append-only `.kapelle/runs/<id>/events.jsonl`; monotonic per-run `seq` as
the cursor; `Last-Event-ID` honoured; in-memory ring (last ~1000) for hot replay and the
file for cold; **message chunks coalesced into the log per message rather than logged per
token** — live subscribers get the stream, the log gets the message, otherwise the log is
95% token fragments and replay is unusable. Settle this at M2 planning, not during M2-2:
the story's *size* depends on it.
*Done when* `curl -N` attached mid-run receives the history and then the live tail,
contiguously.
**Amended 2026-09-14 (pickup, #32): the Decision above is replaced.** (1) **The log is
raw**: every bus event, one line each as `{seq, agent, update}`, with `_meta`; chunks are
not coalesced, because joined text cannot be split again and a reader can join it. M0-4's
443 events per opencode turn makes a task tens of kilobytes, so (2) **no compression**;
M2-5's retention bounds the disk. (3) **The file is the only replay source**: each SSE
connection tails `events.jsonl` from its own offset, so history and live tail are one loop
and there is no ring-to-file hand-off. One open write stream; a caught-up reader takes the
line from the writer's in-process notification instead of the disk; no reader passes the
committed offset; memory is one byte offset per line. (4) The three supervisor variants
M1a-6 left for this consumer land here: `_client_task_started`, `_client_worktree_created`,
`_client_task_finished`. The log is `core/eventlog.ts`, subscribed by `core/run.ts`, so
`--file` runs write one too.

**Amended (room model):** room logs are `{seq, roomId, participantId, update}` (S10) and add `_client_user_message` / `_client_turn_ended`; the run log shape is unchanged.

**M2-3 · Permission over API · M · needs M2-1, M1a-5**
Pending decision list, `GET /permissions`, `POST /permissions/:id`, configurable timeout
(default ~120s) → **deny**, so an unattended run never wedges.
**Gap** — from M2 onward `ask` has two possible deciders (a TTY and the API), and from M4
three. The plan never says what happens when two clients answer the same pending decision.
**Decision: first writer wins; a second answer to a settled decision is a defined error, not
a silent overwrite.**
*Done when* a run submitted in `ask` mode with **no client attached** denies at timeout and
completes rather than hanging.
**Amended 2026-09-11 (M2-1, #31):** until this story lands the daemon refuses any task
resolving to `ask` with a 400 naming M2-3 (`refuseAsk`, `daemon.ts`). Lifting that refusal
is part of this story.
**Amended at pickup 2026-09-16 (#33): daemon only.** The CLI keeps its one-asker rule; M2-9's
`attach` is the next place a person answers, so it lifts that. The queue is
`core/permissions.ts`, handed to `runRun` as `RunOptions.askPolicy`. The answer is
`{"allow": boolean}`, not an option id, so `pickOption` stays the only place that picks. The
timeout is daemon-wide (M2-7's amendment): `--permission-timeout`, default 120 s. The queue
emits `_client_permission_queued` with the id, so M2-9 can answer from the stream. A second
answer is 409; cancelling a run denies what it has open.

**Amended (room model):** `PendingDecision` gains `roomId`, `participantId` and `turn` (S12); rooms reuse the same queue, first-writer-wins and timeout deny.

**M2-4 · Daemon lifecycle · S · needs M2-1**
Pidfile, single-instance guard, live-child registry, kill-all on shutdown, SIGTERM.
*Done when* a daemon crash leaves no harness subprocess alive holding write access.
**Amended 2026-09-11 (M2-1, #31):** the pidfile and single-instance guard landed with M2-1 —
`$XDG_RUNTIME_DIR/kapelle/daemon.json` holds the pid, a live one refuses a second daemon and
a dead one is replaced. What stays here: a strict lock for two daemons starting in the same
instant (it was marked `ponytail:` in `daemon.ts`; this story replaced it), the live-child
registry, kill-all, SIGTERM, and the `kapelle daemon start` and `kapelle daemon add <path>`
verbs.
**Amended at pickup 2026-09-15 (#34): stdin first, no process group.** Measured on all four
harnesses (`docs/FINDINGS.md` §M2-4): each runs its shell commands in a session of its
own, so a group kill never reaches them, and SIGTERM or SIGKILL left opencode's (and under
SIGKILL copilot's) running command alive. Closing stdin left nothing on all four, which is
also what a crash delivers. `AcpAgent.stop()` therefore closes stdin, waits, and SIGKILLs
only a survivor; `kapelle daemon start` runs in the foreground; live pids go to
`children.json` beside `daemon.json` for M2-5.
**A task now ends only once its harness has exited** (decided 2026-09-15, PR #109 review):
`runTask` awaits `stop()`, so the worktree is committed only after nothing can still write to
it. The cost is on purpose: `durationMs` includes the shutdown and the pool slot stays busy
for it — under 1 s measured, up to `stopGraceMs` + 250 ms for a harness that ignores end of file.

**Amended (room model):** `children.json` entries gain `kind`, `ownerId` and `unitId` (S14); the sweep reads the legacy `{runId, taskId}` shape as a run, and room harnesses register the same way.

**M2-5 · Crash-recovery sweep · M · needs M2-4, M1b-3**
The fuller version of "run `git worktree prune`". On boot: mark tasks left in `running` as
`errored`, kill or reap any registered child PIDs that survived, reconcile
`git worktree list` against persisted run records, and reap only those worktrees whose run
is terminal **and** past the retention window (default 7 days).
*Done when* `kill -9` then restart marks the task errored, reaps no worktree still within
retention, and leaves no harness subprocess alive.
**Amended 2026-09-11 (M2-1, #31):** one daemon serves every added repository, so the sweep
reconciles each of them — which needs the repository list M2-6 persists.
**Amended 2026-09-14 (M2-2, #32):** a task with `_client_task_started` and no
`_client_task_finished` in `events.jsonl` was cut off, which the sweep can read. The log is
uncompressed, so retention is its only disk bound; reaping a run removes its log with it.
**Amended 2026-09-16 (M2-6, #36):** the two inputs now exist — `repos.json` names every
repository to sweep, and each `run.json` carries run-level `startedAt`/`endedAt` (with the
task statuses) for the retention window. **The record left saying `running` is this story's
subject**: M2-6's boot scan deliberately restores terminal runs only, so a crashed one is
invisible to the API until the sweep marks it, rather than being listed as live with
nothing running it.
**Amended at pickup 2026-09-16 (#35).** Five decisions, in `core/sweep.ts`. (1) **`errored`
reads `failed`** — `TaskStatus` (`core/run.ts:72`) has no such rung; a task caught
`running` becomes `failed`, tasks still `queued` stay `queued`, and the record is rewritten
with `endedAt` = recovery time, which is what makes M2-6's boot scan restore it. (2)
**Retention is 30 days**, `DEFAULT_RETENTION_MS` in `core/sweep.ts` (the plan's 7 was
raised by the developer at implementation time); the constant stays until M2-7 carries the
knob. Reaping takes the whole footprint — worktree, branches, and the run directory
including `events.jsonl` and the stderr logs — and runs worktree-first: a checkout that
cannot be removed keeps its record for the next sweep. (3) **A worktree with no readable
record** loses a clean checkout but keeps its branch; a dirty one is kept and named in a
boot notice, and an unreadable record counts as absent. (4) **Surviving pids are
identity-checked**: `children.json` carries the `ps` start time recorded at spawn, and only
a still-matching pid is signalled (SIGTERM, then SIGKILL). (5) **Boot-only, in `core/`**,
awaited after the instance claim and before `restoreRuns`/`listen`; a per-repository
failure is a notice, never a refused boot.

**Amended by review 2026-09-17 (#35).** Six of the sweep's answers were wrong on the edge
that produced the debris in the first place. (1) **An orphan on a detached HEAD is kept**,
clean tree or not: `release` refuses the same shape for the same measured reason (#85), and
`kill -9` is exactly when an agent is most likely to have been interrupted after a
`git checkout <sha>`, where removing the checkout takes the reflog and the commits with it.
So decision (3) above now reads: clean **and still on a branch** loses the checkout, and
dirty **or detached** is kept and named. (2) **A pid that cannot be identified is named in
a notice** before `children.json` is deleted — it is still not signalled, because killing
blind is the worse failure, but the file was the last record of it and the skip was silent.
(3) **`processIdentity` is asynchronous**: `daemon.ts` records it from the
`_client_harness_spawned` listener, and a synchronous `ps` there blocked the event loop —
every run's SSE writes and permission answers — on each harness spawn; the field is filled
in once `ps` answers, since only the next boot reads it. (4) **The record temp file carries
the writer's pid** in both `core/sweep.ts` and `core/run.ts`: a `cli.ts --file` run in an
added repository writes the same `run.json`, and one shared `run.json.tmp` is how two
processes tear an atomic write. (5) **`git worktree list` failing is not an empty list** —
it now returns `null` and the repository's reap and orphan passes are skipped until the
next boot, rather than deleting checkouts behind git's back. (6) **Retention falls back to
`startedAt`** when a terminal record has no readable `endedAt`, which was otherwise
immortal — never past the window, and never an orphan either. Plus two smaller ones:
`markCrashed` isolates a failed record write, so one unwritable `run.json` no longer takes
its whole repository's sweep down on this and every later boot, and `daemon.ts` installs a
claim-file handler for the span of the sweep, which runs before the real signal handlers
exist. Retention is **30 days** in `docs/PROJECT-PLAN.md` too, which still said 7.

**Amended (room model):** the sweep also reconciles room participants' harnesses and room worktrees from the same registry.

**M2-6 · Persistence · S · needs M2-1**
JSON per run under `.kapelle/runs/<id>/`, written on state transitions. For completed-run
history, not live recovery.
**Revised by M0-1 — the stated reason was wrong.** "ACP has no resume" holds for the base
protocol but not for any harness we target: all three advertise
`agentCapabilities.loadSession: true`, and opencode and claude-agent-acp also advertise
`sessionCapabilities.resume` and `.fork`. History-only is therefore a scope choice, not a
protocol limit. **Persist the harness `sessionId` on the run record here** — it costs one
field, and without it the backlog's `session/load` item cannot be picked up later without a
migration. Actual reattachment stays out of scope and stays capability-gated. Single-process and single-writer, which is why this is JSON and not the SQLite
ensemble needs for concurrent plugin writers — and zero runtime dependencies stays with it.
**Amended 2026-09-11 (M2-1, #31):** persist the list of added repositories too. The daemon
keeps it in memory, so a restart forgets every `POST /repos`. It belongs to the daemon, not to
a repository, so it lives in a user-level location rather than in any one `.kapelle/`.
**Amended 2026-09-14 (M2-2, #32):** replay after a restart comes from M2-2's file. The
daemon keeps only a `seq → offset` index per run, so this story rebuilds it by reading
`events.jsonl` once; no second replay path. The run JSON stays separate from the log.
**Amended at pickup 2026-09-16 (#36).** Two decisions and one correction.
**(1) The repository list lives in a state directory, not the runtime one** —
`$XDG_STATE_HOME/kapelle/repos.json`, or `~/.local/state/kapelle` where that is unset.
`runtimeDir()` resolves to `/run/user/<uid>` on Linux, a tmpfs cleared at logout, so a list
kept beside `daemon.json` would survive a daemon restart and not a reboot; a list that is
sometimes there is worse than one that never was.
**(2) The daemon reads records back on boot**, so `GET /runs`, `GET /runs/:id` and
`GET /runs/:id/events` all answer for runs from before the restart — M2-2's amendment
already promised the SSE half, and M2-9's `kapelle attach <run-id>` needs the lookup. The
scan follows the repository list rather than a second index, and M2-5 reuses it. **Terminal
runs only**, per that story's amendment above.
**(3) "Rebuild the index by reading `events.jsonl` once" understated the change.** The
`seq → offset` index is `starts[]` inside a log `createEventLog` opens with `flags: "w"`,
which truncates. Replay needs a **read-only** open, `openEventLog` (`core/eventlog.ts`), and
it drops a trailing partial line the way the writer's "committed, not appended" rule does.
The record itself is now written at every task transition — `queued`, `running`, then the
verdict — atomically (temp file plus `rename`), and for **every** run with a log directory,
including the shared-cwd fallback that has no branches: `core/merge.ts` already refuses a
task with no branch by name, which beats "no run record. Run it first."
`sessionId` rides the task entry, set once `session/new` answers — the success
path, a cancel before the prompt, and a throw out of the harness.

**Amended (room model):** rooms persist under `stateDirFor(root)/rooms/<roomId>/` with `room.json`, participant records and the room event log; restore is no longer read-only — a restored room comes back `paused` and a participant revives on its next message with a fresh session (S3(b), R42) — and the participant record carries `sessionId` (S4). `session/load` reattachment (S3(c), Half B) stays capability-gated and deferred.

**M2-7 · Config · S · needs M2-1**
`.kapelle/config.json`, `KAPELLE_*` env override, layered env > project. Home for the
knobs that do not belong in a run file: watchdog thresholds, TTL, retention window, port,
permission timeout, `maxConcurrency` default.
**Gap** — the plan introduces the file but says nothing about validating it. A
silently-ignored `stallIdleMs` typo is a watchdog that never fires.
*Done when* unknown keys and type mismatches are rejected loudly at load.
**Amended 2026-09-11 (M2-1, #31):** one daemon serves every repository, so the daemon-wide
knobs — port, permission timeout — cannot come from one repository's `.kapelle/config.json`.
They need a user-level file or `KAPELLE_*`; per-run knobs keep the project layer.
**Amended 2026-09-14 (M2-2, #32):** no replay buffer size to configure — M2-2 has no ring.
**Amended at pickup 2026-09-17 (#37).** Three decisions. (1) **Unknown `KAPELLE_*` env
names warn and are ignored**, not refused: the prefix is also `SECRET_PREFIX`
(`protocol/registry.ts:96`), stripped from every harness, so an unknown name may be a
secret rather than a typo; a known name with a bad value still refuses the load. (2)
**Precedence is run file > env > project config > built-in**; for the daemon-wide knobs a
CLI flag sits above env, which sits above the user-level file. (3) **Retention is per
repository** in `.kapelle/config.json` (env above it), read by each repository's sweep
pass, rather than one daemon-wide number. Both files are strict — an unknown key or a
wrong type is refused naming file and key — and a bad project config refuses that
repository's run and skips its sweep, never the daemon's boot. Implemented in
`core/config.ts`.

**Amended (room model):** room knobs live here too: per-participant queue bound, room retention, idle eviction (off in v1).

**M2-8 · Auth · S · needs M2-1**
Localhost-only bind plus a shared-secret token file. Not optional: anything that can
`POST /runs` with `mode: auto` executes commands as the user, and once M4 can dispatch runs
*every* write endpoint is an execution surface, not just `POST /runs`. `EventSource` cannot
set custom headers, so the token must also be acceptable as a query parameter on the SSE
endpoint or exchangeable for a cookie by a login POST — decided here so M4 is not blocked;
the localhost-only bind is unchanged. Strips `KAPELLE_*` from child environments before
spawn (M1a-4).
**Amended 2026-09-11 (M2-1, #31): the token moved to M2-1.** `daemon.ts` writes a fresh
32-byte token to `$XDG_RUNTIME_DIR/kapelle/daemon.json` at each start and refuses any
request without it. What stays here is the browser half — the query parameter or cookie
exchange, and a `Host` check against DNS rebinding once a page the daemon serves holds the
token. The `KAPELLE_*` strip already landed with M1a-4.
**Amended at pickup 2026-09-17 (#38): this story is the `Host` check alone.** The browser
token moves to **M4-1**, and the cookie/`POST /login` half of the either-or is dropped
outright — when M4-1 builds it, it is `?token=` on the SSE route. A browser is the only
client that needs it: nothing serves `text/html` yet, and a **TUI is not the same case** —
it runs as the operator, reads `daemon.json` the way `kapelle daemon add` does
(`cli.ts:583-613`), and streams SSE with `fetch`, which can set headers. That is M2-9's
`attach`, not auth work. The `Host` check stays here because it guards the daemon now
rather than only once a page holds the token: `LOOPBACK_HOST` (`daemon/http.ts:38`) admits
`127.0.0.1`, `localhost`, `localhost.` and `[::1]`, with or without a port and in **any
case** — a hostname is case-insensitive (RFC 9110 §4.2.3) and `curl`, Python, Go and Java
all copy the caller's spelling into `Host`, so a case-sensitive match refuses a local
client with a security-shaped error. The regex takes `/i` and **not** `/u`, which would
fold `localhoſt` into a match. Anything else is `403` before the token is read. The
**port is deliberately not matched**: rebinding needs an attacker-chosen DNS name to gain
same-origin access. Direct cross-origin requests to a loopback URL still arrive with a
loopback `Host`, but without the bearer token they are refused; matching the port would
add no protection against those.

**The guard reads `authorityOf`, not `req.headers.host`,** because an HTTP/1.1 message
carries the authority in two places and the header is not always the one that counts.
An **absolute-form** target (`GET http://evil.example/repos`) is authoritative and `Host`
is ignored (RFC 9112 §3.2.2) — reading the header there added a repository through a
forged target, and refused a loopback target that carried a forged header. **Two `Host`
lines** are malformed (RFC 9110 §7.2) and Node keeps only the first, so a loopback line in
front of a forged one passed; `rawHeaders` is where both survive, and more than one is a
refusal. Neither shape is reachable from a browser — a page can emit neither — so this is
the allowlist being closed rather than a live rebinding path.

A request with **no** `Host` at all is refused by the same guard: on HTTP/1.1 because
`requireHostHeader: false` hands it here instead of letting Node answer `400`, and on
HTTP/1.0 — where that option has no say — because there is then no authority to match.
Master served the HTTP/1.0 shape; one rule ("a loopback authority, or `403`") is worth
more than the `nc` health probe it costs. All of it is asserted in `tests/daemon.test.ts`.

**Amended (room model):** the browser half is retired (A3); `?token=` and the cookie exchange return only with a browser client. The Host check and the bearer token stay.

**M2-9 · `--detach` and `attach` · M · needs M2-2, M2-3**
Submit a run file to the daemon, stream SSE, answer permissions interactively, print
results.
**Amendment 2026-09-06 — there is no second CLI. `runs.ts` is dropped.** The story read
"two front ends, one core: `run` drives in-process, `runs` talks to the daemon". Three
things are wrong with that, and none of them is the daemon.

1. **`runs` is not a word for what it does.** The `s` came from the HTTP path `POST /runs`,
   which is plumbing. Read as English it says "many runs", and the actual difference is
   *local versus detached* — a run file is N tasks on both sides.
2. **`run` and `runs` differ by one letter** for a difference that is not one letter big,
   and `core/run.ts` already collides with the front end's `run.ts` (M1c-5 owns the file
   names).
3. **A second CLI is a second place to keep the flags, the notice rules and the SIGINT
   grace in step.** That is the argument M1b-2 already used to put `--file` on `run.ts`
   rather than in a new file, and M1b-8 uses to retire `fanout.mjs`. It does not stop being
   true one milestone later. The CLI is already subcommand-shaped: M1c-3 adds
   `kapelle merge`, and M1c-5 adds the `bin` that makes subcommands the surface people
   type.

**Decision: one command, and a flag for the difference.**

```text
kapelle run tasks.json             # in-process; dies with the terminal
kapelle run tasks.json --detach    # hands it to the daemon, returns the run id
kapelle attach <run-id>            # stream a detached run, replay included
```

`attach` is its own verb rather than a flag on `run`, because reattaching starts no work —
it is a different job with a different argument, and M2-2's replay-from-cursor is the whole
of it. What is dropped is the *file and the name*, not the code: submitting over HTTP,
streaming SSE and answering permissions interactively are all still this story's
deliverable, reached through `--detach` and `attach` instead of a second binary.
*Done when* `kapelle run <file> --detach` returns a run id while the run continues
without the launching terminal, and `kapelle attach <run-id>` on a later terminal receives
the history and then the live tail.
**Amended 2026-09-11 (M2-1, #31):** `--detach` reads the port and token from
`$XDG_RUNTIME_DIR/kapelle/daemon.json` and sends `{cwd, run}`, with `cwd` the folder it was
started in; a repository not yet added answers 403.
**Amended 2026-09-14 (M2-2, #32):** the stream is raw — every bus event, text chunks
included, `id:` its `seq`, `Last-Event-ID` honoured — so `attach` can feed it to
`render.ts`. `render.ts` owns one stream at a time, so an N-task run needs the `--file`
path's shape: one task in full, or milestones for all; that choice is this story's. Task
boundaries arrive as `_client_task_started` / `_client_task_finished`.
**Amended at pickup 2026-09-18 (#39).** (1) **The run file is a verb's flag:** `kapelle run
--file <f> [--detach]`, and the bare `kapelle --file` is refused with a line naming the new
spelling, so every job is a verb like `merge`, `daemon` and `attach`. An unquoted prompt
starting with `run` now meets the verb. (2) **The in-process path keeps its one-asker rule**;
its notice names `--detach` plus `attach`. (3) **`attach` offers both shapes**: milestones for
all tasks by default, and `--task <id>` for that one task in full through `render.ts`, with
only its asks — the filter is client-side, since every event already names its task. Each
task card is built from the stream, because a run restored after a restart has no `report`. It asks one `_client_permission_queued` at a time, on a TTY only, and only while
`GET /permissions` still lists it; ^C leaves the run running. Found on the way: readline
swallowed ^C at a y/N prompt on a TTY and hung every `ask` path, so `makeAskPolicy`
re-raises it as a real SIGINT.

**Amended (room model):** `attach` is later refactored onto the shared `client/` module (M5-10); the room SSE shape is `{seq, roomId, participantId, update}`.

**M2-10 · List detached runs and their tasks · S · needs M2-9**
Added 2026-09-18 at M2-9's pickup (#39). A person who detached runs has no command that says
what is still going. `GET /runs` answers `{id, cwd, status}` only, and a live run's state in
`daemon.ts` carries no task list: the per-task state is in each repository's
`.kapelle/runs/<runId>/run.json`, written at every transition (M2-6). Add a verb — `kapelle
ps` is the working name — that lists runs and each task's id and status, reading
`daemon.json` through `daemonApi()` as `attach` does.
**Gap** — the daemon must report a live run's tasks: keep them in memory from the
`_client_task_*` events, or read the record back on `GET`. Decide at pickup.
*Done when* the verb lists every running run with each task's id and status, and a finished
run shows its verdict.
**Amended at pickup 2026-09-18 (#121): the gap is closed with a callback.** `core/run.ts`
hands `daemon.ts` the same task list it writes to `run.json`, through `RunOptions.onTasks`,
at every transition, and the first time before its first `await`, so a live run is never
listed without tasks. `GET /runs` carries `tasks: [{id, status}]` on each entry, so
`kapelle ps` makes one request. Rejected: reading `run.json` on each `GET` (a file read per
request), and rebuilding the list from `_client_task_*` events (a second copy of the status
rules, and no event exists for `queued`).

---

## M3 — Pipeline, DAG, terminals

**Runs only.** The dependency graph, worktree inheritance and handoff below are
run-file semantics. Rooms have no graph and no scheduler (M6); they never reuse these stories.

**M3-1 · `core/scheduler.ts` · M · needs M1b-2**
Topological execution: parallel where no `needs`, sequential where there is. Lifts M1b-1's
rejection. Cycle detection is a validation error.
*Done when* `node:test` covers toposort, cycles, and the dependent-skipping rule from
M1b-2's `skipped` decision.
**Amended 2026-09-14 (M2-2, #32):** a skipped task never starts, so it emits
`_client_task_finished` with status `skipped`, as a task cancelled before it started already
does — otherwise the log and SSE viewers never learn it existed.

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

## M4 — TUI

The first thing here that is not a CLI. `spike/chat-tui` proves the screen; these stories
move it onto the shared `client/` module and add the roster, permissions and the
multi-room surface. The browser dashboard stories are retired (A3, A7); `chat.ts` and
pi-tui are the direction.

**M4-1 · pi-tui screen as the first shared-client consumer · M · needs M6-0, M5-10a**
`spike/chat-tui` is still one unlanded commit — M6-0 deliberately left it there (#144), so
this story rebases it onto master as its first step. The spike screen becomes a consumer
of `client/`: its `Daemon`, `api`, `follow`,
`RoomView` and `LogEvent` move into the module, and `chat.ts` keeps only the screen and
the commands. Ratify `@earendil-works/pi-tui` 0.85.1 under M1c-7's rule (presentation
only, worst failure cosmetic, pinned exactly), override the nested `marked` 18.0.5 pin
to 18.0.12, and record the optional `darwin-modifiers.node` helper: lazily
loaded, try/catch-guarded, Shift+Enter only on Apple Terminal, never on Linux.
*Done when* `chat.ts` imports `client/`, pi-tui and `core/runtime.ts` (for the
`daemon.json` path, M5-10a) and nothing else from the repository,
the import-boundary test says so, and the TTY test still leaves the transcript in
scrollback.
Decisions: S7, S8, S9, M6. (S8 settled as (a).)
**Built 2026-09-27 (#47).** The spike is rebased; its `daemon.ts` and `CLAUDE.md` hunks
were dropped, because master rewrote both. pi-tui 0.85.1 is ratified under M1c-7's rule
and pinned exactly. 0.87.1 was out, but the spike measured 0.85.1, and a bump is its own
change. It brings one transitive runtime package, `get-east-asian-width` 1.6.0 (MIT, no
dependencies). pi-tui pins `marked` 18.0.5 exactly, and `overrides` points it at ours
(`$marked`), so `npm ls marked` shows one copy. That is an override of a pin, not a
dedupe of a range: pi-tui's markdown runs on a `marked` its author did not test. It is
taken because the worst case is a badly drawn answer. Look here first when a pi-tui
render goes wrong. npm reads `overrides` only in the root project, so if kapelle were ever
installed as a dependency, pi-tui would get its own `marked` again. That is two copies,
and it still works. pi-tui ships two native helpers, both loaded lazily inside a
try/catch: `darwin-modifiers.node` (Shift+Enter in Apple Terminal only) and
`win32-console-mode.node` (Windows only). Linux loads neither. `chat.ts` now reads its
room with `followEvents`. It reconnects after a cut only while the daemon still
answers: a room does not survive a restart, so waiting for a new daemon would wait
forever.

**M4-2 · Room and roster sidebar, switching, unread badges · M · needs M4-1, M6-4, M6-10**
**Amended 2026-09-26:** the screen state comes from M6-10's room reducer; this story only
draws it. A room list from `GET /rooms`, a rooms → participants tree, switching between rooms and
participants without losing their streams, and unread/attention badges derived from
events (`_client_turn_ended`, permission queued, stall warning). This is the
"multiple chat rooms" requirement, one level richer because a room has a roster. **The
room opens on the timeline**, and the composer — not the row cursor — names the target
(R43): a leading `@name` resolves client-side to a participant id, and a message with no
mention goes to the orchestrator; the rules are `docs/CLIENT-API.md` § Addressing.
Opening a participant's thread pre-fills `@name` in an empty composer; the timeline
pre-fills nothing. The filtered streams and the nested `messages` route are M6-4's, which
is why this story needs M6-4. The resolver is its own module, `client/mention.ts`, never
an export on `client/contract.ts`, so `daemon.ts` never imports a message parser; piped
`chat.ts` uses the same module (S8). **Amended 2026-09-26:** M4-1 already widened the
`chat.ts` import rule to `client/`, so this story changes no rule; the test stays
transitive, and this module reaches nothing under `core/` or `protocol/` at runtime. The stall warning the badge reads is the one R38 creates: a
participant's watchdog warns, never cancels.
*Done when* the timeline is the landing view, switching rows changes the filtered thread
without losing a stream, a message starting `@name` reaches that participant, a message
with no mention reaches the orchestrator, opening a participant's thread pre-fills its
`@name`, and every refusal in § Addressing has a resolver test.
Decisions: R8, R19, R43, S11, R38. (S11 settled as (a) plus the additive `_client_room_closed`.)
**Decided at pickup 2026-09-30 (#48):** the sidebar lists every active room the daemon
holds, from all repositories; a filter for one repository comes later. A click,
`alt+↑↓` or `ctrl+p/n` picks a row, so `↑ ↓ Enter` stay with the composer and Tab stays
free for M4-4's completion. Two keys do one job: `alt+↑↓` is the easy one, and `ctrl+p/n`
works where a terminal sends no alt+arrow (macOS Terminal without "Option as Meta", some
tmux setups). A row's circle is `●` when something waits (unseen lines, a
question or a stall) and `○` when nothing does; the name is magenta for a question and
yellow for a stall. `«`/`»` and `ctrl+t` hide the sidebar, and it starts hidden below 70
columns. **`kapelle chat` moves here from M6-9**, with S7a's name.
**Built 2026-09-30 (#48).** `client/mention.ts` resolves the target, and both screens
send through it: piped `chat.ts` no longer sends to the first participant. The screen
keeps one stream and one reducer per room, polls `GET /rooms` every 5 s for rooms made
elsewhere, and exits when every room it holds lost its stream (M4-5: with no room left,
it stays open, so the person can open one). What is on screen counts as
seen: the timeline marks its whole room, and a thread marks its participant. A
`@name` pre-fill the person did not touch follows the view, so it never names the
thread just left. In a thread, an empty composer always holds the thread's `@name`: after a
send, and after a delete by hand (R43, amended the same day).

**M4-3 · Answer per-participant permissions from the TUI · M · needs M4-2, M5-4, M6-5**
With a person at the keyboard, a participant can run `ask`: a queued permission names the
room, the participant and the turn, opens an overlay, the answer posts by id, and every
other observer sees the same decision through the answered event.
*Done when* answering in the TUI lets the turn proceed and a CLI observer on the same room
sees the same decision.
Decisions: R12, S2, S12, D1–D8. (S2 settled: per participant at add, default `auto`.)
**Decided at pickup 2026-10-01 (#49):** the box opens by itself when the composer holds
no typed text (an `@name` pre-fill counts as empty) and no pop-up is open; otherwise it
waits, and `ctrl+o` lists the open questions first. `deny` is selected first, so a stray
Enter says no, as a timeout does. One box at a time, oldest first, from any view. The
question carries `input`, the harness's `rawInput` as it sent it, capped, and the box
shows it as `key: value` lines. Control characters are removed before drawing. The piped
screen prints the question and how it closed: that is the CLI observer. The diff moves
to M4-6: a pop-up is no place for one.
**Built 2026-10-01 (#49).** `core/permissions.ts` cuts the input (`capInput`), and the
reducer removes control characters (`printable`, `client/room.ts`); the event and
`GET /permissions` carry `input` since 1.6. Four pty tests drive the box: one with a piped
observer on the same room, one for a thread's `@name` pre-fill and Esc, one for a question
closed elsewhere, and one whose fake daemon makes the `409` reply land, so the message
comes from `GET /permissions/:id`. **Review of #205:** Esc or `ctrl+o` on a question box
means away, so the next question waits too; only an answer, or a close from elsewhere,
opens the next. The box wraps the action and the input instead of cutting them.

**M4-4 · Notifications and transcript polish · S · needs M4-2**
Terminal bell and desktop notification for a participant waiting on a permission or
stalled, transcript search, and the block-splitting optimisation for the `Markdown`
component if the measured re-parse cost grows past the spike's ~5 ms at 53k chars. The
stall half needs R38; without it no room emits `_client_stall_warning` and there is
nothing to ring for. Mention autocomplete for the roster is the R43 polish this story
owns; M4-2 ships the resolver with plain text.
Decisions: R19, R43, R38. (F9 dropped by M5-6, #138.)
**Decided at pickup 2026-10-05 (#50):** the TUI owns the room's attention signal, and the
daemon does not ring. **No desktop pop-up**: it is too noisy. `core/notify.ts` stays as it
is, for `cli.ts` runs. In its place, a **banner** on top of the timeline: one row per
participant that waits off screen, magenta for a question and yellow for a stall, with who,
which room and why. A click opens the thread, and the question's box. The terminal bell
rings once when a participant starts to wait. **No plain search**: pi-tui already searches
the transcript (`ctrl+shift+f`). In its place, a **history list**: the person's own
messages in the view, in the side view, one row each, cut to its width. A click or Enter
scrolls the transcript there, and the row under the mouse lights up.
**Built 2026-10-05 (#50).** `chat/view.ts` says who waits (`waiting`), the banner's rows
(`banner`) and when the bell rings (`bell`); `chat/tui/banner.ts` draws the rows. A wait is
an open question, or a stall warning in the live turn: the reducer keeps the warning's
text on the turn, so `seen` hides it from the banner but not from the bell. The bell looks
after each chunk of lines, so a replay rings only for what is still open at its end.
`ctrl+r` opens the history list; the side view shows a list as well as a diff. `@` at the
start of the composer, or Tab after it, lists the room's names (`mentionsFor`,
`client/mention.ts`). The re-parse cost was 13 to 23 ms at 53k chars (§M4-4), past the
threshold, so an answer's finished blocks go into their own `Markdown` (`settled`).

**M4-5 · Room and roster commands in the TUI · M · needs M4-2, M6-3, M6-4, M6-5**
**Added 2026-09-26.** M6-2..M6-5 build the routes, and M4-2 only lists
and switches, so no story let a person drive a room from the screen. Today `chat.ts` has
only `new`, `attach`, `list` and `dismiss`, as shell verbs. This story adds, inside the
TUI: open a room (empty, or with an orchestrator) and dismiss it; add a participant
(harness, name, role, mode, and a `base` ref, so a reviewer can start from the developer's
branch — the field M6-3 adds), remove it, rename it and change its role; cancel a participant's current
turn; and change its mode. Each command calls one documented route. A refusal shows its
error code's message; the screen never guesses.
*Done when* every command above reaches its route against `mock-agent.mjs`, and each
refusal the route documents has a test that shows its message.
Decisions: R10, R12, R21, R35, R44, S5.
**Decided at pickup 2026-09-30 (#181):** each command has two ways in. `ctrl+o` opens a
menu in a box at the centre of the timeline, wide enough for a folder or a command (moved
there from the sidebar the same day); in a thread it lists that agent's commands at once.
A typed command
names its agent with a leading `@name`, as a message does, and is refused without one;
`/new` or `/add` alone opens its form in the same box. A refusal stays in the form; a success is one
status line. With no room, the screen stays open; it exits when the daemon is gone, until
M6-7a lets it follow a restart. While a pop-up is open, the row keys do nothing: Esc first.
The menu has a `help` row.
**Built 2026-09-30 (#181).** `client/command.ts` parses the typed commands and calls
the routes; both screens and the pop-up forms go through it. `--base @name` sends that
participant's `branch`. The piped screen takes the same commands and has no forms.
`shutting_down` has no test of its own: every refusal goes through one path.
**Added 2026-10-01 (#181):** in the new-room form, Tab completes the folder (folders
only, `client/folder.ts`); the harness row lists the measured harnesses from a new
Experimental `GET /harnesses`, then `other…`; and a `/new` refused with `repo_not_added`
asks to add the folder, then opens the room. The piped screen prints
`kapelle daemon add <path>` instead.
**Added 2026-10-01 (#201):** while a pop-up is open the status line swaps its key hint
for `esc back · ctrl+o close`; the composer's hint returns when the box closes.

**M4-6 · Diff view in the TUI · L · needs M4-3, M4-12**
**Added 2026-10-01 (#49 pickup).** A question about an edit shows its diff in a view of
its own, never in the answer box. The box gets one line, `± <path> +a −d`, and a
`view diff` row. The view replaces the transcript, keeps the sidebar, scrolls, and
answers with `y` or `n`; Esc goes back to the box. The view reads `git diff` text, so
M6-11a and M6-11b hand it their own diff before a move or a land. Where a question's diff
comes from: the harness's `diff` content block, when the tool call has one before the
ask; else the daemon builds one from the new text (copilot's `rawInput.file_text`, or our
own `fs/write_text_file`) against the file on disk, after the path guard, with
`git diff --no-index`. A shell command has no diff. `_client_permission_queued` and
`GET /permissions` gain `diff`, capped, and control characters are removed before
drawing, as for M4-3's `input`.
*Done when* a mock-agent `ask` write shows its diff in the view and is answered from it,
a `file_text` ask gets a built diff, a path outside the checkout gets none, and the view
draws a diff text a caller passes in.
Decisions: R12, R45, R47. **Open at pickup:** the cap, and how a new or deleted file
shows.
**Amended 2026-10-02:** it also needs M4-12, so its diff holds only the new view and no
code that moved.
**Decided at pickup 2026-10-05 (#204), size now L:** the view is a **side pane** right of
the timeline, not in its place; below 120 columns it replaces the timeline, as first
written. It takes any `git diff` text, so M4-13 reuses it. **An agent's own changes, in
any mode:** `auto` asks nothing, so a question diff misses the common case. `/diff @name`,
or `view changes` in the agent's `ctrl+o` menu, opens them from a new
`GET /rooms/:id/agents/:agentId/diff?against=head|base`: uncommitted by default
(`git diff HEAD` and the untracked files, read without `git add`), and `b` switches to
the whole branch, from `baseSha`. It is a snapshot; `r` reloads. **Many files are one
scroll:** the title names the file (`2 of 20`), and `]` and `[` jump. A question's
`AcpAgent` names the edit after the path guard, and `core/` builds the diff only for a
queued question, so `auto` and `safe` pay nothing. **The cap:** 32 KB for a question,
which the daemon keeps; 512 KB for the route, which it does not. Both cut at a line end,
and `+a −d` is counted before the cut. **New and deleted files** show `(new)` and
`(deleted)`, from git's header. Several files make one box line:
`± cli.ts and 19 more files +120 −30`.
**Built 2026-10-05 (#204).** `core/diff.ts` builds both diffs; `client/diff.ts` reads
one for a screen; `chat/tui/pane.ts` is the pane. The piped screen prints `/diff` as text.
Four things the build found. pi-tui 0.85.1 gives the first of two `grow` entries about
two thirds of the space, so the pane gets a set width and the timeline the one `grow`.
Every size in that row is set, because an `auto` size makes pi-tui measure each line on
every frame: half a second for a 10,000-line diff, and about 10 ms per key after. pi-tui's
screen takes the page keys for the timeline, so the chat hands the pane every key while it
has them. A diff that fits the pane cannot scroll, so `]` and `[` remember the file they
picked.
**Added 2026-10-05 (#204): a view, not a box.** The side view is a second view beside the
timeline, as the sidebar is: `ctrl+x` shows and hides it, and what it shows stays while it
is hidden. Before anything is put in it, it says how to fill it. It has the keys when shown,
and `ctrl+]` gives them to the composer and back, so a message goes out while the diff
stays in view; its single-letter keys (`y`, `n`, `b`, `r`) would otherwise type into both.
Esc gives the keys back without hiding it; for a question it also brings the box back.
`ctrl+o` opens the menu as everywhere. An answered question's diff stays, and its title
says how it closed. M4-13's terminal uses the same view and the same keys.

**M4-13 · A terminal in the side pane · L · needs M4-6**
**Added 2026-10-05 (#204 pickup).** The side pane M4-6 builds also holds a real
terminal: a shell in the agent's checkout, beside the timeline, where full-screen
programs such as `vim` and `less` work. M4-6's `ctrl+]` moves the keys between the
composer and the terminal. It needs a pseudo-terminal (a pty) and a screen emulator. The
likely pair is `node-pty` (native, starts the shell) and `@xterm/headless` (no dependencies); a pty
starts a process, which M1c-7's rule forbids today, so this story first amends that rule
and compares the options: `node-pty`, a prebuilt fork of it, or `script(1)`, which needs
no native code but cannot resize. Not ACP `terminal/*`: that stays off (§M0-3).
*Done when* a shell in the pane runs `vim` in the agent's checkout, resizes with the
screen, and its exit leaves the chat running.
Decisions: M1c-7 (amended here).

**M4-7..M4-12: take the logic out of the screen.** **Added 2026-10-02.** `chat.ts` is
2000 lines, and `chatTui` is one function of about 1280 of them. It draws and reads keys,
and it also decides things: which question opens next, what the composer pre-fills,
which rooms it follows and when the screen ends. That logic has no unit test; only the
pty tests reach it, and the bugs fixed in #205 were all there. The piped screen also
repeats the TUI's send flow. These six stories move the logic out, one piece at a time,
before M4-6 adds a view. The shape at the end:

```text
client/   any front end: no pi-tui, no stdout, unit tests (S8 already holds this)
  daemon.ts  stream.ts  contract.ts          talk to the daemon
  room.ts  roomset.ts (M4-11)                room data
  mention.ts  command.ts  folder.ts          rules
  submit.ts (M4-8)  questions.ts (M4-9)
chat/     this command's screens: draw and read keys
  view.ts (M4-10)                            screen-only rules, pure, unit tests
  tui.ts  tui/*.ts (M4-12)  piped.ts  common.ts
chat.ts   the entry: arguments, the daemon, which screen
```

**Decided 2026-10-02:** rules any front end needs go in `client/`, where a bridge to
another chat app can use them. Rules only this screen has (rows, the `@name` pre-fill,
seen marks) go in `chat/`, still pure and still unit-tested. The folder is named after
the command, as `daemon.ts` and `daemon/` are. Each story moves code and changes no
behaviour: every existing test passes unchanged, except the import-boundary test, which
M4-7 and M4-12 widen to the new folders. A bug found during a move is reported, not
fixed in the same story. Each story that adds a file also adds its row to the table in
`AGENTS.md`, and the file opens with a comment that says what it holds and why. In order: M4-7, M4-8, M4-9, M4-10, M4-11, M4-12, then M4-6.

**M4-7 · One file per screen · S · needs M4-3**
Move code only. `chat.ts` keeps the entry: the usage, the arguments, the `new`,
`attach`, `list` and `dismiss` verbs, and the choice of screen. `chatPiped` and
`makePrinter` go to `chat/piped.ts`. `chatTui`, with its types and themes, goes to
`chat/tui.ts`. What both use (`address`, `readRoom`, `reconcile`, the colours, `unpad`,
`rosterOf`) goes to `chat/common.ts`. The comment at the top of `chat.ts` is split, so
each file keeps the part about itself.
*Done when* `git diff --color-moved` marks every moved line as moved, apart from the
import blocks, every other test passes
unchanged, and the import-boundary test in `tests/daemon.test.ts` holds every file in
`chat/` to the same rule as `chat.ts`. The test reads the files directly in `chat/`,
not `chat/tests/`: a test may import anything. In `AGENTS.md`, the `chat.ts` row says
it is the entry only, `chat/` gets a row, and the dependency sentence under "Where things
are" gains the arrow `chat.ts` → `chat/` → `client/`.
Decisions: S8, M1c-7.

**M4-8 · One send flow for both screens · S · needs M4-7**
Both screens read a typed line the same way: `parseCommand`, then a refusal, `/leave`,
`/help`, a form or a command; else `resolveTarget` and a message. Today each screen has
its own copy. `client/submit.ts` decides, from the text and the roster, which of those
the line is, and does no I/O. Each screen then does its own part: the TUI opens a form
or asks to add a folder, and the piped screen prints the command to run or waits for the
turn to end. A refusal that names a key, such as `ctrl+o`, keeps its words in the
screen. **Decided 2026-10-02:** the TUI's "no room" and "no agents" checks stay in the
TUI. Both name `ctrl+o`, and the piped screen has neither today, so moving them would
change what a piped user sees. They run when `client/submit.ts` says the line is a
message, before the target's refusal is shown. Run before the call, they would refuse
`/new` with no room open (#214).
*Done when* neither screen calls `parseCommand` or `resolveTarget` itself, and
`client/tests/submit.test.ts` covers each outcome.
Decisions: R43, S8.

**M4-9 · Question queue out of the screen · S · needs M4-7**
`chatTui` keeps the queue of open questions itself: `waiting`, `aside`, `asking`,
`questions()`, `syncBox` and `offer`. `client/questions.ts` takes the rules M4-3 decided:
one queue over every room, oldest first; a question put aside (Esc, `ctrl+o`, or
answered here before the close came back) never opens by itself again; a question
closed elsewhere leaves the queue; nothing opens while something is in the way; and the
box's place, `n of m`. The screen says whether something is in the way (a pop-up, or
typed text) as one boolean, and keeps the timer that opens the next box. **Decided
2026-10-02 (#206 review):** the queue goes in `client/`, though only the TUI uses it
today. A bridge to another chat app would want the same rules: oldest first, a question
put aside stays aside, and `n of m`.
*Done when* `chat/tui.ts` holds none of that state, and `client/tests/questions.test.ts`
covers each rule above.
Decisions: R12, S8.

**M4-10 · View and pre-fill out of the screen · S · needs M4-9**
`chatTui` decides what the person looks at: `view`, `prefill`, `rows()`, `open`,
`markSeen`, the row keys, and the branches of `onLine` that follow a rename or a removed
participant. `chat/view.ts` takes those rules, pure: from the rooms, the view and the
composer's text, it gives the next view, the pre-fill and what is seen. The screen sets
the text and draws. It needs M4-9 because both change `onLine`.
*Done when* `chat/tests/view.test.ts` covers: the row order and the row keys; an
untouched pre-fill follows the view, and typed text stays; a rename moves an untouched
pre-fill; a thread whose participant left goes back to the timeline; a dismissed room
goes to the first row; the timeline marks its whole room seen, and a thread marks its
participant.
Decisions: R43.

**M4-11 · The room set out of the screen · M · needs M4-10**
`chatTui` follows the rooms itself: the `rooms` map, `follow`, `loadDto`, `closed`, the
5 s poll of `GET /rooms` and `gone`. `client/roomset.ts` takes them: one stream and one
reducer per room; a room made elsewhere joins on the next poll; a dismissed room
leaves; and when the screen must end (every room lost its stream, or no room is left
and the daemon is gone or answers `401`). `readRoom` and `reconcile` move with them,
and the piped screen uses them from there. `reconcile` returns what happened, not a
line: its lines name `kapelle chat attach`, so each screen writes the words, as M4-8's
refusals do. `client/` may not import `core/runtime.ts`
(S8), so the module takes a function that reads the daemon's address. The poll period
is a parameter, so a test does not wait 5 s. Riding out a daemon restart stays M6-7a's.
The two may land in either order: after M4-11, M6-7a's chat half changes
`client/roomset.ts`; before it, M4-11 moves the reconnect with the rest.
*Done when* `chat/tui.ts` has no poll, no map of rooms and no `reconcile` call, and
`client/tests/roomset.test.ts` covers each rule above against a fake daemon. The name
is not `rooms.ts`, so it does not read as `client/room.ts`.
Decisions: S8, M4-2's and M4-5's rules for when the screen ends.

**M4-12 · TUI parts in their own files · S · needs M4-11**
Move code only. The pop-up frame, the pick list, the text box and the forms go to
`chat/tui/panel.ts`; the question box and its answer call to `chat/tui/question.ts`;
the sidebar, the strip and the marks to `chat/tui/sidebar.ts`; drawing the transcript
to `chat/tui/transcript.ts`. After M4-9..M4-11 most of the state they share lives in
`client/` and `chat/view.ts`, so each file takes little from `chat/tui.ts`.
*Done when* `chat/tui.ts` defines none of the pop-up, question box, sidebar or transcript
parts and imports each from `chat/tui/`; `git diff --color-moved` marks every moved line
as moved, apart from the import blocks; every other test passes unchanged; and the
import-boundary test also reads the files in `chat/tui/`.
Decisions: M1c-7.

---

## M5 — Client contract (proposed)

The contract work that makes `attach`, the TUI and a future bridge speak one documented
API. Decisions live in `docs/CONTRACT-PLAN.md` (A, B, C, D, E, F, G, H, I, J, K, M);
this section is the work breakdown once they are settled. Every story below is
**Proposed**.

**M5-1 · Contract artifact and version handshake · M · needs M2-10**
`docs/CLIENT-API.md`, `client/contract.ts`, a `GET /version` and a capability list; the
compatibility policy written down.
**Added 2026-09-21 (#145):** it also folds in M6-1's room vocabulary and record sketch
(`docs/CONTRACT-PLAN.md`) and marks that section superseded — the sketch is planning,
`CLIENT-API.md` is the promise, and two documents cannot both be normative.
*Done when* a reader who has never opened `daemon.ts` can implement a client from the
document, and a contract test asserts the version/capability response.
Decisions: A1–A7, B1–B10. **Closed for M5-1 (#133):** all now follow
`docs/CONTRACT-PLAN.md` — A2 was decided 2026-09-20 and A3/A7 were settled by the
`spike/chat-tui` spike, the rest on 2026-09-22 — except B2, which is `major.minor`
rather than one integer, so B5 reads "warn on a minor difference, refuse a major one". No
client checks the version in this story; M5-10a adds that.

**M5-2 · Curated run DTOs · M · needs M5-1**
`RunDto` and `TaskDto`, one shape for live and restored runs, mapped at the daemon edge.
*Done when* a test asserts a live run and a boot-restored run produce the same DTO shape.
Decisions: C1–C12.

**M5-3 · Error envelopes, body limits, request validation · S · needs M5-1**
Stable `{error:{code,message}}`, a body-size cap with 413, optional 415, a read timeout.
Decisions: C7, C8, J1–J5.

**M5-4 · Permission resolution and settled decisions · M · needs M2-3, M5-1**
An answered event with the queued id, outcome and reason (`client`, `timeout`, `cancel`,
`task_end`, `run_end`), every settle path covered, settled decisions queryable.
*Done when* two clients on one room or run attribute a decision to the same id and reason.
Decisions: D1–D8. **Decided 2026-09-24 (#136):** a new `_client_permission_answered`
`{id, allow, reason}` from `core/permissions.ts`, all five reasons, and
`GET /permissions/:id` for a closed decision; the `409` body is unchanged. Runs only —
no room asks anything until M6-5, which emits the same event.

**M5-5 · Run terminal event and event timestamps · S · needs M5-1**
`_client_run_finished` before the log closes, plus `at` timestamps on events.
Decisions: E1–E6, C5, C6. **Decided 2026-09-24 (#137):** the plan's E1–E4 and E6; E5
amended — a crashed run gets no event, and the sweep marks it and its running tasks
`killed`, a new status, rather than `failed`.

**M5-6 · SSE liveness, reconnect and backpressure · M · needs M5-1**
Heartbeat, `retry:`, a reconnect consumer with `Last-Event-ID`, and a `follow` seam that
pauses on a full socket; a slow-client policy.
Decisions: F1–F9. **Decided 2026-09-24 (#138):** a 15 s ping and no `retry:`; `follow`
pauses on a full socket and never disconnects; `attach` reconnects through
`client/stream.ts` until `daemon.json` is gone; F9 dropped.

**M5-7 · Idempotent dispatch · S · needs M5-1, M2-6**
`Idempotency-Key` on `POST /runs`; a replay and a conflict response.
Decisions: G1–G6. **Decided 2026-09-25 (#139):** a header, one key space for the daemon,
kept in memory until the daemon stops; `409 idempotency_conflict` for a different body,
`409 idempotency_in_progress` while the first request has not answered; runs only.

**M5-8 · Task-level cancel · S · needs M2-3, M2-9**
`DELETE /runs/:id/tasks/:taskId`; status vocabulary, worktree outcome, permission deny.
Decisions: H1–H7.

**M5-9 · Run filtering and repository removal · S · needs M5-2**
`DELETE /repos`, `GET /runs` filters, ordering and cursor pagination.
Decisions: I1–I5.

**Split 2026-09-26.** M5-10 was one story with two halves, and only one
half is on the TUI's path. The transport serves runs and rooms. The reducer it described —
task status, cards, the final result — is a **run** reducer, and a room has no task. The
room reducer is M6-10.

**M5-10a · Shared client transport · S · needs M5-1, M5-3, M5-6**
`client/` gains what every client needs before it reads one event: read `daemon.json`, an
HTTP client that returns the typed reply or the `{error: {code, message}}` envelope, and
the version check B5 asks for — refuse a different `major` of `GET /version`, warn on a
different `minor`. `client/stream.ts` (M5-6) is the SSE reader it pairs with. **The caller
passes the `daemon.json` path.** `cli.ts` and `chat.ts` get it from `core/runtime.ts`, as
today, so the folder rule and its ownership check (`ours()`, which `stateDirFor` shares)
keep one copy, and `client/` still imports nothing under `core/`. `attach` moves its HTTP
calls onto it. M4-1 moves `chat.ts`'s `Daemon` and `api` onto it.
*Done when* `attach` reads `daemon.json` and makes every HTTP call through `client/`, a
different `major` is refused and a different `minor` warns, and the module reaches nothing
under `core/` or `protocol/` at runtime.
Decisions: B5, B6, F3, K6. (B6 settled as (a). F3 settled by M5-6.)
**Decided 2026-09-26 (#142):** K6 is (a), no client id. `attach` checks the version
again when `daemon.json` names a new token, since a restart is when a new version arrives.
Every daemon verb moves onto `client/daemon.ts`, not only `attach`.

**M5-10b · Run reducer and `attach` on it · M · needs M5-10a, M5-2, M5-4, M5-5**
A pure run reducer in `client/`: task status, joined prose, pending permission, final
result, notices. `attach` is refactored onto it with no visible change. Not on the TUI's
path: the TUI never shows a run (M5-7, R16).
*Done when* `attach` contains no protocol parsing of its own and the reducer is tested
from recorded streams for live, restored, cancelled and replay cases.
Decisions: B7.

**M5-11 · Conformance suite · M · needs M5-1..M5-6**
Contract tests that treat the daemon as an external process: mock client, golden DTO
fixtures, replay, permission race, idempotency; CI with no credentials.
**Amended 2026-09-26: no freeze.** The project is private and has one operator, so no
story freezes the contract. The suite still fails when a DTO field is renamed, so a
rename is always a choice and never an accident. A freeze is decided when a second
client needs a promise.
Decisions: B8, M1–M6.

---

## M6 — Rooms (proposed)

A room is a long-lived container of independent agents on one repository: empty, or with a
starter agent acting as the orchestrator. Each named agent has its own harness, mode,
settings and long-lived multi-turn session; there is no dependency graph and no scheduler
(R24–R30 retired). Decisions R1–R44 and S1–S14 live in `docs/CONTRACT-PLAN.md`. Every
story below is **Proposed**. **Amended 2026-09-20 (plan review):** the spike port moves
from last to **first, as M6-0** — it needs nothing, and it is the only story that gets
more expensive the longer it waits. R37–R42 close six decisions the stories below were
reading without an answer.

**M6-0 · Land the spike on master · M · needs nothing · landed 2026-09-21 (#144)**
Rebase `chat-mvp` onto current master (S1a) and reconcile with what
landed since: the M2-3 permission queue, the M2-5 sweep, M2-6 persistence, M2-7 config,
the M2-8 Host guard, M2-9 `attach`, M2-10 `ps`. Two corrections the spike predates: room
state moves out of `.kapelle/rooms/` to `stateDirFor(root)` (#129), and `children.json`
takes S14's `{pid, kind, ownerId, unitId}` shape with the legacy entry read as a run.
**Only `chat-mvp` lands, and `spike/chat-tui` is left where it is** — not rebased here
either, because M4-1 rebases it anyway and doing it twice buys nothing. M4-1 is where
`@earendil-works/pi-tui` is ratified and its nested `marked` pin overridden, and it needs M5-10a
first; `package.json` keeps `marked` as its only runtime dependency.
**No new features** — one participant per room, `auto` only, no roster and no permission
answering — and `chat.ts` ships marked **experimental**, so the room API is not a
promise until M5-1 documents it. The `kapelle chat` verb stays with M6-9 (S7a); M4-2 built it (#48). R37
applies from here. The spike's `close()` releases as
`done`, which commits the work and removes the checkout; both must stop. `release` already
behaves as R37 wants under a non-releasing status, but every such label (`failed`,
`cancelled`, `timed_out`) misdescribes a room that was simply dismissed. **Settled: `release`
takes a `ReleaseAction` (`"commit" | "keep"`)**, `RELEASES` moves to `core/run.ts` beside
`TaskStatus` and converts at its one call site, and a room always passes `"keep"` — so
`core/worktree.ts` imports no run word at all. Add R40's `ponytail:` comment where the
room runtime spawns a harness. **S9 lands here too:** `newRoomId()`
(`room-YYYYMMDD-HHMMSS-xxxx`) plus a private `assertOwnerId` that `branchName` validates
with, since `core/worktree.ts` serves runs and rooms alike; `assertRunId` still rejects a
room id. `assertRoomId` and `roomBranchName` wait for a caller — `npm run knip` fails on
an unused export.
*Done when* the spike's seven `tests/daemon.test.ts` cases pass on master, `npm run check`
and `npm run fmt:check` are clean, room state is under `stateDirFor(root)`, and
`node chat.ts` drives a room end to end against `mock-agent.mjs`.
Decisions: S1, S9, S13, S14, R37, R40.

**M6-1 · Design the room container · S · needs M6-0**
With the runtime on master, design what the spike does not have: the roster, the
empty/starter choice, per-participant settings, streams, persistence, queue, base choice
and title. No code lands; the R/S decisions are recorded and the API shapes sketched for
the rest.
**R42 answered 2026-09-21 (#145): (c) — a shutdown is a pause, not a close.** The owner
wants a reboot to be resumable, and it now is: shutdown stops each harness and leaves the
room `paused`, with roster, branch, checkout and history intact; a participant revives on
its next message. `session/load` where the harness advertises it, otherwise a fresh session
with the loss reported as `resumed: "fresh"`. **Half A** — revive with a fresh session — is
M6-7 and needs no probe; **Half B** — `session/load` — stays deferred with S3(c). R37's
`keep` is what made either answer possible: the checkout never left.
**Amended 2026-09-26:** Half A is M6-7a, and Half B is no longer deferred: it is M6-7b,
after the M0-9 probe (R42).

**One word per idea, decided with it.** `dismiss` is a person ending a room
(`POST /rooms/:id/dismiss`); `delete` throws it away (`DELETE /rooms/:id`, R18's own
meaning, which the MVP had borrowed); `pause` is the machine stopping; `resume` brings a
room back. The status set is `idle`/`busy`/`exited`/`paused`/`dismissed` — `closed` is
renamed. M6-2 does the rename while `chat.ts` is still the only client and experimental.
*Done when* every R decision that shapes an API has an answer and M6-2..M6-9 can be
picked up without re-opening the model.
Decisions: R1–R23, R31–R44, S10, S12, S13.

**M6-2 · Room container: roster, empty/starter, DTOs · M · needs M6-1, M5-1, M5-10a**
The room record (repo, roster, title, created/updated); `POST /rooms` accepts an empty
room or a starter participant and answers 201 once the session exists (S13); `RoomDto`
and `ParticipantDto` in `client/contract.ts`; `assertRoomId` and `roomBranchName` once
something imports them (`newRoomId()` landed in M6-0, #144), opaque participant ids.
No dependency field and no scheduler.
**Added 2026-09-21 (#145):** `GET /rooms` carries the roster inline and summarised,
`participants: [{id, name, role?, status}]` — the shape `GET /runs` already gives its tasks
(`daemon/dto.ts:188`) — so M4-2's sidebar costs one call, not one per room; the full
`ParticipantDto` is on `GET /rooms/:id`. The participant record carries the harness
`sessionId` from this first version (the M2-6 precedent), even though nothing
loads it until Half B (`session/load`) lands.
**Added 2026-09-23 (R44):** the participant record carries `role` from this first
version, and the starter gets `role: "orchestrator"` (R21), so M4-2 can find the default
target before M6-3 lets a person set or change a role.
**And the rename lands here**, while `chat.ts` is the only client and
marked experimental: status `closed` becomes `dismissed`, `Room.close()` becomes
`dismiss()`, its inner closure — confusingly named `shutdown` today, one import from
`daemon.ts`'s process `shutdown` — becomes `teardown()`, and dismiss moves to
`POST /rooms/:id/dismiss` so `DELETE /rooms/:id` can mean what R18 says it means: remove
the room's worktrees, branches, record and log at once, refused with `409` naming the files
while any checkout has uncommitted work. The
rename also splits today's single `RoomStatus` (`core/room.ts:43`: `idle`/`busy`/`exited`/
`closed`) into a room status — `active`/`paused`/`dismissed`, what `GET /rooms` and
`GET /rooms/:id` publish — and a participant status — `idle`/`busy`/`exited`/`paused`/
`dismissed`, the sketch's record. A mechanical `closed`→`dismissed` rename alone would
publish participant-shaped values as the room status, which `daemon.ts`'s `roomView` reads
from `room.status()` today.
**Amended 2026-09-27 (#146 pickup).** The body is
`{cwd, title?, agents?: [{agent | cmd, name?, role?}]}`, not R21's `orchestrator?` field:
R44 made the orchestrator a label on any participant, so the body names none. An agent has
only the role it is sent; nothing is promoted. A room holds **at most one** agent until
M6-3, because a second needs its own checkout (M6-6a) and a route to reach it (M6-4).
`POST /rooms/:id/messages` goes to the orchestrator and answers `409 no_orchestrator`
without one. `DELETE /rooms/:id` is freed, not built: it answers `404` until M6-7a builds
R18's delete. `room_closed` splits into `room_dismissed` and `agent_exited`.
*Done when* empty and starter rooms round-trip through `GET /rooms/:id`, the list carries
each roster inline, ids are tested, no file says `closed` of a dismissed room, and the
DTOs are covered by contract tests.
Decisions: R1, R3, R9, R17, R21, R22, R33, R36, R44, S4, S13. (R22 settled: a new `roomId`.)

**M6-3 · Participant lifecycle: add/remove/list, settings, names · M · needs M6-2, M6-6a**
**Amended 2026-09-26:** a second participant needs a checkout of its own, and today a room
has one (`core/room.ts`, `ROOM_TASK`). M6-6a gives each participant one, so this story
needs it. The add body also takes `base`: a ref, or another participant's branch, which
M6-6a's runtime already accepts. This story documents `base` as a request field in
`docs/CLIENT-API.md`.
`POST /rooms/:id/agents` with `{name, agent or cmd, mode, settings, base?}`; list, get, remove,
and rename — R10 grants it, so the story carries it: the display name is mutable, the
opaque id and the branch name are not. Names match `^[A-Za-z0-9_-]{1,32}$` and are unique
under ASCII lowercase folding (R22); harness fixed at add; mode mutable and default
`auto`; an optional, mutable `role` (`orchestrator`, `developer`, `tester`, `architect`),
a label only, with a second `orchestrator` refused `409` `orchestrator_exists` at add and
at a role change (R44). One route changes a participant:
`PATCH /rooms/:id/agents/:agentId` with any of `{name, mode, role}`; this story adds its
row to the CLIENT-API route table and drops `orchestrator_exists`'s "Not built yet" note.
Removal cancels the session and applies the worktree policy. Settings reuse run-file
`Task` fields plus a purpose/instructions field.
*Done when* a room holds several named participants added through the route, each with
its own harness and mode; list, get, rename and `PATCH` of `name`, `mode` and `role` work;
a second `orchestrator` is refused `409` `orchestrator_exists` at add and at a role change;
removing one leaves the others untouched; two participants work in parallel without
touching each other's files; and one added with the other's branch as `base` starts from
that branch's head.
**Amended 2026-09-28 (#147 pickup).** No purpose field: R15 is amended, and instructions
are the first message. `settings` is `allowReadOutsideRoot` only. `mode` accepts only
`auto`; M6-5 owns `ask` and `safe`. The HTTP proof of parallel turns moves the orchestrator
role from a busy participant to another, because a message reaches only the orchestrator
until M6-4.
Decisions: R4, R9, R10, R12, R15, R18, R22, R33, R44. (R33 settled as (a).)

**M6-4 · Routing, room timeline, participant streams and cancel-turn · M · needs M6-3**
A message names its target participant, orchestrator by default (R7a). One room log and
one sequence; every line `{seq, roomId, participantId, update}` (S10); a thread is a
client-side filter (R8c over R13a). Nested participant event route for the filtered view.
A busy participant queues FIFO (R32a), bound 16 and `429` when full, in memory and lost at
restart (R41); cancel-current-turn keeps the session (S5a); cross-agent context is
human-composed in v1 (R34a), `contextFrom` next (R34b). A room turn carries no result
contract (R39) and a watchdog that only warns (R38). The daemon never parses message
text: the target is the nested route, and `@name` resolution lives in `client/` (R43).
*Done when* one participant's thread and the room timeline replay from one log, a second
message to a busy participant is queued and answered in order, and the seventeenth is
refused with `429`.
**Amended 2026-09-28 (#148 pickup).** A room line is `{seq, at, roomId, participantId,
update}` with no `agent`: a harness name is not unique in a room, and a rename would make
a name stale. A queued message is two events, `_client_message_queued` on arrival and
`_client_user_message` when its turn starts, so a turn stays one span and a queue lost at
restart reads as never sent. A cancel drops the queue first and logs
`_client_queue_cleared {count}`; removing a participant and a harness exit do the same.
The bound is 16 waiting behind the live turn. No turn id: S12's `turn` is M6-5's.
Decisions: R6, R7, R8, R13, R32, R34, R38, R39, R41, R43, S5, S10, S11.

**M6-5 · Per-participant modes and permissions · M · needs M6-4, M5-4**
Per-participant mode at add, default `auto`; `ask`/`safe` selectable (S2). The permission
queue gains `roomId`, `participantId`, `turn` (S12); first-writer-wins and timeout deny;
the answered event from M5-4. `auto` still warns about silent autonomy.
**Amended 2026-09-28 (#149 pickup).** A room sets the harness's own mode: `modeMap.safe`
for `safe`, `modeMap.ask` for `ask` and `auto`, never `modeMap.auto`; at session start
and before the first turn after a change. No start mode is kept. A room decision names
`roomId`, `participantId` and `turn` in place of `runId`/`taskId`, and `turn` is also on
`_client_user_message`. Every room path that closes a decision without an answer or the
timeout reads `cancel`. The TUI answer is M4-3's; this story proves it over HTTP. Runs keep
`safe`-only negotiation (#193). **2026-09-29:** a mode does not survive `session/load`
reliably (`docs/FINDINGS.md` §Mode after load), so M6-7b sends it again after a load.
**Amended 2026-09-29 (#194 review).** A mode that leaves `ask` answers what waits, as the
new reason `mode_change`: yes for `auto`, no for `safe`. A mode send that failed is tried
again before the next turn. The notices that name a mode are replaced on a change.
Decisions: R12, S2, S12.

**Split 2026-09-26.** M6-6 held two jobs. The worktree for each
participant is on the TUI's path: M6-3 needs it. The merge rework is size `L` and is not.

**M6-6a · Per-participant worktrees and base choice · M · needs M6-2**
Each participant owns one worktree and branch, `kapelle/<roomId>/<participantId>`, forked
from the base named at add, room base by default. The base may be **another participant's
branch** (R35c), so a reviewer can start from the developer's work. The runtime call that
adds a participant takes that base; M6-3 exposes it as the route's `base` field. Nothing is inherited
and no checkout is shared (R24–R30 retired). This replaces the room's one checkout
(`core/room.ts`, `ROOM_TASK`). Parallel turns are safe; nothing caps the live harness count
in v1 (R40). Under R37 the participant commits its own branch, so the supervisor adds no
commits of its own. Removing a participant keeps its branch and checkout, as dismiss does.
No merge here: until M6-6b lands, a person lands a participant's branch with git by hand.
*Done when* tests drive the room runtime (`core/room.ts`) directly, with no route: two
participants work in parallel without touching each other's files, one given another's
branch as its base starts from that branch's head, and a dismiss leaves every participant
branch. The add route and its `base` field are M6-3's, and M6-3 proves the same through
HTTP.
Decisions: R6, R14, R35, R37.

**M6-6b · Merge rework for per-participant bases · L · needs M6-6a**
**Sized `L` because R35(c) forces a merge rework** (decided 2026-09-20): `core/merge.ts`
assumes one base per run — it measures each branch's diff from that branch's own `baseSha`
(`core/merge.ts:83`), refuses when two branches touch one file (`:86`), then squashes every
branch at once (`:126`) — so two participants on different bases can pass the overlap check
while the squash replays the parent's work. The `done`/`warned` gate (`:65`) also names a
task status a participant never reaches (R37).
Deliverables: a preflight correct for per-participant bases; a test proving the
multi-branch squash is right when one branch's history contains another's; `kapelle room
merge <roomId>` as the surface (R31b), scoped in v1 to one participant at a time
(`--participant`) with whole-room merge as the additive follow-up, merging in creation
order and aborting atomically; and the participant states a room merge accepts. The merge
logic lives in `core/`, so M6-11b's daemon route calls the same code.
*Done when* a chained-base pair merges without replaying the parent's commits, and a real
conflict is refused by name with nothing half-landed.
*Risk* — the only new, untested git logic in the room model. Fallback: R35(a) for v1,
chained bases with R35(d).
Decisions: R14, R31, R35, R37.

**Split 2026-09-26.** M6-7 held Half A and Half B. **Half B is no longer
deferred** (R42, amended): a shutdown must leave a participant's memory as a cancel does,
and only `session/load` keeps memory across a stopped process. M0-9 measures it first.

**M6-7a · Persistence, restart, fresh revive and `killed` · M · needs M6-2, M2-6**
`stateDirFor(root)/rooms/<roomId>/` with `room.json`, participant records and the event
log; retention and idle eviction use owner config. **Rewritten 2026-09-21 (#145) by
R42(c):** a shutdown is a pause, so this story splits the two verbs — shutdown persists the
room and stops each harness, and no longer calls the dismiss path. A restart restores the
roster, and a participant revives on its next message: respawn the harness in its existing
worktree with a fresh session and `resumed: "fresh"` on the DTO. That is **Half A**, and it
needs no new protocol method and no probe. Pause never releases the worktree, resume
reattaches it rather than creating one, and the log is reopened for appending with `seq`
carried on — the sketch in `docs/CONTRACT-PLAN.md` names the code each one replaces.
`room.json` is written with a temp file and `rename`, as `run.json` is.
**Amended 2026-09-26 — a shutdown is a cancel, and a kill is `killed` (R33, R46).** A
shutdown cancels each busy turn first (the 2 s grace of §M0-4), so the log gets its
`_client_turn_ended`; then it stops the harness and writes `paused`. A participant that
stops **during a turn without a clean end** reads `killed`: its memory may not match the
files. Three things set it. The boot sweep sets it for a participant that `room.json`
still shows `busy`, because the daemon crashed; the sweep also rewrites the room and every
`idle` participant to `paused`, and adds no line to the log, as for runs (M5-5). The room
sets it when the harness dies during a turn (one that dies while idle reads `exited`). The
shutdown sets it when a cancel outlives the grace and the harness is killed.
`killed` revives on the next message by the same path as `paused` and `exited`. **Order:**
pick it up after M6-4, which changes the log line this story saves. **Open at
pickup:** whether the sweep also reports a stale `.git/index.lock` in a `killed`
participant's checkout.
**Added 2026-09-27 (#146): R18's delete lands here.** M6-2 freed `DELETE /rooms/:id` and
left it unrouted. This story owns the room's record and its retention, so it also builds
delete: remove the room's worktrees, branches, record and log at once, refused with `409`
naming the files while any checkout has uncommitted work. It lands after M6-6a, so it
removes one checkout per participant. **Amended 2026-09-27 (#187 review):** delete finds
the checkouts on disk, under `stateDirFor(root)/wt/<roomId>/`, as `managedWorktrees` in
`core/sweep.ts` does, and not from the roster. A failed add whose harness wrote into its
checkout keeps that checkout and its branch. No participant owns them, and only a room
notice names them. A delete that walked the roster would answer `200` and leave that work
on disk.
*Done when* a restart lists the room `paused` and every participant `paused`, a shutdown
during a turn ends that turn in the log and leaves the participant `paused`, a `kill -9`
during a turn leaves that participant `killed` after the next boot, its history replays, a
message to one revives it and is answered, the DTO reports `resumed: "fresh"`, a
dismissed room is not revived by the same path, and `DELETE /rooms/:id` removes a clean
room's checkouts, branches, record and log and refuses a dirty one with `409`.
**Added 2026-09-29 (#180):** after a restart, the room reducer (`client/room.ts`) shows the
`paused` or `killed` state that `GET /rooms/:id` reports, and a turn the crash cut reads
as cut, tested from a recorded stream. M6-10 moved this case here.
**Added 2026-10-01 (#200 review):** the chat screen rides out a restart as `attach` does:
it reads `daemon.json` again, reconnects its streams, and checks the version again. This
replaces M4-5's exit with no room open (`chat.ts`, the 5 s poll).
Decisions: R17, R18, R33, R42, R46, S3, S4.

**M6-7b · `session/load` for a paused participant · M · needs M6-7a, M0-9**
**Half B.** A participant revives with `session/load` where the harness advertises
`loadSession: true` **and** M0-9 measured the load working; the DTO then reports
`resumed: "loaded"`. Any other harness revives fresh, as in M6-7a. What a `killed`
participant loads follows M0-9's kill-case finding: if the memory can be behind the files,
the revive says so. `AGENTS.md` drops `session/load` from "Deliberately unimplemented" in
the same change.
**Amended 2026-09-27 (M0-9, #176):** the load works on all four harnesses. Two findings
change this story. First, the warning is not for `killed` alone: a participant cancelled
during a turn, which reads `paused`, can also come back with memory behind the files (R46).
Second, the load replays the old conversation as ordinary `session/update`
notifications. They must not reach the room log or the screen a second time. Also, after
a SIGKILL, claude said it had been told "continue", which nobody sent; the replay does not
carry it, so the revive cannot filter it out.
*Done when* after a shutdown and a restart, a participant on each harness M0-9 marked
working answers a question about a turn before the restart, and the DTO says `loaded`. A
participant stopped during a turn gets the warning, and the replay adds no line to the
room log and draws nothing on either `chat.ts` surface (the pi-tui screen and the piped
lines).
Decisions: R42, S3.

**M6-8 · Orchestrator and delegation · M · needs M6-4 · deferred by R2**
R2 is decided for v1: the orchestrator is a normal participant and the default recipient,
with no delegation powers. Kept for the later coordinator choice (R34c); the charter's
agent-to-agent non-goal still applies. **Named deferred option (R43):** scanning the
orchestrator's responses for mentions — an experimental, supervisor-mediated
agent-to-agent step — is one candidate shape for when the delegation choice is taken up.
It is not v1 and needs its own decision first: it reopens `PROJECT-BRIEF.md`'s non-goal
and R2/R34c, and the daemon stays free of chat-platform code.
*Done when* the chosen behaviour is implemented or explicitly deferred behind a `Decided`
note; a direct agent-to-agent channel is not built without re-opening the brief. The
orchestrator-response scan is recorded as the deferred option, not built.
Decisions: R2, R23, R34, R43.

**M6-9 · Room CLI and bridge readiness · S · needs M6-5, M4-2**
Keep `chat.ts` standalone and add `kapelle chat` that runs it (S7a; built by M4-2, #48); document the bridge
pattern in `CLIENT-API.md` — a local process subscribes to a room or participant stream
and answers permissions; no chat SDK enters the daemon.
Decisions: S7, K5, R19.

**M6-10 · Room reducer · M · needs M6-4, M5-10a**
**Added 2026-09-26.** M5-10's reducer is a run reducer, and a room has no
task. A pure reducer in `client/` turns room lines `{seq, roomId, participantId, update}`
into screen state: the roster and each participant's status, the room timeline, the
per-participant thread (a filter, R8c), each turn (open, ended, or cut — a user message
with no `_client_turn_ended`), the queue, and unread and attention marks. It skips a `seq`
it has seen, so a reconnect adds no duplicate. Pending permissions join it as an addition
when M6-5 lands. It does no I/O, so the TUI and a bridge share it. `chat.ts`'s `RoomView`
and `LogEvent` logic ends here.
*Done when* the reducer is tested from recorded room streams for live, replay, reconnect,
restart (`paused` and `killed`) and a cut turn, and M4-2 draws from it with no event
parsing of its own.
Decisions: R8, R13, S10, S11. **Decided 2026-09-29 (#180):** the roster is on the log.
The room writes `_client_participant_added`, `_changed` and `_removed`, starters included,
and the reducer (`client/room.ts`) reads the stream only; `GET /rooms/:id` stays for the
reconcile after the stream ends. Rooms are Experimental, so no version step. `chat.ts`
moves onto the reducer in this story, and M6-5's questions are in it. The restart case
moves to M6-7a: the boot sweep adds no line to the log, and nothing sets `paused` or
`killed` yet. "M4-2 draws from it" is M4-2's to check.

**M6-11a · Fast-forward one participant to another, from the TUI · S · needs M6-6a, M4-5, M4-6**
**Added 2026-09-26, R45.** A reviewer starts from the developer's branch
(M6-6a) and commits on top; the person then moves the developer's branch up to the
reviewer's commit. **Fast-forward only**: it works when the developer made no commits
since, and it can never conflict. A daemon route does the move in the target's checkout,
and a TUI command calls it. It refuses, by code, when the target is `busy` and when a
fast-forward is not possible. **The move runs `git merge --ff-only` inside the target's
checkout**, never `git update-ref`: the branch is checked out there, and moving only the
ref leaves the index and files at the old commit, which the agent would then commit on
top of. It writes a `_client_` event to the room log, so every observer sees the move.
**Accepted consequence:** an `idle` target's harness is still alive, and its memory
describes the files before the move. The daemon tells it nothing; the person does, in a
message. **Open at pickup:** the route's path and name, and whether uncommitted work in
the target's checkout is refused.
*Done when* after the move the target's branch and checkout are at the source's commit, a
busy target and a diverged target are both refused with nothing changed, and a second
client sees the event.
Decisions: R37, R45.

**M6-11b · Land a participant into the main checkout, from the TUI · S · needs M6-6b, M4-5, M4-6**
**Added 2026-09-26, R47.** R31 made `kapelle room merge` the surface.
This story adds a daemon route that runs the same M6-6b code for one participant, and a
TUI command that calls it. It is the first time the **daemon**, not the CLI, writes to the
operator's own checkout, so the route keeps every M6-6b preflight and refuses by code.
That includes the check `core/merge.ts` already runs on the operator's checkout —
uncommitted changes, or new commits, where a branch writes — which M6-6b keeps.
*Done when* a participant's work lands in the main checkout from the TUI with the same
result as `kapelle room merge --participant`, and a refused merge leaves nothing
half-landed.
Decisions: R31, R47.

---

## Critical path

```text
M0 ─ M1a ─ M1b ─ M1c ─ M2
  ├─ M3  (pipeline, DAG, worktrees; runs only)
  ├─ M6-0 ─ M6-1   (done: the spike landed, the room model designed)
  └─ M5-1..M5-6    (done: the contract document and the shared wire rules)
```

**The path to the TUI (amended 2026-09-26).** The spine, in order:

```text
M5-10a ─ M6-2 ─ M6-6a ─ M6-3 ─ M6-4 ─┬─ M6-10 ─ M4-2 ─ M4-5 ─ M6-11a
                                      ├─ M6-5 ─ M4-3 ─ M4-7..M4-12 ─ M4-6 ─ M4-13
                                      ├─ M6-7a ─ M6-7b
                                      └─ M6-8 (deferred by R2)
M6-6a ─ M6-6b ─ M6-11b
```

The edges the drawing leaves out: **M4-1** needs M6-0 and M5-10a, and **M4-2** needs M4-1
too. **M4-5** also needs M6-5. **M4-3** also needs M4-2 and M5-4. **M6-7b** also needs the
**M0-9** probe. **M6-11b** also needs M4-5. **M6-11a** and **M6-11b** also need M4-6, for
the diff view. **M4-4** needs M4-2. **M6-9** needs M6-5 and M4-2. **M6-7a** needs only
M6-2, but goes after M6-4, which changes the log line it saves. Its chat half and
**M4-11** change the same poll, in either order.

Off the path, because the TUI shows no run (R16): M5-7, M5-8, M5-9, M5-10b and M5-11.
M5-11 adds an idempotency test *if* M5-7 has landed — a condition, not a dependency. No
story freezes the contract while the project is private (M5-11). **M5-10a is the gate:**
both M4-1 and M6-2 need it, and it is ready now.

Three things are worth pulling forward, because everything queues behind them:

1. ~~**M0-3.**~~ **Done 2026-08-21.** It did delete one story and rescue the other: M3-5 is
   cut to documentation, M3-6 survives without it. The containment label M1a-4 ships is now
   two fields, `shell` and `argvChannel`.
   **M0-8, its would-be successor, resolved instead of run** — `87cbfe3` had already
   advertised the flag, and `FINDINGS.md` records the result: no fourth
   `argvChannel` value, so M1a-4's type is settled on the two fields M0-3 established.
2. **M1a-2.** Every later module types against it, and it is the story that earns the
   TypeScript decision.
3. **The eleven decision halves** listed under *Decide before M1a starts*.

~~M3-5 and M3-6 are the only stories here that may evaporate entirely.~~ **Settled:** M3-5
evaporated, M3-6 did not — it now depends on `argvChannel` rather than on M3-5. M3's
capacity is one large story lighter.

---

## Backlog — named, not scheduled

Each carries its trigger, so none of these is waiting to become a blocker by accident:

- **Global live-harness cap (R40).** Added 2026-09-20 with the room model; the
  `ponytail:` anchor is the file header of `core/room.ts` since M6-0 (#144). Rooms make the
  live subprocess count `runs + Σ(busy participants)` across every room, and the default
  participant mode is `auto`, so nothing asks a human before a turn starts. `maxConcurrency`
  bounds **one run**; nothing bounds the daemon. v1 caps nothing on purpose — a cap is a
  knob, a default and a refusal path, and no room has yet had more than one participant.
  The shape when it is wanted: one daemon-wide key beside `port` in the user config,
  counted across runs and rooms, and a `429` when a message would exceed it — not a second
  queue on top of R41's per-participant FIFO, because "queued behind another room" has no
  honest place to be drawn in the TUI. *Trigger:* the first room with more than a handful
  of participants, or the first machine driven into swap or a failed harness spawn for want
  of resources.
- **Orchestrator-response scan (experimental agent-to-agent).** Named by R43 as the
  deferred agent-to-agent path: the orchestrator's answers are scanned for mentions and
  the daemon mediates the handoff. It is not v1 and needs its own decision first — it
  reopens `PROJECT-BRIEF.md`'s non-goal and R2/R34c, and no daemon chat parser exists
  today. M6-8 carries the option. *Trigger:* the delegation choice is taken up and the
  brief is amended.
- **Bound the retained stderr to a head/tail window.** M1a-3 retains every stderr line for
  the life of the agent and attaches all of it to a death rejection. The 2026-08-31
  measurement says that costs nothing today — zero bytes per turn on all three harnesses in
  the configuration we ship — so it was left unbounded on purpose. The shape when it is
  wanted: keep the **first 12 and last 12 lines** with an elision marker, plus a per-line
  byte cap. First-and-last rather than last-N because the measurement put the actionable
  line near the head (17 lines from the end on claude); the per-line cap covers the one
  hazard no line-count bound touches — a progress spinner writing `\r` with no `\n`
  accumulates into a single unbounded line. *Trigger:* a harness measured emitting stderr
  through a normal turn (`opencode --print-logs` already does ~11 MB per agent per 4 h), or
  a rejection message large enough to be unreadable in the terminal or M2-2's event log.
  Note M1b-7 keeps the complete record on disk regardless, so this is about what is held in
  memory and pasted into an error, not about losing data.

- **Sandboxing (`bwrap` / `sandbox-exec`).** The only option that actually closes the shell
  gap rather than documenting it, and the only thing that bounds `auto` mode's blast
  radius — which is where the real risk lives, and which labelling does nothing for.
  ~~*Trigger:* a judgement call on `auto`'s blast radius, not an event.~~
  **Decided 2026-08-23 (#62 R2): deferred, and the trigger is now an event — M2's daemon
  accepting dispatch (`POST /runs`).** Until then `auto` is a human act in a terminal that
  human is watching; an API that accepts run files and executes them under `auto` is remote
  code execution as a service, which is a different risk arriving on a known date. What M1
  ships instead — worktree isolation, the containment label, the silent-autonomy warning —
  **bounds nothing about the shell**, and the docs must keep saying so. Two supporting
  findings: AgentPool's sandboxed execution environments would bind nothing here, since they
  contain only client-served `fs/*` and `terminal/*` operations and our harnesses use
  neither (`docs/PRIOR-ART-AGENTPOOL.md`); and the platform matrix is real work — `bwrap` is
  Linux-only and macOS's `sandbox-exec` is deprecated — which is a second reason not to
  inline it into a milestone that already needs shrinking.
  **Trigger fired 2026-09-11 (M2-1, #31) — still deferred.** `POST /runs` ships behind a
  `0600` token file and a `127.0.0.1` bind, so dispatch still comes only from the local
  operator (`PROJECT-BRIEF.md`: local-first, single operator), and what reaches the daemon is
  no wider than what reaches the terminal. *New trigger:* the daemon binding anything other
  than `127.0.0.1`, or accepting a caller who is not the local operator. The token stops
  being enough at the same moment, so that day needs TLS as much as it needs a sandbox.
  Rooms add a surface: each participant runs a harness and the default room mode is `auto`, so the same trigger — a bind beyond `127.0.0.1`, or a caller who is not the operator — applies to the room API.
- **Per-harness price table.** *Trigger:* M0-5 reporting that any harness names the model it
  selected. **Trigger fired 2026-08-22 — all three name it**, in `configOptions` on the
  `session/new` response with the reserved `category: "model"`. Still unscheduled, and M0-5
  changed what it should build: opencode and claude-agent-acp already report cumulative USD
  on `usage_update`, so pricing their tokens ourselves would only add a second, worse number;
  copilot reports no currency and meters premium requests (`_meta.copilotUsage`), so no token
  count converts to its spend. What is left is per-harness *unit* recording, plus an alias
  table for claude-agent-acp, whose `currentValue` is `opus`, not a concrete model id.
  **Decision 2026-08-22: nice-to-have, explicitly not scheduled.** The trigger fired and the
  entry stays here rather than becoming a story — two of three harnesses already report their
  own USD, so the table would mostly add a second, worse number.
- **`stallRepeatCount` per-harness tuning.** *Trigger:* an observed false positive. Safe to
  wait — a task re-running the same test command while iterating is a legitimate repeat, the
  default is deliberately generous, and repeats only ever warn.
- **`session/load` where a harness advertises it.** *Trigger:* M0-1 recording a harness with
  `agentCapabilities.loadSession`. **Trigger fired — all three advertise it**, and opencode
  and claude-agent-acp also advertise `sessionCapabilities.resume`/`.fork`. Still not
  scheduled, but it is now a known-available feature rather than a hypothetical, it must
  stay behind a per-harness capability check, and it depends on M2-6 persisting the harness
  `sessionId`.
  Rooms and participants are the second consumer: M6-7's Half A revives a participant after
  a daemon restart with a fresh session, not this call; Half B uses the capability-gated
  call when it lands.
  **Two gaps recorded 2026-09-21 (#145), both to close before Half B is scheduled.** Every
  `loadSession: true` we hold is a **handshake advertisement** (`docs/FINDINGS.md`
  §M0-1, `agentCapabilities`); §Multi-turn measured two turns in *one* process, and
  nobody has loaded a session into a **new** harness process — which is what a reboot
  needs. And pi-acp's measurement table
  (`docs/FINDINGS.md` §pi-acp) has no `loadSession` row at all, so "every measured harness
  advertises it" is true of three of the four. One probe answers both. M6-7's Half A does
  not wait on it.
  **Scheduled 2026-09-26:** the probe is M0-9 and Half B is M6-7b, because a shutdown must
  leave a participant's memory as a cancel does (R42, amended).
- **`#send` write backpressure.** `#send` ignores the return value of `write()`
  (`protocol/agent.ts`). *Trigger:* fan-out moving large file contents. The one item here that is
  genuinely "fix it when it bites" — Node buffers, so it degrades to memory growth rather
  than corruption.
- **Composing and dispatching runs from the browser.** M5+. Named because it is the stated
  trajectory and the reason M2's API has to be complete rather than observability-only.
- **Registry-resolved, zero-install harness spawn.** The ACP registry publishes per-platform
  distributions and AgentPool resolves them to `npx -y <pkg>` / `uvx` / a downloaded binary
  (`docs/PRIOR-ART-AGENTPOOL.md`, item 2), which would delete the `npm i -g` / `EACCES`
  section of `README.md`. Deliberately **not** taken: silently resolving "latest" from a CDN
  contradicts a registry whose labels are measured per build. The *pinning* half is proposed
  inside M1a-4 instead. *Trigger:* a target harness with no stable install path, or a second
  machine where the manual install is the thing that breaks.
- **Politeness for unimplemented and extension methods.** Decline `session/request_elicitation`
  and acknowledge `_`-prefixed extension methods instead of returning `-32000`
  (`protocol/agent.ts`), as AgentPool's headless client does. *Trigger:* the wire tap recording
  any method reaching the `#handleRequest` default. **M0-1 measured zero across six turns**,
  so this is currently hardening against traffic that does not exist; ~10 lines whenever the
  trigger fires.
- **Filtering injected MCP servers by advertised transport.** Drop HTTP/SSE servers a harness
  cannot reach and warn, rather than failing `session/new`
  (`agents/acp_agent/helpers.py:17`). *Trigger:* the first story that passes anything to
  `newSession({ mcpServers })` — today nothing does, which is why it is here and not in M1a.
- ~~**CI workflow running `check` / `test` / `selftest`.**~~ **Landed #68, extended by
  M1a-3 (2026-08-31)** — `.github/workflows/code_checks.yml` now runs `fmt:check`, `check`,
  `test`, `selftest` and `knip` under a 15-minute job ceiling. The trigger below fired
  early; the entry is kept for the reasoning, not as pending work.
  M1's exit bar was deliberately
  offline — the two scripts pass locally and `npm run selftest` stays green — and the only
  workflow in `.github/` was the agent harness, which ran no tests. *Trigger:* the first
  milestone whose exit bar depends on a machine other than the developer's — likely M2's
  daemon, or the first harness build that changes measured labels (M0-7's lesson: a safety
  claim is a claim about a build, and builds change underneath you).
