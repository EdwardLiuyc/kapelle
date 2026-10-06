/**
 * The browser page (spike/pwa): its files, and the one-time code that logs
 * it in. A spike, not a story: see `web/index.html`.
 *
 * **The page files need no token.** They hold no secret, and a browser
 * cannot put a header on a page load. Every API route still needs the
 * token: the page sends it in `Authorization`, as the TUI does. A browser
 * never adds that header by itself, so another site cannot borrow the
 * login (no cookie, so no CSRF), and the `Host` guard still runs first.
 *
 * **Only listed files are served.** A name is letters, digits and `-`, one
 * dot and an extension, so `..` and `/` never reach the disk. `client/*.ts`
 * and `chat/view.ts` go out as JavaScript: Node strips the types, and each
 * `node:` import points at a small stand-in in `web/shim/`. The TUI's files
 * stay as they are.
 *
 * **The code** is how the page gets the token. `kapelle web` asks for one
 * with the token and prints a link with it after `#`; the page trades it
 * for the token once. The token itself never goes in a link: a link lands in
 * the browser's history, and a browser can sync that history to a cloud
 * account. A code works once, for 60 s.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";

const ROOT = new URL("../", import.meta.url);
const NAME = /^[a-z0-9-]+\.(html|js|css|json|svg|ts)$/;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  ts: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/manifest+json",
  svg: "image/svg+xml",
};

/** On every page file. The CSP allows no inline script and no script from
 *  elsewhere, so agent text that slips into the page as HTML cannot run. */
const HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
    "base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** The file a page path names, or `undefined` for one not served. */
function fileOf(path: string): URL | undefined {
  const rest = path === "/app/" ? "index.html" : path.slice("/app/".length);
  const [dir, name, extra] = rest.includes("/") ? rest.split("/") : ["", rest];
  if (extra !== undefined) return undefined;
  if (dir === "vendor" && name === "marked.js") {
    return new URL("node_modules/marked/lib/marked.esm.js", ROOT);
  }
  if (!name || !NAME.test(name)) return undefined;
  if (dir === "") return new URL(`web/${name}`, ROOT);
  if (dir === "shim" && name.endsWith(".js")) {
    return new URL(`web/shim/${name}`, ROOT);
  }
  if (dir === "client" && name.endsWith(".ts")) {
    return new URL(`client/${name}`, ROOT);
  }
  if (dir === "chat" && name === "view.ts")
    return new URL("chat/view.ts", ROOT);
  return undefined;
}

/** A `.ts` file as browser JavaScript: no types, and each `node:` import
 *  from its stand-in. */
export const toBrowser = (source: string) =>
  stripTypeScriptTypes(source).replace(
    /from "node:([a-z/]+)"/g,
    (_, m: string) => `from "/app/shim/${m.replace("/", "-")}.js"`,
  );

/** Serves a `GET /app…` path. Answers whether it was one. */
export function serveApp(path: string, res: ServerResponse): boolean {
  if (path === "/app") {
    // Relative imports resolve against `/app/`, not `/`.
    res.writeHead(308, { location: "/app/" });
    res.end();
    return true;
  }
  if (!path.startsWith("/app/")) return false;
  const file = fileOf(path);
  let body: string | undefined;
  try {
    body = file && readFileSync(file, "utf8");
  } catch {
    // Not there: the 404 below.
  }
  if (!file || body === undefined) {
    res.writeHead(404, { "content-type": "text/plain", ...HEADERS });
    res.end("not found");
    return true;
  }
  const ext = file.pathname.split(".").at(-1) ?? "";
  res.writeHead(200, {
    "content-type": TYPES[ext] ?? "text/plain",
    ...HEADERS,
  });
  res.end(ext === "ts" ? toBrowser(body) : body);
  return true;
}

const CODE_MS = 60_000;

/** One-time login codes. `take` answers whether the code was good, and
 *  spends it. */
export function loginCodes(now = () => Date.now()) {
  const codes = new Map<string, number>();
  return {
    make(): string {
      for (const [c, until] of codes) if (until < now()) codes.delete(c);
      const code = randomBytes(16).toString("hex");
      codes.set(code, now() + CODE_MS);
      return code;
    },
    take(code: unknown): boolean {
      if (typeof code !== "string") return false;
      const until = codes.get(code);
      codes.delete(code);
      return until !== undefined && until >= now();
    },
  };
}
