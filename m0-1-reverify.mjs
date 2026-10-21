#!/usr/bin/env node
// M0-7 re-verification probe — ephemeral spike tooling, not part of the client.
//
// M0-1 surveyed copilot on 1.0.78; M0-3/4/5 ran on 1.0.80. The roll-up table
// M0-7 adds would otherwise carry a column spanning two builds, which M0-4
// explicitly warns against ("pin the version next to every row"). This re-runs
// M0-1's copilot checks on the current build so the column is one version.
//
// Three runs, each a fresh subprocess and a fresh throwaway workspace:
//   read   — autoPolicy, a read-only prompt: handshake, capabilities, update
//            variants, inbound requests, permission behaviour on reads
//   write  — safePolicy, asks for a file: the containment probe
//   modes  — no prompt: session/new mode fields, set_mode valid + bogus
//
//   node m0-1-reverify.mjs --agent copilot --out out.json

import { AcpAgent, autoPolicy, safePolicy } from "./acp.mjs";
import { resolveAgent, resolveEnv } from "./agents.mjs";
import { writeFile, mkdir, rm, cp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const agentId = flag("agent", "copilot");
const outPath = flag("out", `${agentId}-reverify.json`);
const tmp = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : "/tmp";
const REPO = new URL(".", import.meta.url).pathname;
const waitMs = Number(flag("wait", 240)) * 1000;
const sleep = (n) => new Promise((r) => setTimeout(r, n));

const only = (flag("only", "") || "").split(",").filter(Boolean);
const wanted = (tag) => only.length === 0 || only.includes(tag);

const spec = resolveAgent(agentId, flag("cmd"));

async function freshWorkspace(tag) {
  const ws = `${tmp}/reverify-${agentId}-${tag}`;
  await rm(ws, { recursive: true, force: true });
  await mkdir(ws, { recursive: true });
  for (const f of ["acp.mjs", "agents.mjs", "render.mjs", "run.mjs", "fanout.mjs"]) {
    await cp(`${REPO}/${f}`, `${ws}/${f}`);
  }
  return ws;
}

// Every inbound request the harness made, read back off the wire log — AcpAgent
// answers fs/* and session/request_permission internally and surfaces only the
// synthetic events, so "never called fs/*" has to be read from the wire.
async function inboundRequests(wirePath) {
  if (!existsSync(wirePath)) return [];
  const out = [];
  const rl = createInterface({ input: createReadStream(wirePath) });
  for await (const line of rl) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.dir !== "agent->client") continue;
    const m = rec.msg;
    if (m && m.method && m.id !== undefined) out.push({ ms: rec.ms, method: m.method, params: m.params });
  }
  return out;
}

async function run({ tag, policy, prompts = [], modeProbe = false }) {
  const ws = await freshWorkspace(tag);
  const wire = `${tmp}/${agentId}-${tag}.wire.jsonl`;
  await rm(wire, { force: true });

  const args = [new URL("./wire-tap.mjs", import.meta.url).pathname, wire, spec.command, ...spec.args];
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const events = [];
  const permissions = [];

  const agent = new AcpAgent({
    name: spec.name,
    command: process.execPath,
    args,
    env: resolveEnv(spec.env),
    cwd: ws,
    policy,
    verbose: has("verbose"),
    onEvent: ({ update = {} }) => {
      events.push({ ms: ms(), update: structuredClone(update) });
      if (update.sessionUpdate === "_client_permission") {
        permissions.push({ ms: ms(), allow: update.allow, kind: update.kind, title: update.title });
        console.error(`[${ms()}ms] permission ${update.kind} "${String(update.title).slice(0, 60)}" -> ${update.allow ? "ALLOW" : "REFUSE"}`);
      }
    },
  });

  const r = { tag, workspace: ws, wire, turns: [], permissions, modeProbes: [] };
  try {
    r.initialize = await agent.start();
    r.initializeMs = ms();
    const t = Date.now();
    const sessionRes = await agent.request("session/new", { cwd: ws, mcpServers: [] });
    r.sessionNewMs = Date.now() - t;
    agent.sessionId = sessionRes.sessionId;
    r.sessionNew = sessionRes;

    if (modeProbe) {
      for (const modeId of [flag("mode", "https://agentclientprotocol.com/protocol/session-modes#plan"), "definitely-not-a-mode"]) {
        // No timeout on agent.request: a harness that simply never answers
        // set_mode would hang the probe forever, which is itself a result.
        const res = await Promise.race([
          agent.request("session/set_mode", { sessionId: agent.sessionId, modeId })
            .then((result) => ({ outcome: "ok", result: result ?? null }))
            .catch((e) => ({ outcome: "error", detail: e.message })),
          sleep(20000).then(() => ({ outcome: "no-answer" })),
        ]);
        r.modeProbes.push({ modeId, ...res });
        console.error(`[${ms()}ms] set_mode ${modeId} -> ${res.outcome}${res.detail ? ` (${res.detail})` : ""}`);
      }
    }

    for (const [i, text] of prompts.entries()) {
      const before = events.length;
      const startedMs = ms();
      console.error(`\n[${startedMs}ms] --- ${tag} turn ${i + 1}: ${text.slice(0, 70)}`);
      const res = await Promise.race([
        agent.request("session/prompt", { sessionId: agent.sessionId, prompt: [{ type: "text", text }] })
          .then((result) => ({ outcome: "answered", result }))
          .catch((e) => ({ outcome: "error", detail: e.message })),
        sleep(waitMs).then(() => ({ outcome: "no-answer" })),
      ]);
      r.turns.push({
        turn: i + 1, prompt: text, startedMs, endedMs: ms(),
        outcome: res.outcome, result: res.result ?? null, detail: res.detail ?? null,
        updates: events.length - before,
      });
      if (res.outcome !== "answered") break;
    }
    await sleep(1500);
  } catch (err) {
    r.fatal = err.message;
    console.error("FATAL", err.message);
  } finally {
    agent.stop();
  }

  await sleep(300);
  r.updateKinds = events.reduce((a, e) => {
    const k = e.update.sessionUpdate ?? "(none)";
    a[k] = (a[k] ?? 0) + 1; return a;
  }, {});
  r.inbound = await inboundRequests(wire);
  r.inboundMethods = r.inbound.reduce((a, x) => { a[x.method] = (a[x.method] ?? 0) + 1; return a; }, {});
  r.events = events;
  return r;
}

