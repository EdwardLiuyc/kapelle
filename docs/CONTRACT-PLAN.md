# Client contract plan — draft

**Status: the M4/M5/M6 stories are now in `STORIES.md`; this file is the decision
register behind them.** The room model is the no-dependency roster, R24–R30 retired.
**Amended 2026-09-20 (plan review):** the spike lands first as **M6-0** rather than last
(A2 restated), and R31 plus R37–R42 close the room decisions the stories were reading
without an answer. Still open here: the contract tables A, B, C, D, E, F, G, H, I, J, K
and M. The purpose remains to name every decision a story depends on before the work
starts.

Relationship to the other docs: `PROJECT-BRIEF.md` is the charter (why and what is in
scope), `PROJECT-PLAN.md` is the milestone narrative, `STORIES.md` is the work
breakdown and owns "Decided" markers, and this file owns the client-contract gap
between M2 and M4. When a decision here is settled, the story moves into `STORIES.md`
with a `Decided` note; this file is then the history of the discussion.

## Goal

A client — the TUI first, a chat bridge later, `attach` today — can be written from
`docs/CLIENT-API.md` alone. It discovers the daemon, checks a version, speaks
documented request and response shapes, follows a documented event stream, and never
imports `daemon.ts`, `core/`, or an internal `RunState` type to understand what it
sees. The daemon stays loopback-only, single-operator, and free of chat-platform code.

## Non-goals

- Multi-user identity, tenancy, or a bind beyond `127.0.0.1`.
- ACP over the network. ACP is stdio-only pre-1.0; the daemon HTTP API is the
  integration layer.
- Any chat SDK inside the daemon. Bridges are separate local clients.
- A database. JSON on disk and in memory stays.
- Rewriting the event bus. The bus keeps carrying the raw wire object; the contract is
  a documented view of it, not a replacement.

## Current state, by contract part

| Contract part | Exists today | Planned in the repo | Missing |
| --- | --- | --- | --- |
| Transport & auth | Loopback bind, Host guard, bearer token, SSE, JSON errors | M5 contract hardening | Body limits, content-type validation, explicit identity stance |
| Resources & operations | Repos, runs, permissions, cancel, SSE, `ps`, `attach` | M3 DAG, TUI read views (M4-2) | Room follow-up, task cancel, idempotency, repo removal, filtering |
| Payload shapes | Raw envelope, run file schema, live/restored shapes as they are | M3 handoff fields | Curated DTOs, restored-field parity, error codes, timestamps |
| Stream grammar | `seq` cursor, `Last-Event-ID` replay, committed lines | Nothing new | Run-finished event, heartbeat, retry, backpressure, reconnect in a client |
| Behavioural guarantees | First writer wins, timeout deny, preflight-before-202, sweep | TUI permission overlay (M4-3) | Resolution id/reason, idempotency, defined slow-consumer behaviour |
| Lifecycle & version | Discovery file, lock, clean shutdown, boot restore | TUI (M4 reshaped) | `GET /version`, `CLIENT-API.md`, shared types, conformance tests |
| Rooms (spike) | `chat-mvp` proves a single-participant runtime: one live harness + session, `/rooms` API, `chat.ts` | The participant primitive for a multi-agent room (direction below) | Room container, roster, per-participant settings/modes, persistence, resume, cancel-turn |
| TUI (spike) | `spike/chat-tui`: pi-tui screen for `chat.ts` | The chosen TUI direction | Room/roster sidebar, roster management, permission UI, reconnect |

## Spike evidence

Two branches already carry the direction this plan must adopt. They are evidence, not a
proposal to re-litigate.

- **`chat-mvp`** (`49a6264`, based on `4cc2c75`) — "Chat MVP: rooms in the daemon,
  `chat.ts` as a standalone front end". A room is one harness and one session kept alive
  between messages until dismissed. It adds `core/room.ts`, the `/rooms` routes, `chat.ts`,
  and the `_client_user_message` / `_client_turn_ended` events. Seven tests in
  `tests/daemon.test.ts` cover context kept, busy refusal, the HTTP-only import boundary,
  `/leave` plus attach replay, and a real pseudo-terminal.
- **`spike/chat-tui`** (`ac41315`, on top of `chat-mvp`) — "Spike: pi-tui screen for
  `chat.ts`". On a TTY, `chat.ts` is a `TuiAltScreen` app: a `ScrollView` transcript with
  `follow: "end"`, each answer a `Markdown` component re-set as chunks arrive, and an
  `Editor` disabled between `_client_user_message` and `_client_turn_ended`. Piped, it is
  the plain-text loop. `@earendil-works/pi-tui` 0.85.1 is added under M1c-7's
  presentation-dependency rule; it pins `marked` 18.0.5, so npm installs a second copy.

**What the spikes settle**, now treated as decided:

- The TUI is `chat.ts` with pi-tui, not the browser dashboard. The M4-1 HTML serving story
  and its `?token=` browser auth are retired (A3, A7, K1–K4).
- The **participant runtime** is proven: one harness, one session kept alive between
  messages, busy from `_client_user_message` to `_client_turn_ended`, dismissed with
  cancel/stop/commit. That runtime is the primitive a multi-agent room reuses (P1–P9).
- The event log and the SSE grammar are shared with runs through `streamLog`
  (`Last-Event-ID`, committed lines, one seq per log) (P2).
- `chat.ts` is HTTP-only; its single repository import is `core/runtime.ts`, enforced by a
  test. That is the proof that the API is the boundary (B6, M5-10).

**The product room model is the user direction, not the spike.** A room is a long-lived
container on one repository: a roster of named agents, not a graph of tasks. Each agent
has its own harness, its own mode (`ask`/`safe`/`auto`) and settings, and a long-lived
multi-turn session; tasks emerge in conversation and may need turns of back-and-forth
between several agents. There is no dependency relation between agents — no `needs`, no
successor, no blocked turn, no completion gate. Work sequences live in the conversation
and in the human routing messages, not in a scheduler. The spike's `core/room.ts` is the
single-participant runtime this container reuses; it is not the room model (R1–R23,
R31–R36; R24–R30 retired).

**What the spikes do not settle**, and the reshaped plan must:

- They are **13 commits behind master**: no M2-3 permission queue, M2-5 sweep, M2-6
  persistence, M2-7 config, M2-8 Host guard, M2-9 `attach`, M2-10 `ps`. Landing them is a
  rebase plus reconciliation, not a merge (S1). The spike also reuses `newRunId()` for
  rooms and writes under `.kapelle/rooms/`; R22 and #129 supersede both. **That rebase is
  M6-0, and it goes first** (2026-09-20), because it is the only item on this list that
  grows while it waits.
- The room container is not designed: roster, empty versus starter orchestrator,
  participant sessions, routing, a room topic and settings are all R decisions — and there
  is no agent-to-agent dependency relation to design.
- Rooms are `auto` only, one participant, one worktree. Per-participant modes, the
  busy/queue rule, workspace base choice and cross-agent context are R/S decisions
  (R32–R35). The spike also runs no watchdog, sends no result preamble and never commits
  on the agent's behalf — deliberate, and now recorded as **R37–R39** rather than left as
  an implementation detail a later story could silently reverse.
