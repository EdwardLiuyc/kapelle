# Client API

This document tells you how to write a client for the kapelle daemon. A client is any
program that talks to the daemon: `kapelle attach`, `kapelle ps`, `chat.ts`, a TUI, or a
bridge to a chat app.

You do not need to read `daemon.ts` or anything in `core/`. If this document and the code
disagree, that is a bug. Please report it.

Contract version: **1.0** (story M5-1, #133).

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
10. [A first client, step by step](#a-first-client-step-by-step)

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
| Different `major` | Stop, and tell the person to update the client or the daemon. |

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
| `rooms` | [Rooms](#rooms). Experimental. |

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
| `GET /runs/:id`, `DELETE /runs/:id` replies | One shape for live and restored runs (M5-2). |
| SSE format, `seq`, `Last-Event-ID` | |
| Event `update` values from the harness (ACP) | Stable as a pass-through. See [Events](#events). |
| `_client_*` events | Except the room events. See [Events](#events). |
| `GET /permissions`, `GET /permissions/:id`, `POST /permissions/:id` | `GET /permissions/:id` added in 1.1 (M5-4). |
| Error replies (`{error: {code, message}}`) and the error codes | Codes are only added (M5-3). |
| Request limits: `Content-Type`, body size, unknown fields, read timeout | M5-3. |

**Provisional and experimental.** These will change. The last column names the story that
changes each one.

| Part | Label | Changed by |
| --- | --- | --- |
| `GET /runs` list | Provisional | M5-9 (filters, order, pages; shared run fields since M5-2) |
| End of a run's stream | Provisional | M5-5 (adds a "run finished" event) |
| Event timestamps | Provisional | M5-5 (adds `at`) |
| Heartbeat and reconnect | Provisional | M5-6 |
| `POST /runs` retry safety | Provisional | M5-7 (adds `Idempotency-Key`) |
| Everything under `/rooms` | Experimental | M6-2 and later |

**Planned, not built yet:** cancel one task (M5-8).

Version 1 stops changing at story M5-11. After that, only additions are allowed.

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
| `permission_not_found` | `404` | The daemon never gave out this permission id. | |
| `no_event_log` | `404` | The run or room exists, but it has no event log to stream. | Read `GET /runs/:id` for a run, or `GET /rooms/:id` for a room. |
| `run_ended` | `409` | You cancelled a run that already ended. | Stop. Read its status. |
| `already_decided` | `409` | The permission was already answered, timed out, or cancelled. | Stop. Your answer was not used. `GET /permissions/:id` says who won. |
| `room_busy` | `409` | The room still answers the last message. | Wait for `_client_turn_ended`, then send again. |
| `room_closed` | `409` | The room was dismissed, or its harness exited. | Stop. Open a new room. |
| `orchestrator_exists` | `409` | Not built yet (M6-3). The room already has an orchestrator. | Change the other participant's role first. |
| `shutting_down` | `503` | The daemon is shutting down. | Try again after it restarts. |
| `room_open_failed` | `500` | A room's harness or checkout could not start. For example, the harness is not installed. | Show the message. |
| `internal` | `500` | An error the daemon did not expect. For example, a bug, or a git command that failed in a broken repository. | Show the message. Report it if the repository is fine. |

**Status codes you will see:**

| Code | Meaning |
| --- | --- |
| `200` | Done. |
| `201` | Created (a room). |
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
(`415`, then `413`, then `400`). One route resolves a resource first:
`POST /rooms/:id/messages` looks the room up, so an unknown room is `404 room_not_found`
even when the body would be refused.

## Routes

| Method and path | What it does |
| --- | --- |
| `GET /version` | The contract version and the capabilities. |
| `POST /repos` | Add a repository. |
| `GET /repos` | List the added repositories. |
| `POST /runs` | Start a run. |
| `GET /runs` | List all runs. |
| `GET /runs/:id` | One run in full. |
| `DELETE /runs/:id` | Cancel a run. |
| `GET /runs/:id/events` | A run's [event stream](#the-event-stream). |
| `GET /permissions` | Decisions that wait for an answer. |
| `GET /permissions/:id` | One decision, open or closed. |
| `POST /permissions/:id` | Answer one decision. |
| `POST /rooms` | Open a room. Experimental. |
| `GET /rooms` | List rooms. Experimental. |
| `GET /rooms/:id` | One room. Experimental. |
| `POST /rooms/:id/messages` | Send a message into a room. Experimental. |
| `GET /rooms/:id/events` | A room's event stream. Experimental. |
| `DELETE /rooms/:id` | Close a room. Experimental. |

### `GET /version`

**Reply `200`:**

```json
{
  "apiVersion": { "major": 1, "minor": 1 },
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

**Task status** is one of the words above, or `queued` (not started yet), or `running`.
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
| `error` | run could not start | Why. No task ran. |
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
data: {"seq":7,"agent":"summarise","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}

```

- `id` is the event's `seq`.
- `data` is one line of JSON: `{seq, agent, update}`.
- A blank line ends the block.

| Field | Meaning |
| --- | --- |
| `seq` | The event's number in this log. The first event is `1`. It goes up by one each time, with no gaps. |
| `agent` | For a run: the task id. For a room: the harness name. |
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

### End of the stream

- For a run, the stream ends when the run ends. Then call `GET /runs/:id` for the result.
  (Provisional: M5-5 adds an event that says the run finished.)
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

**Tasks** (runs; a room also emits `_client_worktree_created`, where `agent` is the
harness name):

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_task_started` | `harness` | The task left the queue. Its events follow. |
| `_client_worktree_created` | `path`, `branch`, `baseSha` | The task's (or room's) own checkout exists. Missing when the run shares one folder. |
| `_client_task_finished` | `status`, `durationMs` | The task's verdict. A task cancelled before it started has this event but no `_client_task_started`. |

**Permissions:**

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_permission_pending` | `title`, `kind` | A decision is about to be taken. It fires for every decision, also ones that need no person. |
| `_client_permission_queued` | `id`, `title`, `kind` | A decision waits for a person. Answer it with `POST /permissions/:id`. |
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
| `_client_stall_warning` | `kind`, `text` | The task looks stuck. `kind` is `idle` (quiet too long) or `repeat` (same tool again and again). The task keeps running. |

**Harness process:**

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_harness_spawned` | `pid` | The harness process started. |
| `_client_harness_exited` | `pid` | The harness process is gone. |

**Rooms** (experimental):

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_user_message` | `text` | A message a person sent into the room. M6-4 adds `participantId` to the log line, not to this event. |
| `_client_turn_ended` | `stopReason?`, `error?` | The harness finished its answer. The room takes the next message. `error` means the turn failed. |

Ignore a `_client_*` name that you do not know. New ones can appear.

## Permissions

Some harness actions need a yes or no, for example "edit this file". A run in `ask` mode
asks a person through the API. Reading, searching, fetching and thinking never ask.

**How to answer:**

1. See the question. Either watch a stream for `_client_permission_queued`, or poll
   `GET /permissions`.
2. Show the `title` and `kind` to the person.
3. Send the answer with `POST /permissions/:id`.

**Rules:**

- **The first answer wins.** Two clients can see the same question. Only the first answer
  counts. A later answer gets `409`.
- **No answer means no.** A question with no answer is denied after a time limit. The
  default is 120 seconds. The daemon's owner sets it with `--permission-timeout`.
- **Cancel means no.** When a run is cancelled or ends, or its task stops, its open
  questions are denied.
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
| `cancel` | `false` | The run was cancelled, or the daemon stopped. |
| `task_end` | `false` | The question's task ended, for example at its time limit. |
| `run_end` | `false` | The run ended with the question still open. |

New reasons can be added. If you get a reason you do not know, use `allow`.

A daemon restart forgets closed questions. `GET /permissions/:id` then answers `404`, but
the run's event stream still has the `_client_permission_answered` event.

### `GET /permissions`

**Reply `200`:** every open question, from all runs.

```json
[
  {
    "id": "7d4c1e0a-5b2f-4a61-9c3e-2f8b1d6a9e40",
    "runId": "20260922-101500-a1b2",
    "taskId": "summarise",
    "kind": "edit",
    "title": "Edit README.md"
  }
]
```

`kind` is one of `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`,
`switch_mode`, `other`. Treat `id` as an opaque string.

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
`permission_not_found` for an id the daemon never gave out. `409` `already_decided` when
the question is already closed (answered, timed out, or cancelled).

## Rooms

**Everything in this section is experimental.** The room API will change in M6-2 and
after. `chat.ts` uses it today.

A room is one harness with one session that stays alive between messages. The room has its
own git branch and checkout. Today a room always runs in `auto` mode, so it never asks a
permission.

### `POST /rooms`

**Request:** `cwd` plus either `agent` (a harness name) or `cmd` (a command line).

```json
{ "cwd": "/home/me/src/app", "agent": "opencode" }
```

The reply comes when the harness is ready. This can take some seconds.

**Reply `201`:** the room.

```json
{
  "id": "room-20260922-101500-a1b2",
  "cwd": "/home/me/src/app",
  "harness": "opencode",
  "workspace": "/home/me/.local/state/kapelle/repos/app-1a2b3c/wt/room-…/room",
  "notices": [{ "text": "…", "kind": "containment" }],
  "status": "idle"
}
```

`status` is `idle` (waits for a message), `busy` (answers a message), `exited` (the
harness died) or `closed`.

**Refusals, in this order:** `400` `invalid_request` for a bad `cwd`; `403`
`repo_not_added` when `cwd` is not in an added repository; `400` `invalid_request` for a
bad or missing harness; `503` `shutting_down` when the daemon shuts down; `500`
`room_open_failed` when the harness cannot start (for example its binary is not
installed).

### `GET /rooms` and `GET /rooms/:id`

**Reply `200`:** a list of rooms, or one room. `404` `room_not_found` for an unknown id.

### `POST /rooms/:id/messages`

**Request:** `{ "text": "What does this repo do?" }`

**Reply `202`:** `{ "seq": 41 }`. The answer arrives on the room's stream. The turn is over
at the first `_client_turn_ended` with a `seq` above 41.

**Refusals:** `404` `room_not_found` for an unknown room. `400` `invalid_request` for
empty text. `409` `room_busy` while the room answers, and `409` `room_closed` after it
exited or closed. Send one message at a time.

### `GET /rooms/:id/events`

The room's event stream. Same format as a run's. `agent` is the harness name.

**Refusals:** `404` `room_not_found` for an unknown room, `404` `no_event_log` for one
with no event log; `400` `invalid_request` for a bad `Last-Event-ID`.

### `DELETE /rooms/:id`

Stops the harness and closes the room. The reply waits until that is done. The daemon
never commits the room's work. Changes that nobody committed stay in the checkout.

**Reply `200`:** the room, with `status: "closed"`. `404` `room_not_found` for an unknown
room. `409` `room_closed` when the room was already closed.

### Words for the room lifecycle (planned)

These words are fixed now, so every client uses the same ones. Most of them are not
built yet. M6-2 and M6-7 build them.

| Word | Who does it | Room after | Harness | Work on disk |
| --- | --- | --- | --- | --- |
| dismiss | a person | `dismissed`, final | stopped | branch and checkout kept |
| delete | a person | gone | stopped | removed; refused with `409` while a checkout has work that nobody committed |
| pause | the machine (shutdown, reboot) | `paused` | stopped | branch and checkout kept |
| resume | the next message to a paused or exited participant | `active` | started again in its own checkout | untouched |

A paused room can be dismissed or deleted as it is. Neither word starts a harness first.
A room where every participant has `exited` still reads `active`, because the next
message brings each one back.

Today's `DELETE /rooms/:id` is **dismiss**. The status it reports is still `closed`.

### Room record (planned)

This is the shape that M6-2 builds. It is here so that the words above can be checked
against real fields. It is not an API yet.

```text
room              id, cwd, title, base, createdAt, updatedAt, status
                  status: active | paused | dismissed
participant       id, name, role?, harness, mode, purpose, settings,
                  branch, worktree, baseSha,
                  sessionId, resumed?: "loaded" | "fresh",
                  status: idle | busy | exited | paused | dismissed
room list         [{id, cwd, title, status, updatedAt,
                    participants: [{id, name, role?, status}]}]
room detail       the room fields above, plus every participant in full
```

`resumed` is missing until a participant comes back. `loaded` means it kept its memory.
`fresh` means it started a new session.

`role` is one of `orchestrator`, `developer`, `tester` or `architect`, or missing. It is a
label. It sends no text to the agent. A client changes `name`, `mode` or `role` with one
route, `PATCH /rooms/:id/agents/:agentId`. A room has at most one `orchestrator`: adding or
changing a participant to that role is refused with `409` `orchestrator_exists` while
another one exists. More roles may come later, so a client shows a role it does not know
as plain text.

### Addressing (planned)

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
- **No mention** sends the message to the participant whose `role` is `orchestrator`. A
  room with no orchestrator refuses before the request, and says: start with `@name`, or
  give a participant the orchestrator role.
- After the first word that does not begin with `@`, an `@` is plain text. `@alice ask
  @bob` goes to alice. To start a message with a literal `@`, put it in backticks,
  like `` `@property` ``, or put a word before it.
- The client **removes the mention**, its end mark and the whitespace after it,
  newlines included. The rest is the text it sends, so it is what the agent gets and
  what `_client_user_message` records. A replaying client draws that text and names the
  target from the log line's `participantId`, which M6-4 adds to every room log line
  beside `seq` and `agent`.
- A mention with nothing after it (`@alice`) is a client-side error **at submit**. The
  daemon would refuse the empty text with `400` `invalid_request`. While the person
  types, the composer only shows the resolved target, so a thread that opens with its
  `@name` pre-filled is not in an error state.

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
