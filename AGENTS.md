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
| how a loop, a skill or the orchestrator works | its own file: `.kapelle/loops/<name>.md`, `.agent/skills/<name>/SKILL.md`, `assets/orchestrator.md` |
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
**Amended 2026-10-13 (M4-13):** one subprocess is allowed, the shell the person starts
with `/term` and types into. The screen package may send it bytes; it still never
reaches a harness, the daemon, the policy or the path guard. No native code: a native
crash cannot be caught.

**This code is the client. The coding harness is the agent.** We spawn the harness as a
subprocess, own the workspace, serve its filesystem requests and decide its permissions.
Harnesses (opencode, claude, copilot, pi, …) log in by themselves. This client never
touches a key.

## Commands

```bash
npm run check          # tsc --noEmit
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
node cli.ts merge <runId> [--squash] [--cwd dir]
node cli.ts room info | send | add | ff | diff | remove [--room id] [--as name]   # from a participant's checkout; add takes --model id
node cli.ts loop <recipe> <task> ["<note>"] [--agent id] [--cmd "<cmd>"] [--model id] [--cwd dir]   # a room whose orchestrator drives the recipe
node cli.ts loop list [--cwd dir]              # every recipe, its folder, and which one wins a name
node cli.ts workspace [--cwd dir]              # where this repo's worktrees and records live
node cli.ts workspace move <old-repo> <new-repo>
node cli.ts daemon start [--port n] [--permission-timeout s]   # same as: node daemon.ts
node cli.ts daemon stop                        # SIGTERM to the pid in daemon.json, then wait
node cli.ts daemon add <path>
node cli.ts chat [new --agent <id> [--cwd dir]]   # chat rooms: runs chat.ts
node chat.ts attach <roomId> | list | dismiss <roomId>
```

`ACP_TEST.md` is selftest output, not source. You can delete it.

## Where things are

Dependencies point one way: `cli.ts` and `daemon.ts` → `core/` → `protocol/`.
**`core/` may import `protocol/`. `protocol/` never imports `core/`.** That is why
`AcpAgent`'s default policy refuses everything instead of being `safePolicy`.
`client/` imports only `protocol/types.ts`, and nothing in `core/` or `protocol/` imports
`client/`. `chat.ts` → `chat/` → `client/`. `render.ts` → `core/markdown.ts` is the one
arrow that points back.

