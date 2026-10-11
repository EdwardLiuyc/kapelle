/**
 * A harness's text made safe for a terminal (#229).
 *
 * pi-tui's `Markdown` and `marked` pass an escape sequence through, so an
 * answer that holds `ESC]52` could write the clipboard and one with `ESC[2J`
 * could clear the screen. Every string a harness sends that we print goes
 * through `clean` first: `render.ts`, `cli.ts` and the `--mode ask` prompt.
 *
 * `client/room.ts` has the same rule as `cleanLines`, because `client/` may
 * not import `core/`. `tests/text.test.ts` checks that the two agree.
 */

/**
 * Each control and format character is a space, and a tab is four spaces.
 * `\n` stays, and so does the zero-width joiner, so a family emoji is one
 * emoji.
 */
export const clean = (s: string) =>
  s
    .replaceAll("\t", "    ")
    .replace(/[[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]--[\n\u200D]]/gv, " ");

/** `clean`, on one line: for a prompt, where a new line could draw a fake
 *  question under the real one. */
export const oneLine = (s: string) => clean(s).replaceAll("\n", " ");
