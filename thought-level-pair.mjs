// node thought-level-pair.mjs "<cmd args>" level1 model1 [level2 model2 ...]: set a level, then a model, then read the level.
// FINDINGS.md §Thinking level (#487). Not part of the client.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
const [cmdline, ...pairs] = process.argv.slice(2);
const [cmd, ...args] = cmdline.split(" ");
const env = { ...process.env };
for (const k of ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k];
const cwd = mkdtempSync(join(tmpdir(), "tl-ws-"));
const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
let next = 1; const pending = new Map();
createInterface({ input: child.stdout }).on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id != null && pending.has(m.id) && !m.method) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method && m.id != null) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "probe" } })}\n`); });
const call = (method, params) => new Promise((res) => { const id = next++; pending.set(id, res);
  setTimeout(() => pending.has(id) && (pending.delete(id), res({ timeout: true })), 60000);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
const th = (r) => r?.configOptions?.find((o) => o.category === "thought_level");
const mo = (r) => r?.configOptions?.find((o) => o.category === "model");
const vals = (o) => (o?.options ?? []).flatMap((x) => x.options ?? [x]).map((x) => x.value);
await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
const ns = await call("session/new", { cwd, mcpServers: [] });
const sid = ns.result.sessionId; let t = th(ns.result); const m = mo(ns.result);
console.log(`start model=${m.currentValue} level=${t.currentValue}`);
for (let i = 0; i < pairs.length; i += 2) {
  const s = await call("session/set_config_option", { sessionId: sid, configId: t.id, value: pairs[i] });
  const r = await call("session/set_config_option", { sessionId: sid, configId: m.id, value: pairs[i + 1] });
  const t2 = th(r.result);
  console.log(`set level ${pairs[i]} (${s.result ? th(s.result)?.currentValue : JSON.stringify(s.error)}) then model ${pairs[i + 1]} -> level ${t2?.currentValue ?? "(no option)"} of ${JSON.stringify(vals(t2))}`);
  if (t2) t = t2;
}
child.kill(); process.exit(0);