| Path | What it is |
| --- | --- |
| `protocol/agent.ts` | `AcpAgent`: one harness subprocess, JSON-RPC over stdio, the path guard. |
| `protocol/registry.ts` | The whole adapter layer: one entry per harness, `launch` plus `measured`. |
| `protocol/types.ts` | Hand-written wire types, and the `_client_*` synthetic events. |
| `core/policy.ts` | `safe` / `ask` / `auto`, mode negotiation, `resolvePolicy`. |
| `core/events.ts` | The event bus. |
| `core/runfile.ts` | Run-file validation (`validateRun`). |
| `core/run.ts` | The task pool, and how a status is worked out. |
| `core/worktree.ts` | One git worktree per task, and the `linkPaths` mirror into each new checkout. |
| `core/result.ts` | The `<task-result>` contract and its cross-check. |
| `core/merge.ts` | `kapelle merge`. |
| `core/watchdog.ts` | Stall detection: idle, repeat, TTL. |
| `core/notify.ts` | Bell and desktop notification for the two attention events. |
| `core/permissions.ts` | The daemon's queue of pending `ask` decisions. |
| `core/diff.ts` | `git diff` text for a person (M4-6): a question's edit and an agent's checkout, and the shared ancestry check used by worktree fast-forward and rebase detection. |
| `core/eventlog.ts` | `events.jsonl` and its `events.idx` cache: write, replay and follow. |
| `core/sweep.ts` | The daemon's boot sweep. |
| `core/config.ts` | The config files and `KAPELLE_*` variables. |
| `core/runtime.ts` | The user-level directories, `stateDir()` and `stateDirFor(root)`. |
| `core/harnesses.ts` | Which agents are installed (M9-3): the agent's program, then its ACP program, on the daemon's `PATH`, each version by `--version` (pi-acp's from its `package.json`), and `harnesses.json`. The install (M9-3b): the pinned npm command, and `npm` run with no shell. |
| `core/check.ts` | The login check and the saved models (M9-4): a check session per ready agent, with no prompt, each agent's login signal, `checks.json`, and the update from a real room session. |
| `core/room.ts` | A chat room: a roster of participants, each one harness kept alive across turns. |
| `core/ids.ts`, `core/markdown.ts` | Ids and branch names; the only file that knows `marked`. |
| `core/text.ts` | A harness's text made safe for a terminal (#229): `render.ts`, `cli.ts` and the `ask` prompt use it. `client/room.ts` has a copy, and `tests/text.test.ts` checks that they agree. |
| `render.ts` | Terminal drawing of `session/update` events. |
| `cli.ts` | The CLI and the `kapelle` bin. |
| `daemon.ts` | The HTTP daemon: one for all of the operator's repositories. |
| `daemon/` | The parts of `daemon.ts` that tests can import (`daemon.ts` starts a daemon when imported). |
| `client/contract.ts` | The client API as types, plus `API_VERSION`. |
| `client/daemon.ts` | `daemon.json`, the HTTP calls and the version check. Every `cli.ts` daemon verb and `chat.ts` use it. |
| `client/lifecycle.ts` | The daemon's life from a client (M9-2): start it detached with its log when none answers, wait for `daemon.json`, and stop it on SIGTERM. Its subprocesses are `node daemon.ts` (detached) and `ps` for the start-time identity. Bare `kapelle` uses it. |
| `client/stream.ts` | The SSE reader with reconnect. `attach` uses it. |
| `client/room.ts` | The room reducer: room lines in, screen state out. No I/O. Both `chat/` screens draw from it. |
| `client/roomset.ts` | The rooms a screen follows (M4-11): one stream and one reducer per room, the poll that adds rooms made elsewhere, and when the screen must end. `readRoom` and `reconcile` too. |
| `client/mention.ts` | The composer's target: `@name` or the orchestrator (R43). Both `chat/` screens send through it. |
| `client/questions.ts` | The queue of open questions over every room (M4-9): which one opens next, and its `n of m`. No I/O. |
| `client/folder.ts` | Tab completion for a folder path, folders only (M4-5), and a typed folder as a full path, with no throw when the current folder was removed. |
| `client/command.ts` | Room and roster commands (M4-5): the typed line parsed, and the one route each calls. Both screens and the pop-up forms use it. |
| `client/diff.ts` | A diff text read for a screen (M4-6): where each file starts, the question box's `±` line, and the changed-files block's per-file letters and counts (M7-3). |
| `client/loop.ts` | Loop recipes (M8-5): the two folders a recipe is looked for in, the list, and the orchestrator's first message. `kapelle loop` and `/loop` use it through `client/command.ts`. |
| `client/setup.ts` | The setup list (M9-3): the agents the daemon found, as lines, and when the chat opens it. Both screens and `kapelle setup` print it. The install request and its streamed lines (M9-3b). |
| `client/submit.ts` | What a typed line is: a command, or a message and its target (M4-8). No I/O. Both `chat/` screens read a line through it. |
| `chat.ts` | The chat entry only: the arguments, the verbs and which screen to open. |
| `chat/` | The chat screens (M4-7): `tui.ts`, a pi-tui screen over every room on a TTY; `piped.ts`, one room as plain lines; `common.ts`, what both use. With `chat.ts`, they talk HTTP only, and import only `client/`, pi-tui, `core/runtime.ts` and each other; `chat/tui/term.ts` also imports `@xterm/headless`. Their subprocesses are the clipboard tool (`chat/tui/clipboard.ts`) and the person's shell (`chat/tui/term.ts`). |
| `chat/view.ts` | What the TUI shows (M4-10): the rows and the row keys, the `@name` pre-fill, where a thread goes when its participant left or its room was dismissed, and what is seen; each agent's colour, the activity rows and the status line's fit (M7-1); which tool calls fold into one line, and when (M7-2); where a key moves the question box's cursor (M7-4); which messages the history lists and how a row reads (#362); the history rail's active mark, window, hit rows and two-line preview (M7-7). Pure. |
| `chat/tui/` | The TUI's parts (M4-12): `panel.ts`, the pop-up, its menu and forms; `question.ts`, the question box and its answer; `sidebar.ts`, the sidebar, the strip, the marks and the changed-files block (M7-3); `transcript.ts`, drawing the transcript and its virtual height model; `rail.ts`, the history rail and its hover card (M7-7); `pane.ts`, the side view beside the timeline, with a diff (M4-6) or the history list (M4-4); `banner.ts`, the activity rows under the timeline: a participant that waits (M4-4), or a busy one in the open room (M7-1); `backdrop.ts`, the screen behind an open pop-up: dim, colourless, every background one gray (#407); `clipboard.ts`, a selection copied with the system's own tool, OSC 52 last; `term.ts`, the person's shell (M4-13): `script(1)` for the pty and `@xterm/headless` for its screen. `chat/tui.ts` puts them on the screen and keeps the keys, the bell, the send flow and the end. |
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
- **Keep the path guard separate from the policy.** `#guardPath` compares realpaths and
  applies in every mode, `auto` included.
- **Keep the `toolCallId → {title, kind, rawInput}` map in `AcpAgent`.** A permission
  request can carry only a `toolCallId`. Without the map, every decision goes blind.
  A finished call, or one outside a turn, keeps only its title, kind and status (#163).
  Do not bring back the whole-object merge: a room would keep every call's input.
- **An approval covers one write per file it named, of the bytes the person saw.**
  The rule is at `#writeDecisions` (#310). A denial is sticky. `pickOption` returns `null`
  rather than guess; never fall back to `options[0]` (#13).
- **We send a harness two mode ids at most.** `harnessModeId` picks
  `measured.modeMap.safe` for `safe` and `measured.modeMap.ask` for `ask` and `auto`.
  **Never send `modeMap.auto`**: claude's is `bypassPermissions`, where it stops asking
  us. A room sends one at session start and before the first turn after a change; a run
  sends only `safe`'s (#193). A harness does not keep its mode across `session/load`
  (§Mode after load), so send it again after a load.
- **`--quiet` never hides the containment notice** or the "not negotiated" line (#13).
- **Status comes from our own record** (did we cancel, did the watchdog fire), not from
  `stopReason`. copilot answers `end_turn` for a turn it cancelled (§M0-4).
- **Never add up `usage` across tasks or harnesses.** copilot counts cumulatively;
  the others count per turn.
- **No second prompt during a turn, and no re-ask after it** (§M0-4).
- **No `HStack` below another in the chat screen, and no `auto` size in one.** pi-tui
  sizes an `HStack`'s parts by drawing each in full. A stack there that holds another
  `HStack` joins every line of the whole transcript on every frame, so the screen lags
  more as a room grows: 145 ms a frame at 1,160 rows, against 6 ms flat (#242). Keep
  the timeline and the side view as direct parts of `row` in `screenLayout`
  (`chat/tui.ts`). `chat/tests/layout.test.ts` checks it.
- **A new synthetic event starts with `_client_`.** The `render.ts` switch has no
  `default`, so an unknown event is dropped rather than drawn wrong.
- **A missing `measured` half means "not verified".** Do not add a second flag for it.
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
- `hostile-agent.mjs` has one attack per `--scenario` and no default. Each attack must
  end its turn normally, so a test proves "refused, and the run continues".
- `tests/cli.test.ts` and the daemon suites (`tests/daemon*.test.ts`,
  `tests/attach.test.ts`, `tests/chat-*.test.ts`) drive the real entry points as
  subprocesses. They are split by subject so they run at the same time (#340): put a
  new test in the file whose header names its subject. Each daemon under test gets its
  own temp `XDG_RUNTIME_DIR` and `XDG_STATE_HOME`. Share the helpers in
  `integration/helpers.ts`; do not copy them.
- `integration/*.itest.ts` drives the real harnesses. `node --test` does not discover the
  `.itest.ts` suffix, and that is the only thing that keeps them out of CI, so do not
  rename them. Assert on what the client controls (exit code, our notice lines), never
  on the agent's prose. A missing harness skips.
- `--mode ask` needs a TTY. Without one it becomes `safe`, so tests cannot reach it.

## When something fails

- A harness that fails to start shows as an opaque JSON-RPC error, often
  `Internal error (code -32603)` on `session/new`. Run with `--verbose`, or read
  `<stateDirFor(root)>/runs/<runId>/<taskId>.stderr.log`.
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

If every changed file is a `.md` file, this is the only check to run, with one
exception: `assets/orchestrator.md`. It ships in the package, and `kapelle loop` pastes
it, so `tests/package.test.ts` and `tests/loop-cli.test.ts` read it. A change to it runs
the full gate. No test reads any other tracked `.md` file.

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
