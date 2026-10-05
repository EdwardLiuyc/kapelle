# AGENTS.md

Instructions for any coding agent working in this repo. Harness-neutral by design — this
repo drives several harnesses, so a procedure only one of them can follow is a bug.
`CLAUDE.md` is one line that imports this file, so Claude Code reads the same text.

Use plain language and short sentences in code comments and docs.

This file holds only what an agent cannot learn by reading the code. **The detail lives
at the top of each source file** — read that comment before you change the file. The
history and the measurements live in `docs/`:

- `docs/FINDINGS.md` — what each harness was measured to do. When this file or a source
  comment names a section such as `§M0-4` or `§Multi-turn`, it is a section of
  `docs/FINDINGS.md`.
- `docs/STORIES.md` — the work breakdown, with the reason for each decision.
- `docs/CLIENT-API.md` — the daemon's API, for client authors. `docs/CONFIG.md` — the
  config keys.
- `docs/PROJECT-BRIEF.md` (why), `docs/PROJECT-PLAN.md` (what, in what order),
  `docs/CONTRACT-PLAN.md` (the decision register for M4–M6).

**Do not read `docs/archive/`.** It holds recaps for people, such as a milestone summary.
They are snapshots, and they go out of date. The code and the files above are the
source of truth.

## What this is

