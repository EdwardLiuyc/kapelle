/**
 * An answer's finished blocks — `settled` in `chat/tui/transcript.ts`,
 * story M4-4 (#50). Markdown cut where it says draws as it does whole.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  Container,
  Markdown,
  Text,
  type TuiAltScreen,
} from "@earendil-works/pi-tui";
import type { RoomEventLine } from "../../client/contract.ts";
import { applyLine, type Entry, newRoomState } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { bgRgb, inverse } from "../common.ts";
import { settled, transcriptParts, unbar } from "../tui/transcript.ts";
import { activeMark, messages } from "../view.ts";

test("a copy loses each row's bar, and keeps a typed one", () => {
  assert.equal(unbar("▎ hello\n▎ ▎ kept\n  note"), "hello\n▎ kept\n  note");
  assert.equal(unbar("▎"), "");
});

const id = (s: string) => s;
const FULL_TRANSCRIPT = () => Number.POSITIVE_INFINITY;
const THEME = {
  heading: id,
  link: id,
  linkUrl: id,
  code: id,
  codeBlock: id,
  codeBlockBorder: id,
  quote: id,
  quoteBorder: id,
  hr: id,
  listBullet: id,
  bold: id,
  italic: id,
  strikethrough: id,
  underline: id,
};
const draw = (text: string) => new Markdown(text, 1, 0, THEME).render(40);

const ANSWER = [
  "# Title",
  "",
  "Para one, with `code`.",
  "",
  "1. one",
  "",
  "   still one",
  "",
  "2. two",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "> a quote",
  "",
  "$$",
  "a = b",
  "",
  "c = d",
  "$$",
  "",
  "$$e$$",
  "",
  "End.",
].join("\n");

test("a cut is after a blank line, before a line that is not indented, outside a fence or a math block", () => {
  assert.equal(settled("one\n\ntwo", 0), 5);
  assert.equal(settled("one\n\n", 0), 0, "the next block has not started");
  assert.equal(settled("- a\n\n  b", 0), 0, "an indented line continues");
  assert.equal(settled("```\na\n\nb", 0), 0, "inside an open fence");
  assert.equal(settled("x\n\n```\na\n\nb\n```\n\ny", 0), 17);
  assert.equal(settled("x\n\n$$\na\n\nb\n$$\n\ny", 0), 3, "inside $$");
  assert.equal(settled("x\n\n$$a$$\n\ny", 0), 3, "never right after $$");
  assert.equal(settled("one\n\ntwo", 5), 5, "nothing after from");
});

test("an answer drawn in its settled pieces, chunk by chunk, draws as it does whole", () => {
  for (let size = 1; size <= ANSWER.length; size++) {
    const text = ANSWER.slice(0, size);
    // As the transcript does it: each chunk cuts off what settled.
    const pieces: string[] = [];
    let done = 0;
    for (let at = 1; at <= size; at++) {
      const cut = settled(text.slice(0, at), done);
      if (cut > done) pieces.push(text.slice(done, cut));
      done = cut;
    }
    pieces.push(text.slice(done));
    // A bare `>` draws an empty row alone, and nothing at the end of a
    // whole text: one row too many, until the quote's text comes.
    if (text.slice(done).trim() === ">") continue;
    assert.deepEqual(pieces.flatMap(draw), draw(text), JSON.stringify(text));
  }
});

test("a jump puts the person's message at the top of the transcript", () => {
  const state = newRoomState();
  const line = (seq: number, update: RoomEventLine["update"]) =>
    applyLine(state, {
      seq,
      at: "2026-10-05T00:00:00Z",
      roomId: "r1",
      participantId: "p-ann",
      update,
    });
  line(1, {
    sessionUpdate: "_client_participant_added",
    name: "ann",
    harness: "mock",
    mode: "auto",
  });
  const alpha = line(2, {
    sessionUpdate: "_client_user_message",
    text: "alpha",
    turn: 1,
  });
  line(3, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "one\n\ntwo\n\nthree" },
  });
  line(4, { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" });
  line(5, { sessionUpdate: "_client_user_message", text: "beta", turn: 2 });
  for (let i = 0; i < 30; i++)
    line(6 + i, {
      sessionUpdate: "_client_user_message",
      text: `later ${i}`,
      turn: 3 + i,
    });
  assert.ok(alpha);
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const {
    transcript,
    scroll,
    redraw,
    jump,
    model: currentModel,
  } = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 5,
  });
  redraw();
  let lines = transcript.render(40);
  scroll.updateLayout(lines.length, 5, () => {});
  // At the end, as a long transcript is: the jump goes back up.
  scroll.scrollToEnd();
  const model = currentModel();
  assert.ok(model);
  assert.equal(
    model.byEntry.get(alpha)?.parts,
    undefined,
    "alpha is not drawn",
  );
  const top = model.topOf(alpha);
  assert.equal(typeof top, "number");
  assert.equal(model.entryAt(top as number), alpha);
  const created = model.stats.partsCreated;
  const visited = model.stats.entriesVisited;
  jump(alpha);
  assert.equal(model.stats.partsCreated, created, "jump creates no parts");
  assert.equal(model.stats.entriesVisited, visited, "jump visits no items");
  lines = transcript.render(40);
  scroll.updateLayout(lines.length, 5, () => {});
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const plain = (l?: string) => l?.replace(/\x1b\[[0-9;]*m/g, "").trim();
  assert.equal(plain(lines[scroll.scrollTop]), "▎ you → ann");
  assert.equal(plain(lines[scroll.scrollTop + 1]), "▎ alpha");
});

test("a jump reaches a message added since the last layout", () => {
  const state = newRoomState();
  let seq = 0;
  const line = (update: RoomEventLine["update"]) => {
    const e = applyLine(state, {
      seq: ++seq,
      at: "2026-10-05T00:00:00Z",
      roomId: "r1",
      participantId: "p-ann",
      update,
    });
    assert.ok(e);
    return e;
  };
  applyLine(state, {
    seq: ++seq,
    at: "2026-10-05T00:00:00Z",
    roomId: "r1",
    participantId: "p-ann",
    update: {
      sessionUpdate: "_client_participant_added",
      name: "ann",
      harness: "mock",
      mode: "auto",
    } as unknown as RoomEventLine["update"],
  });
  line({
    sessionUpdate: "_client_user_message",
    text: "first",
    turn: 1,
  });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 5,
  });
  parts.redraw();
  let rows = parts.transcript.render(40);
  parts.scroll.updateLayout(rows.length, 5, () => {});
  let target: Entry | undefined;
  for (let i = 0; i < 30; i++) {
    const e = line({
      sessionUpdate: "_client_user_message",
      text: `later ${i}`,
      turn: 2 + i,
    });
    parts.draw(state, e);
    if (i === 10) target = e;
  }
  assert.ok(target);
  parts.jump(target);
  rows = parts.transcript.render(40);
  parts.scroll.updateLayout(rows.length, 5, () => {});
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const plain = rows.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim());
  assert.equal(plain[parts.scroll.scrollTop], "▎ you → ann");
  assert.equal(plain[parts.scroll.scrollTop + 1], "▎ later 10");
});

test("an answer streamed through draw, chunk by chunk, draws as its whole text", () => {
  const state = newRoomState();
  let seq = 0;
  const line = (update: RoomEventLine["update"]) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-05T00:00:00Z",
      roomId: "r1",
      participantId: "p-ann",
      update,
    });
  line({
    sessionUpdate: "_client_participant_added",
    name: "ann",
    harness: "mock",
    mode: "auto",
  });
  line({ sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: FULL_TRANSCRIPT,
  });
  parts.redraw();
  for (let at = 0; at < ANSWER.length; at += 7) {
    const e = line({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: ANSWER.slice(at, at + 7) },
    });
    assert.ok(e);
    parts.draw(state, e);
  }
  // The theme only paints; the rows are the same without it.
  const plain = (rows: string[]) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    rows.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  // The answer draws one column narrower, after its bar (M7-1).
  const whole = plain(
    new Markdown(ANSWER, 1, 0, THEME).render(39).map((l) => `▎${l}`),
  );
  const drawn = plain(parts.transcript.render(40));
  assert.deepEqual(drawn.slice(-whole.length), whole);
  const bar = parts.transcript.children.findLast(
    (c) => c instanceof Container && c.children[0] instanceof Container,
  ) as Container;
  const box = bar.children[0] as Container;
  assert.ok(box.children.length > 5, "the finished blocks were cut off");
});

test("a fast-forward draws a line naming both participants", () => {
  const state = newRoomState();
  let seq = 0;
  const line = (participantId: string, update: RoomEventLine["update"]) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-07T00:00:00Z",
      roomId: "r1",
      participantId,
      update,
    });
  line("p-dev", {
    sessionUpdate: "_client_participant_added",
    name: "dev",
    harness: "mock",
    mode: "auto",
  });
  line("p-rev", {
    sessionUpdate: "_client_participant_added",
    name: "rev",
    harness: "mock",
    mode: "auto",
  });
  line("p-dev", {
    sessionUpdate: "_client_participant_fast_forwarded",
    from: "p-rev",
    branch: "kapelle/r1/p-dev",
    sha: "abc123",
  });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: FULL_TRANSCRIPT,
  });
  parts.redraw();
  const plain = (rows: string[]) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    rows.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  assert.ok(
    plain(parts.transcript.render(80)).some((l) =>
      l.includes("↪ dev moved to rev's commit"),
    ),
    parts.transcript.render(80).join("\n"),
  );
});

/** The transcript after ana's message and one revive line `revived`. */
function afterRevive(revived: RoomEventLine["update"]): string {
  const state = newRoomState();
  let seq = 0;
  const line = (update: RoomEventLine["update"]) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-08T00:00:00Z",
      roomId: "r1",
      participantId: "p-ana",
      update,
    });
  line({
    sessionUpdate: "_client_participant_added",
    name: "ana",
    harness: "mock",
    mode: "auto",
  });
  line({ sessionUpdate: "_client_user_message", text: "hi", turn: 1 });
  line(revived);
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: FULL_TRANSCRIPT,
  });
  parts.redraw();
  return (
    parts.transcript
      .render(160)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
      .join("\n")
  );
}

