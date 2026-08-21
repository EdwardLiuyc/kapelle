# M0 findings

Empirical answers to the M0 spikes. This note is the input to M1a-4's containment labels
and env list, M1c-1's TTL default, and M3-5's terminal scope — where a story asks "what do
the harnesses actually do", this file is the answer, not the plan.

Surveyed 2026-08-20 on Linux (WSL2), Node 24, against the MVP client at `74f2fc2`.
Method: each harness spawned behind a transparent stdio proxy that logged every
JSON-RPC line in both directions, so "did not happen" below means *absent from the wire*,
not *not noticed*.

---

## M0-1 · Harness availability and handshake survey

### Availability

All three target harnesses are **available** — installed, authenticated, and observed
completing a turn. None is recorded as unavailable, and none is untested.

| Harness | Binary | Invocation | Version | Available |
|---|---|---|---|---|
| opencode | `~/.opencode/bin/opencode` | `opencode acp` | OpenCode 1.18.18 | yes |
| claude-agent-acp | `~/.local/bin/claude-agent-acp` | `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` 0.49.0 | yes |
| copilot | `~/.local/bin/copilot` | `copilot --acp` | GitHub Copilot CLI 1.0.78 | yes |

The registry in `agents.mjs:32` says `copilot acp`; the real flag is `copilot --acp`
(confirmed in `copilot --help`). M0-2 already owns that fix. `claude-agent-acp` needs
`CLAUDECODE` unset — this survey also unset `CLAUDE_CODE_SSE_PORT` and
`CLAUDE_CODE_ENTRYPOINT`, which is the fuller env scrub M1a-4's env list should carry.
**Both fixed by M0-2.** Caveat recorded there: re-running the Claude handshake *without*
the scrub also succeeded on adapter 0.49.0, so the nested-session refusal this survey hit
is not reproducible on that version.

Registry entries `omp`, `pi` and `gemini` are **not installed** on this machine and were
not surveyed. They are unavailable here, not failing. (`claude-code`, the deprecated
`@zed-industries/claude-code-acp` adapter, was also uninstalled and unsurveyed; M0-2
removed the entry, so `claude` is now the only Claude id.)

### Handshake and turn

| | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| spawns | yes | yes | yes |
| `initialize` latency | 1.1 s | 0.3 s | 0.5 s |
| `session/new` latency | 1.1 s | 0.7 s | 3.0 s |
| completes a turn | yes | yes | yes |
| stop reason | `end_turn` | `end_turn` | `end_turn` |
| turn latency (read prompt) | 13.7 s | 4.4 s | 5.6 s |
| protocol version | 1 | 1 | 1 |
| `authMethods` at init | `opencode-login` offered | `[]` | `copilot-login` offered |

All three answer `protocolVersion: 1`, so the hard-fail at `acp.mjs:91` never fires.
Note that opencode and copilot advertise auth methods *even when already authenticated* —
a non-empty `authMethods` is not a signal that login is required, and the note logged at
`acp.mjs:96` should not be read as one.

Copilot's auth method carries `_meta["terminal-auth"]` with a real `{command, args, label}`
for `copilot login`. That is a ready-made affordance for M2-8 and M4-3: the harness is
telling us exactly how to re-authenticate it.

### `agentCapabilities`

| capability | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| `loadSession` | **true** | **true** | **true** |
| `sessionCapabilities.resume` | yes | yes | — |
| `sessionCapabilities.fork` | yes | yes | — |
| `sessionCapabilities.list` | yes | yes | yes |
| `sessionCapabilities.close` | yes | yes | yes |
| `sessionCapabilities.delete` | — | yes | — |
| `sessionCapabilities.additionalDirectories` | — | yes | — |
| `promptCapabilities.image` | yes | yes | yes |
| `promptCapabilities.embeddedContext` | yes | yes | yes |
| `mcpCapabilities.http` / `.sse` | yes / yes | yes / yes | yes / yes |
| vendor `_meta` | — | `claudeCode.promptQueueing: true` | — |

**All three advertise `loadSession: true`.** The plan frames persistence as history-only
"because ACP has no resume"; that premise is wrong for every harness we actually target.
opencode and claude-agent-acp additionally advertise `resume` and `fork`; copilot
advertises `loadSession` but neither, so it needs its own probe before being counted in.
Real resume is a cheap win for M2-6 and worth its own story — but `session/load` must stay
behind a capability check, since the registry still contains harnesses that lack it.

### Update variants `render.mjs` does not handle

