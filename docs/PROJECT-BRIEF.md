# Multi-Harness Agent Supervisor — project brief

Context document for planning. Drop this in the repo root (or `docs/`) and point
Claude Code at it.

---

## Goal

A supervisor that runs several **different** coding agent harnesses as
subprocesses, drives them from one Node/TypeScript process, and keeps control of
the workspace and the permission boundary.

The key word is *different*. Nearly every existing tool solves multi-agent work
by having one harness spawn specialised copies of itself. This project crosses
harness boundaries: opencode, Pi/oh-my-pi, GitHub Copilot CLI, Claude Code and
Kilo as peers in one system.

## Requirements, in priority order

**P0 — must have**

1. Manage multiple agents/harnesses from one process
2. Talk to open-source harnesses (opencode, Pi) *and* vendor ones (Copilot,
   Claude Code)
3. Bring-your-own API keys; ability to define custom agents

**P1 — nice to have, deliberately deferred**

4. A UI or local page to monitor all running agents
5. A declared graph topology where agents pass work between each other

Requirements 4 and 5 were dropped to P1 on purpose. They are the expensive ones,
and the shape they should take will be clearer after P0 runs for a while.

## Decisions already made

| Decision | Rationale |
|---|---|
| **ACP as the integration layer** | One client implementation reaches every harness. Turns N×M into N+M. opencode, oh-my-pi, Copilot CLI, Gemini CLI and Kilo have native or adapter support. |
| **Node / TypeScript** | Matches the existing stack; every harness in scope is Node-based or has a Node adapter. Microsoft Agent Framework was evaluated and rejected — its agent-authoring surface is Python and .NET only, and its value was the graph orchestration and Azure hosting that are now P1. |
| **Build thin, don't adopt a platform** | This category churns hard (Vibe Kanban's company shut down April 2026, Crystal deprecated February 2026). A small owned client has a better survival profile than a dependency. |
| **Harnesses own their own auth** | The supervisor never handles an API key. Each harness logs in through its own CLI. |
| **Permission policy is the safety boundary** | One policy function applied identically to every harness, plus a workspace-root path guard that applies regardless of policy. |

## Non-goals

- Not a replacement for a harness. We don't run model loops or edit files
  ourselves.
- Not an editor or IDE.
- Not agent-to-agent messaging (that's A2A's layer, and it's P1 anyway).
- Not a hosted/multi-user product. Local-first, single operator.

## Current state — MVP exists

770 lines, zero dependencies, Node 20+. Working and tested:

- JSON-RPC over stdio, newline-delimited
- `initialize` handshake with capability negotiation
- `session/new`, `session/prompt`, `session/cancel`
- Client-side `fs/read_text_file` and `fs/write_text_file` with a
  workspace-root path guard
- `session/request_permission` with three policies: `safe` (reads only),
  `ask` (prompt per mutation), `auto` (approve all)
- `session/update` rendering: message chunks, thoughts, tool calls, plans,
  usage
- Agent registry (`agents.mjs`) — adding a harness is one line
- `fanout.mjs` — N agents in parallel, per-task policy and workspace
- `mock-agent.mjs` — the agent side of the protocol, for testing with no
  harness installed

Verified by running: handshake through stop reason, `safe` vs `auto` diverging
on the same prompt, parallel fan-out with different policies per agent, spawn
failure handling, and a hostile agent attempting to write outside the workspace
root while in `auto` mode (blocked).

## Known gaps in the MVP

- **Terminals not implemented.** We advertise `terminal: false`, so agents run
  shell commands internally. Their output doesn't flow through the supervisor.
  This is the biggest visibility gap and the first thing to add.
- No `session/load` or `session/resume` — no persistence across restarts.
- Cancellation is best-effort (sends `session/cancel`, waits 2s, kills).
- No worktree management. Tasks take a `cwd`; creating and cleaning up git
  worktrees is manual.
- No structured result contract. Agent output comes back as prose.
- Elicitation, slash commands, session modes, MCP server passthrough: unhandled.
- Copilot's ACP invocation in the registry is a guess and needs verifying.

## Protocol gotchas worth remembering

1. **`session/request_permission` may carry only a `toolCallId`.** The title and
   kind arrived earlier in the `tool_call` notification. The client keeps a
   `toolCallId → {title, kind}` map so the policy has something to judge.
2. **ACP is pre-1.0.** Known gaps: no thread resume, no message editing, no
   remote transport (agents must be local subprocesses today).
3. **We are the "client" despite being the orchestrator.** Client = spawns the
   subprocess, owns the workspace, answers requests. Same inversion as LSP.
4. **Capabilities are negotiated, not assumed.** Check
   `agent.agentCapabilities` before calling optional methods.

## Open questions to work through

**Architecture**

- Does the supervisor stay a library, or become a long-running daemon with an
  API? The daemon answer is what unlocks P1 #4 (a UI) later.
- Worktree lifecycle: who creates, who cleans up, what happens on crash?
- How do results come back structurally rather than as prose? Options: require a
  JSON block in the final message, read `git diff` from the worktree, or wire
  through an MCP server the supervisor controls so agents call a `report_result`
  tool.

**Orchestration (the P1 #5 question, when it comes back)**

- Is the useful pattern handoff (A finishes, B takes the artifact) or
  coordinator/worker (planner delegates isolated tasks)? Group chat over
  stateful, file-owning harness processes is likely the wrong model.
- Where does a plan live — in code, or in a declarative task file?

**Operational**

- Per-harness policy defaults, or one global policy?
- How to handle a harness that never requests permission because its own config
  is autonomous — the policy silently never fires.
- Cost and token tracking across harnesses (`usage_update` gives some of this).
- What happens when two agents want the same file, if worktrees are ever shared.

## Prior art to check before building each piece

- **sage** — pure bash orchestrator, runtime-agnostic (Claude Code, Cline,
  Codex, Gemini CLI, ACP), wave-based plan execution, worktree isolation,
  headless CI mode, 295 bats tests. Closest architectural match.
- **Paseo** — self-hosted, supports Claude Code, Codex, Copilot, opencode and
  Pi. Node daemon + WebSocket + multiple clients. The reference for P1 #4.
  AGPL-3.0, solo maintainer.
- **Agent Orchestrator (AO)** — 26 harnesses behind a plugin adapter
  architecture; pushes furthest into autonomous PR lifecycle handling.
- **Emdash** — wraps any CLI agent found on PATH. The cheap discovery model.
  Its founders ruled out sub-agent orchestration, which is a useful data point
  on where that road ends.
- **oh-my-openagent** — publicly restructuring toward multi-harness support
  (opencode, Codex, Pi, Claude Code). Worth watching; may overlap.

## First session with Claude Code — suggested agenda

1. Run the MVP against real opencode and record where it breaks.
2. Decide library vs daemon, since it constrains everything after.
3. Design the result contract — this is the piece that turns "several agents
   ran" into "the supervisor knows what happened."
4. Add terminal support, or explicitly decide to keep it out and accept the
   visibility cost.