test("a revive draws a line that says the session is fresh (M6-7a)", () => {
  assert.match(
    afterRevive({
      sessionUpdate: "_client_participant_revived",
      resumed: "fresh",
      sessionId: "s2",
    }),
    /↻ ana is back with a fresh session; it does not remember/,
  );
});

test("a revive shows an unknown resumed as text, and warns only when loaded (#238)", () => {
  const unknown = afterRevive({
    sessionUpdate: "_client_participant_revived",
    resumed: "forked",
    sessionId: "s3",
  } as unknown as RoomEventLine["update"]);
  assert.match(unknown, /↻ ana is back \(forked\)/);
  assert.doesNotMatch(unknown, /fresh session/);
  const fresh = afterRevive({
    sessionUpdate: "_client_participant_revived",
    resumed: "fresh",
    sessionId: "s2",
    memoryMayBeBehind: true,
  });
  assert.match(fresh, /↻ ana is back with a fresh session/);
  assert.doesNotMatch(fresh, /behind/);
});

test("a loaded revive says so, and warns when its memory may be behind (M6-7b)", () => {
  const loaded = afterRevive({
    sessionUpdate: "_client_participant_revived",
    resumed: "loaded",
    sessionId: "s1",
  });
  assert.match(loaded, /↻ ana is back with its old session/);
  assert.doesNotMatch(loaded, /behind/);
  assert.match(
    afterRevive({
      sessionUpdate: "_client_participant_revived",
      resumed: "loaded",
      sessionId: "s1",
      memoryMayBeBehind: true,
    }),
    /! ana is back with its old session, but it stopped during a turn: what it remembers may be behind its files/,
  );
});

type Line = (update: Record<string, unknown>, participantId?: string) => void;

/** ana's turn: a thought, an answer and a tool call, drawn in r1's
 *  timeline. `more` adds lines after it. */
function look(more?: (line: Line) => void) {
  const state = newRoomState();
  let seq = 0;
  const line = (update: Record<string, unknown>, participantId = "p-ana") =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-10T09:05:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
  line({
    sessionUpdate: "_client_participant_added",
    name: "ana",
    role: "reviewer",
    harness: "claude",
    mode: "ask",
  });
  line({ sessionUpdate: "_client_user_message", text: "hi", turn: 1 });
  line({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "SECRET" },
  });
  line({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "**hello**" },
  });
  line({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read File" });
  more?.(line);
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: FULL_TRANSCRIPT,
  });
  parts.redraw();
  return parts.transcript.render(80);
}

test("an agent's heading shows its harness, role and time; its lines get its bar; no thinking text (M7-1)", () => {
  const rows = look();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const plain = rows.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  const d = new Date("2026-10-10T09:05:00Z");
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  assert.ok(
    plain.includes(`▎ ana · claude · reviewer · ${time}`),
    plain.join("\n"),
  );
  assert.ok(plain.includes("▎ hello"), "the answer has the bar");
  // A live call ends with the spinner (M7-2).
  assert.ok(
    plain.some((l) => /^▎ \$ Read File [◐◓◑◒]$/.test(l)),
    "the tool call too",
  );
  assert.ok(plain.includes("▎ you → ana"), "the person's message: a bar");
  const you = plain.indexOf("▎ you → ana");
  assert.equal(plain[you - 1], "", "the gap above has no bar");
  assert.ok(!rows[you - 1]?.includes("\x1b[48;5;"), "and no background");
  assert.ok(
    rows.join("").includes("\x1b[38;5;75m▎"),
    "ana's colour, the first",
  );
  assert.ok(
    rows.join("").includes("\x1b[48;5;236m"),
    "the person's background",
  );
  assert.ok(!rows.join("").includes("SECRET"), "thinking text is never drawn");
});