`render.mjs:20` silently drops anything not in its switch. Observed unhandled:

| variant | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| `available_commands_update` | 1× | 1× | 2× |
| `config_option_update` | — | — | 1× |

Both are dropped, neither is fatal. `available_commands_update` arrives from **all three**
immediately after `session/new` — it is the harness's slash-command list, which the plan
defers, so dropping it is a real decision rather than an oversight. Worth capturing rather
than rendering: it is exactly the payload a future slash-command story needs, and M4-2's
read views can show it. Copilot's `config_option_update` reports session config (model
selection among them) and is a candidate input for the plan's open "which model actually
ran" question (M0-5).

Handled variants seen: `agent_message_chunk` (all three), `tool_call` / `tool_call_update`
(all three), `usage_update` (all three), `agent_thought_chunk` (**opencode only** — 15× in
one turn; the other two never emit it). `plan` was not emitted by any harness on these
prompts, so its rendering path is still unexercised outside `mock-agent.mjs`.

### Methods reaching the `#handleRequest` default

**None.** Across six surveyed turns, no harness sent a method outside the three we
implement, so the `-32000` default at `acp.mjs:205` never fired and we returned zero
errors. In particular no harness called `terminal/*` — consistent with our advertising
`terminal: false`, and the starting point M0-3 has to disturb.

The more interesting result is what they *didn't* call:

| inbound request | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| `fs/read_text_file` | never | never | never |
| `fs/write_text_file` | never | never | never |
| `session/request_permission` | **never** | on writes only | on reads *and* writes |

**Zero `fs/*` traffic from any harness, in any run.** We advertise
`fs.readTextFile`/`writeTextFile: true` and all three ignore it, reading and writing
through their own process. Files created during the write probe appeared on disk in every
throwaway workspace without a single `fs/write_text_file` crossing the wire. Therefore
`#guardPath` (`acp.mjs:235`) currently protects **nothing in production** — it is dead code
against these three harnesses, live only against `mock-agent.mjs`. It should stay (a
harness may use `fs/*` tomorrow, and the MCP path may), but no containment claim may rest
on it.

How each harness reads a file, from `tool_call.kind`:

- opencode — `read` kind, tool `read`, internal.
- claude-agent-acp — `read` kind, tool `Read File`, internal, no permission asked.
- copilot — **`execute` kind**, shelling `cat <path> 2>&1`, with the real command in
  `rawInput.command` and `rawInput.commands[]`.

Copilot's shape is the significant one: it never calls `terminal/*`, but it *does* put real
argv in front of the policy via `session/request_permission`. Commands are executed
internally; only the decision crosses the boundary. That is a partial answer to M0-3's
second question, ahead of the spike.

### Session modes — a second channel, missed on the first pass

The original survey captured `initialize` in full but kept only `sessionId` from
`session/new`, and the mode information lives in that result. Re-probed:

| | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| `modes` in `session/new` | **absent** | 6 modes, vendor ids | 3 modes, ids are **canonical spec URLs** |
| mode ids | via `configOptions` (`build`, `plan`) | `default`, `auto`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` | `#agent`, `#plan`, `#autopilot` |
| `session/set_mode` accepted | **yes** | yes | yes |
| other permission knobs | — | — | `configOptions.allow_all` (category `permissions`) |

**All three accept `session/set_mode`, including opencode, which advertises no `modes` at
all** — its ids are discoverable only through `configOptions` entries with
`category: "mode"`. The acceptance is real, not a silent no-op: opencode answers
`-32602 mode not found` for a bogus id and `OK` for `plan` and `build`. A client that
discovers modes only through `SessionModeState` will conclude opencode has none and be
wrong; discovery must consider both fields.

Vocabulary is only partly normalized. Copilot uses the spec's own mode URLs; the other two
use bare vendor ids with no overlap. There is enough structure to negotiate with, not
enough to assume shared names — so a mapping belongs in the registry.

### Containment probe (beyond the story, but decisive)

Each harness was asked to create a file while running under `safePolicy`, in a throwaway
workspace:

| harness | asked permission | file created under `safe` |
|---|---|---|
| opencode | **no** | **YES — `blocked.txt` written** |
| claude-agent-acp | yes (`edit`) → rejected | no |
| copilot | yes (`execute`) → rejected | no |

