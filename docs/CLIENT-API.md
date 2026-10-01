# Client API

This document tells you how to write a client for the kapelle daemon. A client is any
program that talks to the daemon: `kapelle attach`, `kapelle ps`, `chat.ts`, a TUI, or a
bridge to a chat app.

You do not need to read `daemon.ts` or anything in `core/`. If this document and the code
disagree, that is a bug. Please report it.

Contract version: **1.6** (M5-1, #133; minor bumped by M5-4, #136, M5-5, #137,
M5-6, #138, M5-7, #139, M6-5, #149, and M4-3, #49).

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
| `Idempotency-Key` on `POST /runs` | Since 1.4 (M5-7). |
| End of a run's stream | `_client_run_finished` since 1.2 (M5-5). |
| Event timestamps (`at`) | Since 1.2 (M5-5). Absent on older lines. |
| `GET /runs/:id`, `DELETE /runs/:id` replies | One shape for live and restored runs (M5-2). |
| SSE format, `seq`, `Last-Event-ID` | |
| Heartbeat (`: ping`) and a paused slow reader | Since 1.3 (M5-6). |
| Event `update` values from the harness (ACP) | Stable as a pass-through. See [Events](#events). |
| `_client_*` events | Except the room events. See [Events](#events). |
| `GET /permissions`, `GET /permissions/:id`, `POST /permissions/:id` | `GET /permissions/:id` added in 1.1 (M5-4). Questions from rooms since 1.5 (M6-5). `input` since 1.6 (M4-3). |
| Error replies (`{error: {code, message}}`) and the error codes | Codes are only added (M5-3). |
| Request limits: `Content-Type`, body size, unknown fields, read timeout | M5-3. |

**Provisional and experimental.** These will change. The last column names the story that
changes each one.

| Part | Label | Changed by |
| --- | --- | --- |
| `GET /runs` list | Provisional | M5-9 (filters, order, pages; shared run fields since M5-2) |
| Everything under `/rooms` | Experimental | M6-7a and later |
| `GET /harnesses` | Experimental | M4-5 added it for `chat.ts` |

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
| `permission_not_found` | `404` | The daemon never gave out this permission id, or it forgot a closed one at a restart. | |
| `no_event_log` | `404` | The run or room exists, but it has no event log to stream. | Read `GET /runs/:id` for a run, or `GET /rooms/:id` for a room. |
| `run_ended` | `409` | You cancelled a run that already ended. | Stop. Read its status. |
| `already_decided` | `409` | The permission was already closed, for any of the reasons in [Why a question closed](#why-a-question-closed). | Stop. Your answer was not used. `GET /permissions/:id` gives the reason. |
| `queue_full` | `429` | 16 messages already wait for this participant. | Wait for a `_client_turn_ended`, then send again. Or cancel its turn, which drops the queue. |
| `no_turn` | `409` | You cancelled a turn, but the participant has none. | Stop. Its turn already ended. |
| `room_dismissed` | `409` | The room was dismissed. | Stop. Open a new room. |
| `agent_exited` | `409` | The participant's harness exited by itself. | Remove the participant and add a new one. M6-7a brings the participant back on the next message. |
| `no_orchestrator` | `409` | The room has no participant with the `orchestrator` role, so a message has no target. | Open a room with an orchestrator. |
| `idempotency_conflict` | `409` | This `Idempotency-Key` already started a run with a different body. | Use a new key for new work. |
| `idempotency_in_progress` | `409` | A request with this `Idempotency-Key` has not answered yet. | Wait, then send the same request again. |
| `orchestrator_exists` | `409` | The room already has an orchestrator. | Change the other participant's role first. |
| `name_taken` | `409` | Another participant in the room has this name. Names are compared without ASCII case, so `Alice` takes `alice`. | Choose another name. |
| `shutting_down` | `503` | The daemon is shutting down. | Try again after it restarts. |
| `room_open_failed` | `500` | A room's harness or checkout could not start. For example, the harness is not installed. | Show the message. |
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
`POST /rooms/:id/agents` and `PATCH /rooms/:id/agents/:agentId` look the room up, so an
unknown room is
`404 room_not_found` even when the body would be refused. They look the participant up
only after the body, so a bad body to an unknown participant is `400`, not `404`. `DELETE` carries no body, and
the `GET` routes take none.

## Routes

| Method and path | What it does |
| --- | --- |
| `GET /version` | The contract version and the capabilities. |
| `POST /repos` | Add a repository. |
| `GET /repos` | List the added repositories. |
| `GET /harnesses` | List the harnesses the daemon can start by name. Experimental. |
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
| `POST /rooms/:id/messages` | Send a message to the room's orchestrator. Experimental. |
| `GET /rooms/:id/events` | A room's event stream. Experimental. |
| `POST /rooms/:id/dismiss` | End a room. Experimental. |
| `POST /rooms/:id/agents` | Add a participant. Experimental. |
| `GET /rooms/:id/agents` | List a room's participants. Experimental. |
| `GET /rooms/:id/agents/:agentId` | One participant. Experimental. |
| `PATCH /rooms/:id/agents/:agentId` | Rename a participant, or change its mode or role. Experimental. |
| `DELETE /rooms/:id/agents/:agentId` | Remove a participant. Experimental. |
| `POST /rooms/:id/agents/:agentId/messages` | Send a message to one participant. Experimental. |
| `GET /rooms/:id/agents/:agentId/events` | One participant's lines of the room's stream. Experimental. |
| `POST /rooms/:id/agents/:agentId/turns/current/cancel` | Cancel a participant's turn and drop its queue. Experimental. |

### `GET /version`

**Reply `200`:**

```json
{
  "apiVersion": { "major": 1, "minor": 6 },
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
or a participant. `measured` is `true` when kapelle measured how the harness behaves.
`false` means nobody checked it. Neither says the harness is installed here.

**Reply `200`:**

```json
[
  { "id": "opencode", "measured": true },
  { "id": "gemini", "measured": false }
]
```

A daemon older than this route answers `404` `no_route`. Then a client can still take a
name typed by the person.

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
- A run that failed before the daemon opened its log — the worktree preflight can
  fail before the log exists — has no stream at all. `GET /runs/:id/events` answers
  `404 no_event_log`, and `GET /runs/:id` still carries the `failed` status.
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
| `_client_permission_queued` | `id`, `title`, `kind`, `input?` | A decision waits for a person. Answer it with `POST /permissions/:id`. `input` is the tool's input: see [`GET /permissions`](#get-permissions). Since 1.6. |
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
| `_client_stall_warning` | `kind`, `text` | The task, or a room participant's turn, looks stuck. `kind` is `idle` (quiet too long) or `repeat` (same tool again and again). It keeps running: in a room, only a cancel ends a turn. |

**Harness process:**

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_harness_spawned` | `pid` | The harness process started. |
| `_client_harness_exited` | `pid` | The harness process is gone. |

**Rooms** (experimental):

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_message_queued` | `text` | A message reached a busy participant and waits. `_client_user_message` follows when its turn starts. |
| `_client_user_message` | `text`, `turn` | The participant's turn starts with this message. The line's `participantId` names who got it. `turn` counts that participant's turns from 1. It is absent on lines written before 1.5. |
| `_client_turn_ended` | `stopReason?`, `error?` | The harness finished its answer, and the next queued message starts. `error` means the turn failed. |
| `_client_queue_cleared` | `count` | `count` queued messages were dropped and never sent: the turn was cancelled, the participant was removed, its harness exited, or the room was dismissed. |
| `_client_participant_added` | `name`, `role?`, `harness`, `mode` | The participant joined: a starter when the room opened, or an add. It comes after its `_client_harness_spawned`, and after `_client_worktree_created` when it has its own checkout. An add that fails never logs this, though it may have logged either of the other two. |
| `_client_participant_changed` | `name?`, `role?`, `mode?` | A rename, or a new role or mode. Only the changed fields are present. `role: null` means the role was cleared. |
| `_client_participant_removed` | none | The participant left the roster. It is the participant's last line. A dismiss has no such line: the stream ends instead. |

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

**Everything in this section is experimental.** The room API will change in M6-7a and
after. `chat.ts` uses it today.

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
- `role`: optional. One of `orchestrator`, `developer`, `tester` or `architect`. No role
  is given by default. A message goes to the `orchestrator`, so give that role to the
  agent that should answer.
- `mode`: optional. `ask`, `safe` or `auto`. The default is `auto`. See [Modes](#modes).
- `base`: optional. The git ref the participant's branch starts from. It can be another
  participant's `branch`, so a reviewer starts from the developer's commits. The default
  is the repository's `HEAD`. Only committed work is on a branch.
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
      "status": "idle",
      "notices": [{ "text": "…", "kind": "containment" }]
    }
  ]
}
```

A room's `status` is `active` or `dismissed`. `paused` comes with M6-7a. A participant's
`status` is `idle` (waits for a message), `busy` (answers a message), `exited` (the
harness died) or `dismissed`. `paused` and `killed` come with M6-7a.

The participant `id` is opaque. `title`, `role`, `branch` and `baseSha` are missing when
there is no value. `branch` and `baseSha` are missing when `cwd` cannot carry a git
checkout; then `worktree` is `cwd` itself.

**Refusals, in this order:** `400` `invalid_request` for a bad `cwd`; `403`
`repo_not_added` when `cwd` is not in an added repository; `400` `invalid_request` for a
bad `title`, a bad or missing harness, a bad `name`, `role`, `mode` or `settings`, or an
unknown agent field; `409` `name_taken` or `orchestrator_exists` when two agents in the
list clash; `400` `invalid_config` when the repository's `.kapelle/config.json` is not
valid, because the room reads its watchdog limits from it; `400` `invalid_request` for a
bad `base`; `503` `shutting_down` when the
daemon shuts down; `500` `room_open_failed` when a harness cannot start (for example its
binary is not installed).

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

**Reply `200`:** the room, in the same shape as `POST /rooms` answers. `404`
`room_not_found` for an unknown id.

### `POST /rooms/:id/messages`

The message goes to the participant with the `orchestrator` role. Everything else is as
for [`POST /rooms/:id/agents/:agentId/messages`](#post-roomsidagentsagentidmessages).

**Request:** `{ "text": "What does this repo do?" }`

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
still in the checkout. When it changed nothing, both are removed.

A kept checkout lasts only until the next daemon start. Until M6-7a, rooms are not
saved, so the start-up cleanup removes a kept checkout that has no uncommitted changes.
Its branch stays. A checkout with uncommitted changes is kept, and so is one whose HEAD
is detached, that is, not on a branch.

**Reply `200`:** the room, with `status: "dismissed"`, and each participant
`dismissed`. `404` `room_not_found` for an unknown room. `409` `room_dismissed` when the
room was already dismissed.

### `POST /rooms/:id/agents`

Adds one participant to a room. The request is one agent, in the same shape as an entry of
the `agents` list of [`POST /rooms`](#post-rooms).

```json
{ "agent": "claude", "name": "reviewer", "role": "tester", "base": "kapelle/room-…/p-0k3x9a2b" }
```

The reply comes when the harness is ready.

**Reply `201`:** the participant, in the shape `GET /rooms/:id` gives it.

**Refusals:** `404` `room_not_found`; `400` `invalid_request` for a bad field, or a bad
`base` (see [`POST /rooms`](#post-rooms)); `409` `name_taken`; `409` `orchestrator_exists`; `409`
`room_dismissed`; `503` `shutting_down`; `500` `room_open_failed` when the harness cannot
start.

### `GET /rooms/:id/agents` and `GET /rooms/:id/agents/:agentId`

**Reply `200`:** every participant, in the order they were added, or one participant.
`404` `room_not_found` or `participant_not_found`.

### `PATCH /rooms/:id/agents/:agentId`

Changes one participant. Send one or more of:

- `name`: a new name. The `id` and the `branch` do not change.
- `mode`: `ask`, `safe` or `auto`. The next question uses the new mode at once, and a
  question that waits under `ask` gets the new mode's answer. The harness hears of it
  before its next turn, never during one. See [Modes](#modes).
- `role`: a new role, or `null` to remove the role. To move the `orchestrator` role, first
  remove it from the participant that has it.

The daemon checks every field before it changes any. The harness and its session stay
as they are. The room's stream gets `_client_participant_changed`, with only the fields
that changed, so every client sees the change.

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

**Request:** `{ "text": "Review the login change." }`

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

**Refusals:** `404` `room_not_found` or `participant_not_found`. `400` `invalid_request`
for empty text. `409` `room_dismissed` for a dismissed room. `409` `agent_exited` after
the participant's harness exited. `429` `queue_full` when 16 messages already wait.

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
**dismiss** is built. M6-7a builds the others.

| Word | Who does it | Room after | Harness | Work on disk |
| --- | --- | --- | --- | --- |
| dismiss | a person | `dismissed`, final | stopped | branch and checkout kept for a participant that changed something; both removed for one that did not |
| delete | a person | gone | stopped | removed; refused with `409` while a checkout has work that nobody committed |
| pause | the machine (shutdown, reboot) | `paused` | stopped | branch and checkout kept |
| resume | the next message to a paused, killed or exited participant | `active` | started again in its own checkout | untouched |
| kill | the machine, during a turn (crash, harness death, a cancel that does not end) | participant `killed`; the room reads `paused` after a crash or a shutdown, and stays `active` when only the harness died | stopped by force | kept; may not match the harness's memory |

A paused room can be dismissed or deleted as it is. Neither word starts a harness first.
A room whose participants have all `exited`, or were `killed` while the daemon stayed up,
still reads `active`, because the next message brings each one back.

`DELETE /rooms/:id` is kept for **delete**, and answers `404` `no_route` until M6-7a
builds it. Today a daemon shutdown dismisses every room; M6-7a makes it a pause.

### Room record (planned)

This is the whole record. The replies above show the part that is built. The rest comes
with the story that fills it: `resumed` (M6-7a) and the room's `base` (M6-6a).

```text
room              id, cwd, title, base, createdAt, updatedAt, status
                  status: active | paused | dismissed
participant       id, name, role?, harness, mode, settings,
                  branch, worktree, baseSha,
                  sessionId, resumed?: "loaded" | "fresh",
                  status: idle | busy | exited | paused | killed | dismissed
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
- **No mention** sends the message to the participant whose `role` is `orchestrator`. A
  room with no orchestrator refuses before the request, and says: start with `@name`, or
  give a participant the orchestrator role.
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
