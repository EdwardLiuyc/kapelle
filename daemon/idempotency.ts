/**
 * `POST /runs`'s `Idempotency-Key` (M5-7, #139), split from `daemon.ts`
 * (M12-7a). The key is reserved before the body is read, so a retry that
 * arrives while the first request has not answered gets
 * `idempotency_in_progress` rather than a second run. Only a started run is
 * kept: a refused request frees its key, so the client can fix it and send it
 * again with the same key.
 *
 * One map for every repository (G3): `cwd` is in the body, so a key reused in
 * another repository is a conflict. Kept for the daemon's life, like its runs
 * (G4); a restart forgets every key.
 */

import type { IncomingMessage } from "node:http";
import { digest, refusal } from "./http.ts";

/** The `Idempotency-Key` header, `undefined` when absent, or a 400. Visible
 *  ASCII with no space, so a duplicated header, which Node joins with ", ",
 *  is refused rather than read as one key. */
function idempotencyKey(req: IncomingMessage): string | undefined {
  const key = req.headers["idempotency-key"];
  if (key === undefined) return undefined;
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,255}$/.test(key)) {
    throw refusal(
      400,
      "invalid_request",
      "Idempotency-Key must be 1 to 255 visible ASCII characters, with no space",
    );
  }
  return key;
}

/** The digest of a parsed body with every object's keys sorted, so a retry
 *  that sends the same fields in another order is the same body. Arrays keep
 *  their order: task order means something. */
function bodyDigest(body: Record<string, unknown>): Buffer {
  return digest(
    JSON.stringify(body, (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
          )
        : value,
    ),
  );
}

/** The key map. `once` reads the body with `read` and starts the run with
 *  `start` at most once per key, and answers the run id. */
export function createIdempotencyKeys() {
  /** Key → the body's digest and the run it started, or `null` while that
   *  request has not answered. */
  const keys = new Map<string, { hash: Buffer; id: string } | null>();

  async function once(
    req: IncomingMessage,
    read: () => Promise<Record<string, unknown>>,
    start: (body: Record<string, unknown>) => Promise<string>,
  ): Promise<string> {
    const key = idempotencyKey(req);
    if (key === undefined) return start(await read());
    const seen = keys.get(key);
    if (seen === null) {
      throw refusal(
        409,
        "idempotency_in_progress",
        `a request with Idempotency-Key ${key} has not answered yet`,
      );
    }
    if (seen) {
      const body = await read();
      if (!bodyDigest(body).equals(seen.hash)) {
        throw refusal(
          409,
          "idempotency_conflict",
          `Idempotency-Key ${key} was used with a different body`,
        );
      }
      return seen.id;
    }
    keys.set(key, null);
    try {
      const body = await read();
      const id = await start(body);
      keys.set(key, { hash: bodyDigest(body), id });
      return id;
    } catch (err) {
      // Only when no run started: a key freed after that would let a retry
      // start a second run.
      keys.delete(key);
      throw err;
    }
  }

  return { once };
}
