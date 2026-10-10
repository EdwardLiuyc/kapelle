# Findings

What the harnesses actually do, measured. It began as the answers to the M0 spikes, and
later measurements (pi-acp, M2-4's stop, multi-turn) join it here; it was
`M0-FINDINGS.md` until 2026-09-24. This note is the input to M1a-4's containment labels
and env list, M1c-1's TTL default, and M3-5's terminal scope — where a story asks "what do
the harnesses actually do", this file is the answer, not the plan.

All of it on Linux (WSL2), Node 24, one machine. Each section states its own date,
client commit and spike branch — they differ, and by enough to matter:

| section | run | client at | spike tooling |
| --- | --- | --- | --- |
| M0-1 | 2026-08-20 | `74f2fc2` | stdio proxy, not kept |
| M0-3 | 2026-08-21 | `1f5d9ff` + `terminal/*` stubs | `spike/m0-3-terminal` |
| M0-4 | 2026-08-21 | `ae6a885` | `spike/m0-4-cancel-probe` |
| M0-5 | 2026-08-22 | `97eeb1e` | `spike/m0-5-usage-probe` |
| M0-1 copilot re-verification | 2026-08-23 | `c4307f3` | `spike/m0-7-reverify` |
| M0-9 | 2026-09-27 | `04d6ac9` (run 1), `457bfb5` (run 2); same `protocol/` and `core/policy.ts` | `spike/m0-9-load-probe` (`load-probe.mjs`) |
| M6-7b | 2026-10-08 | `635a124` + the M6-7b working tree | `integration/daemon.itest.ts` |

Method throughout: each harness spawned behind a transparent stdio proxy that logged every
JSON-RPC line in both directions, so "did not happen" below means *absent from the wire*,
not *not noticed*.

---

## Roll-up — every harness, every question

**This table is an index, not the record.** Every cell compresses a section below, and the
sections win wherever they differ. It exists because the plan's M0 exit criterion
(`docs/PROJECT-PLAN.md`) asks its questions per harness, and until now the answers
were spread across four sections.

**Versions are part of every finding.** copilot's behaviour changed measurably between
1.0.78 and 1.0.80 in three days — see "What re-verification changed", below — so read each
column as a claim about that build, not about that harness.

| | opencode 1.18.18 | claude-agent-acp 0.49.0 | copilot 1.0.80 | measured in |
| --- | --- | --- | --- | --- |
| starts / completes a turn | yes / yes | yes / yes | yes / yes | §M0-1 |
| unhandled `session/update` | `available_commands_update` | `available_commands_update` | `available_commands_update`, `config_option_update` | §M0-1 |
| calls `fs/*` | never — so `#guardPath` binds nothing here | never | never | §M0-1 |
| `session/request_permission` | **never, ever** — the policy has no jurisdiction, and it wrote a file under `safe` | on writes; reads pass unasked | on shelled commands and writes; **file reads pass unasked** | §M0-1 |
| calls `terminal/create` | never, even when offered `true` | never, even when offered `true` | never, even when offered `true` | §M0-3 |
| where commands run | internal (`bash`) | internal (its tool is *named* `Terminal` — a vendor name, not the ACP method) | internal (`shell`) | §M0-3 |
| do we ever see argv | **no** — title is the bare string `bash`, `rawInput` carries only `cwd` | yes, but **late**: on `tool_call_update` ~0.5 s after the `tool_call`, which announces `{}` | yes, on the `tool_call` and again on the permission request | §M0-3 |
| `usage_update` cadence | **1, at end of turn** — no in-turn signal for a watchdog at all | ~23 per long turn | ~5 per long turn | §M0-5 |
| `used` | trustworthy occupancy, agrees with the harness's own count | trustworthy, but **`0` means *unknown*, not *empty*** (compaction fallback) | trustworthy | §M0-5 |
| `size` as a denominator | the only real per-model limit — and the one harness with no second opinion to check it against | **wrong for all of turn 1**: 200k for any window, a warm-up rather than a glitch | **wrong always**: 200000 matches neither its own 264k window nor the ~175k it leaves usable | §M0-5 |
| `cost` | on every update, cumulative USD; `0` meant an unmetered provider, not a dead field | on the last update of each turn, cumulative USD — **list price under OAuth, which nobody is invoiced** | absent entirely | §M0-5 |
| exhaustion warning | none — spend with nothing to compare it against | `_meta["_claude/rateLimit"]` — **read from adapter source, never observed firing**, and `render.mjs` drops `_meta` today | none | §M0-5 |
| `session/cancel` mid-turn | `cancelled`, 45–64 ms | `cancelled`, 5–10 ms | **`end_turn` for a turn it cancelled** — 26–28 ms, contrary to the spec's MUST | §M0-4 |
| second `session/prompt` in flight | accepted; kills the running turn; the text lands **in that turn's context**, read as injection | accepted; kills the running turn; served as a turn of its own | accepted; kills the running turn; **responds in 10 ms, before acting** | §M0-4 |
| session usable after cancel | yes | yes | yes | §M0-4 |

### What M1a-4 should put in the registry

Measured fields only. The containment *label* — and what `safe` should warn about — is
M1a-4's call, not this note's.

| field | opencode | claude-agent-acp | copilot |
| --- | --- | --- | --- |
| `shell` | `internal` | `internal` | `internal` |
| `argvChannel` | `none` | `notification` (late) | `notification` + `permission` |
| mode discovery | `configOptions` with `category: "mode"` **only** — `modes` is absent, so a client that reads `SessionModeState` alone concludes it has none and is wrong | `SessionModeState`, 6 vendor ids | `SessionModeState`, 3 canonical spec URLs |
| mode ids | `build`, `plan` | `default`, `auto`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` | `https://agentclientprotocol.com/protocol/session-modes#agent`, `…#plan`, `…#autopilot` — **the full URL is the id; the bare `#plan` fragment returns `-32602`** |
| `session/set_mode` | accepted — and really so: `-32602` on a bogus id | accepted | accepted, with the full URL id |
| `env.unset` | — | `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT` | — |
| `loadSession` | true, plus `resume` and `fork` | true, plus `resume`, `fork`, `delete` | true — but `close`/`list` only, **neither `resume` nor `fork`** |

At the time of the M0 runs below, `omp`, `pi` and `gemini` were uninstalled here:
**`unknown` by absence, not by test.** pi was measured later (2026-09-09, below);
`omp` and `gemini` remain unverified by absence. `unknown` should read as
`internal` / `none` for warning purposes.

### Containment vocabulary

These terms describe what the client can see and contain; the measured values are in the table above.

- **`shell`** — where the harness runs its commands: `internal` (its own shell), `terminal` (via our `terminal/*`), or `unknown`.
- **`argvChannel`** — whether the real command text reaches us, and on which message: `none`, `notification` (on `session/update`), or `permission` (on the permission request).
- **`asksPermission`** — whether the harness ever sends `session/request_permission`; opencode is `false`, so the policy has no jurisdiction over it.
- **`_meta.terminal_output`** — a capability axis, not a fourth `argvChannel` value: it changes how claude-agent-acp renders a Bash call but adds no command output or exit code (§M0-3).

---

## M0-1 · Harness availability and handshake survey

### Availability

All three target harnesses are **available** — installed, authenticated, and observed
completing a turn. None is recorded as unavailable, and none is untested.

| Harness | Binary | Invocation | Version | Available |
| --- | --- | --- | --- | --- |
| opencode | `~/.opencode/bin/opencode` | `opencode acp` | OpenCode 1.18.18 | yes |
| claude-agent-acp | `~/.local/bin/claude-agent-acp` | `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` 0.49.0 | yes |
| copilot | `~/.local/bin/copilot` | `copilot --acp` | GitHub Copilot CLI 1.0.78 | yes |

The registry in `agents.mjs` says `copilot acp`; the real flag is `copilot --acp`
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
| --- | --- | --- | --- |
| spawns | yes | yes | yes |
| `initialize` latency | 1.1 s | 0.3 s | 0.5 s |
| `session/new` latency | 1.1 s | 0.7 s | 3.0 s |
| completes a turn | yes | yes | yes |
| stop reason | `end_turn` | `end_turn` | `end_turn` |
| turn latency (read prompt) | 13.7 s | 4.4 s | 5.6 s |
| protocol version | 1 | 1 | 1 |
| `authMethods` at init | `opencode-login` offered | `[]` | `copilot-login` offered |

All three answer `protocolVersion: 1`, so the hard-fail at `protocol/agent.ts` never fires.
Note that opencode and copilot advertise auth methods *even when already authenticated* —
a non-empty `authMethods` is not a signal that login is required, and the note logged at
`protocol/agent.ts` should not be read as one.

Copilot's auth method carries `_meta["terminal-auth"]` with a real `{command, args, label}`
for `copilot login`. That is a ready-made affordance for M2-8 and M4-3: the harness is
telling us exactly how to re-authenticate it.

### `agentCapabilities`

| capability | opencode | claude-agent-acp | copilot |
| --- | --- | --- | --- |
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

`render.mjs` silently drops anything not in its switch. Observed unhandled:

| variant | opencode | claude-agent-acp | copilot |
| --- | --- | --- | --- |
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
one turn; the other two did not emit it). `plan` was not emitted by any harness on these
prompts, so its rendering path is still unexercised outside `mock-agent.mjs`.

