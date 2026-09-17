# Config

Three sources set the knobs that do not belong in a run file (M2-7, #37):

- **User level** — `$XDG_CONFIG_HOME/kapelle/config.json`, or
  `~/.config/kapelle/config.json` when `XDG_CONFIG_HOME` is unset or relative.
  Holds the daemon-wide knobs, `port` and `permissionTimeoutMs`. One daemon
  serves every added repository (M2-1), so these cannot come from one
  repository's file.
- **Project level** — `<repo>/.kapelle/config.json`. Holds the run defaults:
  `stallIdleMs`, `stallRepeatCount`, `ttlMs`, `maxConcurrency` and
  `retentionMs`. **This file is not shared.** `.kapelle/` has to stay
  git-ignored — `checkStateDir` refuses a run in a repository that tracks it —
  so the file cannot be committed, and it reaches nobody else who clones the
  repository. Each person writes their own copy, or the run file carries the
  values instead.
- **Environment** — `KAPELLE_*`. Overrides both files; for the run knobs an
  explicit run-file value still wins.

Both files are strict: an unknown key or a wrong type is refused naming the
file and the key, because a silently-ignored `stallIdleMs` typo is a watchdog
that never fires. A missing file is no opinion, never an error, and nothing
creates one. Unknown `KAPELLE_*` names are the one warning path: the prefix is
also the secret namespace (`SECRET_PREFIX`, stripped from every harness), so an
unknown name may be a secret rather than a typo.

Legend: **✅ happy** · **⚠ warning** · **❌ bad**.

## Where each config is read

| Config | Read by | Not read by |
| --- | --- | --- |
| User file | `kapelle daemon start` only | in-process CLI, merge, sweep |
| Project file | `POST /repos`, `POST /runs` (each request), `kapelle --file`, `sweepBoot` per repository | plain `kapelle "prompt"`, `merge` |
| `KAPELLE_*` env | daemon start, every run-default resolution, `kapelle --file` | plain prompt, merge |

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

## Project file — `<repo>/.kapelle/config.json`

Per-run defaults plus retention. A bad file surfaces per read site:
`POST /repos` → 400; `POST /runs` → 400; `kapelle --file` → exit 1; the
boot sweep → `cannot sweep <root>: …` notice and only that repository is
skipped. The daemon keeps booting and serving the rest.

| Path | Case | Example | Result |
| --- | --- | --- | --- |
| ✅ | file absent | — | no opinion → env → built-ins |
| ✅ | idle threshold | `{"stallIdleMs": 1000}` | stall warning after 1 s; `0` disables |
| ✅ | repeat threshold | `{"stallRepeatCount": 3}` | repeat warning at 3 in a row; `0` disables |
| ✅ | TTL | `{"ttlMs": 60000}` | cancel at 60 s; `0` disables |
| ✅ | concurrency | `{"maxConcurrency": 2}` | run-file default parallelism 2 (minimum 1) |
| ✅ | retention | `{"retentionMs": 86400000}` | this repo's terminal runs reaped after 1 day; `0` = reap on next sweep |
| ✅ | all five | — | all applied (a run-file value still wins per knob) |
| ❌ | unknown key | `{"stallIdle": 1}` | `<path>: unknown key "stallIdle". Known: stallIdleMs, stallRepeatCount, ttlMs, maxConcurrency, retentionMs.` |
| ❌ | wrong-layer key | `{"port": 5000}` | `<path>: "port" is daemon-wide; put it in <user-config-path>.` |
| ❌ | wrong type | `{"ttlMs": "soon"}`, `{"maxConcurrency": 1.5}` | whole-number rule naming the key |
| ❌ | out of range | negatives; `{"maxConcurrency": 0}` | `0 or greater` (watchdog/retention) or `1 or greater` (concurrency) |
| ❌ | invalid JSON / non-object / unreadable | — | the same three structural refusals as the user file |
| ⚠ | — | — | files never warn |

## Environment — `KAPELLE_*`

Known names are validated and override both files; unknown names are the only
warning path. An offending known value blocks the daemon start and a
`kapelle --file` the same way a file error does.

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

## Precedence and built-in floors

| Knob group | High → low | Built-in floor |
| --- | --- | --- |
| `stallIdleMs`, `stallRepeatCount`, `ttlMs`, `maxConcurrency` | task value → run-file run-level → `KAPELLE_*` → project config → default | 300 000 ms / 8 / 3 600 000 ms / 4 |
| `port`, `permissionTimeoutMs` | CLI flag → `KAPELLE_*` → user config → default | 4719 / 120 000 ms |
| `retentionMs` | `sweepBoot` option (tests) → `KAPELLE_RETENTION_MS` → project config → default | 30 days |

Notes:

- `--permission-timeout` is seconds; the env and file forms are milliseconds.
- Project config is re-read on every request/run (edit without a restart);
  the user config is read once at daemon start. `KAPELLE_*` is read at daemon
  start for the daemon-wide knobs, then re-read for every run-default
  resolution and per repository by the boot sweep.
- `0` is a meaningful watchdog value (signal disabled) and a meaningful
  `retentionMs` (reap every terminal run on the next sweep); `port: 0` means
  an OS-chosen port.

## Where this lives

- `core/config.ts` — key sets, value rules, both file readers, the `KAPELLE_*`
  reader, `warnUnknownConfigEnv`, `resolveRunDefaults`, `resolveRetentionMs`.
- `daemon.ts` — `DEFAULT_PORT` / `DEFAULT_PERMISSION_TIMEOUT_S` and flag
  resolution, `postRepo`, `postRun`.
- `cli.ts` — `runFromFile`, the project-config defaults for `--file`.
- `core/runfile.ts` — `RunDefaults` and the task > run > config > built-in chain.
- `core/sweep.ts` — `DEFAULT_RETENTION_MS` and the per-repository retention read.
- `core/watchdog.ts` — `WATCHDOG_DEFAULTS`.
- `protocol/registry.ts` — `SECRET_PREFIX`, the reserved `KAPELLE_*` namespace.
