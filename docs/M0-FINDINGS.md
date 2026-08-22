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

Run 2026-08-22 on branch `spike/m0-5-usage-probe` (kept, never merged) against the same
three harnesses. Method: `usage-probe.mjs` drives **one session of three prompts** — turn 1
long and multi-tool (read five files, write `NOTES.md`, read it back and append to it),
turns 2 and 3 trivial (`Reply with the single word OK`) — and logs every `session/update`
verbatim, `_meta` and unknown top-level fields included. `wire-tap.mjs` tees the whole
JSON-RPC wire in both directions, because `AcpAgent` forwards only `session/update` to
`onEvent` (`acp.mjs:211-212`) and `prompt()` returns `res.stopReason` and throws the rest of
the response away (`acp.mjs:120`) — which is exactly where the per-turn token count turned
out to live. `--mode auto`, no `session/set_mode`. Workspace: a throwaway five-file JS
project, reset per harness.

M0-1's incidental note (§M0-1, "Incidental") said `{used, size}` with `size` = 200000
everywhere and `cost` on opencode alone. **Both halves are corrected below**, and the
sample that produced them was a turn too short to bill.

### Samples

| | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| version | 1.18.18 | 0.49.0 (SDK schema 0.28.1) | 1.0.80 |
| auth mode | opencode-login (Zen) + a DeepSeek API key | OAuth subscription (no `ANTHROPIC_API_KEY` in env) | GitHub Copilot subscription |
| model it ran | `opencode/big-pickle`, and `deepseek/deepseek-chat` in a second run | `opus` (Opus 4.8), and `haiku` in a second run | `claude-sonnet-5`, and `claude-haiku-4.5` in a second run |
| who chose it | harness default / our `session/set_config_option` | same | same |
| turn-1 wall clock | 231 s | 40 s | 17 s |

Every model above is **self-reported by the harness** — see "All three name the model", below.

### Does `usage_update` arrive, and what is in it

**Yes, from all three**, and only on `session/update`. Across six sessions no usage figure
appeared on any other notification or on any request; the only other carrier is the
`session/prompt` **response** (next section).

| | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| `usage_update` per turn | **1**, at end of turn | **many** (23 on turn 1), streamed | **many** (5 on turn 1), streamed |
| `used` | yes | yes | yes |
| `size` | yes | yes | yes |
| `cost` | **on every one** | **on the last one of each turn only** | **never** |
| `_meta` | never observed | never observed (but see below) | never observed |

`used` is context occupancy and a **snapshot**, as the story assumed and the spec says
("Tokens currently in context"). It climbs with the transcript and never resets: opencode
10888 → 11063 → 11093, claude 11293 → … → 15647, copilot 13945 → … → 17197 over the same
three turns. A trivial turn 3 does not drop it back, so it is not a per-turn count.

**`size` is not a constant, and on claude it is wrong until the first turn ends.** M0-1's
200000-everywhere reading was an artefact of one short sample:

| model | reported `size` |
|---|---|
| `opencode/big-pickle` | 200000 |
| `deepseek/deepseek-chat` | 1000000 |
| claude `opus` | **200000 mid-turn, 1000000 on the turn's final update** |
| claude `haiku` | 200000 throughout |
| copilot `claude-sonnet-5` | 200000 |
| copilot `claude-haiku-4.5` | 136000 |

The claude flip is not a glitch, it is a warm-up: the adapter carries
`session.contextWindowSize`, defaulted to 200k and **learned from the SDK's `modelUsage`
only when the turn's `result` message arrives** (`acp-agent.js:1068-1078`, whose own comment
notes that a miss would "leave the next prompt's mid-stream updates reporting 200k"). So
`size - used` — the "remaining context" the RFD invites clients to compute — is
**understated by 5× for the whole of a session's first turn** on claude with a 1M model.
Anything that watches remaining context to decide when to stop feeding a task must ignore
`size` until it has seen an end-of-turn value.

### Cost: opencode's `0` was "not billed", not "always `0`"

This is the question M0-1 left open, and it needed the second run rather than a longer one.

| harness / model | auth | `cost.amount` after a real turn |
|---|---|---|
| opencode `opencode/big-pickle` | opencode Zen subscription | `0` — and still `0` after 231 s and 155 updates |
| opencode `deepseek/deepseek-chat` | DeepSeek API key | **`0.0017770984` USD**, → `0.0018118688` after one trivial turn |
| claude-agent-acp `opus` | OAuth subscription | **`0.2328715` USD**, → `0.2436225` → `0.2517525` |
| copilot | Copilot subscription | field absent entirely |

