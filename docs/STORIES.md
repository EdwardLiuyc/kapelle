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
| **M1b-3** (`.agent-team/` git-ignore) | ratified **with amendment** — the preflight dirtied the tree it checks |
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

> Survey complete — `M0-FINDINGS.md`, M0-1 section. All three targets **available**
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
**Done 2026-08-22** (`docs/M0-FINDINGS.md` §M0-5). Four corrections to this text as written.
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
`docs/M0-FINDINGS.md`. The input to M1a-4's containment labels and env list, M1c-1's TTL
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
at `docs/M0-FINDINGS.md`: claude-agent-acp's Bash `tool_call` gains a `terminal_id`
and a `{type:"terminal"}` content block for a terminal that was **never created**, with
still zero `terminal/*` calls and **no command output crossing the wire**, and **no exit
code**. It is a rendering convention for a client that already draws the terminal, not the
visibility M0-3 called unobtainable. `argvChannel` therefore gains no fourth value, and
M1a-4 is not gated by this.
**Decision (2026-08-23): park, no further action.** The capability axis is settled for the
MVP; no backlog entry is scheduled. The record lives in §M0-3 (`M0-FINDINGS.md`), which
already holds the finding, so no new §M0-8 is added to the findings note.

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
class: `protocol/agent.test.ts` runs in about six seconds (measured 2026-08-31, most of it
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
empty-set pass. Verified with a throwaway smoke test: `node --test` discovers `core/*.test.ts`
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
there (`_meta["_claude/rateLimit"]`, `M0-FINDINGS.md` §M0-5), M0-3 found harnesses gating
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
M2-1 (event log) if M1a-5 hand-extends.
**Landed 2026-08-31 (#10).** The union is hand-written, `_meta` sits on the base of the
message types in both directions, and `assertNever` makes an unhandled variant a `tsc`
error. `locations[]` is typed on `tool_call` and `tool_call_update`
(`protocol/types.ts:201`, `:218`) but nothing reads it — the probe that would decide
whether `render` shows it never ran, and the type costs nothing while it waits.
**The types-coverage decision fired at M1a-5 and the answer was hand-extend.**
`session/set_mode` was the only surface M1 needed outside this file, which is criterion (1)
as written — one small addition, not three. It is typed at `protocol/types.ts:582`, the SDK
was not adopted, the zero-runtime-dependency trait is intact, and `assertNever` still works.
Per the rule above, this hand-extension re-opens the checkpoint at **M2-1**.

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
*Done when* (in addition to the criteria below) a second `prompt()` during a live turn
throws without a byte reaching the subprocess, covered by `node:test`.
**Landed 2026-09-02 (#11).** All five behaviours are in and each has a subprocess-driven
test in `protocol/agent.test.ts`: the 30s deadline on the handshake and session-management
calls but never on `session/prompt`, unbounded stderr attached to a mid-handshake death,
the in-flight guard, the whole `PromptResponse`, and `_client_cancel_requested`.
**One `#guardPath` case does not pass, deliberately.** A symlink pointing out of the root is
followed: `path.resolve` is string arithmetic and never touches the filesystem, so
`link.txt` looks in-root. The test records what the guard does today rather than what it
should do (`protocol/agent.test.ts:362`), and **M1b-6 owns closing it** — the fix is
`fs.realpath` before the prefix check. The other four cases — in-root, escaping `../`,
absolute-outside, and the read/write asymmetry under `allowReadOutsideRoot` — pass.

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
branches kept only their probes) and `docs/M0-FINDINGS.md` records the handshake without
`agentInfo`. So the literal comes from the version rows in that note, and the check compares
against `agentInfo.version` when the harness sends one and stays silent when it does not —
warning only, never failing a run, as B2 decided.
**M2-8's `AGENT_TEAM_*` strip collides with M0-2's identity return**, and secrecy wins:
`resolveEnv` returns `base` by identity only when the entry declares no `env` **and** no such
variable is set. Both properties are asserted in `protocol/registry.test.ts`.
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
too and `safe` refused those as well (`M0-FINDINGS.md` §M0-1, "What re-verification
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
**Landed 2026-09-03 (#14).** Both entry points subscribe and neither reads agent state:
`run.ts` attaches `render`, `fanout.mjs` attaches its own buffering listener. **Not
`node:events`** — `EventEmitter.emit` propagates a listener's throw and skips the listeners
behind it, so one broken renderer would take the run down; a `Set` and a `try` is less code
than wrapping every handler.
**None of the six supervisor variants landed, because five have no producer.** Task started,
worktree created, permission pending, stall warning and task finished are sent by files that
do not exist yet (M1b-2, M1b-3, M1c-1); each story widens the union when it lands its own
producer. The sixth, the containment warning, deliberately stays on stderr: routing it
through the bus would put it behind a sink `--quiet` can switch off, and #13 says that line
is never silenced.

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
**This is the first `render.test.ts`.** Every other branch of the renderer is eyeballed
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
**Gap** — `agent-team merge <runId>` operates on branches, retention promises "the branch
always survives", and worktrees live at `.agent-team/wt/<runId>/<taskId>` — yet the plan
gives no format for `runId`, no charset constraint for `taskId`, and **no branch naming
convention at all**, so merge has no defined way to find the branches belonging to a run.
Three things depend on it: filesystem path safety, git ref legality, and branch discovery.
**Decided 2026-08-23 (ratified with amendment, #62 B1):** `runId` =
`YYYYMMDD-HHMMSS-<4 char base36>` (sorts chronologically, readable in a path, collision-safe
within a second); `taskId` validator-enforced **`^[a-z0-9][a-z0-9_-]{0,63}$`**; branch =
`agent-team/<runId>/<taskId>`. Merge discovers branches by reading the run's own persisted
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
with the validator by construction (`core/ids.test.ts:69`). The three ids the dropped dot
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
this repo's own modules — an imported run file read `AGENT_TEAM_*` out of `process.env` and
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
*Done when* `node:test` covers the stop-reason table and the roll-up ordering, a six-task
run file with `maxConcurrency: 2` never has three live subprocesses, and the run-file JSON
Schema's property names are asserted equal to `RUN_KEYS` and `TASK_KEYS` by a test, with the
example run file carrying a `$schema` line.

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
root when a task runs from the repo root. **Decided 2026-08-23 (ratified with amendment, #62 B1): a preflight step that requires
`.agent-team/` to be git-ignored** — **refusing to start with an instruction if it is
neither ignored nor tracked**, refusing to start if the path is *tracked* — plus explicit
exclusion from the diff cross-check (M1b-4). Keeping state in-repo is right, discoverable
and per-project; it just has to be invisible to git.
**Amendment — the preflight cannot append it.** As written it appended `.agent-team/` to
`.gitignore` when absent, which dirties the working tree the same preflight refuses to start
on: the first run in a fresh repo would either refuse after having modified the user's file,
or need an exception carved for its own edit. It is also a write to someone's repository
that nobody asked for, on a tool whose entire posture is that it does not touch things
without permission. So it **refuses with the fix in the message** — *"add `.agent-team/` to
.gitignore and re-run"* — a one-time cost per repository, paid deliberately.
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
exact signature this warning exists to catch — so on opencode it fires on
every mutating task. Two consequences: the warning text must not read as an anomaly report,
and it should be paired with M1a-4's `asksPermission: false` so a run says "this harness
never asks" once, rather than crying wolf per task. Excludes `.agent-team/` from the diff (M1b-3).
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
retry would silently destroy the very work whose result it was trying to recover. #62's R5
makes this structural rather than advisory — `prompt()` throws on a second call
(M1a-3) — so this story could not have implemented the retry even if it wanted to. The
conflict predates today: it was written into M1b-4 before M0-4 measured the behaviour, and
survived because nothing forced the two to be read together.
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
**Gap, narrowed by M1a-3** — stderr was discarded unless `--verbose`. M1a-3 now retains it
in memory and attaches it to the rejection when a harness **dies**
(`docs/STORIES.md`, the `Decided 2026-08-31` block under M1a-3), which covers a harness that
**dies during the handshake**. What remains for this story is the **durable**
record: a harness that dies leaves nothing on disk, a *live* harness's stderr is still only
mirrored under `--verbose`, and under a daemon nobody is watching a terminal.
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
idle time structurally cannot see. Repeat reuses the `toolCallId → {title, kind, rawInput}` map
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
**M0-5 makes that drop evidence-backed rather than cautious** (`docs/M0-FINDINGS.md` §M0-5).
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

**M1c-5 · Package identity · XS**
**Gap** — the plan invokes `agent-team merge`, but `package.json` is `private`, named
`acp-mvp`, and has no `bin`; and no document states which platforms are supported, while
M1c-4 shells to `notify-send`/`osascript` and `git worktree`, paths and `sep` all behave
differently on Windows. **Decision: rename to `agent-team`, drop `private`, add the `bin`
entry, and declare macOS and Linux supported with Windows explicitly unsupported** — rather
than discovering it.

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

**M1c-6 · M1 acceptance · S · needs all M1c**
A run file with three independent tasks against three real harnesses, each in its own
worktree, each returning a parsed `TaskResult`; `git worktree list` clean afterwards. Kill
the process mid-run, restart, confirm orphans are reaped. A `.json` run file and the same run
as a POST body validate to the same object (amended 2026-09-05, M1b-1: run files are JSON
only). A run file exceeding a harness `maxMode` is rejected, naming both values, before any
subprocess starts.

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
**Amended by M1c-7 (2026-09-04): the "no runtime dependency" clause is under revision.**
M1c-7 renders agent text as Markdown and takes the project's first runtime dependency to do
it, and `-js-render` is the second consumer of the same `core/markdown.ts` — the parser is
shared across surfaces, only the paint is per surface. Whichever way M1c-7 decides, this
sentence must be revised rather than quietly broken: either it gains the same
presentation-layer exception M1c-7 proposes, or the browser half is vendored as one
self-contained file and the clause stands as written. Do not start M4-1 against the
unamended text.

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

```text
M0-1 ─┬─ M0-3 ─┬─ M0-7 ─ M1a-4 ┐
      ├─ M0-4 ─┤                      │
      └─ M0-5 ─┘                      │
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
   **M0-8, its would-be successor, resolved instead of run** — `87cbfe3` had already
   advertised the flag, and `M0-FINDINGS.md` records the result: no fourth
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
  a rejection message large enough to be unreadable in the terminal or M2-1's event log.
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
