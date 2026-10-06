/**
 * `node:os` in the browser (spike/pwa): the daemon's home folder, which
 * the page reads once from `GET /folders` (`web/app.js`).
 */
export const homedir = () => globalThis.kapelleHome ?? "/";
