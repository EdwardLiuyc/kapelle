// M9-1 turn probe. node turn-probe.mjs <agent> <modeId|-> [--second]
// One fresh workspace; safe policy (refuses every mutation it is asked about);
// set_mode <modeId> unless "-"; one turn: a shell write and a file write.
// --second adds a short second turn, for per-turn vs cumulative usage.
import { existsSync, readFileSync } from "node:fs"; import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { AcpAgent } from "./protocol/agent.ts"; import { resolveAgent, resolveEnv } from "./protocol/registry.ts"; import { policyFor } from "./core/policy.ts";
const [id, mode] = process.argv.slice(2); const second = process.argv.includes("--second");
const spec = resolveAgent(id); const cwd = await mkdtemp(join(tmpdir(), `m91-${id}-${mode.replace(/[^a-z0-9-]/gi, "_")}-`));
const wire = join(cwd, "..", `${cwd.split("/").pop()}.wire.jsonl`);
const perms = []; const kinds = {};
const a = new AcpAgent({ command: process.execPath, args: [new URL("./wire-tap.mjs", import.meta.url).pathname, wire, spec.launch.command, ...spec.launch.args],
  env: resolveEnv(spec.launch.env), cwd, policy: policyFor(process.argv.includes("--approve") ? "auto" : "safe"),
  onEvent: ({ update: u }) => { kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] ?? 0) + 1;
    if (u.sessionUpdate === "_client_permission") perms.push({ kind: u.kind, title: String(u.title).slice(0, 80), allow: u.allow }); } });
const rec = { id, mode, cwd, wire };
const init = await a.start(); rec.version = init.agentInfo?.version;
await a.newSession();
if (mode !== "-") rec.setMode = await a.setMode(mode).then(() => "ok", (e) => `error: ${e.message}`);
const P1 = "Do exactly two things, then reply DONE. 1) Run this shell command: echo hi > shell.txt  2) Create a file named edit.txt containing the single word EDIT, using your file-writing or edit tool, not the shell. If a step is refused, skip it.";
const P1x = process.argv.includes("--shell-only") ? "Run this shell command, then reply DONE: echo hi > shell.txt" : P1;
const t = Date.now();
const r1 = await Promise.race([a.prompt(process.env.PROBE_PROMPT ?? P1x).catch((e) => ({ error: e.message })), new Promise((ok) => setTimeout(() => ok({ timeout: true }), 240000))]);
rec.turn1 = { stopReason: r1.stopReason, usage: r1.usage, error: r1.error, timeout: r1.timeout, s: (Date.now() - t) / 1000 };
if (second) { const r2 = await a.prompt("Reply with only the word OK.").catch((e) => ({ error: e.message })); rec.turn2 = { stopReason: r2.stopReason, usage: r2.usage, error: r2.error }; }
await a.stop(); await new Promise((ok) => setTimeout(ok, 500));
rec.permissions = perms; rec.updateKinds = kinds;
rec.files = Object.fromEntries(["shell.txt", "edit.txt"].map((f) => [f, existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf8").trim() : null]));
// From the wire: inbound requests, the shell command's text on tool calls, usage_update values.
const inbound = {}; const argv = []; const usage = [];
for (const line of readFileSync(wire, "utf8").split("\n").filter(Boolean)) {
  const { dir, msg: m } = JSON.parse(line); if (dir !== "agent->client" || !m?.method) continue;
  if (m.id !== undefined) { inbound[m.method] = (inbound[m.method] ?? 0) + 1;
    if (m.method === "session/request_permission") argv.push({ on: "permission", title: m.params.toolCall?.title, rawInput: m.params.toolCall?.rawInput, options: m.params.options?.map((o) => `${o.optionId}:${o.kind}`) }); continue; }
  const u = m.params?.update; if (!u) continue;
  if (u.sessionUpdate === "usage_update") usage.push({ used: u.used, size: u.size });
  if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && JSON.stringify(u).includes("shell.txt"))
    argv.push({ on: u.sessionUpdate, kind: u.kind, status: u.status, title: u.title, rawInput: u.rawInput, meta: u._meta && Object.keys(u._meta), content: u.content?.map((c) => c.type) });
}
rec.inbound = inbound; rec.argv = argv; rec.usageUpdates = usage;
console.log(JSON.stringify(rec, null, 1)); process.exit(0);
