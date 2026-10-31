# Client API

This document tells you how to write a client for the kapelle daemon. A client is any
program that talks to the daemon: `kapelle attach`, `kapelle ps`, `chat.ts`, a TUI, or a
bridge to a chat app.

You do not need to read `daemon.ts` or anything in `core/`. If this document and the code
disagree, that is a bug. Please report it.

Contract version: **1.18** (M5-1, #133; minor bumped by M5-4, #136, M5-5, #137,
M5-6, #138, M5-7, #139, M6-5, #149, M4-3, #49, M4-6, #204, M6-7a, #151, which made
rooms stable, M6-7b, #179, which added `resumed: "loaded"`, M6-7c, #235, which added
`DELETE /rooms/:id`, M8-1, #265, which added a message's `from`, M8-2, #266, which
added replies and copies, `PATCH /rooms/:id`, which renames a room, M8-3, #267,
which added the `reviewer` role and a participant's `turnFrom`, #352, which added
the delete preview, M9-5, #300, which added an agent's `model`, M9-6, #301, which
changes the model during a chat and added an agent's `models`, and #354, which
added `_client_repeat_resolved`).

## Contents

1. [How the daemon works, in short](#how-the-daemon-works-in-short)
2. [Versions and stability](#versions-and-stability)
3. [Find the daemon](#find-the-daemon)
4. [Rules for every request](#rules-for-every-request)
5. [Routes](#routes)
6. [The event stream](#the-event-stream)
7. [Events](#events)
8. [Permissions](#permissions)
9. [Rooms](#rooms)
10. [Bridges](#bridges)
11. [A first client, step by step](#a-first-client-step-by-step)

## How the daemon works, in short

- One daemon runs per user. It serves all of your repositories.
- It listens on `127.0.0.1` only. It never listens on a network address.
- It runs coding agents, called **harnesses** (opencode, claude, copilot, and others).
- A **run** is a list of tasks. Each task is one prompt to one harness. Each task works in
  its own copy of the repository (a git worktree).
- A **room** is a chat with one harness that stays alive between messages.
- Everything that happens in a run or a room goes into an **event log**. You read it as a
  stream.
- Some harness actions need a yes or no from a person. These are **permissions**. You can
  answer them through the API.

## Versions and stability

### The version number

The contract has a version with two numbers: `major.minor`.

- `major` goes up when a change can break an existing client.
- `minor` goes up when something is added. Old clients keep working.

These numbers track the **stable** parts. A **provisional** part changes with its named
story and without a version step; the stability tables below say which is which.

Ask the daemon for its version with [`GET /version`](#get-version). Then compare it with
the version your client was written for:

| Daemon's version vs. yours | What your client should do |
| --- | --- |
| Same `major`, same `minor` | Continue. |
| Same `major`, different `minor` | Continue, and show a warning. Something was added or is missing. |
| Different `major` | Update the client or the daemon, then stop it with `kapelle daemon stop`. |

The client keeps its own version. It never sends it to the daemon.

How can the two differ? The daemon and the client are separate programs. For example, you
update kapelle while an old daemon is still running. The new client then talks to the old
daemon.

### Capabilities

`GET /version` also lists **capabilities**. A capability is a name for one feature that
this daemon has. Names are only added. A name is never removed or renamed within one
`major` version.

Check for a capability before you use its feature. Ignore names that you do not know.

| Capability | What it means |
| --- | --- |
| `repos` | [Repositories](#repositories): add and list. |
| `runs` | [Runs](#runs): start, list, read, cancel. |
| `events` | [The event stream](#the-event-stream) for runs, with replay. |
| `permissions` | [Permissions](#permissions): list and answer. |
| `rooms` | [Rooms](#rooms). Stable since 1.8. |

### Stability

Not every part of this API is final yet. Each part has one of three labels:

- **Stable**: will not break within `major` version 1.
- **Provisional**: works today, but a named story will change it. The story is in the
  table. A provisional part changes with that story and without a version step: the
  version tracks the Stable rows.
- **Experimental**: can change at any time, with no version step. Do not build on it.

**Stable.** You can build on these now.

| Part | Note |
| --- | --- |
| Finding the daemon (`daemon.json`) | |
| Host check and token | |
| `GET /version` | |
| `POST /repos`, `GET /repos` | |
| `POST /runs` request body | |
| `POST /runs` reply (`{id}`) | |
| `Idempotency-Key` on `POST /runs` | Since 1.4 (M5-7). |
| End of a run's stream | `_client_run_finished` since 1.2 (M5-5). |
| Event timestamps (`at`) | Since 1.2 (M5-5). Absent on older lines. |
| `GET /runs/:id`, `DELETE /runs/:id` replies | One shape for live and restored runs (M5-2). |
| SSE format, `seq`, `Last-Event-ID` | |
| Heartbeat (`: ping`) and a paused slow reader | Since 1.3 (M5-6). |
| Event `update` values from the harness (ACP) | Stable as a pass-through. See [Events](#events). |
| `_client_*` events | See [Events](#events). |
| `GET /permissions`, `GET /permissions/:id`, `POST /permissions/:id` | `GET /permissions/:id` added in 1.1 (M5-4). Questions from rooms since 1.5 (M6-5). `input` since 1.6 (M4-3). `diff` since 1.7 (M4-6). |
| Error replies (`{error: {code, message}}`) and the error codes | Codes are only added (M5-3). |
| Request limits: `Content-Type`, body size, unknown fields, read timeout | M5-3. |
| Everything under `/rooms`, and the room events | Since 1.8 (M6-7a). Rooms survive a daemon restart. |

**Provisional and experimental.** These will change. The last column names the story that
changes each one.

| Part | Label | Changed by |
| --- | --- | --- |
| `GET /runs` list | Provisional | M5-9 (filters, order, pages; shared run fields since M5-2) |
| `GET /harnesses`, `POST /harnesses`, `POST /harnesses/done`, `POST /harnesses/install` | Experimental | M4-5 added the list for `chat.ts`; M9-3 the find; M9-3b the install; M9-4 the login check; M9-8 makes them stable |

**Planned, not built yet:** cancel one task (M5-8).

No version is frozen yet. The project is private, so a freeze waits until a second client
needs one. Until then, a change to a stable part still bumps the version.

### Types for TypeScript clients

`client/contract.ts` has every reply shape in this document as a TypeScript type. It also
has `API_VERSION`, `CAPABILITIES`, and the types of the events inside the stream
(`AgentEvent`). A TypeScript client imports this one file for every reply and stream-event
type; the `run` member of the `POST /runs` request body is the run file described by
`schema/run.schema.json`.

A client in another language uses this document. There is no JSON Schema for the API
replies; the run file has its own authoring schema at `schema/run.schema.json`.

## Find the daemon

The daemon publishes a file named `daemon.json` as its lock while it starts, and completes
it with the port and token once it is ready. Your client reads this file to find the port
and the token.

**Where it is:**

- `$XDG_RUNTIME_DIR/kapelle/daemon.json`, when `XDG_RUNTIME_DIR` is set to an absolute path.
  A relative or empty value is treated as unset, like the daemon does.
- Otherwise `<temp dir>/kapelle-<your uid>/daemon.json`. The temp dir is the operating
  system's (`os.tmpdir()`: `$TMPDIR`, `$TMP` or `$TEMP`, else `/tmp`). On macOS, this is
  the usual case.

**What it holds:**

```json
{ "pid": 12345, "port": 4719, "token": "3f9a…" }
```

| Field | Meaning |
| --- | --- |
| `pid` | The daemon's process id. |
| `port` | The port on `127.0.0.1`. |
| `token` | The secret for the `Authorization` header. 64 hex characters. |

**Rules:**

- While the daemon starts, the file can exist with only `pid`; `port` and `token` are added
  once the port is open. Require both before you use the file.
- Once the port is open, the file exists until the daemon stops. No file means no daemon.
- If the daemon crashed, the file can stay. The port then refuses your connection. Restart
  the daemon first.
- A new daemon makes a new token. Read the file again after a restart to retrieve the new
  token.
- The file and its folder are private to your user. Keep the token secret. Never write it
  into a log or a URL.
- The file has no version in it. Ask `GET /version` for that.

## Rules for every request

**Address.** Send every request to `http://127.0.0.1:<port>`. The `Host` header must be
one of these names, with or without a port:

- `127.0.0.1`
- `localhost` (or `localhost.`)
- `[::1]`

Normal HTTP libraries send a path like `GET /runs`. Then any other `Host` gets `403`, and
so do a missing `Host` and two `Host` headers. Some tools send the full address instead,
like `GET http://127.0.0.1:4719/runs`. Then the daemon checks that address and ignores
`Host`.

**Token.** Every request needs this header, on every route:

```text
Authorization: Bearer <token>
```

A missing or wrong token gets `401`.

**Bodies.** Every reply that has a body is JSON, except the event stream. A request body
must follow these rules:

- Send it with the header `Content-Type: application/json`. A parameter such as
  `; charset=utf-8` is fine. Any other type, or no header, gets `415`. Note that `fetch`
  sends `text/plain` for a string body and `curl -d` sends a form type, so set the header
  yourself.
- Keep it at 4 MiB (4 194 304 bytes) or less. A larger body gets `413`. When
  `Content-Length` is too large, the `413` comes before the daemon reads the body. The
  daemon never holds more than 4 MiB of a body: it throws the rest away as it arrives,
  so your upload can finish and you can read the `413`.
- Make it one JSON object. Send only the fields the route names. An unknown field gets
  `400`.
- Send it all within 30 seconds. If you do not, Node answers `408 Request Timeout` with
  an empty body and closes the connection. Node checks only every 30 seconds, so the
  `408` comes 30 to 60 seconds after the request started. This limit covers only the request. A slow reply
  or a long event stream is never cut.

`GET` and `DELETE` have no body and need no `Content-Type`.

**Errors.** Every refusal has this body:

```json
{ "error": { "code": "run_ended", "message": "run 20260922-101500-a1b2 already ended: done" } }
```

- `code` says what went wrong. It is a fixed word. Use it in your code.
- `message` is a sentence for a person. Show it. Do not parse it: the words can change.

New codes can be added. A code is never removed or renamed within one `major` version. If
you get a code that you do not know, decide from the HTTP status code.

Two refusals have no JSON body, because Node sends them before the daemon can answer. A
request that runs past the 30-second limit gets `408`, and the connection closes. A
request that is not valid HTTP gets `400`.

**Error codes:**

| Code | Status | What happened | What to do |
| --- | --- | --- | --- |
| `host_not_allowed` | `403` | The `Host` is not a loopback name. | Connect to `127.0.0.1`. |
| `unauthorized` | `401` | Token missing or wrong. | Read `daemon.json` again. The daemon may have restarted. |
| `no_route` | `404` | No route has this method and path. | Fix the client. |
| `unsupported_media_type` | `415` | The body is not `application/json`. | Set the header. |
| `body_too_large` | `413` | The body is larger than 4 MiB. | Send less. |
| `invalid_request` | `400` | A field is missing, has the wrong type, or is unknown; or the body is not a JSON object; or `Last-Event-ID` is out of range. | Fix the request. |
| `invalid_run` | `400` | The run file is not valid. | Show the message. It names the field. |
| `invalid_config` | `400` | The repository's `.kapelle/config.json` is not valid. | The person fixes that file. |
| `repo_not_added` | `403` | `cwd` is not inside an added repository. | `POST /repos` first. |
| `run_not_found` | `404` | No run has this id. | |
| `room_not_found` | `404` | No room has this id. | |
| `participant_not_found` | `404` | The room has no participant with this id. It may have been removed. | Read `GET /rooms/:id/agents`. |
| `invalid_sender` | `400` | A message's `from` is not the room's orchestrator, or the orchestrator sent a message to itself. Since 1.11. | Only the orchestrator sends with `from`. Send without it for the person. |
| `permission_not_found` | `404` | The daemon never gave out this permission id, or it forgot a closed one at a restart. | |
| `no_event_log` | `404` | The run or room exists, but it has no event log to stream. | Read `GET /runs/:id` for a run, or `GET /rooms/:id` for a room. |
| `run_ended` | `409` | You cancelled a run that already ended. | Stop. Read its status. |
| `already_decided` | `409` | The permission was already closed, for any of the reasons in [Why a question closed](#why-a-question-closed). | Stop. Your answer was not used. `GET /permissions/:id` gives the reason. |
| `queue_full` | `429` | 16 messages already wait for this participant. | Wait for a `_client_turn_ended`, then send again. Or cancel its turn, which drops the queue. |
| `no_turn` | `409` | You cancelled a turn, but the participant has none. | Stop. Its turn already ended. |
| `agent_busy` | `409` | A fast-forward target has a live turn. | Wait for its `_client_turn_ended`, then try again. |
| `not_fast_forward` | `409` | The target branch is not an ancestor of the source branch, or the target checkout is not on its branch, so the move would be a merge or land somewhere else. | Nothing changed. Let a person merge by hand, or choose another source. |
| `dirty_worktree` | `409` | The target checkout has tracked changes, or files the move would overwrite. | Commit or stash them first. Untracked files alone do not refuse. |
| `no_branch` | `409` | A participant has no branch: its checkout is the shared repository folder, or the branch ref is gone. | There is nothing to move; inspect the participant's worktree. |
| `room_dismissed` | `409` | The room was dismissed. | Stop. Open a new room. |
| `room_active` | `409` | You deleted a room that is still active. | Dismiss it first, then delete it. |
| `uncommitted_work` | `409` | You deleted a room, and a checkout has changes nobody committed. New files count. The message names each file. | Nothing changed. Commit or remove the files, then delete again. |
| `agent_exited` | `409` | The participant is stopping: it is being removed, or the daemon is shutting down. A participant whose harness died is not refused: the next message revives it. | Stop. |
| `no_orchestrator` | `409` | The room has no participant with the `orchestrator` role, so a message has no target. | Open a room with an orchestrator. |
| `idempotency_conflict` | `409` | This `Idempotency-Key` already started a run with a different body. | Use a new key for new work. |
| `idempotency_in_progress` | `409` | A request with this `Idempotency-Key` has not answered yet. | Wait, then send the same request again. |
| `orchestrator_exists` | `409` | The room already has an orchestrator. | Change the other participant's role first. |
| `name_taken` | `409` | Another participant in the room has this name. Names are compared without ASCII case, so `Alice` takes `alice`. | Choose another name. |
| `shutting_down` | `503` | The daemon is shutting down. | Try again after it restarts. |
| `room_open_failed` | `500` | A room's harness or checkout could not start. For example, the harness is not installed. | Show the message. |
| `install_running` | `409` | An install already runs (`POST /harnesses/install`). | Wait for its last line, then send again. |
| `no_diff` | `409` | The participant's changes cannot be shown: its checkout is not a git checkout, it has no branch to compare with, or git failed for another reason. The message says which. | Show the message. |
| `internal` | `500` | An error the daemon did not expect. For example, a bug, or a git command that failed in a broken repository. | Show the message. Report it if the repository is fine. |

**Status codes you will see:**

| Code | Meaning |
| --- | --- |
| `200` | Done. |
| `201` | Created (a room or a participant). |
| `202` | Accepted. The work goes on after the reply. |
| `400` | Your request is wrong. The message says what is wrong. |
| `401` | Token missing or wrong. |
| `403` | The `Host` is not allowed, or the folder is not in an added repository. |
| `404` | No such route, run, room or permission. |
| `408` | The request was not fully sent within 30 seconds. Empty body. |
| `409` | The request is fine, but the thing is not in a state to accept it. |
| `413` | The body is larger than 4 MiB. |
| `415` | The body is not sent as `application/json`. |
| `500` | An error the daemon did not expect, or a room could not start. |
| `503` | The daemon is shutting down. |

**Checks run in this order:** the `Host`, then the token, then the route, then the body
(`415`, then `413`, then `400`). `POST /runs` with an `Idempotency-Key` checks the key
format, and whether its first request has answered, before the body. For a key that
already started a run, the daemon reads the body, but does not check the run again,
before it compares the digest: see
[Sending a run again safely](#sending-a-run-again-safely). Some routes resolve a resource
first: `POST /rooms/:id/messages`, `POST /rooms/:id/agents/:agentId/messages`,
`POST /rooms/:id/agents`, `PATCH /rooms/:id` and `PATCH /rooms/:id/agents/:agentId`
look the room up, so an unknown room is `404 room_not_found` even when the body would be
refused. They look the participant up
only after the body, so a bad body to an unknown participant is `400`, not `404`. `DELETE` carries no body, and
the `GET` routes take none.

## Routes

| Method and path | What it does |
| --- | --- |
| `GET /version` | The contract version and the capabilities. |
| `POST /repos` | Add a repository. |
| `GET /repos` | List the added repositories. |
| `GET /harnesses` | List the harnesses the daemon can start by name, and which are installed. Experimental. |
| `POST /harnesses` | Find the installed harnesses again. Experimental. |
| `POST /harnesses/done` | The person has seen the setup list. Experimental. |
| `POST /harnesses/install` | Install the ACP programs of the harnesses the person checked. Experimental. |
| `POST /runs` | Start a run. |
| `GET /runs` | List all runs. |
| `GET /runs/:id` | One run in full. |
| `DELETE /runs/:id` | Cancel a run. |
| `GET /runs/:id/events` | A run's [event stream](#the-event-stream). |
| `GET /permissions` | Decisions that wait for an answer. |
| `GET /permissions/:id` | One decision, open or closed. |
| `POST /permissions/:id` | Answer one decision. |
| `POST /rooms` | Open a room. |
| `GET /rooms` | List rooms. |
| `GET /rooms/:id` | One room. |
| `PATCH /rooms/:id` | Rename a room. |
| `POST /rooms/:id/messages` | Send a message to the room's orchestrator. |
| `GET /rooms/:id/events` | A room's event stream. |
| `POST /rooms/:id/dismiss` | End a room. |
| `GET /rooms/:id/delete-preview` | What a delete would remove from git. |
| `DELETE /rooms/:id` | Throw a stopped room away, with its work on disk. |
| `POST /rooms/:id/agents` | Add a participant. |
| `GET /rooms/:id/agents` | List a room's participants. |
| `GET /rooms/:id/agents/:agentId` | One participant. |
| `PATCH /rooms/:id/agents/:agentId` | Rename a participant, or change its mode, role or model. |
| `DELETE /rooms/:id/agents/:agentId` | Remove a participant. |
| `POST /rooms/:id/agents/:agentId/messages` | Send a message to one participant. |
| `GET /rooms/:id/agents/:agentId/events` | One participant's lines of the room's stream. |
| `POST /rooms/:id/agents/:agentId/turns/current/cancel` | Cancel a participant's turn and drop its queue. |
| `GET /rooms/:id/agents/:agentId/diff` | What a participant changed in its checkout. |
| `POST /rooms/:id/agents/:agentId/fast-forward` | Move a participant's branch and checkout to another participant's commit. |
| `GET /rooms/:id/agents/:agentId/fast-forward` | The diff a fast-forward would bring. |

### `GET /version`

**Reply `200`:**

```json
{
  "apiVersion": { "major": 1, "minor": 18 },
  "capabilities": ["repos", "runs", "events", "permissions", "rooms"]
}
```

Call this first. See [Versions and stability](#versions-and-stability) for what to do
with the answer.

### Repositories

The daemon only works in repositories that you added. You add each repository one time.
The daemon remembers the list after a restart.

#### `POST /repos`

**Request:**

```json
{ "path": "/home/me/src/app" }
```

`path` must be an absolute path to a folder that exists. It can be any folder inside the
repository. The daemon finds the repository root for you.

**Reply `200`:**

```json
{ "root": "/home/me/src/app" }
```

`root` is the real path of the repository root. Adding the same repository twice is fine.

**Refusals:** `400` `invalid_request` when `path` is not absolute or does not exist.
`400` `invalid_config` when the repository's `.kapelle/config.json` is not valid.

#### `GET /repos`

**Reply `200`:** a list of repository roots.

```json
["/home/me/src/app", "/home/me/src/lib"]
```

### `GET /harnesses`

**Experimental.** The harnesses the daemon can start by name, as `agent` in a run, a room
or a participant, and which of them are installed (M9-3). `measured` is `true` when
kapelle measured how the harness behaves. `false` means nobody checked it. Since M9-1,
every harness on this list is measured, so `measured` is always `true`; a client should
still handle `false`.

**Installed** means found on the **daemon's** `PATH`, because the daemon starts the
harnesses. The daemon looks for the agent's own program first (`program`, such as `pi`),
then for the program it starts (`acpProgram`, such as `pi-acp`). Some agents are their
own ACP program: then the two are the same. Each version comes from `--version`, or for
pi-acp from its npm `package.json`, so no session starts.

`state` is one of:

- `ready`: both programs are there.
- `main_only`: the agent is there, its ACP program is not. `install` is the command that
  installs it, pinned to the build kapelle measured. The person runs it, or checks the agent
  in the chat's setup list (`POST /harnesses/install`).
- `not_installed`: anything else.

`warning` is set when the ACP program is not the build kapelle measured. The agent's own
version is shown, never compared.

The daemon saves the find in `$XDG_STATE_HOME/kapelle/harnesses.json`. The first ask with
no saved find runs one, which takes about a second. Later asks read the saved one.
`checkedAt` is when it ran. `done` is `true` once the person said "done" to the setup
list (`POST /harnesses/done`); a new find keeps it. The chat opens the list at start
while `done` is `false`, and while no harness is `ready`.

**The login check** (M9-4). For each `ready` harness, the daemon starts a check session:
`initialize` and `session/new` in a new temporary folder, with no prompt, so no tokens.
All start at the same time, each with a 15-second limit, and the reply waits for them:
about 5 seconds. A `GET` checks a harness only when it has no saved check, its ACP
version changed, or it is `ok` with no saved model list; every `POST /harnesses` checks
them all. Each real session in a room also updates its harness, at no cost: its models
and login state on `session/new`, and its models only on a revive's `session/load`,
because whether a load works logged out is not measured. A session that reports while
a check runs wins only the fields it gave; the check keeps the rest. copilot cannot
delete a session, so each check leaves one empty session in copilot's own history. The
result is saved in `$XDG_STATE_HOME/kapelle/checks.json`, and a `ready` harness that
was checked gets these fields:

- `login`: `ok`, `logged_out`, or `unknown`. `ok` means the harness can open a session
  and use its models, not that the person has an account: opencode with no login is
  `ok`, with its free models. copilot never says, so it is always `unknown`; a check
  that failed or ran out of time is `unknown` too.
- `loginHint`: what the person runs to log in, such as `kimi login`. Only when `login`
  is not `ok` and the check did not fail.
- `checkFailed`: the last check could not open a session: it ran out of time
  (`timeout`), or the harness failed to start or answer (`error`). `login` is then
  `unknown`, with no login hint, since logging in would not fix it, and `models` stay
  from before, since a failure disproves no list. The next real session that gives a
  login clears it; one that gives models only, such as a revive, leaves it.
- `models` (`id` and `name`) and `model`: the harness's model list, and the model its
  last session started with, from the `configOptions` entry with `category: "model"`. A
  change of model during a session is not saved. Absent when the harness sent none, such
  as pi logged out.
- `loginCheckedAt`: when a check or a real session last said something. A revive whose
  load sends no models says nothing, so it does not change this time.

No account field is kept: claude's `_auth/status_update` holds an e-mail and an
organisation, and only its `kind` is read.

**Reply `200`:**

```json
{
  "checkedAt": "2026-10-22T09:30:00.000Z",
  "done": false,
  "harnesses": [
    {
      "id": "pi",
      "measured": true,
      "state": "ready",
      "program": "pi",
      "version": "1.3.0",
      "acpProgram": "pi-acp",
      "acpVersion": "0.0.34",
      "login": "ok",
      "models": [{ "id": "deepseek/deepseek-chat", "name": "DeepSeek Chat" }],
      "model": "deepseek/deepseek-chat",
      "loginCheckedAt": "2026-10-22T09:30:04.000Z"
    },
    {
      "id": "claude",
      "measured": true,
      "state": "main_only",
      "program": "claude",
      "version": "2.1.307",
      "acpProgram": "claude-agent-acp",
      "install": "npm i -g @agentclientprotocol/claude-agent-acp@0.89.1"
    },
    {
      "id": "kimi",
      "measured": true,
      "state": "not_installed",
      "program": "kimi",
      "acpProgram": "kimi"
    }
  ]
}
```

A daemon older than M9-3 sends only the `harnesses` list, as a bare array, with `id` and
`measured`. A daemon older than M4-5 answers `404` `no_route`. Then a client can still
take a name typed by the person.

### `POST /harnesses`

**Experimental.** Finds the installed harnesses again, saves the find, checks the login
of every `ready` one (M9-4), and replies as `GET /harnesses` does. It keeps `done`.
`kapelle setup` and the chat's `/setup` call it. No body.

### `POST /harnesses/done`

**Experimental.** The person said "done" to the setup list: `done` becomes `true`, and the
chat stops opening the list at start. The reply is the same as `GET /harnesses`. No
body.

### `POST /harnesses/install`

**Experimental** (M9-3b). Installs the ACP program of each harness in `ids`. The body
takes ids only, never a command: the daemon builds each command from its registry. It
runs `npm i -g <package>@<measured version>` on the daemon's `PATH`, with no shell, one
harness after the other, each with a 3-minute limit. kapelle never installs a harness's
own program.

**Request:**

```json
{ "ids": ["claude"] }
```

**Refusals:** `400` `invalid_request` when `ids` is not a non-empty list of strings, when
the body has any other field, or when an id is not a harness whose state is `main_only`
now. The daemon finds again before it checks, and one bad id refuses the whole list.
`409` `install_running` while another install runs. `503` `shutting_down` while the daemon
stops.

**Reply `200`:** `application/x-ndjson`, one JSON object per line, as it happens. Each
install starts with its command, then npm's output in pieces. The last line has each
install that failed, and a new find, the same as `GET /harnesses` replies. The find
decides, not npm's exit code, in both directions. A harness that is `ready` after its
install is no failure, whatever npm said, unless it also has a `warning` and npm failed:
then npm stopped after it linked the program, and the install is a failure with npm's
`error`. A harness that is not `ready` is a failure, also when npm exited 0:

- npm failed: `error` is npm's, and `command` is the command that ran. Show it for the
  person to run, for example with `sudo`.
- npm exited 0: its global bin folder is not on the daemon's `PATH`. `error` says so, and
  there is no `command`: run by hand, it would install into the same folder.

```json
{"id":"claude","command":"npm i -g @agentclientprotocol/claude-agent-acp@0.89.1"}
{"id":"claude","output":"added 1 package in 3s\n"}
{"failed":[],"setup":{"checkedAt":"2026-10-28T11:00:00.000Z","done":false,"harnesses":[]}}
```

A client that closes the connection does not stop npm. The next find shows what it did. A
daemon that stops during an install stops npm, and ends the stream with no last line. A
stream that ends without the last line is such a stop, or a cut connection: find again
(`POST /harnesses`) to see what is installed.

### Runs

#### `POST /runs`

Starts a run. The reply comes at once. The run goes on after it.

**Request:**

```json
{
  "cwd": "/home/me/src/app",
  "run": {
    "agent": "opencode",
    "mode": "safe",
    "tasks": [
      { "id": "summarise", "prompt": "Summarise what this project does." }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `cwd` | Absolute path to a folder inside an added repository. The tasks work there. |
| `run` | A run file. Its format is in `schema/run.schema.json`. `tasks.json` is an example. |

**Reply `202`:**

```json
{ "id": "20260922-101500-a1b2" }
```

Treat the id as an opaque string. Do not parse it.

**Refusals, in this order:**

1. `400` `invalid_request`: `cwd` is not an absolute path, or does not exist.
2. `403` `repo_not_added`: `cwd` is not inside an added repository. Add it with
   `POST /repos` first.
3. `400` `invalid_config`: the repository's `.kapelle/config.json` is not valid.
4. `400` `invalid_run`: the run file is not valid. The message names the field.
5. `503` `shutting_down`: the daemon is shutting down.

##### Sending a run again safely

A network error can hide the reply. Then you do not know if the run started. To make a
retry safe, send an `Idempotency-Key` header (since 1.4, M5-7):

```http
Idempotency-Key: 9b2f6c1e-4d7a-4b8e-a0c3-5f1d2e3a4b5c
```

- Make a new key for each new run. A random UUID is a good key.
- The key is 1 to 255 visible ASCII characters, with no space.
- Send the same key and the same body again. You get the same `202 {id}`, and no second
  run starts.
- The daemon compares the parsed body. Spaces between JSON tokens and the order of fields
  in an object do not matter. The order of items in a list does matter.
- One key covers all repositories. A key sent again with a different `cwd` is a
  different body.
- The daemon keeps a key until it stops. After a restart, it forgets all keys.
- The daemon keeps a key only after a `202`. If a request is refused, fix it and send it
  again with the same key.
- A request without the header works as before. Each one starts a run.
- Only `POST /runs` reads the header. Every other route ignores it.

**Refusals for a request with a key:**

1. `400` `invalid_request`: the key is not 1 to 255 visible ASCII characters. A header
   sent twice is refused too.
2. `409` `idempotency_in_progress`: a request with this key has not answered yet. Wait,
   then send the same request again. This normally lasts less than a second. If it lasts
   more than a minute, the daemon is stuck: stop, and tell the person. Do not switch to a
   new key, because the first request can still start its run.
3. A key that already started a run: the daemon reads the body (so `415`, `413` or
   `400 invalid_request` can come first), but it does not check the run again. A
   different body is `409 idempotency_conflict`. The same body gets the same `202 {id}`.

#### `GET /runs`

Every run the daemon knows. This includes finished runs from before a restart.
Provisional: M5-9 adds filters, a fixed order and pages.

**Reply `200`:**

```json
[
  {
    "id": "20260922-101500-a1b2",
    "cwd": "/home/me/src/app",
    "root": "/home/me/src",
    "status": "running",
    "source": "live",
    "startedAt": "2026-09-22T10:15:00.000Z",
    "tasks": [
      { "id": "summarise", "status": "running" },
      { "id": "look-for-bugs", "status": "queued" }
    ]
  }
]
```

| Field | When | Meaning |
| --- | --- | --- |
| `id` | always | The run id. |
| `cwd` | always | The folder the run started in. |
| `root` | always | The added repository the run belongs to. |
| `status` | always | The run status (see below). |
| `source` | always | `live` for a run this daemon started, `restored` for one read back from disk. |
| `startedAt` | usually | ISO 8601, when the run was accepted. |
| `endedAt` | finished runs | ISO 8601, when the run stopped. |
| `tasks` | always | `{id, status}` per task. |

A field the daemon does not have is omitted, never `null`; `GET /runs/:id` describes
the same fields in full.

**Run status** is `running` while the run is live. When the run ends, it is the worst task
status:

| Status | Meaning, mildest first |
| --- | --- |
| `done` | The task finished. |
| `warned` | The task finished, but its report and its changes do not agree. |
| `cancelled` | Someone cancelled it. |
| `skipped` | It did not run. |
| `timed_out` | It ran past its time limit and was stopped. |
| `failed` | It failed. |
| `killed` | The daemon stopped while the run was live, for example a crash or a power cut. Only a run or a task read back after a restart has it. Since 1.2 (M5-5). |

**Task status** is one of the task words above, or `queued` (not started yet), or
`running` (while the run is live). After a restart, a task that was running when the
daemon stopped is `killed`, and a task that never started stays `queued`. In TypeScript,
`TaskDto.status` is a `string`, so it can carry these words.
Show a word that you do not know as it is. Do not fail on it; that goes for the run
status too, which comes off the same record.

#### `GET /runs/:id`

One run in full. Since M5-2 a live run and a run restored after a restart carry the
same shape: `source` says which one it is, and a field the record cannot fill is
omitted, never `null`.

**Reply `200`:**

| Field | When | Meaning |
| --- | --- | --- |
| `id` | always | The run id. |
| `cwd` | always | The folder the run started in. |
| `root` | always | The added repository the run belongs to. |
| `status` | always | The run status (see above). |
| `source` | always | `live` or `restored` (see above). |
| `startedAt` | usually | ISO 8601, when the run was accepted. |
| `endedAt` | finished runs | ISO 8601, when the run stopped. |
| `durationMs` | live run, after it ends | The run's own elapsed time. Absent on a restored run. |
| `turns` | live run, after it ends | How many tasks got a prompt. Absent on a restored run. |
| `notices` | always | A list of `{taskId, text, kind?}`. Lines for the person to read. See below. |
| `tasks` | always | One task per entry; `[]` when the record has none. |
| `error` | run could not start | Why. No task ran. A restored run has it too. |
| `cancelRequested` | after a cancel | `true`. The status stays `running` until the run stops. |

Each task has `id` and `status`, and when known `agent`, `durationMs`, `error`,
`usage`, `usageSemantics`, `warnings` (`{kind, text}` each), `summary`,
`summarySynthesised`, `branch`, `baseSha` and `sessionId`. `usage` carries the token
counts and may carry a `_meta` object, passed through unchanged (C11). `cwd`,
`stopReason`, `transcript` and the structured `result` are not part of the contract:
the event stream carries the prose, and a restored run never had them.

A live run's `startedAt`/`endedAt` are the daemon's clock; a restored run's are the
record's own stamps, so the same run can report them a moment apart after a restart.

A notice's `kind` is `containment`, `unverified`, `version` or `advisory`. **Always show
`containment` notices.** They tell the person how much the harness is contained. The other
kinds are advice.

**Refusals:** `404` `run_not_found` for an unknown id.

#### `DELETE /runs/:id`

Asks the run to stop. Stopping takes a moment, so the reply comes first.

**Reply `202`:** the run, as `GET /runs/:id` gives it, with `cancelRequested: true`.
Poll `GET /runs/:id`, or follow the event stream, to see when it stops.

**Refusals:** `404` `run_not_found` for an unknown id. `409` `run_ended` when the run
already ended.

#### `GET /runs/:id/events`

The run's event stream. See [The event stream](#the-event-stream).

**Refusals:** `404` `run_not_found` for an unknown id, `404` `no_event_log` when the run
has no event log. `400` `invalid_request` for a bad `Last-Event-ID`.

## The event stream

A run or a room writes every event into a log. You read the log as
[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
(SSE). SSE is a plain HTTP reply that stays open. The server writes text blocks into it
over time.

The stream first sends every event from the start (the history). Then it sends new events
as they happen (the live tail). History and live tail look the same.

### Format

The reply has `Content-Type: text/event-stream`. Each event is one block:

```text
id: 7
data: {"seq":7,"at":"2026-09-24T10:15:02.113Z","agent":"summarise","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}

```

- `id` is the event's `seq`.
- `data` is one line of JSON: `{seq, at, agent, update}` for a run, and
  `{seq, at, roomId, participantId, update}` for a room.
- A blank line ends the block.

| Field | Meaning |
| --- | --- |
| `seq` | The event's number in this log. The first event is `1`. It goes up by one each time, with no gaps. |
| `at` | ISO 8601, when the daemon wrote the event. Since 1.2 (M5-5); older events have none. |
| `agent` | Runs only: the task id, or `""` for `_client_run_finished`. |
| `roomId` | Rooms only: the room. |
| `participantId` | Rooms only: the participant's opaque id. Its name is in `GET /rooms/:id`, because a rename changes the name and never the id. |
| `update` | The event itself. See [Events](#events). |

An event may carry `_meta`, an object the harness attached to it. It is passed through
unchanged; a client may ignore it.

### Resume after a break

Send the last `seq` that you got in the `Last-Event-ID` header:

```text
Last-Event-ID: 7
```

The stream then starts at `seq` 8. You get no event twice and miss none. Without the
header, you get everything from `seq` 1.

The value must be a whole number from 0 to the number of events so far. Any other value
gets `400`.

A browser `EventSource` sends this header for you when it reconnects. Other clients must
send it themselves. (A browser also cannot send the token header; the browser path is
retired, so this is not on a current story.)

The daemon keeps no cursor for you. Your client keeps the last `seq`. A new process that
has no cursor starts from `seq` 1 and builds its view again from the replay.

### Heartbeat

Every 15 seconds the daemon writes a comment line into the stream (since 1.3, M5-6):

```text
: ping

```

An SSE parser ignores a line that starts with `:`. The ping lets you tell a quiet run
from a daemon that stopped answering. There is no `retry:` line.

### When to reconnect

This is the rule `kapelle attach` follows. A client can follow the same rule.

- Treat the connection as cut when it fails, when it ends with an error, or when no byte
  arrives for 45 seconds (three missed pings).
- Connect again with `Last-Event-ID`. Wait 250 ms before the first try. Double the wait
  after each failed try, up to 5 s. Go back to 250 ms once a connection gets data, not
  when it only connects: a stream can be accepted and then cut at once.
- Read `daemon.json` again before each try. A daemon that restarts has a new token, and
  it can have a new port.
- Stop when `daemon.json` is gone. The daemon removes it only when it stops cleanly, so no
  new daemon is coming. After a crash the file stays, so keep trying.
- Stop on any refusal: a status that is not 2xx, such as `404`, `400` or `500`. A new
  try gets the same answer.
- Drop any event whose `seq` is at or below the last one you have.

### A slow reader

If your client reads more slowly than events arrive, the daemon waits for you (since 1.3,
M5-6). It keeps at most about 64 KiB for your connection, plus the one event that went
past that mark. It reads the rest from the event file when you catch up. It does not close
your connection and it does not slow the run. No ping is written while it waits.

### End of the stream

- For a run, the last event is `_client_run_finished`, with the run's `status`. Then the
  stream ends. When you get that event, `GET /runs/:id` already shows the same status.
- A run's stream can also end with no `_client_run_finished`. This happens for a run
  from before 1.2, a run that stopped when the daemon stopped, and a run that failed
  inside the daemon after its log was opened. Then call `GET /runs/:id` for the result.
  If the status is still `running`, connect again with `Last-Event-ID`. Either the
  connection was cut, or the run failed inside the daemon a moment ago and its status
  is not saved yet. In the second case, the new stream ends at once, and `GET` then
  shows `failed`.
- A run whose worktree preflight failed has an empty stream. It ends at once, with
  no `_client_run_finished`. `GET /runs/:id` shows `failed` and the `error`, also
  after a restart.
- A run whose state folder the daemon could not make has no log. Then
  `GET /runs/:id/events` answers `404 no_event_log`. `GET /runs/:id` carries the
  status until the daemon stops, but no record is kept.
- For a room, the stream ends when the room closes.
- For a finished run, you get the history and then the end.

If the connection breaks before the end, connect again with `Last-Event-ID`.

### Chunks are not joined

A harness sends its text in many small pieces. Each piece is its own event. To show a
whole message, join the `text` of consecutive `agent_message_chunk` events.

## Events

`update.sessionUpdate` says what kind of event it is. There are two families.

### From the harness (ACP)

These come from the harness unchanged, as the
[Agent Client Protocol](https://agentclientprotocol.com) `session/update` defines them.
The daemon passes them through. It does not promise their content, because each harness
fills them in its own way.

| `sessionUpdate` | Meaning |
| --- | --- |
| `agent_message_chunk` | A piece of the agent's answer. Text is in `content.text`. |
| `agent_thought_chunk` | A piece of the agent's thinking. |
| `user_message_chunk` | A piece of the prompt, repeated back. |
| `tool_call` | The agent starts a tool: `toolCallId`, `title`, `kind`. |
| `tool_call_update` | A tool changed: status, output. Same `toolCallId`. |
| `plan` | The agent's plan, as `entries`. |
| `available_commands_update` | Commands the harness offers. |
| `current_mode_update` | The session mode changed. |
| `config_option_update` | Session settings, for example the model. |
| `session_info_update` | Session title or time. |
| `usage_update` | Tokens used so far, and maybe cost. |

Ignore a `sessionUpdate` that you do not know. New ones can appear.

### From kapelle (`_client_*`)

The daemon adds its own events. Their names all start with `_client_`, so they never clash
with ACP names.

**Tasks** (runs; a room also emits `_client_worktree_created`, one per participant):

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_task_started` | `harness` | The task left the queue. Its events follow. |
| `_client_worktree_created` | `path`, `branch`, `baseSha` | The task's (or room's) own checkout exists. Missing when the run shares one folder. |
| `_client_task_finished` | `status`, `durationMs` | The task's verdict. A task cancelled before it started has this event but no `_client_task_started`. |

**Runs** (since 1.2, M5-5):

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_run_finished` | `status`, `durationMs`, `turns` | The run is over. `status` is the run status. It is the last event, after every `_client_task_finished`, and `agent` is `""`. See [End of the stream](#end-of-the-stream). |

**Permissions:**

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_permission_pending` | `title`, `kind` | A decision is about to be taken. It fires for every decision, also ones that need no person. |
| `_client_permission_queued` | `id`, `title`, `kind`, `input?`, `diff?` | A decision waits for a person. Answer it with `POST /permissions/:id`. `input` is the tool's input, and `diff` what an edit would change: see [`GET /permissions`](#get-permissions). `input` since 1.6, `diff` since 1.7. |
| `_client_permission_answered` | `id`, `allow`, `reason` | A queued decision closed. `id` is the one from `_client_permission_queued`. `reason` says why: see [Why a question closed](#why-a-question-closed). |
| `_client_permission` | `allow`, `title`, `kind`, `optionId?` | The decision was taken. |

**Files and cancel:**

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_wrote_file` | `path` | The daemon wrote a file for the harness. |
| `_client_cancel_requested` | `sessionId` | The daemon asked the harness to stop its turn. |

**Warnings:**

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_result_warning` | `kind`, `text` | The task's report and its changes do not agree. `kind` is `noResultBlock`, `filesNotInDiff`, `filesUnclaimed` or `policyNeverFired`. |
| `_client_stall_warning` | `kind`, `text` | The task, or a room participant's turn, looks stuck. `kind` is `idle` (quiet too long) or `repeat` (the same operation again and again: same title, kind, input and path). It keeps running: in a room, only a cancel ends a turn. |
| `_client_repeat_resolved` | — | Since 1.18. Rooms only. The loop a `repeat` warning named is over: the participant ran another operation. The warning's line stays as history. |

**Harness process:**

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_harness_spawned` | `pid` | The harness process started. |
| `_client_harness_exited` | `pid` | The harness process is gone. In a room, a participant whose harness exits during a turn is `killed`, and one that exits while idle is `exited`. |

**Rooms**:

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_message_queued` | `text`, `from?`, `kind?` | A message reached a busy participant and waits. `_client_user_message` follows when its turn starts. `from` and `kind` as below. |
| `_client_user_message` | `text`, `turn`, `from?`, `kind?` | The participant's turn starts with this message. The line's `participantId` names who got it. `turn` counts that participant's turns from 1. It is absent on lines written before 1.5. `from` is the id of the participant that sent the message (since 1.11). No `from` means the person sent it. `kind` is `reply` or `copy` for a message the daemon sent (since 1.12): see [Replies and copies](#replies-and-copies). |
| `_client_turn_ended` | `stopReason?`, `error?` | The harness finished its answer, and the next queued message starts. `error` means the turn failed. |
| `_client_queue_cleared` | `count` | `count` queued messages were dropped and never sent: the turn was cancelled, the participant was removed, its harness exited, or the room was dismissed. |
| `_client_participant_added` | `name`, `role?`, `harness`, `mode` | The participant joined: a starter when the room opened, or an add. It comes after its `_client_harness_spawned`, and after `_client_worktree_created` when it has its own checkout. An add that fails never logs this, though it may have logged either of the other two. |
| `_client_participant_changed` | `name?`, `role?`, `mode?`, `model?` | A rename, or a new role, mode or model. Only the changed fields are present. `role: null` means the role was cleared. `model` (since 1.17) is the model the harness runs on after a change of model, also after a refused one, or `null` when the harness names none. |
| `_client_participant_fast_forwarded` | `from`, `branch`, `sha` | A fast-forward moved the target participant's branch and checkout to `from`'s commit. `from` is the source participant id, `branch` the target's branch, and `sha` the commit it now points at. A no-op move writes none. |
| `_client_participant_removed` | none | The participant left the roster. It is the participant's last line. A dismiss has no such line: the stream ends instead. |
| `_client_participant_revived` | `resumed`, `sessionId`, `memoryMayBeBehind?` | A `paused`, `killed` or `exited` participant has a new harness in its own checkout. `resumed` is `loaded` (since 1.9): it loaded its old session and remembers the turns before. Or it is `fresh`: a new session, so it does not. `memoryMayBeBehind` is `true` only with `loaded`, when the participant stopped during a turn: what it remembers may be behind its files. It comes after the `_client_user_message` that revived it, and after the new `_client_harness_spawned`. |

Build the roster from these three events. Then a replay shows the roster as it was at
each `seq`, and a rename by another client shows too. `client/room.ts` does this for a
TypeScript client.

A turn is the span from `_client_user_message` to `_client_turn_ended` of one
participant. A `_client_message_queued` with no `_client_user_message` after it was
dropped: by `_client_queue_cleared`, or by a daemon restart, which loses the queue.

Ignore a `_client_*` name that you do not know. New ones can appear.

## Permissions

Some harness actions need a yes or no, for example "edit this file". A run in `ask` mode,
and a room participant in `ask` mode, asks a person through the API. Reading, searching,
fetching and thinking never ask.

**How to answer:**

1. See the question. Either watch a stream for `_client_permission_queued`, or poll
   `GET /permissions`.
2. Show the `title`, `kind` and `input` to the person. All three are the harness's text:
   remove control characters before you draw them.
3. Send the answer with `POST /permissions/:id`.

**Rules:**

- **The first answer wins.** Two clients can see the same question. Only the first answer
  counts. A later answer gets `409`.
- **No answer means no.** A question with no answer is denied after a time limit. The
  default is 120 seconds. The daemon's owner sets it with `--permission-timeout`.
- **Cancel means no.** When a run is cancelled or ends, or its task stops, its open
  questions are denied. In a room, the open questions of a turn are denied when the turn
  ends for any reason: a cancel, a removal, a dismiss or a harness that exits.
- **A mode change answers.** When a room participant leaves `ask`, its open questions
  close: `auto` answers yes, and `safe` answers no.
- A stream replay also shows old `_client_permission_queued` events. Check
  `GET /permissions` before you ask a person. If the id is not there, the question is
  already closed.
- Every client sees the same close. Each queued question closes exactly once, with one
  `_client_permission_answered` event in the stream.

### Why a question closed

`_client_permission_answered` and `GET /permissions/:id` give one of these reasons:

| `reason` | `allow` | What closed the question |
| --- | --- | --- |
| `client` | `true` or `false` | A client answered with `POST /permissions/:id`. |
| `timeout` | `false` | Nobody answered in time. |
| `cancel` | `false` | The run was cancelled, or the daemon stopped. In a room: the turn was cancelled, the participant was removed, its harness exited, or the room was dismissed. |
| `task_end` | `false` | The question's task ended, for example at its time limit. |
| `run_end` | `false` | The run ended with the question still open. |
| `mode_change` | `true` or `false` | A room participant left `ask`: `true` for `auto`, `false` for `safe`. Since 1.5. |

New reasons can be added. If you get a reason you do not know, use `allow`.

A daemon restart forgets closed questions. `GET /permissions/:id` then answers `404`, but
the run's event stream still has the `_client_permission_answered` event. The one
exception is `run_end`: the run's stream has already ended by then, so only
`GET /permissions/:id` has it. Today no question is still open at the end of a run, so
this does not happen.

### `GET /permissions`

**Reply `200`:** every open question, from all runs and rooms. A question from a run has
`runId` and `taskId`. A question from a room has `roomId`, `participantId` and `turn`
instead. `turn` is the number on that turn's `_client_user_message`.

```json
[
  {
    "id": "7d4c1e0a-5b2f-4a61-9c3e-2f8b1d6a9e40",
    "runId": "20260922-101500-a1b2",
    "taskId": "summarise",
    "kind": "edit",
    "title": "Edit README.md"
  },
  {
    "id": "0b9e6f3c-2d71-4e8a-b5c4-7a1f3e9d2c68",
    "roomId": "room-20260929-101500-a1b2",
    "participantId": "p-4f2a9c",
    "turn": 3,
    "kind": "execute",
    "title": "npm test",
    "input": { "command": "npm test", "description": "Run the tests" }
  }
]
```

`kind` is one of `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`,
`switch_mode`, `other`. Treat `id` as an opaque string.

`input` is the tool's input as the harness sent it, so a person can judge the action. Since
1.6. It is absent when the harness sent none. Each value is text: a value that was not a
string is its JSON. It holds at most 8 fields. A key is cut at 64 characters and a value at
400, so a cut value ends with `…`. The whole object is held within 4 KB of JSON, so some
of the 8 fields can be dropped when their text has long escapes. Its fields differ by
harness: for example `command` for a shell command, or `path` and `file_text` for a new
file.

`diff` is what an edit would change, as `git diff` text with its size. Since 1.7. The
daemon builds it from what the harness said before it asked: a `diff` block on the tool
call, or `path` and `file_text` in its input, or the text of a `fs/write_text_file` that
did not ask. It is absent for a tool that is not an edit, for a path outside the
checkout, and for an edit that changes nothing.

```json
"diff": {
  "text": "diff --git a/notes.md b/notes.md\nnew file mode 100644\n…",
  "files": 1,
  "added": 12,
  "removed": 0
}
```

The text is cut at 32 KB, at a line end, and then ends with `… N more lines`. `files`,
`added` and `removed` are counted before the cut. A new file has git's `new file mode`
line. The text is the files' own: remove control characters before you draw it. Like
`input`, it is part of `_client_permission_queued`, so it is written to the run's or the
room's event log on disk and replayed to every client that attaches.

### `GET /permissions/:id`

**Reply `200`:** one decision. An open one looks the same as in `GET /permissions`. A
closed one also has `allow` and `reason`:

```json
{
  "id": "7d4c1e0a-5b2f-4a61-9c3e-2f8b1d6a9e40",
  "runId": "20260922-101500-a1b2",
  "taskId": "summarise",
  "kind": "edit",
  "title": "Edit README.md",
  "allow": false,
  "reason": "timeout"
}
```

Use it after a `409` to learn who won. **Refusals:** `404` `permission_not_found` for an
id the daemon never gave out, or one it forgot at a restart.

### `POST /permissions/:id`

**Request:**

```json
{ "allow": true }
```

**Reply `200`:**

```json
{ "id": "7d4c1e0a-5b2f-4a61-9c3e-2f8b1d6a9e40", "allow": true }
```

**Refusals:** `400` `invalid_request` when `allow` is not `true` or `false`. `404`
`permission_not_found` for an id the daemon never gave out, or one it forgot at a
restart. `409` `already_decided` when the question is already closed, for any reason in
[Why a question closed](#why-a-question-closed); `GET /permissions/:id` names it.

## Rooms

Rooms are stable since contract 1.8. `chat.ts` uses them.

A room is a container on one repository. It holds a list of participants. Each
participant is one harness with one session that stays alive between messages. Each
participant has its own git branch and checkout. Today:

- A participant has its own mode, `auto` by default. An `ask` participant asks through
  [Permissions](#permissions), and a question nobody answers is denied at the time limit.
  See [Modes](#modes).
- A message goes to one participant. A busy participant keeps up to 16 messages in a
  queue and answers them in order. The queue is in memory: a daemon restart loses it.
- A turn is never cut by a clock. A quiet turn gets `_client_stall_warning`, and only a
  cancel ends it.
- A room survives a daemon restart. See [After a restart](#after-a-restart).

### `POST /rooms`

**Request:** `cwd`, plus an optional `title` and an optional `agents` list. A `title` must
not be blank, and it is kept trimmed. Without `agents`, or with an empty list, the room is
empty.

```json
{
  "cwd": "/home/me/src/app",
  "title": "fix login",
  "agents": [{ "agent": "opencode", "name": "alice", "role": "orchestrator" }]
}
```

An agent takes:

- `agent` (a harness name) or `cmd` (a command line). One of them is required.
- `name`: optional. It must match `^[A-Za-z0-9_-]{1,32}$`. The default is the harness
  name. When that name does not match, give a `name`.
- `role`: optional. One of `orchestrator`, `developer`, `tester`, `architect` or
  `reviewer` (since 1.14). No role
  is given by default. A message with no `@name` goes to the `orchestrator`, or to the
  only participant when the room has one and no orchestrator: see
  [Addressing](#addressing).
- `mode`: optional. `ask`, `safe` or `auto`. The default is `auto`. See [Modes](#modes).
- `model`: optional, since 1.16. A model id, such as one from the agent's `models` in
  [`GET /harnesses`](#get-harnesses). The daemon does not check it against that list; the
  harness does. The daemon sets it after each start of the harness, a revive too, before
  the first turn. When the harness refuses it, does not answer, answers with another
  model, or lists no models, the agent still joins, on the model the harness chose, and a
  notice says so. A failed set is tried again at the next revive, not before. Without
  `model`, the harness chooses.
- `base`: optional. The git ref the participant's branch starts from. It can be another
  participant's `branch`, so a reviewer starts from the developer's commits. The default
  is the repository's `HEAD`. Only committed work is on a branch. The participant's
  `baseSha` records the resolved commit; if the harness later rebases the branch, the
  daemon moves `baseSha` to the commit the rebase moved it onto.
- `settings`: optional. `{ "allowReadOutsideRoot": false }` is the only setting today, and
  that is its default. `true` lets the harness read files outside its checkout through
  the daemon. The daemon never writes there for it. This is not isolation: it covers only
  the files a harness asks the daemon for. A harness that reads or writes with its own
  tools, such as a shell, is outside it.

Names in one room are unique, without ASCII case. At most one agent has the
`orchestrator` role. The agents are added in the order of the list.

There is no field for instructions. Send them as the first message, so every client sees
what the agent was told.

The reply comes when every harness is ready. This can take some seconds.

**Reply `201`:** the room.

```json
{
  "id": "room-20260922-101500-a1b2",
  "cwd": "/home/me/src/app",
  "title": "fix login",
  "createdAt": "2026-09-22T10:15:00.000Z",
  "updatedAt": "2026-09-22T10:15:00.000Z",
  "status": "active",
  "seq": 3,
  "participants": [
    {
      "id": "p-0k3x9a2b",
      "name": "alice",
      "role": "orchestrator",
      "harness": "opencode",
      "mode": "auto",
      "settings": { "allowReadOutsideRoot": false },
      "worktree": "/home/me/.local/state/kapelle/repos/app-1a2b3c/wt/room-…/p-0k3x9a2b",
      "branch": "kapelle/room-20260922-101500-a1b2/p-0k3x9a2b",
      "baseSha": "3f2a…",
      "sessionId": "ses_…",
      "model": "deepseek/deepseek-chat",
      "models": [{ "id": "deepseek/deepseek-chat", "name": "DeepSeek Chat" }],
      "status": "idle",
      "notices": [{ "text": "…", "kind": "containment" }]
    }
  ]
}
```

A room's `status` is `active`, `paused` (the daemon stopped, see
[After a restart](#after-a-restart)) or `dismissed`. A participant's `status` is `idle`
(waits for a message), `busy` (answers a message), `exited` (the harness died while
idle), `killed` (it stopped during a turn without a clean end, so its memory may not match
its files), `paused` (a shutdown stopped it cleanly) or `dismissed`. A message to an
`exited`, `killed` or `paused` participant revives it.

`resumed` is missing until a participant is revived. Then it is `loaded` (since 1.9): the
participant loaded its old session and remembers the turns before, with the same
`sessionId`. Or it is `fresh`: it has a new session and a new `sessionId`, and does not
remember the turns before. A client that does not know a value shows it as text. The
warning that a loaded participant's memory may be behind its files is on the stream only,
as `memoryMayBeBehind` on `_client_participant_revived`. A client that only polls this
reply never sees it.

`model` (since 1.16) is the model the harness runs on, as the harness last said. It is
missing when the harness lists no models, and for a restored participant until its first
revive. It may differ from the `model` that was asked for: then a notice names the
refusal. The asked one is kept, and sent again at the next revive.

`models` (since 1.17) is the model list of the harness's live session, as `id` and
`name`, as the session sent it. A change of model never changes it: copilot's answer to a
change leaves an option out. It is missing when no harness runs, such as a restored
participant before its first revive, and when the harness lists no models.

`seq` is the size of the room's log when the daemon answered. The reply counts every line
up to that `seq`, and a line above it is newer than the reply.

The participant `id` is opaque. `title`, `role`, `branch` and `baseSha` are missing when
there is no value. `branch` and `baseSha` are missing when `cwd` cannot carry a git
checkout; then `worktree` is `cwd` itself.

`branch` and `baseSha` are read again at the end of every turn: a harness may run
`git branch -m` or rebase its branch, so both can change while the room is open. The
daemon updates its record before it sends `_client_turn_ended`, and writes `room.json` a
moment later. A client that shows the branch should read `GET /rooms/:id` again when a
turn ends. A client that shows the whole-branch diff needs no extra step:
`GET /rooms/:id/agents/:agentId/diff` reads the new `baseSha` from the daemon.

**Refusals, in this order:** `400` `invalid_request` for a bad `cwd`; `403`
`repo_not_added` when `cwd` is not in an added repository; `400` `invalid_request` for a
bad `title`, a bad or missing harness, a bad `name`, `role`, `mode`, `model` or
`settings`, or an unknown agent field; `409` `name_taken` or `orchestrator_exists` when
two agents in the list clash; `400` `invalid_config` when the repository's
`.kapelle/config.json` is not valid, because the room reads its watchdog limits and
`linkPaths` from it; `400` `invalid_request` for a bad `base`; `503` `shutting_down` when
the daemon shuts down; `500` `room_open_failed` when a harness cannot start (for example
its binary is not installed).

A `base` is bad when it is not a commit, or when its commit has no copy of the folder
`cwd` names inside the repository. That folder must be in the commit even when no `base`
is sent, because the default is `HEAD`: a folder that is not committed yet gives the same
`400`.

### `GET /rooms`

**Reply `200`:** a list. Each room carries its participants in short, so a list of rooms
is one call.

```json
[
  {
    "id": "room-20260922-101500-a1b2",
    "cwd": "/home/me/src/app",
    "title": "fix login",
    "status": "active",
    "updatedAt": "2026-09-22T10:15:00.000Z",
    "participants": [
      { "id": "p-0k3x9a2b", "name": "alice", "role": "orchestrator", "status": "idle" }
    ]
  }
]
```

### `GET /rooms/:id`

**Reply `200`:** the room, in the same shape as `POST /rooms` answers: every participant
in full, with its `role` when it has one, and the log's size as `seq`. `404` `room_not_found` for an
unknown id.

### `PATCH /rooms/:id`

Since 1.13. Gives the room a new title:

```json
{ "title": "login bug" }
```

The `id` does not change, and `updatedAt` moves. The room's stream gets no line for it,
because the stream is the conversation and a title is not part of it. A client that wants
the new title reads it from `GET /rooms` or `GET /rooms/:id`.

**Reply `200`:** the room, as `GET /rooms/:id` gives it. **Refusals:** `404`
`room_not_found`; `400` `invalid_request` when `title` is missing, empty or not a
string; `409` `room_dismissed`; `503` `shutting_down`.

### `POST /rooms/:id/messages`

The message goes to the participant with the `orchestrator` role. Everything else is as
for [`POST /rooms/:id/agents/:agentId/messages`](#post-roomsidagentsagentidmessages).

**Request:** `{ "text": "What does this repo do?" }`. It takes no `from`: the
orchestrator never sends to itself, so `from` is an unknown field here.

**Reply `202`:** `{ "seq": 41, "queued": 0 }`, as below.

**Refusals:** as below, and `409` `no_orchestrator` when no participant has that role,
which includes an empty room.

### `GET /rooms/:id/events`

The room's event stream: one log and one `seq` for the whole room. Same format as a run's,
but each line names `roomId` and `participantId` in place of `agent`. See
[Format](#format).

**Refusals:** `404` `room_not_found` for an unknown room, `404` `no_event_log` for one
with no event log; `400` `invalid_request` for a bad `Last-Event-ID`.

### `POST /rooms/:id/dismiss`

Stops every harness and ends the room. The reply waits until that is done. The daemon
never commits the room's work. Each participant has its own checkout and branch. When a
participant changed something, its checkout and branch stay, with uncommitted changes
still in the checkout. When it changed nothing, both are removed. A branch the harness
switched to that already existed is never deleted; the checkout is kept and the daemon's
log names it.

A kept checkout stays while the room's record does: a daemon restart keeps it. A dismissed
room comes back after a restart, still dismissed, so its history can be read and its
branches merged. It stays until you [delete](#delete-roomsid) it, or until a daemon boot
finds it older than `retentionMs` (30 days unless configured, from the dismiss). That boot
removes it as a delete does. A room with uncommitted work is kept, and the daemon's log
names it.

**Reply `200`:** the room, with `status: "dismissed"`, and each participant
`dismissed`. `404` `room_not_found` for an unknown room. `409` `room_dismissed` when the
room was already dismissed.

### `GET /rooms/:id/delete-preview`

Since 1.15. What [`DELETE /rooms/:id`](#delete-roomsid) would remove from git.
Every branch the room owns appears, including one with no current participant, such as a
failed add or a removed participant. `commits` holds the commits on that branch that no
ref outside the room can reach: local branches, remote-tracking branches and tags. A
branch merged into `main` therefore has none. A branch based on another room branch can
still show the commits both would lose.

Read-only, so it works on an active room.

**Reply `200`:**

```json
{
  "branches": [
    {
      "branch": "kapelle/room-20261026-121039-6ehf/p-0k3x9a2b",
      "participant": "dev",
      "commits": [
        { "sha": "3f2a…", "subject": "Add the delete preview" }
      ],
      "total": 1
    }
  ]
}
```

`participant` is omitted when the room record no longer names one. `commits` is empty
when every commit is already reachable outside the room. It carries at most 200 commits
per branch; `total` is the full count, so a client can say how many were left out.

**Refusals:** `404` `room_not_found`.

### `DELETE /rooms/:id`

Throws a room away. Its checkouts, the branches it owns, its record and its event log are
removed at once. Branches go even when nothing merged them.
[`GET /rooms/:id/delete-preview`](#get-roomsiddelete-preview) lists them and their
unmerged commits first. A branch the harness renamed into is the room's own and goes too;
a branch it switched to that already existed belongs to its owner and is left, and the
daemon's log names it. Open streams of the room end.

Only a stopped room can be deleted: a dismissed one, or a paused one that no message has
revived. A paused room is deleted as it is; no harness starts first. Dismiss an active room
first.

The daemon reads each checkout under the room's folder before it removes anything,
including a checkout no participant owns, such as one a failed add kept. A file that
nobody committed, new files included, refuses the delete.

**Reply `204`**, with no body. The room is gone: `GET /rooms/:id` answers `404`.

**Refusals:** `404` `room_not_found`; `409` `room_active`; `409` `uncommitted_work`,
naming the files; `503` `shutting_down`. Nothing changes on a refusal, with one
exception: a message sent to a paused room during its delete can revive a participant. If
that participant then leaves uncommitted work, the delete is refused, and the room is left
dismissed.

A branch that git will not delete, such as one checked out in another folder, is left. The
daemon's log names it, and the rest of the room is still removed.

### `POST /rooms/:id/agents`

Adds one participant to a room. The request is one agent, in the same shape as an entry of
the `agents` list of [`POST /rooms`](#post-rooms).

```json
{ "agent": "claude", "name": "reviewer", "role": "tester", "base": "kapelle/room-…/p-0k3x9a2b" }
```

The reply comes when the harness is ready.

**Reply `201`:** the participant, in the shape `GET /rooms/:id` gives it.

**Refusals:** `404` `room_not_found`; `400` `invalid_request` for a bad field, or a bad
`base` (see [`POST /rooms`](#post-rooms)); `400` `invalid_config` when the repository's
`linkPaths` cannot be used; `409` `name_taken`; `409` `orchestrator_exists`; `409`
`room_dismissed`; `503` `shutting_down`; `500` `room_open_failed` when the harness cannot
start.

### `GET /rooms/:id/agents` and `GET /rooms/:id/agents/:agentId`

**Reply `200`:** every participant, in the order they were added, or one participant.
`404` `room_not_found` or `participant_not_found`.

### `PATCH /rooms/:id/agents/:agentId`

Changes one participant. Send one or more of:

- `name`: a new name. The `id` and the `branch` do not change. This route never renames
  the checkout's branch; a harness that renames its own branch is picked up when its turn
  ends, as [`GET /rooms/:id`](#get-roomsid) says.
- `mode`: `ask`, `safe` or `auto`. The next question uses the new mode at once, and a
  question that waits under `ask` gets the new mode's answer. The harness hears of it
  before its next turn, never during one. See [Modes](#modes).
- `role`: a new role, or `null` to remove the role. To move the `orchestrator` role, first
  remove it from the participant that has it.
- `model` (since 1.17): a model id, such as one from the participant's `models`. The
  harness checks it, not the daemon. An idle harness gets it at once, and the reply shows
  the model it runs on. A busy one gets it before its next turn, never during one, and one
  with no harness running gets it when it starts again, also after a daemon restart; the
  reply then shows the model it had. A harness that refuses the model does not refuse the
  request: the harness keeps the model it had, and a notice says so. A pending change
  refused at a start leaves the last model the harness took. Only a model the harness took
  is sent again at a revive. The saved models of `GET /harnesses` do not change.

The daemon checks every field before it changes any. The model is applied last, and
apart from the other fields: the daemon changes `name`, `mode` and `role` first, then
sends the model. So a refusal at the model step, such as `409` `room_dismissed` when the
room was dismissed between the two, leaves the earlier fields changed. No field restarts
the harness or opens a new session. A model change updates the model option of the
session that runs. The room's stream gets `_client_participant_changed`, with only the
fields that changed, so every client sees the change. A change of model gets its own
line once the harness answered, with `model`: the model in use, or `null` when the
harness names none, such as one with no model option. Read the participant again for
its notice.

**Reply `200`:** the participant. **Refusals:** `404` `room_not_found` or
`participant_not_found`; `400` `invalid_request` for a bad field or an empty body; `409`
`name_taken`; `409` `orchestrator_exists`; `409` `room_dismissed`.

### `DELETE /rooms/:id/agents/:agentId`

Removes one participant. The daemon cancels its turn if it has one, stops its harness and
keeps its work, as for a dismiss: a checkout with changes and its branch stay. The other
participants do not change. The participant leaves the room's list at once, so its name
is free again.

**Reply `200`:** the room, without that participant. **Refusals:** `404`
`room_not_found` or `participant_not_found`; `409` `room_dismissed`.

### `POST /rooms/:id/agents/:agentId/messages`

One message to one participant. The daemon never reads the text. A client turns a leading
`@name` into the participant id itself: see [Addressing](#addressing).

**Request:** `{ "text": "Review the login change." }`, or with
`"from": "<the orchestrator's id>"` when the orchestrator sends it (since 1.11).

- No `from` means the person sent it.
- `from` must be the id of the participant whose `role` is `orchestrator`, and not the
  target. There is one operator and one token, so the daemon trusts `from` as it trusts
  the rest of the body. It is information, not a control.
- With `from`, the harness gets one extra first line, `[from <name>]`, with the sender's
  name at that time. The log's `text` does not have that line, and `from` is on its
  `_client_message_queued` and `_client_user_message`.

**Reply `202`:** `{ "seq": 41, "queued": 1 }`. The message is on the room's log.

- `seq` is the log's size before the message.
- `queued` is how many of this participant's turns come before this message, the live
  one included. `0` means its turn started at once, with `_client_user_message`.
  Otherwise the log has `_client_message_queued` now, and `_client_user_message` when
  its turn starts.
- The answer is over at this participant's `queued + 1`th `_client_turn_ended` with a
  `seq` above `seq`.

A participant keeps at most 16 messages waiting behind its live turn. They are in memory
only: a daemon restart loses them.

A message to an `exited`, `killed` or `paused` participant revives it first: see
[After a restart](#after-a-restart). The reply does not wait for the new harness. A
harness that cannot start ends the turn with `_client_turn_ended` and `error`.

**Refusals:** `404` `room_not_found` or `participant_not_found`. `400` `invalid_request`
for empty text. `400` `invalid_sender` for a `from` that is not the orchestrator, or that
is the target. `409` `room_dismissed` for a dismissed room. `409` `agent_exited` while the
participant is being removed or the daemon shuts down. `429` `queue_full` when 16 messages
already wait.

#### Replies and copies

Since 1.12. When a turn ends, the daemon may send its answer on as a new message, with
`kind` on its `_client_message_queued` and `_client_user_message`:

- **A reply** (`kind: "reply"`) goes to the participant that sent the turn's message
  with `from`. Its first line is `[reply from <name>] <end>, <n> tool calls`.
- **A copy** (`kind: "copy"`) goes to the orchestrator when the person sent the message
  to another participant that the orchestrator gave work to: a message from the
  orchestrator, with `from`, started one of that participant's turns. A room with no
  orchestrator gets no copies, and a new orchestrator gets none for work the old one
  gave. The room keeps this across a restart. **Changed 2026-10-24 (#333), still
  1.14:** before, the orchestrator got a copy of the person's message to
  any other participant. Nothing was added,
  so the version did not change. Its first line is
  `[copy] you → <name> · <end>, <n> tool calls`, then the person's message, then
  `[answer]` and the answer.

`from` is the participant whose turn ended. `<end>` is the turn's stop reason,
`cancelled by the person`, a plain `cancelled` from any other cut, or `error`. Only the
person cancels a turn that replies: a stop sends nothing. The answer is the text after the turn's last tool call, or the
last text before it when that is empty. Each is cut at 64 KiB of UTF-8, never inside a
character, and the first line then ends with `, cut at 64 KiB`. Only the answer is cut:
a copy carries the person's message whole, as the worker got it. A cancelled turn sends
its first line only. A turn that ended with an error, a harness that exited during it
included, sends the error in place of its answer.

The log's `text` is all the harness reads, first line included. There is no `[from …]`
line. A reply or a copy is never refused for a full queue: it does not count toward the
16. A turn that starts from a reply or a copy sends nothing when it ends. A remove, a
dismiss or a shutdown sends nothing either. A reply to a participant that has left the
room is dropped, and the daemon's stderr says so. A reply or a copy to an `exited` or
`killed` participant revives it, as any message does: see
[After a restart](#after-a-restart). A harness that cannot load its old session starts
fresh, with no memory of the work, and `_client_participant_revived` says `fresh`.

### `GET /rooms/:id/agents/:agentId/events`

One participant's view of the room: the room's stream with only the lines whose
`participantId` is this one. `seq` and `Last-Event-ID` are the room's, so the numbers have
gaps. The stream ends when the room's log closes.

A removed participant has no stream: this route answers `404` for it. Its lines stay in
[`GET /rooms/:id/events`](#get-roomsidevents); filter them there by `participantId`.

**Refusals:** as for [`GET /rooms/:id/events`](#get-roomsidevents), and `404`
`participant_not_found`.

### `POST /rooms/:id/agents/:agentId/turns/current/cancel`

Cancels the participant's live turn. First it drops the participant's queue; if it held any
messages, the log gets `_client_queue_cleared`. Then it asks the harness to stop. The
session stays, so the participant remembers the turn, and the room stays `active`. To
replace a message, cancel, then send the new one.

**Reply `202`:** the participant. The turn ends later, on the stream, with
`_client_turn_ended`.

**Refusals:** `404` `room_not_found` or `participant_not_found`; `409` `room_dismissed`;
`409` `no_turn` when the participant has no live turn.

### `GET /rooms/:id/agents/:agentId/diff`

What the participant changed in its checkout, in any mode. In `auto` it asks nothing, so
this is how a person sees its work before they ask it to commit.

- `?against=head` (the default): what is not committed yet.
- `?against=base`: the whole branch, from the commit its work starts at. That is the fork
  point, or the commit a later rebase moved it onto. The branch's own commits are in it
  too, but the base's are not.

New files that git does not track are in both, as new files. Ignored files are not. The
daemon reads the checkout and changes nothing in it, not even git's index. Each request is
a new snapshot; nothing is kept.

**Reply `200`:** the same shape as a question's [`diff`](#get-permissions), cut at 512 KB.
A checkout with no changes gives `{"text": "", "files": 0, "added": 0, "removed": 0}`.

**Refusals:** `404` `room_not_found` or `participant_not_found`; `400` `invalid_request`
for another `against`; `409` `no_diff` when the checkout is not a git checkout, for `base`
when the participant has no branch, or when git fails for another reason (the message
says why).

### `POST /rooms/:id/agents/:agentId/fast-forward`

Moves the target participant's branch and checkout up to the source participant's commit
(M6-11a, R45). **Fast-forward only:** the target must not be `busy`, its branch must be
an ancestor of the source's branch, and its checkout must have no tracked changes
(decided 2c). The move runs `git merge --ff-only <source branch>` inside the target's
checkout, so the branch, index and files move together. The source's branch and checkout
are not touched. Untracked files alone do not refuse; a collision with one is Git's own
refusal. While the move runs, the target is `busy`: a message sent to it then queues, and
its turn starts after `_client_participant_fast_forwarded`. A move to the commit the
target already has is a successful no-op and writes no event.

**Request:** `{ "from": "<participantId>" }`.

**Reply `200`:** the target participant, in the shape `GET /rooms/:id` gives it, with the
same `branch` name as before. The room's stream also gets
`_client_participant_fast_forwarded` with `from`, `branch` and `sha` when the move
changed the commit.

**Refusals:** `404` `room_not_found` or `participant_not_found`; `400` `invalid_request`
for a missing or blank `from`, or when it names the target itself; `409` `room_dismissed`;
`409` `agent_busy`; `409` `not_fast_forward`; `409` `dirty_worktree`; `409` `no_branch`. A
branch ref that no longer resolves is `409` `no_branch`, never a bare git failure.

### `GET /rooms/:id/agents/:agentId/fast-forward?from=<participantId>`

Read-only preview of what the move would bring: the commits in `from`'s branch that are
not in the target's `HEAD`. Same shape and 512 KB cap as
[`GET /rooms/:id/agents/:agentId/diff`](#get-roomsidagentsagentiddiff). The TUI shows it
before the person confirms.

**Refusals:** `404` `room_not_found` or `participant_not_found`; `400` `invalid_request`
when `from` is missing; `409` `no_branch` when either participant has none; `409`
`no_diff` when git fails.

### Modes

A participant's mode says what happens when its harness asks to change something.

| `mode` | A question from the harness | The harness's own mode |
| --- | --- | --- |
| `auto` (default) | Yes, always. | Its normal mode. |
| `ask` | Waits for a person in [Permissions](#permissions). No answer in time means no. | Its normal mode. |
| `safe` | No. Reading, searching, fetching and thinking still work. | Its read-only mode, for example claude's `plan`. |

- A mode change acts at once on our side. A question that waits under `ask` closes with
  reason `mode_change`: yes for `auto`, no for `safe`.
- The daemon sets the harness's own mode when the participant starts, and before the
  first turn after a change. If the harness refuses, the daemon tries again before the
  next turn. It never sends the mode that stops a harness from asking,
  such as claude's `bypassPermissions`: under `auto` the harness still asks, and the
  daemon says yes.
- A harness with no measured mode ids, such as pi or any `cmd`, keeps its own mode. Its
  `notices` say so.
- `safe` turns `allowReadOutsideRoot` off while it lasts. `settings` shows the value in
  use.
- A mode is not a sandbox. A harness that never asks, such as opencode or pi, is not held
  by `ask` or `safe`. Its `notices` say so. The lines that name a mode always name the
  current one: a mode change replaces them.

### Words for the room lifecycle

These words are fixed now, so every client uses the same ones. They describe the whole
room, not one participant: removing a participant is
[`DELETE /rooms/:id/agents/:agentId`](#delete-roomsidagentsagentid), which keeps its work.
**dismiss** and **delete** are routes. **pause**, **resume** and **kill** are built too,
but they have no route: a shutdown, a message and a crash cause them.

| Word | Who does it | Room after | Harness | Work on disk |
| --- | --- | --- | --- | --- |
| dismiss | a person | `dismissed`, final | stopped | branch and checkout kept for a participant that changed something; both removed for one that did not |
| delete | a person, on a dismissed or paused room | gone | stopped | removed; refused with `409` while a checkout has work that nobody committed |
| pause | the machine (shutdown, reboot) | `paused` | stopped | branch and checkout kept |
| resume | the next message to a paused, killed or exited participant | `active` | started again in its own checkout | untouched |
| kill | the machine, during a turn (crash, harness death, a cancel that does not end) | participant `killed`; the room reads `paused` after a crash or a shutdown, and stays `active` when only the harness died | stopped by force | kept; may not match the harness's memory |

A paused room can be dismissed or deleted as it is. Neither word starts a harness first.
A room whose participants have all `exited`, or were `killed` while the daemon stayed up,
still reads `active`, because the next message brings each one back.

`DELETE /rooms/:id` is **delete**. A daemon boot also deletes a dismissed room past
`retentionMs`, unless it has uncommitted work. It never deletes a paused room.

### After a restart

A daemon shutdown is a **pause**, not a dismiss. The daemon cancels each live turn and
waits up to 2 s for it to end, so the log gets its `_client_turn_ended`. Then it stops
every harness. It keeps every branch and checkout as they are, and commits nothing.

The daemon saves each room in its own record, beside the room's log. At the next start it
reads every record back:

- `GET /rooms` lists the room `paused`, and `GET /rooms/:id` shows each participant
  `paused`. A turn still live after the 2 s, or a turn the daemon died during (a crash,
  `kill -9`), leaves its participant `killed`. A participant that had `exited` stays
  `exited`.
- The start adds no line to the log. A turn the crash cut has a `_client_user_message`
  and no `_client_turn_ended`, so read the status from `GET /rooms/:id`, not from the
  stream. The reply and the replay can arrive in either order: compare the reply's `seq`
  with each line's. A `paused` or `killed` holds until a `_client_participant_revived`
  above that `seq`. A revive at or below it is from before the stop. `client/room.ts`
  has `applyStatus` for this.
- The stream replays the whole history, and new lines follow with the next `seq`.
- Queued messages are lost, as are open permission questions.
- The next message to a `paused`, `killed` or `exited` participant revives it: a new
  harness in the same checkout. It loads the old session where the harness can, and gets
  `resumed: "loaded"`. Otherwise, or when the load fails, it gets a fresh session and
  `resumed: "fresh"`. The log gets `_client_participant_revived`, and the room is `active`
  again. Adding a participant also makes it `active`.
- The load replays the old conversation to the daemon. The daemon drops it, so it adds no
  line to the log. The mode is sent to the harness again before the message, because a
  load does not keep it.
- A participant that stopped during a turn may remember less than its files show. That
  is a `killed` one, or one with a turn cancelled since its last revive, by a person or
  by the shutdown. Its loaded revive carries `memoryMayBeBehind: true`. Ask it to check
  its files before it goes on.
- After a hard kill, claude has once reported a message nobody sent ("continue"). The
  replay does not carry it, so the daemon cannot filter it out.
- A dismissed room comes back dismissed. Its stream ends once it has replayed. It never
  revives.
- A `killed` participant whose checkout has a git `index.lock` left by the cut turn gets
  one notice naming the file, at the next boot. A crash and a shutdown's grace both cut a
  turn. Git refuses to commit there until the file is removed. The daemon does not remove
  it. The notice goes at the first boot after the file is gone.

### Room record (planned)

This is the whole record. The replies above show the part that is built. The rest comes
with the story that fills it: the room's `base` (M6-6a).

```text
room              id, cwd, title, base, createdAt, updatedAt, status
                  status: active | paused | dismissed
participant       id, name, role?, harness, mode, settings,
                  branch, worktree, baseSha,
                  sessionId, resumed?: "loaded" | "fresh",
                  status: idle | busy | exited | paused | killed | dismissed,
                  turnFrom?
room list         [{id, cwd, title, status, updatedAt,
                    participants: [{id, name, role?, status}]}]
room detail       the room fields above, plus every participant in full
```

`resumed` is missing until a participant comes back. `fresh` means it started a new
session. `loaded` means it kept its memory.

`turnFrom` (since 1.14) is the id of the participant whose message the live turn runs,
as `from` names it on `_client_user_message`. It is missing when the person sent that
message, and when no turn runs. A reply's turn names the worker that replied.

`role` is one of `orchestrator`, `developer`, `tester`, `architect` or `reviewer` (since
1.14), or missing. It is a
label. It sends no text to the agent. A client changes `name`, `mode`, `role` or
`model` with one route, `PATCH /rooms/:id/agents/:agentId`. A room has at most one
`orchestrator`: adding or changing a participant to that role is refused with `409`
`orchestrator_exists` while another one exists. More roles may come later, so a client
shows a role it does not know as plain text.

### Addressing

Every message has exactly one target participant. A client sends to
`POST /rooms/:id/agents/:agentId/messages`, and a per-participant stream is the room's
event log filtered by `participantId`. The TUI opens on the room timeline and lets the
person name the target with a leading `@name`; the client resolves the name to the opaque
participant id itself (R43). The daemon never parses message text. Every client follows
the same rules, so the TUI and piped `chat.ts` behave the same:

- The client first removes whitespace at the start of the message. So a leading space
  is not a way to write a literal `@`, and piped `chat.ts`, which already trims, cannot
  differ from the TUI.
- A **mention** is a word at the very start of the message that begins with `@`. The name
  after `@` ends at whitespace (a space, a tab or a newline) or at one of `,` `:` `;` `.`.
  `@alice, look`, `@alice: look` and `@alice` then a newline then `look` all send `look`
  to alice.
- The name matches a participant name with ASCII case folding, so `@Alice` is `@alice`.
- **One mention** names the target. An unknown name is a client-side error.
- **Two or more mentions** at the start are a client-side error, known names or not.
  Taking the first and ignoring the rest would send `@edward @bab hi` to edward with
  `@bab` as text, so a typo in the second name would pass unnoticed. Refusing catches it.
- **No mention** sends the message to the participant whose `role` is `orchestrator`.
  A room with no orchestrator and one participant sends it to that participant (#333).
  A room with no orchestrator and two or more participants, or none, refuses before the
  request, and says: start with `@name`, or give a participant the orchestrator role.
- After the first word that does not begin with `@`, an `@` is plain text. `@alice ask
  @bob` goes to alice. To start a message with a literal `@`, put it in backticks,
  like `` `@property` ``, or put a word before it.
- The client **removes the mention**, its end mark and the whitespace after it,
  newlines included. The rest is the text it sends, so it is what the agent gets and
  what `_client_user_message` records. A replaying client draws that text and names the
  target from the log line's `participantId`.
- A mention with nothing after it (`@alice`) is a client-side error **at submit**. The
  daemon would refuse the empty text with `400` `invalid_request`. While the person
  types, the composer only shows the resolved target, so a thread that opens with its
  `@name` pre-filled is not in an error state.

## Bridges

A bridge connects a chat app, such as Slack or Matrix, to a room. It is a client like
`chat.ts`, and it uses only the routes in this document. **No chat SDK goes into the
daemon.** The bridge holds the chat app's library and its login.

**Where it runs.** On the same machine and as the same user as the daemon. It finds the
daemon and its token as in [Find the daemon](#find-the-daemon). There is one token, the
operator's, so a bridge can do everything a person at the terminal can do. Keep the token
out of the chat app. Anyone who can write where the bridge listens can answer a question
in the operator's name, `execute` included. So the bridge decides who may answer, and the
chat channel stays closed to everyone else. A token per bridge is not built (#255).

**What it does:**

1. Follow a room with [`GET /rooms/:id/events`](#get-roomsidevents), or one participant
   with [`GET /rooms/:id/agents/:agentId/events`](#get-roomsidagentsagentidevents).
   Keep the last `seq` and reconnect as in [Resume after a break](#resume-after-a-break).
2. Post the agent's text to the chat app. Join the chunks of a message yourself: see
   [Chunks are not joined](#chunks-are-not-joined).
3. Send a chat message with
   [`POST /rooms/:id/messages`](#post-roomsidmessages), or to one participant with
   [`POST /rooms/:id/agents/:agentId/messages`](#post-roomsidagentsagentidmessages).
   Read a leading `@name` as in [Addressing](#addressing).
4. Answer questions as in [Permissions](#permissions): show `_client_permission_queued`
   in the chat app, then send the person's yes or no with
   [`POST /permissions/:id`](#post-permissionsid). A bridge reconnects often, and each
   replay shows old questions again, so check `GET /permissions` before you ask.

**Rules:**

- A question can close without the bridge, at the terminal or by a time limit. Tell the
  chat app when it does: `_client_permission_answered` has the `reason`, see
  [Why a question closed](#why-a-question-closed).
- A message route has no retry key. If a reply is lost, do not send the message again at
  once, or the agent can get it twice. To make a check possible:
  1. Before each send, call [`GET /rooms/:id`](#get-roomsid). Keep its `seq`: the
     message's line will be above it. Keep the target's id too. For
     `POST /rooms/:id/messages`, that is the participant whose `role` is `orchestrator`.
     Read it now, because the role can move to another participant later.
  2. If the reply is lost, call [`GET /rooms/:id`](#get-roomsid) again. Its `seq` is the
     log's size now. It counts only lines already written to disk, so the message's line
     can be a moment late.
  3. Read [`GET /rooms/:id/events`](#get-roomsidevents) with `Last-Event-ID` set to the
     first `seq`, and take every line up to the second `seq`. There may be none: two
     equal numbers mean nothing was written, so do not wait for a line. Use the room's
     stream even if you follow one participant: a participant's stream has gaps, so it
     can miss the second `seq`.
  4. Look for `_client_user_message` or `_client_message_queued` with the target's
     `participantId` and the text you sent, after the mention was removed (see
     [Addressing](#addressing)). Do not look below the first `seq`: a short text such as
     "yes" is often sent more than once, so an older line proves nothing.
  5. If neither is there, do steps 2 to 4 once more, for the line that was late. If it is
     still not there, send the message again. A `_client_message_queued` is not yet a
     turn: a cancel or a daemon restart can still drop it (see [Events](#events)).

  A room with no event log has no stream (`404` `no_event_log`), so the check cannot
  run. Do not send again there.
- Text from the agent is not trusted. Remove control characters before you post it.

## A first client, step by step

This example uses `curl` and `jq`. Any HTTP library works the same way.

```bash
# 1. Find the daemon.
case "${XDG_RUNTIME_DIR:-}" in
/*) f="$XDG_RUNTIME_DIR/kapelle" ;;
*) f="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}/kapelle-$(id -u)" ;;
esac
PORT=$(jq -r '.port // empty' "$f/daemon.json")
TOKEN=$(jq -r '.token // empty' "$f/daemon.json")
if [ -z "$PORT" ] || [ -z "$TOKEN" ]; then
  echo "daemon not ready: no port/token in $f/daemon.json" >&2
  exit 1
fi
api() { curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
BASE="http://127.0.0.1:$PORT"

# 2. Check the version. Stop if major is not 1.
api "$BASE/version"

# 3. Add the repository, once.
api -X POST "$BASE/repos" -d '{"path":"'"$PWD"'"}'

# 4. Start a run.
ID=$(api -X POST "$BASE/runs" \
  -d '{"cwd":"'"$PWD"'","run":{"agent":"opencode","mode":"safe",
       "tasks":[{"id":"hello","prompt":"Say hello."}]}}' | jq -r .id)

# 5. Follow its events until the run ends.
api -N "$BASE/runs/$ID/events"

# 6. Read the result.
api "$BASE/runs/$ID" | jq .status
```
