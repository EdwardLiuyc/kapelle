/**
 * `node:path` in the browser (spike/pwa): the POSIX parts `client/folder.ts`
 * uses. The daemon runs on Linux or macOS, so its paths are POSIX.
 */
export const isAbsolute = (p) => p.startsWith("/");

export function resolve(...parts) {
  let path = "";
  for (const p of parts) path = isAbsolute(p) ? p : `${path}/${p}`;
  const out = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return `/${out.join("/")}`;
}

export const join = (...parts) => parts.join("/").replace(/\/+/g, "/");