So opencode's `cost` is a **live, correct, cumulative session total** that reads `0` because
the provider in effect is not metered per token — exactly the distinction the story asked
for, and one no amount of extra work on a single provider would have settled.

Two cautions on the claude figure. It is the Claude Agent SDK's `total_cost_usd` passed
straight through (`acp-agent.js:1079-1095`); under OAuth subscription auth **nobody is
invoiced that amount** — it is the SDK's list-price valuation of the tokens, not spend.
And the model list this adapter offers describes some entries as "Draws from usage credits"
(`sonnet[1m]`, Fable), so the same number means different things per entry. Treat it as
"what these tokens would have cost at list price", which is still the right input for a
budget guard and the wrong one for an invoice.

`cost.amount` is **cumulative for the session** on both harnesses that send it (the schema
says so, and both series above are monotone), so a per-task figure is a subtraction across
the task's first and last `usage_update`, never a sum of them.

### The per-task token count has a source — and we currently discard it

Gap 3 in the pickup comment asked whether `TaskResult.tokens` has a source at all. It does,
on **all three harnesses**, and it is not `usage_update`: it is `usage` on the
`session/prompt` response.

| field (turn 1) | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| `inputTokens` | 264 | 2704 | 100678 |
| `outputTokens` | 146 | 2595 | 1689 |
| `thoughtTokens` | 17 | — | 12 |
| `cachedReadTokens` | 10624 | 129785 | 78733 |
| `cachedWriteTokens` | — | 8895 | 21598 |
| `totalTokens` | 11051 | 143979 | 102367 |

**Three harnesses, two meanings.** On opencode and claude-agent-acp the numbers are
**per turn** — `inputTokens` falls 264 → 183 → 85 (opencode) and 2704 → 2 → 2 (claude) as
the turns get trivial, which a cumulative counter cannot do. On copilot they are
**cumulative for the session**: 100678 → 122487 → 144401 input, with `outputTokens` ticking
1689 → 1693 → 1697 for two one-word replies. The composition differs too: copilot's
`cachedRead + cachedWrite` ≈ `inputTokens` (cache is *inside* input, and `totalTokens` =
input + output), while opencode and claude add all four components to reach `totalTokens`.

The consequence for M1b-4 is concrete: `tokens` must be recorded **per harness with its
semantics tagged**, a supervisor must **subtract, not sum, on copilot**, and `totalTokens`
is not comparable across vendors — which is the plan's existing "never summed" rule
(`STORIES.md:334`) arriving with a second, sharper reason.

Two spec notes on this field. It is **`UNSTABLE`** in the schema shipped with the SDK
("not part of the spec yet, and may be removed or changed at any point"), and the published
prompt-turn docs still describe the response as carrying `stopReason` alone — so all three
harnesses are ahead of the documentation here, and a client that depends on it is depending
on an unversioned extension. And the schema's own field descriptions ("Sum of all token
types across session", "Total input tokens across all turns") describe the *cumulative*
reading, so **copilot is the one implementing it as written** and the other two are the
useful outliers. Nothing in the schema says whether cached tokens are included in
`inputTokens`; the three harnesses answer that differently, and it will bite whoever prices
them.

Our client cannot see any of this today: `AcpAgent.prompt()` returns `res.stopReason`
(`acp.mjs:120`) and drops the rest of the response. Making `usage` reachable is a
one-line change in `prompt()` and belongs to M1b-4, not here.

### All three name the model they ran

The plan's "nothing reports that today" is **false, and was already false when written**.
Every harness reports its current model in the `session/new` response, in the spec's own
`configOptions` shape, with the reserved `category: "model"` — so it is machine-readable
without string-matching:

| | opencode | claude-agent-acp | copilot |
|---|---|---|---|
| `configOptions` on `session/new` | yes | yes | yes |
| `id: "model"`, `category: "model"` | yes | yes | yes |
| `currentValue` observed | `opencode/big-pickle` | `opus` | `claude-sonnet-5` |
| resolvable to a real model? | **yes** — provider-qualified | **no** — an alias; the display text says "Opus 4.8" | **yes** — `claude-sonnet-5`, `gpt-5.4`, … |
| `config_option_update` notification | never | never | **1×**, just after `session/new` |
| accepts `session/set_config_option` | **yes** | **yes** | **yes** |
| re-emits `config_option_update` after we set it | no | no | **no** |

So M0-1's lead — copilot's `config_option_update` — is real but is the *weakest* of the
three channels: it repeats what `session/new` already said, and it did **not** fire again
when we changed the model mid-session. The reliable pattern is: read `configOptions` from
the `session/new` response, and treat the `session/set_config_option` **response** (which
returns the full option set) as the update channel, since none of the three notifies.

