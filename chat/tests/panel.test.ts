/**
 * The pop-up's top border: it fills the box's width exactly, with the
 * title, or a cut title, in it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { yellow } from "../common.ts";
import { topEdge } from "../tui/panel.ts";

test("the top border is as wide as the box, and holds the title", () => {
  for (const width of [10, 11, 40, 80]) {
    for (const title of ["new room", "question 1 of 3", "x".repeat(100)]) {
      const line = topEdge(title, width, yellow);
      assert.equal(visibleWidth(line), width, `${title} at ${width}`);
      const text = stripTerminalSequences(line);
      assert.match(text, /^┏━ .+ ━*┓$/);
      if (width >= title.length + 6) assert.ok(text.includes(title));
      else assert.ok(text.includes("…"));
    }
  }
});