#### Re-measured 2026-09-09 (M1c-7 pickup), one turn each

The 2026-08-20 rows above are a survey of six turns, not a law about the protocol, so they
were re-run on today's builds with a prompt that **explicitly asks for step-by-step
reasoning** — the case most likely to produce a thought chunk.

| | opencode 1.18.30 | claude-agent-acp 0.49.0 | copilot |
| --- | --- | --- | --- |
| `agent_message_chunk` | 42× | 8× | 7× |
| `agent_thought_chunk` | **13×** | **none** | **none** |
| `messageId` on chunks | **on all 55** | **on all 8** | **never** |
| other variants | `available_commands_update`, `usage_update` | same | plus `config_option_update`, `session_info_update` |

**`agent_thought_chunk` stays opencode-only**, now on a prompt that begged for it. Read it as
a property of the *adapter's default settings* rather than of the harness: claude-agent-acp
streams thinking only when extended thinking is switched on, and nothing here switches it on.
A harness that starts emitting it needs no client change — `render.ts` has had the branch
since M1a-7.

**Note, 2026-10-10 (M7-1):** room logs from October 2026 show that **claude and pi send
`agent_thought_chunk`** too, one pi agent about 82,000 in one room. The rows above stay as
measured; they were true for those builds and those prompts. The chat TUI shows only the word
`thinking`, never the text (`client/room.ts` keeps no thinking text).

**`messageId` is populated by two of three** — the M1c-7 measurement, which no M0 finding
covered. It is not needed: block detection uses blank lines, and copilot omits it entirely,
so a `messageId`-keyed design would have had no fallback on one third of the fleet. Recorded
because it is the natural second key if blank-line detection ever proves wrong.

**`session_info_update` is new** — copilot sends one per session and M0-1 did not see it.
Unhandled, like its two siblings, and dropped in silence by design.

#### claude-agent-acp 0.75.1, re-measured 2026-09-09

The adapter jumped 0.49.0 → 0.75.1 (26 releases). `npm run test:harness` for claude passes
all three tests, and a `--mode auto` probe running one `echo` re-verified the rest:

- **`shell: internal`** holds — it ran the command itself, called no `terminal/*` and no `fs/*`.
- **`argvChannel: notification`** holds, with the same lateness: `tool_call` carries
  `rawInput: {}` and `title: "Terminal"`, and the command text (`{"command":"echo …"}`)
  arrives on the first `tool_call_update`. Anything judging a command must still read the
  merged view.
- **`asksPermission: true`** holds — under `safe` the refusal fires on `switch_mode`, exactly
  as measured 2026-09-04.