test("a message from the orchestrator reads po → ana, live and queued (M8-1)", () => {
  const rows = look((line) => {
    line(
      {
        sessionUpdate: "_client_participant_added",
        name: "po",
        role: "orchestrator",
        harness: "claude",
        mode: "auto",
      },
      "p-po",
    );
    line({ sessionUpdate: "_client_message_queued", text: "go", from: "p-po" });
    line({
      sessionUpdate: "_client_user_message",
      text: "go",
      turn: 2,
      from: "p-po",
    });
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const plain = rows.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  assert.ok(plain.includes("▎ you → ana"), plain.join("\n"));
  assert.ok(plain.includes("▎ po → ana"), plain.join("\n"));
  assert.ok(
    plain.some((l) => l.includes("queued for ana from po: go")),
    plain.join("\n"),
  );
});

test("NO_COLOR: the transcript has no colour code, and inverse stays (M7-1)", (t) => {
  const was = process.env.NO_COLOR;
  t.after(() => {
    if (was === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = was;
  });
  process.env.NO_COLOR = "1";
  const rows = look((line) =>
    line({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    }),
  ).join("");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  assert.doesNotMatch(rows, /\x1b\[(3[0-9]|4[0-9]|9[0-7]|10[0-7])[;m]/);
  assert.ok(rows.includes("\x1b[1m"), "bold stays");
  assert.ok(rows.includes("Read File ✓"), "success survives without colour");
  assert.equal(inverse("x"), "\x1b[7mx\x1b[27m", "the history cursor stays");
});

test("a tool call is one row that its updates change in place, with ✗ in red (#240, M7-2)", () => {
  const state = newRoomState();
  let seq = 0;
  const line = (update: Record<string, unknown>) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-10T00:00:00Z",
      roomId: "r1",
      participantId: "p-ann",
      update: update as unknown as RoomEventLine["update"],
    });
  line({
    sessionUpdate: "_client_participant_added",
    name: "ann",
    harness: "mock",
    mode: "auto",
  });
  line({ sessionUpdate: "tool_call", toolCallId: "t1", title: "edit" });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: FULL_TRANSCRIPT,
  });
  parts.redraw();
  const children = parts.transcript.children.length;
  const e = line({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    rawInput: { filePath: "/w/a.ts" },
    status: "failed",
  });
  assert.ok(e);
  parts.draw(state, e);
  assert.equal(parts.transcript.children.length, children, "no new row");
  const rendered = parts.transcript.render(40);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const plain = rendered.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim());
  // After the agent's bar (M7-1), with a coloured empty row at both ends.
  assert.deepEqual(plain.slice(-4, -2), ["▎ $ edit ✗", "▎   /w/a.ts"]);
  assert.ok(rendered.at(-4)?.includes("\x1b[31m ✗"), "failed is red");
  assert.ok(
    rendered.slice(-5, -1).every((l) => l.includes("\x1b[48;5;52m")),
    "the text and both empty rows get the failure background",
  );
});

test("a completed multi-line command has a background on every row (#351)", (t) => {
  const colourTerm = process.env.COLORTERM;
  t.after(() => {
    if (colourTerm === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = colourTerm;
  });
  process.env.COLORTERM = "truecolor";
  const state = newRoomState();
  let seq = 0;
  const line = (update: Record<string, unknown>) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-10T00:00:00Z",
      roomId: "r1",
      participantId: "p-ann",
      update: update as unknown as RoomEventLine["update"],
    });
  line({
    sessionUpdate: "_client_participant_added",
    name: "ann",
    harness: "mock",
    mode: "auto",
  });
  line({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "shell",
    rawInput: { command: "cd /w;\nls;\npwd" },
    status: "completed",
  });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: FULL_TRANSCRIPT,
  });
  parts.redraw();
  const rows = parts.transcript.render(40);
  const plain = rows.map((l) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd(),
  );
  assert.deepEqual(plain.slice(-7, -1), [
    "▎",
    "▎ $ shell ✓",
    "▎   cd /w;",
    "▎   ls;",
    "▎   pwd",
    "▎",
  ]);
  assert.ok(
    rows
      .slice(-7, -1)
      .every(
        (l) => l.includes("\x1b[48;2;37;65;49m") && !l.includes("\x1b[2m"),
      ),
    "all rows get the success background, and the text is not dim",
  );
  assert.ok(
    rows.some((l) => l.includes("\x1b[1m$\x1b[22m")),
    "the tool marker is bold",
  );
  assert.ok(
    !rows.at(-1)?.includes("\x1b[48;"),
    "an uncoloured row follows the last tool block",
  );
});

test("an RGB background uses its fallback outside truecolor terminals", (t) => {
  const colourTerm = process.env.COLORTERM;
  t.after(() => {
    if (colourTerm === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = colourTerm;
  });
  process.env.COLORTERM = "256color";
  assert.equal(bgRgb(37, 65, 49, 23)("x"), "\x1b[48;5;23mx\x1b[49m");
});

/** ann's room drawn in a transcript, and a line maker that draws each
 *  line it changes, as the screen does. `plain()` is the rows without
 *  colour. */
function runRoom() {
  const state = newRoomState();
  let seq = 0;
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: FULL_TRANSCRIPT,
  });
  const send = (who: string, update: Record<string, unknown>) => {
    const e = applyLine(state, {
      seq: ++seq,
      at: "2026-10-11T00:00:00Z",
      roomId: "r1",
      participantId: who,
      update: update as unknown as RoomEventLine["update"],
    });
    if (e) parts.draw(state, e);
    return e;
  };
  for (const name of ["ann", "bob"]) {
    send(name, {
      sessionUpdate: "_client_participant_added",
      name,
      harness: "mock",
      mode: "auto",
    });
  }
  parts.redraw();
  const note = (who: string, text: string) =>
    send(who, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  const tool = (who: string, id: string, more: Record<string, unknown>) =>
    send(who, { sessionUpdate: "tool_call", toolCallId: id, ...more });
  const plain = (width = 60) =>
    parts.transcript
      .render(width, true)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  /** A left click on the first row that has `text`. */
  const click = (text: string, width = 60) => {
    const y = plain(width).findIndex((l) => l.includes(text));
    assert.ok(y >= 0, `no row with ${text}`);
    return parts.transcript.handleMouse({
      type: "click",
      button: "left",
      x: 4,
      y,
      width,
      height: plain(width).length,
    } as never);
  };
  return { state, parts, send, note, tool, plain, click };
}

test("an unchanged frame keeps a streamed answer's markdown cache", () => {
  const { note, parts } = runRoom();
  note("ann", "```ts\nconst a = 1;\n");
  parts.transcript.render(60);
  const invalidate = Markdown.prototype.invalidate;
  let invalidated = 0;
  Markdown.prototype.invalidate = function (this: Markdown) {
    invalidated += 1;
    return invalidate.call(this);
  };
  try {
    parts.transcript.render(60);
  } finally {
    Markdown.prototype.invalidate = invalidate;
  }
  assert.equal(invalidated, 0, "an unchanged answer is not parsed again");
});

