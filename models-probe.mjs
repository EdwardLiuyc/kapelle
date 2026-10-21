// FINDINGS.md §Models and login, 2026-10-15. Not part of the client.
// node models-probe.mjs [--logged-out] <command> [args...]
// Logged out: an empty HOME and XDG folders, and only PATH, LANG and TERM.
// It prints claude's _auth/status_update params, which hold the account's e-mail.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const loggedOut = argv[0] === "--logged-out";
const [cmd, ...args] = loggedOut ? argv.slice(1) : argv;
const cwd = mkdtempSync(join(tmpdir(), "mp-ws-"));
let env = { ...process.env };
for (const k of ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k];
if (loggedOut) {
  // A bare environment: no keys, no tokens, no keyring, an empty home.
  const home = mkdtempSync(join(tmpdir(), "mp-home-"));
  env = { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb", HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache") };
}
const t0 = Date.now();
const ms = () => Date.now() - t0;
const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
let next = 1;
const pending = new Map();
const notes = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && pending.has(m.id) && !m.method) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method && m.id != null) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "probe" } })}\n`);
    notes.push({ request: m.method });
  } else if (m.method) {
    notes.push({ method: m.method, kind: m.params?.update?.sessionUpdate, params: m.method.startsWith("_") ? m.params : undefined });
  }
});
const call = (method, params, ms = 30000) =>
  new Promise((res) => {
    const id = next++;
    pending.set(id, res);
    setTimeout(() => pending.has(id) && (pending.delete(id), res({ timeout: true })), ms);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const flat = (opts = []) => opts.flatMap((o) => (o.options ? o.options.map((x) => ({ ...x, group: o.group ?? o.name })) : [o]));
const modelOpt = (r) => r?.configOptions?.find((o) => o.category === "model");
const short = (o) => o && { id: o.id, category: o.category, type: o.type, currentValue: o.currentValue, count: flat(o.options).length, grouped: (o.options ?? []).some((x) => x.options), sample: flat(o.options).slice(0, 6).map((x) => x.value + (x.group ? ` [${x.group}]` : "")) };

const out = { cmd, loggedOut, cwd };
const init = await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
out.agentInfo = init.result?.agentInfo;
out.capKeys = Object.keys(init.result?.agentCapabilities ?? {});
out.providersCap = init.result?.agentCapabilities?.providers;
out.initError = init.error ?? (init.timeout ? "timeout" : undefined);
out.authMethods = init.result?.authMethods?.map((m) => ({ id: m.id, name: m.name, type: m.type }));
out.authCap = init.result?.agentCapabilities?.auth;
out.sessionCaps = Object.keys(init.result?.agentCapabilities?.sessionCapabilities ?? {});
out.initMs = ms();
const ns = await call("session/new", { cwd, mcpServers: [] }, 60000);
out.newMs = ms();
if (!ns.result) { out.notifications = notes; out.sessionNewError = ns.error ?? ns; console.log(JSON.stringify(out, null, 1)); console.error(stderr.slice(-2000)); child.kill(); process.exit(1); }
const sid = ns.result.sessionId;
out.newKeys = Object.keys(ns.result); out.newMeta = ns.result._meta;
out.configCategories = (ns.result.configOptions ?? []).map((o) => `${o.id}:${o.category ?? "-"}`);
const mo = modelOpt(ns.result);
out.modelOption = short(mo);
out.legacyModels = ns.result.models && { currentModelId: ns.result.models.currentModelId, count: ns.result.models.availableModels?.length, sample: ns.result.models.availableModels?.slice(0, 4).map((m) => m.modelId) };
// M9-1: no model switch, by request (one model set up).
const pl = await call("providers/list", {});
out.providersList = pl.result ? { providers: pl.result.providers?.map((p) => ({ id: p.providerId, required: p.required, supported: p.supported, current: p.current && { apiType: p.current.apiType } })) } : { error: pl.error && { code: pl.error.code, message: pl.error.message?.slice(0, 120) }, timeout: pl.timeout };
await new Promise((r) => setTimeout(r, 1500));
out.notifications = notes;
console.log(JSON.stringify(out, null, 1));
child.kill();
process.exit(0);
