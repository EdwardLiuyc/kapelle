/**
 * Run commands for the daemon's HTTP routes, split from `daemon.ts` so their
 * state-ordering rules can be tested without booting a server.
 */

import type { RunState } from "./dto.ts";
import { refusal } from "./http.ts";

/** Cancel a live run and return the state for the 202 reply. The public
 *  status decides whether it ended; final cleanup may retain the controller. */
export function cancelRun(
  id: string,
  state: RunState | undefined,
  canceller: AbortController | undefined,
): RunState {
  if (!state) {
    throw refusal(404, "run_not_found", `no run ${id}`);
  }
  if (state.status !== "running" || !canceller) {
    throw refusal(409, "run_ended", `run ${id} already ended: ${state.status}`);
  }
  canceller.abort("cancel");
  state.cancelRequested = true;
  return state;
}
