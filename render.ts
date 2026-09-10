/**
 * Terminal formatting for one event off the bus — story M1a-7, issue #15.
 *
 * Pure presentation. It reads the wire object and writes characters; it makes
 * no protocol decision, which is why it sits outside `protocol/` and why the
 * dependency arrow only ever points at it.
 *
 * **The switch deliberately has no `default`** (CLAUDE.md). A variant nobody
 * renders is dropped in silence rather than drawn wrong — M0-1 observed two
 * that arrive today and have no branch here: `available_commands_update` from
 * all three harnesses, and `config_option_update` from copilot. `assertNever`
 * would be wrong here: it would turn an unrendered-but-valid notification into
 * a crash. (`plan` is the mirror case — it *has* a branch, and no harness M0-1
 * measured emits one, so `mock-agent.mjs` is the only thing that drives it.)
 */

import { blockEnd, displayWidth, toAnsi } from "./core/markdown.ts";
import type { AgentEventEnvelope } from "./protocol/agent.ts";
import type { ContentBlock } from "./protocol/types.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/**
 * Which stream is open on the current line, so the next write knows whether to
 * continue it or close it first. Prose and thinking both arrive a few tokens at
 * a time; the only difference is that thinking is dim and announces itself once.
 */
let stream: "none" | "message" | "thought" = "none";

/**
 * The markdown repaint — story M1c-7, issue #78. **Draw raw live, repaint one
 * block at a time.**
 *
 * Text arrives a few tokens at a time and markdown cannot be parsed until a
 * construct closes, so chunks print raw exactly as they used to and the live
 * feel is unchanged. When `core/markdown.ts` says a block has closed, the rows
 * just drawn are erased and the rendered block replaces them. Blocks already
 * replaced are finished and never touched again.
 *
 * `buf` is the source of the block being collected; `drawn` is the prefix of
 * it that is on the screen, which is what the erase is measured against.
 *
 * **This is a single-writer renderer and must stay one.** The erase moves the
 * cursor up over the rows it drew, which is only correct while one thing owns
 * the cursor — hence module-level state, one variable per process rather than
 * one per agent. `cli.ts:185` subscribes this on the single-agent path only;
 * the `--file` path prints milestones and buffers prose instead. Making the
 * state per-agent looks like the fix for that and is not: it stops the output
 * corrupting and leaves it unreadable.
 */
let buf = "";
let drawn = "";
/** Whether the cursor sits at column 0, so `endStream` knows to close a line. */
let atCol0 = true;

/**
 * The repaint is skipped — raw printed, move on — when stdout is not a TTY or
 * `NO_COLOR` is set. Non-TTY is the common case: CI and `npm run selftest`
 * both pipe, and a piped run must read as plain markdown source with no cursor
 * escapes in it. These are the only escape hatches; no new flag.
 */
const canRepaint = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function emit(s: string) {
  if (s === "") return;
  process.stdout.write(s);
  atCol0 = s.endsWith("\n");
}

/** Rows `drawn` occupies, counting the terminal's own wrapping. */
function drawnRows(): number {
  const columns = process.stdout.columns || 80;
  let rows = 0;
  for (const l of drawn.split("\n")) {
    rows += Math.max(1, Math.ceil(displayWidth(l) / columns));
  }
  return rows;
}

/**
 * Replace the rows `drawn` occupies with the rendered form of `block`.
 *
 * Declines — finishing the block raw instead — when it is taller than the
 * screen, because the rows scrolled off the top cannot be erased and the
 * cursor arithmetic would eat whatever is above them.
 */
function paint(block: string) {
  const rows = drawnRows();
  if (rows > (process.stdout.rows || 24) - 1) {
    // `drawn` can outrun the block: a loose list holds its boundary open for
    // one line, so by the time it closes the next block's first line is on
    // screen. Draw only what is missing and keep the overhang for that block.
    emit(block.slice(Math.min(drawn.length, block.length)));
    drawn = drawn.slice(block.length);
    return;
  }

  // Up to the first row drawn, then clear to the end of the screen.
  process.stdout.write(rows > 1 ? `\r\x1b[${rows - 1}A\x1b[J` : "\r\x1b[J");
  atCol0 = true;
  // `toAnsi` drops the blank line that closed the block; put it back, so the
  // gap between two paragraphs survives the repaint.
  const gap = /\n[ \t]*\n$/.test(block) ? "\n" : "";
  emit(toAnsi(block, { width: process.stdout.columns || 80 }) + gap);
  drawn = "";
}