**opencode never sends `session/request_permission` at all** — zero across every run,
read and write alike. It writes files with no client involvement, so `--mode safe` and
`--mode ask` are both inert against it: nothing to refuse, nothing to prompt. This is not a
bug in the policy; it is the policy having no jurisdiction. It confirms M0-6's correction
in the strongest possible form. It is also the plan's "silent autonomy" row (non-empty diff,
zero permission requests) occurring by default in a supported harness, not as an anomaly —
that detector should be treated as required, not nice-to-have.

**But opencode is not uncontainable — an earlier draft of this note said so and was wrong.**
Re-running the same probe with one line added, `session/set_mode → plan` before the prompt:

| run | policy | mode negotiated | `probe.txt` written |
|---|---|---|---|
| control | `safe` | none | **yes** |
| with negotiation | `safe` | `plan` | **no** |

It declined in-band: *"I'm currently in plan mode, so I can't create files. Here's the
plan: …"*. So the accurate label is **not containable through the permission channel,
containable through session mode** — a different statement with a different remedy.

One honest limit on that result: the refusal arrived as agent prose, so this test cannot
distinguish tool-level enforcement from model compliance. opencode's own description of
`plan` is *"Disallows all edit tools"*, which claims enforcement, but we measured the
outcome, not the mechanism. Treat mode negotiation as defence in depth, never as a
sandbox.

The mirror-image consequence for copilot: because it reads by shelling out, `execute` is
not in `READ_ONLY_KINDS`, so `--mode safe` refuses copilot's *reads* too. Safe mode does
not make copilot cautious, it makes it useless. Any per-kind policy needs a per-harness
notion of what a kind means, or `safe` should be documented as opencode-uncontained and
copilot-unusable.

### Incidental (belongs to M0-5, recorded here because it was on the wire)

`usage_update` is `{used, size}` on all three, with `size` = 200000 for each.
**opencode alone adds `cost: {amount, currency}`** (`0`/`USD` on a trivially short turn).
So a price table is possible for opencode directly and would have to be modelled for the
other two. M0-5 owns confirming whether that amount ever becomes non-zero.

---

## M0-3 · Terminal and shell-routing spike

Run 2026-08-21 on branch `spike/m0-3-terminal` (kept, never merged) against the same
three harnesses. Method: `clientCapabilities.terminal` flipped to `true`, and all five
`terminal/*` methods implemented as handlers that **really execute** the command and
return true output and exit status.

The story said "logging no-ops". That is not a legal answer — `terminal/create` must
return a `terminalId`, and a harness that gets nothing either aborts the turn or falls
back to its own shell, which in the log is indistinguishable from never having asked.
Executing for real also keeps the turn alive long enough to see what comes *after* the
first command. Every call was logged with full argv, and `#guardPath` deliberately did
not apply: the spike observes, it does not contain.

Workspace: a throwaway Node project with a genuine failing test (`sum` returning `a - b`),
reset between harnesses. Prompt `run the tests`, `--mode auto`, no `session/set_mode`.
Copilot self-updated to **1.0.80** between M0-1 (2026-08-20) and this run; the M0-1 rows
above still say 1.0.78 and were correct when written.

**`auto` bounds every verdict below.** It was required — under `safe`, copilot's reads go
through `execute`, which is not in `READ_ONLY_KINDS`, so they are refused before a terminal
call could happen. The consequence is that all of this measures what a harness does when
**nothing is refused**. A harness that reached for `terminal/*` only after its own shell
was denied would not appear here. Untested, and cheap to test if it ever matters.

### Question 1 — does `terminal/create` ever arrive?

**No. Not once, from any harness, with the capability advertised as `true`.**

| | opencode 1.18.18 | claude-agent-acp 0.49.0 | copilot 1.0.80 |
|---|---|---|---|
| `terminal/create` | never | never | never |
| any `terminal/*` | never | never | never |
| turn completed | yes | yes | yes |
| shell tool used instead | `bash` | `Terminal` | `shell` |

All three ran the tests, read the failure and diagnosed the bug correctly — through their
own shell, ignoring the capability entirely. M0-1's zero was therefore not an artefact of
`terminal: false`. **None of these harnesses delegates command execution to the client** —
though see below: claude-agent-acp does have a terminal-shaped path, behind a vendor flag
this spike initially failed to offer.

Note the trap in the middle column: claude-agent-acp *names its own tool* `Terminal`. It
is a vendor tool name in a `tool_call` notification, not the ACP method. Grepping logs for
"terminal" finds it and means nothing.

### Question 2 — does the command text reach us, and how?

