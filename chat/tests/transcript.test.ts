/**
 * An answer's finished blocks — `settled` in `chat/tui/transcript.ts`,
 * story M4-4 (#50). Markdown cut where it says draws as it does whole.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type Container,
  Markdown,
  type TuiAltScreen,
} from "@earendil-works/pi-tui";
import type { RoomEventLine } from "../../client/contract.ts";
import { applyLine, newRoomState } from "../../client/room.ts";
import type { Followed } from "../../client/roomset.ts";
import { inverse } from "../common.ts";
import { settled, transcriptParts } from "../tui/transcript.ts";

const id = (s: string) => s;
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
  assert.ok(alpha);
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const { transcript, scroll, redraw, jump } = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
  });
  redraw();
  const lines = transcript.render(40).map((l) => l.trim());
  scroll.updateLayout(lines.length, 3, () => {});
  // At the end, as a long transcript is: the jump goes back up.
  scroll.scrollToEnd();
  jump(alpha);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const plain = (l?: string) => l?.replace(/\x1b\[[0-9;]*m/g, "").trim();
  assert.equal(plain(lines[scroll.scrollTop]), "▎ you → ann");
  assert.equal(plain(lines[scroll.scrollTop + 1]), "▎ alpha");
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
  const bar = parts.transcript.children.at(-1) as Container;
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

/** ana's turn: a thought, an answer and a tool call, drawn in r1's
 *  timeline. */
function look() {
  const state = newRoomState();
  let seq = 0;
  const line = (update: Record<string, unknown>) =>
    applyLine(state, {
      seq: ++seq,
      at: "2026-10-10T09:05:00Z",
      roomId: "r1",
      participantId: "p-ana",
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
  const rooms = new Map([
    ["r1", { entry: { id: "r1", cwd: "/tmp" }, state } as unknown as Followed],
  ]);
  const parts = transcriptParts({
    tui: { requestRender() {} } as unknown as TuiAltScreen,
    rooms,
    view: () => ({ roomId: "r1" }),
    setStatus() {},
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
  assert.ok(plain.includes("▎ · Read File"), "the tool call too");
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

test("NO_COLOR: the transcript has no colour code, and inverse stays (M7-1)", (t) => {
  const was = process.env.NO_COLOR;
  t.after(() => {
    if (was === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = was;
  });
  process.env.NO_COLOR = "1";
  const rows = look().join("");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  assert.doesNotMatch(rows, /\x1b\[(3[0-9]|4[0-9]|9[0-7]|10[0-7])[;m]/);
  assert.ok(rows.includes("\x1b[1m"), "bold stays");
  assert.equal(inverse("x"), "\x1b[7mx\x1b[27m", "the history cursor stays");
});