const record = { harness: spec.name, command: `${spec.command} ${spec.args.join(" ")}`.trim(), startedAt: new Date().toISOString(), runs: [] };

// 1. read — the M0-1 handshake/turn/capability row set.
if (wanted("read")) record.runs.push(await run({
  tag: "read",
  policy: autoPolicy,
  prompts: ["Read the file acp.mjs in this directory and reply with one sentence describing what it does. Do not modify anything."],
}));

// 2. write under safe — the containment probe (M0-FINDINGS.md:166-180).
if (wanted("write")) {
  const writeRun = await run({
    tag: "write",
    policy: safePolicy,
    prompts: ["Create a file called blocked.txt in this directory containing the single word BLOCKED."],
  });
  writeRun.blockedTxtExists = existsSync(`${writeRun.workspace}/blocked.txt`);
  if (writeRun.blockedTxtExists) writeRun.blockedTxtContent = await readFile(`${writeRun.workspace}/blocked.txt`, "utf8");
  record.runs.push(writeRun);
}

// 3. modes — session/new mode fields, plus set_mode valid and bogus.
if (wanted("modes")) record.runs.push(await run({ tag: "modes", policy: autoPolicy, modeProbe: true }));

// 4. read under safe — the claim M0-6 shipped: copilot reads by shelling out,
// so `safe` refuses its reads and makes it unusable rather than cautious.
// 5. exploratory read under safe — the read above names the file, so it never
// needs to look around. An exploratory prompt is where copilot's shelled `ls`
// (kind `execute`, outside READ_ONLY_KINDS) actually meets the policy.
if (wanted("explore-safe")) record.runs.push(await run({
  tag: "explore-safe",
  policy: safePolicy,
  prompts: ["What files are in this directory? List them and summarise in one sentence what this codebase does."],
}));

if (wanted("read-safe")) record.runs.push(await run({
  tag: "read-safe",
  policy: safePolicy,
  prompts: ["Read the file acp.mjs in this directory and reply with one sentence describing what it does. Do not modify anything."],
}));

await writeFile(outPath, JSON.stringify(record, null, 2));

console.log(`\n─── M0-1 re-verification · ${record.harness} ───────────────`);
console.log(`command            ${record.command}`);
console.log(`agentInfo          ${JSON.stringify(record.runs[0]?.initialize?.agentInfo ?? null)}`);
console.log(`protocolVersion    ${record.runs[0]?.initialize?.protocolVersion}`);
console.log(`authMethods        ${JSON.stringify((record.runs[0]?.initialize?.authMethods ?? []).map((a) => a.id))}`);
for (const r of record.runs) {
  console.log(`\n[${r.tag}]  init ${r.initializeMs}ms  session/new ${r.sessionNewMs}ms`);
  for (const t of r.turns) console.log(`   turn ${t.turn}  ${t.outcome}  ${((t.endedMs - t.startedMs) / 1000).toFixed(1)}s  updates=${t.updates}  stopReason=${t.result?.stopReason ?? "-"}`);
  console.log(`   update kinds     ${JSON.stringify(r.updateKinds)}`);
  console.log(`   inbound requests ${JSON.stringify(r.inboundMethods)}`);
  console.log(`   permissions      ${r.permissions.length ? JSON.stringify(r.permissions.map((p) => `${p.kind}:${p.allow ? "allow" : "refuse"}`)) : "none"}`);
  if (r.modeProbes.length) console.log(`   set_mode         ${JSON.stringify(r.modeProbes.map((m) => `${m.modeId}=${m.outcome}${m.detail ? ` (${m.detail})` : ""}`))}`);
  if (r.tag === "write") console.log(`   blocked.txt      ${r.blockedTxtExists ? "*** WRITTEN ***" : "not created"}`);
}
console.log(`\nfull record  ${outPath}`);
