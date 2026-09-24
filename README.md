# kapelle

<!-- markdownlint-disable MD033 -- HTML is required for the fixed-width right-aligned logo; markdown has no image sizing -->
<img src="assets/icon.svg" alt="kapelle" width="88" align="right">

A minimal Agent Client Protocol client. One runtime dependency, Node 24+.

That dependency is `marked`, and the rule it arrived under (ratified 2026-09-09,
M1c-7) is narrow: a runtime dependency is acceptable only **downstream of the bus,
in presentation**, where its worst failure is cosmetic — it can change no permission
decision, path guard, policy, mode negotiation, or anything that reaches a
subprocess. It is pinned exactly, and `core/markdown.ts` falls back to the raw text
if it throws, so a bad release costs the screen and never the run.

You are the **client**: you spawn the harness as a subprocess, own the workspace,
answer its file-system requests, and decide its permissions. The harness is the
**agent**. Adding a second harness is an entry in `protocol/registry.ts`, not an integration.

## The name

A *Kapelle* is the ensemble a *Kapellmeister* directs — the players, not the
conductor. That is the right way round here: this client directs, and the
harnesses do the playing.

The name is one word everywhere you meet it: the command you type, the
`kapelle/<runId>/<taskId>` branches a run leaves behind, and the
`~/.local/state/kapelle/` directory those runs keep their worktrees and
records in.

Run `kapelle workspace` inside a repository to print where its worktrees and
records live. If you rename or move the repository, `kapelle workspace move
<old-path> <new-path>` carries them across and repairs the checkouts — one
command, because a plain `mv` would leave git calling every checkout
`prunable`.

**A run asks nothing of your repository.** No `.gitignore` line, and no clean
working tree: each task gets a `git worktree` of its own, outside your
repository, branched off `HEAD`. Keep working in your checkout while the
agents work in theirs. The one thing a run says about uncommitted changes is
one line telling you they will not reach any task — `merge` is where a real
conflict is caught, per file.

## Install

```bash
npm install
npm link       # puts `kapelle` on your PATH; `npm unlink -g kapelle` undoes it
kapelle --help
```

If `npm link` fails with `EACCES` on `/usr/lib/node_modules`, npm's global prefix is
root-owned. Point it somewhere you own rather than reaching for `sudo`:

```bash
npm config set prefix ~/.local        # then add ~/.local/bin to PATH
```

**macOS and Linux only.** Windows is not supported: `core/notify.ts` shells to
`notify-send`/`osascript`, and `git worktree` paths and separators differ there.
`package.json` declares `"os": ["darwin", "linux"]`, so `npm install` on Windows
stops with `EBADPLATFORM` rather than failing later in a stranger place. WSL
counts as Linux and works.

Without `npm link`, every `kapelle` below reads `node cli.ts` from the repo root.

## Layout

| Path | What it is |
| --- | --- |
| `protocol/` | Everything wire-level: hand-written types for every message we touch (`types.ts`), the client itself (`agent.ts` — JSON-RPC over stdio, handshake, `fs/*`, permissions), and the adapter layer (`registry.ts` — how to launch each harness, and what we measured when we ran it). |
| `core/` | Supervisor-side orchestration and pure logic: policy (`policy.ts`), event bus (`events.ts`), run-file validation (`runfile.ts`), the run engine (`run.ts`), worktrees (`worktree.ts`), merge (`merge.ts`), result parsing/cross-check (`result.ts`), the stall detector (`watchdog.ts`), the attention signal (`notify.ts`), run and task ids (`ids.ts`), and the one file that knows a markdown library exists (`markdown.ts`). `core/` may import `protocol/`, never the reverse. |
| root scripts | The entry points and terminal glue: `cli.ts` (the CLI, and the `kapelle` `bin`: one prompt, N tasks from a run file via `run --file`, the same run handed to the daemon with `--detach` and followed with `attach <runId>`, or `merge <runId>`), `daemon.ts` (one HTTP daemon for all your repositories, on `127.0.0.1`: add a repository with `POST /repos`, then `POST`/`GET`/`DELETE /runs` plus `GET /permissions`, `GET /permissions/:id` and `POST /permissions/:id` for `ask` decisions, behind the bearer token in `$XDG_RUNTIME_DIR/kapelle/daemon.json`; the repository list survives a restart in `$XDG_STATE_HOME/kapelle/repos.json`), `render.ts` (terminal output for `session/update` events), and the offline fake agents `mock-agent.mjs` (compliant) and `hostile-agent.mjs` (adversarial). |
| `docs/` | Plans, stories and what was measured about each harness; `CONFIG.md` is the knobs reference. |
| `assets/`, config files | Logo, tool configs (`biome.json`, `tsconfig.json`, `knip.jsonc`, `.markdownlint.json`), `package.json`. |

Test suites (`*.test.ts`) live in a `tests/` folder beside their sources — `core/tests/`, `protocol/tests/`, and `tests/` at the root; `npm run test` runs them all.

## Run files

`kapelle run --file` runs N independent tasks, each with its own agent and mode.
In a git repository, each task gets its own worktree; outside one, tasks share
the cwd and a notice says so. `tasks.json` is the worked example:

```bash
kapelle run --file tasks.json
```

With a daemon running (`kapelle daemon start`, then `kapelle daemon add .`),
`kapelle run --file tasks.json --detach` hands the run over and prints its id;
`kapelle attach <runId>` shows it from any terminal and asks its `ask` prompts;
add `--task <taskId>` to watch one task in full. `kapelle ps` lists every run the
daemon knows, with each task's status.

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

## Configuration

Two optional JSON files plus `KAPELLE_*` environment overrides set the knobs
that do not belong in a run file. The user-level
`$XDG_CONFIG_HOME/kapelle/config.json` (`~/.config/kapelle/config.json` by
default) holds the daemon-wide `port` and `permissionTimeoutMs`; a repository's
`.kapelle/config.json` — the only file kapelle reads from inside your
repository, and one you write yourself — holds the per-run watchdog thresholds, TTL,
`maxConcurrency` default and retention window. Unknown keys and wrong types are
refused by file and key; unknown `KAPELLE_*` names warn and are ignored.

Every knob, its range, its precedence and every failure mode:
[`docs/CONFIG.md`](docs/CONFIG.md).

## 1. Verify the client works (no harness needed)
