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
  table. Expect a change, and a `minor` or `major` step with it.
- **Experimental**: can change at any time, with no version step. Do not build on it.

| Part | Label | Changed by |
| --- | --- | --- |
| Finding the daemon (`daemon.json`) | Stable | |
| Host check and token | Stable | |
| `GET /version` | Stable | |
| `POST /repos`, `GET /repos` | Stable | |
| `POST /runs` request body | Stable | |
| `POST /runs` reply (`{id}`) | Stable | |
| `GET /runs` list | Provisional | M5-9 (filters, order, pages) |
| `GET /runs/:id`, `DELETE /runs/:id` replies | Provisional | M5-2 (one shape for live and restored runs) |
| Error replies (`{error}`) | Provisional | M5-3 (adds an error `code`) |
| Request limits (body size, content type) | Provisional | M5-3 |
| SSE format, `seq`, `Last-Event-ID` | Stable | |
| End of a run's stream | Provisional | M5-5 (adds a "run finished" event) |
| Event timestamps | Provisional | M5-5 (adds `at`) |
| Heartbeat and reconnect | Provisional | M5-6 |
| Event `update` values from the harness (ACP) | Stable as a pass-through | See [Events](#events) |
| `_client_*` events | Stable, except where marked | See [Events](#events) |
| `GET /permissions`, `POST /permissions/:id` | Stable | |
| How a permission ended (reason) | Provisional | M5-4 (adds an "answered" event) |
| `POST /runs` retry safety | Provisional | M5-7 (adds `Idempotency-Key`) |
| Cancel one task | Not built | M5-8 |
| Everything under `/rooms` | Experimental | M6-2 and later |

Version 1 stops changing at story M5-11. After that, only additions are allowed.

### Types for TypeScript clients

`client/contract.ts` has every reply shape in this document as a TypeScript type. It also
has `API_VERSION` and `CAPABILITIES`. The events inside the stream use the types in
`protocol/types.ts`. A TypeScript client can import these two files and nothing else.

A client in another language uses this document. There is no JSON Schema yet.

## Find the daemon

The daemon writes a file named `daemon.json` when it is ready. Your client reads this file
to find the port and the token.

**Where it is:**

- `$XDG_RUNTIME_DIR/kapelle/daemon.json`, when `XDG_RUNTIME_DIR` is set to an absolute path.
- Otherwise `<temp dir>/kapelle-<your uid>/daemon.json`. The temp dir is `$TMPDIR`, or
  `/tmp` when that is not set. On macOS, this is the usual case.

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

- The file exists only while the port is open. No file means no daemon.
- If the daemon crashed, the file can stay. The port then refuses your connection. Tell the
  person to start the daemon again.
- A new daemon makes a new token. Read the file again after a restart.
- The file and its folder are private to your user. Keep the token secret. Never write it
  into a log or a URL.
- The file has no version in it. Ask `GET /version` for that.

## Rules for every request

**Address.** Send every request to `http://127.0.0.1:<port>`. The `Host` header must be
one of these names, with or without a port:

- `127.0.0.1`
- `localhost` (or `localhost.`)
- `[::1]`

Any other `Host` gets `403`. So do a missing `Host` and two `Host` headers. Normal HTTP
libraries do the right thing for you.

**Token.** Every request needs this header, on every route:

```text
Authorization: Bearer <token>
```

A missing or wrong token gets `401`.

**Bodies.** Send request bodies as a JSON object. Every reply that has a body is JSON,
except the event stream.

**Errors.** Every refusal has this body:

```json
{ "error": "a sentence for a person to read" }
```

Show the sentence to the person. Do not parse it: the words can change. Decide what to do
from the HTTP status code. (M5-3 adds a stable `code` field.)

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
| `409` | The request is fine, but the thing is not in a state to accept it. |
| `500` | A bug in the daemon. |
| `503` | The daemon is shutting down. |

**Checks run in this order:** the `Host`, then the token, then the route.

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
  "apiVersion": { "major": 1, "minor": 0 },
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

**Refusals:** `400` when `path` is not absolute or does not exist, or when the
repository's `.kapelle/config.json` is not valid.

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

1. `400`: `cwd` is not an absolute path, or does not exist.
2. `403`: `cwd` is not inside an added repository. Add it with `POST /repos` first.
3. `400`: the run file is not valid. The message names the field.
4. `503`: the daemon is shutting down.

#### `GET /runs`

Every run the daemon knows. This includes finished runs from before a restart.
Provisional: M5-9 adds filters, a fixed order and pages.

**Reply `200`:**

```json
[
  {
    "id": "20260922-101500-a1b2",
    "cwd": "/home/me/src/app",
    "status": "running",
    "tasks": [
      { "id": "summarise", "status": "running" },
      { "id": "look-for-bugs", "status": "queued" }
    ]
  }
]
```

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
Show a word that you do not know as it is. Do not fail on it.

#### `GET /runs/:id`

One run in full. Provisional: today a live run and a restored run give different fields.
M5-2 makes them the same.

**Reply `200`:**

| Field | When | Meaning |
| --- | --- | --- |
| `id` | always | The run id. |
| `cwd` | always | The folder the run started in. |
| `status` | always | The run status (see above). |
| `notices` | always | A list of `{taskId, text, kind?}`. Lines for the person to read. See below. |
| `tasks` | usually | A list of `{id, status, branch?, baseSha?, sessionId?}`. |
| `report` | live run, after it ends | `{status, durationMs, turns, tasks}`, with each task in full. |
| `error` | run could not start | Why. No task ran. |
| `cancelRequested` | after a cancel | `true`. The status stays `running` until the run stops. |
| `restored` | run from before a restart | `true`. It has `tasks`, but no `report`. |

Each task in `report.tasks` has: `id`, `agent`, `cwd`, `status`, `durationMs`,
`transcript` (the agent's text), and when known `branch`, `baseSha`, `sessionId`,
`stopReason`, `usage`, `usageSemantics`, `error`, `result`, `warnings`, `summary` and
`summarySynthesised`. `client/contract.ts` (`TaskReport`) has the exact types.

A notice's `kind` is `containment`, `unverified`, `version` or `advisory`. **Always show
`containment` notices.** They tell the person how much the harness is contained. The other
kinds are advice.

**Refusals:** `404` for an unknown id.

#### `DELETE /runs/:id`

Asks the run to stop. Stopping takes a moment, so the reply comes first.

**Reply `202`:** the run, as `GET /runs/:id` gives it, with `cancelRequested: true`.
Poll `GET /runs/:id`, or follow the event stream, to see when it stops.

**Refusals:** `404` for an unknown id. `409` when the run already ended.

#### `GET /runs/:id/events`

The run's event stream. See [The event stream](#the-event-stream).

**Refusals:** `404` for an unknown id, or when the run has no event log. `400` for a bad
`Last-Event-ID`.

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
send it themselves. (A browser also cannot send the token header. That problem is still
open; see M4-1.)

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

**Tasks** (runs only):

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_task_started` | `harness` | The task left the queue. Its events follow. |
| `_client_worktree_created` | `path`, `branch`, `baseSha` | The task's own checkout exists. Missing when the run shares one folder. |
| `_client_task_finished` | `status`, `durationMs` | The task's verdict. A task cancelled before it started has this event but no `_client_task_started`. |

**Permissions:**

| `sessionUpdate` | Fields | Meaning |
| --- | --- | --- |
| `_client_permission_pending` | `title`, `kind` | A decision is about to be taken. It fires for every decision, also ones that need no person. |
| `_client_permission_queued` | `id`, `title`, `kind` | A decision waits for a person. Answer it with `POST /permissions/:id`. |
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
| `_client_user_message` | `text` | A message a person sent into the room. |
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

(Provisional: today no event says *why* a question closed. M5-4 adds that.)

#### `GET /permissions`

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

#### `POST /permissions/:id`

**Request:**

```json
{ "allow": true }
```

**Reply `200`:**

```json
{ "id": "7d4c1e0a-5b2f-4a61-9c3e-2f8b1d6a9e40", "allow": true }
```

**Refusals:** `400` when `allow` is not `true` or `false`. `404` for an id the daemon
never gave out. `409` when the question is already closed (answered, timed out, or
cancelled).

## Rooms

**Everything in this section is experimental.** The room API will change in M6-2 and
after. `chat.ts` uses it today.

A room is one harness with one session that stays alive between messages. The room has its
own git branch and checkout. Today a room always runs in `auto` mode, so it never asks a
permission.

#### `POST /rooms`

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

**Refusals, in this order:** `400` for a bad `cwd`; `403` when `cwd` is not in an added
repository; `400` for a bad or missing harness; `503` when the daemon shuts down.

#### `GET /rooms` and `GET /rooms/:id`

**Reply `200`:** a list of rooms, or one room. `404` for an unknown id.

#### `POST /rooms/:id/messages`

**Request:** `{ "text": "What does this repo do?" }`

**Reply `202`:** `{ "seq": 41 }`. The answer arrives on the room's stream. The turn is over
at the first `_client_turn_ended` with a `seq` above 41.

**Refusals:** `404` for an unknown room. `400` for empty text. `409` while the room is
busy, or after it exited or closed. Send one message at a time.

#### `GET /rooms/:id/events`

The room's event stream. Same format as a run's. `agent` is the harness name.

#### `DELETE /rooms/:id`

Stops the harness and closes the room. The reply waits until that is done. The daemon
never commits the room's work. Changes that nobody committed stay in the checkout.

**Reply `200`:** the room, with `status: "closed"`. `404` for an unknown room. `409` when
the room was already closed.

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
participant       id, name, harness, mode, purpose, settings,
                  branch, worktree, baseSha,
                  sessionId, resumed?: "loaded" | "fresh",
                  status: idle | busy | exited | paused | dismissed
room list         [{id, cwd, title, status, updatedAt,
                    participants: [{id, name, status}]}]
room detail       the room fields above, plus every participant in full
```

`resumed` is missing until a participant comes back. `loaded` means it kept its memory.
`fresh` means it started a new session.

## A first client, step by step

This example uses `curl` and `jq`. Any HTTP library works the same way.

```bash
# 1. Find the daemon.
if [ -n "$XDG_RUNTIME_DIR" ]; then f="$XDG_RUNTIME_DIR/kapelle"
else f="${TMPDIR:-/tmp}/kapelle-$(id -u)"; fi
PORT=$(jq -r .port "$f/daemon.json")
TOKEN=$(jq -r .token "$f/daemon.json")
api() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }
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
