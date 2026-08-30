# Multi-Harness Agent Supervisor — project brief

Why this project exists: the goal, the founding decisions and their rationale, the
requirements and their priority, and what is explicitly out of scope. This is the
**charter** — read it before adding scope. It is deliberately *not* a status report;
live state lives in the README and the plan.

> **Role map:** this file = why, and what's in/out of scope · **README.md** = how to use
> it today · **CLAUDE.md** = the agent-facing architecture map · **PROJECT-PLAN.md** =
> what we're building and in what order · **STORIES.md** = the work breakdown ·
> **M0-FINDINGS.md** = what the harnesses empirically do.

## Goal

A supervisor that runs several **different** coding agent harnesses as
subprocesses, drives them from one Node/TypeScript process, and keeps control of
the workspace and the permission boundary.

The key word is *different*. Nearly every existing tool solves multi-agent work
by having one harness spawn specialised copies of itself. This project crosses
harness boundaries: opencode, Pi/oh-my-pi, GitHub Copilot CLI, Claude Code and
Kilo as peers in one system.

## Requirements, in priority order

### P0 — must have

- **1.** Manage multiple agents/harnesses from one process
- **2.** Talk to open-source harnesses (opencode, Pi) *and* vendor ones (Copilot,
  Claude Code)
- **3.** Bring-your-own API keys; ability to define custom agents

### P1 — nice to have, deliberately deferred

- **4.** A UI or local page to monitor all running agents
- **5.** A declared graph topology where agents pass work between each other

Requirements 4 and 5 were dropped to P1 on purpose. They are the expensive ones,
and the shape they should take will be clearer after P0 runs for a while.

## Decisions already made

| Decision | Rationale |
| --- | --- |
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

## Prior art to check before building each piece

The broad landscape. Two of these neighbours have dedicated deep dives elsewhere:
`PROJECT-PLAN.md` reviews opencode-ensemble (what we took and what we didn't), and
`docs/PRIOR-ART-AGENTPOOL.md` reviews agentpool in detail.

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

## Where the rest of the original brief went

The original version of this file also carried live status sections — current MVP
state, known gaps, protocol gotchas, open questions, and a first-session agenda. Those
sections rotted during M0, so they are superseded, each by the doc that owns that concern
now:

- **Current MVP state & how to run it** → `README.md` (and `CLAUDE.md` for the
  agent-facing architecture map).
- **Known gaps / what's deliberately unimplemented** → `README.md` ("What's
  deliberately missing") and `CLAUDE.md` ("Deliberately unimplemented").
- **Protocol gotchas** — the `toolCallId → {title, kind, rawInput}` map, the client/supervisor
  inversion, and capability negotiation → `CLAUDE.md` ("Two client invariants worth
  preserving") and `README.md` ("Two things worth knowing"). One fact is preserved
  here rather than migrated: ACP is pre-1.0 — no thread resume, no message editing,
  no remote transport — so agents are local subprocesses today.
- **Open questions** → `PROJECT-PLAN.md` ("Open, deliberately unresolved") and the
  backlog in `STORIES.md`.
- **Empirical answers** (what the harnesses actually do) → `docs/M0-FINDINGS.md`.
