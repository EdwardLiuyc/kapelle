/**
 * Markdown for the terminal — story M1c-7, issue #78.
 *
 * The schema is normative and we did not follow it: on the text variant of
 * `ContentBlock`, *"Clients SHOULD render this text as Markdown."* We are the
 * client, so headers, tables and fences used to reach the terminal as literal
 * `##`, `|` and backticks.
 *
 * **This is the only file that knows a markdown library exists.** `render.ts`
 * calls `toAnsi`; M4-1's `dashboard-js-render` adds `toHtml` here — one line,
 * `marked.parse(md)` — when it has a consumer. It is not exported yet because
 * `npm run knip` fails on an export nobody imports, and a speculative export
 * bought with a config exception is worse than the line M4 will write.
 *
 * **`marked` 18 is the project's first runtime dependency** (exception
 * ratified 2026-09-09, see `README.md`): presentation only, downstream of the
 * bus, pinned exactly, and `toAnsi` falls back to the raw source on any throw,
 * so a bad release costs the screen and never the run.
 *
 * `md4x`, the package the story recommended, was dropped at pickup on
 * measurement: 0.0.29 renders `- one\n  - alpha` as `* one  * alpha`, gluing
 * the child onto the parent line, and joins table cells with tabs.
 *
 * **Reference, not vendored:** `earendil-works/pi` (MIT),
 * `packages/tui/src/components/markdown.ts` — the same `marked`-plus-own-paint
 * choice. Two shapes are taken from it: a list rendered as a marker prefix
 * plus a continuation pad of the same visible width (`renderList`, its :756),
 * and a table that prints its own raw markdown rather than a broken box when
 * the terminal is too narrow (`renderTable`, its :842). Its 1337-line
 * `utils.ts` — grapheme segmentation, emoji width, ANSI-aware wrapping — is
 * the tail we decline, which is why nothing here wraps text: the terminal
 * does that, and `width` is read by the table renderer alone.
 */

import { marked, type Token, type Tokens } from "marked";

