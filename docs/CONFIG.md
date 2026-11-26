# Config

Four sources set configuration that does not belong in a run file (M2-7, #37;
M11-4, #478):

- **User level** — `$XDG_CONFIG_HOME/kapelle/config.json`, or
  `~/.config/kapelle/config.json` when `XDG_CONFIG_HOME` is unset or relative.
  Holds the daemon-wide knobs, `port` and `permissionTimeoutMs`. One daemon
  serves every added repository (M2-1), so these cannot come from one
  repository's file.
- **Client level** — `$XDG_CONFIG_HOME/kapelle/client.json`, beside the user
  file. Holds `daemonAddress` and `accessKey` for a client that reaches a
  daemon elsewhere. The daemon never reads it.
- **Project level** — `<repo>/.kapelle/config.json`. Holds the run defaults:
  `stallIdleMs`, `stallRepeatCount`, `ttlMs`, `maxConcurrency` and
  `retentionMs`, plus `orchestratorTurnCap` for new rooms and `linkPaths` for
  new worktrees. **Commit it if you want
  to** (#129). It used to be
  uncommittable, because `.kapelle/` also held worktrees and run records and
  `checkStateDir` refused a repository that tracked it; that state now lives
  in `$XDG_STATE_HOME/kapelle/repos/<name>-<hash>/`, so this file is the only
  thing kapelle reads from inside your repository. You write it by hand, or with
  `/config` in the chat (M10-5), which saves through the daemon's `PATCH /config`;
  a safe invalid file can be replaced through `PUT /config` (#504).
  Nothing else creates it, and no preflight looks at it.
  A room reads it from the repository of its own `cwd`. One exception: a
  participant with its own `cwd` (M11-2) gets the `linkPaths` of the
  repository it works in. The room's watchdog limits, turn cap and retention
  still come from the room's repository.
- **Environment** — `KAPELLE_*`. Overrides the user and project files; it does
  not set the client connection. For the run knobs an explicit run-file value
  still wins.

All three files are strict: an unknown key or a wrong type is refused naming
the file and the key, because a silently-ignored `stallIdleMs` typo is a
watchdog that never fires. A missing file is no opinion, never an error. Only
`/config` creates the project file; nothing creates the user or client file.
Unknown `KAPELLE_*` names are the one warning path: the prefix is
also the secret namespace (`SECRET_PREFIX`, stripped from every harness), so an
unknown name may be a secret rather than a typo.

Legend: **✅ happy** · **⚠ warning** · **❌ bad**.

## Where each config is read

| Config | Read by | Not read by |
| --- | --- | --- |
| User file | the daemon's start, however it is reached: `kapelle daemon start` or bare `kapelle` starting one (M9-2) | in-process CLI, merge, sweep |
| Client file | `cli.ts` for daemon-facing HTTP calls and the bare-client auto-start decision; `chat.ts` and `chat/`; the non-detached `run --file` and `kapelle demo` checks read it only to refuse | the daemon process, explicit `kapelle daemon start`/`stop`, `merge`, `workspace`, sweep |
| Project file | `POST /repos`, `POST /runs` (each request), `POST /rooms` and each room the daemon restores at start (its stall limits and turn cap), `kapelle run --file`, `sweepBoot` per repository, `GET /config`, `PATCH /config` and `PUT /config` | plain `kapelle "prompt"`, `merge` |
| `KAPELLE_*` env | the daemon's start (including bare `kapelle`), every run-default and room-cap resolution, `kapelle run --file` | plain prompt, merge |

## User file — `$XDG_CONFIG_HOME/kapelle/config.json`

Daemon-wide knobs only: `port` and `permissionTimeoutMs`. Any failure here
refuses the daemon start (one line, exit 1), before the instance claim.

| Path | Case | Example | Result |
| --- | --- | --- | --- |
| ✅ | file absent | — | no opinion → env → built-in (4719 / 120 s) |
| ✅ | valid port | `{"port": 4719}` | daemon binds 4719 |
| ✅ | ephemeral port | `{"port": 0}` | OS picks; `daemon.json` records the real port |
| ✅ | valid timeout | `{"permissionTimeoutMs": 5000}` | unanswered permission denied after 5 s |
| ✅ | both | `{"port": 0, "permissionTimeoutMs": 1500}` | both applied; flags/env still win |
| ❌ | unknown key | `{"post": 5000}` | `<path>: unknown key "post". Known: port, permissionTimeoutMs.` |
| ❌ | wrong-layer key | `{"ttlMs": 1}` | `<path>: "ttlMs" is a per-repository knob; put it in <repo>/.kapelle/config.json.` |
| ❌ | wrong type | `{"port": "5000"}` | `<path>: "port" must be a whole number 0 or greater; got "5000".` |
| ❌ | port out of range | `-1`, `70000`, `1.5` | whole-number rule, or `must be a port 0-65535; got N.` |
| ❌ | timeout bad | `0`, `-5`, `"soon"`, `2147483648` | `must be a number of milliseconds above 0 and at most 2147483647` |
| ❌ | invalid JSON | `{port: 1}` | `<path> is not valid JSON: …` |
| ❌ | not an object | `[]`, `null`, `42`, `"x"` | `<path> must be a JSON object.` |
| ❌ | unreadable | `chmod 000` | `cannot read <path>: …` |
| ❌ | a directory, a symlink, someone else's, or group/other-writable | `chmod 666` | `<path> must be a plain file owned by you and not writable by anyone else.` |
| ⚠ | — | — | files never warn; strict refusal is the only failure mode |

## Client file — `$XDG_CONFIG_HOME/kapelle/client.json`

Client-local connection settings only. The daemon never reads this file; on a
remote client there need not be a daemon or `config.json` on that machine.
The file must be a plain file owned by you with mode exactly `0600`, because it
holds a credential. A stricter `0400` is refused too, as decided at pickup (#478).

```json
{
  "daemonAddress": "http://127.0.0.1:4719",
  "accessKey": "the token from daemon.json"
}
```

`daemonAddress` must be exactly `http://127.0.0.1:<port>`: no HTTPS, host
name, path, query, fragment or credentials. That loopback form is what an SSH
tunnel reaches today (D6). `accessKey` is sent as the bearer token; until
M11-8 it is the daemon's current token, copied by hand. It must be a bearer
token: one or more letters, digits, or `-._~+/`, then optional `=` padding.
The key must never appear in a URL, request path or log.

Both keys must be present together. A missing file or `{}` is no opinion and
falls back to `daemon.json`. A present setting wins over `daemon.json`: the
client never starts a daemon and never reads the runtime file. If the
configured daemon does not answer, the error names the address it tried.

`kapelle daemon stop` only reads the local `daemon.json`; it never stops a
daemon named by this file. When a configured daemon refuses its API version,
the message says to stop it on the machine that runs it. A chat that loses the
daemon tells a configured client to check the SSH tunnel on its local port or
the remote daemon, then reconnect with `kapelle chat`; a local client is told
to start the daemon. `kapelle demo` is refused because its folder and
`demo-agent.mjs` are local; run it on the daemon machine instead.

With a client setting active, a non-detached `kapelle run --file` is refused
with a message that points to `--detach`; running it locally would put the
harness on the wrong machine. A one-shot `kapelle "<prompt>"` still runs
locally by design: only `run --file` has a daemon-backed `--detach` path.
`--detach` is the supported remote run path, but until M11-5 its `--cwd` must
name an existing repository folder on the daemon machine.

| Case | Result |
| --- | --- |
| file absent, or `{}` | no opinion; use `daemon.json` |
| valid pair | use the configured origin and bearer key |
| only one key | refused: both must be set together |
| unknown key | refused, naming the known keys |
| not a plain file owned by you, or mode other than `0600` (including `0400`) | refused |
| bad address or invalid key | refused; the key is not echoed |
| `kapelle demo` | refused: its folder and agent are local |
| non-detached `kapelle run --file` | refused; use `--detach` |

## Project file — `<repo>/.kapelle/config.json`

Per-run defaults, retention, the orchestrator's turn cap, and the paths a new
worktree links from the main checkout. A bad file surfaces per read site:
`POST /repos` → 400; `POST /runs` → 400; `kapelle run --file` → exit 1; the
boot sweep → `cannot sweep <root>: …` notice and only that repository is
skipped. The daemon keeps booting and serving the rest.

| Path | Case | Example | Result |
| --- | --- | --- | --- |
| ✅ | file absent | — | no opinion → env → built-ins |
| ✅ | idle threshold | `{"stallIdleMs": 1000}` | stall warning after 1 s; `0` disables |
| ✅ | repeat threshold | `{"stallRepeatCount": 3}` | repeat warning at 3 in a row; `0` disables |
| ✅ | TTL | `{"ttlMs": 60000}` | cancel at 60 s; `0` disables |
| ✅ | concurrency | `{"maxConcurrency": 2}` | run-file default parallelism 2 (minimum 1) |
| ✅ | retention | `{"retentionMs": 86400000}` | this repo's terminal runs and dismissed rooms reaped after 1 day; `0` = reap on next sweep |
| ✅ | orchestrator cap | `{"orchestratorTurnCap": 12}` | new rooms allow 12 worker messages from the orchestrator (minimum 1; default 40) |
| ✅ | linked paths | `{"linkPaths": ["node_modules"]}` | each new run-task and room-participant checkout mirrors the path from the main checkout; a missing path is skipped |
| ✅ | all seven | — | all applied (a run-file value still wins for the run knobs) |
| ❌ | unknown key | `{"stallIdle": 1}` | `<path>: unknown key "stallIdle". Known: stallIdleMs, stallRepeatCount, ttlMs, maxConcurrency, retentionMs, orchestratorTurnCap, linkPaths.` |
| ❌ | wrong-layer key | `{"port": 5000}` | `<path>: "port" is daemon-wide; put it in <user-config-path>.` |
| ❌ | wrong type | `{"ttlMs": "soon"}`, `{"maxConcurrency": 1.5}`, `{"linkPaths": "node_modules"}` | whole-number rule naming the key, or the `linkPaths` array rule |
| ❌ | bad link path | `{"linkPaths": ["/x"]}`, `["../x"]`, `["a", "a/b"]`, `[".git"]`, `["sub/.git"]`, `42` | entry-specific rule naming the file and `linkPaths[i]` |
| ❌ | tracked / escaping link | `{"linkPaths": ["README.md"]}`, a path or a directory entry whose real target leaves the checkout | refused when the repository is added, a run starts, a room opens, or `PATCH`/`PUT /config` writes, as `invalid_config`; the path and its entries are checked again when a checkout is made |
| ❌ | link git would see | an untracked path no ignore rule matches | refused when a checkout is made: the task fails, or the room's add is a 400 `invalid_config`; the links are removed again |
| ❌ | out of range | negatives; `{"maxConcurrency": 0}`, `{"orchestratorTurnCap": 0}` | `0 or greater` (watchdog/retention) or `1 or greater` (concurrency/cap) |
| ❌ | invalid JSON / non-object | — | a structural refusal everywhere except `/config`, which shows a `200` invalid view so the file can be replaced |
| ❌ | unreadable | — | `cannot read <path>: …`; `/config` refuses it as unsafe and does not offer replacement |
| ⚠ | — | — | files never warn |

A linked path is **shared state, not a copy**: the symlink points at the main
checkout, so a task that writes through it writes the operator's file, and an
install in one checkout can mutate the directory every task shares. List
paths workers only read. A nested entry needs its parent folders in the
checkout already; the linker does not create them. The links are absolute, so
moving the repository (`kapelle workspace move`) leaves them pointing at the
old path.

A symlink that is a top-level entry of a linked directory must resolve inside
the main checkout. One that leaves it, or is dangling, is refused with
`invalid_config` naming `linkPaths[i]` and the entry; it is not skipped. The
listed path and its entries are resolved again when each checkout is made,
because either can be swapped for an outside symlink after the config was
validated.

A mirror link names a path, not a real target (#447). If that path in the
main checkout is later swapped for a symlink to an outside folder, the
checkout's link then points outside too. The path guard covers only the
client's own file requests (`fs/*`). Every mirror link resolves into the main
checkout, outside the agent's own checkout, so the guard refuses a write
through any mirror link, swapped or not, in every mode. It refuses a read in
`safe` mode, and in the other modes unless `allowReadOutsideRoot` is on. A
harness that reads or writes through its own process, with its shell or its
own file tools, is outside the guard; most harnesses send no `fs/*` at all
(`docs/FINDINGS.md` §M0-1, §M9-1 re-measure).

### Editing it in the chat — `/config`

`/config` opens a form for the repository of the room on screen, or for the folder
the chat started in when no room is open. A hall chat has no project, so `/config`
refuses there and says to attach a room. When that folder's repository is not
added, the chat asks to add it first, as `/new` does. The form lists every project
key with the file's value, and the value in use with its source: `default`, `config`
or `env`. Enter edits a value; a blank value removes the key, so its default applies
again. `linkPaths` is a JSON array, such as `["node_modules"]`. The save row sends
only the changed keys. On a pipe, `/config` prints the same rows for a valid file and
edits nothing.

The daemon checks each value with the rules above before it writes, and the
`linkPaths` the file will hold are also checked against git, as `POST /repos` does.
It never writes a default. A safe file whose content is invalid opens with the
validation error above the rows; saving valid values replaces the whole file through
`PUT /config`. The form warns that any key not entered is removed. Unsafe paths — a
symlink, a non-file, another owner, a file you cannot read, a group/other-writable
file, or a linked `.kapelle` — are refused and left alone. Only `/config` refuses a
linked `.kapelle`; the other config readers keep their read-only behavior.
`PATCH /config` still only merges changed keys into a valid file. A new file is
`0644` whatever the umask; an existing file keeps its mode. A saved value applies to
later runs, new rooms, the next sweep and new checkouts, not to work already underway.
On a pipe, `/config` prints the refusal and says to fix the file by hand or use
`/config` on a terminal to replace it.

## Environment — `KAPELLE_*`

`linkPaths` has no `KAPELLE_*` twin: it is a list of paths relative to one
checkout, and a daemon-wide value would be read against every added
repository. Keep it in the repository's own config. `KAPELLE_LINK_PATHS` is
an unknown name: it warns and is ignored.

Known names are validated and override both files; unknown names are the only
warning path. An offending known value blocks the daemon start and a
`kapelle run --file` the same way a file error does.

| Path | Case | Example | Result |
| --- | --- | --- | --- |
| ✅ | known + valid | `KAPELLE_TTL_MS=60000` | beats project config, loses to run file |
| ✅ | unset | — | no opinion |
| ⚠ | unknown name | `KAPELLE_FOO=1`, `KAPELLE_TOKEN=…` | warns once: `! unknown KAPELLE_* env ignored as config: KAPELLE_FOO. Known: KAPELLE_PORT, …`; ignored; still stripped from harness env by `resolveEnv`. Advisory, so `--quiet` drops it |
| ❌ | known but empty | `KAPELLE_TTL_MS=` | `KAPELLE_TTL_MS is set but empty.` |
| ❌ | known non-numeric | `KAPELLE_TTL_MS=soon` | `KAPELLE_TTL_MS must be a number; got "soon".` |
| ❌ | known wrong range | `KAPELLE_MAX_CONCURRENCY=0` | `… must be a whole number 1 or greater; got 0.` |
| ❌ | port out of range | `KAPELLE_PORT=70000` | `KAPELLE_PORT must be a port 0-65535; got 70000.` |
| ❌ | timeout out of range | `KAPELLE_PERMISSION_TIMEOUT_MS=0` | `… must be a number of milliseconds above 0 and at most 2147483647; got 0.` |

Known name → knob → accepted values:

| Env var | Knob | Accepts |
| --- | --- | --- |
| `KAPELLE_PORT` | `port` | integer 0–65535 |
| `KAPELLE_PERMISSION_TIMEOUT_MS` | `permissionTimeoutMs` | number > 0, ≤ 2147483647 |
| `KAPELLE_STALL_IDLE_MS` | `stallIdleMs` | integer ≥ 0 |
| `KAPELLE_STALL_REPEAT_COUNT` | `stallRepeatCount` | integer ≥ 0 |
| `KAPELLE_TTL_MS` | `ttlMs` | integer ≥ 0 |
| `KAPELLE_MAX_CONCURRENCY` | `maxConcurrency` | integer ≥ 1 |
| `KAPELLE_RETENTION_MS` | `retentionMs` | integer ≥ 0 |
| `KAPELLE_ORCHESTRATOR_TURN_CAP` | `orchestratorTurnCap` | integer ≥ 1 |

## Precedence and built-in floors

| Knob group | High → low | Built-in floor |
| --- | --- | --- |
| `stallIdleMs`, `stallRepeatCount`, `ttlMs`, `maxConcurrency` | task value → run-file run-level → `KAPELLE_*` → project config → default | 300 000 ms / 8 / 3 600 000 ms / 4 |
| `port`, `permissionTimeoutMs` | CLI flag → `KAPELLE_*` → user config → default | 4719 / 120 000 ms |
| `retentionMs` | `sweepBoot` option (tests) → `KAPELLE_RETENTION_MS` → project config → default | 30 days |
| `orchestratorTurnCap` | room PATCH → `KAPELLE_ORCHESTRATOR_TURN_CAP` → project config → default | 40 |
| `linkPaths` | project config only (no env, no run-file field) | no links |
| `daemonAddress`, `accessKey` | client config only (no env or flag) | none; use `daemon.json` when the client file is absent or empty |

Notes:

- `--permission-timeout` is seconds; the env and file forms are milliseconds.
- Project config is re-read on every request/run (edit without a restart);
  the user config is read once at daemon start. `KAPELLE_*` is read at daemon
  start for the daemon-wide knobs, then re-read for every run-default
  resolution and per repository by the boot sweep.
- The client connection is read by each client command that needs a daemon;
  it has no environment or command-line override.
- `0` is a meaningful watchdog value (signal disabled) and a meaningful
  `retentionMs` (reap every terminal run and dismissed room on the next sweep); `port: 0` means
  an OS-chosen port.

## Where this lives

- `core/config.ts` — key sets, value rules, both daemon/project file readers,
  the `KAPELLE_*` reader, `warnUnknownConfigEnv`, `resolveRunDefaults`,
  `DEFAULT_RETENTION_MS`, `resolveRetentionMs`, `resolveOrchestratorTurnCap`,
  `readProjectLinkPaths`, and for `/config` `projectConfigView`,
  `saveProjectConfig` and `replaceProjectConfig`.
- `client/daemon.ts` — `clientConfigPath`, the strict `client.json` reader,
  the client-over-`daemon.json` resolver, the HTTP transport and version check.
- `client/config.ts` — the `/config` rows as lines, the invalid-file lines, and the
  form's values as a `PATCH` or `PUT /config` body.
- `core/worktree.ts` — `openWorktrees` plans and makes the `linkPaths` mirrors,
  and refuses a tracked, escaping, or still-visible link, or an escaping or
  dangling entry of a linked directory.
- `daemon/main.ts` — `DEFAULT_PORT` / `DEFAULT_PERMISSION_TIMEOUT_S` and flag
  resolution.
- `daemon/routes/repos.ts` — `postRepo`, `GET /config`, `PATCH /config`,
  `PUT /config`.
- `daemon/routes/runs.ts` — `postRun`.
- `cli.ts` — `findDaemon`, the M11-4 `run --file` and `demo` refusals,
  `runFromFile`, and the project-config defaults for `--file`.
- `chat/common.ts` — the screen's `client.json`-first address read.
- `core/runfile.ts` — `RunDefaults` and the task > run > config > built-in chain.
- `core/sweep.ts` — the boot sweep and its use of the per-repository retention
  window.
- `core/watchdog.ts` — `WATCHDOG_DEFAULTS`.
- `protocol/registry.ts` — `SECRET_PREFIX`, the reserved `KAPELLE_*` namespace.
