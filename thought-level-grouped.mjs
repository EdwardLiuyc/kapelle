// FINDINGS.md §Thinking level (#487): is the level list flat or grouped? Not part of the client.
// node thought-level-grouped.mjs <command> [args...]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
const [cmd, ...args] = process.argv.slice(2);
const env = { ...process.env };
for (const k of ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k];
const cwd = mkdtempSync(join(tmpdir(), "tl-ws-"));
const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
let next = 1; const pending = new Map();
createInterface({ input: child.stdout }).on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id != null && pending.has(m.id) && !m.method) { pending.get(m.id)(m); pending.delete(m.id); } });
const call = (method, params) => new Promise((res) => { const id = next++; pending.set(id, res); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
const ns = await call("session/new", { cwd, mcpServers: [] });
const t = ns.result.configOptions.find((o) => o.category === "thought_level");
console.log(cmd, "grouped:", t.options.some((x) => x.options) ? "yes" : "no", JSON.stringify(t.options[0]));
child.kill(); process.exit(0);
