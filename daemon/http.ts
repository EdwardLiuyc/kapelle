/**
 * The daemon's HTTP edge — stories M2-1, M2-8 and M5-3, split out of
 * `daemon.ts`.
 *
 * Everything a request meets before a route reads it: the `Host` guard, the
 * token check, the body reader and the refusal type every route throws. Kept
 * apart from `daemon.ts` because that file starts a daemon when imported, and
 * this is the security code, which needs tests that call it directly.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import type { ErrorCode } from "../client/contract.ts";

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Compared as digests: `timingSafeEqual` needs equal lengths, and hashing
 *  both sides gives that without a length check that answers early. */
export const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * The names this daemon answers to — story M2-8, issue #38.
 *
 * DNS rebinding is the attack the token alone does not stop: a page on
 * `evil.example` re-resolves its own name to `127.0.0.1`, and the browser then
 * talks to this daemon while treating the reply as same-origin. The `Host`
 * line is the one field that attack cannot forge — it still says
 * `evil.example`, because that is the name the browser was told to fetch.
 *
 * The port is deliberately not matched: rebinding needs an attacker-chosen
 * DNS name to gain same-origin access. Direct cross-origin requests to a
 * loopback URL still arrive with a loopback Host, but without the bearer token
 * they are refused. Matching the port would add no protection against those.
 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost\.?|\[::1\])(:\d+)?$/i;

/**
 * The authority this request is addressed to, or `null` when there is no one
 * answer. Two fields can carry it, and the guard has to read the right one.
 *
 * RFC 9112 §3.2.2: with an absolute-form target (`GET http://host/path`) the
 * target's authority wins and `Host` is ignored. RFC 9110 §7.2: more than one
 * `Host` line is malformed — Node keeps the first for `req.headers.host`, so a
 * loopback line followed by a forged one would otherwise pass. `rawHeaders` is
 * where both survive. The match itself is case-insensitive and admits the
 * root-anchored `localhost.`, because a hostname is both (RFC 9110 §4.2.3) and
 * a rebinding page can put neither spelling on the wire; `/i` without `/u`, or
 * `localhoſt` would fold into a match.
 */
function authorityOf(req: IncomingMessage): string | null {
  const hosts = req.rawHeaders.filter(
    (h, i) => i % 2 === 0 && h.toLowerCase() === "host",
  );
  if (hosts.length > 1) return null;
  try {
    // Throws for an origin-form target, which is every ordinary request.
    return new URL(req.url ?? "/").host;
  } catch {
    return req.headers.host ?? "";
  }
}

/** Is this request addressed to loopback? A forged, duplicated or missing
 *  `Host` is not. */
export function hostAllowed(req: IncomingMessage): boolean {
  const authority = authorityOf(req);
  return authority !== null && LOOPBACK_HOST.test(authority);
}

/** Does the request carry the bearer token whose `digest` is `expected`? */
export function authorised(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(given), expected);
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** An error that carries its HTTP status and contract code (M5-3). Only a
 *  `Refusal` is trusted by the server's catch; anything else is a 500
 *  `internal`, so a raw Node or `execFile` error cannot leak its own `code`
 *  into the envelope. */
export class Refusal extends Error {
  status: number;
  code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function refusal(
  status: number,
  code: ErrorCode,
  message: string,
): Refusal {
  return new Refusal(status, code, message);
}

/** The largest request body read (J1): run files carry prompts. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * A write's JSON body, refused in order: not JSON by `Content-Type` (415),
 * too large (413), not a JSON object (400), a field outside `fields` (400,
 * C8). The size is checked on `Content-Length` before a byte is read, and
 * counted as it arrives for a body sent without one, so an oversized body is
 * never held in memory.
 */
export async function readBody(
  req: IncomingMessage,
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (type.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw refusal(
      415,
      "unsupported_media_type",
      `send the body as Content-Type: application/json; got ${type || "none"}`,
    );
  }
  const tooLarge = () =>
    refusal(
      413,
      "body_too_large",
      `the body is larger than ${MAX_BODY_BYTES} bytes`,
    );
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  // `destroyOnReturn: false`, then `resume()`: leaving the loop early must
  // not destroy the request, or nothing reads the rest of an oversized upload
  // and it stalls (measured 2026-09-23: after 8 MiB). Resumed, the rest is
  // discarded as it arrives, as Node does after a 413 on `Content-Length`.
  let over = false;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      over = true;
      break;
    }
    chunks.push(chunk as Buffer);
  }
  if (over) {
    req.resume();
    throw tooLarge();
  }
  // Joined as bytes, then decoded once: a character split across two chunks
  // would otherwise decode as two replacement characters.
  const text = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw refusal(
      400,
      "invalid_request",
      `body is not JSON: ${messageOf(err)}`,
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw refusal(400, "invalid_request", "body must be a JSON object");
  }
  const extra = Object.keys(body).find((key) => !fields.includes(key));
  if (extra !== undefined) {
    throw refusal(
      400,
      "invalid_request",
      `unknown field "${extra}"; this route takes ${fields.join(", ")}`,
    );
  }
  return body as Record<string, unknown>;
}

/** `value` as the real path of a folder that exists, or a 400 naming `field`. */
export function existingDir(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw refusal(
      400,
      "invalid_request",
      `"${field}" must be an absolute path; got ${JSON.stringify(value)}`,
    );
  }
  if (!statSync(value, { throwIfNoEntry: false })?.isDirectory()) {
    throw refusal(
      400,
      "invalid_request",
      `"${field}": ${value} does not exist as a folder`,
    );
  }
  return realpathSync(value);
}
