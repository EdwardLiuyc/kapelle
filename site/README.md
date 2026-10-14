# site

The project website, for kapelle.dev. Plain HTML, CSS and one small script.
There is no build step and no dependency.

| Path | What it is |
| --- | --- |
| `index.html` | The home page. |
| `guide/index.html` | The guide: install, rooms, runs, agents, modes, config. |
| `404.html` | The page for an unknown path. |
| `style.css` | One stylesheet for every page. Light and dark themes. |
| `site.js` | The theme picker, the install tabs, the copy buttons, the guide's contents. |
| `fonts/` | Fraunces and Martian Mono, self-hosted, with their SIL Open Font Licenses. |
| `_headers` | Response headers for Cloudflare Pages. |

The TUI figures on the home page are stills, drawn in HTML. They show the
orchestrator before it ships, so each one says "preview". Replace them with
terminal recordings of the real screen when it does.

## Preview

```bash
python3 -m http.server -d site 8000    # then open http://localhost:8000
```

## Deploy

Cloudflare Pages, connected to this repository:

- Production branch: `master`
- Build command: none
- Build output directory: `site`
- Build watch paths: `site/*`
