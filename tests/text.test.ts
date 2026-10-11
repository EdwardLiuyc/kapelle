/**
 * The terminal-cleaning rules have two copies each (#229): `clean` and
 * `oneLine` in `core/text.ts`, `cleanLines` and `printable` in
 * `client/room.ts`, since `client/` may not import `core/`. This suite fails
 * when a pair drifts. The sample is a
 * tripwire, not a proof: it holds every `Cc`, `Zl` and `Zp` character and
 * some `Cf` ones, and one is enough to catch a drift. Here and not in
 * `client/tests/`, because it imports both sides.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { cleanLines, printable } from "../client/room.ts";
import { clean, oneLine } from "../core/text.ts";

test("each pair agrees on every control, format and separator character", () => {
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
  assert.equal(oneLine(sample), printable(sample));
  // The rule itself, once: what goes, and what stays.
  assert.equal(clean("a\x1b[2J\tb\nc\u202Ed\u200De"), "a [2J    b\nc d\u200De");
});
