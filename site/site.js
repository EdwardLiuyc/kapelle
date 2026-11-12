/**
 * `site/site.js` — the little the site does in a browser.
 *
 * - The theme picker in the footer: auto, light or dark. The choice is kept in
 *   localStorage. Auto removes `data-theme`, so the system decides. An inline
 *   script in each page's <head> sets the saved theme before the first paint.
 * - The install tabs: one panel shows at a time.
 * - The copy buttons: they copy a block's commands, without the `$ ` prompts,
 *   the `#` comments and the hidden label.
 * - The guide's contents list marks the section on screen.
 * - The hero prompt types itself. Fig. 01 replays its timeline when it scrolls
 *   into view, and its spinners and clocks run while it is on screen.
 * - A vim status line at the bottom (wide screens only): the section on
 *   screen and how far down the page you are. Keys: j and k jump to the next
 *   and previous section, gg and G to the top and the end, t changes theme.
 *
 * Every page works without this file: all install panels show, every figure
 * is a complete still, and the pickers and copy buttons stay hidden (style.css
 * shows them under `.js`). Under prefers-reduced-motion nothing moves.
 */

const KEY = "kapelle:theme";
const THEMES = ["auto", "light", "dark"];
const root = document.documentElement;
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function savedTheme() {
  try {
    return localStorage.getItem(KEY) || "auto";
  } catch {
    return "auto";
  }
}

let theme = savedTheme();
function applyTheme(next) {
  theme = next;
  if (next === "light" || next === "dark") root.dataset.theme = next;
  else delete root.dataset.theme;
  try {
    if (next === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Storage can be blocked. The theme still applies to this page.
  }
  for (const b of document.querySelectorAll(".theme-picker button")) {
    b.setAttribute("aria-pressed", String(b.dataset.theme === next));
  }
}

for (const b of document.querySelectorAll(".theme-picker button")) {
  b.addEventListener("click", () => applyTheme(b.dataset.theme));
}
applyTheme(theme);

// ---- install tabs ----

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

// ---- copy buttons ----

function commandsOf(pre) {
  const copy = pre.cloneNode(true);
  for (const label of copy.querySelectorAll(".label")) label.remove();
  return copy.textContent
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
      button.textContent = "[ Copied ✓ ]";
    } catch {
      button.textContent = "[ Select and copy ]";
    }
    setTimeout(() => {
      button.textContent = "[ Copy ]";
    }, 1600);
  });
}

// ---- the guide's contents ----

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

// ---- the hero prompt types itself ----

const typed = document.querySelector(".prompt .typed");
if (typed && !still) {
  const text = typed.textContent;
  typed.textContent = "";
  let i = 0;
  const tick = () => {
    typed.textContent = text.slice(0, ++i);
    if (i < text.length) setTimeout(tick, 55 + Math.random() * 60);
  };
  setTimeout(tick, 400);
}

// ---- Fig. 01: replay, spinners and clocks ----

const SPIN = ["◐", "◓", "◑", "◒"];
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

for (const fig of document.querySelectorAll(".tui[data-replay]")) {
  // Steps play in document order. A step marked "same" shows with the one before.
  const steps = [];
  for (const el of fig.querySelectorAll("[data-step]")) {
    if (el.dataset.step === "same" && steps.length) steps.at(-1).push(el);
    else steps.push([el]);
  }
  const spinners = [...fig.querySelectorAll(".spin")];
  const clocks = [...fig.querySelectorAll("[data-clock]")].map((el) => ({
    el,
    start: Number(el.dataset.clock),
  }));
  let timers = [];
  let ticker = 0;
  let onScreen = false;
  let played = false;

  const stopTicker = () => {
    clearInterval(ticker);
    ticker = 0;
  };
  const startTicker = () => {
    if (still || ticker) return;
    let n = 0;
    ticker = setInterval(() => {
      n++;
      for (const s of spinners) s.textContent = SPIN[n % SPIN.length];
      if (n % 4 === 0)
        for (const c of clocks) c.el.textContent = clock(c.start + n / 4);
    }, 250);
  };

  const play = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    played = true;
    for (const group of steps) {
      for (const el of group) el.classList.remove("shown");
      for (const el of group) el.classList.add("later");
    }
    for (const c of clocks) c.el.textContent = clock(c.start);
    steps.forEach((group, i) => {
      timers.push(
        setTimeout(
          () => {
            for (const el of group) {
              el.classList.remove("later");
              el.classList.add("shown");
            }
          },
          350 + i * 850,
        ),
      );
    });
  };

  fig.querySelector(".replay")?.addEventListener("click", play);
  if (still || !("IntersectionObserver" in window)) continue;

  new IntersectionObserver(
    ([e]) => {
      onScreen = e.isIntersecting;
      if (onScreen) {
        if (!played) play();
        startTicker();
      } else stopTicker();
    },
    { threshold: 0.35 },
  ).observe(fig);
}