Model switching works on all three and takes effect immediately — the proof is `size`
moving with it (copilot 200000 → 136000 for haiku; opencode 200000 → 1000000 for deepseek).

Two extras worth keeping:

- **copilot ships a price table of its own.** Each model option carries
  `_meta: {copilotUsage, copilotPriceCategory, copilotEnablement}` — `"1x"` for
  `claude-sonnet-5`, `"15x"` for `claude-opus-5`, `"0.33x"` for `claude-haiku-4.5`, `"0x"`
  for `gpt-5-mini`. That is a premium-request multiplier, not currency: copilot's spend is
  denominated in requests, and no token count converts to it.
- **claude's `currentValue` needs a mapping table.** `opus` is an alias, and the only place
  the concrete model appears is the human-readable `description` ("Opus 4.8 · Best for
  everyday, complex tasks"). Parsing prose for a billing key is exactly the "confidently
  wrong dollar figure" the plan warns about — for claude, prefer its self-reported `cost`
  over pricing its tokens ourselves.

### Verdict on the price table

**A per-harness price table is possible but is no longer the cheapest route to a cost
figure: opencode and claude-agent-acp already report cumulative USD themselves, and copilot
cannot be priced in currency at all — it meters premium requests, not tokens — so the
useful work is recording each harness's self-reported unit, not converting tokens.**

The backlog trigger (`STORIES.md:746-748`, "any harness names the model it selected") has
**fired — all three do**. It is recorded as fired and left unscheduled, with the scope
changed by this survey: what M4-2 should show is a `cost` in USD for two harnesses and a
premium-request multiplier for copilot, not one table pricing tokens for all three.

### Surprises, and what the spec says about them

Cross-checked against the ACP JSON schema shipped in `@agentclientprotocol/sdk` 0.28.1
(vendored under the claude adapter) and the published docs and RFD.

1. **`PromptResponse.usage` is not in the docs.** The prompt-turn page still says the
   response carries `stopReason`; the schema carries `usage`, marked `UNSTABLE`. All three
   harnesses populate it. Real, useful, and unversioned — pin the behaviour with a
   `mock-agent.mjs` case rather than trusting it.
2. **The same field means two different things across harnesses** (per-turn vs cumulative),
   and the spec's wording endorses the reading only copilot implements. This is the finding
   most likely to produce a wrong number quietly.
3. **copilot answers `session/new` with a `models` object** —
   `{availableModels, currentModelId: "claude-sonnet-5"}` — that **does not exist in
   `NewSessionResponse` in schema 0.28.1** (there is no `SessionModelState` definition left).
   It is a superseded field kept alive alongside the `configOptions` that replaced it.
   Harmless, but do not build on it; it is the half that will disappear.
4. **copilot uses documentation URLs as config value ids** —
   `currentValue: "https://agentclientprotocol.com/protocol/session-modes#agent"`. Legal
   (ids are opaque strings) and stable, but any code comparing mode ids across harnesses
   must not assume short tokens.
5. **claude-agent-acp has two vendor `_meta` extensions on `usage_update` that we never
   saw**: `_claude/origin` on the end-of-turn update when a result has an origin, and
   `_claude/rateLimit` carrying `rate_limit_info` on a `rate_limit_event`
   (`acp-agent.js:1084-1095`, `:1512-1524`). The second is a rate-limit signal delivered on
   a channel `render.mjs` currently reduces to "context N/M tokens". Worth catching before
   M1c's retry logic guesses at it.
6. **A stray `opencode.json` above the workspace kills the harness before `initialize`.**
   The first attempt at the DeepSeek run wrote its probe record to the parent of the
   workspace; opencode walks up from `cwd`, found the file, and exited 1 with
   *"Configuration is invalid … Expected object | undefined, got \"opencode acp\" command"* —
   surfacing to the client as the same opaque spawn failure `CLAUDE.md` already warns about.
   A supervisor that scatters per-task state files near a worktree can brick a harness this
   way; keep run state out of the workspace's ancestry.

### Coverage

Six sessions: one three-turn session per harness plus one two-turn re-run per harness with a
different model. One machine, one workspace shape, one prompt pair. **`omp`, `pi` and
`gemini` remain uninstalled here — unknown by absence, not by test**, and nothing in this
section should be read as covering them. Context compaction was never triggered, so the
behaviour of `used` across a compaction is untested — it is the one place the adapter source
says an approximation (`used: 0`) is emitted deliberately (`acp-agent.js:835-855`), and the
obvious next probe if a long-running task's context accounting ever matters.
