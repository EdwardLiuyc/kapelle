// Thinking-level probe for kapelle #487. Not part of the client.
// node thought-level-probe.mjs [--logged-out] [--load] [--prompt] <command> [args...]
// Based on models-probe.mjs (spike/m9-models-probe).
// Steps: 1 offered, 2 set, 3 per model, 4 after a load (--load), 5 logged out (--logged-out).
// --prompt sends one "Hi" before the stop in step 4, for an agent that keeps no session without one.
// Notifications keep only their method and kind: claude's auth notice holds an e-mail.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

let argv = process.argv.slice(2);
const flag = (f) => (argv.includes(f) ? ((argv = argv.filter((a) => a !== f)), true) : false);
const loggedOut = flag("--logged-out");
const doLoad = flag("--load");
const withPrompt = flag("--prompt");
const [cmd, ...args] = argv;
const cwd = mkdtempSync(join(tmpdir(), "tl-ws-"));
let env = { ...process.env };
for (const k of ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k];
if (loggedOut) {
  const home = mkdtempSync(join(tmpdir(), "tl-home-"));
  env = { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb", HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache") };
}

function start() {
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
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "probe" } })}\n`);
      notes.push({ request: m.method });
    } else if (m.method) {
      const u = m.params?.update;
      const n = { method: m.method, kind: u?.sessionUpdate };
      // A config change sent unasked: keep the thinking option's value.
      if (u?.sessionUpdate === "config_option_update") n.thought = thoughtOf(u)?.currentValue;
      if (u?.sessionUpdate === "current_mode_update") n.mode = u.currentModeId;
      notes.push(n);
    }
  });
  const call = (method, params, ms = 30000) =>
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

const flat = (opts = []) => opts.flatMap((o) => (o.options ? o.options : [o]));
const values = (o) => flat(o?.options).map((x) => x.value);
// The thinking option: the reserved category, or a name that says so under another category.
const thoughtOf = (r) =>
  r?.configOptions?.find((o) => o.category === "thought_level") ??
  r?.configOptions?.find((o) => /effort|thought|think|reason/i.test(`${o.id} ${o.name}`));
const modelOf = (r) => r?.configOptions?.find((o) => o.category === "model");
const err = (r) => (r.error ? { code: r.error.code, message: String(r.error.message).slice(0, 160) } : r.timeout ? "timeout" : undefined);
const takeNotes = (notes) => notes.splice(0).filter((n) => n.kind !== "agent_message_chunk" && n.kind !== "available_commands_update");
const settle = () => new Promise((r) => setTimeout(r, 800));

const out = { cmd: [cmd, ...args].join(" "), loggedOut };
const a = start();
const init = await a.init();
out.agentInfo = init.result?.agentInfo;
out.initError = err(init);
const ns = await a.call("session/new", { cwd, mcpServers: [] }, 60000);
if (!ns.result) {
  out.sessionNewError = err(ns);
  console.log(JSON.stringify(out, null, 1));
  await a.stop();
  process.exit(0);
}
const sid = ns.result.sessionId;

// 1. Offered.
out.options = (ns.result.configOptions ?? []).map((o) => ({
  id: o.id, name: o.name, category: o.category ?? null, type: o.type, currentValue: o.currentValue,
  values: o.category === "model" ? `${values(o).length} models` : values(o),
}));
out.modes = ns.result.modes && { current: ns.result.modes.currentModeId, ids: ns.result.modes.availableModes?.map((m) => m.id) };
out.legacyModels = ns.result.models && { current: ns.result.models.currentModelId, ids: ns.result.models.availableModels?.map((m) => m.modelId) };
await settle();
out.notesAfterNew = takeNotes(a.notes);
const t0 = thoughtOf(ns.result);
out.thoughtOption = t0 ? { id: t0.id, category: t0.category ?? null, start: t0.currentValue, values: values(t0) } : null;

// 2. Set each level, then a bad one.
if (t0) {
  out.set = [];
  for (const v of values(t0)) {
    const r = await a.call("session/set_config_option", { sessionId: sid, configId: t0.id, value: v });
    await settle();
    out.set.push({ value: v, ok: !!r.result, error: err(r), after: thoughtOf(r.result)?.currentValue,
      modeAfter: r.result?.modes?.currentModeId, notes: takeNotes(a.notes) });
  }
  const bad = await a.call("session/set_config_option", { sessionId: sid, configId: t0.id, value: "no-such-level" });
  out.setBad = bad.result ? { accepted: true, after: thoughtOf(bad.result)?.currentValue } : err(bad);
  // Back to the start level, so step 3 begins where a new session does.
  await a.call("session/set_config_option", { sessionId: sid, configId: t0.id, value: t0.currentValue });
}

// 3. Per model: set a level that is not the default, then the model; read the level back.
const m0 = modelOf(ns.result);
if (m0 && !loggedOut) {
  out.perModel = [];
  let levels = t0 ? values(t0) : [];
  let current = t0?.currentValue;
  for (const model of values(m0)) {
    let before;
    if (t0) {
      before = levels.find((v) => v !== current && v !== t0.currentValue) ?? levels.find((v) => v !== current);
      if (before !== undefined) {
        const s = await a.call("session/set_config_option", { sessionId: sid, configId: t0.id, value: before });
        if (!s.result) before = { refused: before, error: err(s) };
      }
    }
    const r = await a.call("session/set_config_option", { sessionId: sid, configId: m0.id, value: model }, 60000);
    await settle();
    const t = thoughtOf(r.result);
    const row = { model, ok: !!r.result, error: err(r), levelBefore: before };
    if (r.result) {
      row.modelAfter = modelOf(r.result)?.currentValue;
      row.levels = t ? values(t) : null;
      row.levelAfter = t?.currentValue;
      row.optionIds = r.result.configOptions?.map((o) => o.id);
      row.notes = takeNotes(a.notes);
      if (t) { levels = values(t); current = t.currentValue; } else { levels = []; current = undefined; }
    }
    out.perModel.push(row);
  }
}

// 4. After a load: set a level that is not the start one, stop, load in a new process.
if (doLoad && t0) {
  const fresh = start();
  await fresh.init();
  const n2 = await fresh.call("session/new", { cwd, mcpServers: [] }, 60000);
  const t2 = thoughtOf(n2.result);
  const target = values(t2).find((v) => v !== t2.currentValue);
  const s = await fresh.call("session/set_config_option", { sessionId: n2.result.sessionId, configId: t2.id, value: target });
  out.load = { start: t2.currentValue, set: target, setOk: !!s.result, prompted: withPrompt };
  if (withPrompt) {
    const p = await fresh.call("session/prompt", { sessionId: n2.result.sessionId, prompt: [{ type: "text", text: "Hi" }] }, 120000);
    out.load.prompt = p.result ? p.result.stopReason : err(p);
  }
  await settle();
  await fresh.stop();
  const b = start();
  const bi = await b.init();
  const canDelete = !!bi.result?.agentCapabilities?.sessionCapabilities?.delete;
  const l = await b.call("session/load", { sessionId: n2.result.sessionId, cwd, mcpServers: [] }, 60000);
  await settle();
  out.load.loadOk = !!l.result;
  out.load.loadError = err(l);
  out.load.levelAfterLoad = thoughtOf(l.result)?.currentValue;
  out.load.modeAfterLoad = l.result?.modes?.currentModeId;
  out.load.notes = takeNotes(b.notes).filter((n) => n.kind === "config_option_update" || n.kind === "current_mode_update");
  if (canDelete) out.load.deleted = (await b.call("session/delete", { sessionId: n2.result.sessionId })).result ? true : "no";
  await b.stop();
}

await a.stop();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