`kapelle` is a minimal [Agent Client Protocol](https://agentclientprotocol.com)
**client**, in TypeScript with ES modules. Node ≥24, `"type": "module"`, no build step.
It has two runtime dependencies, both for presentation only: `marked`
(`core/markdown.ts`) and `@earendil-works/pi-tui` (the `chat/tui.ts` screen). Both are
pinned exactly, and an npm `overrides` entry keeps pi-tui on our `marked`.

**The rule for a runtime dependency** (M1c-7, 2026-09-09): it is allowed only in
presentation, after the event bus, where its worst failure is cosmetic. It must not
change a permission decision, the path guard, the policy, mode negotiation, or anything
that reaches a subprocess. Pin it exactly, and give it a fallback so a bad release costs
the screen, never the run: `core/markdown.ts` returns the raw text if `marked` throws,
and `chat/tui.ts` leaves pi-tui's screen before it exits on a throw.

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
npm run knip           # unused files and exports
npm run selftest       # end to end against mock-agent.mjs, --mode auto (writes ACP_TEST.md)
npm run test:harness   # the real harnesses; local only, needs credentials, spends tokens
node cli.ts "<prompt>" [--agent opencode|omp|pi|claude|gemini|copilot] [--cmd "<cmd>"] [--cwd dir] [--mode ask|safe|auto] [--verbose] [--quiet]
node cli.ts run --file <run.json> [--detach]   # N tasks (tasks.json is the example); --detach hands them to the daemon
node cli.ts attach <runId> [--task <id>]       # replay then follow a detached run
node cli.ts ps                                 # every run the daemon knows, with its tasks
node cli.ts merge <runId> [--squash] [--cwd dir]
node cli.ts workspace [--cwd dir]              # where this repo's worktrees and records live
node cli.ts workspace move <old-repo> <new-repo>
node cli.ts daemon start [--port n] [--permission-timeout s]   # same as: node daemon.ts
node cli.ts daemon add <path>
node cli.ts chat [new --agent <id> [--cwd dir]]   # experimental chat rooms: runs chat.ts
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
| `core/worktree.ts` | One git worktree per task. |
| `core/result.ts` | The `<task-result>` contract and its cross-check. |
| `core/merge.ts` | `kapelle merge`. |
| `core/watchdog.ts` | Stall detection: idle, repeat, TTL. |
| `core/notify.ts` | Bell and desktop notification for the two attention events. |
| `core/permissions.ts` | The daemon's queue of pending `ask` decisions. |
| `core/diff.ts` | `git diff` text for a person (M4-6): a question's edit, and an agent's checkout. |
| `core/eventlog.ts` | `events.jsonl`: write, replay and follow. |
| `core/sweep.ts` | The daemon's boot sweep. |
| `core/config.ts` | The config files and `KAPELLE_*` variables. |
| `core/runtime.ts` | The user-level directories and `stateDirFor(root)`. |
| `core/room.ts` | A chat room: a roster of participants, each one harness kept alive across turns. |
| `core/ids.ts`, `core/markdown.ts` | Ids and branch names; the only file that knows `marked`. |
| `render.ts` | Terminal drawing of `session/update` events. |
| `cli.ts` | The CLI and the `kapelle` bin. |
| `daemon.ts` | The HTTP daemon: one for all of the operator's repositories. |
| `daemon/` | The parts of `daemon.ts` that tests can import (`daemon.ts` starts a daemon when imported). |
| `client/contract.ts` | The client API as types, plus `API_VERSION`. |
| `client/daemon.ts` | `daemon.json`, the HTTP calls and the version check. Every `cli.ts` daemon verb and `chat.ts` use it. |
| `client/stream.ts` | The SSE reader with reconnect. `attach` uses it. |
| `client/room.ts` | The room reducer: room lines in, screen state out. No I/O. Both `chat/` screens draw from it. |
| `client/roomset.ts` | The rooms a screen follows (M4-11): one stream and one reducer per room, the poll that adds rooms made elsewhere, and when the screen must end. `readRoom` and `reconcile` too. |
| `client/mention.ts` | The composer's target: `@name` or the orchestrator (R43). Both `chat/` screens send through it. |
| `client/questions.ts` | The queue of open questions over every room (M4-9): which one opens next, and its `n of m`. No I/O. |
| `client/folder.ts` | Tab completion for a folder path, folders only (M4-5), and a typed folder as a full path, with no throw when the current folder was removed. |
| `client/command.ts` | Room and roster commands (M4-5): the typed line parsed, and the one route each calls. Both screens and the pop-up forms use it. |
| `client/diff.ts` | A diff text read for a screen (M4-6): where each file starts, and the question box's `±` line. |
| `client/submit.ts` | What a typed line is: a command, or a message and its target (M4-8). No I/O. Both `chat/` screens read a line through it. |
| `chat.ts` | The chat entry only: the arguments, the verbs and which screen to open. |
| `chat/` | The chat screens (M4-7): `tui.ts`, a pi-tui screen over every room on a TTY; `piped.ts`, one room as plain lines; `common.ts`, what both use. With `chat.ts`, they talk HTTP only, and import only `client/`, pi-tui, `core/runtime.ts` and each other. |
| `chat/view.ts` | What the TUI shows (M4-10): the rows and the row keys, the `@name` pre-fill, where a thread goes when its participant left or its room was dismissed, and what is seen. Pure. |
| `chat/tui/` | The TUI's parts (M4-12): `panel.ts`, the pop-up, its menu and forms; `question.ts`, the question box and its answer; `sidebar.ts`, the sidebar, the strip and the marks; `transcript.ts`, drawing the transcript; `pane.ts`, the side view beside the timeline, with a diff (M4-6) or the history list (M4-4); `banner.ts`, the rows on top of the timeline for a participant that waits (M4-4). `chat/tui.ts` puts them on the screen and keeps the keys, the bell, the send flow and the end. |
| `schema/run.schema.json` | An editor aid for run files. Never a second validator. |

Run state is outside the repository, in `$XDG_STATE_HOME/kapelle/repos/<name>-<hash>/`
(`stateDirFor`). The only file a run reads inside the repository is
`.kapelle/config.json`.

## Rules that are easy to break

- **The policy is a filter, not a sandbox.** It decides what a harness *asks*, and the
  one change a harness can make through us: `fs/write_text_file`. A harness that edits
  through its own shell is outside its reach. opencode and pi never ask at all.
  `core/policy.ts` is the one policy file, and `policyFor(mode)` is the only map from a
  mode to a decider.
- **Keep the path guard separate from the policy.** `#guardPath` compares realpaths and
  applies in every mode, `auto` included.
- **Keep the `toolCallId → {title, kind, rawInput}` map in `AcpAgent`.** A permission
  request can carry only a `toolCallId`. Without the map, every decision goes blind.
- **An approval covers one write.** A denial is sticky. `pickOption` returns `null`
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
- **A new synthetic event starts with `_client_`.** The `render.ts` switch has no
  `default`, so an unknown event is dropped rather than drawn wrong.
- **A missing `measured` half means "not verified".** Do not add a second flag for it.
- **Do not rename the package to `agent-team`.** That npm name and `bin` belong to an
  unrelated live package. `private: true` stays; it blocks `npm publish` only.

## Tests

- Suites live in a `tests/` folder beside their sources. `npm run test` needs no harness,
  so CI needs no credentials.
- `mock-agent.mjs` is the offline, well-behaved harness. **Check a change to
  `protocol/agent.ts` against it before a real harness.** When you add a client
  capability, add a path to it. Scenarios are picked with `--scenario <name>` on argv,
  never with a keyword in the prompt.
- `hostile-agent.mjs` has one attack per `--scenario` and no default. Each attack must
  end its turn normally, so a test proves "refused, and the run continues".
- `tests/cli.test.ts` and `tests/daemon.test.ts` drive the real entry points as
  subprocesses. Each daemon under test gets its own temp `XDG_RUNTIME_DIR` and
  `XDG_STATE_HOME`. Share the helpers in `integration/helpers.ts`; do not copy them.
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
- `session/load` and resume.
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
comment.

## Markdown lint

All tracked `.md` files stay clean under `markdownlint-cli2` (config: `.markdownlint.json`,
the same rules pi-lens applies). After editing any Markdown, run:

```bash
npx -y markdownlint-cli2 --config .markdownlint.json $(git ls-files '*.md')
```

Fix findings before finishing. An inline `<!-- markdownlint-disable MD0xx -->` is allowed
only with a comment saying why.

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