test("a pending to completed update redraws the text and background", (t) => {
  const colourTerm = process.env.COLORTERM;
  t.after(() => {
    if (colourTerm === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = colourTerm;
  });
  process.env.COLORTERM = "truecolor";
  const { tool, send, parts, plain } = runRoom();
  tool("ann", "t1", { title: "Read a.ts", status: "pending" });
  assert.ok(
    parts.transcript.render(60).some((l) => l.includes("\x1b[48;5;236m")),
    "pending starts with the active background and no spinner while idle",
  );
  send("ann", {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
  });
  assert.ok(plain().includes("▎ $ Read a.ts ✓"));
  assert.ok(
    parts.transcript.render(60).some((l) => l.includes("\x1b[48;2;37;65;49m")),
    "the same row changes to the success background",
  );
});

test("active calls have a neutral background and uncoloured gaps between and after them", () => {
  const { send, tool, parts, plain } = runRoom();
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  tool("ann", "t1", { title: "first", status: "in_progress" });
  tool("ann", "t2", { title: "second", status: "pending" });
  const rows = parts.transcript.render(60);
  const text = plain();
  const first = text.findIndex((l) => l.includes("first"));
  assert.ok(first > 0, text.join("\n"));
  assert.equal(text[first + 1], "▎", "the first call's bottom padding");
  assert.equal(text[first + 2], "▎", "the uncoloured separator");
  assert.equal(text[first + 3], "▎", "the second call's top padding");
  assert.ok(text[first + 4]?.includes("second"), text.join("\n"));
  assert.equal(text[first + 6], "▎", "the row after the last block");
  assert.ok(
    !rows[first + 2]?.includes("\x1b[48;") &&
      !rows[first + 6]?.includes("\x1b[48;"),
    "the rows between and after blocks have no background",
  );
  assert.ok(
    [
      ...rows.slice(first - 1, first + 2),
      ...rows.slice(first + 3, first + 6),
    ].every((l) => l.includes("\x1b[48;5;236m") && !l.includes("\x1b[2m")),
    "both calls and their coloured empty rows have the active background",
  );
});

// This component test checks folding, clicking, and redraw as one flow.
// pi-lens-ignore: high-fan-out
test("a run folds into one line when the agent's next note comes, with its failed count in red; a click opens it and a second folds it (M7-2)", () => {
  const { send, note, tool, plain, click, parts } = runRoom();
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  note("ann", "Looking.");
  tool("ann", "t1", { title: "Read a.ts", kind: "read", status: "completed" });
  tool("ann", "t2", { title: "Read b.ts", kind: "read", status: "completed" });
  tool("ann", "t3", {
    title: "Edit a.ts",
    kind: "edit",
    status: "failed",
    content: [
      { type: "diff", path: "a.ts", oldText: "a\n", newText: "b\nc\n" },
    ],
  });
  // The live run is open, with the edit's counts and failure mark.
  assert.ok(plain().includes("▎ $ Read a.ts ✓"), plain().join("\n"));
  assert.ok(plain().includes("▎ $ Edit a.ts +2 −1 ✗"));
  note("ann", "Done.");
  const folded = plain();
  assert.ok(
    folded.includes("▎ ▸ 3 tool calls · 2 read · 1 edit · 1 failed"),
    folded.join("\n"),
  );
  assert.ok(!folded.some((l) => l.includes("Read a.ts")), "the rows fold");
  assert.ok(
    folded.indexOf("▎ Looking.") <
      folded.indexOf("▎ ▸ 3 tool calls · 2 read · 1 edit · 1 failed") &&
      folded.indexOf("▎ ▸ 3 tool calls · 2 read · 1 edit · 1 failed") <
        folded.indexOf("▎ Done."),
    "at the run's first place, between the notes",
  );
  assert.ok(
    parts.transcript.render(60).some((l) => l.includes("\x1b[31m · 1 failed")),
    "failed is red",
  );
  // A click opens it; the rows come back under the line.
  assert.equal(click("▸ 3 tool calls")?.handled, true);
  const open = plain();
  const at = open.indexOf("▎ ▾ 3 tool calls · 2 read · 1 edit · 1 failed");
  assert.ok(at >= 0, open.join("\n"));
  assert.deepEqual(
    open
      .slice(at + 1)
      .filter((l) => l !== "▎")
      .slice(0, 3),
    ["▎ $ Read a.ts ✓", "▎ $ Read b.ts ✓", "▎ $ Edit a.ts +2 −1 ✗"],
  );
  // It stays open after a redraw, as after a switch.
  parts.redraw();
  assert.ok(plain().includes("▎ $ Read a.ts ✓"), "open after a redraw");
  // A second click folds it.
  click("▾ 3 tool calls");
  assert.ok(!plain().some((l) => l.includes("Read a.ts")));
  assert.equal(click("Done."), undefined, "a click on a note does nothing");
});

test("a question never folds: it ends the run before it, and the deny stays on screen (M7-2)", () => {
  const { send, note, tool, plain } = runRoom();
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  tool("ann", "t1", { title: "Read a.ts", kind: "read", status: "completed" });
  tool("ann", "t2", { title: "Write b.ts", kind: "edit", status: "pending" });
  send("ann", {
    sessionUpdate: "_client_permission_queued",
    id: "q1",
    title: "Write b.ts",
    kind: "edit",
  });
  send("ann", {
    sessionUpdate: "_client_permission_answered",
    id: "q1",
    allow: false,
    reason: "user",
  });
  send("ann", {
    sessionUpdate: "tool_call_update",
    toolCallId: "t2",
    status: "failed",
  });
  tool("ann", "t3", { title: "Read c.ts", kind: "read", status: "completed" });
  note("ann", "It was denied.");
  const rows = plain();
  assert.ok(
    rows.includes("▎ ▸ 2 tool calls · 1 read · 1 edit · 1 failed"),
    rows.join("\n"),
  );
  assert.ok(rows.some((l) => l.includes("? ann asks: Write b.ts — denied")));
  assert.ok(rows.some((l) => l.includes("▸ 1 tool call · 1 read")));
  const q = rows.findIndex((l) => l.includes("? ann asks"));
  assert.ok(
    rows.findIndex((l) => l.includes("▸ 2 tool calls")) < q &&
      q < rows.findIndex((l) => l.includes("▸ 1 tool call")),
    "the question sits between the two runs",
  );
});

test("a call still open when its turn ends shows no spinner; another agent's lines leave a run open (M7-2)", () => {
  const { send, note, tool, plain, click } = runRoom();
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  tool("ann", "t1", { title: "Run tests", kind: "execute", status: "pending" });
  // bob speaks in between: ann's run stays open.
  send("bob", { sessionUpdate: "_client_user_message", text: "hi", turn: 1 });
  note("bob", "Hello.");
  send("bob", { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" });
  assert.ok(
    plain().some((l) => /^▎ \$ Run tests [◐◓◑◒]$/.test(l)),
    plain().join("\n"),
  );
  send("ann", { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" });
  assert.ok(
    plain().includes("▎ ▸ 1 tool call · 1 execute"),
    "the end folds it",
  );
  click("▸ 1 tool call");
  assert.ok(plain().includes("▎ $ Run tests"), "no mark once the turn ended");
});

test("a fold above the view keeps the rows the person reads where they are (M7-2)", () => {
  const { send, note, tool, plain, parts } = runRoom();
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  for (let i = 0; i < 5; i++) {
    tool("ann", `t${i}`, { title: `Read f${i}.ts`, kind: "read" });
  }
  send("bob", { sessionUpdate: "_client_user_message", text: "hi", turn: 1 });
  note("bob", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n"));
  // The person reads bob's answer, with ann's run above the view.
  const { scroll } = parts;
  const layout = () => scroll.updateLayout(plain(60).length, 10, () => {});
  layout();
  const top = plain(60).indexOf("▎ line 20");
  scroll.scrollTo(top, { disableFollow: true });
  assert.equal(scroll.isFollowingEnd, false);
  note("ann", "Read them all.");
  layout();
  assert.equal(
    plain(60)[scroll.scrollTop],
    "▎ line 20",
    "the same row at the top of the view",
  );
  assert.ok(plain(60).includes("▎ ▸ 5 tool calls · 5 read"));
});

test("a fold at the turn's end keeps the rows the person reads when the spinner wraps the running row (M7-2)", () => {
  const { send, note, tool, plain, parts } = runRoom();
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  // At this width the pending row's spinner wraps it to a second row.
  tool("ann", "t1", {
    title: "Read abcdefghijklmn",
    kind: "read",
    status: "in_progress",
  });
  send("bob", { sessionUpdate: "_client_user_message", text: "hi", turn: 1 });
  note("bob", Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n"));
  const width = 24;
  const layout = () => {
    const rows = plain(width);
    parts.scroll.updateLayout(rows.length, 8, () => {});
    return rows;
  };
  const before = layout();
  const title = before.findIndex((l) => l.includes("Read abcdefghijklmn"));
  assert.ok(
    /[◐◓◑◒]/.test(before[title + 1] ?? ""),
    "the spinner wraps the running row",
  );
  const top = before.findIndex((l) => l.includes("line 20"));
  assert.ok(top > 0, before.join("\n"));
  parts.scroll.scrollTo(top, { disableFollow: true });
  assert.equal(parts.scroll.isFollowingEnd, false);
  send("ann", { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" });
  const after = layout();
  assert.equal(
    after[parts.scroll.scrollTop],
    before[top],
    "the same row at the top of the view",
  );
});

test("a cut turn's run folds when the agent's next turn starts (M7-2)", () => {
  const { send, tool, plain } = runRoom();
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  tool("ann", "t1", { title: "Read a.ts", kind: "read", status: "completed" });
  assert.ok(plain().includes("▎ $ Read a.ts ✓"), plain().join("\n"));
  // No turn end: the turn was cut. The next message starts the next turn.
  send("ann", {
    sessionUpdate: "_client_user_message",
    text: "again",
    turn: 2,
  });
  const rows = plain();
  const folded = rows.findIndex((l) => l.includes("▸ 1 tool call · 1 read"));
  const next = rows.findIndex((l) => l.includes("again"));
  assert.ok(folded >= 0 && folded < next, rows.join("\n"));
  assert.ok(!rows.some((l) => l.includes("Read a.ts")), "the run folded");
});

test("a redraw scrolled up draws no part: a replayed fold does no anchor work (M7-2)", () => {
  const { send, note, tool, plain, parts } = runRoom();
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  for (let i = 0; i < 4; i++) {
    note("ann", `Step ${i}.`);
    tool("ann", `t${i}`, { title: `Read f${i}.ts`, kind: "read" });
  }
  note("ann", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n"));
  parts.scroll.updateLayout(plain().length, 8, () => {});
  parts.scroll.scrollTo(3, { disableFollow: true });
  assert.equal(parts.scroll.isFollowingEnd, false);
  // Each replayed note folds a run. A frame draws the parts; the replay
  // must not, once per run.
  let drawn = 0;
  const render = Text.prototype.render;
  Text.prototype.render = function (this: Text, width: number) {
    drawn++;
    return render.call(this, width);
  };
  try {
    parts.redraw();
  } finally {
    Text.prototype.render = render;
  }
  assert.equal(drawn, 0);
  assert.ok(plain().includes("▎ ▸ 1 tool call · 1 read"));
});

test("a click on any row of a wrapped fold line opens the run (M7-2)", () => {
  const { send, note, tool, parts } = runRoom();
  send("ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  const kinds = ["read", "edit", "execute", "search", "fetch", "move"];
  for (const [i, kind] of kinds.entries()) {
    tool("ann", `t${i}`, { title: `T${i}`, kind });
  }
  note("ann", "Done.");
  const width = 30;
  const rows = parts.transcript
    .render(width)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  const at = rows.findIndex((l) => l.includes("▸ 6 tool calls"));
  assert.ok(at >= 0 && !rows[at + 1]?.includes("Done."), "the line wraps");
  const hit = parts.transcript.handleMouse({
    type: "click",
    button: "left",
    x: 4,
    y: at + 1,
    width,
    height: rows.length,
  } as never);
  assert.equal(hit?.handled, true);
  assert.ok(
    parts.transcript.render(width).some((l) => l.includes("T0")),
    "the run opened",
  );
});

test("a failed update after a fold rewraps its summary and moves later entries", () => {
  const state = newRoomState();
  let seq = 0;
  const add = (participantId: string, update: Record<string, unknown>) => {
    const e = applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
    assert.ok(e);
    return e;
  };
  for (const [id, name] of [
    ["p-ann", "ann"],
    ["p-bob", "bob"],
  ]) {
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId: id,
      update: {
        sessionUpdate: "_client_participant_added",
        name,
        harness: "mock",
        mode: "auto",
      } as unknown as RoomEventLine["update"],
    });
  }
  add("p-ann", {
    sessionUpdate: "_client_user_message",
    text: "go",
    turn: 1,
  });
  const first = add("p-ann", {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Read a",
    kind: "read",
    status: "completed",
  });
  add("p-ann", {
    sessionUpdate: "tool_call",
    toolCallId: "t2",
    title: "Read b",
    kind: "read",
    status: "completed",
  });
  add("p-ann", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Done" },
  });
  const target = add("p-bob", {
    sessionUpdate: "_client_user_message",
    text: "TARGET",
    turn: 1,
  });
  for (let i = 0; i < 40; i++)
    add("p-bob", {
      sessionUpdate: "_client_stall_warning",
      kind: "idle",
      text: `later ${i}`,
    });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 10,
  });
  parts.redraw();
  const rows = parts.transcript.render(30);
  parts.scroll.updateLayout(rows.length, 10, () => {});
  const model = parts.model();
  assert.ok(model);
  const summary = model.byEntry.get(first);
  assert.ok(summary);
  assert.equal(summary.measured, false, "the summary is above the window");
  const height = summary.height;
  const top = model.topOf(target);
  assert.equal(typeof top, "number");
  const update = add("p-ann", {
    sessionUpdate: "tool_call_update",
    toolCallId: "t2",
    status: "failed",
  });
  parts.draw(state, update);
  assert.ok(summary.height > height, "the failed count wraps the summary");
  assert.equal(model.topOf(target), (top as number) + 1, "the offset moves");
});

test("a folded run keeps the heading of a later call from another speaker", () => {
  const state = newRoomState();
  let seq = 0;
  const add = (participantId: string, update: Record<string, unknown>) => {
    const e = applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
    assert.ok(e);
    return e;
  };
  for (const [id, name] of [
    ["p-ann", "ann"],
    ["p-bob", "bob"],
  ]) {
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId: id,
      update: {
        sessionUpdate: "_client_participant_added",
        name,
        harness: "mock",
        mode: "auto",
      } as unknown as RoomEventLine["update"],
    });
  }
  add("p-ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  add("p-ann", {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "First",
    kind: "read",
    status: "completed",
  });
  add("p-bob", { sessionUpdate: "_client_user_message", text: "hi", turn: 1 });
  add("p-bob", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hello" },
  });
  add("p-ann", {
    sessionUpdate: "tool_call",
    toolCallId: "t2",
    title: "Second",
    kind: "edit",
    status: "completed",
  });
  add("p-ann", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "after the fold" },
  });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 20,
  });
  parts.redraw();
  const plain = parts.transcript
    .render(40)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  const hello = plain.findIndex((l) => l.includes("hello"));
  const done = plain.findIndex((l) => l.includes("after the fold"));
  const heading = plain.findIndex(
    (l, i) => i > hello && i < done && l.includes("ann · mock"),
  );
  assert.ok(hello >= 0 && done > hello, plain.join("\n"));
  assert.ok(heading >= 0, plain.join("\n"));
});

