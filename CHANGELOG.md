# Changelog

What changed in each version that a user can see. A release writes its section;
`docs/RELEASING.md` says how.

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
