/**
 * `chat/tui/backdrop.ts` — the screen behind an open pop-up (#407).
 *
 * Behind a pop-up, a line loses its colours and is drawn dim, so the box
 * stands out. **A background stays, in one gray.** Any span that had a
 * background gets `bg(235)`, so a tool call's block (#391) keeps its shape
 * instead of turning into empty rows. The rule reads only the SGR codes: it
 * does not know what drew the span or why. With `NO_COLOR`, `bg` adds
 * nothing, so no background is left.
 *
 * Each span closes its own background and the line closes its dim, so
 * nothing runs past a span or a line. The visible text is the same, so the
 * width is too.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { bg, dim } from "../common.ts";

const GRAY = bg(235);
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR codes
const SGR = /\x1b\[([0-9;:]*)m/g;

/** Whether a background is on after the SGR parameters `params`, given
 *  whether one was on before. `38`, `48` and `58` take `5;n` or `2;r;g;b`
 *  after them; those numbers are skipped, so `48;5;2` is not read as dim. */
const afterSgr = (params: string, on: boolean): boolean => {
  const p = params.split(";");
  for (let i = 0; i < p.length; i++) {
    const code = p[i] as string;
    const n = Number(code.split(":")[0] || 0);
    if (n === 0 || n === 49) on = false;
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107) || n === 48)
      on = true;
    if ((n === 38 || n === 48 || n === 58) && !code.includes(":"))
      i += p[i + 1] === "5" ? 2 : p[i + 1] === "2" ? 4 : 0;
  }
  return on;
};

const backdropLine = (line: string): string => {
  let out = "";
  let run = "";
  let runOn = false;
  let on = false;
  let at = 0;
  const flush = () => {
    out += runOn ? GRAY(run) : run;
    run = "";
  };
  const text = (s: string) => {
    const shown = stripTerminalSequences(s);
    if (!shown) return;
    if (on !== runOn) flush();
    runOn = on;
    run += shown;
  };
  for (const m of line.matchAll(SGR)) {
    text(line.slice(at, m.index));
    on = afterSgr(m[1] as string, on);
    at = m.index + m[0].length;
  }
  text(line.slice(at));
  flush();
  return dim(out);
};

/** The lines behind an open pop-up. */
export const backdropLines = (lines: string[]): string[] =>
  lines.map(backdropLine);
