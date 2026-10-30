// FINDINGS.md §Models and login, `session/load` logged out (M9-4b, #379). Not part of the client.
// node load-logged-out-probe.mjs [--prompt] <store> <command> [args...]
// <store> is the agent's own folder, relative to HOME: .pi, .codex, .kimi-code, .claude, .copilot, .local/share/opencode.
//
// 1. Logged in: initialize, session/new in a new temporary folder, then stop. With --prompt,
//    one one-word prompt first, for an agent that keeps no session without one.
// 2. Every file in <store> that names the session id is copied into an empty HOME, at the same
//    path. A file whose name looks like a login file is never copied; the copied list is printed.
// 3. Logged in again: session/load in a new process. The baseline.
// 4. Logged out: session/load in a new process with the empty HOME, as models-probe.mjs does.
// 5. The baseline process deletes the session when the agent can.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const withPrompt = argv[0] === "--prompt";
const [store, cmd, ...args] = withPrompt ? argv.slice(1) : argv;
const cwd = mkdtempSync(join(tmpdir(), "lp-ws-"));
const loginLike = /auth|credential|token|secret|key|\.toml$|^config\.json$/i;

const loggedInEnv = { ...process.env };
for (const k of ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"]) delete loggedInEnv[k];
const home = mkdtempSync(join(tmpdir(), "lp-home-"));
const loggedOutEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb", HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
  XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache") };

function start(env) {
  const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let next = 1;
  const pending = new Map();
  const notes = [];
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && pending.has(m.id) && !m.method) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method && m.id != null) {
      // A permission request gets a refusal: a one-word prompt needs no tool.
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "probe" } })}\n`);
      notes.push({ request: m.method });
    } else if (m.method) {
      const kind = m.params?.update?.sessionUpdate;
      // Only the notice's kind: claude's carries the account's e-mail.
      const auth = m.params?.authStatus?.kind;
      notes.push({ method: m.method, ...(kind && { kind }), ...(auth && { authKind: auth }) });
    }
  });
  const call = (method, params, ms = 60000) =>
    new Promise((res) => {
      const id = next++;
      pending.set(id, res);
      setTimeout(() => pending.has(id) && (pending.delete(id), res({ timeout: true })), ms);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const init = () => call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
  const stop = async () => { child.kill(); await new Promise((r) => setTimeout(r, 500)); };
  return { call, init, notes, stop, stderr: () => stderr };
}

const err = (r) => r.error ? { code: r.error.code, message: String(r.error.message).slice(0, 160) } : r.timeout ? "timeout" : undefined;
const dedupe = (notes) => [...new Set(notes.map((n) => JSON.stringify(n)))].map((s) => JSON.parse(s));
// How much history a load replayed: session/update kinds, counted.
const replay = (notes) => notes.filter((n) => n.kind).reduce((m, n) => ({ ...m, [n.kind]: (m[n.kind] ?? 0) + 1 }), {});
const modelCount = (r) => {
  const o = r?.configOptions?.find((x) => x.category === "model");
  return o ? (o.options ?? []).flatMap((x) => x.options ?? [x]).length : undefined;
};
const out = { cmd, store, withPrompt, cwd, home };

// 1. Logged in: a session to load.
const a = start(loggedInEnv);
const ai = await a.init();
out.agentInfo = ai.result?.agentInfo;
out.loadSession = ai.result?.agentCapabilities?.loadSession;
const canDelete = !!ai.result?.agentCapabilities?.sessionCapabilities?.delete;
const ns = await a.call("session/new", { cwd, mcpServers: [] });
if (!ns.result) { out.newError = err(ns); console.log(JSON.stringify(out, null, 1)); console.error(a.stderr().slice(-2000)); await a.stop(); process.exit(1); }
const sid = ns.result.sessionId;
out.sessionId = sid;
if (withPrompt) {
  const p = await a.call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "Hi" }] }, 120000);
  out.prompt = p.result ? { stopReason: p.result.stopReason } : err(p);
}
await new Promise((r) => setTimeout(r, 1500));
await a.stop();

// 2. Copy the files that name the session, never a login file.
const root = join(homedir(), store);
let hits = [];
try {
  hits = execFileSync("grep", ["-rlF", "--", sid, root], { encoding: "utf8", maxBuffer: 1 << 24 }).split("\n").filter(Boolean);
} catch {}
const sqliteSiblings = (f) => /\.(db|sqlite)(-wal|-shm)?$/.test(f)
  ? ["", "-wal", "-shm"].map((s) => f.replace(/(-wal|-shm)?$/, s)) : [f];
const files = [...new Set(hits.flatMap(sqliteSiblings))].filter((f) => existsSync(f));
out.copied = [];
out.skipped = [];
for (const f of files) {
  const rel = relative(homedir(), f);
  if (rel.split("/").some((part) => loginLike.test(part))) { out.skipped.push(rel); continue; }
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  copyFileSync(f, join(home, rel));
  // A text index that names a file by its full path (pi's session map) points into the empty
  // HOME instead, so the logged-out process reads nothing from the real one.
  if (!/\.(db|sqlite)(-wal|-shm)?$/.test(f)) {
    const text = readFileSync(f, "utf8");
    if (text.includes(homedir())) writeFileSync(join(home, rel), text.replaceAll(homedir(), home));
  }
  out.copied.push(rel);
}

// 3. Logged in: the baseline load.
const b = start(loggedInEnv);
await b.init();
const bl = await b.call("session/load", { sessionId: sid, cwd, mcpServers: [] });
await new Promise((r) => setTimeout(r, 1500));
out.loggedIn = bl.result ? { ok: true, models: modelCount(bl.result), replay: replay(b.notes), notes: dedupe(b.notes).filter((n) => n.method !== "session/update") } : { error: err(bl) };

// 4. Logged out: the load this probe is for.
const c = start(loggedOutEnv);
const ci = await c.init();
out.loggedOutInitError = err(ci);
const cl = await c.call("session/load", { sessionId: sid, cwd, mcpServers: [] });
await new Promise((r) => setTimeout(r, 1500));
out.loggedOut = cl.result ? { ok: true, models: modelCount(cl.result), replay: replay(c.notes) } : { error: err(cl), data: cl.error?.data && Object.keys(cl.error.data) };
out.loggedOutNotes = dedupe(c.notes).filter((n) => n.method !== "session/update");
await c.stop();
if (!cl.result) out.loggedOutStderr = c.stderr().slice(-600);

// 5. Clean up.
if (canDelete) {
  const d = await b.call("session/delete", { sessionId: sid });
  out.deleted = d.result ? true : err(d);
}
await b.stop();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