- **`modeMap`**: `safe: "plan"` negotiates, `auto: "bypassPermissions"` is accepted by
  `session/set_mode`. **2026-09-29:** `ask: "default"` is accepted on claude-agent-acp
  0.75.1 (§Mode after load). A room sends it for `ask` and `auto` (#149); a run still
  sends only `safe`'s (#193).
- **Not re-verified, and the new date does not cover them:** `usage`, because separating
  per-turn from cumulative needs two turns in one session, and no probe had run at this date;
  §Multi-turn below (2026-09-15) makes the second turn reachable but leaves `usage` carried
  forward, not measured. And `meta`, which describes behaviour gated on advertising
  `terminal_output`, which this client does not advertise.

Three things that are new on the wire since M0, none of which the client reads yet:

- `usage_update` can carry **`cost`** — `{"amount":0.1323235,"currency":"USD"}` on the last
  update of the turn. The first vendor-neutral money figure any harness has given us.
- `size` **changed mid-turn**, 200000 for every update and then 1000000 on the last one. M0-5
  already refuses to build a rung on that denominator; this is a second reason.
- The `_meta["_claude/rateLimit"]` object has grown `unifiedWindows` (`five_hour` and
  `seven_day`, each with `utilization` and `resetsAt`), plus `overageStatus` and
  `overageDisabledReason`. Still the fleet's only exhaustion signal.

### Methods reaching the `#handleRequest` default

**None.** Across six surveyed turns, no harness sent a method outside the three we
implement, so the `-32000` default at `protocol/agent.ts` never fired and we returned zero
errors. In particular no harness called `terminal/*` — consistent with our advertising
`terminal: false`, and the starting point M0-3 has to disturb.

The more interesting result is what they *didn't* call:

| inbound request | opencode | claude-agent-acp | copilot |
| --- | --- | --- | --- |
| `fs/read_text_file` | never | never | never |
| `fs/write_text_file` | never | never | never |
| `session/request_permission` | **never** | on writes only | on reads *and* writes |

**Zero `fs/*` traffic from any harness, in any run.** We advertise
`fs.readTextFile`/`writeTextFile: true` and all three ignore it, reading and writing
through their own process. Files created during the write probe appeared on disk in every
throwaway workspace without a single `fs/write_text_file` crossing the wire. Therefore
`#guardPath` (`protocol/agent.ts`) currently protects **nothing in production** — it is dead code
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
| --- | --- | --- | --- |
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
| --- | --- | --- |
| opencode | **no** | **YES — `blocked.txt` written** |
| claude-agent-acp | yes (`edit`) → rejected | no |
| copilot | yes (`execute`) → rejected | no |

**opencode never sends `session/request_permission` at all** — zero across every run,
read and write alike. It writes files with no client involvement, so `--mode safe` and
`--mode ask` are both inert against it: nothing to refuse, nothing to prompt. This is not a
bug in the policy; it is the policy having no jurisdiction. It confirms M0-6's correction
in the strongest possible form — that correction **landed 2026-08-23 in `c4307f3`**, and
`CLAUDE.md` and `README.md` now carry the per-harness claim. It is also the plan's
"silent autonomy" row (non-empty diff, zero permission requests) occurring by default in a
supported harness, not as an anomaly — that detector should be treated as required, not
nice-to-have.

**But opencode is not uncontainable — an earlier draft of this note said so and was wrong.**
Re-running the same probe with one line added, `session/set_mode → plan` before the prompt:

| run | policy | mode negotiated | `probe.txt` written |
| --- | --- | --- | --- |
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

**That last sentence is true of 1.0.78 and only half true of 1.0.80** — on the current
build copilot reads a named file through a native `read` tool that `safe` allows, and still
dies on anything that has to explore. Measured below, under "What re-verification changed";
the general point survives, the blanket "unusable" does not.

### What re-verification changed (copilot 1.0.78 → 1.0.80)

Everything above was measured on copilot **1.0.78**; M0-3, M0-4 and M0-5 all ran on
**1.0.80**, which copilot self-updated to on 2026-08-21. M0-4's rule — *"pin the version
next to every row; that is the only durable part of this table"* — means the roll-up cannot
carry a column spanning two builds, so M0-7 re-ran this section's copilot checks on 1.0.80
(2026-08-23, `spike/m0-7-reverify`, four runs, fresh workspace each).

**Four cells above no longer describe the current build** — three because copilot's
behaviour changed, one because the ids were recorded in abbreviated form and the
abbreviation is not usable. All were correct as written and are left in place; this is what
changed under them.

| | 1.0.78, as recorded above | 1.0.80, measured 2026-08-23 |
| --- | --- | --- |
| reading a file | kind **`execute`**, shelling `cat <path> 2>&1` | kind **`read`**, a native "Viewing …" tool with `rawInput: {path}`, and **no permission request at all** |
| `session/request_permission` | on reads *and* writes | on **shelled commands and writes**; file reads pass unasked |
| creating a file | asked with kind `execute` | asks with kind **`edit`**, `rawInput: {path, file_text}` — still refused under `safe` |
| mode ids | abbreviated `#agent`, `#plan`, `#autopilot` | the **full URL is the id**; `session/set_mode` with the bare `#plan` fragment returns `-32602`, with the full URL returns OK |

Re-confirmed unchanged: no `fs/*` traffic of any kind, `available_commands_update` ×2 and
`config_option_update` ×1, `loadSession: true` with `close`/`list` and **neither `resume`
nor `fork`**, protocol version 1, and `copilot-login` advertised while already
authenticated.

**The consequence lands on a safety claim, not a table cell.** M0-6 shipped
*"copilot shells `cat` to read, so `safe` refuses its reads and makes it unusable"* into
`CLAUDE.md` and `README.md` on 2026-08-23, hours before this re-run. On 1.0.80 that is half
wrong, and both halves were measured:

| prompt, under `safePolicy` | what happened |
| --- | --- |
| "Read `acp.mjs` and describe it" (names the file) | native `read` tool, **zero permission requests, turn completed, correct answer** |
| "What files are in this directory?" (must look around) | shells `find`, kind `execute` → **refused** → turn dies in 2.3 s with **no output at all**, reporting `end_turn` |

So on 1.0.80: `safe` lets copilot read a file whose path is already known, and still kills
anything that has to explore — which is most real work, and it fails silently as a clean
`end_turn`. The corrected wording is in `CLAUDE.md` and `README.md` as of this story;
`#7` stays closed and points here.

The wider lesson is the one M0-4 already stated and this section now demonstrates: a
per-harness finding is a claim about a build, and three days was enough to invalidate one.

### Incidental (belongs to M0-5) — **superseded by §M0-5, kept for the correction**

> `usage_update` is `{used, size}` on all three, with `size` = 200000 for each.
> **opencode alone adds `cost: {amount, currency}`** (`0`/`USD` on a trivially short turn).
> So a price table is possible for opencode directly and would have to be modelled for the
> other two. M0-5 owns confirming whether that amount ever becomes non-zero.

Every claim in that paragraph was overtaken by the survey it was handing off to:

- **`size` = 200000 for each is wrong.** It is per-model, and unusable as a denominator on
  two harnesses — §M0-5, "`size` is per-model, late on one harness and wrong on another".
- **"opencode alone adds `cost`" is wrong.** claude-agent-acp sends it too, on the last
  update of each turn — §M0-5, "opencode's `cost: 0` was 'not billed', not 'always `0`'".
- **The `0` did not mean the field was dead.** It meant the provider in effect was not
  metered; the same field reported real spend against a metered one.
- **The price table it proposed is deliberately not being built** — §M0-5, "Verdict on the
  price table". The per-task token count it was reaching for exists, but on the
  `session/prompt` response, not here.

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
| --- | --- | --- | --- |
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
| --- | --- | --- | --- |
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
(`run.mjs`) kills the subprocess 2 s after cancelling. Because `#failAll` rejects
every pending request on `close` (`protocol/agent.ts`), a cancel slower than that grace would
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
| --- | --- | --- | --- |
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
(`docs/STORIES.md`) — nobody invented a value. The mismatch is semantic, and that is
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
| --- | --- | --- | --- |
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
  the grace `run.mjs` already uses, so the watchdog inherits a number rather than
  inventing one. Kill only if that expires — expect never to reach it.
- **M1b-2's stop-reason table cannot key on `stopReason` alone.** `cancelled` may never
  arrive (copilot), and `end_turn` is now known to mean *finished*, *I was cancelled*, or
  *someone interrupted me*, depending on harness. The status must be derived from the
  triple (`stopReason`, did **we** send a cancel, did the watchdog fire) — the supervisor's
  own record of intent is the authoritative half. The table stands; its input does not.
- **Scope note, 2026-09-15:** Question 2 sent the second prompt *during* a live turn. A
  prompt sent after `end_turn` is a different case and completed on all four harnesses —
  see §Multi-turn below.
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

## M0-5 · Context window and usage reporting survey

*Refocused mid-story (2026-08-22): the question that matters for M1c's watchdog is
**how much context a task has left and whether the harness will warn before it runs out**.
Cost and token accounting were surveyed too and are recorded below, but the price table they
feed is explicitly demoted to nice-to-have — see the verdict.*

Run 2026-08-22 on branch `spike/m0-5-usage-probe` (kept, never merged) against the same three
harnesses. Method: `usage-probe.mjs` drives **one session of N prompts**, logging every
`session/update` verbatim — `_meta` and unknown top-level fields included — and keeping the
whole `session/prompt` response. `wire-tap.mjs` tees the JSON-RPC wire in both directions,
because `AcpAgent` forwards only `session/update` to `onEvent` (`protocol/agent.ts`) and
`prompt()` returned `res.stopReason` and threw the rest of the response away
(resolved by M1a-3, #62 B3 — the whole response is now returned).
`--mode auto`, no `session/set_mode`. Workspace: a throwaway five-file JS project, reset per
session.

**Eleven sessions**, in four shapes: a three-turn run per harness (one long multi-tool turn,
then two trivial ones); a two-turn re-run per harness on a **different model**; a
slash-command run per harness (`/context`, `/usage`, `/usage-credits`); and a five-turn
compaction run (real turn → `/context` → `/compact` → `/context` → real turn). Slash commands
are sent as ordinary prompt text — that is the only channel ACP gives a client for them — and
they are what let this note check each harness's report **against its own accounting**.

M0-1's incidental note (§M0-1, "Incidental") said `{used, size}` with `size` = 200000
everywhere and `cost` on opencode alone. **Both halves are corrected below.**

### Samples

| | opencode | claude-agent-acp | copilot |
| --- | --- | --- | --- |
| version | 1.18.18 | 0.49.0 (ACP schema 0.28.1) | 1.0.80 |
| auth mode | opencode-login (Zen) + a DeepSeek API key | OAuth subscription (no `ANTHROPIC_API_KEY` in env) | GitHub Copilot subscription |
| models run | `opencode/big-pickle`, `deepseek/deepseek-chat` | `opus` (= `claude-opus-4-8`), `haiku` | `claude-sonnet-5`, `claude-haiku-4.5` |
| turn-1 wall clock | 231 s | 40 s | 17 s |

---

### The context window

#### `usage_update` arrives from all three — and is the only notification that carries usage

| | opencode | claude-agent-acp | copilot |
| --- | --- | --- | --- |
| `usage_update` arrives | **yes** | **yes** | **yes** |
| `used` | always | always | always |
| `size` | always | always | always |
| `cost` | **on every update** | **on the last update of each turn** | **never** |
| `_meta` | never observed | never observed (two vendor keys exist in source — see "Running out") | never observed |
| per long turn | 1, at end | 23, streamed | 5, streamed |

Across eleven sessions no usage figure appeared on any other notification or on any inbound
request: the wire carries it in exactly two places, this notification and the
`session/prompt` **response** (see "The per-task token count", below). 78 `usage_update`s
were captured and **none carried `_meta`**.

#### `size` is per-model, late on one harness and wrong on another

| harness / model | `size` on the wire | the harness's own view | agree? |
| --- | --- | --- | --- |
| opencode `opencode/big-pickle` | 200000 | no `/context` command exists | unverifiable |
| opencode `deepseek/deepseek-chat` | 1000000 | " | unverifiable |
| claude `opus` | **200000 mid-turn, 1000000 from the first end-of-turn update on** | `/context`: "12.9k / 1m" | **only after the first turn** |
| claude `haiku` | 200000 throughout | — | — |
| copilot `claude-sonnet-5` | 200000 | `/context`: "15k/**264k** tokens", of which "Buffer 74.0k (28%)" | **no** |
| copilot `claude-haiku-4.5` | 136000 | — | — |

Two distinct failures, both fatal to a naive `size - used`:

**claude-agent-acp under-reports by 5× for the whole of a session's first turn.** Not a
glitch — a warm-up. The adapter carries `session.contextWindowSize`, defaulted to 200k and
**learned from the SDK's `modelUsage` only when the turn's `result` message arrives**
(`acp-agent.js:1068-1078`; its own comment notes a miss would "leave the next prompt's
mid-stream updates reporting 200k"). Every mid-turn update on turn 1 of a 1M-context session
claims a 200k window.

**copilot reports a third number that matches neither its window nor its usable space.** Its
own `/context` calls the window 264k and reserves a 74k buffer, leaving ~175k free; the wire
says 200000. We could not account for the 200000 from anything copilot reports, and it is not
a constant — haiku-4.5 moved it to 136000. Treat copilot's `size` as an order-of-magnitude
hint, not a budget.

Only opencode's `size` is a straight read of a real per-model limit (its ACP layer computes
it from the provider/model pair at emission time), and it is the one harness that offers no
second opinion to check it against.

#### `used` is occupancy, a snapshot, and arrives at very different rates

`used` is "tokens currently in context", as the spec says and the story assumed. It climbs
with the transcript and never resets on a turn boundary — opencode 10888 → 11063 → 11093,
claude 11293 → … → 15647, copilot 13945 → … → 17197 across three turns, where turns 2 and 3
were one-word replies. It is **not** a per-turn count.

Where a harness has a `/context` command, its `used` agrees with it (claude 12943 vs "12.9k";
copilot 15742 vs "16k"). **The disagreements are all in `size`, never in `used`.**

Cadence is where they diverge, and it decides what a watchdog can do:

| | updates per long turn | when |
| --- | --- | --- |
| opencode | **1** | at the **end** of the turn only |
| claude-agent-acp | 23 | roughly per assistant message, plus one at end of turn carrying `cost` |
| copilot | 5 | roughly per tool step |

**On opencode a client learns nothing about context until the turn is already over.** A
supervisor that means to intervene before a window fills has no in-turn signal there at all —
the same shape as M0-1's finding that opencode routes nothing through the permission channel.

#### Compaction is invisible on the protocol

Neither harness that supports it announces compaction in-band; both say it in prose, and the
numbers move quietly.

| | `/compact` result (prose) | `usage_update` during it | `used` after |
| --- | --- | --- | --- |
| claude-agent-acp | "Compacting completed." | 1 update, 13599 → **13874 (up)** | `/context` unchanged at 12.9k → 13.9k — nothing was reclaimed |
| copilot | "Compacted conversation history and removed 10 messages and 1,256 tokens." | **none** | next turn's update: 15742 → **15165**, and `/context` confirms messages 2.4k → 1.2k |
| opencode | no `/compact` command over ACP | — | — |

So a client watching `used` sees, at best, an unexplained step **down one turn late**
(copilot) and at worst nothing at all (claude, where a compaction of an already-small context
reclaimed nothing and the counter still rose). Anything that treats a fall in `used` as an
event needs to tolerate it happening silently and late.

One trap worth pre-empting: claude-agent-acp has a fallback that reports **`used: 0`** when
its own token fetch fails during compaction (`acp-agent.js:835-855`). It did not fire here —
the observed compaction reported a real number — but a client must read a `0` as *unknown*,
not *empty*, or it will conclude a task just got a fresh window.

#### Running out: is there a warning, a quota, or a credit signal?

**In ACP itself, no.** Schema 0.28.1 has no definition mentioning a quota, credit, rate limit
or balance, and no threshold or warning field anywhere on `UsageUpdate`. The only in-band
exhaustion signals the protocol defines are the stop reasons `max_tokens` ("reached the
maximum number of tokens") and `max_turn_requests` — **neither of which any harness returned
in eleven sessions**. A client that wants a "90% full" warning has to compute it from
`used`/`size` itself, which is exactly why the `size` failures above matter.

Per harness:

| | warns before it runs out? | channel | what it carries |
| --- | --- | --- | --- |
| claude-agent-acp | **yes** | `usage_update._meta["_claude/rateLimit"]` | `status: allowed \| allowed_warning \| rejected`, `utilization`, `surpassedThreshold`, `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`), `resetsAt`, `isUsingOverage`, `errorCode: "credits_required"`, `overageDisabledReason` (including `out_of_credits`), `canUserPurchaseCredits` |
| copilot | no | — | `/usage` reports consumption only: "Requests: 1 AI Units", input/output/cached tokens. No entitlement, no remaining, no limit |
| opencode | no | — | its emission site builds `{used, size, cost}` with no `_meta` and no warning field; `cost` is a spend total with nothing to compare it against |

**claude-agent-acp is the only harness that can tell us we are running out**, and it does it
properly: `allowed_warning` is a pre-exhaustion state, `utilization` is the percentage the
question asked for, `resetsAt` says when it clears, and `credits_required` /
`out_of_credits` separate "throttled, wait" from "out of money, stop". The type is the SDK's
`SDKRateLimitInfo` and the adapter forwards it verbatim on a `rate_limit_event`
(`acp-agent.js:1512-1524`).

Two caveats, both important. It is a **vendor `_meta` extension**, not protocol, so nothing
obliges the other two to grow one — and **we never observed it firing** in eleven sessions,
because the account was nowhere near a limit; the emission path is read from the adapter and
SDK source, not from the wire. And `render.mjs` drops `_meta` entirely today, so even when it
does fire, this client sees "context N/M tokens" and nothing else.

**The one on-demand alternative that works today** is claude's `/usage`, which returns plan
utilisation as prose — *"Current session: 41% used · resets Aug 22, 4:49pm … Current week
(all models): 39% used · resets Aug 26"* — for **zero tokens** (its `PromptResponse.usage`
came back all-zero and it emitted no `usage_update`). It is pollable and cheap, it is text
that must be parsed, and it exists on claude only: copilot's `/usage` reports consumption
without a limit, and opencode exposes no such command over ACP at all.

The practical consequence for M1c: **the supervisor must own the threshold.** Compute
occupancy from `used`/`size`, distrust `size` on copilot and on claude's first turn, and treat
`_claude/rateLimit` as a bonus that arrives on one harness rather than as the mechanism.

---

### Cost and token accounting

Surveyed because the story asked, and kept because it is cheap to record; the price table it
was meant to feed is deprioritised below.

#### opencode's `cost: 0` was "not billed", not "always `0`"

| harness / model | auth | `cost.amount` after a real turn |
| --- | --- | --- |
| opencode `opencode/big-pickle` | opencode Zen subscription | `0` — still `0` after 231 s and 155 updates |
| opencode `deepseek/deepseek-chat` | DeepSeek API key | **`0.0017770984` USD**, → `0.0018118688` after one trivial turn |
| claude-agent-acp `opus` | OAuth subscription | **`0.2328715` USD**, → `0.2436225` → `0.2517525` |
| copilot | Copilot subscription | field absent entirely |

opencode's `cost` is a **live, correct, cumulative session total** that reads `0` because the
provider in effect is not metered per token — the distinction the story asked for, and one no
amount of extra work on a single provider would have settled. **claude-agent-acp sends `cost`
too**, on the last `usage_update` of each turn, which corrects M0-1's "opencode alone".

Two cautions on the claude figure: it is the Claude Agent SDK's `total_cost_usd` passed
through (`acp-agent.js:1079-1095`), and under OAuth subscription auth **nobody is invoiced
that amount** — it is a list-price valuation, the right input for a budget guard and the wrong
one for an invoice. `cost.amount` is **cumulative for the session** on both harnesses that
send it, so a per-task figure is a subtraction across the task's first and last
`usage_update`, never a sum.

#### The per-task token count has a source — and we currently discard it

It exists on **all three harnesses**, and it is not `usage_update`: it is `usage` on the
`session/prompt` **response**.

| field (turn 1) | opencode | claude-agent-acp | copilot |
| --- | --- | --- | --- |
| `inputTokens` | 264 | 2704 | 100678 |
| `outputTokens` | 146 | 2595 | 1689 |
| `thoughtTokens` | 17 | — | 12 |
| `cachedReadTokens` | 10624 | 129785 | 78733 |
| `cachedWriteTokens` | — | 8895 | 21598 |
| `totalTokens` | 11051 | 143979 | 102367 |

**Three harnesses, two meanings.** On opencode and claude the numbers are **per turn** —
`inputTokens` falls 264 → 183 → 85 and 2704 → 2 → 2 as the turns get trivial, which a
cumulative counter cannot do; claude even returns all-zeros for a slash command. On copilot
they are **cumulative for the session**: 100678 → 122487 → 144401 input, with `outputTokens`
ticking 1689 → 1693 → 1697 for two one-word replies, and unchanged totals across a slash
command. Composition differs too: copilot's `cachedRead + cachedWrite` ≈ `inputTokens` (cache
sits *inside* input, `totalTokens` = input + output), while opencode and claude add all four
components.

