# agent-team

<!-- markdownlint-disable MD033 -- HTML is required for the fixed-width right-aligned logo; markdown has no image sizing -->
<img src="assets/icon.svg" alt="agent-team" width="88" align="right">

A minimal Agent Client Protocol client. Zero runtime dependencies, Node 24+.

You are the **client**: you spawn the harness as a subprocess, own the workspace,
answer its file-system requests, and decide its permissions. The harness is the
**agent**. Adding a second harness is an entry in `protocol/registry.ts`, not an integration.

## Layout

| Path | What it is |
| --- | --- |
| `protocol/` | Everything wire-level: hand-written types for every message we touch (`types.ts`), the client itself (`agent.ts` — JSON-RPC over stdio, handshake, `fs/*`, permissions), and the adapter layer (`registry.ts` — how to launch each harness, and what we measured when we ran it). |
| `core/` | Client-side logic that never touches the wire: the policy filter (`policy.ts`) and the event bus (`events.ts`). |
| root scripts | The entry points and terminal glue: `run.ts` (CLI: one prompt, or N tasks from a run file via `--file`), `render.ts` (terminal output for `session/update` events), `mock-agent.mjs` (a fake agent, so you can test with nothing installed). |
| `docs/` | Plans, stories and what was measured about each harness. |
| `assets/`, config files | Logo, tool configs (`biome.json`, `tsconfig.json`, `knip.jsonc`, `.markdownlint.json`), `package.json`. |

Test suites (`*.test.ts`) live next to their sources; `npm run test` runs them all.

## Run files

`run.ts --file` runs N independent tasks, each with its own agent and mode.
In a git repository, each task gets its own worktree; outside one, tasks share
the cwd and a notice says so. `tasks.json` is the worked example:

```bash
node run.ts --file tasks.json
```

```json
{
  "note": "A worked example: two independent tasks sharing one agent and one mode.",
  "agent": "opencode",
  "mode": "safe",
  "tasks": [
    {
      "id": "summarise",
      "prompt": "Summarise what this project does in three sentences."
    },
    {
      "id": "look-for-bugs",
      "prompt": "List any obvious bugs or missing error handling you can see."
    }
  ]
}
```

Task ids are validated and never sanitised: they name the git branches a run
leaves behind. See `schema/run.schema.json` for every field.

## 1. Verify the client works (no harness needed)
