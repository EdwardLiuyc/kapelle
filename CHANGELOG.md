# Changelog

What changed in each version that a user can see. A release writes its section;
`docs/RELEASING.md` says how.

## 0.3.0

### Added

- The hall: a room the daemon always keeps, with no orchestrator. Its agents show as
  chats under `── chats ──` in the sidebar. `/chat` starts one from any view, and
  `kapelle chat list` prints each as `@name (hall)` (#519).
- `kapelle chat attach @name` on a pipe opens one hall chat (#525).
- `kapelle chat scratch [clean [--yes]]` lists the kept hall scratch folders, and
  removes the stale ones (#528).
- `/chat` and `/add` take `--cwd`, and their forms have a folder field. Each agent can
  work in its own repository, or in a folder with no git (#523).
- Pick an agent's thinking level: `@name /level` lists the model's levels, and
  `@name /level <id>` picks one (#508). `kapelle room add` takes `--level <id>` (#521).
- The TUI status line shows the thinking level (#512).
- `/config` opens a form for the project config, `.kapelle/config.json` (#503).
- A client-local `client.json` can point the CLI and chat at a daemon through an SSH
  tunnel. With it set, a local `run --file` is refused and `--detach` is the remote run
  path (#478).

### Changed

- Git 2.36 is now required. Older Git skips worktree cleanup rather than guessing at
  paths (#532).
- `/config` opens a config file whose content is not valid. It shows the error, and a
  save replaces the whole file (#529).
- A chat refuses `/title` and `/cap`, as it refuses `/add` (#522).

### Fixed

- When a room is deleted, the other chat screens say "the room was deleted". They no
  longer mark it as lost (#513).

## 0.2.0

### Added

- `--model <id>` for `kapelle loop` and `/loop`. The loop does not start when the
  orchestrator is not confirmed on that model (#460).
- `/loop` with no arguments opens a form: pick the folder, the recipe, the task, the
  agent and the model (#468).
- `kapelle demo`: a room with an offline demo agent. It needs no agent and no account
  (#472).
- A `starter` loop recipe ships in the package, and the README has a "Your first loop"
  section (#492).

### Changed

- When an agent fails to start, the next line names the login command, the stderr log,
  or `--verbose` (#486).

### Fixed

- A saved room whose participant's agent is no longer known now opens. That participant
  is set aside, and the rest of the room comes back (#459).
- `/new` and `/add` refuse an empty `--model` (#467).

## 0.1.0

The first release.