For M1b-4 that means `tokens` must be recorded **per harness with its semantics tagged**, a
supervisor must **subtract, not sum, on copilot**, and `totalTokens` is not comparable across
vendors — the plan's existing "never summed" rule (`STORIES.md`) with a sharper reason.

Two spec notes: the field is **`UNSTABLE`** in the schema ("may be removed or changed at any
point") and the published prompt-turn docs still describe the response as carrying
`stopReason` alone, so all three harnesses are ahead of the documentation; and the schema's
own descriptions ("Total input tokens across all turns") describe the cumulative reading, so
**copilot is the one implementing it as written**. Our client cannot see any of it today —
`AcpAgent.prompt()` returned `res.stopReason` and dropped the rest — resolved by
M1a-3 (#62 B3), which keeps the whole response; rendering it still waits on
M1a-4 recording the per-harness semantics.

#### All three name the model they ran

The plan's "nothing reports that today" is **false, and was already false when written**.
Every harness reports its current model in the `session/new` response, in the spec's own
`configOptions` shape, with the reserved `category: "model"`:

| | opencode | claude-agent-acp | copilot |
| --- | --- | --- | --- |
| `configOptions` on `session/new` | yes | yes | yes |
| `currentValue` observed | `opencode/big-pickle` | `opus` | `claude-sonnet-5` |
| resolvable to a real model? | **yes** — provider-qualified | **an alias**; `/context` resolves it to `claude-opus-4-8` | **yes** |
| `config_option_update` notification | never | never | **1×**, just after `session/new` |
| accepts `session/set_config_option` | **yes** | **yes** | **yes** |
| re-emits `config_option_update` after we set it | no | no | **no** |

M0-1's lead — copilot's `config_option_update` — is real but the weakest of the three
channels: it repeats what `session/new` already said and did **not** fire again when we
changed the model mid-session. The reliable pattern is to read `configOptions` from the
`session/new` response and treat the `session/set_config_option` **response** (which returns
the full option set) as the update channel. Switching works on all three and takes effect
immediately — `size` moves with it.

Also worth keeping: **copilot ships a price table of its own**, as `_meta` on each model
option — `copilotUsage: "1x"` for `claude-sonnet-5`, `"15x"` for `claude-opus-5`, `"0.33x"`
for `claude-haiku-4.5`, `"0x"` for `gpt-5-mini`, plus `copilotPriceCategory`. That is a
premium-request multiplier, not currency.

#### Verdict on the price table — possible, and deliberately deprioritised

**A per-harness price table is now possible — all three name the model they ran — but it is
recorded as nice-to-have and left unscheduled: opencode and claude-agent-acp already report
cumulative USD themselves, and copilot cannot be priced in currency at all, since it meters
premium requests rather than tokens.**

The backlog trigger (`STORIES.md`, "any harness names the model it selected") has
**fired**, and is recorded as fired with the decision to defer attached, so the next reader
does not re-derive it. If it is ever picked up, the work is recording each harness's
self-reported unit — USD, USD, premium requests — plus an alias table for claude, not
converting tokens for all three.

---

### Surprises, and what the spec says about them

Cross-checked against the ACP JSON schema shipped in `@agentclientprotocol/sdk` 0.28.1
(vendored under the claude adapter) and the published docs and RFD.

1. **`PromptResponse.usage` is not in the docs.** The prompt-turn page still says the response
   carries `stopReason`; the schema carries `usage`, marked `UNSTABLE`. All three harnesses
   populate it. Real, useful, unversioned — pin it with a `mock-agent.mjs` case rather than
   trusting it.
2. **The same field means two different things across harnesses** (per-turn vs cumulative),
   and the spec's wording endorses the reading only copilot implements. The finding most
   likely to produce a wrong number quietly.
3. **copilot's `size` matches nothing it reports elsewhere** — 200000 on the wire against a
   264k window and ~175k of usable space by its own `/context`. Unexplained, and the reason
   the watchdog cannot trust `size` as a denominator.
4. **The protocol has no concept of running out.** No quota, credit, rate-limit or threshold
   field exists anywhere in schema 0.28.1; the one real warning channel in the field
   (`_claude/rateLimit`) is a vendor `_meta` extension on a single harness.
5. **copilot answers `session/new` with a `models` object** —
   `{availableModels, currentModelId: "claude-sonnet-5"}` — that **does not exist in
   `NewSessionResponse` in schema 0.28.1**. A superseded field kept alive alongside the
   `configOptions` that replaced it. Harmless; do not build on it.
6. **copilot uses documentation URLs as config value ids** —
   `currentValue: "https://agentclientprotocol.com/protocol/session-modes#agent"`. Legal (ids
   are opaque) but no cross-harness code may assume short tokens.
7. **A stray `opencode.json` above the workspace kills the harness before `initialize`.** The
   first DeepSeek run wrote its probe record to the workspace's parent; opencode walks up from
   `cwd`, found it, and exited 1 with *"Configuration is invalid … Expected object | undefined,
   got \"opencode acp\" command"* — surfacing as the same opaque spawn failure `CLAUDE.md`
   already warns about. Keep run state out of a workspace's ancestry.

### Coverage

Eleven sessions across three harnesses, one machine, one workspace shape. **`omp`, `pi` and
`gemini` remain uninstalled here — unknown by absence, not by test.** Three gaps are known and
named rather than papered over:

- **No harness was driven near an actual limit.** Every claim about warning behaviour
  (`allowed_warning`, `utilization`, `credits_required`) is read from adapter and SDK source,
  not observed on the wire. The stop reasons `max_tokens` and `max_turn_requests` were never
  seen either.
- **Compaction was tested only by asking for it** (`/compact`), on a context far from full.
  Automatic compaction at a threshold — which is when it will actually happen to a long task —
  is untested, and is the obvious next probe.
- **opencode's context accounting has no second opinion.** It exposes no `/context` or
  `/usage` command over ACP, so its `size` and `used` were checked against nothing but its own
  source.

---

## pi-acp measured 2026-09-09

pi was installed after the M0 rows above were taken, so it is not a fourth column in the
M0 tables. This section is the measurement that fills its registry entry — pi-acp 0.0.33
spawning pi v0.85.1, one machine, throwaway workspaces, wire-tap captures.

| field | pi-acp 0.0.33 / pi v0.85.1 |
| --- | --- |
| `shell` | `internal` — pi reads/writes/executes locally; no `terminal/*` or `fs/*` delegation |
| `argvChannel` | `notification` — shell commands arrive as the `tool_call` title; read calls arrive as `rawInput.path` |
| `asksPermission` | **false** — zero `session/request_permission` requests; it wrote a file under `safe` |
| `modeMap` | **absent** — ACP `modes` are thinking-effort levels (`off`…`xhigh`), not safety/behaviour modes |
| `usage` | `absent` — no `usage_update` and no `usage` on the `session/prompt` response in the turns measured |
| `measuredOn` | `{ version: "0.0.33", date: "2026-09-09" }` |

`loadSession` was not recorded here. §M0-9 measured it on pi-acp 0.0.34: it is `true`, and
the load works in a new process.

Other wire notes that matter for downstream consumers:

- `session/new` returns `modes.currentModeId: "medium"` and `configOptions` for `model` and
  `thought_level`. `session/set_mode` accepts the six thinking ids and rejects a bogus id
  with `-32602`, confirming the ids in `modes` are the only ids.
- Shell `tool_call`s carry `content: [{ type: "terminal", terminalId }]` and
  `_meta.terminal_info`, even though the client never advertises `terminal/*`. Output and
  exit status arrive on `tool_call_update` as `_meta.terminal_output` and
  `_meta.terminal_exit`.
- Because the only ACP modes are thinking levels, mapping `safe`/`ask`/`auto` to one of
  them would claim a safety mode that does not exist. The registry entry therefore omits
  `modeMap`; `safe` prints the no-safety-mode notice and the never-asks notice rather than
  pretending a thinking level bounds the agent.

---

## M2-4 · How a harness stops — measured 2026-09-15 (#34)

**Question.** When the client goes away, or stops a harness, does the harness exit, and
does the shell command it was running go with it?

**Method.** A stand-in parent spawned each harness over stdio, answered the handshake,
allowed every permission, and prompted `Run exactly this shell command and wait for it:
sleep 300`. Once a `tool_call` had arrived and `sleep 300` showed in `ps`, the parent
stopped the harness one of four ways, then polled `ps` for the harness and for `sleep`.
Versions: opencode 1.18.30, claude-agent-acp 0.75.1, copilot 1.0.83, pi-acp 0.0.33.

| stop | opencode | claude-agent-acp | copilot | pi-acp |
| --- | --- | --- | --- | --- |
| idle after `session/new`, parent `kill -9` | exits < 1 s | exits < 1 s | exits < 1 s | exits < 1 s |
| mid `sleep`, parent `kill -9` (stdin end of file only) | clean | clean, inner `claude` process gone ≤ 3 s | clean | clean |
| mid `sleep`, stdin closed and SIGTERM at once (the old `stop()`) | **`sleep` survives** | clean | clean | clean |
| mid `sleep`, SIGTERM | **`sleep` survives** | clean | clean | clean |
| mid `sleep`, SIGKILL | **`sleep` survives** | clean | **`sleep` survives** | clean |

*Clean* means the harness and `sleep` were both gone at the first poll after one second.

**Every harness runs its shell command in a session of its own** (`ps` showed `sleep`'s
pgid and sid equal to its own pid, never the harness's). So no kill the client sends — to
the harness pid or to its process group — reaches that command. Only the harness's own
shutdown does, and end of file on stdin is what starts it on all four.

**End of file is a convention, not a guarantee.** ACP's transports page shows "close
stdin, terminate subprocess" in a diagram and places no requirement on the agent. MCP's
lifecycle spec writes the same order down for its clients — close input, wait, SIGTERM,
SIGKILL — but it too requires nothing of the server. That is why this is a per-build
measurement, and why `AcpAgent.stop()` keeps a SIGKILL behind the grace.

**Consequences.** `stop()` closes stdin first and signals only a harness still alive after
the grace; a daemon crash delivers the same end of file through the kernel; the daemon
records live harness pids in `children.json` for M2-5, for the build that stops honouring it.

---

## Multi-turn · a second prompt after `end_turn` — measured 2026-09-15

**Question.** M0-4 Question 2 sent a second prompt while the first turn was still running.
Does a second prompt sent *after* the first turn ended complete on the same session, with
the first turn's context kept?

**Method.** One `AcpAgent`, one `session/new`, `policy: () => false`. Turn 1: *"Remember
this codeword: ZEBRA-4417. Do not use any tools. Reply with only the word OK."* Turn 2,
sent only once turn 1 had answered: *"What codeword did I give you in my previous message?
… Reply with only the codeword."* Two runs per harness by script; the recall and wall-clock
rows below come from those runs. One more run per harness goes through `npm run test:harness`
(`twoTurns` in `integration/helpers.ts`), which asserts only what the client controls — the
stop reasons, the session id and the spawn count — and never the agent's prose, so recall on
a real harness is observed here but not asserted by the suite.

| | opencode 1.18.30 | claude-agent-acp 0.75.1 | copilot 1.0.83 | pi-acp 0.0.33 / pi v0.85.1 |
| --- | --- | --- | --- | --- |
| turn 1 / turn 2 `stopReason` | `end_turn` / `end_turn` | `end_turn` / `end_turn` | `end_turn` / `end_turn` | `end_turn` / `end_turn` |
| same `sessionId` | yes | yes | yes | yes |
| harness spawns | 1 | 1 | 1 | 1 |
| turn 2 answered the codeword | 2 of 2 | 2 of 2 | 2 of 2 | 2 of 2 |
| both turns, wall clock | 9.1 s, 14.6 s | 5.2 s, 4.6 s | 5.5 s, 4.5 s | 6.1 s, 5.7 s |

**Answer: yes, on all four.** The in-flight guard (#62 R5) already allows it, so no client
change was needed. The session keeps its context between turns until the client ends it:
`core/run.ts` awaits `agent.stop()` after the turn, which closes the harness's stdin (§M2-4).
No harness closes a session by itself after `end_turn`, and the client never sends
`session/close`.

**What this does not change.** A prompt *during* a live turn still kills that turn (M0-4
Question 2). Copilot's [#4555](https://github.com/github/copilot-cli/issues/4555) still aborts
background work on any prompt; this probe started no background work, so it did not reach
that path. pi prefixes its first message with a startup banner (version, skills, extensions),
and a pi extension adds an `[anchored-tools]` line to the second — noise a chat surface would
show, from this machine's pi configuration rather than from the protocol.

**Offline counterpart.** `mock-agent.mjs --scenario remember` answers each turn with the
previous turn's prompt, and `protocol/tests/agent.test.ts` pins the client half in CI.

---

## M0-9 · `session/load` into a new harness process — measured 2026-09-27 (#176)

**Question.** Every `loadSession: true` above is a handshake claim. Does `session/load`
work in a **new** harness process, after a clean stop and after a kill during a turn? And
after the stop, does the harness remember all of its work, less than the files show, or
nothing?

**Method.** A probe script drove `AcpAgent` with `policyFor("auto")`, one temp workspace
per run. The client has no load method, so the script sent `session/load` through
`request()`. In process 1, turn 1 wrote `notes.txt` (a codeword) and `counter.txt` (`0`).
Turn 2 ran four rounds: read `counter.txt`, add 1, write it back, append `round N` to
`log.txt`, run `sleep 5`. The probe read `log.txt` every 20 ms and stopped process 1 the
moment `round 2` appeared, in one of three ways:

- **clean**: `session/cancel`, wait for the turn to end, then `stop()` (stdin end of file).
- **eof**: `stop()` during the turn, with the SIGKILL grace set to 60 s so that it never
  fired. This is what a daemon crash delivers (§M2-4).
- **sigkill**: SIGKILL to the harness pid during the turn.

Process 2 started in the same cwd and sent `session/load` with the old id. Then it asked,
with no tools: the codeword, which rounds finished, what `counter.txt` holds, and whether
the task finished. Last, it told the harness to finish without redoing a round. The right
end state is `counter.txt` = `4` and rounds 1–4 in `log.txt` once each. A round done twice
shows on disk. Two runs per harness per stop, 24 in all. An earlier, simpler probe (one run
each, stopped once one file existed) gave the same load results and is not in the table.

| | opencode 2.0.18 | claude-agent-acp 0.81.1 | copilot 1.0.88 | pi-acp 0.0.34 / pi 0.87.1 |
| --- | --- | --- | --- | --- |
| `loadSession` | true | true | true | **true** |
| `sessionCapabilities` | `close`, `delete`, `fork`, `list`, `resume` | `additionalDirectories`, `close`, `delete`, `fork`, `list`, `resume`, `subagents` | `close`, `list` | `delete`, `list` |
| load works (clean / eof / sigkill) | 2/2 · 2/2 · 2/2 | 2/2 · 2/2 · 2/2 | 2/2 · 2/2 · 2/2 | 2/2 · 2/2 · 2/2 |
| turn 2 answer on eof | none, exit 0 | none, exit 0 | **`cancelled`, then exit**, about 1 s later than the others | none, exit 0 |
| memory matches the files (clean / eof / sigkill) | 2 · 2 · 2 of 2 | **1** · 2 · 2 of 2 | 1 · 1 · **0** of 2 | 2 · 2 · 2 of 2 |
| end state after "finish" | 6 of 6 exact | **5 of 6 exact; 1 did round 2 twice** | 6 of 6 exact | 6 of 6 exact |
| `session/load` result keys | `configOptions` | `sessionId`, `modes`, `configOptions` | `models`, `modes`, `configOptions` | `configOptions`, `models`, `modes`, `_meta` |

*Memory matches* was graded by hand: the answer about rounds and the counter, against
`counter.txt` and `log.txt` at the stop. On clean, every harness answered turn 2 with
`cancelled`. On sigkill, none answered.

**Answer: `session/load` works on all four, after all three stops.** pi-acp's
`loadSession` was not recorded before (§pi-acp). It is `true`, and the load works.

**Memory can be behind the files, and not only after a kill.** It happened in two ways:

- **claude, after a clean cancel (1 of 2).** The cancel arrived while
  `echo 'round 2' >> log.txt` ran. The line reached the disk, but the replayed history
  marks that tool call `failed`. After the load, claude said the line was missing. Told to
  finish, it appended `round 2` again. The counter stayed right, because each round reads
  it from disk. This is the only run of 24 with a wrong end state.
- **copilot, after every kind of stop (4 of 6).** The last write before the stop was on
  disk, but its `tool_call` replayed as `pending`, with no update that completes it.
  copilot then said that write had not happened. It still finished exactly in all four
  runs, because it read the files before it wrote again.

opencode and pi matched the files in all 12 runs, SIGKILL included. Turn 1, which ended
normally before every stop, was remembered correctly in all 24 runs.

**The load replays the history.** During the load, every harness sends the old
conversation as ordinary `session/update` notifications: `user_message_chunk`, `tool_call`
and `tool_call_update` with titles and statuses, and `agent_message_chunk`. opencode adds
`agent_thought_chunk`, and pi adds `usage_update`.

**claude reports a prompt nobody sent.** After both SIGKILL runs, claude said "you said
continue" and that it did not resume. The probe sent no such prompt, and the replay has no
user message for it. The cause was not checked.

**Consequences.**

- **M6-7b:** all four harnesses pass its gate: they advertise `loadSession: true`, and the
  load works here.
- **R46** draws its line between a cancel and a kill. These runs draw it between
  *stopped during a turn* and *idle*. Any of the three stops during a turn can leave memory
  behind the files. So when M6-7b says "the revive says so", that must also cover a
  participant cancelled during a turn, not only one that reads `killed`.
- **The replay arrives as ordinary `session/update`.** M6-7b has to keep it out of the room
  log and off the screen, or the history shows twice.
- **claude can report a prompt nobody sent.** It did so after both SIGKILL runs. A revived
  claude participant can believe it was told something the person never said. The replay
  does not carry it, so a replay filter will not find it. M6-7b should expect it.

**Coverage.** One machine, two runs per cell. Every stop came at the same point: the
second `log.txt` write. An idle participant was not stopped as a case of its own; turn 1
is the only evidence for it. `session/resume` was not measured. **Open:** where claude's
unsent "continue" comes from, and whether any notification carries it.

---

## Mode after load · `session/set_mode`, then `session/load` — measured 2026-09-29 (#149)

**Question.** #149 lets kapelle set a harness's own mode: `modeMap.safe` for `safe`, and
`modeMap.ask` for `ask` and `auto`. M6-7b will revive a participant with `session/load`
into a new process. Does the mode a client set survive that load? And does it leak into a
new session?

**Method.** A scratch script drove `AcpAgent` directly, not through a room. Its policy
approved read kinds only and recorded every request, so a harness's mode showed in what it
asked. Three cases per harness, one run each, a fresh temp workspace each:

- **v1**: `session/new`, set `modeMap.safe`, one turn, stop.
- **v2**: `session/new`, one turn, set `modeMap.safe`, stop at once, with no turn after.
- **v3**: `session/new`, set `modeMap.safe`, one turn, set `modeMap.ask`, stop at once.

Every stop was idle and clean (`stop()`, stdin end of file). Process 2 sent `session/load`
in the same cwd and read the mode from its result (`modes.currentModeId`, or
`configOptions` with `category: "mode"` for opencode). Then it asked the harness to create
a file. Process 3 opened a new session and read its start mode. Each turn asked for one
file, so the behaviour could be checked against the reported mode. pi has no `modeMap`: its
ACP modes are thinking levels, so the probe set `minimal` (start `medium`) and, in v3, set
`medium` back.

| | opencode 1.18.30 | claude-agent-acp 0.75.1 | copilot 1.0.86 | pi-acp 0.0.33 |
| --- | --- | --- | --- | --- |
| start mode | `build` | `default` | `#agent` | `medium` |
| `set_mode` accepted | yes, all | yes, all, **`default` included** | yes, all | yes, all |
| v1: mode after load | `plan` — kept | **`default` — lost** | `#plan` — kept | `low` — neither |
| v2: mode after load | **`build` — lost; it wrote the file** | **`default` — lost** | `#plan` — kept | `low` — neither |
| v3: mode after load | **`plan` — the change back is lost** | `default` | `#agent` — kept | `high` — neither |
| new session in process 3 | `build` | `default` | `#agent` | `medium` |

**Answer: the mode does not reliably survive a load.** Each harness behaves differently:

- **claude drops it every time.** A loaded session starts in `default`.
- **opencode keeps the mode of its last turn.** A `set_mode` with no turn after it is lost,
  in both directions. In v2 that left a `safe` session in `build`, and the loaded harness
  wrote the file with no question: opencode never asks (§M0-1).
- **copilot keeps it**, in both directions. Its load replays the mode changes as
  `current_mode_update`.
- **pi reports a thinking level after a load that is neither the one set nor the start
  one.** The cause was not checked. It has no safety effect: pi has no `modeMap`.

**What the harness reported was what it did** in all 12 runs: opencode in `plan` refused in
prose, claude in `default` asked for `edit`, and copilot in `#plan` wrote a plan and no
file. claude in `plan`, in process 1, asked for `switch_mode` first. **A new session never
inherited a mode.**

**Consequences.**

- **Send the mode again after every `session/load`.** Without it, a `safe` claude or
  opencode participant comes back unrestricted. This is M6-7b's (#179). `AGENTS.md` says so
  beside the mode-id rule.
- **No start mode needs to be kept.** A load cannot be trusted to report the mode the
  client wants, so the client sends it; it never needs to restore one.

**Coverage.** One machine, one run per case, idle stops only. A stop during a turn was not
measured. Versions are the handshake's `agentInfo.version`.

---

## M6-7b · a room revive with `session/load` — checked 2026-10-08 (#179)

**Question.** §M0-9 drove `AcpAgent` by hand. Does the room's own revive load the session
after a real daemon restart, keep the replay off the log, and come back remembering?

**Method.** `integration/daemon.itest.ts`, one run per harness. A daemon opened a room with
one `safe` participant. Turn 1 asked it to remember the codeword `PLUM-42` and reply `OK`.
The daemon then stopped with SIGTERM, idle, and a second daemon started on the same state.
Turn 2 asked for the codeword. The test asserted on our record: `resumed: "loaded"`, the
same `sessionId`, and no replayed kind on the log between the reviving message and the
revive line. The answer was read by hand.

| | opencode 2.0.18 | claude-agent-acp 0.81.1 | copilot 1.0.91 | pi-acp 0.0.34 |
| --- | --- | --- | --- | --- |
| `resumed` | `loaded` | `loaded` | `loaded` | `loaded` |
| same `sessionId` | yes | yes | yes | yes |
| replay on the log | none | none | none | none |
| answer after the restart | `PLUM-42` | `PLUM-42` | `PLUM-42` | `PLUM-42` |

**Answer: yes, on all four.**

**Not every update after a load is replay.** The first run failed on claude and copilot:
`available_commands_update` and `config_option_update` came between the message and the
revive line. A probe with no prompt showed both on a new session too: the commands list
when a session opens, and `config_option_update` as the answer to `session/set_mode`,
which the room sends after every load. The replay is the old conversation only:
`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
`tool_call_update` and `usage_update` (§M0-9). `AcpAgent` drops what comes during the
`session/load` request, and nothing else.

**Coverage.** One run per harness, an idle stop only. A stop during a turn, and so the
`memoryMayBeBehind` warning, is proved against `mock-agent.mjs` only
(`core/tests/room.test.ts`). The real-harness memory loss behind that warning is §M0-9's.

---

## M4-4 · Markdown re-parse cost — measured 2026-10-05 (#50)

**Question.** The TUI sets an answer's whole text on pi-tui's `Markdown` for each chunk,
so each frame parses the whole answer again. The spike noted about 5 ms at 53k chars, and
M4-4 builds a split only past that. What does it cost now?

**Method.** A scratch script with pi-tui 0.85.1 on one machine. It built an answer of the
given size, then 30 times added one character, called `setText`, and timed `render(100)`,
as one streamed chunk does. Two kinds of text: prose paragraphs, and a mix of headings,
paragraphs with code spans and links, lists and code blocks.

| answer | prose, median | mixed, median | mixed, p90 |
| --- | --- | --- | --- |
| 10k chars | 2.6 ms | — | — |
| 53k chars | 13.5 ms | 23.2 ms | 43.7 ms |
| 200k chars | — | 115 ms | 126 ms |

The same text drawn again at the same width took 0.03 ms or less: `Markdown` keeps what it
drew while its text and width stay.

**Consequences.**

- **Past the threshold, so the split is built** (`settled`, `chat/tui/transcript.ts`). The
  finished blocks of an answer go into their own `Markdown`, which is parsed once and then
  drawn from its keep. A chunk parses only the rest.
- **A cut is safe only after a blank line, before a line that is not indented, and outside
  a code fence and a `$$` math block.** There, the pieces draw the same rows as the whole
  text: a piece keeps its trailing blank line, and the next piece starts a new block. A
  math block is the exception, found in review: at the end of a piece it draws no blank
  row after it, so there is never a cut right after a line with `$$`. The one difference measured
  is a rest that is only `>`: alone it draws an empty row, and at the end of a whole text
  it draws none. That lasts until the quote's text comes.

**Coverage.** One machine, one run per size, synthetic text. A long code block is never
cut, so its whole text is parsed again on each chunk.

## M4 · Chat layout — measured 2026-10-09 (#242)

**Question.** The chat screen lagged more the longer a room was used, worst while an agent
worked. Where did the time go: the daemon, the stream, or the screen?

**Method.** A 90 s CPU profile (`node --cpu-prof`) of a second chat screen on the live
daemon, with three rooms open. Then a scratch script with pi-tui 0.85.1 at 200×50 columns
and rows. It replayed real room logs through the reducer and `transcriptParts`, and timed
`renderNow()` with the old nesting of stacks and with `screenLayout`.

| layout | 430 rows | 1,160 rows |
| --- | --- | --- |
| nested: `HStack` › `VStack` › `HStack` › timeline | 28 ms | 145 ms |
| flat: `screenLayout`, the timeline a direct part of the one `HStack` | 4 ms | 6 ms |

The profile showed stalls of 100 to 220 ms, almost all in `doRender` → `measureHeight` →
`HStack.render` → `compositeTuiLine`. The daemon used about 0.1% CPU. Each streamed line
asks for a frame, a thought chunk too, and one room's log was 95% thought chunks.

**Consequences.**

- **pi-tui sizes an `HStack`'s parts with their own `render()`**, which draws all of a
  part. Its layout gives a scroll view only the rows it shows, but this measure does not.
  For a stack, `render()` goes all the way down, and an `HStack` there joins each line of
  the whole transcript to the line beside it, one character at a time. pi-tui 1.1.0 does
  the same, so an upgrade does not fix it.
- **The layout is flat** (`screenLayout`, `chat/tui.ts`): no `HStack` below another, and
  the banner moved under the row. `chat/tests/layout.test.ts` checks the rule.

**Coverage.** One machine, real logs from three rooms. The frame time grows with the rows
of the open view only; rooms off screen cost nothing to draw.

---

## What this note does not cover

M0's questions are answered; these are the edges, collected so that no downstream story
mistakes silence for a negative result.

- **`omp` and `gemini` were never run** — uninstalled on this machine. The M0 tables have
  three columns because three harnesses existed to test at the time, not because the registry
  has three entries; pi is measured separately above. `unknown` is the honest label, and it
  should read as `internal` / `none` for warning purposes.
- **Only copilot's M0 column was re-verified in-place; pi is not an M0 row but was
  measured later** (above). opencode is still 1.18.18 and claude-agent-acp still 0.49.0 in
  the M0 rows, the versions those rows were measured on. They will decay the same way the
  moment either updates.
- **Nothing was driven near a real limit**, nothing was compacted automatically, and no
  harness was cancelled mid-*edit* — the three named gaps under §M0-5 and §M0-4 coverage.
  §M0-9 cancelled one claude run during a shell append, which is the nearest case so far.
- **`safe` was measured, `auto` was not bounded.** §M0-3's verdicts are all under
  `--mode auto`, so they describe what a harness does when nothing is refused. A harness
  that reaches for `terminal/*` only after its own shell is denied would not appear here.
- **This note records what harnesses do, not what the client should do about it.** The
  containment labels, the warning text and the mode mapping are M1a-4's to decide; the
  fields above are the evidence, not the design.
