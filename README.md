<!-- markdownlint-disable MD033 MD041 -- HTML is required for the fixed-width centred logo; markdown has no image sizing or alignment. The logo comes before the title, so the first line is not a heading. -->
<p align="center">
  <img src="assets/icon.svg" alt="kapelle logo" width="128">
</p>

> A *Kapelle* is the ensemble a *Kapellmeister* directs: the players, not the conductor. kapelle directs, and the agents play.

# Kapelle

**A terminal chatting workspace for a team of coding agents.**

kapelle runs different coding agents side by side on one repository: pi, Claude Code, Copilot, opencode and more. Each agent works in its own git worktree, on its own branch. You talk to them in your terminal, answer their permission requests, and merge their work when you are ready.

One background daemon holds all the work. Close the terminal and come back later: your agents and their history are still there. Each agent logs in by itself. kapelle never touches a key.

[Install](#install) · [Quick start](#quick-start) · [Rooms](#rooms) · [Runs](#runs) · [Agents](#agents) · [Safety](#what-the-modes-do-and-do-not-do) · [Docs](#docs)

## Install

You need Node 24 or newer, git, and macOS or Linux. WSL counts as Linux. Windows is not supported.

```bash
git clone https://github.com/EdwardLiuyc/kapelle.git && cd kapelle
npm install
npm link       # puts `kapelle` on your PATH; `npm unlink -g kapelle` undoes it
kapelle --help
```

If `npm link` fails with `EACCES`, npm's global folder belongs to root. Use a folder you own instead of `sudo`:

```bash
npm config set prefix ~/.local        # then add ~/.local/bin to PATH
```

Without `npm link`, type `node cli.ts` wherever this page says `kapelle`.

## Quick start

First, check that kapelle works. This needs no agent and no account. It uses a fake agent that ships with the repository:

```bash
npm run selftest
```

You should see `✓ allowed Write ACP_TEST.md`. Delete `ACP_TEST.md` when you are done.

Next, use a real agent. pi is the default. Install pi and its ACP adapter, then log in to pi once:

```bash
npm i -g @earendil-works/pi-coding-agent pi-acp
pi                     # type /login, then quit

kapelle "summarise this repo in three sentences"
```

pi works in your own checkout here, and it never asks for permission, so no mode can stop its changes. Read [Safety](#what-the-modes-do-and-do-not-do) before you give it real work.

Other options: `--agent <id>` picks another agent. `--cwd <dir>` works in another folder. `--mode` sets what the agent may do (see [Safety](#what-the-modes-do-and-do-not-do)). `--verbose` shows the agent's own error output. `--quiet` hides normal output, but never the safety notices.

## Rooms

A room is a chat with a team of agents. Each agent keeps its memory across messages, and works on its own branch, `kapelle/<roomId>/<participantId>`. You decide who does what by choosing who to message.

Rooms live in the daemon. Start it once, and add each repository once:

```bash
kapelle daemon start     # terminal 1: runs until Ctrl-C
kapelle daemon add .     # terminal 2: in your repository
```

Then open a room:

```bash
node chat.ts new --agent pi         # open a room and chat in it
node chat.ts list                   # every room
node chat.ts attach <roomId>        # rejoin a room; its history replays
node chat.ts dismiss <roomId>       # stop the room's agents
```

In a room, type a message and press Enter. `/leave` exits and keeps the agents alive. `/dismiss` stops them. In a room, kapelle never commits for an agent: uncommitted work stays in the agent's checkout.

The room API is new, and it can still change.

## Runs

A run hands out N tasks at once. Each task has its own prompt, agent and mode, and each ends with a result. `tasks.json` is an example:

```json
{
  "agent": "pi",
  "mode": "safe",
  "tasks": [
    { "id": "summarise", "prompt": "Summarise what this project does in three sentences." },
    { "id": "look-for-bugs", "prompt": "List any obvious bugs or missing error handling you can see." }
  ]
}
```

```bash
kapelle run --file tasks.json
```

In a git repository, each task gets its own `git worktree`, on a branch named `kapelle/<runId>/<taskId>`. Keep working in your own checkout while the agents work in theirs. Your uncommitted changes do not reach the tasks, and kapelle tells you so. Outside a git repository, the tasks share the folder.

When a task ends `done` or `warned`, kapelle commits its work on the task's branch. Look at one task's work with `git log -p kapelle/<runId>/<taskId>` before you merge.

See `schema/run.schema.json` for every field. Task ids name git branches, so kapelle checks them and never changes them.

### Run in the background

With the daemon running, hand the run over and follow it from any terminal:

```bash
kapelle run --file tasks.json --detach   # prints the run id
kapelle ps                               # every run and each task's status
kapelle attach <runId>                   # watch it, and answer its `ask` prompts
kapelle attach <runId> --task <taskId>   # watch one task in full
```

kapelle rings the bell and sends a desktop notification when a run needs you.

### Take the results

```bash
kapelle merge <runId> --squash
```

This puts the changes of all tasks into your working tree, unstaged. It makes no commit. It refuses when two tasks change the same file, or when your own changes touch a file a task changed.

### Where the worktrees live

Worktrees and records live in `~/.local/state/kapelle/`. Nothing goes into your repository.

```bash
kapelle workspace                      # print where this repository's work lives
kapelle workspace move <old> <new>     # after you move or rename the repository
```

Use `workspace move`, not a plain `mv`. A plain `mv` breaks git's link to each worktree.

## Agents

Pick one with `--agent <id>`. Each agent logs in by itself.

| `--agent` | Install | Tested here |
| --- | --- | --- |
| `pi` (default) | `npm i -g @earendil-works/pi-coding-agent pi-acp` | yes |
| `claude` | `npm i -g @agentclientprotocol/claude-agent-acp`, then `claude auth login` | yes |
| `copilot` | the Copilot CLI (`copilot --acp`) | yes |
| `opencode` | `npm i -g opencode-ai`, then `opencode auth login` | yes |
| `gemini` | the Gemini CLI (`gemini --acp`) | no |
| `omp` | oh-my-pi (`omp acp`) | no |

Any other ACP agent works too: `--cmd "some-agent --acp"`.

**Claude Code** has no ACP mode of its own, so it needs the adapter above. If you see `spawn claude-agent-acp ENOENT`, the adapter is not on your `PATH`. Check with `command -v claude-agent-acp`. You can run kapelle from inside a Claude Code session. No `env -u` is needed.

## What the modes do and do not do

| Mode | What it does |
| --- | --- |
| `safe` | Allows reads. Refuses every change the agent asks about. |
| `ask` | Allows reads. Asks you about each change. Needs a terminal: without one, kapelle uses `safe` and prints a notice. |
| `auto` | Allows everything. File paths outside the workspace are still refused. |

**A mode is a filter, not a sandbox.** It decides the answer when an agent asks for permission. An agent that changes files through its own shell does not ask. pi and opencode never ask, so `safe` does not stop them.

kapelle always refuses a file path outside the workspace, in every mode. But this only covers file requests that go through kapelle.

What each agent was measured to do is in [`docs/FINDINGS.md`](docs/FINDINGS.md).

## Configuration

Two optional JSON files and `KAPELLE_*` environment variables:

- `~/.config/kapelle/config.json`: the daemon's `port` and permission timeout.
- `.kapelle/config.json` in your repository: stall limits, time limits, how many tasks run at once, and how long records are kept. This is the only file kapelle reads from your repository. You write it yourself.

Every key, its range and its order of precedence: [`docs/CONFIG.md`](docs/CONFIG.md).

## Docs

- [`docs/CONFIG.md`](docs/CONFIG.md): every config key.
- [`docs/CLIENT-API.md`](docs/CLIENT-API.md): the daemon's HTTP API, to write your own client.
- [`docs/FINDINGS.md`](docs/FINDINGS.md): what each agent was measured to do.
- [`docs/PROJECT-BRIEF.md`](docs/PROJECT-BRIEF.md): why this project exists.

## Development

Read [`AGENTS.md`](AGENTS.md) first. It has the commands, the file map and the rules. This applies to people and to coding agents.

```bash
npm run check && npm run fmt:check && npm run test && npm run knip
```

## License

[MIT](LICENSE) © Yongchuan Liu
