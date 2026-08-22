#!/usr/bin/env node
// M0-5 wire tap — ephemeral spike tooling, not part of the client.
//
// Spawns a harness and copies stdio through unchanged, appending every line in
// both directions to a JSONL log. Same method M0-1 used, kept as a separate
// process so the probe can see traffic AcpAgent never surfaces: #onNotification
// (acp.mjs:211-212) forwards only `session/update`, so any other notification —
// or a usage field on a *response* — is invisible to onEvent.
//
//   node wire-tap.mjs <log.jsonl> <command> [args...]

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";

const [logPath, command, ...args] = process.argv.slice(2);
if (!logPath || !command) {
  console.error("usage: node wire-tap.mjs <log.jsonl> <command> [args...]");
  process.exit(2);
}

const log = createWriteStream(logPath, { flags: "a" });
const t0 = Date.now();
const write = (dir, line) => {
  let msg = null;
  try { msg = JSON.parse(line); } catch { /* keep raw */ }
  log.write(JSON.stringify({ ms: Date.now() - t0, dir, msg, raw: msg ? undefined : line }) + "\n");
};

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });

createInterface({ input: process.stdin }).on("line", (line) => {
  write("client->agent", line);
  child.stdin.write(line + "\n");
});
createInterface({ input: child.stdout }).on("line", (line) => {
  write("agent->client", line);
  process.stdout.write(line + "\n");
});

child.on("close", (code) => { log.end(); process.exit(code ?? 0); });
child.on("error", (err) => { write("tap-error", err.message); log.end(); process.exit(127); });
