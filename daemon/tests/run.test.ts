/**
 * Run route commands, called directly — `daemon/run.ts`.
 * `tests/daemon-runs.test.ts` covers the same routes over real sockets.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RunState } from "../dto.ts";
import { Refusal } from "../http.ts";
import { cancelRun } from "../run.ts";

test("cancelRun refuses a terminal run while its canceller awaits final cleanup", () => {
  // This is the exact onFinished/finally window: GET can already return done,
  // but final cleanup has not removed the controller from `cancels` yet.
  const state: RunState = {
    id: "r1",
    cwd: "/repo",
    root: "/repo",
    status: "done",
    source: "live",
    endedAt: "2026-11-03T00:00:00.000Z",
    notices: [],
    tasks: [],
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