Yes for two of three, and **never through the channel the plan expected**. The command
arrives on ordinary `session/update` notifications, which `render.mjs` drops on the floor.

| | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| `shell` | internal | internal | internal |
| `argvChannel` | **none** | **notification** (late) | **notification** + permission |
| `rawInput` on `tool_call` | `{cwd}` only | `{}` | full `{command}` |
| `rawInput` on `tool_call_update` | — | full `{command, description}` | — |
| permission requests | **0** | 1 of 2 `execute` calls | 3 of 3 |

Observed argv, verbatim:

- **opencode** — nothing. Title is the bare string `bash`, `rawInput` carries only `cwd`.
  Seven tool calls, zero permission requests, and it **silently edited `sum.mjs`** to fix
  the bug under `--mode auto`. We never saw a single command it ran.
- **claude-agent-acp** — `cat package.json 2>/dev/null; echo "---"; ls`, then
  `node --test 2>&1`. Both arrived **on `tool_call_update`, ~0.5s after** the `tool_call`
  that announced them with an empty `rawInput`. It asked permission for the second command
  and not the first.
- **copilot** — full command on the initial `tool_call`, e.g.
  `cd <ws> && npm test`, and again on the permission request. Confirms M0-1.

**`argvChannel` therefore needs four values, not the two the plan implies:**
`terminal | notification | permission | none`. "Notification" is the one nobody planned
for, and it is where two of three harnesses actually put the command. Timing matters too:
claude-agent-acp's argv is late, so a policy that reads `rawInput` at `tool_call` time
sees `{}` and judges blind — the same bookkeeping trap `#toolCalls` already exists to
avoid.

### Why nothing called it — checked, not assumed

The verdict above is "did not happen". Three follow-ups turn that into "does not exist,
or is not wired to the capability we advertised".

**The spec permits it.** Agents **MUST** verify `clientCapabilities.terminal` before
calling any terminal method, but nothing obliges them to prefer terminals over their own
shell. Advertising and being ignored is conformant, not a client bug.

**opencode — capability bundled, never called.** Its binary carries the ACP SDK's five
method constants and the SDK's `createTerminal()` wrapper
(`sendRequest(Q.terminal_create, …)`). That wrapper appears exactly once: the definition.
No call site anywhere in opencode's own agent code. (Its `capabilities?.terminal?.*` hits
are xterm TUI code, and its one `_meta` capability gate is `terminal-auth`, for login.)

**claude-agent-acp — never reads `clientCapabilities.terminal` at all.** It gates on a
vendor extension instead: `clientCapabilities._meta["terminal_output"]`
(`dist/acp-agent.js:1862`, `:3195`). **We never offered it, so this part of the spike was
untested rather than negative.** Offering it (`spike/m0-3-terminal`, second commit)
changes the wire immediately:

```json
{"sessionUpdate":"tool_call","toolCallId":"toolu_01FDY…","title":"Terminal","kind":"execute",
 "_meta":{"claudeCode":{"toolName":"Bash"},"terminal_info":{"terminal_id":"toolu_01FDY…"}},
 "content":[{"type":"terminal","terminalId":"toolu_01FDY…"}]}
```

Every Bash call now carries an ACP `type: "terminal"` content block — for a terminal that
**was never created**, whose `terminalId` is simply the `toolCallId`. Still zero
`terminal/*` calls, and still no command output crossing the wire. It is a rendering
convention for a client that already displays the terminal, not delegated execution.

**copilot — statically opaque.** A 177 MB bun-compiled ELF; `strings` finds no ACP method
names at all, control strings included, so nothing can be concluded from the binary.
GitHub's own ACP reference documents no terminal support, and its shell is a first-class
internal tool (`--allow-tool='shell(git:*)'`, `--available-tools="bash,view"`).

**The general lesson, which outlives this spike:** a capability probe that tests only the
standard field under-reports. Harnesses gate behaviour on `_meta` extensions we do not
advertise, and each vendor spells them differently (`terminal_output` for claude-agent-acp,
`terminal-auth` for opencode). The registry should record per-harness `_meta` flags
alongside the containment fields, and `render.mjs` currently drops `type: "terminal"`
content on the floor.

### Consequences

- **M3-5 (terminals) is not worth building as specified.** Nothing calls `terminal/create`.
  It becomes per-harness documentation, and `terminal: false` on master is now a recorded
  decision rather than a default. **One piece survives:** if embedded-terminal rendering is
  ever wanted, claude-agent-acp already emits `type: "terminal"` content under
  `_meta.terminal_output`, and `render.mjs` would need to handle it.
