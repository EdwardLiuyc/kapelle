# UI client stack — investigation and the PWA spike

Which language and framework to use for a second UI client that runs on many platforms, and
what the browser option (a PWA) needs. Written 2026-10-06. The spike is on branch `spike/pwa`,
commit `1296d64`.

This file is a **findings note**, not a decision. Nothing here changes the plan until a story
takes it up.

The app sizes and memory numbers below are **rough figures from general knowledge**. Nothing
was built or measured for them, except the PWA spike.

## Contents

1. [What limits the choice](#what-limits-the-choice)
2. [Every stack](#every-stack)
3. [Desktop only: four stacks](#desktop-only-four-stacks)
4. [Flutter or Qt](#flutter-or-qt)
5. [The PWA in detail](#the-pwa-in-detail)
6. [The spike](#the-spike)
7. [Open decisions](#open-decisions)

## What limits the choice

These are facts about the project today. They hold unless a decision changes them.

1. **The client runs on the same machine as the daemon.** The daemon listens on `127.0.0.1`
   only (`docs/CLIENT-API.md`), and the token is in a local file, `daemon.json`. So
   "many platforms" means Windows, macOS and Linux desktops. A phone needs the daemon on the
   network, which is a large security change (see [phones](#phones)).
2. **Every request carries `Authorization: Bearer <token>`.** A page cannot read
   `daemon.json`. The daemon sends no CORS headers, so a page from another origin cannot call
   it.
3. **The client logic is TypeScript.** `client/` plus `chat/view.ts` is about 2,200 lines,
   with 1,285 lines of tests:
   - About 1,200 lines are pure and run anywhere TS runs: `room.ts`, `questions.ts`,
     `mention.ts`, `stream.ts`, `contract.ts`, `chat/view.ts`.
   - About 600 lines need Node: `daemon.ts` (`node:fs/promises`), `folder.ts` (`node:fs`,
     `node:os`, `node:path`), and `parseArgs` from `node:util` in `command.ts`. The files that
     import them (`roomset.ts`, `diff.ts`, `submit.ts`) work once those three are replaced.
4. **No TUI screen code moves to a GUI.** `chat/` and `chat/tui/` are about 2,900 lines. Every
   option builds a new screen of about that size.

## Every stack

With the project's rules set aside, the loopback-only daemon included.

| Stack | Desktop | Phone | Browser | App size | Reuse of `client/` |
| --- | --- | --- | --- | --- | --- |
| Electron | Win, Mac, Linux | No | Renderer code can be reused | 80–150 MB | All of it |
| Tauri v2 | Win, Mac, Linux | iOS, Android (newer) | No | 3–10 MB | Pure TS; port about 600 lines to Rust |
| Wails | Win, Mac, Linux | No | No | 8–15 MB | Pure TS; port about 600 lines to Go |
| React Native | Win, Mac (no Linux) | iOS, Android | Partly | 20–50 MB | Pure TS; replace the Node parts |
| Web app (PWA) | Any browser | Any browser | Yes | Under 1 MB, no install | Pure TS; the daemon serves the page |
| Flutter | Win, Mac, Linux | iOS, Android | Yes (weaker) | 20–50 MB | None: rewrite in Dart |
| Compose Multiplatform | Win, Mac, Linux | Android, iOS | Beta | 60–100 MB (ships a JVM) | None: rewrite in Kotlin |
| Qt | Win, Mac, Linux | iOS, Android | Limited | 40–80 MB | None: rewrite in C++ or Python |
| Avalonia | Win, Mac, Linux | iOS, Android | Yes (WASM) | 30–80 MB | None: rewrite in C# |

### Per stack

**Electron.** All of `client/` runs unchanged in the main process, and it is all TypeScript.
Every OS draws the screen the same way, because Electron brings its own Chromium. Costs: the
largest app and the most memory, and builds on three operating systems.

**Tauri v2.** A very small app, with low memory. It can also make phone apps. Costs: a Rust
part, a port of about 600 lines, WebKitGTK on Linux (the weakest system web view), and a
different web view on each OS. Its phone support is newer.

**Wails.** Like Tauri, in Go instead of Rust. It has the same web view limits, it is desktop
only, and its community is smaller.

**React Native.** TypeScript, with one code base for phones and two desktops. It has no good
Linux version. Microsoft keeps the desktop versions, and they fall behind the phone version.

**Web app served by the daemon (PWA).** The least work, with nothing to install. It needs
daemon work: see [The PWA in detail](#the-pwa-in-detail). It has no tray icon, and
notifications work only while the page is open.

**Flutter.** The widest coverage from one code base, with one look everywhere and an easy
language (Dart). Costs: a full rewrite of `client/` and its tests, and a second client to keep
in step with each API change.

**Compose Multiplatform.** Kotlin, solid on desktop, native on Android. Costs: a full rewrite,
a JVM in the app (large, slow to start), and Gradle.

**Qt.** The most mature desktop toolkit, native-feeling and fast. Costs: a full rewrite in C++
(or in Python, with a much larger app), and its license (see [Qt's license](#qts-license)).

**Avalonia.** A good C# desktop toolkit that can build one small file (NativeAOT). Costs: a full
rewrite, .NET, and a smaller community than Flutter's.

### Why a rewrite costs more than its line count

The rewrite is about 2,200 lines plus tests. The larger cost is two copies of the same logic.
Some parts of the API are still **provisional** in `docs/CLIENT-API.md`: a named story will
change them without a version step. Each such change then needs work in two languages. The
M5 goal ("write a client from `docs/CLIENT-API.md` alone") does welcome a second-language
client, but it does not make keeping two of them in step free.

## Desktop only: four stacks

| | Electron | PWA | Qt | Flutter |
| --- | --- | --- | --- | --- |
| Windows, macOS, Linux | All 3 | All 3, in a browser | All 3 | All 3 |
| App size | 80–150 MB | 0 (no install) | 40–80 MB (C++); more with Python | 20–50 MB |
| Memory, idle | 150–300 MB | One browser tab | 30–80 MB | 50–120 MB |
| Users install | Nothing extra | A browser (Chrome, Edge or Safari can install it as an app; Firefox runs it as a tab) | Nothing extra | Nothing extra (GTK3 on Linux) |
| Build tools | Node + a packager | Nothing new | Qt SDK, CMake, a C++ compiler (or Python + PySide6) | Flutter SDK |
| Language | TypeScript | TypeScript | C++ + QML, or Python | Dart |
| Reuse of `client/` | All 2,200 lines + tests | About 1,200 pure lines + their tests | None | None |
| Client logic to rewrite | 0 | About 300 lines (token, folder list) | About 2,200 + 1,300 test lines | Same as Qt |
| Daemon changes | None | Medium (see below) | None | None |
| API types stay in step | Yes: shared `contract.ts` | Yes: shared `contract.ts` | No: hand-copied | No: hand-copied |
| Markdown | `marked`, already in the repo | `marked`, already in the repo | QML has basic built-in Markdown | Community packages |
| Diff view | HTML, easy | HTML, easy | Custom widget | Custom widget |
| Tray icon, notifications | Full | Notifications while open; no tray | Full | Community plugins |
| Updates | Built-in updater available | A page reload | Your own | Your own |
| Code signing | Needed (macOS, Windows) | Not needed | Needed | Needed |
| CI builds | 3 operating systems | None | 3 operating systems | 3 operating systems |
| From WSL | Must find `daemon.json` inside WSL | Works: the Windows browser opens `127.0.0.1:4719` | Same as Electron | Same as Electron |
| Main security risk | XSS in the window; the window has no Node | XSS in the page can use the login and start runs | Low: no HTML | Low: no HTML |

Words in the table:

- **XSS:** agent text that runs as script in the page. Agent text is untrusted: a harness can
  echo any file in any repository.
- **Code signing:** a paid certificate. Without it, macOS blocks the app and Windows warns.

Where each one wins:

- **Electron:** the most reuse, no daemon change, full desktop features. Cost: app size.
- **PWA:** the least work, no packaging, no signing, no CI builds, the best WSL story. Cost:
  daemon login work that must be secure, and browser limits.
- **Qt:** small, fast, native, no XSS class. Cost: a full rewrite and two clients to keep in
  step.
- **Flutter:** small, one look, an easy language. Cost: as Qt, with weaker desktop extras.

Qt and Flutter make sense only if the client must use no web technology at all.

## Flutter or Qt

Flutter was named over Qt only for the "desktop **and** phones" case. For desktop only, Qt is
as good a choice, or better.

| | Flutter | Qt |
| --- | --- | --- |
| Phones | Built for phones first | Works, but fewer people use it there; heavier tools |
| Language | Dart: easy, close to TypeScript | C++ with QML; Python (PySide6) has almost no phone support |
| Build | One tool, `flutter build` | CMake, a C++ compiler, Qt Creator |
| Desktop feel | Draws its own widgets: the same everywhere, not fully native | More native, very mature |
| License | BSD: free, no rules worth noting | Free with rules (below) |

### Qt's license

Qt has two licenses:

- **Open source: LGPLv3 for most modules, GPLv3 for some.** It costs nothing. A closed or
  commercial app may use it.
- **Commercial: paid.** Needed only when the LGPL rules cannot be followed.

The LGPLv3 rules: link Qt as shared libraries, so a user can swap in their own Qt; ship the
license text and offer the Qt source; and do not use the GPL-only modules (Qt Charts, for
example) unless the app is GPL too.

The trouble spot is **iOS**. An iOS app usually links Qt statically, and the LGPL then asks
for the object files a user needs to re-link it. That is awkward for an App Store app.

This repository is MIT. On desktop, Qt is free for it.

## The PWA in detail

### No cookie, no CSRF

An earlier draft of this investigation said the PWA needs a cookie, `SameSite=Strict` and an
`Origin` check on every write. **It does not.**

- The daemon serves the page, so the page and the API share one origin. `fetch()` can send
  the `Authorization` header, as the TUI does. `client/stream.ts` already reads the event
  stream through `fetch()`, not `EventSource`.
- A browser never adds that header by itself. So another site cannot borrow the login: no
  cookie means no CSRF (cross-site request forgery).
- If another site tries to send the header itself, the browser first asks the daemon with a
  preflight `OPTIONS` request. The daemon never grants it, so the browser stops.
- The `Host` check (M2-8) still runs first and stops DNS rebinding.

### What the daemon needs

For a PWA on the operator's own machine, the change is medium:

1. **Serve the page,** with no token: the files hold no secret.
2. **A login step.** The page cannot read `daemon.json`, so it trades a one-time code for the
   token.
3. **A folder-list route,** for the new-room form's folder completion.
4. **Security headers:** a strict CSP and `nosniff`.

Not needed: TLS (a browser treats `127.0.0.1` as a secure address, so the page can be
installed), and a fixed port (the default is already `4719`).

### Phones

For phones the change really is large: the daemon listens on the network, needs TLS, needs a
login for each device and a way to remove a lost one, and every device on the network can
then reach a server that runs commands on the operator's machine.

### The steps

These are the steps as planned before the spike. [The spike](#the-spike) says what it did and
did not do.

**Part 1 — make `client/` load in a browser.**

1. Move the `daemon.json` read out of `client/daemon.ts` into a Node-only file.
2. Remove `parseArgs` (`node:util`) from `client/command.ts`.
3. Pass folder completion into `command.ts` as a function.
4. Add a test that fails when a browser file imports `node:`.

**Part 2 — the daemon serves the page.**

1. Add a `GET /app/...` route after the `Host` check and before the token check, from an
   allow-list of folders. Refuse `..` and any path outside them.
2. Serve `.ts` as JavaScript with `stripTypeScriptTypes` from `node:module`, so there is still
   no build step. Node 24 marks it experimental.
3. Send `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none';
   frame-ancestors 'none'` and `X-Content-Type-Options: nosniff` with every page file.

**Part 3 — the daemon login.**

1. A one-time code: `POST /session/code` (with the token) gives a code that works once, for
   60 s. `POST /session {code}` (no token, `Host` check still on) gives the token. The token
   never goes in a link: a link lands in the browser's history, and a browser can sync that
   history to a cloud account.
2. A CLI verb prints `http://127.0.0.1:4719/app/#code=…`. The part after `#` never goes to a
   server. The page removes it with `history.replaceState`.
3. The page keeps the token in `localStorage`. After a daemon restart (new token, `401`), it
   asks for a new link.
4. `GET /folders?path=…`, with the token. It adds no power: the token can already run
   commands.

**Part 4 — the page.**

1. `index.html`, `manifest.json` and one icon. No service worker: the page is useless
   offline, and Chrome and Edge install a page without one.
2. Build the screen on the existing reducers: `roomset.ts`, `room.ts`, `questions.ts`,
   `mention.ts`, `submit.ts`, `chat/view.ts`.
3. Markdown through `marked`: raw HTML escaped, links only for `http:` and `https:`. With the
   CSP, no sanitizer library is needed.
4. Browser notifications when an agent waits.

**Part 5 — tests and docs.**

1. Daemon tests: page files without a token, API routes still need it, no CORS on `OPTIONS`,
   a code works once and expires, `..` refused, the CSP present.
2. An attack test: `<script>` and `<img onerror>` in agent text show as text.
3. Docs: `docs/CLIENT-API.md` (the new routes, a minor version step), `docs/PROJECT-PLAN.md`
   (the browser client returns; "browser-compatible auth — retired" reverses), and the
   `AGENTS.md` file table.

## The spike

Scope: the PWA with the functions the TUI has today, and no more. Estimated at about 2,500
lines; built in about 2,650.

### What it is

| Part | Where | What |
| --- | --- | --- |
| Daemon | `daemon/web.ts`, about 30 lines in `daemon.ts` | `GET /app/…` from an allow-list, `.ts` served type-stripped, the CSP, `POST /session/code`, `POST /session`, `GET /folders` |
| CLI | `cli.ts` | `kapelle web`: prints the one-time link |
| Page | `web/` | `index.html`, `app.css`, `app.js` (login, live rooms, sidebar, banner, status, composer, keys), `transcript.js`, `box.js` (the `<dialog>` pop-up, forms, question box), `pane.js` (diff and history), `dom.js` |
| Browser stand-ins | `web/shim/` | `node:util` (`parseArgs`), `node:fs`, `node:fs/promises`, `node:os`, `node:path` |
| Tests | `daemon/tests/web.test.ts` | Allow-list, blocked paths, the code, the type stripping |
| knip | `knip.jsonc` | `web/**` ignored: the daemon serves those files, nothing imports them |

### Where it differs from the plan

- **Part 1 was not done.** `client/` and the TUI are unchanged. The daemon rewrites each
  `node:` import to a stand-in in `web/shim/` as it serves the file. The page sets
  `globalThis.process` so `client/folder.ts` resolves a relative `--cwd` from home.
- **The verb is `kapelle web`,** not `kapelle open`: `kapelle open` already sends the prompt
  "open". `web` has the same clash, only less likely.
- **The keys moved,** because a browser keeps ctrl+t, ctrl+n, ctrl+w, ctrl+r and ctrl+p:
  ctrl+k menu (TUI: ctrl+o), ctrl+b rooms (ctrl+t), alt+x side view (ctrl+x), alt+h history
  (ctrl+r), alt+↑↓ rows. Every action is also a button or a click.
- **An answer is parsed again whole on each chunk,** at most once a frame. The TUI's block
  split (`settled` in `chat/tui/transcript.ts`) was not ported.
- **The page is opened on `127.0.0.1` only.** `client/daemon.ts` calls `127.0.0.1`, so the
  page redirects any other host name there.
- **Part 5's docs were not written.**

### What was checked

- The gate: `npm run check`, `npm run fmt:check`, `npm run knip`, and `npm run test`
  (816 tests, 4 new) all pass.
- `curl` against a test daemon: API routes still need the token; a wrong `Host` gets `403`; a
  cross-site preflight gets no CORS grant; a spent code gets `401`; `..` paths never reach
  the disk.
- Headless Chromium (Playwright, outside the repository) against `mock-agent.mjs`: login,
  `/new`, `@mock /mode ask`, a message, the question box (deny focused first), the next
  question opening by itself, the ctrl+k menu, the thread's `@name` pre-fill, history,
  `/diff`, `/help`, the add-agent form, folder Tab completion, `/dismiss`, and the narrow
  layout. No console errors and no CSP blocks.
- Markdown: `<script>`, `<img onerror>` and `javascript:` links come out as text.

### What was not checked

- A real harness, a Windows browser, Firefox and Safari.
- The question box's "view diff": the mock agent's question had no diff. `/diff` uses the
  same side view.

## Open decisions

1. **Keep the PWA, or build a desktop app (Electron).** The PWA is the least work and suits
   WSL; Electron gives a tray icon, works with no browser open, and needs no daemon change.
2. **If the PWA stays:** do Part 1 (make `client/` browser-safe and drop the stand-ins), and
   write Part 5's docs.
3. **The verb's name** (`kapelle web`), since any single word clashes with a one-word prompt.
4. **The screen code:** plain DOM, as in the spike, or Preact with `htm` (about 5 KB, no build
   step) if the plain DOM grows hard to follow.
