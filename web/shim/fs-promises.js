/**
 * `node:fs/promises` in the browser (spike/pwa). The page has its address
 * from the login, never from `daemon.json`.
 */
export const readFile = () =>
  Promise.reject(new Error("no disk in the browser"));
