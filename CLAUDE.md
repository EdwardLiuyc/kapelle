# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Use plain language, short sentences, and avoid dense or overly compressed phrasing.

## What this is

`agent-team` — a minimal [Agent Client Protocol](https://agentclientprotocol.com) **client** in ~700 lines of ES modules. Zero runtime dependencies, Node ≥24, `"type": "module"`, no build step; `biome` formats and lints (`npm run fmt:check`), `node:test` covers pure functions (`npm run test`).

The inversion that governs every design choice: **this code is the client, the coding harness is the agent.** We spawn the harness as a subprocess, own the workspace, serve its filesystem requests, and decide its permissions. Harnesses (opencode, gemini, copilot, …) authenticate themselves — this client never touches a key.

## Commands

```bash
npm run check               # type-check: tsc --noEmit, guarded on .ts discovery (protocol/ is typed since M1a-2)
npm run fmt                 # biome format + lint autofix (biome check --write .)
npm run fmt:check           # biome format + lint check (biome check .)
npm run test                # node:test for pure functions in core/ and protocol/
npm run selftest            # end-to-end against mock-agent.mjs, --mode auto (writes ACP_TEST.md)
node run.mjs "self test" --cmd "node mock-agent.mjs" --mode safe   # same run, write refused
node run.mjs "<prompt>" [--agent opencode|omp|pi|claude|gemini|copilot] [--cmd "<cmd>"] [--cwd dir] [--mode ask|safe|auto] [--verbose] [--quiet]
node fanout.mjs tasks.json  # N agents concurrently
```

`node:test` covers pure functions in `core/` and `protocol/` (M1a-1; `protocol/types.test.ts` is the first suite, landed with M1a-2) — run it with `npm run test`. `mock-agent.mjs` is the end-to-end test harness: it implements the agent side of the protocol and drives every client code path (streaming, `fs/read_text_file`, `session/request_permission`, `fs/write_text_file`). **Verify changes to `protocol/agent.ts` against it before touching a real harness** — it needs nothing installed. Extend `mock-agent.mjs` when adding client capabilities so the new path is exercisable offline. `ACP_TEST.md` in the repo root is selftest output, not source; deleting it is safe.

`--mode ask` requires a TTY and degrades to `safe` otherwise, so piped/CI invocations never block on a prompt.

**Harness spawn failures surface as opaque JSON-RPC errors** — typically `Internal error (code -32603)` on `session/new`, with the real message only on the harness's stderr under `--verbose`. Reach for `--verbose` first. The `--agent claude` case is the one to know: older adapters refused to start a nested session when they saw the markers a parent Claude Code session leaves in the environment, and `AcpAgent` passes its `env` through to the subprocess. The `claude` entry scrubs those markers (`CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`) via the registry `env` field (`agents.mjs`), so no `env -u ...` prefix is needed. Adapter 0.49.0 no longer refuses, so the scrub is regression insurance rather than a fix for a live failure. The deprecated `claude-code-acp` adapter is no longer in the registry.

## Architecture

Six files, one direction of dependency: `run.mjs` / `fanout.mjs` → `protocol/agent.ts` + `agents.mjs` + `render.mjs`, typed by `protocol/types.ts`.

- **`protocol/agent.ts`** — everything protocol. `AcpAgent` owns one subprocess: spawn, newline-delimited JSON-RPC over stdio, `initialize` handshake (hard-fails on `protocolVersion` mismatch), `session/new`, `session/prompt`, `session/cancel`. It handles exactly three inbound requests — `fs/read_text_file`, `fs/write_text_file`, `session/request_permission` — and one notification, `session/update`, which it forwards to `onEvent`.
- **`agents.mjs`** — the entire adapter layer: a map of agent id → `{command, args, env?}`. Supporting a new harness is one line here, not an integration. `env` is `{unset?, set?}`, applied to `process.env` by `resolveEnv` at construction time — the place to put a harness's environment quirks so no caller has to remember them. `resolveAgent` also parses `--cmd` strings and derives a readable label (`node mock-agent.mjs` → `mock-agent`).
- **`render.mjs`** — terminal formatting for `session/update`. Pure presentation; no protocol logic.
- **`run.mjs`** — single-agent CLI, hand-rolled arg parsing, SIGINT → `session/cancel` then 2s grace before kill.
- **`fanout.mjs`** — `Promise.allSettled` over tasks. Deliberately buffers prose per agent and prints only milestones live, because interleaved token streams are unreadable. Give each task its own `cwd` (a git worktree is the usual choice) so concurrent agents don't collide.

### Two client invariants worth preserving

**Permission decisions depend on state carried across messages.** `session/request_permission` may arrive with only a `toolCallId`. Title and kind were announced earlier in the `tool_call` notification, so `AcpAgent` maintains a `toolCallId → {title, kind, rawInput}` map. Break that bookkeeping and every policy decision goes blind.

**The policy function filters what a harness asks — it is not a sandbox.** One function, one place, applied identically to every harness. `safePolicy` allows only the `READ_ONLY_KINDS` set (`read`, `search`, `fetch`, `think`); `makeAskPolicy` auto-approves those and prompts per mutation; `autoPolicy` approves all. What it can reach is per-harness — opencode never asks, and copilot's behaviour changed across builds — so per-harness containment lives in the registry, not in this sentence (`docs/M0-FINDINGS.md` §M0-1). `#guardPath` rejects any `fs/*` path outside the workspace root, but no surveyed harness calls `fs/*`: it bounds this client's own file service, not the agent, and does not bound `--mode auto`. Keep the two layers separate: policy is about intent, the path guard is unconditional. Mode negotiation (`session/set_mode`) is the channel that does reach opencode and is not implemented here; that is M1a-5.

### Synthetic events

`render.mjs` handles `_client_permission` and `_client_wrote_file` — these are emitted by this client, not by the protocol. Prefix any new client-originated event with `_client_` so it stays distinguishable from real `sessionUpdate` values.

## Deliberately unimplemented

Don't treat these as gaps to fill unless asked: `terminal/*` (we advertise `terminal: false` — and M0-3 measured that flipping it to `true` changes nothing: opencode, claude-agent-acp and copilot all run shell commands internally and never call `terminal/create`, so this is a recorded decision, not a gap. See `docs/M0-FINDINGS.md` §M0-3); `session/load` / resume (check `agent.agentCapabilities` before calling); elicitation, slash commands, session modes. Cancellation is best-effort.