function endStream() {
  if (stream === "none") return;
  if (stream === "message") {
    // The end of a turn, or any `line()` event, flushes what is left — which
    // is what keeps a tool call from landing inside an open paragraph.
    if (buf !== "") {
      paint(buf);
      buf = "";
    }
    drawn = "";
    if (!atCol0) emit("\n");
  } else {
    process.stdout.write("\n");
  }
  stream = "none";
  atCol0 = true;
}

/** Flush the open block at the end of a turn. `cli.ts` prints past `render`. */
export function flushStream(): void {
  endStream();
}

/** Text is the only block this client draws; anything else renders as nothing. */
const textOf = (c: ContentBlock | undefined): string | undefined =>
  c?.type === "text" ? c.text : undefined;

function line(s: string) {
  endStream();
  process.stdout.write(`${s}\n`);
}

/** Pretty-print a session/update notification. */
export function render({ agent, update }: AgentEventEnvelope): void {
  const tag = dim(`[${agent}]`);

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update.content);
      if (!text) break;
      if (stream !== "message") endStream();
      stream = "message";
      if (!canRepaint()) {
        emit(text);
        break;
      }
      buf += text;
      for (let end = blockEnd(buf); end >= 0; end = blockEnd(buf)) {
        paint(buf.slice(0, end));
        buf = buf.slice(end);
      }
      emit(buf.slice(drawn.length));
      drawn = buf;
      break;
    }

    case "agent_thought_chunk": {
      // Streamed like prose, for the same reason: a real harness sends a single
      // thought as many small chunks, and one prefixed line per chunk cut every
      // sentence into unreadable fragments. The prefix is kept — it is what
      // separates thinking from what the agent is actually saying — but it is
      // printed once per run of thinking, not once per chunk.
      const text = textOf(update.content);
      if (!text) break;
      let said = text;
      if (stream !== "thought") {
        endStream();
        // Built from `agent` rather than `tag`: nesting dim inside dim ends the
        // run at the inner reset, and the words after it lose the dimming.
        emit(dim(`[${agent}] thinking: `));
        // The prefix already supplies the space, and a chunk that opens a run
        // often starts mid-sentence with one.
        said = text.trimStart();
        stream = "thought";
      }
      // Through `emit`, so `atCol0` stays true of the cursor even though a
      // thought is never buffered or repainted.
      emit(dim(said));
      break;
    }

    case "tool_call":
      line(
        `${tag} ${cyan("→")} ${update.title ?? "(tool)"} ${dim(`[${update.kind ?? "other"}]`)}`,
      );
      break;

    case "tool_call_update":
      if (update.status === "failed") {
        line(`${tag} ${red("✗")} tool ${update.toolCallId} failed`);
      } else if (update.status === "completed") {
        for (const c of update.content ?? []) {
          if (c.type === "diff") line(`${tag} ${green("±")} ${c.path}`);
        }
      }
      break;

    case "plan":
      line(`${tag} plan:`);
      for (const e of update.entries ?? []) {
        line(dim(`     • ${e.content}`));
      }
      break;

    case "usage_update":
      line(dim(`${tag} context ${update.used}/${update.size} tokens`));
      break;

    // Synthetic events emitted by our client, not the protocol.
    case "_client_permission":
      line(
        update.allow
          ? `${tag} ${green("✓ allowed")} ${update.title}`
          : `${tag} ${red("✗ refused")} ${update.title} ${dim(`[${update.kind}]`)}`,
      );
      break;

    case "_client_wrote_file":
      line(`${tag} ${green("wrote")} ${update.path}`);
      break;

    // `_client_permission_pending` is deliberately not drawn (M1c-4). Under
    // `ask` the prompt itself is already on screen and `core/notify.ts` writes
    // the alert line; under `safe`/`auto` the decision is instant and the
    // `_client_permission` arm above says what it was. Drawing it here would
    // print two lines per decision, one of them announcing a wait that never
    // happened.
  }
}
