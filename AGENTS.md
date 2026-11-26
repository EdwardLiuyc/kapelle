# AGENTS.md

Instructions for any coding agent working in this repo. Harness-neutral by design — this
repo drives several harnesses, so a procedure only one of them can follow is a bug.
`CLAUDE.md` is one line that imports this file, so Claude Code reads the same text.

Use plain language and short sentences in code comments and docs.

This file holds only what an agent cannot learn by reading the code.

## Who owns a fact

Each fact has one owner, and it is stated only there. Anywhere else, link to the owner;
do not restate it. A restated fact goes stale in one place and stays right in the other.

| A fact about | Its owner |
| --- | --- |
| a module: what it does, its invariants and why | the comment at the top of its file. Read it before you change the file. |
| the daemon's API, for client authors | `docs/CLIENT-API.md` |
| the config keys | `docs/CONFIG.md` |
| what each harness was measured to do | `docs/FINDINGS.md`. A section such as `§M0-4` or `§Multi-turn`, named in this file or a source comment, is a section there. |
| the work breakdown, and the reason for each decision | `docs/STORIES.md` |
| what three runs of an orchestrator agent showed, the evidence for M8 | `docs/ORCHESTRATOR-SPIKES.md` |
| how a release is made, and the credential scan's record | `docs/RELEASING.md` |
| why, what in what order, and the decision register for M4–M6 | `docs/PROJECT-BRIEF.md`, `docs/PROJECT-PLAN.md`, `docs/CONTRACT-PLAN.md` |
| how a loop, a skill or the orchestrator works | its own file: `.kapelle/loops/<name>.md`, `$XDG_CONFIG_HOME/kapelle/loops/<name>.md` or `assets/loops/<name>.md`, `.agent/skills/<name>/SKILL.md`, `assets/orchestrator.md` |
| the workflow, the rules that cross files, and this map | `AGENTS.md` |

When a behaviour changes, its owner changes in the same commit. Not every code change
needs a doc edit: the PR template asks which owner changed, or why none did.

**Do not read `docs/archive/`.** It holds recaps for people, such as a milestone summary.
They are snapshots, and they go out of date. The code and the files above are the
source of truth.

## Question or work?

A question gets an answer, not an action. It asks for information; work asks for
action. Decide what would complete the exchange: a reply completes a question; only
the action completes a request. If both readings are plausible, ask first. A question
about whether you can do something is completed by the answer; naming the action does
not ask for it. Being able, useful, or the obvious next step is not a request.

Before an action that starts a harness, spends tokens, or changes state outside a
temporary folder, the person must have unambiguously asked for it — in this message
or a later reply. Otherwise propose it and wait. Investigate as far as needed; use a
temporary folder or detached worktree, then clean it up (`git worktree remove` for a
worktree). Leave the original checkout as you found it: config, issues and PRs stay
untouched; Git discipline still governs commits and pushes. If a change would help,
propose it and wait.

If you cannot tell whether a message is a question or a request, ask first; if you
cannot ask, treat it as a question and change nothing.

## What this is

