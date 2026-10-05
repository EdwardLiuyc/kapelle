/**
 * M2-3, issue #33 — the pending-decision queue, with no daemon and no harness.
 */

import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { tempDir } from "../../integration/helpers.ts";
import type {
  AgentEventEnvelope,
  PolicyRequest,
} from "../../protocol/agent.ts";
import type { ToolKind } from "../../protocol/types.ts";
import { createEventBus } from "../events.ts";
import { capInput, createPermissionQueue } from "../permissions.ts";

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
  return { queue, events, bus, cancel, policy };
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

// --- M5-4, #136: every settle path says which question it closed and why ----

/** The one `_client_permission_answered` the queue emitted, and `get`'s view. */
function closed(
  events: AgentEventEnvelope[],
  queue: ReturnType<typeof createPermissionQueue>,
  id: string,
) {
  const answered = events.filter(
    (e) => e.update.sessionUpdate === "_client_permission_answered",
  );
  assert.equal(answered.length, 1, "one answered event per queued id");
  return { event: answered[0], got: queue.get(id) };
}

test("each settle path emits the answered event with its reason, and get returns it", async () => {
  // `denyTask` and a run-end abort have no other test; the rest run through
  // the same `settle` with a different reason.
  const paths: [
    string,
    boolean,
    (s: ReturnType<typeof setup>, id: string) => unknown,
  ][] = [
    ["client", true, ({ queue }, id) => queue.answer(id, true)],
    ["timeout", false, () => {}],
    ["cancel", false, ({ cancel }) => cancel.abort("cancel")],
    ["task_end", false, ({ queue }) => queue.denyTask("run-1", "task-a")],
    ["run_end", false, ({ cancel }) => cancel.abort("run_end")],
  ];
  for (const [reason, allow, close] of paths) {
    const s = setup(reason === "timeout" ? 20 : 60_000);
    const decided = s.policy(req("edit"));
    const [pending] = s.queue.list();
    assert.ok(pending);
    assert.deepEqual(s.queue.get(pending.id), pending, "open: as listed");

    close(s, pending.id);
    assert.equal(await decided, allow);
    const { event, got } = closed(s.events, s.queue, pending.id);
    assert.deepEqual(event, {
      agent: "task-a",
      update: {
        sessionUpdate: "_client_permission_answered",
        id: pending.id,
        allow,
        reason,
      },
    });
    assert.deepEqual(got, { ...pending, allow, reason });
  }
});

test("an abort with no reason reads as cancel, and denyTask spares other tasks", async () => {
  const { queue, events, cancel, policy } = setup();
  const mine = policy(req("edit"));
  const other = policy({ ...req("edit"), agent: "task-b" });
  const [a, b] = queue.list();
  assert.ok(a && b);

  queue.denyTask("run-1", "task-b");
  assert.equal(await other, false);
  assert.deepEqual(queue.list(), [a]);

  cancel.abort();
  assert.equal(await mine, false);
  assert.deepEqual(queue.get(a.id), { ...a, allow: false, reason: "cancel" });
  assert.deepEqual(queue.get(b.id), { ...b, allow: false, reason: "task_end" });
  assert.equal(queue.get("nope"), undefined);
  // A settled id answers once: a late answer emits nothing more.
  assert.equal(queue.answer(a.id, true), "settled");
  assert.equal(
    events.filter(
      (e) => e.update.sessionUpdate === "_client_permission_answered",
    ).length,
    2,
  );
});

test("a client answer wins over an in-flight timeout, and emits once", async () => {
  const { queue, events, policy } = setup(20);
  const decided = policy(req("edit"));
  const [pending] = queue.list();
  assert.ok(pending);

  assert.equal(queue.answer(pending.id, true), "ok");
  assert.equal(await decided, true);
  // Well past the timer: a timer that was not cleared would emit again here.
  await new Promise((resolve) => setTimeout(resolve, 60));

  const answered = events.filter(
    (e) => e.update.sessionUpdate === "_client_permission_answered",
  );
  assert.equal(answered.length, 1, "one answered event per queued id");
  assert.deepEqual(queue.get(pending.id), {
    ...pending,
    allow: true,
    reason: "client",
  });
});

test("a late abort or denyTask after a client answer adds nothing", async () => {
  const { queue, events, cancel, policy } = setup();
  const decided = policy(req("edit"));
  const [pending] = queue.list();
  assert.ok(pending);

  assert.equal(queue.answer(pending.id, false), "ok");
  assert.equal(await decided, false);

  // Both deniers would settle the id a second time if the queue had not
  // removed the abort listener and deleted the entry.
  cancel.abort("cancel");
  queue.denyTask("run-1", "task-a");

  const answered = events.filter(
    (e) => e.update.sessionUpdate === "_client_permission_answered",
  );
  assert.equal(answered.length, 1, "only the client close emitted");
  assert.deepEqual(queue.get(pending.id), {
    ...pending,
    allow: false,
    reason: "client",
  });
});

