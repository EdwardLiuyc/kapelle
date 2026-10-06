/**
 * `node:fs` in the browser (spike/pwa). A page has no disk: folder
 * completion asks the daemon (`GET /folders`), so these only throw.
 */
const none = () => {
  throw new Error("no disk in the browser");
};
export const readdirSync = none;
export const statSync = none;