`kapelle` is a minimal [Agent Client Protocol](https://agentclientprotocol.com)
**client**, in TypeScript with ES modules. Node ≥24, `"type": "module"`, and no
build step in a checkout. `prepack` builds `dist/` only when the npm package is made.
It has three runtime dependencies, all for presentation only: `marked`
(`core/markdown.ts`), `@earendil-works/pi-tui` (the `chat/tui.ts` screen) and
`@xterm/headless` (the shell's screen, `chat/tui/term.ts`). All are pinned exactly, and an
npm `overrides` entry keeps pi-tui on our `marked`.

**The rule for a runtime dependency** (M1c-7, 2026-09-09): it is allowed only in
presentation, after the event bus, where its worst failure is cosmetic. It must not
change a permission decision, the path guard, the policy, mode negotiation, or anything
that reaches a subprocess. Pin it exactly, and give it a fallback so a bad release costs
the screen, never the run: `core/markdown.ts` returns the raw text if `marked` throws,
and `chat/tui.ts` leaves pi-tui's screen before it exits on a throw. One import has no
fallback: `chat/tui/question.ts` reads pi-tui's `dist/keys.js`, a file outside its main
exports. If a new pi-tui moves it, `chat.ts` fails at start, so check it at each bump.
`chat/tui.ts` also replaces the root layout's `handleMouse` with an untaken-event hook;
a bump must keep routing events through child parts first, then the root.
**Amended 2026-10-13 (M4-13):** the screen package may drive one subprocess, the shell
the person starts with `/term` and types into. It may send it bytes; it still never
reaches a harness, the daemon, the policy or the path guard. This limits the package,
not the chat: the chat's own subprocesses are listed under "Where things are". No native
code: a native crash cannot be caught.

**This code is the client. The coding harness is the agent.** We spawn the harness as a
subprocess, own the workspace, serve its filesystem requests and decide its permissions.
Harnesses (opencode, claude, copilot, pi, …) log in by themselves. This client never
touches a key.

## Commands

```bash
npm run check          # tsc --noEmit
npm run check:changelog # the first CHANGELOG section names package.json's version
npm run fmt            # biome format + lint, with fixes
npm run fmt:check      # biome format + lint, check only
npm run test           # node:test: pure functions and wire behaviour; no harness needed
npm run test:adaptive  # default concurrency (cores - 1); GitHub's runners use it
npm run test:coverage  # offline production-only coverage (#428)
npm run knip           # unused files and exports
npm pack --dry-run     # prepack builds dist/, then show the package file list
npm run selftest       # end to end against mock-agent.mjs, --mode auto (writes ACP_TEST.md)
npm run test:harness   # the real harnesses; local only, needs credentials, spends tokens
node cli.ts                                     # on a terminal: the chat, starting the daemon if none runs; a pipe prints chat usage and exits 1
node cli.ts "<prompt>" [--agent opencode|pi|claude|copilot|codex|kimi] [--cmd "<cmd>"] [--cwd dir] [--mode ask|safe|auto] [--verbose] [--quiet]
node cli.ts run --file <run.json> [--detach]   # N tasks (tasks.json is the example); --detach hands them to the daemon
node cli.ts attach <runId> [--task <id>]       # replay then follow a detached run
node cli.ts ps                                 # every run the daemon knows, with its tasks
node cli.ts setup                              # the agents the daemon finds on its PATH, and what to install
node cli.ts demo                               # a room with the offline demo-agent.mjs, in <stateDir>/demo, made again each run
node cli.ts merge <runId> [--squash] [--cwd dir]
node cli.ts room info | send | add | ff | diff | remove [--room id] [--as name]   # from a participant's checkout; add takes --model id and --level id
node cli.ts loop <recipe> <task> ["<note>"] [--agent id] [--cmd "<cmd>"] [--model id] [--cwd dir]   # a room whose orchestrator drives the recipe
node cli.ts loop list [--cwd dir]              # every recipe, its folder, and which one wins a name
node cli.ts workspace [--cwd dir]              # where this repo's worktrees and records live
node cli.ts workspace move <old-repo> <new-repo>
node cli.ts daemon start [--port n] [--permission-timeout s]   # same as: node daemon.ts
node cli.ts daemon stop                        # SIGTERM to the pid in daemon.json, then wait
node cli.ts daemon add <path>
node cli.ts chat [new --agent <id> [--cwd dir]]   # chat rooms: runs chat.ts
node chat.ts attach <roomId> | list | dismiss <roomId> | scratch [clean [--yes]]
```

`ACP_TEST.md` is selftest output, not source. You can delete it.

## Where things are

Dependencies point one way: `cli.ts` and `daemon.ts` → `core/` → `protocol/`.
`cli.ts` is the composition root: it may also use `client/`, `render.ts`, `chat.ts`
and `daemon.ts`, but not `chat/`, `daemon/` internals or a package. `daemon.ts` and
`daemon/` may use `core/`, `protocol/`, `client/contract.ts` and files under
`daemon/`, but never `chat.ts`, `chat/` or a package.

**`core/` may import `protocol/`. `protocol/` never imports `core/`.** That is why
`AcpAgent`'s default policy refuses everything instead of being `safePolicy`.
`client/` imports only `protocol/types.ts`, and nothing in `core/` or `protocol/`
imports `client/`. `chat.ts` → `chat/` → `client/`. `render.ts` →
`core/markdown.ts` and `core/text.ts` are the arrows that point back. These layer
and package rules are runtime rules: a declaration-level `import type` may cross
them because it is erased; an inline `type` specifier still loads its module.
`chat.ts` and `chat/` talk HTTP only. They import only `client/`, pi-tui,
`core/runtime.ts` and each other; `chat/tui/term.ts` also imports
`@xterm/headless`. `chat/` never imports `chat.ts`, because loading the entry
runs `main()`. Their subprocesses are the clipboard tool (`chat/tui/clipboard.ts`)
and the person's shell (`chat/tui/term.ts`).

| Path | What it is |
| --- | --- |
| `protocol/agent.ts` | `AcpAgent`: one harness subprocess and its ACP session; the `toolCallId` map and write decisions. |
| `protocol/json-rpc.ts` | Newline-delimited JSON-RPC framing and the 32 MiB stdout-line refusal. |
| `protocol/path-guard.ts` | The disk-reading, realpath-based workspace guard; it applies in every mode. |
| `protocol/permission.ts` | Pure policy-answer interpretation and permission-option selection. |
| `protocol/registry.ts` | The whole adapter layer: one entry per harness, `launch` plus `measured`. |
| `protocol/types.ts` | Hand-written wire types, and the `_client_*` synthetic events. |
| `core/policy.ts` | `safe` / `ask` / `auto`, mode negotiation, `resolvePolicy`. |
| `core/events.ts` | The event bus. |
| `core/git.ts` | The one place core starts git; raw output, `GitError`, accepted exits and buffers. |
| `core/runfile.ts` | Run-file validation (`validateRun`). |
| `core/run.ts` | The task pool, and how a status is worked out. |
| `core/worktree.ts` | One git worktree per task, and the `linkPaths` mirror into each new checkout. |
| `core/result.ts` | The `<task-result>` contract and its cross-check. |
| `core/merge.ts` | `kapelle merge`. |
| `core/watchdog.ts` | Stall detection: idle, repeat, TTL. |
| `core/notify.ts` | Bell and desktop notification for the two attention events. |
| `core/permissions.ts` | The daemon's queue of pending `ask` decisions. |
| `core/diff.ts` | `git diff` text for a person (M4-6), and the shared ancestry check. |
| `core/eventlog.ts` | `events.jsonl` and its `events.idx` cache: write, replay and follow. |
| `core/sweep.ts` | The daemon's boot sweep. |
| `core/config.ts` | The config files and `KAPELLE_*` variables. |
| `core/runtime.ts` | The user-level directories, `stateDir()` and `stateDirFor(root)`. |
| `core/harnesses.ts` | Which agents are installed, in `harnesses.json` (M9-3), and their npm install (M9-3b). |
| `core/check.ts` | The login check and the saved models, in `checks.json` (M9-4). |
| `core/room.ts` | A chat room: its roster, what it saves in `room.json`, the reply to a sender and the turn cap. |
| `core/room/` | The room's shared types, constants and `RoomRefusal` (`types.ts`); request validation (`validate.ts`); the `room.json` record and tombstones (`record.ts`); one participant's queue (`turns.ts`); one participant's harness, revive, mode, model and level (`participant.ts`); and one participant's add, remove, checkout and record for any owner, a room or not (`member.ts`). |
| `core/chat.ts` | A chat (M11-12): one agent outside every room, with its own `chat.json`, log and archive. |
| `core/ids.ts`, `core/markdown.ts` | Ids and branch names; the only file that knows `marked`. |
| `core/text.ts` | A harness's text made safe for a terminal (#229). |
| `render.ts` | Terminal drawing of `session/update` events. |
| `cli.ts` | The CLI and the `kapelle` bin. |
| `daemon.ts` | The daemon's entry: importing it starts the one daemon for all of the operator's repositories. |
| `daemon/main.ts` | The daemon's boot: the arguments, the claim, the sweep, the restore, the signals and the listen. |
| `daemon/app.ts` | `createDaemonApp`: the state, the `Host` and token checks, and the route table. Importing it starts nothing. |
| `daemon/` | The app's other parts, each importable by a test. `daemon/routes/` holds the table's rows and their handlers. |
| `client/contract.ts` | The client API as types, plus `API_VERSION`. |
| `client/daemon.ts` | `client.json`, `daemon.json`, the HTTP calls and the version check. |
| `client/lifecycle.ts` | The daemon's life from a client (M9-2): start it when none answers, and stop it. |
| `client/stream.ts` | The SSE reader with reconnect. `attach` uses it. |
| `client/room.ts` | The room reducer: room lines in, screen state out. No I/O. |
| `client/roomset.ts` | The rooms a screen follows (M4-11): one stream and one reducer per room. |
| `client/mention.ts` | The composer's target: `@name` or the orchestrator (R43). |
| `client/questions.ts` | The queue of open questions over every room (M4-9): which one opens next, and its `n of m`. No I/O. |
| `client/folder.ts` | Tab completion for a folder path (M4-5). |
| `client/command.ts` | Room and roster commands (M4-5): the typed line parsed, and the one route each calls. |
| `client/diff.ts` | A diff text read for a screen (M4-6). |
| `client/loop.ts` | Loop recipes (M8-5): where one is found, the list, and the orchestrator's first message. |
| `client/config.ts` | The project config (M10-5): `GET /config` as lines, and the form's values as a `PATCH` or `PUT /config` body. |
| `client/setup.ts` | The setup list (M9-3), and the install request (M9-3b). |
| `client/submit.ts` | What a typed line is: a command, or a message and its target (M4-8). No I/O. |
| `chat.ts` | The chat entry only: the arguments, the verbs and which screen to open. |
| `chat/` | The chat screens (M4-7): `tui.ts` on a TTY, `piped.ts` on a pipe, `common.ts` for both. |
| `chat/view.ts` | What the TUI shows (M4-10). Pure. |
| `chat/tui/` | The TUI's parts (M4-12), one file each. |
| `schema/run.schema.json` | An editor aid for run files. Never a second validator. |

Run state is outside the repository, in `$XDG_STATE_HOME/kapelle/repos/<name>-<hash>/`
(`stateDirFor`). The only file a run reads inside the repository is
`.kapelle/config.json`.

## Rules that are easy to break

- **The policy is a filter, not a sandbox.** It decides what a harness *asks*, and the
  one change a harness can make through us: `fs/write_text_file`. A harness that edits
  through its own shell is outside its reach. pi never asks, and opencode asks only
  for a write outside the root (§M9-1 re-measure).
  `core/policy.ts` is the one policy file, and `policyFor(mode)` is the only map from a
  mode to a decider. `SECURITY.md`'s "Scope" states this reach to outside reporters, so
  a change to the reach changes that section too.
- **The daemon's one install is npm, with a command from the registry only** (M9-3b).
  `POST /harnesses/install` takes agent ids, never a command. `installArgs` builds
  `npm i -g <setup.npm>@<measuredOn.version>`, and `runNpm` starts it with no shell. It
  installs only an ACP program the person checked, never a main program, and it never
  logs in (D6, as amended). npm runs the package's own install scripts as the daemon's
  user: the one place kapelle runs third-party code outside a harness. The check box and
  the registry's pin are what contain it, so never widen either without the person.
- **Never let a mode turn off the path guard.** See the top of `protocol/path-guard.ts`.
- **Never move the `toolCallId` map out of `AcpAgent`.** See the top of `protocol/agent.ts`.
- **Never let an approval cover more than one write of the bytes the person saw.** See
  the top of `protocol/agent.ts`.
- **Never fall back to `options[0]` when `pickOption` finds no match**, on any permission
  request. See the top of `protocol/permission.ts`.
- **Never send `modeMap.auto`, and send the mode again after a `session/load`.** See
  `harnessModeId` in `core/policy.ts`, and the top of `core/room/participant.ts` for when
  a room sends it.
- **`--quiet` never hides the containment notice** or the "not negotiated" line (#13).
- **Never take a status from `stopReason`.** See the top of `core/run.ts`.
- **Never add up `usage` across tasks or harnesses.** See the top of `core/run.ts`.
- **No second prompt during a turn, and no re-ask after it** (§M0-4).
- **No `HStack` below another in the chat screen, and no `auto` size in one.** See
  `screenLayout` in `chat/tui.ts`.
- **A new synthetic event starts with `_client_`.** See the top of `render.ts` for why an
  unknown event is dropped.
- **A missing `measured` half means "not verified". Never add a second flag for it.**
  See the top of `protocol/registry.ts`.
- **Do not rename the package to `agent-team`.** That npm name and `bin` belong to an
  unrelated live package.

## Tests

- Suites live in a `tests/` folder beside their sources. `npm run test` needs no harness,
  so CI needs no credentials.
- Coverage includes `**/*.ts`, excludes `**/tests/**`, `integration/**`, `dist/**` and
  `node_modules/**`, and uses concurrency 2 (4 exposed an upload-test flake). Intentional
  `SIGKILL`s stay: killed processes cannot flush V8 data. Baseline: #428.
- `mock-agent.mjs` is the offline, well-behaved harness. **Check a change to
  `protocol/agent.ts` against it before a real harness.** When you add a client
  capability, add a path to it. Scenarios are picked with `--scenario <name>` on argv,
  never with a keyword in the prompt.
- `demo-agent.mjs` is the other offline agent, for people: `kapelle demo` runs it,
  and it ships in the package. It is not a test fixture, so add no scenario to it.
- `hostile-agent.mjs` has one attack per `--scenario` and no default. Each attack must
  end its turn normally, so a test proves "refused, and the run continues".
- `tests/cli.test.ts`, `tests/cli-flags.test.ts` and the daemon suites
  (`tests/daemon*.test.ts`, `tests/attach.test.ts`, `tests/chat-*.test.ts`) drive the
  real entry points as subprocesses. They are split by subject so they run at the same
  time (#340): put a new test in the file whose header names its subject. Each daemon
  under test gets its own temp `XDG_RUNTIME_DIR` and `XDG_STATE_HOME`. Share the helpers
  in `integration/helpers.ts`; do not copy them.
- `integration/*.itest.ts` drives the real harnesses. `node --test` does not discover the
  `.itest.ts` suffix, and that is the only thing that keeps them out of CI, so do not
  rename them. Assert on what the client controls (exit code, our notice lines), never
  on the agent's prose. A missing harness skips.
- `--mode ask` needs a TTY. Without one it becomes `safe`, so tests cannot reach it.

## When something fails

- A harness that fails to start shows as an opaque JSON-RPC error, often
  `Internal error (code -32603)` on `session/new`. When there is a next step, the
  line after it names it (`startHelp`, `core/check.ts`): the login command, the
  stderr log, or `--verbose` for a one-shot prompt or a run with no log. A failed
  spawn gets no `--verbose` line, as it has no stderr; `kapelle setup` covers a
  missing program.
- The `claude` registry entry removes the parent Claude Code session's variables
  (`CLAUDECODE`, …). You do not need `env -u`.

## Deliberately unimplemented

Do not add these unless asked:

- `terminal/*`: we send `terminal: false`, and turning it on changes nothing (§M0-3).
- `session/resume`. A room revive uses `session/load` (M6-7b); a run never loads.
- Elicitation, slash commands and session modes.

Cancellation is best-effort.

## Git discipline

**Never commit, push, or create branches/PRs unless the user explicitly asks in that
instruction.** Keep edits in the working tree until then. When asked to commit, commit on
the story's branch — never directly on `master`.

**Commits.** Keep the message short and clear, and say what changed. Prefer a single
line. Add no `Co-Authored-By:` line or any other trailer.

**Pull requests.** Never write that an agent or a tool made the PR. No "Generated with
Claude Code" line, no agent name, no robot emoji — not in the title, the body or a
comment. Fill the body from `.github/pull_request_template.md`: `gh pr create --body`
does not read it.

## Review triage

Sort every review finding by its impact, whoever wrote it: a person, the review bot or
`review-local`. There are two levels, `blocker` and `nit`.

- **Blocker.** The code and its owner doc disagree (a contract mismatch), a contract
  statement is missing, a bug, or a changed behaviour with no test. Fix it in this PR.
- **Not a blocker (a nit).** Wording, the direction of a comment, a duplicate, an
  optional refactor. Fix the nits together in one commit, or reply why not.
- **A stale doc the change did not touch** is a `nit` marked "separate issue". It is
  not fixed in this PR, and no agent opens an issue for it. The reply and the
  hand-over report list it; the person picks which ones become issues.

A round whose fixes are docs-only or nits only gets no new full review. Check it by
reading its diff, with the focused tests and CI.

## Markdown lint

All tracked `.md` files stay clean under `markdownlint-cli2` (config: `.markdownlint.json`,
the same rules pi-lens applies). After editing any Markdown, run:

```bash
npx -y markdownlint-cli2 --config .markdownlint.json $(git ls-files '*.md')
```

Fix findings before finishing. An inline `<!-- markdownlint-disable MD0xx -->` is allowed
only with a comment saying why.

If every changed file is a `.md` file, this is the only check to run, with three
exceptions: `assets/orchestrator.md`, the recipes in `assets/loops/`, and `CHANGELOG.md`.
The first two ship in the package, and `kapelle loop` pastes them, so
`tests/package.test.ts`, `tests/loop-cli.test.ts` and `client/tests/loop.test.ts` read
them. A change to them runs the full gate. `CHANGELOG.md` must also run
`npm run check:changelog`, so a changelog-only edit cannot skip the version guard. No test
reads any other tracked `.md` file.

## Format and lint (TS/JS)

`biome` (config: `biome.json`) is the formatter and linter for all tracked TS/JS. After
editing any `.ts`/`.mts`/`.cts`/`.mjs`/`.js`/`.cjs` file, run:

```bash
npx biome check --write .
```

Fix findings before finishing. Biome findings use `// biome-ignore: <rule>: reason`;
pi-lens-native findings use `// pi-lens-ignore: <rule>` — the two do not read each
other's comments. `tsc` stays the type checker (`npm run check`), markdownlint stays for
`.md`.

## Diagnostics (pi-lens)

pi-lens is the deeper lint layer (per-edit dispatch + session scans). Before finishing a
change, clear every finding — no blockers, no warnings. Each finding is resolved one of
four ways: **fix** it (preferred; the fix is observed, not asserted), **suppress** it
inline with `// pi-lens-ignore: <rule>` (bare rule-id, comma-separate several; put the
reason in an adjacent comment — trailing text breaks the match), **disable** the rule
project-wide in `.pi-lens.json` (`rules.<id>.disable`), recording the reason in the commit
message, or **disprove** it (below). Check with `lens_diagnostics` (mode `full`); config
lives in `.pi-lens.json` and `knip.jsonc`.

**Disproving a finding.** pi-lens wraps other tools, and a wrapped tool can report
something the tool itself does not. When a finding names an underlying tool, run that tool
directly; if it disagrees, the finding is disproved rather than resolved. Record in the
commit message: the exact commands run, their exit codes, and why the finding cannot be
true (a line number that no longer exists, a symbol that is not exported, and so on).

Two rules make this a real branch rather than an escape hatch. **Never change code to
satisfy a finding you have not reproduced** — doing so once already introduced a genuine
defect in this repo (a type exported to silence a stale knip report, which then became a
real unused export). And **a disproved lane stops being a gate**: the failure is symmetric,
so a lane that serves a stale finding can equally serve a stale clean result and hide a
real one. Put the underlying tool in CI, where its verdict is reproducible — which is why
`npm run knip` runs there.

## Skills

Reusable procedures live in `.agent/skills/<name>/SKILL.md` as plain Markdown, assuming
only a shell and the CLIs they name. There is no registry and no plugin: read the file and
follow it.

Harnesses that need discovery metadata get a per-harness shim that carries the frontmatter
and points back here: `.pi/skills/` (pi, invoked as `/skill:<name>`) and `.claude/skills/`
(Claude Code, invoked as `/<name>`). Keep procedure edits in `.agent/skills/`; the shims
carry discovery metadata only.

- **[`pickup-issue`](.agent/skills/pickup-issue/SKILL.md)** — run when asked to pick up,
  start, scope or break down a GitHub issue, before writing any code.
- **[`address-comment`](.agent/skills/address-comment/SKILL.md)** — run when asked to
  address, handle, triage or answer review comments on a pull request. Ends with CI read
  and a reply on every thread, including the rejected ones.
- **[`review-local`](.agent/skills/review-local/SKILL.md)** — run when asked to review
  local work on an issue, before the push. The issue gives the scope. Each role
  (developer, tester, security, …) is one file in its `roles/` folder. The gate and the
  proofs run in a temporary worktree. It then applies the fixes in the working tree,
  uncommitted, and posts nothing.
- **[`merge-close`](.agent/skills/merge-close/SKILL.md)** — run when asked to merge-close
  a pull request after verifying all acceptance criteria are met. Merges, cleans up the
  branch, checks whether a linked issue auto-closed without closing it manually, and
  moves whatever that issue was blocking to `Ready` once it has no open blocker left.

Read issues and PRs only with `gh issue|pr view <N> --json ...`; the plain view fails.
