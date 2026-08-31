#!/usr/bin/env node
import { AcpAgent, autoPolicy, makeAskPolicy, safePolicy } from "./acp.mjs";
import { AGENTS, resolveAgent, resolveEnv } from "./agents.mjs";
import { render } from "./render.mjs";

const argv = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = argv[i - 1];
  return !(prev?.startsWith("--") && !["--verbose", "--quiet"].includes(prev));
});

const promptText = positional.join(" ").trim();

if (!promptText || flag("help")) {
  console.log(`
acp-mvp — a minimal Agent Client Protocol client

  node run.mjs "<prompt>" [options]

Options:
  --agent <id>     ${Object.keys(AGENTS).join(" | ")}   (default: opencode)
  --cmd "<cmd>"    custom agent command, e.g. --cmd "opencode acp"
  --cwd <dir>      workspace root (default: current directory)
  --mode <mode>    ask | safe | auto      (default: ask)
                     ask  = reads auto-approved, mutations prompt you
                     safe = reads only, all mutations refused
                     auto = approve everything (path guards still apply)
  --verbose        show agent stderr and protocol noise
  --quiet          only print the final assistant message

Examples:
  node run.mjs "list the top-level files and summarise this repo"
  node run.mjs "add a health endpoint" --cwd ../my-app --mode ask
  node run.mjs "what does src/index.ts do" --mode safe
`);
  process.exit(promptText ? 0 : 1);
}

const mode = flag("mode", "ask");
const verbose = argv.includes("--verbose");
const quiet = argv.includes("--quiet");

let policy = safePolicy;
let closeAsk = () => {};
if (mode === "auto") policy = autoPolicy;
else if (mode === "ask") {
  if (process.stdin.isTTY) {
    const asker = makeAskPolicy();
    policy = asker.policy;
    closeAsk = asker.close;
  } else {
    console.error("! not a TTY — falling back to --mode safe");
  }
} else if (mode !== "safe") {
  console.error(`unknown --mode ${mode}`);
  process.exit(1);
}

const spec = resolveAgent(flag("agent", "opencode"), flag("cmd"));

const agent = new AcpAgent({
  name: spec.name,
  command: spec.command,
  args: spec.args,
  env: resolveEnv(spec.env),
  cwd: flag("cwd", process.cwd()),
  policy,
  verbose,
  onEvent: quiet ? () => {} : render,
});

process.on("SIGINT", () => {
  console.error("\n^C cancelling turn…");
  agent.cancel();
  setTimeout(() => {
    agent.stop();
    process.exit(130);
  }, 2000);
});

try {
  const init = await agent.start();
  if (!quiet) {
    const who = init.agentInfo
      ? `${init.agentInfo.name} ${init.agentInfo.version ?? ""}`.trim()
      : spec.name;
    console.log(`connected to ${who} (ACP v${init.protocolVersion})`);
  }

  await agent.newSession();
  if (!quiet) console.log(`session ${agent.sessionId}\n`);

  const stopReason = await agent.prompt(promptText);
  if (!quiet) console.log(`\n\n— turn ended: ${stopReason}`);
} catch (err) {
  console.error(`\nerror: ${err.message}`);
  process.exitCode = 1;
} finally {
  closeAsk();
  agent.stop();
}
