// M9-1: print modes and every non-model configOption. No prompt.
import { mkdtemp } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { AcpAgent } from "./protocol/agent.ts"; import { resolveAgent, resolveEnv } from "./protocol/registry.ts"; import { policyFor } from "./core/policy.ts";
const spec = resolveAgent(process.argv[2]); const cwd = await mkdtemp(join(tmpdir(), "m91-modes-"));
const a = new AcpAgent({ command: spec.launch.command, args: spec.launch.args, env: resolveEnv(spec.launch.env), cwd, policy: policyFor("safe") });
const init = await a.start(); const r = await a.request("session/new", { cwd, mcpServers: [] });
console.log(JSON.stringify({ meta: init._meta, agentMeta: init.agentCapabilities?._meta, prompt: init.agentCapabilities?.promptCapabilities, modes: r.modes, config: r.configOptions?.filter((o) => o.category !== "model") }, null, 1));
await a.stop(); process.exit(0);