// ---- the vim status line and its keys ----

const sections = [
  ...document.querySelectorAll("main [data-sec], .doc section[id]"),
].map((el) => ({
  el,
  name:
    el.dataset.sec ||
    el.querySelector("h2")?.textContent.replace(/^\d+/, "").trim() ||
    el.id,
}));
const fileName = location.pathname.replace(/^\/|\/$/g, "") || "index";

const line = document.createElement("div");
line.className = "statusline";
line.setAttribute("aria-hidden", "true");
line.innerHTML =
  '<span class="mode">NORMAL</span><span class="file"></span><span class="sec"></span>' +
  '<span class="hint">j/k section · gg/G · t theme</span><span class="cmd"></span><span class="pct"></span>';
document.body.append(line);
document.body.classList.add("has-statusline");
line.querySelector(".file").textContent = `kapelle/${fileName}`;
const secEl = line.querySelector(".sec");
const pctEl = line.querySelector(".pct");
const cmdEl = line.querySelector(".cmd");

const offset = () => window.innerHeight * 0.3;
function currentIndex() {
  let at = -1;
  sections.forEach((s, i) => {
    if (s.el.getBoundingClientRect().top <= offset()) at = i;
  });
  return at;
}

function update() {
  const i = currentIndex();
  secEl.textContent = i >= 0 ? `§ ${sections[i].name}` : "";
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const y = window.scrollY;
  pctEl.textContent =
    y <= 2 ? "Top" : y >= max - 2 ? "Bot" : `${Math.round((y / max) * 100)}%`;
}
let queued = false;
window.addEventListener(
  "scroll",
  () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  },
  { passive: true },
);
window.addEventListener("resize", update);
update();

const behavior = still ? "auto" : "smooth";
// The section a smooth jump still moves to. A key pressed before it gets
// there counts from it: measured from mid-scroll, it would pick the same
// section again, and the press would be lost.
let aim = -1;
let aimTimer = 0;
const endAim = () => {
  aim = -1;
};
window.addEventListener("scrollend", endAim);
function jump(dir) {
  if (!sections.length) return;
  let i = aim + dir;
  if (aim < 0) {
    // The section whose top sits just below the header counts as "here".
    // scrollIntoView stops at the CSS scroll-padding-top, so measure from
    // it: a guess larger than it leaves "here" above the line, and k jumps
    // to it.
    const pad =
      parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) ||
      0;
    const tops = sections.map((s) => s.el.getBoundingClientRect().top - pad);
    i =
      dir > 0
        ? tops.findIndex((t) => t > 4)
        : tops.findLastIndex((t) => t < -4);
  }
  clearTimeout(aimTimer);
  if (i >= 0 && i < sections.length) {
    sections[i].el.scrollIntoView({ behavior, block: "start" });
    // No scrollend comes when the page cannot move, such as at its end.
    if (behavior === "smooth") {
      aim = i;
      aimTimer = setTimeout(endAim, 1000);
    }
  } else {
    aim = -1;
    window.scrollTo({
      top: dir > 0 ? document.documentElement.scrollHeight : 0,
      behavior,
    });
  }
}

let pending = "";
let pendingTimer = 0;
function show(cmd) {
  cmdEl.textContent = cmd;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    cmdEl.textContent = "";
    pending = "";
  }, 900);
}

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (
    t instanceof HTMLElement &&
    (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
  )
    return;
  const k = e.key;
  if (k === "j" || k === "k") {
    jump(k === "j" ? 1 : -1);
    show(k);
  } else if (k === "G") {
    endAim();
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
    show("G");
  } else if (k === "g") {
    if (pending === "g") {
      endAim();
      window.scrollTo({ top: 0, behavior });
      pending = "";
      show("gg");
    } else {
      pending = "g";
      show("g");
    }
    return;
  } else if (k === "t") {
    applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]);
    show(`:${theme}`);
  } else return;
  pending = "";
});

console.log(
  "%c█ %c▀▄%c\n█ %c▄▀%c  kapelle — you are the Kapellmeister.\n\nThey play. You direct. Press j / k to move between sections.",
  "color:#5cc8ff",
  "color:#c792ea",
  "color:#5cc8ff",
  "color:#ffb454",
  "color:inherit",
);
