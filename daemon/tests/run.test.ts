/**
 * Run route commands, called directly — `daemon/run.ts`.
 * `tests/daemon-runs.test.ts` covers the same routes over real sockets.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RunState } from "../dto.ts";
import { Refusal } from "../http.ts";
import { cancelRun } from "../run.ts";

function runState(status: RunState["status"]): RunState {
  return {
    id: "r1",
    cwd: "/repo",
    root: "/repo",
    status,
    source: "live",
    notices: [],
    tasks: [],
  };
}

test("cancelRun refuses a terminal run while its canceller awaits final cleanup", () => {
  // This is the exact onFinished/finally window: GET can already return done,
  // but final cleanup has not removed the controller from `cancels` yet.
  const state: RunState = {
    ...runState("done"),
    endedAt: "2026-11-03T00:00:00.000Z",
  };
  const canceller = new AbortController();

  assert.throws(
    () => cancelRun(state.id, state, canceller),
    (err) => {
      assert.ok(err instanceof Refusal);
      assert.equal(err.status, 409);
      assert.equal(err.code, "run_ended");
      return true;
    },
  );
  assert.equal(canceller.signal.aborted, false);
  assert.equal(state.cancelRequested, undefined);
});

test("cancelRun aborts a live run and marks cancellation requested", () => {
  const state = runState("running");
  const canceller = new AbortController();

  assert.equal(cancelRun(state.id, state, canceller), state);
  assert.equal(canceller.signal.aborted, true);
  assert.equal(canceller.signal.reason, "cancel");
  assert.equal(state.cancelRequested, true);
});

test("cancelRun refuses an unknown run", () => {
  assert.throws(
    () => cancelRun("missing", undefined, undefined),
    (err) => {
      assert.ok(err instanceof Refusal);
      assert.equal(err.status, 404);
      assert.equal(err.code, "run_not_found");
      return true;
    },
  );
});

test("cancelRun does not call a running run ended when its canceller is absent", () => {
  const state = runState("running");

  assert.throws(
    () => cancelRun(state.id, state, undefined),
    (err) => {
      assert.ok(err instanceof Refusal);
      assert.equal(err.status, 409);
      assert.equal(err.code, "run_ended");
      assert.equal(err.message, "run r1 is not cancellable");
      return true;
    },
  );
  assert.equal(state.cancelRequested, undefined);
});