/** Draws every item at one width, as the full-window tests do. */
function layoutAll(parts: ReturnType<typeof transcriptParts>, width: number) {
  const rows = parts.transcript.render(width);
  parts.scroll.updateLayout(rows.length, Number.MAX_SAFE_INTEGER, () => {});
  return rows;
}

test("a redraw repairs the open run's last-row height estimate", () => {
  const state = newRoomState();
  state.timeline = Array.from({ length: 3 }, (_, i) => ({
    seq: i + 1,
    at: "2026-10-31T00:00:00Z",
    participantId: "p-ann",
    type: "tool",
    toolCallId: `t${i}`,
    title: `Tool ${i}`,
    kind: "read",
    status: "completed",
  })) as Entry[];
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 20,
  });
  parts.redraw();
  const model = parts.model();
  assert.ok(model);
  const total = model.total;
  const rows = parts.transcript.render(80, true);
  assert.equal(
    total,
    rows.length,
    "the model's total matches the rows it draws",
  );
});

test("a rows-only viewport growth mounts the whole new viewport", () => {
  const state = newRoomState();
  state.timeline = Array.from({ length: 100 }, (_, i) => ({
    seq: i + 1,
    at: "2026-10-31T00:00:00Z",
    participantId: "p-ann",
    type: "stall",
    kind: "idle",
    text: `line ${i}`,
  })) as Entry[];
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  let viewport = 10;
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => viewport,
  });
  parts.redraw();
  const rows = parts.transcript.render(80);
  parts.scroll.updateLayout(rows.length, viewport, () => {});
  const model = parts.model();
  assert.ok(model);
  viewport = 30;
  parts.transcript.render(80);
  const top = model.total - 30;
  // One-row notices make the private 8-row margin exact. A change to the
  // margin moves one of these two boundaries and fails the test.
  const start = top - 8;
  assert.ok(model.at(top)?.parts, "the new viewport is covered");
  assert.ok(model.at(start)?.parts, "the lower margin is mounted");
  assert.equal(
    model.at(start - 1)?.parts,
    undefined,
    "the window stays bounded",
  );
});

