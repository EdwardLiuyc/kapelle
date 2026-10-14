/**
 * `site/site.js` — the little the site does in a browser.
 *
 * - The theme picker in the footer: Auto, Light or Dark. The choice is kept in
 *   localStorage. Auto removes `data-theme`, so the system decides. An inline
 *   script in each page's <head> sets the saved theme before the first paint.
 * - The install tabs: one panel shows at a time.
 * - The copy buttons: they copy a block's commands, without the `$ ` prompts
 *   and the `#` comments.
 * - The guide's contents list marks the section on screen.
 *
 * Every page works without this file: all install panels show, and the
 * pickers and copy buttons stay hidden (style.css shows them under `.js`).
 */

const KEY = "kapelle:theme";
const root = document.documentElement;

function savedTheme() {
  try {
    return localStorage.getItem(KEY) || "auto";
  } catch {
    return "auto";
  }
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be blocked. The theme still applies to this page.
  }
  for (const b of document.querySelectorAll(".theme-picker button")) {
    b.setAttribute("aria-pressed", String(b.dataset.theme === theme));
  }
}

for (const b of document.querySelectorAll(".theme-picker button")) {
  b.addEventListener("click", () => applyTheme(b.dataset.theme));
}
applyTheme(savedTheme());

for (const box of document.querySelectorAll(".install")) {
  const tabs = [...box.querySelectorAll('[role="tab"]')];
  const show = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => show(tab));
    tab.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length];
      next.focus();
      show(next);
    });
  });
  if (tabs.length) show(tabs[0]);
}

function commandsOf(pre) {
  return pre.textContent
    .split("\n")
    .map((line) => line.replace(/^\$ /, "").replace(/\s+#.*$/, ""))
    .filter((line) => line.trim() !== "")
    .join("\n");
}

for (const button of document.querySelectorAll(".copy")) {
  button.addEventListener("click", async () => {
    const pre = button.parentElement.querySelector("pre");
    try {
      await navigator.clipboard.writeText(commandsOf(pre));
      button.textContent = "[ Copied ]";
    } catch {
      button.textContent = "[ Select and copy ]";
    }
    setTimeout(() => {
      button.textContent = "[ Copy ]";
    }, 1600);
  });
}

const tocLinks = [...document.querySelectorAll(".toc a[href^='#']")];
if (tocLinks.length && "IntersectionObserver" in window) {
  const byId = new Map(tocLinks.map((a) => [a.hash.slice(1), a]));
  const seen = new Set();
  const mark = () => {
    const first = [...byId.keys()].find((id) => seen.has(id));
    for (const [id, a] of byId) {
      if (id === first) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) seen.add(e.target.id);
        else seen.delete(e.target.id);
      }
      mark();
    },
    { rootMargin: "0px 0px -70% 0px" },
  );
  for (const id of byId.keys()) {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  }
}
