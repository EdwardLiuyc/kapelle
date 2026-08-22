# Prior art — AgentPool

A design review of [`phil65/agentpool`](https://github.com/phil65/agentpool) against this
project, done because it is the only prior art surveyed so far that ships **a second full
implementation of the ACP client side** — the exact layer `acp.mjs` is — and has already
crossed several bridges `docs/PROJECT-BRIEF.md` still lists as open questions.

Read 2026-08-22 against commit `b6ddbea9` (shallow clone, last commit 2026-04-26). Every
`path.py:NN` below is that commit; every `acp.mjs:NN` is master at `97eeb1e`. Line numbers
rot — re-check with `sed -n 'NNp'` before trusting one.

This file is a **findings note, not a plan**. Nothing in `docs/PROJECT-PLAN.md` or
`docs/STORIES.md` changes on account of it; the verdicts below are recommendations for a
later session to turn into stories deliberately.

---

## Verdicts, up front

| # | What | Verdict |
|---|---|---|
| 1 | Race handshake RPCs against process death; keep a stderr ring buffer | **take** — M1a |
| 2 | ACP registry resolution + zero-install spawn (`npx -y`, `uvx`, binaries) | **take, scoped** — M1a/M1b |
| 3 | Filter injected MCP servers by the agent's advertised transports | **take** — M1a |
| 4 | Decline elicitation and ack `_`-prefixed ext methods instead of erroring | **take** — M1a |
| 5 | Render `locations[]` on tool calls | **take** — M1a |
| 6 | Mock agent that can fire every `sessionUpdate` variant on demand | **take** — M1a |
| 7 | A backend seam under `fs/*` (and later `terminal/*`) | **take the seam** — M2 |
| 8 | Persist raw `session/update` objects as the source of truth | **take as constraint** — M2 |
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

## Take

### 1 · Race handshake RPCs against process death — M1a

`run_with_process_monitor` (`utils/subprocess_utils.py:126`) runs an RPC as a task racing
`process.wait()`. If the process wins, it reads the subprocess's stderr and raises
`SubprocessError(returncode, stderr)`. Every handshake step is wrapped in it —
`initialize`, `session/new`, `session/load` (`acp_agent.py:278`, `:282`, `:292`, `:296`).

This is the direct fix for the papercut `CLAUDE.md` names: *"harness spawn failures surface
as opaque JSON-RPC errors — typically `Internal error (code -32603)` on `session/new`, with
the real message only on the harness's stderr under `--verbose`."* We already discard that
stderr unless asked (`acp.mjs:73`), and a harness that dies *before* answering leaves
`#failAll` (`acp.mjs:64`) reporting only an exit code.

Cost in our terms: a bounded stderr ring buffer (keep the last ~20 lines regardless of
`--verbose`) plus attaching it to the rejection in `#failAll`. ~25 lines, no dependency, no
invariant touched. The `close` handler already exists; only the message improves.

### 2 · ACP registry resolution and zero-install spawn — M1a/M1b, scoped

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
place harness quirks live — `CLAUDE_PARENT_ENV` (`agents.mjs:26`) is exactly the kind of
knowledge no upstream registry will carry for us, and neither will the M0 containment
metadata (`argvChannel`) the plan puts in the registry.

### 3 · Filter injected MCP servers by advertised transports — M1a

`filter_servers_by_capabilities` (`agents/acp_agent/helpers.py:17`) drops HTTP servers when
`agentCapabilities.mcpCapabilities.http` is falsy, SSE likewise, passes stdio through
always, and logs which servers were skipped and why. Called before both `session/new`
(`acp_agent.py:374`) and `session/load` (`:694`).

`newSession({ mcpServers })` already exists at `acp.mjs:107` and nothing passes anything to
it. The moment a task wants to inject an MCP server, this filter is the difference between
"that harness didn't get the server, here's a warning" and a failed session. ~15 lines,
and it is capability negotiation — the fourth protocol gotcha in the brief — applied
somewhere we currently don't apply it.

### 4 · Decline elicitation, ack extension methods — M1a

Their headless client answers `elicitation` with a decline (`headless_client.py:265`),
no-ops `elicitation_complete` (`:271`), and acks `ext_method`/`ext_notification`
(`:260`, `:274`) rather than failing.

Our `#handleRequest` throws for every method outside the three we implement
(`acp.mjs:205`). For a genuinely unknown method that is right; for elicitation — which the
brief lists as deliberately unimplemented — a hard error can end a turn that a polite
"declined" would let continue. Same for `_`-prefixed unstable extensions, which by
convention a peer must tolerate. ~10 lines, and `mock-agent.mjs` should learn to send both
so the path is exercised (see 6).

### 5 · Render `locations[]` — M1a

`ToolCallState.update` (`tool_call_state.py:128`) normalizes `locations` to
`ToolCallLocation` and forwards them. `render.mjs:37` prints title and kind only; we surface
a path only for completed `diff` content (`render.mjs:45`). `locations` is the harness
telling us which files a call is about, *before* it happens — cheap output, and useful
input to M1c's "same tool repeating" stall heuristic, which currently has only a title
string to compare.

### 6 · A mock agent that can fire every update variant — M1a

Their testing rig is `src/acp/agent/implementations/debug_server/`: a mock agent plus a
small web panel whose entire purpose is manually firing *any* notification type from the
schema — plans, thoughts, tool call progress, mode changes, available-commands updates — at
a client under test.

We don't need the web panel; we need the capability. `CLAUDE.md` makes `mock-agent.mjs` the
test harness of record and says to extend it when adding client capabilities, but
`render.mjs` today has branches (`plan`, `usage_update`, failure paths) that nothing
offline drives. A `--emit <variant,variant,…>` flag on `mock-agent.mjs` makes the renderer
verifiable with nothing installed, which is the invariant we already claim.

### 7 · A backend seam under `fs/*` — M2, seam only

Every filesystem and terminal request in their client handler goes through a pluggable
*execution environment* rather than the local disk: `read_text_file` at
`client_handler.py:248` and `write_text_file` at `:274` both call `self.env.get_fs()`, and
the environment is configurable per agent (`models/acp_agents/base.py:75`,
`client_execution_environment`: local, docker, an E2B sandbox, or remote). They also model
the ACP session itself as a filesystem (`acp://`, `filesystem.py:73`) so an agent can be
handed a workspace that isn't a directory at all.

Worth taking as **one indirection, not a feature**: route our `fs/*` handlers through a
tiny interface so an M1b worktree-scoped or a later container-scoped workspace can be
substituted. Do not take the sandboxes. And note the ordering — see
[Where we are ahead](#where-we-are-ahead): our path guard sits *in front of* the seam, not
inside the backend.

### 8 · Persist raw `session/update` objects — M2, as a design constraint

`ACPSessionState` (`agents/acp_agent/session_state.py`) keeps raw ACP updates in a deque as
"the single source of truth", converting to native events lazily on consumption
(`:37`). Session load flips `is_loading` (`:58`) so replayed updates collect into a separate
buffer and don't get re-emitted into the live stream (`:91`).

Our PROJECT-PLAN already says the event bus is the single source of truth; this adds the
detail worth committing to *before* M2 persistence and `session/load` get built: persist
the wire objects, render from them, and give replay its own buffer. Reconstructing a run
from rendered output is the mistake this avoids.

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
   entirely to the execution environment. Our `#guardPath` (`acp.mjs:235`) is unconditional
   and independent of policy. Keep it in front of any backend seam we add (7). Their design
   is strictly weaker whenever the environment is `local`, which is their default.
2. **Permission option selection.** They take `params.options[0]`
   (`client_handler.py:201`, and again in `headless_client.py:94`) — whatever the agent
   listed first, which may be `allow_always`. Our `pickOption` (`acp.mjs:306`) prefers
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
