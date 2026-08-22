<img src="assets/icon.svg" alt="agent-team" width="88" align="right">

# agent-team

A minimal Agent Client Protocol client. ~400 lines, zero dependencies, Node 20+.

You are the **client**: you spawn the harness as a subprocess, own the workspace,
answer its file-system requests, and decide its permissions. The harness is the
**agent**. Adding a second harness is a line in `agents.mjs`, not an integration.

## Files

| File | What it is |
|---|---|
| `acp.mjs` | The client. JSON-RPC over stdio, handshake, `fs/*`, permissions. |
| `agents.mjs` | How to launch each harness in ACP mode. The whole adapter layer. |
| `run.mjs` | CLI: one prompt, one agent. |
| `fanout.mjs` | Several agents in parallel from `tasks.json`. |
| `render.mjs` | Terminal output for `session/update` events. |
| `mock-agent.mjs` | A fake agent, so you can test with nothing installed. |

## 1. Verify the client works (no harness needed)

```bash
npm run selftest
```

The mock agent streams a message, reads a file back through the client, and asks
permission for a write. You should see `✓ allowed` and `wrote …ACP_TEST.md`.

Now prove the permission layer actually bites:

```bash
node run.mjs "self test" --cmd "node mock-agent.mjs" --mode safe
```

Same run, but the write is refused. Delete `ACP_TEST.md` when you're done poking.

## 2. Run it against opencode

```bash
npm i -g opencode-ai          # if you don't have it
opencode auth login           # opencode owns its own auth — we never see keys

node run.mjs "summarise this repo in three sentences" --mode safe
```

`--mode safe` allows reads, searches and fetches; it refuses every edit, delete,
move and execute. Good first run — nothing can change.

Then let it work:

```bash
node run.mjs "add a --version flag to run.mjs" --mode ask
```

`ask` auto-approves reads and prompts you per mutation. `--mode auto` approves
everything (the workspace-root path guard still applies).

Point it elsewhere with `--cwd ../some-project`. Use `--verbose` to see the
agent's stderr when something looks stuck.

## 3. Two agents at once

```bash
node fanout.mjs tasks.json
```

Edit `tasks.json` to set `agent`, `cwd`, `mode` and `prompt` per task. Give each
task its own `cwd` (a git worktree is the usual choice) and they won't collide.

## Other harnesses

```bash
node run.mjs "..." --agent claude     # Claude Code, via its ACP adapter (below)
node run.mjs "..." --agent omp        # oh-my-pi, native ACP
node run.mjs "..." --agent gemini     # gemini --acp
node run.mjs "..." --agent pi         # via the pi-acp adapter: npm i -g pi-acp
node run.mjs "..." --cmd "some-agent --acp"
```

Each harness authenticates itself. This client never handles a key.

### Claude Code

Claude Code has no native ACP mode. Install the adapter, then use it like any
other harness:

```bash
npm i -g @agentclientprotocol/claude-agent-acp
claude auth login             # the adapter reuses the CLI's own credentials

node run.mjs "summarise this repo in three sentences" --agent claude --mode safe
```

If `npm i -g` fails with `EACCES` (your npm prefix points somewhere root-owned,
`npm config get prefix` will tell you), install into a prefix you own instead —
no sudo, no config change:

```bash
npm i -g --prefix ~/.local @agentclientprotocol/claude-agent-acp
```

That puts the binary in `~/.local/bin`; make sure it's on your `PATH`. Expect
the install to take a while — it pulls platform-specific SDK binaries.

`spawn claude-agent-acp ENOENT` means exactly one thing: the adapter isn't on
your `PATH`. Check with `command -v claude-agent-acp` before debugging anything
else.

The adapter was previously published as `@zed-industries/claude-code-acp`
(binary `claude-code-acp`). It's deprecated upstream and this client no longer
carries an entry for it — install the package above.

**Driving this client from inside a Claude Code session works as-is.** Older
adapters refused to start a nested session when they saw the markers the parent
leaves in the environment, so the `claude` registry entry scrubs them
(`CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`) before spawning.
0.49.0 no longer refuses, so the scrub is insurance against a regression rather
than a fix for a failure you'd hit today. No `env -u ...` prefix needed — though
note that `--cmd "claude-agent-acp"` bypasses the registry, and with it the scrub.

An opaque `Internal error (code -32603)` on `session/new` is the usual shape of
a harness that refused to start; `--verbose` shows the real reason on its stderr.

## What's deliberately missing

- **Terminals.** We advertise `terminal: false`, so agents run shell commands
  internally rather than through us. Add `terminal/*` handlers when you want
  command output routed through the supervisor.
- **Session persistence.** No `session/load` or `session/resume` yet; check
  `agent.agentCapabilities` before calling either.
- **Cancellation is best-effort.** Ctrl-C sends `session/cancel` and waits 2s.
- **Elicitation, slash commands, session modes.** All optional, all unhandled.

## Two things worth knowing

**Permission requests are thin.** `session/request_permission` may carry only a
`toolCallId`. The title and kind arrive earlier, in the `tool_call` notification.
The client keeps a `toolCallId → {title, kind}` map so the policy has something
to judge — without it, every decision is blind.

**The policy is the safety boundary.** One function, one place, applied
identically to every harness. Path guards on `fs/write_text_file` run regardless
of policy, so even `--mode auto` cannot write outside the workspace root.
