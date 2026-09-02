# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Use plain language, short sentences, and avoid dense or overly compressed phrasing.

## What this is

`agent-team` — a minimal [Agent Client Protocol](https://agentclientprotocol.com) **client** in ~2,100 lines of TypeScript and ES modules. Zero runtime dependencies, Node ≥24, `"type": "module"`, no build step; `biome` formats and lints (`npm run fmt:check`), `node:test` covers pure functions and wire behaviour (`npm run test`).

The inversion that governs every design choice: **this code is the client, the coding harness is the agent.** We spawn the harness as a subprocess, own the workspace, serve its filesystem requests, and decide its permissions. Harnesses (opencode, gemini, copilot, …) authenticate themselves — this client never touches a key.

## Commands

```bash
npm run check               # type-check: tsc --noEmit, guarded on .ts discovery (protocol/ is typed since M1a-2)
npm run fmt                 # biome format + lint autofix (biome check --write .)
npm run fmt:check           # biome format + lint check (biome check .)
npm run test                # node:test: pure functions, plus wire behaviour in protocol/
npm run knip                # dead-code / unused-export check, both dev and --production
npm run selftest            # end-to-end against mock-agent.mjs, --mode auto (writes ACP_TEST.md)
node run.mjs "self test" --cmd "node mock-agent.mjs" --mode safe   # same run, write refused
node run.mjs "<prompt>" [--agent opencode|omp|pi|claude|gemini|copilot] [--cmd "<cmd>"] [--cwd dir] [--mode ask|safe|auto] [--verbose] [--quiet]
node fanout.mjs tasks.json  # N agents concurrently
```

`node:test` covers pure functions in `core/` and `protocol/`, and — per the 2026-08-31 amendment in `docs/STORIES.md` (M1a-1) — behaviour whose subject *is* the wire, which a pure function cannot express. Two suites today: `protocol/types.test.ts` (pure, landed with M1a-2) and `protocol/agent.test.ts` (subprocess-driven, landed with M1a-3; it spawns real harness fixtures over real stdio to prove what does and does not reach the subprocess). Run both with `npm run test`. `mock-agent.mjs` is the end-to-end test harness: it implements the agent side of the protocol and drives every client code path (streaming, `fs/read_text_file`, `session/request_permission`, `fs/write_text_file`). **Verify changes to `protocol/agent.ts` against it before touching a real harness** — it needs nothing installed. Extend `mock-agent.mjs` when adding client capabilities so the new path is exercisable offline. `ACP_TEST.md` in the repo root is selftest output, not source; deleting it is safe.

`--mode ask` requires a TTY and degrades to `safe` otherwise, so piped/CI invocations never block on a prompt.

The containment notice `warningsFor` prints, plus the not-negotiated line, are **never suppressed by `--quiet`** (#13): `safe` keeps its name only because that notice carries the caveat.

**Harness spawn failures surface as opaque JSON-RPC errors** — typically `Internal error (code -32603)` on `session/new`, with the real message only on the harness's stderr under `--verbose`. Reach for `--verbose` first. The `--agent claude` case is the one to know: older adapters refused to start a nested session when they saw the markers a parent Claude Code session leaves in the environment, and `AcpAgent` passes its `env` through to the subprocess. The `claude` entry scrubs those markers (`CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`) via the registry `env` field (`protocol/registry.ts`), so no `env -u ...` prefix is needed. Adapter 0.49.0 no longer refuses, so the scrub is regression insurance rather than a fix for a live failure. The deprecated `claude-code-acp` adapter is no longer in the registry.

## Architecture

Seven files, one direction of dependency: `run.mjs` / `fanout.mjs` → `core/policy.ts` → `protocol/agent.ts` + `protocol/registry.ts` + `render.mjs`, typed by `protocol/types.ts`. **`core/` may import `protocol/`; never the reverse** — that is why `AcpAgent`'s default policy refuses everything rather than being `safePolicy`.

- **`protocol/agent.ts`** — everything protocol. `AcpAgent` owns one subprocess: spawn, newline-delimited JSON-RPC over stdio, `initialize` handshake (hard-fails on `protocolVersion` mismatch), `session/new`, `session/prompt`, `session/cancel`. It handles exactly three inbound requests — `fs/read_text_file`, `fs/write_text_file`, `session/request_permission` — and one notification, `session/update`, which it forwards to `onEvent`.
- **`protocol/registry.ts`** — the entire adapter layer (M1a-4, was `agents.mjs`). A map of agent id → `{launch, measured?}`. **The split is load-bearing.** `launch` is `{command, args, env?}` — a recipe we choose. `measured` is a lab report: `shell`, `argvChannel`, `asksPermission`, `modeMap`, `usage`, `meta?` and `measuredOn`, every field a claim about one *build*. `omp`, `pi` and `gemini` were never run here, so they carry no `measured` — its **absence is the only marker of an unverified harness**, and `warningsFor` reads that absence as the least contained harness we did measure. Supporting a new harness is still one entry, not an integration. `env` is `{unset?, set?}`, applied by `resolveEnv`, which also strips `AGENT_TEAM_*` from every harness's environment unconditionally (M2-8's shared secret must never reach a subprocess). `resolveEnv` returns `process.env` **by identity** when there is nothing to do, so quirk-free harnesses don't each get a copy. `resolveAgent` also parses `--cmd` strings and derives a readable label (`node mock-agent.mjs` → `mock-agent`); a `--cmd` spec has no `measured` half, so it warns as unverified.
- **`render.mjs`** — terminal formatting for `session/update`. Pure presentation; no protocol logic.
- **`run.mjs`** — single-agent CLI, hand-rolled arg parsing, SIGINT → `session/cancel` then 2s grace before kill.
- **`fanout.mjs`** — `Promise.allSettled` over tasks. Deliberately buffers prose per agent and prints only milestones live, because interleaved token streams are unreadable. Give each task its own `cwd` (a git worktree is the usual choice) so concurrent agents don't collide.

### Two client invariants worth preserving

**Permission decisions depend on state carried across messages.** `session/request_permission` may arrive with only a `toolCallId`. Title and kind were announced earlier in the `tool_call` notification, so `AcpAgent` maintains a `toolCallId → {title, kind, rawInput}` map. Break that bookkeeping and every policy decision goes blind.

**The policy filters what a harness asks — it is not a sandbox.** One file, `core/policy.ts`, applied identically to every harness. `safePolicy` allows only the `READ_ONLY_KINDS` set (`read`, `search`, `fetch`, `think`); `makeAskPolicy` auto-approves those and prompts per mutation; `auto` approves all — reach them through `policyFor(mode)`, which is the only map from a mode to a decider. What the filter can reach is per-harness — opencode never asks, and copilot's behaviour changed across builds — so per-harness containment lives in the registry, not in this sentence (`docs/M0-FINDINGS.md` §M0-1). `#guardPath` rejects any `fs/*` path outside the workspace root, but no surveyed harness calls `fs/*`: it bounds this client's own file service, not the agent, and does not bound `--mode auto`. Keep the two layers separate: policy is about intent, the path guard is unconditional.

**`safe` negotiates before it filters (M1a-5).** `negotiateSafeMode` sends `session/set_mode` with the registry's `measured.modeMap.safe` right after `session/new`, and that is the only half that reaches opencode, which never asks anything: measured, it wrote the file without negotiation and declined with it. Skipped for a harness with no `measured` half, because the ids would be a guess; skipped for `ask` and `auto`, because sending `auto`'s id would put claude into `bypassPermissions`. A skip or a failure prints a notice and continues — it never fails the run. The refusal arrives as agent prose, so this is defence in depth, not enforcement.

**Mode and `allowReadOutsideRoot` resolve in one place.** `resolvePolicy` settles `task > run > harness > default`. A mode above the entry's `maxMode` is a validation error naming both values, never a silent downgrade, and `safe` forces `allowReadOutsideRoot` to `false` however it was asked for. `ask` without a TTY re-resolves as `safe` rather than renaming itself, so `safe`'s own rules apply to what actually runs.

**A permission answer never guesses.** `pickOption` returns `null` when no option matches the decision, and the client answers the protocol's `cancelled` outcome. The old tail returned `options[0]`, which fails open — claude lists `allow_always` first, so a denial would have become a persisted grant (measured 2026-09-02, issue #13).

### Synthetic events

This client emits three events of its own, not defined by the protocol: `_client_permission`, `_client_wrote_file` and `_client_cancel_requested` (M1a-3, #62 R4 — recorded at the moment `session/cancel` is sent, because copilot answers `end_turn` for a turn it cancelled, so our own record of having asked is the authoritative term for M1b-2). `render.mjs` draws the first two; the third is capture-only, and its switch has no `default`, so an unrendered variant is ignored rather than drawn incorrectly. Prefix any new client-originated event with `_client_` so it stays distinguishable from real `sessionUpdate` values.

## Deliberately unimplemented

Don't treat these as gaps to fill unless asked: `terminal/*` (we advertise `terminal: false` — and M0-3 measured that flipping it to `true` changes nothing: opencode, claude-agent-acp and copilot all run shell commands internally and never call `terminal/create`, so this is a recorded decision, not a gap. See `docs/M0-FINDINGS.md` §M0-3); `session/load` / resume (check `agent.agentCapabilities` before calling); elicitation, slash commands, session modes. Cancellation is best-effort.
