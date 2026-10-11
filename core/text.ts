/**
 * A harness's text made safe for a terminal (#229).
 *
 * pi-tui's `Markdown` and `marked` pass an escape sequence through, so an
 * answer that holds `ESC]52` could write the clipboard and one with `ESC[2J`
 * could clear the screen. Every string a harness sends that we print goes
 * through `clean` first: `render.ts`, `cli.ts` and the `--mode ask` prompt.
 *
 * `client/room.ts` has the same two rules, `cleanLines` and `printable`,
 * because `client/` may not import `core/`. `tests/text.test.ts` checks that
 * each pair agrees.
 *
 * Use `oneLine` for a title, a path or a notice, and `clean` where lines are
 * wanted: an answer, its prose, an error. `--verbose` is the one deliberate
 * exception: it echoes the harness's stderr as sent, because that is what it
 * is for.
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

/** Every control, format and separator character a space, `\n` and tab too:
 *  for a title or a notice, where a new line could draw a fake question or a
 *  fake `! ` line under the real one. The same as `printable`, so the CLI and
 *  the chat screens draw a title the same way. */
export const oneLine = (s: string) =>
  s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
