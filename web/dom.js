/**
 * Building the page (spike/pwa). `h` sets text with `textContent`, never
 * as HTML, so agent text cannot become a tag. The one place that sets HTML
 * is the markdown in `transcript.js`, and it escapes raw HTML first.
 */

/** An element with its attributes and children. A string child is text.
 *  An `on*` attribute is a listener; `class` and the rest are attributes. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** Up and down move the focus between the `li`s of a list, as the TUI's
 *  arrow keys move its cursor. Enter picks. */
export function arrowKeys(list, pick) {
  list.addEventListener("keydown", (e) => {
    const items = [...list.querySelectorAll("li")];
    const at = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = at + (e.key === "ArrowDown" ? 1 : -1);
      items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
    } else if (e.key === "Enter" && at >= 0) {
      e.preventDefault();
      pick(at);
    }
  });
}

/** A list to pick from, as `li`s that take the focus. */
export function pickList(rows, pick) {
  const list = h(
    "ul",
    { class: "pick" },
    rows.map((row, i) =>
      h("li", { tabindex: "0", onclick: () => pick(i) }, row),
    ),
  );
  arrowKeys(list, pick);
  return list;
}
