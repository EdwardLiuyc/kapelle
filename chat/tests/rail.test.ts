/**
 * The history rail's clicks and hover preview (M7-7). The rail reads the
 * virtual model's ordered marks, so these tests use a small model-shaped
 * stand-in and the real rail component.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  Component,
  OverlayOptions,
  ScrollView,
  TuiAltScreen,
  TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { type Entry, printable } from "../../client/room.ts";
import { railParts } from "../tui/rail.ts";
import type { Message } from "../view.ts";

const at = (i: number): Entry =>
  ({
    seq: i + 1,
    at: "2026-11-01T00:00:00Z",
    participantId: "p-ana",
    type: "user",
    text: `message ${i}`,
  }) as Entry;

function setup({
  count = 10,
  tops = Array.from({ length: 10 }, (_, i) => i * 10),
  rows = 8,
}: {
  count?: number;
  tops?: number[];
  rows?: number;
} = {}) {
  const entries = Array.from({ length: count }, (_, i) => at(i));
  let shownCount = count;
  let columns = 100;
  const jumps: Entry[] = [];
  const overlays: {
    component: Component;
    options: OverlayOptions;
    hidden: boolean;
  }[] = [];
  let focused = 0;
  const scrollState = {
    scrollTop: 28,
    isFollowingEnd: false,
    scrollBy(delta: number) {
      scrollState.scrollTop += delta;
    },
  };
  const scroll = scrollState as unknown as ScrollView;
  const model = {
    get markCount() {
      return shownCount;
    },
    markTop(i: number) {
      return tops[i];
    },
    markEntry(i: number): Message | undefined {
      return entries[i] as Message | undefined;
    },
  };
  const tui = {
    requestRender() {},
    setFocus() {
      focused += 1;
    },
    showOverlay(component: Component, options: OverlayOptions = {}) {
      const overlay = { component, options, hidden: false };
      overlays.push(overlay);
      return {
        hide() {
          overlay.hidden = true;
        },
      };
    },
  } as unknown as TuiAltScreen;
  const parts = railParts({
    tui,
    scroll,
    model: () => model,
    viewportRows: () => rows,
    jump: (entry) => jumps.push(entry),
    text: (entry) => `row: ${printable(entry.text)}`,
    terminal: () => ({ width: columns, height: 30 }),
    delay: 5,
  });
  const mouse = (
    type: TuiMouseEvent["type"],
    y: number,
    screenY = y,
  ): TuiMouseEvent =>
    ({
      type,
      button: type === "click" ? "left" : "none",
      x: 0,
      y,
      screenX: 88,
      screenY,
      width: 2,
      height: rows,
      shift: false,
      alt: false,
      ctrl: false,
    }) as TuiMouseEvent;
  return {
    parts,
    jumps,
    entries,
    overlays,
    scroll: scrollState,
    mouse,
    focused: () => focused,
    setCount: (n: number) => {
      shownCount = n;
    },
    setColumns: (n: number) => {
      columns = n;
    },
  };
}

test("a mark click jumps to it, and the chevrons move one mark", () => {
  const { parts, jumps, entries, mouse } = setup();
  const lines = parts.rail.render(2);
  assert.equal(lines.length, 8);
  assert.match(lines[0] as string, /▲/);
  assert.match(lines[7] as string, /▼/);

  parts.rail.handleMouse?.(mouse("click", 1));
  assert.equal(jumps[0], entries[0], "row 1 is the first visible mark");
  parts.rail.handleMouse?.(mouse("click", 7));
  assert.equal(jumps[1], entries[3], "down is the next mark after active");
  parts.rail.handleMouse?.(mouse("click", 0));
  assert.equal(jumps[2], entries[1], "up is the previous mark after active");
});

test("hover waits, replaces the card and closes when the rail is left", async () => {
  const { parts, overlays, mouse, focused } = setup();
  parts.rail.render(2);
  assert.equal(parts.rail.handleMouse?.(mouse("move", 3))?.handled, true);
  assert.equal(overlays.length, 0, "no card before the hover delay");

  await new Promise((ok) => setTimeout(ok, 15));
  assert.equal(overlays.length, 1);
  const first = overlays[0];
  assert.ok(first);
  assert.equal(first.options.nonCapturing, true);
  assert.equal(typeof first.options.width, "number");
  assert.ok((first.options.width as number) <= 40);
  assert.ok(
    typeof first.options.col === "number" &&
      first.options.col + (first.options.width as number) < 88,
    "the card stays left of the rail",
  );
  const card = first.component.render(first.options.width as number);
  assert.ok(card.some((line) => line.includes("row: message 2")));
  assert.equal(focused(), 0, "the card never takes focus");

  parts.rail.handleMouse?.(mouse("move", 4));
  await new Promise((ok) => setTimeout(ok, 15));
  assert.equal(overlays.length, 2);
  assert.equal(first.hidden, true, "the old card is hidden");
  assert.ok(
    overlays[1]?.component
      .render(overlays[1].options.width as number)
      .some((line) => line.includes("row: message 3")),
  );

  parts.miss(mouse("move", 4, 20));
  assert.equal(overlays[1]?.hidden, true);
});

test("hover closes on scrolling and when the rail hides", async () => {
  const { parts, overlays, mouse, setCount, setColumns } = setup();
  parts.rail.render(2);
  parts.rail.handleMouse?.(mouse("move", 3));
  await new Promise((ok) => setTimeout(ok, 15));
  assert.equal(overlays.length, 1);

  assert.equal(
    parts.rail.handleMouse?.(mouse("wheel", 3)),
    undefined,
    "the rail leaves the wheel to the timeline",
  );
  assert.equal(overlays[0]?.hidden, true);

  parts.rail.handleMouse?.(mouse("move", 3));
  await new Promise((ok) => setTimeout(ok, 15));
  assert.equal(overlays.length, 2);
  setColumns(75);
  parts.sync();
  assert.equal(overlays[1]?.hidden, true);
  assert.equal(parts.shown(), false, "the narrow screen hides the rail");

  setColumns(100);
  setCount(2);
  assert.equal(parts.shown(), true, "two messages reserve the rail early");
  setCount(1);
  assert.equal(parts.shown(), false);

  const tiny = setup({ rows: 2 });
  assert.equal(tiny.parts.shown(), false, "under three rows hides the rail");
});

test("the hover card stays on the screen", async () => {
  const { parts, overlays, mouse } = setup();
  parts.rail.render(2);
  parts.rail.handleMouse?.(mouse("move", 5, 29));
  await new Promise((ok) => setTimeout(ok, 15));
  const card = overlays[0];
  assert.ok(card);
  const row = card.options.row as number;
  const height = card.options.maxHeight as number;
  assert.ok(
    row >= 0 && row + height <= 30,
    `the card rows ${row}..${row + height} stay on the 30-row screen`,
  );
});

test("the card itself closes on a move and still scrolls the wheel", async () => {
  const { parts, overlays, mouse, scroll } = setup();
  parts.rail.render(2);
  parts.rail.handleMouse?.(mouse("move", 3));
  await new Promise((ok) => setTimeout(ok, 15));
  const card = overlays[0]?.component;
  assert.ok(card);
  const event = { ...mouse("move", 1), wheelDelta: undefined };
  card.handleMouse?.(event as TuiMouseEvent);
  assert.equal(overlays[0]?.hidden, true);
  card.handleMouse?.({
    ...mouse("wheel", 1),
    wheelDelta: -3,
  } as TuiMouseEvent);
  assert.equal(scroll.scrollTop, 25);
});
