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

Registry entries `omp`, `pi`, `gemini` and `claude-code` are **not installed** on this
machine and were not surveyed. They are unavailable here, not failing.

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

Pending. Partial input already recorded above: no harness called `terminal/*` under
`terminal: false`, and copilot surfaces real argv through `session/request_permission`
while executing internally.

## M0-4 · Cancellation probe

Pending.

## M0-5 · Usage reporting survey

Pending. Partial input recorded above.