test("the exit render does not restore a reading anchor", () => {
  const state = newRoomState();
  state.timeline = Array.from({ length: 100 }, (_, i) => ({
    seq: i + 1,
    at: "2026-10-31T00:00:00Z",
    participantId: "p-ann",
    type: "stall",
    kind: "idle",
    text: `line ${i}`,
  })) as Entry[];
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 10,
  });
  parts.redraw();
  const rows = parts.transcript.render(80);
  parts.scroll.updateLayout(rows.length, 10, () => {});
  const model = parts.model();
  assert.ok(model);
  // Make one item above the anchor differ from its last measurement.
  const drifted = model.at(1);
  assert.ok(drifted);
  model.measure(drifted, drifted.height + 1);
  parts.scroll.scrollTo(5, { disableFollow: true });
  assert.equal(parts.scroll.isFollowingEnd, false);
  let synced = 0;
  let scrolled = 0;
  parts.transcript.syncScroll = () => {
    synced += 1;
  };
  parts.scroll.scrollTo = () => {
    scrolled += 1;
  };
  parts.transcript.render(80, true);
  assert.equal(synced, 0, "exit does not sync the viewport");
  assert.equal(scrolled, 0, "exit does not move the scroll anchor");
});

test("the model's tops follow a growing answer and a folded tool run", () => {
  const state = newRoomState();
  let seq = 0;
  const send = (participantId: string, update: Record<string, unknown>) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
  const line = (participantId: string, update: Record<string, unknown>) => {
    const e = send(participantId, update);
    assert.ok(e);
    return e;
  };
  send("p-ann", {
    sessionUpdate: "_client_participant_added",
    name: "ann",
    harness: "mock",
    mode: "auto",
  });
  line("p-ann", {
    sessionUpdate: "_client_user_message",
    text: "go",
    turn: 1,
  });
  const answer = line("p-ann", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "first paragraph\n\nsecond" },
  });
  const afterAnswer = line("p-bob", {
    sessionUpdate: "_client_stall_warning",
    kind: "idle",
    text: "marker",
  });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 1000,
  });
  parts.redraw();
  layoutAll(parts, 80);
  const model = parts.model();
  assert.ok(model);
  const before = model.topOf(afterAnswer);
  assert.equal(typeof before, "number");

  line("p-ann", {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: "\n\nthird paragraph with enough words to wrap at this width",
    },
  });
  parts.draw(state, answer);
  layoutAll(parts, 80);
  const grown = model.topOf(afterAnswer);
  assert.ok(grown !== undefined && grown > (before as number), "answer grew");

  for (let i = 0; i < 4; i++) {
    const tool = line("p-ann", {
      sessionUpdate: "tool_call",
      toolCallId: `t${i}`,
      title: `Read file ${i}.ts`,
      kind: "read",
      status: "completed",
    });
    parts.draw(state, tool);
  }
  const afterTools = line("p-bob", {
    sessionUpdate: "_client_stall_warning",
    kind: "idle",
    text: "after tools",
  });
  parts.draw(state, afterTools);
  layoutAll(parts, 80);
  const open = model.topOf(afterTools);
  assert.equal(typeof open, "number");

  const done = line("p-ann", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Done." },
  });
  parts.draw(state, done);
  layoutAll(parts, 80);
  const folded = model.topOf(afterTools);
  assert.ok(
    folded !== undefined && folded < (open as number),
    "the folded run takes fewer rows",
  );
});