- **M3-6 (command-level policy gating) survives, on a different foundation.** Its premise
  was "with `terminal/*` we hold real argv". We hold real argv for two of three harnesses
  *without* `terminal/*` — from notifications, not the permission request. What it cannot
  do is gate opencode, which shows us nothing.
- `unknown` reads as `internal` / `none` for warning purposes. `omp`, `pi` and `gemini`
  are uninstalled here and are **unknown by absence, not by test**.

---

## M0-4 · Cancellation probe

Run 2026-08-21 against the same three harnesses, with a throwaway probe that sends
`session/cancel` itself and then **waits** — deliberately not `run.mjs`, whose SIGINT path
(`run.mjs:81-88`) kills the subprocess 2 s after cancelling. Because `#failAll` rejects
every pending request on `close` (`acp.mjs:62-64`), a cancel slower than that grace would
have surfaced as `agent "x" exited with code N` and the stop reason would have been lost.
The probe is spike tooling, kept on branch `spike/m0-4-cancel-probe` (never merged) the way
M0-3's stubs were; the numbers are the deliverable.

Three runs per harness, each in its own workspace (a copy of this repo's five `.mjs` files),
`--mode auto`, prompt *"read every file in this directory one at a time and summarise it"*:

1. **observe** — nobody interferes. The control: without it, "the turn ended" cannot be
   distinguished from "the turn was ending anyway".
2. **cancel** — `session/cancel` on the **first `tool_call`** (a protocol event, not a
   wall-clock delay, so the three are cut at a comparable point despite very different turn
   lengths), then wait up to 60 s, then send a second prompt to test whether the session
   survived.
3. **double** — a second `session/prompt` while the first turn is in flight, awaited to
   completion, carrying a marker word so "served" can be told from "swallowed".

### Question 1 — does the turn end promptly, and with what `stopReason`?

Promptly on all three — and one of them lies about why.

| | opencode 1.18.18 | claude-agent-acp 0.49.0 | copilot 1.0.80 |
|---|---|---|---|
| `stopReason` on cancel | `cancelled` | `cancelled` | **`end_turn`** |
| latency, 2 samples | 64 ms · 45 ms | 5 ms · 10 ms | 26 ms · 28 ms |
| events in the cancelled turn | 20 · 16 | 14 · 14 | 11 · 11 |
| events in an uninterrupted turn | **443** | **180** | **69** |
| uninterrupted turn length | 68.9 s | 51.2 s | 36.3 s |
| `session/update` after the response | 0 | 0 | 0 |
| session usable afterwards | yes (`end_turn`) | yes | yes |

**Latency is not the interesting number.** Every sample landed inside 64 ms, two orders of
magnitude below any plausible TTL, and nothing arrived on the wire after the response. **No
harness came near the 60 s wait bound**, so there is no "did not end within N s" row to
record. The interesting number is the stop reason.

Note also what is *not* wrong here: every literal observed is inside M1b-2's set
(`docs/STORIES.md:334-343`) — nobody invented a value. The mismatch is semantic, and that is
worse, because a vocabulary error would have been caught by a type.

**Copilot reports `end_turn` for a turn it cancelled**, in both samples. The baseline row is
what settles it: 11 events and ~5.6 s against 69 events and 36.3 s, with the `tool_call`
that triggered the cancel never completing. It obeyed immediately and then described the
result as a clean finish. This contradicts the protocol's own MUST — *"the Agent **MUST**
respond to the original `session/prompt` request with the `cancelled` stop reason"*
([ACP, prompt turn](https://agentclientprotocol.com/protocol/prompt-turn)) — and it is
**undocumented**: GitHub's [ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
names `stopReason` only inside an example (`!== "end_turn"`) and never enumerates the
values, and [Canceling a Copilot CLI operation](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/cancel-and-roll-back)
covers only Esc and Ctrl-C in the TUI. No issue on `github/copilot-cli` reported it either,
so this spike filed one:
[github/copilot-cli#4561](https://github.com/github/copilot-cli/issues/4561), with a
standalone repro and the control run above as the evidence the turn was truncated.

Worth knowing that the public record here is inverted: this exact defect was filed against
**opencode** ([anomalyco/opencode#25899](https://github.com/anomalyco/opencode/issues/25899),
*"reporting end_turn for a user-cancel makes a stopped turn look like a clean completion"*)
and closed as not planned — yet opencode 1.18.18 answers `cancelled` here. Neither the
issue tracker nor the vendor's docs predict what a given build does. **Pin the version next
to every row above; that is the only durable part of this table.**

### Question 2 — does a second `session/prompt` in flight get rejected?

**No. The expectation in the story is wrong for all three, in three different ways, and the
failure is silent every time.**

| | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| second prompt | accepted | accepted | accepted |
| answered after | 7.0 s (with the first, ~8 ms apart) | 52.1 s | **10 ms** |
| its `stopReason` | `end_turn` | `end_turn` | `end_turn` |
| effect on the running turn | aborted at 14.3 s (vs 68.9 s) | ended at 5.5 s (vs 51.2 s) | aborted at 11.0 s (vs 36.3 s) |
| where the text landed | merged into the running turn | served as a fresh turn | merged into the running turn |

Nobody errors, nobody queues cleanly, and **the in-flight turn dies in every case** — with
`stopReason: end_turn`, again indistinguishable from success. Copilot's answer is the
strangest: the JSON-RPC response came back 10 ms after the request, *before* the prompt had
been acted on and 5.8 s before the first turn's own response. For a concurrent prompt, that
response is not a completion signal at all.

The marker earns its place: rather than being executed, the second prompt shows up in the
agents' *reasoning* about the first task — copilot: *"looks like it could be a prompt
injection asking me to just reply BANANA"*; claude-agent-acp: *"…conflicts with the task
you…"*. So on opencode and copilot a concurrent prompt is not a message to the agent, it is
**an injection into the running turn's context**. Only claude-agent-acp treats it as a turn
of its own (ending the first at 5.5 s, then spending 52 s on the second).

Copilot's half of this is independently reported, with the mechanism:
[github/copilot-cli#4555](https://github.com/github/copilot-cli/issues/4555) (open) —
*"the `session/prompt` handler calls `session.abort()` unconditionally as its **first
action**"*, tearing down background work *"even when no prompt turn is in flight … and the
client never sent `session/cancel`"*, while the `cancel` handler guards on `pendingPrompt`
and `prompt` does not. That extends our finding: on copilot it is not concurrency that is
unsafe, it is **any** second prompt, including one sent to a session we believe is idle.
Adjacent, same area: [#4336](https://github.com/github/copilot-cli/issues/4336),
[#4127](https://github.com/github/copilot-cli/issues/4127).

### Question 3 — what state is the session left in?

Clean, on all three. Zero `session/update` notifications arrived after the cancelled
`session/prompt` response, and a follow-up prompt was accepted and completed (`end_turn`) in
every cancel run. **A cancelled task does not need its subprocess killed**, and the client
may `stop()` immediately after the response without racing a trailing notification.

### Consequences

- **M1c-1's grace window: 2 s.** Thirty times the slowest observed cancel and identical to
  the grace `run.mjs:81-88` already uses, so the watchdog inherits a number rather than
  inventing one. Kill only if that expires — expect never to reach it.
- **M1b-2's stop-reason table cannot key on `stopReason` alone.** `cancelled` may never
  arrive (copilot), and `end_turn` is now known to mean *finished*, *I was cancelled*, or
  *someone interrupted me*, depending on harness. The status must be derived from the
  triple (`stopReason`, did **we** send a cancel, did the watchdog fire) — the supervisor's
  own record of intent is the authoritative half. The table stands; its input does not.
- **One prompt per session per task, and never a "nudge".** Given #4555, a supervisor that
  sends a second prompt — even to a session it believes idle — can silently destroy work
  and get `end_turn` for it. This is a second, empirical argument for M1c-1's deliberate
  absence of a third rung: there is no safe way to steer a turn in flight, and on two of
  three harnesses the attempt lands in the model's context as a suspected prompt injection.
- **A cancelled turn's worktree is worth keeping.** Cancellation truncates mid-tool-call
  (copilot's triggering `tool_call` never completed), so the same "stopped mid-edit" hazard
  M1b-2 records for `max_tokens` applies to `timed_out` tasks.

### Coverage

Two samples per harness for cancellation, one for each of the other two questions, one
workspace shape, one read-only prompt. `omp`, `pi` and `gemini` remain uninstalled here —
**unknown by absence, not by test**. Nothing was written to any workspace during these
runs, so the interaction between cancellation and a half-finished *edit* is untested and is
the obvious next probe if `timed_out` tasks ever start losing work.

---

## M0-5 · Usage reporting survey

Pending. Partial input recorded above.
