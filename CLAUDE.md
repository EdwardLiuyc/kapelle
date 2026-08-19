# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`acp-mvp` — a minimal [Agent Client Protocol](https://agentclientprotocol.com) **client** in ~400 lines of ES modules. Zero runtime dependencies, Node ≥20, `"type": "module"`, no build step, no test framework, no linter, no git repo.

The inversion that governs every design choice: **this code is the client, the coding harness is the agent.** We spawn the harness as a subprocess, own the workspace, serve its filesystem requests, and decide its permissions. Harnesses (opencode, gemini, copilot, …) authenticate themselves — this client never touches a key.

## Commands

```bash
npm run selftest            # end-to-end against mock-agent.mjs, --mode auto (writes ACP_TEST.md)
node run.mjs "self test" --cmd "node mock-agent.mjs" --mode safe   # same run, write refused
node run.mjs "<prompt>" [--agent opencode|omp|pi|claude|claude-code|gemini|copilot] [--cmd "<cmd>"] [--cwd dir] [--mode ask|safe|auto] [--verbose] [--quiet]
node fanout.mjs tasks.json  # N agents concurrently
```

There is no unit-test suite. `mock-agent.mjs` is the test harness: it implements the agent side of the protocol and drives every client code path (streaming, `fs/read_text_file`, `session/request_permission`, `fs/write_text_file`). **Verify changes to `acp.mjs` against it before touching a real harness** — it needs nothing installed. Extend `mock-agent.mjs` when adding client capabilities so the new path is exercisable offline. `ACP_TEST.md` in the repo root is selftest output, not source; deleting it is safe.

`--mode ask` requires a TTY and silently degrades to `safe` otherwise, so piped/CI invocations never block on a prompt.

**Driving `--agent claude` from inside a Claude Code session fails** unless you unset `CLAUDECODE`. The adapter refuses to start a nested session, and `AcpAgent` passes `process.env` through to every subprocess, so the variable is inherited. The symptom is an opaque `Internal error (code -32603)` on `session/new`; the real message only appears on the adapter's stderr under `--verbose`. Use `env -u CLAUDECODE node run.mjs ... --agent claude`. This is the general shape of harness spawn failures here — reach for `--verbose` first.

## Architecture

Five files, one direction of dependency: `run.mjs` / `fanout.mjs` → `acp.mjs` + `agents.mjs` + `render.mjs`.

- **`acp.mjs`** — everything protocol. `AcpAgent` owns one subprocess: spawn, newline-delimited JSON-RPC over stdio, `initialize` handshake (hard-fails on `protocolVersion` mismatch), `session/new`, `session/prompt`, `session/cancel`. It handles exactly three inbound requests — `fs/read_text_file`, `fs/write_text_file`, `session/request_permission` — and one notification, `session/update`, which it forwards to `onEvent`.
- **`agents.mjs`** — the entire adapter layer: a map of agent id → `{command, args}`. Supporting a new harness is one line here, not an integration. `resolveAgent` also parses `--cmd` strings and derives a readable label (`node mock-agent.mjs` → `mock-agent`).
- **`render.mjs`** — terminal formatting for `session/update`. Pure presentation; no protocol logic.
- **`run.mjs`** — single-agent CLI, hand-rolled arg parsing, SIGINT → `session/cancel` then 2s grace before kill.
- **`fanout.mjs`** — `Promise.allSettled` over tasks. Deliberately buffers prose per agent and prints only milestones live, because interleaved token streams are unreadable. Give each task its own `cwd` (a git worktree is the usual choice) so concurrent agents don't collide.

### Two invariants worth preserving

**Permission decisions depend on state carried across messages.** `session/request_permission` may arrive with only a `toolCallId`. Title and kind were announced earlier in the `tool_call` notification, so `AcpAgent` maintains a `toolCallId → {title, kind, rawInput}` map. Break that bookkeeping and every policy decision goes blind.

**The policy function is the safety boundary** — one function, one place, applied identically to every harness. `safePolicy` allows only the `READ_ONLY_KINDS` set (`read`, `search`, `fetch`, `think`); `makeAskPolicy` auto-approves those and prompts per mutation; `autoPolicy` approves all. Independently, `#guardPath` rejects any `fs/*` path outside the workspace root, so even `--mode auto` cannot write outside it. Keep these two layers separate: policy is about intent, the path guard is unconditional.

### Synthetic events

`render.mjs` handles `_client_permission` and `_client_wrote_file` — these are emitted by this client, not by the protocol. Prefix any new client-originated event with `_client_` so it stays distinguishable from real `sessionUpdate` values.

## Deliberately unimplemented

Don't treat these as gaps to fill unless asked: `terminal/*` (we advertise `terminal: false`, so agents run shell commands internally); `session/load` / resume (check `agent.agentCapabilities` before calling); elicitation, slash commands, session modes. Cancellation is best-effort.