test("a question carries the tool's input as text, cut to stay under 4 KB", () => {
  assert.equal(capInput(undefined), undefined);
  assert.equal(capInput({}), undefined);
  assert.deepEqual(capInput({ path: "a.ts", n: 2, list: ["x"] }), {
    path: "a.ts",
    n: "2",
    list: '["x"]',
  });
  // A harness's `__proto__` key stays a plain field, not the prototype.
  assert.deepEqual(
    capInput(JSON.parse('{"__proto__":"x"}')),
    JSON.parse('{"__proto__":"x"}'),
  );
  // A value with no JSON is still text, never a throw.
  assert.deepEqual(capInput({ f: () => 1, n: 1n, s: Symbol("s") }), {
    f: "() => 1",
    n: "1",
    s: "Symbol(s)",
  });
  const big = capInput({ file_text: "x".repeat(10_000) });
  assert.equal(big?.file_text?.length, 400);
  assert.ok(big?.file_text?.endsWith("…"));
  const many = capInput(
    Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `${"k".repeat(100)}${i}`,
        "v".repeat(1000),
      ]),
    ),
  );
  assert.equal(Object.keys(many ?? {}).length, 8);
  assert.ok(JSON.stringify(many).length < 4096);
});

test("an escape-heavy input is still capped at 4 KB of JSON", () => {
  const quoted = capInput(
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`k${i}`, '"'.repeat(400)]),
    ),
  );
  assert.ok(quoted);
  assert.ok(Object.keys(quoted).length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(quoted), "utf8") <= 4096);

  const control = capInput(
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`k${i}`, "\u0000".repeat(400)]),
    ),
  );
  assert.ok(control);
  assert.ok(Object.keys(control).length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(control), "utf8") <= 4096);
});

test("a question about an edit carries its diff, built only once it waits for a person", async () => {
  const { queue, events, bus, cancel, policy } = setup();
  const edit: PolicyRequest = {
    agent: "task-a",
    toolCall: {
      title: "Write x.md",
      kind: "edit",
      edits: [{ abs: "/nowhere/x.md", path: "x.md", newText: "hi\n" }],
    },
    options: [],
  };
  // The diff is built off the call stack: the question appears once it is.
  const appeared = new Promise<void>((ok) =>
    bus.addListener((e) => {
      if (e.update.sessionUpdate === "_client_permission_queued") ok();
    }),
  );
  const decided = policy(edit);
  await appeared;
  const [pending] = queue.list();
  assert.ok(pending?.diff);
  assert.deepEqual(
    { ...pending.diff, text: "" },
    { text: "", files: 1, added: 1, removed: 0 },
  );
  assert.match(
    pending.diff.text,
    /^diff --git a\/x\.md b\/x\.md\nnew file mode/,
  );
  const queued = events[0]?.update as { diff?: unknown };
  assert.deepEqual(queued.diff, pending.diff);

  // A cancel while the diff builds still denies, and queues nothing.
  const late = policy(edit);
  cancel.abort();
  assert.equal(await late, false);
  assert.equal(await decided, false);
  assert.deepEqual(queue.list(), []);
});

test("a question whose diff path escapes the temp folder writes nothing before the answer", async (t) => {
  const dir = await tempDir(t);
  const victim = join(dir, "victim.txt");
  await writeFile(victim, "VICTIM\n");
  const link = join(
    tmpdir(),
    `kapelle-perm-escape-${process.pid}-${Date.now()}`,
  );
  await symlink(victim, link);
  t.after(() => rm(link, { force: true }));
  // The target a symlink outside the root produces: the real path is inside
  // the workspace, so the guard accepts it, but the relative path has to
  // climb back down to the link. The diff builder must refuse that write.
  const placeholder = join(tmpdir(), "kapelle-diff-placeholder", "0");
  const escaped = join("..", relative(placeholder, link));
  const { queue, bus, cancel, policy } = setup();
  const edit: PolicyRequest = {
    agent: "task-a",
    toolCall: {
      title: "Write outside",
      kind: "edit",
      edits: [{ abs: link, path: escaped, newText: "NEW\n" }],
    },
    options: [],
  };
  const appeared = new Promise<void>((ok) =>
    bus.addListener((e) => {
      if (e.update.sessionUpdate === "_client_permission_queued") ok();
    }),
  );
  const decided = policy(edit);
  await appeared;
  assert.equal(queue.list()[0]?.diff, undefined);
  cancel.abort();
  assert.equal(await decided, false);
  assert.equal(await readFile(victim, "utf8"), "VICTIM\n");
});
