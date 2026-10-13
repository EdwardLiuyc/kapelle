/**
 * The pop-up's top border — `chat/tui/panel.ts`, story M7-4 (#247).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { border } from "../tui/panel.ts";

test("the top border keeps its corner and the title's start at any width, and the count gives way first (M7-4)", () => {
  const title = "asker wants to edit";
  const plain = (...a: Parameters<typeof border>) =>
    stripTerminalSequences(border(...a));
  assert.equal(
    plain(title, "1 of 2", 40),
    `┌ ${title} ${"─".repeat(8)} 1 of 2 ─┐`,
  );
  assert.equal(plain(title, undefined, 30), `┌ ${title} ${"─".repeat(7)}┐`);
  // Too narrow for both: the count goes, and a cut title says so.
  assert.equal(plain(title, "1 of 2", 15), "┌ asker wan… ─┐");
  assert.equal(plain(title, "1 of 2", 10), "┌ aske… ─┐");
  for (let width = 10; width <= 80; width += 1) {
    for (const right of [undefined, "1 of 2", "10 of 12"]) {
      const line = border(title, right, width);
      assert.equal(visibleWidth(line), width, `${width} ${right}: ${line}`);
      assert.ok(line.startsWith("┌ a"), line);
    }
  }
});
