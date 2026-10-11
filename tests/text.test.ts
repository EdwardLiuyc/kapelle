/**
 * The terminal-cleaning rule has two copies (#229): `clean` in
 * `core/text.ts` and `cleanLines` in `client/room.ts`, since `client/` may
 * not import `core/`. This suite fails when they drift. Here and not in
 * `client/tests/`, because it imports both sides.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { cleanLines } from "../client/room.ts";
import { clean } from "../core/text.ts";

test("clean and cleanLines agree on every control, format and separator character", () => {
  const points = [
    ...Array.from({ length: 0x250 }, (_, i) => i),
    ...Array.from({ length: 0x80 }, (_, i) => 0x2000 + i),
    0xfeff,
    0xe0001,
    0xe0041,
    0x1f468,
  ];
  const sample = String.fromCodePoint(...points);
  assert.equal(clean(sample), cleanLines(sample));
  // The rule itself, once: what goes, and what stays.
  assert.equal(clean("a\x1b[2J\tb\nc\u202Ed\u200De"), "a [2J    b\nc d\u200De");
});