- Rooms are in-memory; only `events.jsonl` and `stderr.log` persist (the spike writes them
  under `.kapelle/rooms/`, which predates the #129 state-dir move). Per-participant
  restart and resume are S3/S4.
- `chat.ts` is a second front end with its own `Daemon`, `RoomView`, `LogEvent`, HTTP and
  SSE code. The shared client module (M5-10) folds it in, and `attach` with it (S7).
- The TUI's `follow` has no `Last-Event-ID`, no heartbeat and no reconnect; M5-6 lands those
  in the shared client, then both front ends get them (F1–F4, S8).

## Milestone shape

The spike reorders the work. Landing the room MVP on current master comes first, because
it is the only branch with a working room and TUI and it will conflict more the longer it
waits. The contract then hardens around the shapes the spike already uses. M4 is the TUI,
not a browser dashboard.

- **M6-0 — Land the spike on master** (first: rebase and reconcile). The spike's room and
  TUI code on current master, with its tests passing. **No new features**, and no room
  model: a single-participant room, `auto`, exactly as `chat-mvp` proves it.
- **M6-1 — Design the room container** (no code). The roster, the empty/starter choice,
  per-participant settings and the API shapes, on top of the runtime M6-0 landed.
- **M5 — Client contract.** Completes the API both `attach` and `chat.ts` need, and absorbs
  `chat.ts`'s private DTOs, HTTP client and SSE parser into `client/`.
- **M4 — TUI.** The spike screen becomes the first client of the shared module; then the
  multi-room sidebar, permission answering and reconnect land on it.
- **M6 — Rooms.** The participant runtime grows into the room container: roster, empty or
  starter orchestrator, per-participant settings and modes, routing, persistence and
  per-participant resume, per-participant worktrees, and the room API.
- **Rooms have no scheduler and no graph.** The earlier R24–R30 design (`needs`, blocked
  turns, a room scheduler, predecessor completion) is retired: agents are independent
  long-lived sessions, tasks are conversational, and M3 is irrelevant to rooms. The room
  runtime is a session manager with per-participant turn queues (R32).
- **The spike lands before it rots.** Decided 2026-09-20: every story put in front of the
  port makes the rebase larger, and the branches are already 13 commits behind. M6-0
  rebases deliberately (S1 = a) and ships behind `chat.ts`, marked experimental; the
  `kapelle chat` verb is M6-9's (S7a). The
  room *model* is still designed afterwards by M6-1; only the proven single-participant
  runtime (P1–P9) moves early.

The old M4 browser stories (HTML serving, EventSource token, XSS escaping, toasts) are
retired by A3/A7. The pi-tui dependency ratification is folded into M4-1, including the
`marked` dedupe and the optional `darwin-modifiers.node` caveat.

## Story index

Sizes are the repo's own: `XS` under 2h, `S` half a day, `M` 1–2 days, `L` 3–5 days.
Needs are hard ordering only.

| Story | Size | Needs | One line |
| --- | --- | --- | --- |
| M5-1 | M | M2-10 | Contract doc, shared types, version/capability handshake |
| M5-2 | M | M5-1 | Curated run DTOs, one shape for live and restored |
| M5-3 | S | M5-1 | Error envelopes, body limits, request validation |
| M5-4 | M | M2-3, M5-1 | Permission resolution events, settled decisions, cleanup |
| M5-5 | S | M5-1 | Run terminal event and event timestamps |
| M5-6 | M | M5-1 | SSE heartbeat, retry, reconnect, backpressure |
| M5-7 | S | M5-1, M2-6 | Idempotent dispatch for `POST /runs` |
| M5-8 | S | M2-3, M2-9 | Task-level cancel |
| M5-9 | S | M5-2 | Run filtering and repository removal |
| M5-10 | M | M5-2, M5-4, M5-5 | Shared client module and reducer; `attach` refactored onto it |
| M5-11 | M | M5-1..M5-6 | Conformance suite and v1 freeze |
| M6-0 | M | — | Land the spike on master: rebase, reconcile with M2-3..M2-10, `chat.ts` experimental |
| M6-1 | S | M6-0 | Design the room container on the landed runtime (no code) |
| M4-1 | M | M6-0, M5-10 | pi-tui screen as the first shared-client consumer |
| M4-2 | M | M4-1, M6-3 | Room/roster sidebar, switching, unread badges |
| M4-3 | M | M4-2, M5-4, M6-5 | Answer per-participant permissions from the TUI |
| M4-4 | S | M4-2 | Notifications and transcript polish |
| M6-2 | M | M6-1, M5-1, M5-10 | Room container: roster, empty/starter, DTOs |
| M6-3 | M | M6-2 | Participant lifecycle: add/remove/list, settings |
| M6-4 | M | M6-3 | Routing, timeline, streams, turn queue, cancel-turn |
| M6-5 | M | M6-4, M5-4 | Per-participant modes and permissions (default auto) |
| M6-6 | L | M6-2 | Per-participant worktrees, chained base choice, and the merge rework it forces |
| M6-7 | M | M6-2, M2-6 | Persistence, restart, per-participant resume |
| M6-8 | M | M6-4 | Orchestrator delegation — deferred by R2 |
| M6-9 | S | M6-5, M4-2 | Room CLI and bridge readiness |

Proposed critical path:

**Two roots, and no edge between them.** M6-0 needs nothing; M5-1 needs only M2-10, which
shipped. They start on the same day.

```text
M5-1 ─┬─ M5-2 ─┬─ M5-10 ─┬─ M4-1 ─ M4-2 ─┬─ M4-3
      │        └─ M5-9   │               └─ M4-4
      ├─ M5-3            │
      ├─ M5-4 ───────────┤
      ├─ M5-5 ───────────┘
      ├─ M5-6
      └─ M5-7

M6-0 ─ M6-1 ─ M6-2 ─ M6-3 ─ M6-4 ─┬─ M6-5 ─ M6-9
                                  ├─ M6-6 (L)
                                  ├─ M6-7
                                  └─ M6-8 (deferred by R2)
```

The edges that cross between the two roots, drawn as text because drawing them as lines
makes the graph unreadable: **M6-2** also needs M5-1 and M5-10; **M4-1** also needs M6-0;
**M4-2** also needs M6-3; **M6-5** also needs M5-4; **M4-3** also needs M5-4 and M6-5;
**M6-9** also needs M4-2. **M5-11** needs all six of M5-1..M5-6, which is six lines into one node, so it is named
here too. **M5-7 is not one of them** — M5-11 adds an idempotency test *if* M5-7 has
landed, which is a condition, not a dependency. **M5-8** stands alone: M2-3 and M2-9 are
its only needs and both shipped, so it is ready now and blocks nothing.

M6-0 goes first within its own root: it is a rebase, it needs nothing, and it is the only
story that gets cheaper by being done sooner. M6-1 then designs the room container on a
runtime that runs. M5-10 absorbs `chat.ts`'s private client, so M4-1 is a refactor onto one
module. **M6-2 is the gate** — three feeds meet there, and everything below it queues.

## M5 stories

### M5-1 · Contract artifact and version handshake · M · needs M2-10

Today the contract is the sum of `daemon.ts`, the M2 story amendments, and whatever
`cli.ts` happens to call. A client author cannot tell which of those facts are promises.

Deliverables: `docs/CLIENT-API.md` as the normative client-facing document;
`client/contract.ts` as the shared DTO and endpoint-type module; a version handshake
(`GET /version` or the shape chosen in **B3**); a capability list; and the compatibility
policy written down. The document must describe the SSE body, cursor semantics, every
`_client_*` event the daemon emits, permission first-writer-wins, error envelopes, and
each endpoint's stable fields.

**Amended 2026-09-21 (#145):** it also folds in the room vocabulary and record sketch
below and marks that section superseded. The sketch is planning; `CLIENT-API.md` is the
promise, and two documents cannot both be normative.

**Gap** — no artifact owns the contract, so every story below can invent its own shape.

*Done when* a reader who has never opened `daemon.ts` can implement a client from the
document, and a contract test asserts the version/capability response.

Decisions: **A1–A7, B1–B10**.

### M5-2 · Curated run DTOs · M · needs M5-1

`GET /runs/:id` currently serialises the daemon's internal `RunState`. A live run
carries `report.tasks: TaskRun[]` with fifteen or more fields; a restored run carries
`tasks: RecordTask[]` with five. `cli.ts` defines private `AttachState`, `RecordedTask`
and `Card` types to bridge the difference, and a second client would copy them.

Deliverables: an explicit `RunDto` and `TaskDto`; one shape for live and restored, with
missing data represented by the chosen convention; `GET /runs` list DTO aligned with
the same vocabulary; a mapper at the daemon edge (`toRunDto`), never in `core/`.

**Gap** — restored records cannot fill fields the DTO may want (`agent`, `durationMs`,
`usage`, `warnings`). Decide whether to extend `run.json` or mark the fields absent.

*Done when* a test asserts that a live run and a boot-restored run produce the same DTO
shape, and `attach` no longer needs to branch on `report` versus `tasks`.

Decisions: **C1–C12**.

### M5-3 · Error envelopes, body limits, request validation · S · needs M5-1

Every refusal is `{ error: string }`; bodies are unbounded; `content-type` is never
checked; unknown body fields are accepted by `readBody` (the run file is the exception,
because `validateRun` is strict).

Deliverables: the chosen error shape and a stable code vocabulary; a request body size
cap with `413`; optional `415` for a wrong content type; a request read timeout; and the
same shape for every refusal the daemon already returns.

*Done when* a mock client can switch on a documented code rather than parsing prose, and
an oversized body is refused before it is buffered.

Decisions: **C7, C8, J1–J5**.

### M5-4 · Permission resolution and settled decisions · M · needs M2-3, M5-1

`_client_permission_queued` carries `id`; the resolution event `_client_permission` does
not, and it cannot say whether the decision came from a client, the timeout, a cancel,
or a task ending. A second observer sees a decision without being able to match it to
the question or explain it.

Deliverables: an answered event (or fields on the existing one) carrying id, outcome and
reason; emission from every settle path (client answer, timeout, run cancel, task end);
an explicit policy for whether settled decisions remain queryable; and cleanup of the
queue's settled-id set now that runs have a lifetime.

*Done when* two clients on the same run can each attribute the final decision to the
same queued id and the same reason, including the timeout and cancel paths.

Decisions: **D1–D8**.

### M5-5 · Run terminal event and event timestamps · S · needs M5-1

The only "run is over" signal is the SSE stream ending. A client cannot distinguish a
finished run from a cut connection without polling `GET /runs/:id`. Events also carry
no timestamp, so a room list or bridge cannot order turns across runs.

Deliverables: a run-level terminal event emitted before the log closes; optional `at`
timestamps on the SSE envelope and/or `events.jsonl`; documented fallback for old logs
without the event; and a decision on whether `GET /runs` exposes run start/end times.

*Done when* a stream-only client knows the run ended and its final status without a
second request, and replay of a new run includes the same event.

Decisions: **E1–E6, C5, C6**.

### M5-6 · SSE liveness, reconnect and backpressure · M · needs M5-1

The stream has no heartbeat and no `retry:` directive; the reference client never
reconnects (`attach` treats a cut as fatal); `EventLog.follow` ignores `res.write()`
returning false, so a slow client buffers the rest of a run in its socket.

Deliverables: an idle heartbeat at the chosen interval; the chosen `retry` value; a
documented reconnect and dedupe rule; a backpressure seam (`follow` can pause the
reader on a full socket); a defined slow-client policy; and a reconnecting reference
client (`attach` and the M5-10 module) that replays with `Last-Event-ID`.

*Done when* killing the daemon mid-run and restarting it lets the reference client
resume without duplicates or a gap, and a deliberately slow client cannot grow the
daemon's memory without bound.

Decisions: **F1–F9**.

### M5-7 · Idempotent dispatch · S · needs M5-1, M2-6

`POST /runs` has no retry key. A chat bridge or a TUI reconnect can dispatch the same
run twice.

Deliverables: the chosen idempotency mechanism; the scope of a key; retention and
whether it survives a restart; replay and conflict responses; and the same treatment
decision for the other write endpoints.

*Done when* two identical requests with one key produce one run and the same `202 {id}`,
and a key reused with a different body is a defined error.

Decisions: **G1–G6**.

### M5-8 · Task-level cancel · S · needs M2-3, M2-9

Cancel is whole-run only. The run engine already has per-task `TaskControl`, the
watchdog cancels a TTL task, and `permissions.denyTask` exists; there is no API.

Deliverables: the endpoint and its status vocabulary; the worktree and branch outcome;
permission handling; sibling behaviour; idempotent second cancel; and the CLI/TUI
surface.

*Done when* cancelling one task leaves its siblings running, ends the task with the
chosen status, denies its pending permissions, and leaves the chosen worktree state.

Decisions: **H1–H7**.

### M5-9 · Run filtering and repository removal · S · needs M5-2

`GET /repos` is add-only; `GET /runs` returns every retained run. A TUI sidebar and a
chat bridge both need to answer "which runs belong to this repository" and "show me
the recent ones".

Deliverables: `DELETE /repos` (if wanted), `GET /runs` filters and ordering, a
pagination shape, and the run-list metadata the sidebar needs (counts, last activity)
if it should come from the daemon rather than from joining clients.

*Done when* a client can fetch one page of runs for one repository in a documented
order, and removing a repository that has no live runs succeeds with defined semantics.

Decisions: **I1–I5**.

### M5-10 · Shared client module and reducer · M · needs M5-2, M5-4, M5-5

`attach` currently owns the SSE parser, the card model, the permission answerer, and the
reconciliation against the record. `render.ts` is deliberately a single-writer, one-
stream renderer. Every new client would rebuild the same state machine.

Deliverables: a `client/` module containing the DTO types, an HTTP client built on
`daemon.json`, an SSE parser, and a per-room reducer (task status, joined prose,
pending permission, final result, notices); `attach` refactored onto it with no visible
behaviour change; the TUI and a future bridge consume the same reducer.

*Done when* `attach` contains no protocol parsing of its own, and the reducer is tested
from recorded event streams for live, restored, cancelled and replay cases.

Decisions: **B6, B7, F3, K6**.

### M5-11 · Conformance suite and v1 freeze · M · needs M5-1..M5-6

Contract tests that treat the daemon as an external process: start it, speak documented
requests, assert documented shapes, and fail on undocumented field changes.

Deliverables: a `tests/contract/` suite with a minimal mock client and `mock-agent`;
golden DTO fixtures; a replay test; a permission race test; an idempotency test if M5-7
lands; and the v1 freeze note naming what may change only additively.

*Done when* CI runs the suite with no credentials, and the suite fails when a DTO field
is renamed.

Decisions: **B8, M1–M6**.

## M4 stories — the TUI

M4 is no longer the browser dashboard. `spike/chat-tui` already proves the screen; these
stories move it onto the shared client and add what the spike deliberately left out.

### M4-1 · pi-tui screen as the first shared-client consumer · M · needs M6-0, M5-10

The spike screen becomes a consumer of `client/`. Its `Daemon`, `api`, `follow`,
`RoomView` and `LogEvent` move into the module; `chat.ts` keeps only the screen and the
commands. Also ratify `@earendil-works/pi-tui` 0.85.1 under M1c-7's rule (presentation
only, worst failure cosmetic, pinned exactly), dedupe the nested `marked` 18.0.5 with an
override to 18.0.12, and record the optional `darwin-modifiers.node` helper: lazily
loaded, try/catch-guarded, used only for Shift+Enter on Apple Terminal, never on Linux.

*Done when* `chat.ts` imports `client/` and pi-tui and nothing else from the repository,
the import-boundary test says so, and the TTY test still leaves the transcript in
scrollback.

Decisions: **S7, S8, S9, M6**.

### M4-2 · Room and roster sidebar, switching, unread badges · M · needs M4-1, M6-3

The spike is one room and one participant at a time. A room list from `GET /rooms`, a
rooms → participants tree, switching between rooms and participants without losing their
streams, and unread/attention badges derived from events (`_client_turn_ended`, permission
queued, stall warning). This is the "multiple chat rooms" requirement, one level richer
because a room has a roster. The stall warning the badge reads is the one **R38** creates:
a participant's watchdog warns and never cancels.

Decisions: **R8, R19, S11, R38**.

### M4-3 · Answer per-participant permissions from the TUI · M · needs M4-2, M5-4, M6-5

The spike is `auto` only. With a person at the keyboard, a participant can run `ask`: a
queued permission names the room, the participant and the turn, opens an overlay, the
answer posts by id, and every other observer sees the same decision through the answered
event.

Decisions: **R12, S2, S12, D1–D8**.

### M4-4 · Notifications and transcript polish · S · needs M4-2

Terminal bell and desktop notification for a room waiting on a permission or stalled,
transcript search, and the block-splitting optimisation for the `Markdown` component if
the measured re-parse cost grows past the spike's ~5 ms at 53k chars. The stall half needs
**R38**; without it no room emits `_client_stall_warning` and there is nothing to ring for.

Decisions: **R19, F9, R38**.

## M6 stories — the room container

M6 starts by **landing** the participant runtime the spike already proves, then builds the
room container the user direction describes: a roster on one repository, empty or with a
starter orchestrator, per-participant settings and long-lived sessions.

### M6-0 · Land the spike on master · M · needs nothing

**Decided 2026-09-20. Landed 2026-09-21 (#144).** The port moves from last to first. The spike branches are already
13 commits behind master, every story placed in front of the rebase makes it larger, and
nothing else in M4/M5/M6 gets cheaper by waiting. Rebase `chat-mvp` onto current master (S1 = a)
and reconcile with what landed since: the M2-3 permission
queue, the M2-5 sweep, M2-6 persistence, M2-7 config, the M2-8 Host guard, M2-9 `attach`
and M2-10 `ps`. Two things the spike predates must be corrected in the rebase: room state
moves out of `.kapelle/rooms/` to `stateDirFor(root)` (#129), and `children.json` gains
S14's `{pid, kind, ownerId, unitId}` shape with the legacy entry read as a run.

**Only `chat-mvp` lands (decided 2026-09-21, #144).** `spike/chat-tui` is left alone —
not landed and not rebased: M4-1 is the story that ratifies `@earendil-works/pi-tui`
0.85.1 under M1c-7's rule and dedupes its nested `marked`, and it needs M5-10 first.
Landing the screen here would ratify a second runtime dependency ahead of the story that
vets it, so `package.json` keeps `marked` as its only one. Rebasing it here as well would
be the same work done twice, since its base moves again when M6-0 reaches master.

**No new features.** One participant per room, `auto` only, no roster, no per-participant
modes, no permission answering. `chat.ts` ships marked **experimental** in its header and
its usage line, so the room API is not a promise until M5-1 documents it. The `kapelle
chat` verb itself stays with **M6-9** (S7a), which owns it; M6-0 keeps `node chat.ts`.
The room *model* is designed afterwards by M6-1, and M6-2..M6-9 build it; this story only
stops the proven runtime from rotting.

R37 applies from this story on: the supervisor never commits a participant's branch.
The spike's `close()` releases the worktree as `done`, which commits the work and removes
the checkout. The rebase must stop doing both. `core/worktree.ts` `release` already has the
behaviour R37 wants under a **non-releasing** status — the checkout is kept uncommitted,
and a participant that committed its own work is not `untouched`, so its branch survives —
but every existing non-releasing label (`failed`, `cancelled`, `timed_out`) is a lie about
a room that simply closed. **Settled 2026-09-21 (#144): `release` takes the decision.** Its second parameter is a
`ReleaseAction` — `"commit" | "keep"` — and `RELEASES` moves to `core/run.ts` beside
`TaskStatus`, converting at its one call site; a room always passes `"keep"`. The
alternative, a seventh `TaskStatus`, was rejected: `BY_SEVERITY`, `statusFor`, `runStatus`
and the `run.json` record would each have to answer for a value no task can reach, and
`core/worktree.ts` would keep importing a run word it has no use for. It now imports none.

Add the `ponytail:` comment R40 asks for at the point the room runtime spawns a harness:
nothing bounds the live count across runs and rooms in v1.

**S9 lands here, not in M6-2 (decided 2026-09-21, #144).** A chat with one agent is a room
of two — the operator and the agent — so rooms are the general case and a room id should
never have been a run id. `core/ids.ts` gains `newRoomId()` (`room-YYYYMMDD-HHMMSS-xxxx`)
and a private `assertOwnerId` that takes a run id **or** a room id, which is what
`branchName` validates with, since `core/worktree.ts` serves both. `assertRunId` still
rejects a room id, so `kapelle merge <runId>` cannot reach into a room's branches.
`assertRoomId` and `roomBranchName` are **not** added: nothing imports them, and
`npm run knip` fails on an unused export. M6-2 adds them when it has a caller.

*Done when* the spike's seven `tests/daemon.test.ts` cases pass on master, `npm run check`
and `npm run fmt:check` are clean, room state is under `stateDirFor(root)`, and
`node chat.ts` drives a room end to end against `mock-agent.mjs`.

Decisions: **S1, S9, S13, S14, R37, R40**.

### M6-1 · Design the room container · S · needs M6-0

With the single-participant runtime on master, design what the spike does not have: the
roster, the empty/starter orchestrator choice, per-participant settings, streams and
persistence. No code lands from this story; it ends with the R/S decisions recorded and
the API shapes sketched for M6-2 onward.

**R42 is re-opened here (raised 2026-09-21, #144).** The owner's stated requirement is
the opposite of what R42(b) records: agents idle in a room with uncommitted work, the
machine reboots, and the operator expects to keep talking to them afterwards. Today a
daemon shutdown calls the same `close()` as a dismiss, so a restart is a **stop**, not a
pause. R42(b) then makes the restored room read-only. Nothing blocks the other answer —
three of the four measured harnesses advertise `loadSession: true`
(`docs/M0-FINDINGS.md:136`; pi-acp's `loadSession` was not measured — see the backlog note in
`docs/STORIES.md`), so S3(c) is unscheduled rather than impossible. M6-1 decides whether shutdown and close stay the same
verb, and R37's `keep` is what makes either answer possible: the checkout is still there.

**Answered 2026-09-21 (#145).** R42 is decided as (c): a shutdown is a pause. With it came
four consequences, each recorded on its own row rather than in prose — R9 (roster inline,
dismiss off `DELETE`), R17/S4 (`sessionId` from the first version), R33 (the five-state set,
and pause as one reloadable state whose only v1 trigger is the daemon's shutdown), S3 and S11
(their meanings corrected). The
vocabulary and the record sketch are the section at the end of this file.

*Done when* every R decision that shapes an API has an answer, and M6-2..M6-9 can be
picked up without re-opening the model.

Decisions: **R1–R23, R31–R42, S10, S12, S13**.

### M6-2 · Room container: roster model, empty/starter, DTOs · M · needs M6-1, M5-1, M5-10

Define the room record: repo, roster, created/updated, title; `POST /rooms` accepts an
empty room or a starter participant (the orchestrator) and answers `201` once the session
exists (S13); `RoomDto` and `ParticipantDto` land in `client/contract.ts`; the
persistence layout is decided (R17). `newRoomId()` already landed in M6-0 (#144), so
what is left here is `assertRoomId` and `roomBranchName` — both only once something
imports them — and opaque, ref-safe participant ids; the run-id functions stay untouched
(R22). There is no
dependency field and no scheduler: the roster is a list of independent agents (R24–R30
retired). For v1 the room carries a title only (R36a); a room-level topic injected at add
is a follow-up (R36b).

*Done when* an empty room and a room with a starter participant both round-trip through
`GET /rooms/:id`, room and participant ids are validated by tests, and the DTOs are
covered by contract tests.

Decisions: **R1, R3, R9, R17, R21, R22, R33, R36, S4, S13** (R36 settled: title now, topic later).

### M6-3 · Participant lifecycle: add/remove/list, settings, names · M · needs M6-2

`POST /rooms/:id/agents` with `{name, agent|cmd, mode, settings}`; list, get, remove, and
**rename** (R10 grants it, so the story carries it: the display name is mutable, the
opaque id and the branch name are not).
Names are unique in the room and validated; harness is fixed at add; mode is mutable and
defaults to `auto` (R12). The API is nested (R9a). Removal cancels the session and applies
the worktree policy. Participant settings reuse the run-file `Task` fields minus
`prompt`/`needs`.

*Done when* a room can hold several named participants, each with its own harness and
mode, and removing one leaves the others untouched.

Decisions: **R4, R9, R10, R12, R15, R18, R33**.

### M6-4 · Routing, room timeline, participant streams and cancel-turn · M · needs M6-3

R7, R8, R13, S5, R32 and R34 are decided. A message names its target participant, with
the orchestrator as the default target (R7a). One room log carries `participantId` and one
room sequence; a per-participant thread is a client-side filter over that log (R8c over
R13a). Every room log/SSE line is `{seq, roomId, participantId, update}` (S10); run lines
stay `{seq, agent, update}`. `GET /rooms/:id/events` replays the room log; the nested
participant events route is the server-side filtered view (R9a). A turn is cancelled with
`POST /rooms/:id/agents/:agentId/turns/current/cancel`, and the participant's session
survives (S5a). There is no dependency or blocked state: a message to a busy participant
joins a bounded FIFO queue (R32a), and cross-agent context is human-composed in v1 (R34a),
with `contextFrom` as the next addition (R34b). **R41 sizes that queue**: bound 16, `429`
when full, in memory and lost at restart. **R39** keeps a turn a conversation: no
`RESULT_PREAMBLE`, no `crossCheck`. **R38** gives the turn a watchdog that only warns.

*Done when* a client can replay one participant's conversation and the whole room
timeline from one log, an event names its room, participant and turn, a turn can be
cancelled without dismissing the room, a second message to a busy participant is
queued FIFO and answered in order, and the seventeenth is refused with `429`.

Decisions: **R6, R7, R8, R13, R32, R34, R38, R39, R41, S5, S10, S11** (R7, R8, R13, R32, R34, S5 and S10 settled).

### M6-5 · Per-participant modes and permissions · M · needs M6-4, M5-4

Replace the spike's `auto`-only policy with a per-participant mode chosen at add
(`ask`/`safe`/`auto`; default `auto` per S2), scoped to the participant's own worktree.
Extend the permission queue with `roomId`, `participantId` and `turn` (S12); keep
first-writer-wins and the timeout deny; emit the answered event from M5-4.

*Done when* a participant's mode can be changed between `ask`/`safe`/`auto`, an `ask`
participant's permission can be answered from the TUI, an `auto` participant warns about
silent autonomy, and a `safe` participant is contained in its own worktree.

Decisions: **R12, S2, S12** (S12 settled as a).

### M6-6 · Per-participant worktrees, chained base, and the merge rework · L · needs M6-2

Each participant owns one worktree and one branch, `kapelle/<roomId>/<participantId>`,
forked from the room base by default (R14); nothing is inherited and no checkout is
shared, because there is no dependency graph (R24–R30 retired). R35(c) is **kept for
v1**: the add request may name a base ref, **including another participant's branch**.
Parallel turns are safe because each participant has its own checkout (R6b); nothing caps
the live harness count in v1 (R40). Under R37 the participant commits its own branch, so
the supervisor contributes no commits of its own.

**The merge rework is this story's real cost, and it is why the size is `L`.**
`core/merge.ts` assumes **one base per run**: it computes each branch's changed files from
that branch's own `baseSha` (`core/merge.ts:83`), refuses when two branches touch one file
(`:86`), then runs one `git merge --squash` over every branch at once (`:126`). With
chained bases the two diffs are measured from different points, so the overlap preflight
can pass while the squash replays the parent's work. Two further mismatches: the
`done`/`warned` gate (`:65`) describes a task status a participant never reaches (R37), and
the record it reads is a `run.json`, not a room.

Deliverables: a preflight that is correct when participants have different bases; a test
proving the multi-branch squash is right when one branch's history contains another's; the
room entry point R31 asks for, merging in creation order and aborting atomically; and the
participant states a room merge accepts, in place of `done`/`warned`.

*Done when* two participants work in parallel without touching each other's files, a room
close leaves the participant branches, a chained-base pair merges without replaying the
parent's commits, and a genuine conflict is refused by name with nothing half-landed.

**Risk, named on purpose.** This is the one place in the room model that needs new,
untested git logic. If it proves hard, the fallback is R35(a) — every participant forks
from the room base — and chained bases move to R35(d) with the re-base capability.

Decisions: **R6, R14, R31, R35, R37** (R35 settled as (c), kept for v1 on 2026-09-20).

### M6-7 · Persistence, restart and per-participant resume · M · needs M6-2, M2-6

Persist under `stateDirFor(root)/rooms/<roomId>/`: `room.json` plus one participant
record per agent (harness, mode, sessionId, branch, worktree, status). Retention and idle
eviction follow the owner's config.

**Rewritten 2026-09-21 (#145) — a shutdown is a pause (R42(c)), so this story owns Half A.**
Shutdown stops each harness and persists the room; it no longer calls the dismiss path. A
restart restores the roster with every participant `paused`, and a participant revives on
its next message: respawn the harness in its existing worktree with a fresh session and
`resumed: "fresh"` on the DTO. Half A needs no new protocol method and no probe. **Half B —
`session/load` itself — stays deferred with S3(c)**; when it lands, a harness that advertises
`loadSession: true` reattaches with `resumed: "loaded"` instead of a fresh session. Half B is
gated on a measurement nobody has taken: every `loadSession: true` we hold is a handshake
claim, never a session loaded into a **new** harness process, and pi-acp's own table
(`docs/M0-FINDINGS.md:1019`) has no `loadSession` row at all. `exited` revives through the
same fresh-session path, so a crashed room is recoverable too (R33).

*Done when* a restart lists the room with every participant `paused`, its history replays,
a message to one revives it and is answered, the DTO reports `resumed: "fresh"`, and a
dismissed room is **not** revived by the same path.

Decisions: **R17, S3, S4, R42** (S4 decided as (b)).

### M6-8 · Orchestrator and supervisor-mediated delegation · M · needs M6-4 · deferred by R2

R2 is decided for v1: the orchestrator is a normal participant and the default
recipient, with no special delegation powers. Rooms have no dependency graph and no
successor relation, so this story is purely the deferred delegation choice (R34c): a
coordinator whose messages the daemon relays, or supervisor-mediated context injection.
The charter says no agent-to-agent messaging; daemon-mediated handoff stays on the right
side of that line.

*Done when* the chosen behaviour is implemented or explicitly deferred behind a
`Decided` note; a direct agent-to-agent channel is not built without re-opening the
brief.

Decisions: **R2, R23**.

### M6-9 · Room CLI and bridge readiness · S · needs M6-5, M4-2

S7 is decided: keep `chat.ts` standalone and add `kapelle chat` that runs the same
HTTP-only binary; no second implementation in `cli.ts`. Room ids are not run ids (R22),
so `kapelle merge` needs a room entry point (R31). Document the bridge pattern in
`CLIENT-API.md`: a local process subscribes to a room or participant stream and answers
permissions; no chat SDK enters the daemon.

Decisions: **S7 (a), K5, R19, R31**.

## Decision register

Answer in the interview by ID. Each row carries the options and a recommendation; "open"
means no answer yet. A recorded answer becomes a `Decided <date>` line under the owning
story, and the story moves into `STORIES.md`.

### Program and sequencing

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| A1 | Milestone shape | (a) M5 contract + M6 rooms (b) all as M2-11+ (c) one milestone | (a) |
| A2 | Ordering vs M3 and M4 | (a) M6-1 design first, then M5, port last (b) contract first, rebase spike later (c) M3 first (d) **port first (M6-0)**, then M5 and M6-1 in parallel | **Decided 2026-09-20:** (d). Rooms stay independent of M3 for v1. The rebase is the one item that gets more expensive the longer it waits, and it needs nothing |
| A3 | Browser dashboard | retired — TUI is `chat.ts` + pi-tui (`spike/chat-tui`) | **Settled by spike** |
| A4 | Freeze `POST /runs` before M3? | (a) freeze now, M3 additive (b) let M3 change it, freeze after | (a) |
| A5 | When does v1 stop changing? | (a) at M5-11 (b) after first external client ships (c) never | (a) |
| A6 | Story placement | (a) `STORIES.md` now as Proposed (b) keep this draft until interview closes | (b) |
| A7 | TUI ownership and numbering | M4 becomes the TUI; `chat.ts` is the binary | **Settled by spike** |

### Contract artifact and versioning

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| B1 | Source of truth | (a) `CLIENT-API.md` + `client/contract.ts` (b) OpenAPI/JSON Schema generated (c) types only | (a) |
| B2 | Version scheme | (a) integer `apiVersion: 1` (b) semver (c) capability-only (d) date | (a) |
| B3 | Version surface | (a) `GET /version` (b) `GET /` (c) response header (d) a + c | (a) |
| B4 | Capability list | endpoint names, feature flags, or both; exact names to fix here | feature flags, additive |
| B5 | Mismatch behaviour | (a) refuse with 426 (b) warn and continue (c) best effort | (b) for 1.x, refuse only major |
| B6 | Shared module location | (a) `client/contract.ts` (b) `protocol/contract.ts` (c) `api/` | (a) |
| B7 | Machine-readable schema | (a) TS types + contract tests (b) hand-written JSON Schema (c) OpenAPI | (a), revisit at freeze |
| B8 | Conformance suite home | (a) `tests/contract/` (b) `integration/` (c) per-module tests only | (a) |
| B9 | `daemon.json` carries version? | (a) no, discovery only (b) yes, both | (a) |
| B10 | Doc style | (a) normative MUST/SHOULD (b) plain language with a stability table | (b) plus a stability table |

### DTOs and payload shapes

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| C1 | `GET /runs` fields | id, cwd, root, status, tasks, times, source | add root, startedAt/endedAt, keep tasks |
| C2 | Missing data on restored runs | (a) omit (b) `null` (c) `source: live/restored` + omit (d) explicit `missing[]` | (c) |
| C3 | Contract fields per task | status + agent + duration + warnings + summary, or a subset | status, agent, duration, warnings, summary |
| C4 | Extend `run.json` for restored parity? | (a) yes, agent/duration/warnings (b) keep minimal, mark absent | (a) if cheap, else (c) in C2 |
| C5 | Run times in DTO | (a) startedAt/endedAt ISO (b) epoch ms (c) omit | (a) |
| C6 | Event timestamps | (a) add `at` to `events.jsonl` and SSE (b) SSE only (c) omit | (a) |
| C7 | Error shape | (a) keep `{error: string}` (b) `{error:{code,message}}` (c) full problem detail | (b) |
| C8 | Unknown request fields | (a) reject strictly (b) ignore (c) per endpoint | (a) for writes |
| C9 | Pagination | (a) limit/cursor (b) limit/offset (c) none | (a) |
| C10 | Run order | (a) newest first by startedAt (b) insertion order | (a) |
| C11 | `_meta` in DTO docs | (a) documented pass-through (b) stripped (c) unspecified | (a) |
| C12 | Rename `agent` to `taskId` in events | (a) no, document (b) yes, new field both | (a) |
| C13 | Room DTO | id, cwd, status, roster summary, created/updated, counts | roster summary + status + times |
| C14 | Participant DTO | id, name, harness, mode, status, workspace, branch, sessionId, last activity | all, sessionId optional |

### Permission resolution

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Event shape | (a) add id/reason to `_client_permission` (b) new `_client_permission_answered` (c) both | (b), keep the existing event |
| D2 | Reason vocabulary | `client`, `timeout`, `cancel`, `task_end`; add `run_end`? | all five |
| D3 | Emitter | (a) `core/permissions.ts` (b) `protocol/agent.ts` (c) daemon wrapper | (a) |
| D4 | `_client_permission_pending` | (a) advisory only (b) also gain an id | (a) |
| D5 | Settled history | (a) `GET /permissions/:id` outcome (b) list with `include=settled` (c) event-only | (a) |
| D6 | `409` body | (a) message only (b) winning outcome + reason | (b) |
| D7 | Settled-id cleanup | (a) drop with run lifetime (b) TTL (c) keep for process | (a) |
| D8 | Emit resolved for TTY asks? | (a) no id, no queue event (b) unify | (a) |

### Terminal event and times

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| E1 | Event shape | `{status, durationMs, turns, error?}`; tasks included? | status, durationMs, turns; tasks via GET |
| E2 | Emitter | (a) `core/run.ts` last line (b) daemon wrapper | (a) |
| E3 | Ordering | last line before `close()`; `_client_task_finished` first | confirm (a) |
| E4 | Old logs without the event | (a) EOF fallback documented (b) backfill (c) ignore | (a) |
| E5 | Daemon crash case | no event; sweep marks errored; client reconnects to status | confirm (a) |
| E6 | Duplicate final summaries? | (a) status only (b) include result summaries | (a) |

### SSE liveness and backpressure

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| F1 | Heartbeat | (a) comment `: ping` every 15s (b) 30s (c) none | (a), configurable |
| F2 | `retry:` | (a) send 3s initially (b) client default (c) omit | (a) |
| F3 | Reference-client reconnect | (a) auto with backoff + dedupe (b) remain fatal | (a) |
| F4 | Delivery guarantee | (a) at-least-once + client dedupe (b) exactly-once effort | (a) |
| F5 | Backpressure seam | (a) `follow` pauses on false (b) per-client ring (c) leave unbounded | (a) |
| F6 | Slow-client policy | (a) disconnect after high-water (b) block the run (c) unbounded | (a) |
| F7 | Ping and buffer interaction | (a) count pings in the bound (b) bypass | (a) |
| F8 | Bad `Last-Event-ID` | keep 400 with documented range | confirm |
| F9 | Lag observability | (a) none (b) `_client_stream_lagged` event | (b) if cheap |

### Idempotency, cancel, listing, limits, auth

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| G1 | Idempotency now? | (a) yes (b) trigger at first bridge | (a) |
| G2 | Key location | (a) `Idempotency-Key` header (b) body field | (a) |
| G3 | Scope | (a) operator-wide (b) per repo (c) key + body hash | (c) |
| G4 | Storage | (a) in-memory TTL 24h (b) persisted (c) never expire | (a), persist only if a bridge must survive restart |
| G5 | Conflict response | (a) same 202 replay (b) 409 on different body (c) both | (c) |
| G6 | Other writes | (a) runs only (b) repos too (c) all writes | (a) |
| H1 | Cancel endpoint | (a) DELETE task path (b) POST cancel subresource | (a) |
| H2 | Terminal status | (a) `cancelled` (b) `timed_out` | (a) |
| H3 | Worktree outcome | (a) keep work (b) roll back if untouched (c) differ by task state | (b) |
| H4 | Siblings continue | confirm run status is worst-of | confirm |
| H5 | Deny pending permissions | confirm `denyTask` on cancel | confirm |
| H6 | Second cancel | (a) 409 (b) idempotent 202 | (b) |
| H7 | Client surface | (a) `kapelle cancel` (b) only `attach`/TUI (c) both | (c) |
| I1 | `DELETE /repos` | (a) add (b) defer (c) replace with archive | (a) |
| I2 | Filters | cwd/root, status, since; exact names | cwd + status + since |
| I3 | Pagination shape | cursor by (startedAt, id), default 50 | confirm |
| I4 | Reaped runs | absent from list, documented | confirm |
| I5 | Repo metadata | (a) counts/last run from daemon (b) client joins | (a) |
| J1 | Body cap | (a) 1 MiB (b) 4 MiB (c) per endpoint | (b), run files carry prompts |
| J2 | Content type | (a) require JSON, 415 (b) liberal | (a) |
| J3 | Read timeout | (a) 30s (b) none | (a) |
| J4 | Rate limit | explicitly none, loopback single operator | confirm |
| J5 | Response compression | none | confirm |
| K1 | Browser fate | retired by A3: the TUI is the only front end | **Settled by spike** |
| K2 | Token in URL | retired with K1 | **Settled by spike** |
| K3 | Origin check | the M2-8 Host guard stays; no CORS because no browser UI | **Settled by spike** |
| K4 | Static UI | the daemon stays API-only; `chat.ts` and the TUI own presentation | **Settled by spike** |
| K5 | Bridge tokens | one operator token; bridge local | confirm |
| K6 | Per-client id | (a) none (single operator) (b) optional `clientId` on writes | (a) now, (b) if audit needs it |

### Participant runtime — settled by the spike

The spike is the runtime for **one participant**, not the room model. The room container
reuses these mechanics; the product model itself is R1–R23.

| ID | Settled shape | Evidence |
| --- | --- | --- |
| P1 | One harness, one session, kept alive between turns; a prompt after `end_turn` keeps context | `core/room.ts`, #111 |
| P2 | Busy from `_client_user_message` to `_client_turn_ended`; a second message is a 409 | `send()` |
| P3 | The event log and SSE grammar are shared with runs: `streamLog`, `Last-Event-ID`, committed lines, one seq per log | `streamLog` |
| P4 | Turn boundary events `_client_user_message` / `_client_turn_ended` | `protocol/types.ts` |
| P5 | `POST /messages` returns `{seq}` so a client waits for the first turn end past it | daemon route |
| P6 | The client derives busy from the stream, not from its own request | `chat.ts` |
| P7 | A participant's worktree and branch are acquired and released through `core/worktree.ts` | `openWorktrees`, `release` |
| P8 | `chat.ts` is HTTP-only; the import boundary is test-enforced | import test |
| P9 | pi-tui is the screen: `TuiAltScreen`, `ScrollView` transcript, `Editor`, `Markdown` per answer, transcript left in scrollback | `ac41315` |

### Room model — direction and open decisions

**Direction (user):** a room is a long-lived container on one repository: a roster of
independent, named agents, not a graph of tasks. It starts empty or with a starter agent
acting as the room's orchestrator. Each agent has its own harness, mode, settings and
long-lived multi-turn session; tasks emerge in conversation and may span turns. There is
no dependency relation between agents (R24–R30 retired).

| ID | Decision | Options | Lean |
| --- | --- | --- | --- |
| R1 | Room composition | container on one repo with a roster; created empty or with a starter participant | **Decided (interview):** direction confirmed |
| R2 | Orchestrator semantics | (a) a normal participant that is the default recipient (b) daemon-mediated coordinator: roster + status + delegation (c) direct agent-to-agent (violates the brief) | **Decided (interview):** (a) for v1; delegation deferred to R23 and M6-8 |
| R3 | Session cardinality | (a) one long-lived session per participant (b) multiple addressable sessions per participant (c) room-level sessions participants attach to | **Decided (interview):** (a) for v1; (b) later if feasible |
| R4 | Participant identity | opaque id + unique display name; harness fixed at add; mode mutable | **Decided (interview):** yes |
| R5 | Workspace isolation | (a) one shared room worktree (b) one worktree+branch per participant (c) hybrid following M3 inheritance rules | **Retired (interview):** rooms have no dependency graph, so there is no hybrid and no inheritance. Every participant owns a worktree+branch forked from the room base; the base choice is R35 |
| R6 | Concurrency | (a) one turn in the room at a time (b) per-participant turns in parallel (c) bounded global pool | **Decided (interview):** (b) per-participant turns in parallel; each participant has its own worktree, so there is no shared-checkout serialisation. A global resource cap stays config |
| R7 | Routing | (a) explicit target per message (b) the orchestrator receives all and routes (c) broadcast to all | **Decided (interview):** (a), with the orchestrator as the default target |
| R8 | Transcript model | (a) per-participant threads (b) one interleaved room timeline (c) both | **Decided (interview):** (c), implemented over R13(a): one room log; a thread is a filter by `participantId` |
| R9 | API shape | (a) nested `/rooms/:id/agents(/:agentId)/messages` and `/events` (b) flat agents with a `room` query (c) keep `/rooms/:id/messages` with an `agent` field | **Decided (interview):** (a) nested. **Amended 2026-09-21 (#145):** two shape facts nesting did not settle. `GET /rooms` carries the roster **inline and summarised** — `participants: [{id, name, status}]`, the shape `GET /runs` already gives its tasks (`daemon.ts:987`) — so M4-2's sidebar draws from one call rather than one per room; the full `ParticipantDto` is on `GET /rooms/:id`. And **dismiss moves off `DELETE`**: `POST /rooms/:id/dismiss` ends a room, while `DELETE /rooms/:id` keeps the meaning R18 always gave it. The MVP mapped both onto `close()`, which is why R18 and the code disagreed |
| R10 | Participant lifecycle | add/remove/rename; mode change; harness fixed; crash marks exited; idle eviction | **Decided (interview):** yes, as described |
| R11 | Empty room | messages refused 409 until a participant exists; roster operations still allowed | **Decided (interview):** yes |
| R12 | Modes per participant | (a) `ask`/`safe`/`auto` at add, default `auto` (b) the same, default `ask` when a TTY client is attached | **Decided (interview):** (a) — `ask`/`safe`/`auto` at add, **default `auto`**, mutable after add; `auto` still warns about silent autonomy; the queue is scoped to the participant. **Re-confirmed 2026-09-20:** `ask` was reconsidered as the default, because the CLI defaults to `ask` and M4-3 makes answering possible. Rejected: a room is often left unattended, and an `ask` default would wedge one until a human returned. The containment warning, the per-participant worktree and `#guardPath` carry the risk instead |
| R13 | Stream grammar for a roster | (a) one room log with `participantId` and one room seq (b) one log+seq per participant (c) both | **Decided (interview):** (a) one room log with `participantId` and one room seq; the client filters |
| R14 | Branch and merge | tied to R5: per-room branch or per-participant branches; how `kapelle merge` consumes them | **Decided (interview):** one branch per participant, `kapelle/<roomId>/<participantId>`, forked from the room base (R35); no handoff and no room integration branch in v1; merge consumes persisted branch names (R31) |
| R15 | Participant settings | reuse the run-file `Task` fields; add a purpose/instructions field for "different tasks"; `prompt`/`needs` are not settings | **Decided (interview):** yes, plus a purpose/instructions field; `prompt`/`needs` are not settings. The purpose is prompt material, never a task status (R33) |
| R16 | Room versus run | (a) separate; `POST /runs` unchanged (b) a room can dispatch a run from its roster (c) a run becomes a room | **Decided (interview):** (a) now; (b) deferred |
| R17 | Persistence | room.json + participant records + event log(s); restore read-only; resume per participant, capability-gated | **Decided (interview):** `stateDirFor(root)/rooms/<roomId>/` with `room.json`, participant records and event log(s); restore read-only; resume per participant, capability-gated. **Amended 2026-09-21 (#145):** restore is **not** read-only any more (R42), and the participant record carries the harness `sessionId` from its first version — the M2-6 precedent (`docs/STORIES.md:1800`): one field now, or a migration once resume lands |
| R18 | Room lifecycle | close/archive/delete with N participants; retention; idle eviction | **Decided (interview), corrected 2026-09-21:** dismiss stops every participant and keeps its branch, its checkout and the room's history. **The supervisor commits nothing at dismiss (R37)** — the earlier "commits/releases" wording predates R37 and contradicted it. DELETE removes from the active list; retention reaps dismissed rooms; idle eviction configurable and off in v1; archive read-only deferred. **Amended 2026-09-21 (#145) — one word per idea, in code, URL and docs.** `dismiss`: a person ends the room; it stops, and its branch, checkout and history are kept (`POST /rooms/:id/dismiss`). `delete`: it is thrown away (`DELETE /rooms/:id`, the meaning this row already gave it). `pause`: the machine stopped (R42). `resume`: it comes back. A dismissed room is read, replayed, **merged** (R31) and finally deleted or reaped — merging is why the state earns its place, since the participant commits its own branch (R37) and landing it happens after the talking is over. Dismiss is final; pause is the reversible one |
| R19 | TUI shape | sidebar rooms → participants; active participant thread + room timeline; badges per participant; the permission overlay names the participant | **Decided (interview):** yes, as described |
| R20 | Cost | per-participant usage labelled by harness; no cross-harness totals | **Decided (interview):** yes |
| R21 | Starter/orchestrator creation | `POST /rooms {cwd, orchestrator?: {agent or cmd, name?, mode?}}`; empty body allowed; 201 | **Decided (interview):** yes; default orchestrator mode `auto` (R12); 201 |
| R22 | Naming and ids | room id `newRunId()`; participant opaque id + validated unique name; branch names if R5 forks | **Decided (interview):** a distinct `newRoomId()` — do not reuse the run id; participant ids opaque and ref-safe |
| R23 | Orchestrator instructions | if R2 = coordinator, inject roster, status and the daemon-mediated delegation protocol; if R2 = normal, nothing | defer with R2 |
| R24–R30 | dependency model (retired) | R24 needs, R25 inherit, R26 blocked turns, R27 scheduler, R28 predecessor-done, R29 multi-parent base, R30 reactivation | **Retired (interview):** a room is a group of independent long-lived agents, not a task DAG. Tasks are conversational and may span turns; work is sequenced by the human routing messages, not by dependencies. No `needs`, no handoff, no blocked turn, no scheduler, no completion gate. |
| R31 | Room merge entry point | (a) `kapelle merge <roomId>` detects the `room-` prefix and merges participant branches (b) a separate `kapelle room merge <roomId>` (c) merge stays per-participant, no room-level entry (d) integrate-then-land | **Decided 2026-09-20, wording corrected 2026-09-21:** the surface is (b), `kapelle room merge <roomId>`. The v1 **scope** is one participant at a time (`--participant`), with whole-room merge as the additive follow-up; the earlier note read "(c) as the v1 subset", which cannot be right — (c) says there is no room-level entry at all, and (b) adds one. (d) integrate-then-land is the internal shape when whole-room lands. No dependency order exists, so order is creation order and conflicts abort atomically. Answered inside M6-6, because chained bases (R35c) force that story to rework the preflight anyway, and the `done`/`warned` gate at `core/merge.ts:65` has to be replaced with participant states either way (R37) |
| R32 | Per-participant turn queue | (a) FIFO queue, bounded, while the agent answers (b) refuse 409 while busy (c) interrupt/replace the live turn (d) latest-only queue | **Decided (interview):** (a) bounded FIFO; replacement goes through the explicit cancel endpoint (S5) |
| R33 | Participant availability | (a) always available until removed or the room closes; no terminal state (b) an explicit pause/offline state (c) a display-only goal/done flag | **Decided (interview):** (a): runtime state (`idle`/`busy`/`exited`/`closed`) is the only participant state. (c) is retired: it reintroduces a task status the room model removed, and `idle` already answers "can I send now?". (b) needs no new state — see below; only its person-facing trigger stays deferred. **Amended 2026-09-21 (#145):** the state set is `idle`/`busy`/`exited`/`paused`/`dismissed` — `closed` is renamed `dismissed`, and `paused` is R42's. Pause is one state, whoever or whatever stopped the room: it means the room can be reloaded from what it left, with the harness stopped and its work kept. v1 reaches pause only through a daemon shutdown (R42); a person-facing pause would be a second trigger on that same state, not a new state, and no such route is in v1. `exited` — the harness died by itself — revives through that same path once M6-7 lands resume, so a crashed room stops being a dead end. |
| R34 | Cross-agent context | (a) human-composed only; the client includes another agent's text in its message (b) `POST messages {contextFrom}` injects those participants' last turn or result (c) supervisor-mediated delegation, charter-gated | **Decided (interview):** (a) for v1; (b) as the next addition; (c) stays deferred with M6-8 |
| R35 | Workspace base and rebase | (a) fork from the room base at add (b) fork at first turn (c) choose a base ref at add, including another participant's branch (d) allow a later re-base | **Decided (interview):** (c) with the room base as the default; (d) later |
| R36 | Room topic/context | (a) a title only (b) a room-level topic or instructions injected into every participant at add (c) none | **Decided (interview):** (a) now: a title only; (b) as a follow-up addition |
| R37 | Commit cadence for a participant | (a) the supervisor commits at every turn end (b) the supervisor commits at room close (c) the participant commits its own branch itself | **Decided 2026-09-20:** (c). It is the participant's own branch, so a lazy agent harms nobody else, and the supervisor stays out of the commit business entirely. There is **no auto-commit at dismiss**: uncommitted work is left in the checkout, which is kept. `core/worktree.ts` `release` therefore is never called with `done` for a participant — **M6-0 settled the non-committing path (2026-09-21, #144): `release` takes a `ReleaseAction` (`"commit" \| "keep"`), `RELEASES` moved to `core/run.ts`, and a room always passes `"keep"`.** A participant that never commits has nothing for R31 to merge, which is visible and is its own fault |
| R38 | Participant watchdog | (a) none, as the spike (b) idle and repeat **warn only**, no TTL (c) the full run watchdog including `ttlMs` | **Decided 2026-09-20:** (b). A silent agent must stay visible, so `_client_stall_warning` is emitted and M4-2's badge and M4-4's bell have an event to read. `ttlMs` takes no part: a chat turn must not be killed by a clock, and there is no deliverable a timeout would protect |
| R39 | Result contract in a room | (a) rooms use the run contract (b) rooms use none of it | **Decided 2026-09-20:** (b), restating `core/room.ts`'s own scope note so it is not re-opened. No `RESULT_PREAMBLE` on a room prompt, no `extractResult`, no `crossCheck`, no `_client_result_warning`. A room turn is conversation, not a deliverable |
| R40 | Global live-harness cap | (a) a daemon-wide cap, refuse at the limit (b) a daemon-wide cap, queue at the limit (c) none in v1 | **Decided 2026-09-20:** (c). `runs + Σ(busy participants)` across every room is unbounded, with the default mode `auto`. Recorded as a backlog item with a trigger in `STORIES.md` and as a `ponytail:` comment where the room runtime spawns a harness (M6-0), not built. This is the one accepted risk in the room model that is about resources rather than correctness |
| R41 | Turn-queue bound and overflow | (a) bound 16, refuse with `429` (b) unbounded | **Decided 2026-09-20:** (a). Sixteen messages queued to one agent already means the human should stop typing. The queue is in memory and is **lost at a daemon restart** (R42), which the API documents rather than hides |
| R42 | What a restart leaves | (a) re-spawn a participant with a fresh session, context lost (b) nothing until S3(c) (c) a shutdown is a pause, not a close | **Decided 2026-09-20:** (b). A restored room is read-only: every participant reads `exited`, its history replays and its branch and checkout survive, but it cannot be messaged or revived until S3(c) lands `session/load`. M6-7 says this in its *Done when* rather than implying the roster is usable. **Re-opened 2026-09-21 (#144):** the owner wants a reboot to be resumable — idle agents with uncommitted work, restart, keep talking. That makes a daemon shutdown a pause, not the `close()` it calls today. **Decided 2026-09-21 (#145): (c), a new option — a shutdown is a pause, not a close.** `dismiss` stays the person's verb; a daemon shutdown stops each harness and leaves the room `paused`, with roster, branch, checkout and history intact. A participant revives on its next message: `session/load` where the harness advertises it, otherwise a **fresh session with the loss reported** in the DTO (`resumed: "loaded" \| "fresh"`). That subsumes (a) without its silent amnesia, and keeps S3(c) an upgrade that changes a label rather than the API. The work splits: **Half A**, revive with a fresh session, is M6-7 and needs no probe; **Half B**, `session/load`, stays deferred with S3(c) |

### Spike integration and API decisions — revised

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| S1 | How to land the spike | (a) rebase both commits onto master, resolve toward current M2 (b) cherry-pick the runtime files, rewrite the daemon integration (c) merge master into the branch, then land | **Decided (interview):** (a). **Amended 2026-09-20:** the port is **M6-0 and comes first**, not last. The branches are 13 commits behind and every story placed in front of the rebase makes it larger; nothing about the rebase gets cheaper by waiting for the room model, because the single-participant runtime it carries is already settled (P1–P9). It ships behind `chat.ts`, marked experimental, with no new features. **Landed 2026-09-21 (#144):** only the `chat-mvp` commit. `spike/chat-tui` is left unrebased for M4-1, which ratifies pi-tui and rebases it as its first step — rebasing it here too would be the same work done twice |
| S2 | Participant mode default | (a) keep `auto` for v1 (b) mode at add, default `ask` for a TUI (c) per-message override | **Decided (interview):** mode per participant at add, default `auto`; `ask`/`safe` selectable |
| S3 | Restart and resume | (a) ephemeral rooms, history replay only (b) persist metadata, restore read-only (c) restore + per-participant `session/load` | **Decided (interview):** (b) now; (c) later. **Amended 2026-09-21 (#145):** (b) keeps its place and changes its meaning — it read *restore read-only*, and now reads **restore and revive with a fresh session** (R42). (c) is still `session/load` and still later, now also gated on a measurement nobody has taken: every `loadSession: true` we hold is a handshake claim (`docs/M0-FINDINGS.md:136`), never a session loaded into a **new** harness process |
| S4 | Room and participant records | (a) events are the only record (b) `room.json` + participant records, turns derived from events (c) a file per turn | **Decided (interview):** (b). **Amended 2026-09-21 (#145):** the participant record carries the harness `sessionId` from its first version (R17) |
| S5 | Cancel one turn | (a) `POST /rooms/:id/agents/:agentId/turns/current/cancel` (b) `DELETE .../messages/current` (c) keep room dismiss only | **Decided (interview):** (a) |
| S6 | Room dismiss response | (a) synchronous 200 once every participant has stopped and its checkout is released per R37 (b) 202 like a run cancel (c) 204 | **Decided (interview), corrected 2026-09-21:** (a). The option's old wording said "commits/releases, as the spike", which R37 forbids: nothing is committed, the checkout is kept. **The bound needs participants stopped in parallel**, not one after another: `stop()` waits up to `stopGraceMs` (5 s) for a harness that ignores end of file, so a serial dismiss of N participants bounds at 5N seconds — half a minute of a hanging request on a room of six. Parallel makes the documented bound `stopGraceMs` + overhead, a number that can actually be written down. **Renamed 2026-09-21 (#145):** this is the **dismiss** response — `POST /rooms/:id/dismiss` — and the same parallel bound covers `pause`, which runs the same `teardown()` (R18) |
| S7 | Command surface | (a) `chat.ts` standalone, add `kapelle chat` that runs it (b) move verbs into `cli.ts` (c) retire `chat.ts` | **Decided (interview):** (a) |
| S8 | Shared client and chat | (a) `client/` owns DTOs, HTTP, SSE, reducer; `chat.ts` imports `client/` only (b) chat keeps its own client (c) put the client under `protocol/` | **Decided (interview):** (a); the import-boundary test allows `client/` and pi-tui, forbids `core/`, `protocol/` and `daemon.ts` |
| S9 | Room and participant ids | (a) reuse `newRunId()` for rooms, opaque ids for participants (b) a distinct room prefix (c) uuid for both | **Decided (interview):** (b): a new `newRoomId()`, never the run id; participant ids opaque. **Built in M6-0, not M6-2 (2026-09-21, #144):** `newRoomId()` plus a private `assertOwnerId` that `branchName` validates with; `assertRunId` still rejects a room id |
| S10 | Event identity | (a) `agent` is the participant name, room from the URL (b) add `roomId` + `participantId` to every room event (c) `agent` is the room id | **Decided (interview):** (b). Room log/SSE line: `{seq, roomId, participantId, update}`; run lines stay `{seq, agent, update}` with `agent` as the task id |
| S11 | Stream end on room dismiss | (a) close closes the log and the stream ends, as the spike (b) final event then end (c) reopen read-only | **Decided (interview):** (a) now: close ends the log and every stream, and a client reconciles with `GET /rooms/:id` (dismissed vs 404). Additive follow-up: `_client_room_closed {reason}` with `dismissed`, `deleted` or `shutdown`, emitted before the log closes, when a second observer must distinguish a deliberate dismiss from a cut. **Corrected 2026-09-21 (#145):** `shutdown` is **not** one of those reasons. Under R42 a shutdown does not close the room — the stream ends because the process died, not because the log closed. A client reconciles with `GET /rooms/:id`: `paused`, `dismissed`, or 404. The additive event keeps `dismissed` and `deleted` |
| S12 | Permission scoping | (a) extend `PendingDecision` with `roomId` + `participantId` + `turn` (b) a separate room queue (c) keep rooms `auto` only | **Decided (interview):** (a): `PendingDecision` gains `roomId`, `participantId` and `turn` alongside `runId`/`taskId`; same queue, same first-writer-wins |
| S13 | Creation status | room `201 {room}`; participant add `201 {participant}`; both wait for the session | **Decided (interview):** yes; a harness that cannot start is a request error, not a dead participant |
| S14 | `children.json` | (a) reuse `{pid, runId, taskId}` with the room id in `runId` and the participant in `taskId` (b) rename to `ownerId` (c) a separate file | **Decided (interview):** (b): entries become `{pid, kind, ownerId, unitId, startedAt?}` with `kind` as `run` or `room`; the sweep reads legacy `{pid, runId, taskId}` as a run. **Built in M6-0 (2026-09-21, #144)**, with one `trackChildren` listener for both owners |

### Room vocabulary and record sketch (M6-1, 2026-09-21, #145)

Deliberately short. The routes are not restated here: R9(a) fixes them as nested, and the
M6-2..M6-5 story bodies name them. What follows is the **check** that the decided rows can
actually be drawn as a record — if they could not, M6-2 would find out the expensive way.

| Verb | Trigger | Room after | Harness | Work on disk |
| --- | --- | --- | --- | --- |
| dismiss | a person | `dismissed`, final | stopped | branch + checkout kept |
| delete | a person | gone | stopped | per retention |
| pause | the machine (SIGTERM, reboot) | `paused` | stopped | branch + checkout kept |
| resume | the next message to a paused or exited participant | `active` | respawned in its own worktree | untouched |

```text
room.json         id, cwd, title, base, createdAt, updatedAt, status
                  status: active | paused | dismissed
participant       id, name, harness, mode, purpose, settings,
                  branch, worktree, baseSha,
                  sessionId, resumed?: "loaded" | "fresh",
                  status: idle | busy | exited | paused | dismissed
room list         [{id, cwd, title, status, updatedAt,
                    participants: [{id, name, status}]}]      (R9)
room detail       the room fields above + every participant in full
```

`sessionId` is written from the first version even though nothing loads it yet — the M2-6
precedent (`docs/STORIES.md:1800`): one field now, or a migration when Half B lands.
`resumed` is absent until the participant has been revived; it is how a client tells a
participant that kept its memory from one that did not.

**Naming trap for M6-7.** `core/room.ts` already has an inner closure named `shutdown`
that means *dismiss*, returned as `close()`, while `shutdown` in `daemon.ts` means the
process dying. Same word, opposite meanings, one import apart. M6-2 renames: `close()`
becomes `dismiss()`, the shared body becomes `teardown()` — cancel the live turn, stop the
harness, release the worktree with `"keep"`, close the log — and M6-7 adds `pause()` and
`resume()` on top of it. Dismiss leaves the log closed for good, while pause must leave the
history replayable and the log appendable after a restart — so M6-7 also owns an append-mode
writable reopen. `core/eventlog.ts` opens a new log with `flags: "w"` (truncate), its
`openEventLog` is read-only on purpose, and that reader's `append()` is a no-op today. The reopen must also carry `seq` on from
the log's existing line count: `createEventLog` counts from 0 (`core/eventlog.ts:65`), so a
plain append-mode open would write a second `seq 1` and break `Last-Event-ID` resume.

### Testing and release

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| M1 | Conformance harness | real daemon + `mock-agent` + minimal mock client | confirm |
| M2 | Fixtures | golden DTO JSON in `tests/contract/fixtures/` | confirm |
| M3 | Browser visual checks in CI | (a) no (b) yes headless | (a) |
| M4 | M5 done-when | a client written from the doc alone passes the suite | confirm |
| M5 | Docs to update | README, CLAUDE.md, PROJECT-PLAN, STORIES, CONFIG, this file | confirm the list |
| M6 | Shared module visibility | (a) internal module (b) exported package | (a), `private: true` stays |

## What this plan deliberately leaves alone

- The bus keeps carrying the raw wire object, `_meta` included (#62 B4).
- `core/` keeps importing `protocol/` only; `client/` is an edge module the daemon may
  import, and `core/` may not.
- The loopback bind, the Host guard, the single operator token, and the sandboxing
  trigger stay exactly as M2-1/M2-8 left them.
- The event log stays raw and append-only; timestamps and the terminal event are the
  only proposed additions, and both are additive.
- `chat.ts` stays a front end: HTTP, `client/`, and pi-tui once M4-1 lands. It never
  imports `core/run.ts` or `core/room.ts`.
- pi-tui stays a presentation dependency. No protocol, permission or path decision may
  read it.
- Rooms stay a separate resource from runs. A room does not replace `POST /runs`, and a
  run does not become a room. Participants are independent long-lived sessions inside a
  room — not runs, and not nodes in a graph.

## Risks

- **The room model has no graph, so the daemon cannot sequence work.** Sequencing is the
  human's job (or a bridge's); the API only routes messages and enforces the
  per-participant busy rule (R32). If a task needs several agents, the client composes
  the context (R34) and the merge story lands their branches (R31).
- **Independent worktrees mean agents do not see each other's changes.** That is the
  price of no dependencies; collaboration on one file needs the human to route and merge,
  and `kapelle merge` must handle N branches with conflicts (R31).
- **Chained bases (R35c) make the merge preflight wrong until M6-6 fixes it.**
  `core/merge.ts` measures every branch's diff from its own `baseSha` and assumes one base
  per run, so two participants on different bases can pass the overlap check and still have
  the squash replay the parent's work. This is the only new, untested git logic the room
  model needs. Fallback if it resists: R35(a) for v1, chained bases with R35(d).
- **Nothing caps the live harness count (R40).** `runs + Σ(busy participants)` across every
  room, all defaulting to `auto`. Accepted for v1 with a trigger in `STORIES.md`'s backlog,
  not built.
- **The spike is stale, and that is why it goes first.** It predates M2-3 and M2-8 in
  particular, so its daemon patch must be re-derived, not applied. Budget the rebase as
  real work (S1) — and do it as **M6-0**, before M5 and the room container, because the
  cost grows with every story placed in front of it. **Discharged 2026-09-21 (#144):**
  the daemon patch was re-derived against M2-3, M2-6, M2-7, M2-8 and #129, and the suite
  is green. What remains stale is `spike/chat-tui`, one commit, waiting for M4-1.
- **The room model is a container of independent agents, not a task DAG.** The roster
  work starts from the retired R24–R30 decisions; the open decisions that shape it are
  R32–R36 (busy queue, availability, cross-agent context, workspace base, room topic).
- **Orchestration touches the charter.** The brief's non-goals say "not agent-to-agent
  messaging"; a coordinator that delegates to other participants must be
  supervisor-mediated (the daemon injects results, as M3-3 does) or the brief needs an
  explicit amendment. R2 decides which.
- **Two client implementations exist today** (`cli.ts`/`attach` and `chat.ts`). Without
  M5-10 they drift; the spike's import test is the only thing keeping the boundary
  honest.
- **Serialising the internal state was cheap and the DTO is not.** The mapper is real
  code that must not drift from `RunState`.
- **The room model is a product decision.** R1–R4 decided the milestone and are answered;
  R5 is retired, because rooms have no dependency graph and every participant simply owns
  a worktree and branch (R14, R35).
- **Backpressure can change run pacing.** Pausing an event log reader must not pause the
  run; the seam has to be per-reader or the run pays for the slowest watcher.
- **Two clients answering one permission already have a rule (first writer wins); the
  answered event is what makes the rule visible.** Without it, M4-3's acceptance test
  cannot be written honestly for a second observer.