test("width changes update the model's entry offsets", () => {
  const state = newRoomState();
  let seq = 0;
  const send = (participantId: string, update: Record<string, unknown>) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
  const line = (participantId: string, update: Record<string, unknown>) => {
    const e = send(participantId, update);
    assert.ok(e);
    return e;
  };
  send("p-ann", {
    sessionUpdate: "_client_participant_added",
    name: "ann",
    harness: "mock",
    mode: "auto",
  });
  line("p-ann", {
    sessionUpdate: "_client_user_message",
    text: "go",
    turn: 1,
  });
  line("p-ann", {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: "One long paragraph that has to wrap at the narrower width ".repeat(
        4,
      ),
    },
  });
  const sentinel = line("p-bob", {
    sessionUpdate: "_client_stall_warning",
    kind: "idle",
    text: "marker",
  });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 1000,
  });
  parts.redraw();
  layoutAll(parts, 80);
  const model = parts.model();
  assert.ok(model);
  const wide = model.topOf(sentinel);
  assert.equal(typeof wide, "number");
  layoutAll(parts, 30);
  const narrow = model.topOf(sentinel);
  assert.ok(
    narrow !== undefined && narrow > (wide as number),
    "the long answer wraps to more rows",
  );
});

test("a growing answer above a near-end view keeps its anchor", () => {
  const state = newRoomState();
  let seq = 0;
  const add = (participantId: string, update: Record<string, unknown>) => {
    const e = applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
    assert.ok(e);
    return e;
  };
  for (const [id, name] of [
    ["p-ann", "ann"],
    ["p-bob", "bob"],
  ]) {
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId: id,
      update: {
        sessionUpdate: "_client_participant_added",
        name,
        harness: "mock",
        mode: "auto",
      } as unknown as RoomEventLine["update"],
    });
  }
  add("p-ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  const answer = add("p-ann", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "first paragraph" },
  });
  for (let i = 0; i < 80; i++)
    add("p-bob", {
      sessionUpdate: "_client_stall_warning",
      kind: "idle",
      text: `line ${i}`,
    });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 10,
  });
  parts.redraw();
  let rows = parts.transcript.render(40);
  parts.scroll.updateLayout(rows.length, 10, () => {});
  parts.scroll.scrollTo(parts.scroll.scrollTop - 5, { disableFollow: true });
  const model = parts.model();
  assert.ok(model);
  const before = model.anchorAt(parts.scroll.scrollTop);
  assert.ok(before);
  const chunk = add("p-ann", {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: `\n\n${Array.from({ length: 30 }, (_, i) => `new paragraph ${i}`).join("\n\n")}`,
    },
  });
  assert.equal(chunk, answer, "the chunk grows the same answer");
  parts.draw(state, chunk);
  assert.equal(
    parts.scroll.scrollTop,
    model.rowAt(before),
    "anchor row follows",
  );
  rows = parts.transcript.render(40);
  parts.scroll.updateLayout(rows.length, 10, () => {});
  const after = model.anchorAt(parts.scroll.scrollTop);
  assert.equal(after?.item, before.item, "the same item stays at the top");
  assert.equal(after?.offset, before.offset, "at the same row in it");
});

test("an anchor row move requests the next frame without a measurement change", () => {
  const state = newRoomState();
  let seq = 0;
  const add = (participantId: string, update: Record<string, unknown>) => {
    const e = applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId,
      update: update as unknown as RoomEventLine["update"],
    });
    assert.ok(e);
    return e;
  };
  for (const [id, name] of [
    ["p-ann", "ann"],
    ["p-bob", "bob"],
  ]) {
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-31T00:00:00Z",
      roomId: "r1",
      participantId: id,
      update: {
        sessionUpdate: "_client_participant_added",
        name,
        harness: "mock",
        mode: "auto",
      } as unknown as RoomEventLine["update"],
    });
  }
  add("p-ann", { sessionUpdate: "_client_user_message", text: "go", turn: 1 });
  for (let i = 0; i < 80; i++)
    add("p-bob", {
      sessionUpdate: "_client_stall_warning",
      kind: "idle",
      text: `line ${i} with enough words to wrap at a narrow width`,
    });
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  let renders = 0;
  const parts = transcriptParts({
    tui: {
      requestRender() {
        renders += 1;
      },
    } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 10,
  });
  parts.redraw();
  const rows = parts.transcript.render(20);
  parts.scroll.updateLayout(rows.length, 10, () => {});
  parts.scroll.scrollTo(parts.scroll.scrollTop - 5, { disableFollow: true });
  const model = parts.model();
  assert.ok(model);
  const before = model.anchorAt(parts.scroll.scrollTop);
  assert.ok(before);
  const beforeRow = parts.scroll.scrollTop;
  // Return false even when the measurement lands, and leave the scroll
  // view's callback as the initial no-op. Only the anchor path can request.
  const measure = model.measure.bind(model);
  model.measure = (item, height) => {
    measure(item, height);
    return false;
  };
  parts.transcript.syncScroll = () => {};
  renders = 0;
  parts.transcript.render(40);
  assert.notEqual(parts.scroll.scrollTop, beforeRow, "the anchor row moved");
  assert.ok(renders > 0, "the moved anchor requests a redraw");
});

test("a width change keeps the same anchor item and offset", () => {
  const state = newRoomState();
  state.timeline = Array.from({ length: 80 }, (_, i) => ({
    seq: i + 1,
    at: "2026-10-31T00:00:00Z",
    participantId: "p-ann",
    type: "stall",
    kind: "idle",
    text: `line ${i} with enough words to wrap at a narrow width`,
  })) as Entry[];
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 10,
  });
  parts.redraw();
  let rows = parts.transcript.render(40);
  parts.scroll.updateLayout(rows.length, 10, () => {});
  parts.scroll.scrollTo(parts.scroll.scrollTop - 5, { disableFollow: true });
  const model = parts.model();
  assert.ok(model);
  const before = model.anchorAt(parts.scroll.scrollTop);
  assert.ok(before);
  rows = parts.transcript.render(20);
  parts.scroll.updateLayout(rows.length, 10, () => {});
  const after = model.anchorAt(parts.scroll.scrollTop);
  assert.equal(after?.item, before.item, "the same item stays at the top");
  assert.equal(after?.offset, before.offset, "at the same row in it");
});

/** A room with `count` simple user messages, ready for the window test. */
function largeTranscript(count: number) {
  const state = newRoomState();
  state.timeline = Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    at: "2026-10-31T00:00:00Z",
    participantId: "p-ann",
    type: "user",
    text: `message ${i}`,
    turn: i + 1,
  })) as Entry[];
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 20,
  });
  parts.redraw();
  const model = parts.model();
  assert.ok(model);
  model.resetStats();
  const rows = parts.transcript.render(80);
  return {
    rows,
    stats: {
      entriesVisited: model.stats.entriesVisited,
      partsCreated: model.stats.partsCreated,
      partsRendered: model.stats.partsRendered,
    },
    built: model.stats.entriesBuilt,
  };
}

test("10k and 50k entries render the same bounded window and visit the same number of entries", () => {
  const ten = largeTranscript(10_000);
  const fifty = largeTranscript(50_000);
  assert.equal(ten.built, 10_000);
  assert.equal(fifty.built, 50_000);
  assert.deepEqual(fifty.stats, ten.stats);
  assert.ok(ten.stats.entriesVisited < 100, "only the window is visited");
  assert.ok(ten.stats.partsCreated < 200, "only the window is created");
  assert.ok(ten.stats.partsRendered < 200, "only the window renders");
  assert.ok(ten.rows.length > 0);
  assert.ok(fifty.rows.length > 0);
});