const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
const strike = (s: string) => `\x1b[9m${s}\x1b[29m`;
const underline = (s: string) => `\x1b[4m${s}\x1b[24m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;

const DEFAULT_WIDTH = 80;
/** Narrower than this and a column holds one character plus the ellipsis. */
const MIN_COLUMN = 3;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/**
 * Index just past the first **complete** block in `text`, or `-1` if none has
 * closed yet. Pure, and separate from the drawing on purpose (M1a-1): the
 * boundary rule is a truth table, the repaint is not.
 *
 * A block is one top-level unit — paragraph, heading, list, table, fenced
 * code — and a blank line ends it. Two things stop that rule being naive:
 *
 * - A blank line **inside a fence** does not close it, so the scan tracks the
 *   open marker and the closing run must be at least as long and of the same
 *   character.
 * - A blank line inside a **loose list** does not close it either — in
 *   CommonMark `- a\n\n- b` is one list, not two, and splitting it would
 *   restart the numbering of an ordered list mid-way. So a list, and only a
 *   list, waits one line to see whether what follows continues it. Everything
 *   else closes at the blank line immediately, because waiting would leave a
 *   finished paragraph unrendered while the next one is still being typed.
 *
 * A trailing line with no newline is still arriving, so it never closes a
 * block; the end of a turn flushes whatever is left.
 */
export function blockEnd(text: string): number {
  let fence: string | null = null;
  let isList = false;
  let content = false;
  let pending = -1;
  let pos = 0;

  for (;;) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) return -1;
    const line = text.slice(pos, nl);
    const next = nl + 1;
    const blank = line.trim() === "";

    if (pending >= 0) {
      if (blank) {
        pending = next;
      } else if (LIST_ITEM.test(line) || /^ {2,}\S/.test(line)) {
        pending = -1;
      } else {
        return pending;
      }
    }

    if (pending < 0) {
      if (fence) {
        if (closesFence(line, fence)) fence = null;
      } else {
        const open = FENCE.exec(line);
        if (open) {
          fence = open[1];
          content = true;
        } else if (blank) {
          // Leading blank lines belong to no block; they are skipped here and
          // handed to the renderer, which drops them.
          if (content) {
            if (!isList) return next;
            pending = next;
          }
        } else {
          if (!content) isList = LIST_ITEM.test(line);
          content = true;
        }
      }
    }
    pos = next;
  }
}

function closesFence(line: string, fence: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
}

/**
 * Markdown to ANSI. `width` is the terminal's column count and reaches the
 * table renderer only — long lines are left for the terminal to wrap.
 *
 * Returns the source unchanged if the parser or the walker throws. That
 * fallback is the whole of what makes the dependency affordable: its worst
 * outcome is the screen we had before this story.
 */
export function toAnsi(md: string, opts: { width?: number } = {}): string {
  try {
    const lines = renderBlocks(marked.lexer(md), opts.width ?? DEFAULT_WIDTH);
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  } catch {
    return md;
  }
}

/** Blocks, separated by one blank line. Empty renderings take no separator. */
function renderBlocks(tokens: Token[], width: number): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const lines = renderBlock(token, width);
    if (lines.length === 0) continue;
    if (out.length > 0) out.push("");
    out.push(...lines);
  }
  return out;
}

function renderBlock(token: Token, width: number): string[] {
  switch (token.type) {
    case "space":
    case "def":
      return [];

    case "heading":
      return split(bold(magenta(inline((token as Tokens.Heading).tokens))));

    case "paragraph":
    case "text": {
      const t = token as Tokens.Paragraph | Tokens.Text;
      return split(t.tokens ? inline(t.tokens) : t.text);
    }

    case "code":
      // Indented and dim rather than syntax-highlighted: a highlighter is a
      // second dependency (pi carries `highlight.js` for it) and this story
      // buys one.
      return (token as Tokens.Code).text
        .split("\n")
        .map((l) => (l === "" ? "" : dim(`  ${l}`)));

    case "blockquote":
      return renderBlocks((token as Tokens.Blockquote).tokens, width - 2).map(
        (l) => dim("│ ") + l,
      );

    case "hr":
      return [dim("─".repeat(Math.max(1, Math.min(width, DEFAULT_WIDTH))))];

    case "list":
      return renderList(token as Tokens.List, width);

    case "table":
      return renderTable(token as Tokens.Table, width);

    case "html":
      return split((token as Tokens.HTML).text.replace(/\n$/, ""));

    default:
      return split((token as Tokens.Generic).raw?.replace(/\n$/, "") ?? "");
  }
}

/**
 * The shape taken from pi: a marker prefix on the first line, and a pad of the
 * same visible width on every line after it. Nesting falls out of it — a child
 * list renders its own markers and the parent's pad indents the whole thing.
 */
function renderList(token: Tokens.List, width: number): string[] {
  const out: string[] = [];
  const start = typeof token.start === "number" ? token.start : 1;

  token.items.forEach((item, i) => {
    const marker = token.ordered ? `${start + i}. ` : "- ";
    const task = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
    const first = dim(marker) + task;
    const pad = " ".repeat(marker.length + task.length);
    let firstLine = true;

    for (const child of item.tokens ?? []) {
      for (const line of renderBlock(child, width - pad.length)) {
        out.push((firstLine ? first : pad) + line);
        firstLine = false;
      }
    }
    if (firstLine) out.push(first);
  });

  return out;
}

function renderTable(token: Tokens.Table, width: number): string[] {
  const n = token.header.length;
  if (n === 0) return [];

  const rows = [
    token.header.map((c) => bold(inline(c.tokens))),
    ...token.rows.map((r) => r.map((c) => inline(c.tokens))),
  ];

  const natural = new Array<number>(n).fill(0);
  for (const row of rows) {
    for (let i = 0; i < n; i++) {
      natural[i] = Math.max(natural[i], visibleWidth(row[i] ?? ""));
    }
  }

  // "│ " + " │ " between each pair + " │"
  const overhead = 3 * n + 1;
  const budget = width - overhead;
  // Pi's fallback: below the point where a table can be read, printing the
  // source beats printing a broken box.
  if (budget < n * MIN_COLUMN) return split(token.raw.replace(/\n+$/, ""));
  const cols = fit(natural, budget);

  const rule = (l: string, mid: string, r: string) =>
    dim(l + cols.map((w) => "─".repeat(w + 2)).join(mid) + r);
  const line = (row: string[]) =>
    dim("│ ") +
    cols.map((w, i) => clip(row[i] ?? "", w)).join(dim(" │ ")) +
    dim(" │");

  return [
    rule("┌", "┬", "┐"),
    line(rows[0]),
    rule("├", "┼", "┤"),
    ...rows.slice(1).map(line),
    rule("└", "┴", "┘"),
  ];
}

/** Take from the widest column until the row fits. */
function fit(natural: number[], budget: number): number[] {
  const cols = [...natural];
  let total = cols.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = 0;
    for (let i = 1; i < cols.length; i++) {
      if (cols[i] > cols[widest]) widest = i;
    }
    cols[widest]--;
    total--;
  }
  return cols;
}

function inline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out += bold(inline((token as Tokens.Strong).tokens));
        break;
      case "em":
        out += italic(inline((token as Tokens.Em).tokens));
        break;
      case "del":
        out += strike(inline((token as Tokens.Del).tokens));
        break;
      case "codespan":
        out += cyan((token as Tokens.Codespan).text);
        break;
      case "link": {
        const l = token as Tokens.Link;
        const text = inline(l.tokens);
        out += underline(text) + (text === l.href ? "" : dim(` (${l.href})`));
        break;
      }
      case "image":
        out += dim(`[image: ${(token as Tokens.Image).text}]`);
        break;
      case "br":
        out += "\n";
        break;
      case "text": {
        const t = token as Tokens.Text;
        out += t.tokens ? inline(t.tokens) : t.text;
        break;
      }
      default:
        out +=
          (token as Tokens.Generic).text ?? (token as Tokens.Generic).raw ?? "";
    }
  }
  return out;
}

const split = (s: string): string[] => (s === "" ? [] : s.split("\n"));

// biome-ignore lint/suspicious/noControlCharactersInRegex: measuring text, not escapes.
const SGR = /\x1b\[[0-9;]*m/g;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Coarse East Asian Wide / Fullwidth ranges, plus the emoji planes.
 * ponytail: a range list, not the Unicode table — pi buys
 * `get-east-asian-width` for the exact answer. Widen it if a script shows up
 * that these ranges miss.
 */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u;

/**
 * Display columns, with the colour removed.
 *
 * **Counted in graphemes, not code points, and that is the load-bearing part**
 * — `render.ts` measures the rows it drew with this before erasing them, so an
 * over-count moves the cursor up past its own output and erases whatever was
 * above it, the agent's thinking included. A family emoji is five code points
 * and one grapheme; `Intl.Segmenter` is in the standard library and gets that
 * right where `[...s].length` does not. Wide glyphs count two, so a CJK line is
 * not under-counted either, which would leave the raw text behind on screen.
 */
export function displayWidth(s: string): number {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(s.replace(SGR, ""))) {
    width += WIDE.test(segment) ? 2 : 1;
  }
  return width;
}

const visibleWidth = displayWidth;

function clip(s: string, w: number): string {
  const shown = visibleWidth(s);
  if (shown <= w) return s + " ".repeat(w - shown);
  const plain = [...s.replace(SGR, "")];
  return `${plain.slice(0, Math.max(0, w - 1)).join("")}…`;
}
