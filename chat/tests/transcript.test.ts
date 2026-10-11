/**
 * An answer's finished blocks — `settled` in `chat/tui/transcript.ts`,
 * story M4-4 (#50). Markdown cut where it says draws as it does whole.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type Container,
  Markdown,
  Text,
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
  // A live call ends with the spinner (M7-2).
  assert.ok(
    plain.some((l) => /^▎ · Read File [◐◓◑◒]$/.test(l)),
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
  const rows = parts.transcript.render(40).map((l) => l.trimEnd());
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
  const plain = rows.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim());
  // After the agent's bar (M7-1).
  assert.deepEqual(plain.slice(-2), ["▎ · edit ✗", "▎   /w/a.ts"]);
  assert.ok(rows.at(-2)?.includes("\x1b[31m ✗"), "failed is red");
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
      .render(width)
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
  // The live run is open, each row with its mark and the edit's counts.
  assert.ok(plain().includes("▎ · Read a.ts ✓"), plain().join("\n"));
  assert.ok(plain().includes("▎ · Edit a.ts +2 −1 ✗"));
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
  assert.deepEqual(open.slice(at + 1, at + 4), [
    "▎ · Read a.ts ✓",
    "▎ · Read b.ts ✓",
    "▎ · Edit a.ts +2 −1 ✗",
  ]);
  // It stays open after a redraw, as after a switch.
  parts.redraw();
  assert.ok(plain().includes("▎ · Read a.ts ✓"), "open after a redraw");
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
    plain().some((l) => /^▎ · Run tests [◐◓◑◒]$/.test(l)),
    plain().join("\n"),
  );
  send("ann", { sessionUpdate: "_client_turn_ended", stopReason: "end_turn" });
  assert.ok(
    plain().includes("▎ ▸ 1 tool call · 1 execute"),
    "the end folds it",
  );
  click("▸ 1 tool call");
  assert.ok(plain().includes("▎ · Run tests"), "no mark once the turn ended");
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
  assert.ok(plain().includes("▎ · Read a.ts ✓"), plain().join("\n"));
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
