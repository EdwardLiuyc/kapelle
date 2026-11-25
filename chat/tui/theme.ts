/**
 * `chat/tui/theme.ts` — the editor and pick-list colours shared by the screen,
 * pop-up and question box. It lives apart from the panel so those parts do
 * not need a runtime import from each other (M12-2).
 */

import { bold, cyan, dim } from "../common.ts";

export const EDITOR_THEME = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};
