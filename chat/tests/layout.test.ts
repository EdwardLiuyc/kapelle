/**
 * The chat screen's layout — `screenLayout` in `chat/tui.ts`, #242. pi-tui
 * sizes an `HStack`'s parts by drawing each in full. A part there that holds
 * another `HStack` joins every transcript line on every frame, and an `auto`
 * size measures the width of every line. Both made the screen lag.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type Component,
  HStack,
  Text,
  type TuiAltScreen,
} from "@earendil-works/pi-tui";
import type { Followed } from "../../client/roomset.ts";
import { bannerPart } from "../tui/banner.ts";
import { paneParts } from "../tui/pane.ts";
import { sidebarParts } from "../tui/sidebar.ts";
import { transcriptParts } from "../tui/transcript.ts";
import { screenLayout } from "../tui.ts";

type Part = { component: Component; basis?: number | "auto" };
/** A stack's parts. pi-tui keeps them `protected`. */
const partsOf = (c: Component) =>
  (c as unknown as { entries?: Part[] }).entries ?? [];
/** What `c` holds: a stack's parts, or a scroll view's one child. */
const inside = (c: Component): Component[] => {
  const child = (c as unknown as { child?: Component }).child;
  return child ? [child] : partsOf(c).map((e) => e.component);
};
/** Every part below `c`, at any depth. */
const below = (c: Component): Component[] =>
  inside(c).flatMap((k) => [k, ...below(k)]);

test("no HStack in the chat screen holds another, and each of its parts has a set width", () => {
  const tui = { requestRender() {}, setFocus() {} } as unknown as TuiAltScreen;
  const rooms = new Map<string, Followed>();
  const view = () => ({ roomId: "" });
  const editor = new Text("");
  const { sidebar, strip } = sidebarParts({
    rooms,
    view,
    toggle() {},
    open() {},
  });
  // The real parts, so a stack added inside one is walked too.
  const { root } = screenLayout({
    sidebar,
    strip,
    timeline: transcriptParts({ tui, rooms, view, setStatus() {} }).scroll,
    pane: paneParts({ tui, editor, setStatus() {}, gutter: () => 26 }).pane,
    banner: bannerPart({ rooms, view, open() {}, question() {} }),
    status: new Text(""),
    editor,
    whereBar: new Text(""),
    sidebarShown: () => true,
    timelineShown: () => true,
    paneShown: () => true,
    paneColumns: () => 40,
  });
  const rows = [root, ...below(root)].filter((c) => c instanceof HStack);
  // Not found means pi-tui renamed `entries`, and this test checks nothing.
  assert.ok(rows.length > 0, "the walk finds the row");
  for (const row of rows) {
    for (const p of partsOf(row)) {
      assert.equal(typeof p.basis, "number", "each part has a set width");
    }
    assert.ok(
      !below(row).some((c) => c instanceof HStack),
      "no HStack below an HStack",
    );
  }
});