/** A room whose only content is one folded run of `count` tool calls. */
test("the virtual model keeps the rail's messages and their offsets", () => {
  const state = newRoomState();
  const user = (seq: number, text: string): Entry => ({
    seq,
    at: "2026-11-01T00:00:00Z",
    participantId: "p-ann",
    type: "user",
    text,
  });
  const first = user(1, "first");
  const reply = { ...user(2, "reply"), kind: "reply" } as Entry;
  const answer: Entry = {
    seq: 3,
    at: "2026-11-01T00:00:00Z",
    participantId: "p-ann",
    type: "answer",
    text: "short",
  };
  const second = user(4, "second");
  state.timeline = [first, reply, answer, second];
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 1000,
  });
  parts.redraw();
  layoutAll(parts, 80);
  const model = parts.model();
  assert.ok(model);
  assert.equal(model.markCount, 2, "a daemon reply is not a mark");
  assert.deepEqual(
    [model.markEntry(0), model.markEntry(1)],
    messages(state.timeline),
    "the mark index keeps message order and the history selector",
  );
  const before = model.markTop(1);
  assert.equal(typeof before, "number");

  (answer as Entry & { type: "answer" }).text =
    "first paragraph\n\n" +
    Array.from(
      { length: 20 },
      (_, i) =>
        `Paragraph ${i} has enough words to wrap again beside a narrower transcript.`,
    ).join("\n\n");
  parts.draw(state, answer);
  layoutAll(parts, 80);
  const grown = model.markTop(1);
  assert.ok(grown !== undefined && grown > (before as number), "answer grew");

  layoutAll(parts, 30);
  const narrow = model.markTop(1);
  assert.ok(
    narrow !== undefined && narrow > grown,
    "the mark follows the width change",
  );
});

test("a 10k-message rail finds its active mark without a timeline walk", () => {
  const state = newRoomState();
  state.timeline = Array.from({ length: 10_000 }, (_, i) => ({
    seq: i + 1,
    at: "2026-11-01T00:00:00Z",
    participantId: "p-ann",
    type: "user",
    text: `message ${i}`,
  })) as Entry[];
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 20,
  });
  parts.redraw();
  const rows = parts.transcript.render(80);
  parts.scroll.updateLayout(rows.length, 20, () => {});
  const model = parts.model();
  assert.ok(model);
  assert.equal(model.markCount, 10_000);
  model.resetStats();
  const active = activeMark(
    10_000,
    (i) => model.markTop(i) ?? 0,
    parts.scroll.scrollTop,
  );
  assert.equal(typeof active, "number");
  assert.ok(
    model.stats.markTops < 50,
    `the lookup touches ${model.stats.markTops} marks`,
  );
  assert.equal(model.markEntry(9_999)?.text, "message 9999");
  assert.ok(model.stats.entriesVisited < 100);
});

function largeFoldedRun(count: number) {
  const state = newRoomState();
  let toolVisits = 0;
  const tools: Entry[] = Array.from({ length: count }, (_, i) => {
    const tool = {
      seq: i + 1,
      at: "2026-10-31T00:00:00Z",
      participantId: "p-ann",
      type: "tool",
      toolCallId: `t${i}`,
      title: `Tool ${i}`,
    } as Entry;
    Object.defineProperty(tool, "kind", {
      enumerable: true,
      get() {
        toolVisits += 1;
        return "read";
      },
    });
    Object.defineProperty(tool, "status", {
      enumerable: true,
      get() {
        toolVisits += 1;
        return "completed";
      },
    });
    return tool;
  });
  const answer: Entry = {
    seq: count + 1,
    at: "2026-10-31T00:00:01Z",
    participantId: "p-ann",
    type: "answer",
    text: "done",
  };
  state.timeline = [...tools, answer];
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 20,
  });
  parts.redraw();
  const model = parts.model();
  assert.ok(model);
  model.resetStats();
  // Building the summary once may read every call; drawing it again must not.
  toolVisits = 0;
  const rows = parts.transcript.render(80);
  return {
    rows,
    toolVisits,
    partStats: {
      entriesVisited: model.stats.entriesVisited,
      partsCreated: model.stats.partsCreated,
      partsRendered: model.stats.partsRendered,
    },
    built: model.stats.entriesBuilt,
  };
}

test("10k and 50k folded calls render only the run's summary", () => {
  const ten = largeFoldedRun(10_000);
  const fifty = largeFoldedRun(50_000);
  assert.equal(ten.built, 10_001);
  assert.equal(fifty.built, 50_001);
  for (const run of [ten, fifty]) {
    const stats = run.partStats;
    assert.ok(stats.entriesVisited < 100, "only the window is visited");
    assert.ok(stats.partsCreated < 200, "only the window is created");
    assert.ok(stats.partsRendered < 200, "only the window renders");
    assert.ok(run.toolVisits < 100, "the summary does not visit every tool");
  }
  assert.ok(ten.rows.length > 0);
  assert.ok(fifty.rows.length > 0);
});

test("folding and opening a long run builds only its summary and window", () => {
  const state = newRoomState();
  state.timeline = Array.from({ length: 10_000 }, (_, i) => ({
    seq: i + 1,
    at: "2026-10-31T00:00:00Z",
    participantId: "p-ann",
    type: "tool",
    toolCallId: `t${i}`,
    title: `Tool ${i}`,
    kind: "read",
    status: "completed",
  })) as Entry[];
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
    viewportRows: () => 20,
  });
  parts.redraw();
  const model = parts.model();
  assert.ok(model);
  model.resetStats();
  const answer: Entry = {
    seq: 10_001,
    at: "2026-10-31T00:00:01Z",
    participantId: "p-ann",
    type: "answer",
    text: "done",
  };
  state.timeline.push(answer);
  parts.draw(state, answer);
  assert.ok(model.stats.partsCreated < 100, "a fold creates only its summary");
  assert.ok(model.stats.partsRendered < 100, "a fold renders only its summary");
  let rows = parts.transcript.render(80);
  parts.scroll.updateLayout(rows.length, 20, () => {});
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const plain = rows.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  const y = plain.findIndex((l) => l.includes("▸ 10000 tool calls"));
  assert.ok(y >= 0, plain.join("\n"));
  model.resetStats();
  assert.equal(
    parts.transcript.handleMouse({
      type: "click",
      button: "left",
      x: 4,
      y,
      width: 80,
      height: rows.length,
    } as never)?.handled,
    true,
  );
  assert.ok(model.stats.partsCreated < 100, "opening creates only the window");
  assert.ok(model.stats.partsRendered < 100, "opening renders only the window");
  model.resetStats();
  rows = parts.transcript.render(80);
  assert.ok(model.stats.partsCreated < 100, "the open window stays bounded");
  assert.ok(model.stats.partsRendered < 100, "the open window renders bounded");
  assert.ok(rows.length > 0);
});
