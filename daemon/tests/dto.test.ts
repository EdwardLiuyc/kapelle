/**
 * The daemon's wire shapes, called directly — `daemon/dto.ts`.
 *
 * `tests/contract/run-dto.test.ts` proves the same promise end to end, through
 * a real daemon. This file proves the edge cases that are slow to stage that
 * way: a hand-edited `run.json` with junk in every field, a live report, and
 * permission or config core objects, each carrying fields the contract never
 * names.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { projectConfigView } from "../../core/config.ts";
import type {
  PendingDecision as CorePendingDecision,
  SettledDecision as CoreSettledDecision,
} from "../../core/permissions.ts";
import type { RunReport } from "../../core/run.ts";
import {
  type RunState,
  toConfigView,
  toPendingDecision,
  toPermissionDecision,
  toRunDto,
  toRunListEntry,
  toTaskDto,
} from "../dto.ts";

test("toTaskDto keeps contract fields with the contract's types", () => {
  const dto = toTaskDto({
    id: "t1",
    status: "done",
    agent: "opencode",
    branch: "kapelle/r/t1",
    durationMs: 1200,
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, _meta: { a: 1 } },
    usageSemantics: "per-turn",
    warnings: [{ kind: "k", text: "t" }],
    summarySynthesised: true,
  } as { id: string; status: string });
  assert.deepEqual(dto, {
    id: "t1",
    status: "done",
    agent: "opencode",
    branch: "kapelle/r/t1",
    durationMs: 1200,
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, _meta: { a: 1 } },
    usageSemantics: "per-turn",
    warnings: [{ kind: "k", text: "t" }],
    summarySynthesised: true,
  });
});

test("toTaskDto drops unknown keys and wrong-typed values, never nulls", () => {
  const dto = toTaskDto({
    id: "t1",
    status: "failed",
    transcript: "prose the wire must not carry",
    agent: 5,
    durationMs: Number.NaN,
    usageSemantics: "made-up",
    warnings: 5,
    summarySynthesised: "yes",
  } as { id: string; status: string });
  assert.deepEqual(dto, { id: "t1", status: "failed" });
});

test("toTaskDto rebuilds usage key by key", () => {
  const partial = toTaskDto({
    id: "t",
    status: "done",
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: "3" },
  } as { id: string; status: string });
  assert.equal(partial.usage, undefined, "a required number missing");

  const extra = toTaskDto({
    id: "t",
    status: "done",
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      thoughtTokens: 4,
      cachedReadTokens: "5",
      evil: true,
      _meta: [],
    },
  } as { id: string; status: string });
  assert.deepEqual(extra.usage, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    thoughtTokens: 4,
  });
});

test("toTaskDto keeps only {kind, text} warnings, and omits an empty list", () => {
  const some = toTaskDto({
    id: "t",
    status: "warned",
    warnings: [null, { kind: "k" }, { kind: "k", text: "t", extra: 1 }],
  } as { id: string; status: string });
  assert.deepEqual(some.warnings, [{ kind: "k", text: "t" }]);

  const none = toTaskDto({
    id: "t",
    status: "warned",
    warnings: [null, 5],
  } as { id: string; status: string });
  assert.equal("warnings" in none, false);
});

const restored: RunState = {
  id: "r1",
  cwd: "/repo/sub",
  root: "/repo",
  status: "done",
  source: "restored",
  notices: [],
  tasks: [{ id: "t1", status: "done", agent: "pi" }],
};

test("toRunDto on a restored run serves the record's tasks, gaps omitted", () => {
  assert.deepEqual(toRunDto(restored), {
    id: "r1",
    cwd: "/repo/sub",
    root: "/repo",
    status: "done",
    source: "restored",
    notices: [],
    tasks: [{ id: "t1", status: "done", agent: "pi" }],
  });
});

test("toRunDto flattens a live report and keeps the transcript off the wire", () => {
  const report = {
    status: "done",
    durationMs: 50,
    turns: 1,
    tasks: [
      {
        id: "t1",
        status: "done",
        agent: "pi",
        cwd: "/repo",
        durationMs: 40,
        transcript: "secret prose",
      },
    ],
  } as unknown as RunReport;
  const dto = toRunDto({
    ...restored,
    source: "live",
    startedAt: "2026-09-23T00:00:00.000Z",
    endedAt: "2026-09-23T00:00:01.000Z",
    report,
    cancelRequested: true,
  });
  assert.equal(dto.durationMs, 50);
  assert.equal(dto.turns, 1);
  assert.equal(dto.cancelRequested, true);
  assert.equal("report" in dto, false);
  assert.deepEqual(dto.tasks, [
    { id: "t1", status: "done", agent: "pi", durationMs: 40 },
  ]);
});

test("toRunListEntry carries id and status per task, and no notices", () => {
  const entry = toRunListEntry({
    ...restored,
    notices: [{ taskId: "t1", text: "n" }],
    startedAt: "2026-09-23T00:00:00.000Z",
  });
  assert.deepEqual(entry, {
    id: "r1",
    cwd: "/repo/sub",
    root: "/repo",
    status: "done",
    source: "restored",
    startedAt: "2026-09-23T00:00:00.000Z",
    tasks: [{ id: "t1", status: "done" }],
  });
});

test("toPendingDecision keeps both askers, copies input, and drops unknown fields", () => {
  const runDecision = {
    id: "p1",
    runId: "r1",
    taskId: "t1",
    kind: "edit",
    title: "Edit notes.md",
    input: { path: "notes.md" },
    diff: {
      text: "diff --git a/notes.md b/notes.md",
      files: 1,
      added: 1,
      removed: 0,
      secret: "nested",
    },
    secret: "top",
  } as unknown as CorePendingDecision;
  const dto = toPendingDecision(runDecision);
  assert.deepEqual(dto, {
    id: "p1",
    runId: "r1",
    taskId: "t1",
    kind: "edit",
    title: "Edit notes.md",
    input: { path: "notes.md" },
    diff: {
      text: "diff --git a/notes.md b/notes.md",
      files: 1,
      added: 1,
      removed: 0,
    },
  });
  assert.notEqual(dto.input, runDecision.input);

  const roomDecision = {
    id: "p2",
    roomId: "room-1",
    participantId: "participant-1",
    turn: 2,
    kind: "execute",
    title: "Run tests",
    secret: "top",
  } as unknown as CorePendingDecision;
  assert.deepEqual(toPendingDecision(roomDecision), {
    id: "p2",
    roomId: "room-1",
    participantId: "participant-1",
    turn: 2,
    kind: "execute",
    title: "Run tests",
  });
});

test("toPermissionDecision adds an answer only for a settled decision", () => {
  const open = {
    id: "p1",
    runId: "r1",
    taskId: "t1",
    kind: "edit",
    title: "Edit notes.md",
    diff: { text: "diff", files: 1, added: 1, removed: 0, secret: true },
    secret: "top",
  } as unknown as CorePendingDecision;
  assert.deepEqual(toPermissionDecision(open), {
    id: "p1",
    runId: "r1",
    taskId: "t1",
    kind: "edit",
    title: "Edit notes.md",
    diff: { text: "diff", files: 1, added: 1, removed: 0 },
  });

  const settled = {
    ...open,
    allow: false,
    reason: "timeout",
  } as unknown as CoreSettledDecision;
  assert.deepEqual(toPermissionDecision(settled), {
    id: "p1",
    runId: "r1",
    taskId: "t1",
    kind: "edit",
    title: "Edit notes.md",
    diff: { text: "diff", files: 1, added: 1, removed: 0 },
    allow: false,
    reason: "timeout",
  });
});

test("toConfigView copies every row, its array values, and drops unknown fields", () => {
  const view = {
    path: "/repo/.kapelle/config.json",
    rows: [
      {
        key: "ttlMs",
        value: 5,
        source: "env",
        default: 3,
        file: 4,
        env: "KAPELLE_TTL_MS",
        secret: "nested",
      },
      {
        key: "linkPaths",
        value: ["node_modules"],
        source: "config",
        default: [],
        file: ["node_modules"],
      },
    ],
    invalid: "bad file",
    secret: "top",
  } as unknown as ReturnType<typeof projectConfigView>;
  const dto = toConfigView("/repo", view);
  assert.deepEqual(dto, {
    root: "/repo",
    path: "/repo/.kapelle/config.json",
    rows: [
      {
        key: "ttlMs",
        value: 5,
        source: "env",
        default: 3,
        file: 4,
        env: "KAPELLE_TTL_MS",
      },
      {
        key: "linkPaths",
        value: ["node_modules"],
        source: "config",
        default: [],
        file: ["node_modules"],
      },
    ],
    invalid: "bad file",
  });

  const sourceRow = view.rows[1];
  const dtoRow = dto.rows[1];
  assert.ok(sourceRow && dtoRow);
  assert.notEqual(dtoRow.value, sourceRow.value);
  assert.notEqual(dtoRow.default, sourceRow.default);
  assert.notEqual(dtoRow.file, sourceRow.file);

  const withoutInvalid = toConfigView("/repo", { ...view, invalid: undefined });
  assert.equal("invalid" in withoutInvalid, false);
});
