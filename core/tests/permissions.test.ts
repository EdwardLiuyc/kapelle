/**
 * M2-3, issue #33 — the pending-decision queue, with no daemon and no harness.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentEventEnvelope,
  PolicyRequest,
} from "../../protocol/agent.ts";
import type { ToolKind } from "../../protocol/types.ts";
import { createEventBus } from "../events.ts";
import { createPermissionQueue } from "../permissions.ts";

const req = (kind: ToolKind): PolicyRequest => ({
  agent: "task-a",
  toolCall: { title: `do ${kind}`, kind },
  options: [],
});

function setup(timeoutMs = 60_000) {
  const queue = createPermissionQueue(timeoutMs);
  const bus = createEventBus();
  const events: AgentEventEnvelope[] = [];
  bus.addListener((e) => events.push(e));
  const cancel = new AbortController();
  const policy = queue.policyFor("run-1", bus, cancel.signal);
  return { queue, events, cancel, policy };
}

test("a read-only kind is approved without queueing", async () => {
  const { queue, events, policy } = setup();
  assert.equal(await policy(req("read")), true);
  assert.deepEqual(queue.list(), []);
  assert.deepEqual(events, []);
});

test("a mutation waits, is listed and announced with its id, and the first answer wins", async () => {
  const { queue, events, policy } = setup();
  const decided = policy(req("edit"));

  const [pending] = queue.list();
  assert.ok(pending);
  assert.deepEqual(
    { ...pending, id: "" },
    {
      id: "",
      runId: "run-1",
      taskId: "task-a",
      kind: "edit",
      title: "do edit",
    },
  );
  assert.deepEqual(events[0], {
    agent: "task-a",
    update: {
      sessionUpdate: "_client_permission_queued",
      id: pending.id,
      kind: "edit",
      title: "do edit",
    },
  });

  assert.equal(queue.answer(pending.id, true), "ok");
  assert.equal(await decided, true);
  assert.equal(queue.answer(pending.id, false), "settled");
  assert.deepEqual(queue.list(), []);
  assert.equal(queue.answer("nope", true), "unknown");
});

test("nobody answers: the timeout denies, and a late answer is settled", async () => {
  const { queue, policy } = setup(20);
  const decided = policy(req("execute"));
  const [pending] = queue.list();
  assert.ok(pending);
  assert.equal(await decided, false);
  assert.equal(queue.answer(pending.id, true), "settled");
});

test("cancelling the run denies what it has open, and anything it asks after", async () => {
  const { queue, cancel, policy } = setup();
  const decided = policy(req("edit"));
  cancel.abort();
  assert.equal(await decided, false);
  assert.deepEqual(queue.list(), []);
  assert.equal(await policy(req("edit")), false);
  assert.deepEqual(queue.list(), []);
});
