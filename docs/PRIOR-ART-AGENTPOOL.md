# Prior art — AgentPool

A design review of [`phil65/agentpool`](https://github.com/phil65/agentpool) against this
project, done because it is the only prior art surveyed so far that ships **a second full
implementation of the ACP client side** — the exact layer `acp.mjs` is — and has already
crossed several bridges this project's plan still lists as open questions
(`docs/PROJECT-PLAN.md`, "Open, deliberately unresolved").

Read 2026-08-22 against commit `b6ddbea9` (shallow clone, last commit 2026-04-26). Every
`path.py:NN` below is that commit; every `acp.mjs:NN` is master at `1bfee9c`. Line numbers
rot — re-check with `sed -n 'NNp'` before trusting one.

**Re-scored 2026-08-23** against M0-5, M0-6 and M0-7 (which landed after the first pass) and
against the retrospective's decision surface, issue #62. That second pass moved six of the
fourteen verdicts and reversed one outright — see [What M0 moved](#what-m0-moved). It also
found a whole channel the first pass missed, [`_meta`](#the-_meta-channel), and established
that on three of the retro's risks AgentPool has [nothing to offer](#what-agentpool-does-not-answer).

This file is a **findings note**, and the M0 retrospective ran against it on 2026-08-23.
Four of its recommendations are now decisions — **8b** (`_meta` kept through the typed
layer, #62 B4), **8c** (the `terminal_output` probe, measured by M0-3's `87cbfe3` and parked), **8** (the bus
carries the wire object) and the `measuredOn` half of **2** (#62 B2). Items **1**, **5** and
**6** remain *proposals* awaiting whoever picks up M1a; everything under Defer and Refuse is
a recommendation, not a ruling. `docs/STORIES.md` is the authority on which is which — every
decided half there carries a date.

---

## Verdicts, up front

| # | What | Verdict |
| --- | --- | --- |
| 1 | Race handshake RPCs against process death; keep a stderr ring buffer | **take** — M1a-3, alongside its timeout |
| 2 | ACP registry resolution + zero-install spawn (`npx -y`, `uvx`, binaries) | **split** — pin versions (M1a-4); auto-resolve to backlog |
| 3 | Filter injected MCP servers by the agent's advertised transports | **defer** — with the first story that injects one |
| 4 | Decline elicitation and ack `_`-prefixed ext methods instead of erroring | **backlog** — trigger: first unhandled method on the wire |
| 5 | Render `locations[]` on tool calls | **take, verify first** — types now, render after one probe |
| 6 | Mock agent that can fire every `sessionUpdate` variant on demand | **take** — M1a-2 needs it as its driver |
| 7 | A backend seam under `fs/*` (and later `terminal/*`) | **refuse** — reversed; it would sit under dead code |
| 8 | Persist raw `session/update` objects as the source of truth | **take** — decided; M1a-2 and M1a-6 |
| 8b | Keep `_meta` through the typed layer, both directions | **take** — **decided**; answers #62 B4 |
| 8c | Probe the `_meta.terminal_output` capability | **take** — **decided**; measured by `87cbfe3`, parked |
| 9 | MCP tool bridge as the structured-result contract | **defer** — named M3 successor to `<task-result>` |
| 10 | Supervisor speaks the *agent* side; permissions forward up the chain | **defer** — M4 alternative to the dashboard |
| 11 | WebSocket transport / stdio↔ws bridge | **defer** — M2, if SSE proves insufficient |
| 12 | Native SDK paths below ACP (opencode, pi, Claude Agent SDK) | **refuse** |
| 13 | Reading harnesses' own on-disk session stores | **refuse** |
| 14 | YAML config, declarative teams/chains/connections | **refuse the mechanism** |

Three places where copying would be a regression are in
[Where we are ahead](#where-we-are-ahead). Two facts I could not verify from this container
are in [Unverified](#unverified-from-this-container).

---

## What M0 moved

The first pass scored these against the MVP and the plan. M0-1's traffic tables, M0-5's
usage survey and M0-7's re-verification change six of them, and the retro's own risks
(#62, R2 especially — *"effort is pointed at a guard that binds nothing"*) supply the
principle that decides four.

| # | Change | What moved it |
| --- | --- | --- |
| 1 | take → **take, strengthened** | M0-2 killed the original justification: the opaque `-32603` does not reproduce on adapter 0.49.0. M1a-3's own gap replaces it — a harness that accepts the pipe and never answers `initialize`. The decided 30 s timeout covers *alive but silent*; this covers *died with a message on stderr*. Siblings, not alternatives |
| 2 | take, scoped → **split** | Auto-resolve drops to backlog: `npx -y` against a CDN is actively hostile to a registry of **measured** labels, when M0-7 watched copilot change three behaviours in three days. The version-**pinning** half is promoted instead — pinning is what would make #62's B2 staleness check enforceable rather than advisory |
| 3 | take → **defer** | Nothing in M1 injects an MCP server, so the filter would guard nothing. R2's complaint, applied to this report's own recommendation |
| 4 | take → **backlog** | M0-1: **zero** methods reached `#handleRequest`'s default across six surveyed turns. Speculative hardening. The trigger is free — the wire tap sees the first one the day it appears |
| 6 | take → **take, load-bearing** | M1a-2's *done when* is "adding a variant makes `tsc` fail at every unhandled `switch`", which needs an offline driver. M0-1 found `available_commands_update` dropped from all three and `config_option_update` from copilot, and `plan` emitted by nobody — three render paths with no exercise outside the mock |
| 7 | take the seam → **refuse, reversed** | **Zero `fs/*` traffic from any harness in any run.** An abstraction seam underneath dead code is R2 in its purest form. The first pass wrote this recommendation without M0-1's traffic table; it was wrong |
| 8 | constraint for M2 → **decide in M1a** | All three advertise `loadSession: true`, two add `resume` and `fork`. The plan's "ACP has no resume" premise is dead and #62 calls resume an unscheduled cheap win. Their `is_loading` / `finish_load` split (`agents/acp_agent/session_state.py:58`, `:91`) is exactly the mechanism that stops replayed updates re-entering the live stream |

Verdicts 5, 9–14 stand as written.

---

## What AgentPool is

A unified agent orchestration hub: agents of heterogeneous kinds — native (PydanticAI),
external ACP subprocesses, AG-UI HTTP endpoints, a direct Claude Agent SDK integration —
declared in one YAML file, exposed through `serve-acp`, `serve-opencode`, `serve-mcp`,
`serve-agui` and `serve-api`. Python, ~115k lines across twelve top-level packages,
substantial dependency surface (pydantic-ai, fastapi, httpx, fsspec, structlog, alembic …).

The comparison is not apples-to-apples, and most of the repo is irrelevant to us: knowledge
bases, storage analytics, prompt hubs, a Slack/Discord bot layer, streaming TTS. **Two
parts are directly comparable and worth the read:**

- `src/acp/**` (~11.7k lines) — a standalone ACP library: client side, agent side, schema,
  transports, an agent registry, a stdio↔WebSocket bridge, a message dispatcher.
- `src/agentpool/agents/acp_agent/**` (~2.3k lines) — the supervisor that owns one external
  harness subprocess. This is `acp.mjs` + `agents.mjs` in their shape.

The design inversion we describe in `CLAUDE.md` — *this code is the client, the harness is
the agent* — is theirs too, arrived at independently. So is: the harness owns its own auth,
adding a harness is a config entry rather than an integration, each agent gets its own
`cwd`, optional methods are gated on `agentCapabilities`, one subprocess per agent, and
cancellation is best-effort (`acp_agent.py:559` sends the notification, then cancels local
tasks). That convergence is the most reassuring thing in this document: the brief's bets
are not eccentric.

---

## The list, item by item

Headings carry the **re-scored** verdict. Where the first pass said something else, the
change and its evidence are in [What M0 moved](#what-m0-moved).

### 1 · Race handshake RPCs against process death — take, M1a-3

`run_with_process_monitor` (`utils/subprocess_utils.py:126`) runs an RPC as a task racing
`process.wait()`. If the process wins, it reads the subprocess's stderr and raises
`SubprocessError(returncode, stderr)`. Every handshake step is wrapped in it —
`initialize`, `session/new`, `session/load` (`acp_agent.py:278`, `:282`, `:292`, `:296`).

This is the direct fix for the papercut `CLAUDE.md` names: *"harness spawn failures surface
as opaque JSON-RPC errors — typically `Internal error (code -32603)` on `session/new`, with
the real message only on the harness's stderr under `--verbose`."* We already discard that
stderr unless asked (`acp.mjs`), and a harness that dies *before* answering leaves
`#failAll` (`acp.mjs`) reporting only an exit code.

Cost in our terms: a bounded stderr ring buffer (keep the last ~20 lines regardless of
`--verbose`) plus attaching it to the rejection in `#failAll`. ~25 lines, no dependency, no
invariant touched. The `close` handler already exists; only the message improves.

**Re-scored.** That papercut is gone — M0-2 could not reproduce the `-32603` on adapter
0.49.0. The justification is now M1a-3's own gap instead, and it is a better one: a harness
that accepts the pipe and never answers `initialize`. M1a-3 already decided a 30 s timeout
for it, which catches *alive but silent*; this catches *died, with a message on stderr*.
Build them together or the second failure mode reports a bare exit code.

### 2 · ACP registry resolution and zero-install spawn — split

There is an official ACP registry — `REGISTRY_URL` at `registry/fetch.py:12` — publishing
agent entries with per-platform distributions. `registry/model.py:93` models an entry;
`RegistryAgent.prepare()` (`model.py:126`) resolves one to an argv: `bunx`/`npx -y <pkg>`
(`prepare.py:38`), `uvx --python 3.13 <pkg>`, or download-and-extract a per-platform binary
into `~/.local/bin` (`prepare.py:56`). Registry entries also carry an `env` dict, merged
with the user's, with the user's winning (`acp_agent.py:314`).

Their config keeps both paths, which is the shape I'd copy: an explicit-command entry
(`models/acp_agents/base.py:181`) and a registry-id entry with `extra_args`
(`base.py:227`). Ids visible in their docstrings: `goose`, `gemini`, `claude-acp`,
`opencode`, `codex-acp`, `stakpak`.

Why this matters for us specifically: `README.md` spends a full section on
`npm i -g @agentclientprotocol/claude-agent-acp`, `EACCES`, npm prefixes and
`spawn … ENOENT`. `npx -y` deletes that section. It also means a new harness costs *zero*
lines instead of one.

**Scope it, though.** `npx -y <whatever the registry names>` is remote code execution
sourced from a CDN, on a machine where our whole safety story is about what a harness may
do. Recommended shape: opt-in resolver behind `agents.mjs` (`--agent registry:goose`, never
a silent fallback for a missing local entry), version pinned in the resolved argv, response
cached to disk with the local map as offline fallback, and the security posture stated in
the README rather than implied. Our hand-written entries stay the default and stay the
place harness quirks live — `CLAUDE_PARENT_ENV` (`agents.mjs`) is exactly the kind of
knowledge no upstream registry will carry for us, and neither will the M0 containment
metadata (`argvChannel`) the plan puts in the registry.

**Re-scored — split, and the halves go opposite ways.** M0-7 watched copilot change three
measurable behaviours between 1.0.78 and 1.0.80, in three days. That makes M1a-4's registry
a set of claims *about a build*, and a launcher that silently resolves "latest" from a CDN
is the exact opposite of what such a registry needs. **Auto-resolve → backlog** (trigger: a
target harness with no stable install path).

**Version pinning is the half that survives, and it is worth more than the convenience
was.** #62's B2 asks whether each registry entry records *when* its labels were measured and
whether a mismatch warns. A pinned launch argv turns that from a warning into a property:
we run the build we measured. **Decided 2026-08-23 (#62 B2): `measuredOn: { version, date }`
lands in M1a-4**, compared at startup, warning only. Pinned launch is *not* decided — it
rides on the auto-resolve half that went to the backlog — so the comparison needs a version
from somewhere: check whether `agentInfo` (already stored, `acp.mjs`) carries one before
designing a probe.

### 3 · Filter injected MCP servers by advertised transports — defer

`filter_servers_by_capabilities` (`agents/acp_agent/helpers.py:17`) drops HTTP servers when
`agentCapabilities.mcpCapabilities.http` is falsy, SSE likewise, passes stdio through
always, and logs which servers were skipped and why. Called before both `session/new`
(`acp_agent.py:374`) and `session/load` (`:694`).

`newSession({ mcpServers })` already exists at `acp.mjs` and nothing passes anything to
it. The moment a task wants to inject an MCP server, this filter is the difference between
"that harness didn't get the server, here's a warning" and a failed session. ~15 lines,
and it is capability negotiation — the fourth protocol gotcha in the brief — applied
somewhere we currently don't apply it.

**Re-scored — defer.** Read that paragraph against #62's R2, *"effort is pointed at a guard
that binds nothing"*: no story before M3 injects an MCP server, so shipping the filter in
M1a would add exactly the kind of code that risk is about. It belongs to whichever story
first passes something to `mcpServers` — item 9's successor most likely — and it is 15 lines
whenever that is.

### 4 · Decline elicitation, ack extension methods — backlog

Their headless client answers `elicitation` with a decline (`headless_client.py:265`),
no-ops `elicitation_complete` (`:271`), and acks `ext_method`/`ext_notification`
(`:260`, `:274`) rather than failing.

Our `#handleRequest` throws for every method outside the three we implement
(`acp.mjs`). For a genuinely unknown method that is right; for elicitation — which the
brief lists as deliberately unimplemented — a hard error can end a turn that a polite
"declined" would let continue. Same for `_`-prefixed unstable extensions, which by
convention a peer must tolerate. ~10 lines, and `mock-agent.mjs` should learn to send both
so the path is exercised (see 6).

**Re-scored — backlog, with a free trigger.** M0-1 measured it: across six surveyed turns,
**no harness sent a method outside the three we implement**, so the `-32000` default at
`acp.mjs` never fired. This is hardening against traffic that does not exist. The
trigger costs nothing to arm — the wire tap sees the first unhandled method the day one
appears, and the change is still ~10 lines then.

### 5 · Render `locations[]` — take, verify first

`ToolCallState.update` (`tool_call_state.py:128`) normalizes `locations` to
`ToolCallLocation` and forwards them. `render.mjs` prints title and kind only; we surface
a path only for completed `diff` content (`render.mjs`). `locations` is the harness
telling us which files a call is about, *before* it happens — cheap output, and useful
input to M1c's "same tool repeating" stall heuristic, which currently has only a title
string to compare.

**Re-scored — take the type, verify before spending render effort.** M0 never recorded
whether any harness populates `locations`; it is not in M0-1's field tables either way. So:
M1a-2's union carries it, and the render line waits on one wire-tap answer. If nobody sends
it, the field costs nothing and the render never happens.

### 6 · A mock agent that can fire every update variant — take, M1a-2

Their testing rig is `src/acp/agent/implementations/debug_server/`: a mock agent plus a
small web panel whose entire purpose is manually firing *any* notification type from the
schema — plans, thoughts, tool call progress, mode changes, available-commands updates — at
a client under test.

We don't need the web panel; we need the capability. `CLAUDE.md` makes `mock-agent.mjs` the
test harness of record and says to extend it when adding client capabilities, but
`render.mjs` today has branches (`plan`, `usage_update`, failure paths) that nothing
offline drives. A `--emit <variant,variant,…>` flag on `mock-agent.mjs` makes the renderer
verifiable with nothing installed, which is the invariant we already claim.

**Re-scored — load-bearing, not nice-to-have.** M1a-2's *done when* is that adding a variant
must make `tsc` fail at every unhandled `switch`; proving the runtime half of that needs
something that emits the variant. M0-1 supplies the list: `available_commands_update` from
all three harnesses and `config_option_update` from copilot are **dropped today**, and
`plan` is emitted by **no** harness, so its render path has no driver but the mock. Three
paths, one flag.

### 7 · A backend seam under `fs/*` — refuse (reversed)

Every filesystem and terminal request in their client handler goes through a pluggable
*execution environment* rather than the local disk: `read_text_file` at
`client_handler.py:248` and `write_text_file` at `:274` both call `self.env.get_fs()`, and
the environment is configurable per agent (`models/acp_agents/base.py:75`,
`client_execution_environment`: local, docker, an E2B sandbox, or remote). They also model
the ACP session itself as a filesystem (`acp://`, `filesystem.py:73`) so an agent can be
handed a workspace that isn't a directory at all.

The first pass recommended taking this as **one indirection, not a feature** — route our
`fs/*` handlers through a tiny interface so an M1b worktree-scoped or a later
container-scoped workspace could be substituted.

**Re-scored — refuse. This reverses the recommendation above, and the reversal is the
point.** M0-1 measured **zero `fs/*` traffic from any harness in any run**: all three read
and write in-process, and files appeared on disk during the write probe without a single
`fs/write_text_file` crossing the wire. A pluggable backend beneath handlers nothing calls
is R2 exactly — effort pointed at a guard that binds nothing — and the first pass wrote the
recommendation without that traffic table in front of it.

`#guardPath` still stays, for the reason M0-1 gives: a harness may use `fs/*` tomorrow and
the MCP path may. Keep it, keep its tests (the mock exercises them for free), and spend
nothing further until something actually calls `fs/*`. Note also what this does *not*
settle: R2's real question is sandboxing the harness process itself, which this seam would
never have touched — see [what AgentPool does not answer](#what-agentpool-does-not-answer).

### 8 · Persist raw `session/update` objects — take, decided, M1a-2 and M1a-6

`ACPSessionState` (`agents/acp_agent/session_state.py`) keeps raw ACP updates in a deque as
"the single source of truth", converting to native events lazily on consumption
(`:37`). Session load flips `is_loading` (`:58`) so replayed updates collect into a separate
buffer and don't get re-emitted into the live stream (`:91`).

Our PROJECT-PLAN already says the event bus is the single source of truth; this adds the
detail worth committing to *before* M2 persistence and `session/load` get built: persist
the wire objects, render from them, and give replay its own buffer. Reconstructing a run
from rendered output is the mistake this avoids.

**Re-scored — decide it in M1a, not M2. Decided 2026-08-23.** Two things moved it. First,
resume is real: all three harnesses advertise `loadSession: true`, opencode and
claude-agent-acp add `resume` and `fork` (`M0-FINDINGS.md`, roll-up), so the plan's premise
that ACP has no resume is dead and #62 lists it as a cheap win nobody scheduled. Second,
this is the same decision as `_meta` below — a bus carrying rendered forms cannot replay,
and cannot carry an extension field it never modelled.

What that means concretely for M1a-2 and M1a-6: the bus carries the wire object; consumers
render *from* it; and when replay lands, it gets its own collection buffer rather than
re-entering the live queue.

---

## The `_meta` channel

Found on the second pass, looking specifically for answers to #62. The first pass missed it
entirely, which is itself the finding: **the interesting, undocumented half of this
ecosystem travels in a field our client currently ignores.**

`_meta` is the spec's own extension point — every ACP message type carries an optional
free-form object, so implementations can attach what the spec does not define. The ACP
equivalent of `X-` headers. On the wire:

```jsonc
{"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "bash", "kind": "execute",
 "_meta": {"terminal_info": {"terminal_id": "term_7"},
           "claudeCode": {"toolName": "Bash"}}}
```

M0 already tripped over this twice: M0-5 found the fleet's **only** exhaustion warning there
(claude-agent-acp's `_meta["_claude/rateLimit"]`, with `allowed_warning`, `utilization`,
`credits_required`), and M0-3 found harnesses gating behaviour on `_meta` extensions we do
not advertise.

### 8b · Keep `_meta` through the typed layer — **decided**

AgentPool puts it on the **base** model — `field_meta: dict[str, Any] | None` at
`src/acp/schema/base.py:30`, with an alias generator mapping `field_meta ↔ _meta`
(`base.py:12-14`) — so every request, response and notification carries it by construction
rather than per type.

**Decided 2026-08-23: we do the same, in both directions.** `_meta` on the base of the
message types in M1a-2 — inbound notifications and responses, outbound requests alike — and
M1a-6's bus carries the wire object with it intact. Nothing consumes it yet. **This answers #62's B4.**

Two honest notes on the rationale. It is *preservation, not addition*: `acp.mjs`
already forwards the whole update object to `onEvent`, so `_meta` reaches consumers today
and only `render.mjs` ignores it — the typed port is where we would start losing it. And
the cost of deferring is not a refactor, as I first claimed: adding an optional field to a
base type later is one line. The real cost is that **every run recorded in the meantime has
no `_meta` in its event log.** Code is recoverable; unrecorded data is not.

### 8c · The `_meta.terminal_output` capability — **measured, not reproduced**

`ClientCapabilitiesMeta.terminal_output` (`field_meta.py:231`), sent on `initialize`. Their
note, citing `claude-agent-acp/src/acp-agent.ts:973`: *without* it, agents fall back to
sending bash output as plain text content blocks; *with* it, a Bash tool call becomes a
three-notification lifecycle (`ToolUpdateMeta`, `field_meta.py:132`):

1. `tool_call` carrying `terminal_info` → the client creates a display-only terminal, no PTY
2. `tool_call_update` carrying `terminal_output` → `{terminal_id, data}`, streamed
3. `tool_call_update` carrying `terminal_exit` → `{terminal_id, exit_code, signal}`

Their comment on why it exists: *"Claude Code and Codex execute bash commands server-side,
but ACP normally expects the client to manage terminal processes via `terminal/create`."*
The same convention is used by `codex-acp`.

**Already measured, not reproduced.** M0-3's second commit `87cbfe3` advertised the flag.
claude-agent-acp's Bash `tool_call` then carried `_meta.terminal_info.terminal_id` and a
`{type: "terminal"}` content block for a terminal that was **never created**, with still
zero `terminal/*` calls, no command output crossing the wire, and **no exit code**
(`docs/M0-FINDINGS.md`). It is a rendering convention for a client that already
draws the terminal, not the visibility M0-3 called unobtainable; `argvChannel` gains no
fourth value. The `terminal_exit` lifecycle carrying `exit_code`/`signal` is **not
reproduced** and stays AgentPool's citation into source this repo has not read.
**Decision 2026-08-23: parked** — no follow-up probe scheduled for the MVP.

### 8d · What else is in the pocket — registry content, not client content

Not scheduled; recorded so the stories that need them know where to look.

- **`ClaudeCodeToolMeta`** (`field_meta.py:29`) — `toolResponse` carries structured tool
  output (for `Edit`, the file path and structured patch), and `parentToolUseId` links a
  tool call made *inside* a sub-agent back to what spawned it. The first is a second opinion
  for M1b-4's `<task-result>` vs `git status` cross-check; the second bears on the
  silent-autonomy warning — and note its converse, that a harness spawning sub-agents is
  orchestrating inside a task we treat as one unit.
- **Zed's `subagent_session_info`** (`field_meta.py:205`) — `{session_id,
  message_start_index, message_end_index}` on the tool call's `meta`, which is a *different*
  field from `_meta`.
- **`NewSessionMeta` → `claudeCode.options`** (`field_meta.py:327-361`) — the outbound half:
  `systemPrompt: {append}` and `disableBuiltInTools`, plus `resume`, `maxTurns`, `hooks`,
  `mcpServers`, `disallowedTools`. `systemPrompt.append` is a per-session instruction channel
  *outside the prompt text* — a cheaper route to M1b-4's result contract than item 9's MCP
  server. `maxTurns` is a harness-side bound on a runaway turn, which is interesting against
  R5 precisely because it needs no second prompt.

**Provenance, and the limit on all of it.** `src/acp/schema/field_meta.py` (406 lines) and
`acp_meta_field_reference.md` (209) are a reverse-engineered map, each entry naming producer
and consumer with file and line into Zed and the adapters. Those are *AgentPool's* citations
into third-party source this container cannot reach (see
[Unverified](#unverified-from-this-container)). I have verified that AgentPool asserts them,
not that the cited lines say so. `87cbfe3` put exactly one entry on the wire (the
`terminal_output` flag, recorded at §M0-3); the rest stays their claim until someone probes
it, and M1a-4 should carry the caveat with the flags.

---

## What AgentPool does not answer

Three of #62's items have no prior art here. Recorded so nobody spends a second afternoon
looking.

- **B3 — the discarded `PromptResponse.usage`.** They read `stop_reason` off the prompt
  response and nothing else (`acp_agent.py:512`), computing usage from message parts
  instead. M0-5's finding — that the response carries the only per-task token count present
  on all three harnesses — is ahead of them, and its `UNSTABLE` status plus copilot's
  cumulative-vs-per-turn difference are ours to handle alone.
- **R5 — no safe way to nudge a turn.** They track `_prompt_task` for cancellation
  (`acp_agent.py:199`, `:567`) and have **no in-flight guard at all**. A second `prompt()`
  on their agent lands exactly the way M0-4 measured it landing on ours. Making a second
  prompt structurally impossible is our design problem, unaided.
- **R2 — sandboxing.** Their execution environments (docker, E2B) sandbox only the
  operations *the client serves* — `fs/*` and `terminal/*`. M0-1 measured zero `fs/*`
  traffic and M0-3 zero `terminal/*` calls, so against our three harnesses that sandbox
  would bind **nothing**. The harness subprocess itself is spawned plainly
  (`anyio.open_process`, `acp_agent.py:335`), exactly as we spawn it. The only sandbox that
  binds is one around the harness process, and neither project has one.

---

## Defer

### 9 · MCP tool bridge as the result contract — the named M3 successor

`_setup_toolsets` (`acp_agent.py:257`) starts an in-process MCP server exposing
supervisor-owned tools, then hands its URL to the harness as an `HttpMcpServer` in
`session/new` (`:266`, `:269`). That is how they get typed outputs and subagent delegation
across harnesses that share no SDK — the harness calls *back into the supervisor*.

This is the mechanism our "Result contract" decision defers ("MCP `report_result`
deferred"), and it evidently works in production against real harnesses. It stays deferred:
the supervisor would have to run a server the harness connects to, which is a real cost
against the zero-runtime-deps survival trait, and `<task-result>` gets M1 a contract for
roughly nothing. Record it as the named upgrade path — with 3's capability filter as a
prerequisite, and with the note that stdio MCP servers avoid the HTTP server entirely at
the price of the tool running in a *separate* process from the supervisor that needs the
answer.

### 10 · Supervisor as an ACP agent, with permissions forwarded up — M4 alternative

AgentPool implements the *agent* side too and ships `serve-acp`, so Zed (or any ACP client)
drives the whole pool as if it were one agent (`docs/servers/acp-server.md`). The detail
that makes it more than a demo: when a nested harness asks permission, the client handler
forwards the request to the outer client via `acp_permission_callback`
(`client_handler.py:205`) instead of deciding locally — the editor's own permission UI
answers for a harness two processes away.

For us that is a serious alternative to building the M4 dashboard: implementing the agent
side would hand agent-team an existing, maintained UI with permission answering, which is
precisely the M4 scope. It is not free — the agent side is a second protocol surface, and
run/worktree/merge concepts have no place in an editor's session model. Worth comparing
honestly at M4 rather than doing both.

### 11 · WebSocket transport and a stdio↔ws bridge — M2 if needed

`transports.py:50` defines a `WebSocketTransport` alongside stdio, and `src/acp/bridge/`
runs the bridge. The brief calls "no remote transport" one of ACP's pre-1.0 gaps; this
shows the answer is a bridge outside the protocol, not a protocol change. Our daemon's SSE
stream covers the same need for the UI case, so this only matters if we ever want a harness
on another machine.

---

## Refuse

### 12 · Native SDK paths below ACP

They vendor `src/opencode_sdk` and `src/pi_sdk`, and maintain a direct Claude Agent SDK
integration *in addition to* driving Claude through ACP. Their stated reasons
(`docs/configuration/node-types/claude-code-agents.md`): lower latency, tighter streaming,
toolset bridging, structured outputs.

Refuse — it is the N×M our ACP bet exists to avoid, and a fleet of SDK integrations is what
the brief's "build thin, don't adopt a platform" survival argument is against. But record
the data point honestly: they dropped below ACP for exactly the two things we also want
(structured output, tool injection), which is the price of the bet, and 9 is the ACP-shaped
way to buy them back.

### 13 · Reading harnesses' own session stores

`src/agentpool_storage/` carries `claude_provider`, `codex_provider`, `opencode_provider`
and `zed_provider` — readers for each harness's native on-disk history. It is a real answer
to the brief's cross-harness cost-and-history question that needs no protocol support.

Refuse anyway: undocumented formats, four vendors' churn, and a maintenance tail a
400-line client cannot carry. Noted here so the option is on record rather than rediscovered.

### 14 · YAML config and declarative teams/connections

Agents, teams (`mode: sequential | parallel`), jobs, and `connections` — message forwarding
with conditions, targeting another node, a file, or a Python callable
(`docs/configuration/connections.md`) — all declared in YAML with a published JSON schema.

Their teams-and-chains are our M3 DAG and our pipeline handoff; the convergence is
reassuring. The mechanism is not for us: PROJECT-PLAN's "why the run file is code" already
weighs YAML and rejects it on zero-deps grounds, and `satisfies Run` type-checks a run file
before it executes, which a YAML schema can only approximate.

---

## Where we are ahead

Record these so a later reader doesn't "steal" a regression.

1. **No path guard on their client.** `client_handler.py:274` writes wherever the harness
   asks — `makedirs` then `pipe_file`, no root check — because containment is delegated
   entirely to the execution environment. Our `#guardPath` (`acp.mjs`) is unconditional
   and independent of policy. Keep it in front of any backend seam we add (7). Their design
   is strictly weaker whenever the environment is `local`, which is their default.
2. **Permission option selection.** They take `params.options[0]`
   (`client_handler.py:201`, and again in `headless_client.py:94`) — whatever the agent
   listed first, which may be `allow_always`. Our `pickOption` (`acp.mjs`) prefers
   `allow_once`, falls back to `allow_always`, and mirrors the same order for rejects.
   A one-shot approval that silently becomes a standing one is exactly the failure our
   `ask` mode exists to prevent.
3. **Containment honesty.** Nothing in AgentPool records whether a harness routes commands
   through `terminal/*` or ever shows real argv, nor warns when a policy never fired. Our
   `argvChannel` and `policyNeverFired` work (M0-1, M0-3, `docs/M0-FINDINGS.md`) has no
   counterpart there — and M0-1's finding that opencode never asks permission at all means
   a client without that labelling is quietly overclaiming.

One neutral difference worth a decision rather than a copy: on a missing file their
`read_text_file` returns empty content rather than an error, explicitly *"match Zed
behavior"* (`client_handler.py:267`). We throw. M0-1 found no target harness calls `fs/*`
at all, so this is theory today — but if one starts, Zed's behaviour is the compatibility
target and ours is the honest one.

---

## Unverified from this container

- **The registry contents.** `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  is blocked by this session's egress proxy (`curl`: `CONNECT tunnel failed, response 403`;
  WebFetch: `EGRESS_BLOCKED`). Every agent id quoted in 2 comes from AgentPool's own
  docstrings, not the live feed. Before acting on that row, fetch it locally and confirm it
  carries our three verified targets — opencode, claude-agent-acp, copilot — and check what
  version pinning the entries actually allow.
- **Their published docs.** `phil65.github.io/agentpool` is blocked too; all doc quotes here
  come from the `docs/` tree inside the clone at `b6ddbea9`, which may lag the site.
- **Every citation into Zed and the adapters.** The `_meta` catalogue's entries name lines
  in `claude-agent-acp/src/acp-agent.ts`, `zed/crates/agent_servers/src/acp.rs` and
  `zed/crates/acp_thread/src/acp_thread.rs`. Those repositories are unreachable from here.
  What is verified is that AgentPool asserts them — not that the lines say so. Anything we
  act on wants confirming on the wire first, which `87cbfe3` has done for the one that
  matters most.
