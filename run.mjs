#!/usr/bin/env node
import { createEventBus } from "./core/events.ts";
import {
  makeAskPolicy,
  negotiateSafeMode,
  policyFor,
  resolvePolicy,
} from "./core/policy.ts";
import { AcpAgent } from "./protocol/agent.ts";
import {
  AGENTS,
  resolveAgent,
  resolveEnv,
  warningsFor,
} from "./protocol/registry.ts";
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
  --mode <mode>    ask | safe | auto      (default: the agent's own)
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

const verbose = argv.includes("--verbose");
const quiet = argv.includes("--quiet");

const spec = resolveAgent(flag("agent", "opencode"), flag("cmd"));

// `task > run > harness > default`: run.mjs is one task, so `--mode` is the run
// layer and the registry entry is the harness layer. An unknown mode, or one
// above the entry's ceiling, is a validation error here rather than a silent
// downgrade. There is no `--allow-read-outside-root` flag: the task layer that
// carries it arrives with M1b-1's run file, and inventing a CLI surface for it
// now would be a second place to keep in step.
const resolveOrExit = (mode) => {
  try {
    return resolvePolicy({
      run: { mode },
      harness: {
        name: spec.name,
        mode: spec.defaultMode,
        maxMode: spec.maxMode,
      },
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
};

let resolved = resolveOrExit(flag("mode"));
let closeAsk = () => {};

// `ask` degrades to `safe` without a TTY, and re-resolves rather than just
// renaming itself, so `safe`'s own rules apply to the mode we actually run.
if (resolved.mode === "ask" && !process.stdin.isTTY) {
  console.error("! not a TTY — falling back to --mode safe");
  resolved = resolveOrExit("safe");
}

let policy = policyFor(resolved.mode);
if (resolved.mode === "ask") {
  const asker = makeAskPolicy();
  policy = asker.policy;
  closeAsk = asker.close;
}

// M1a-6: every consumer subscribes; nothing reads agent state directly.
const bus = createEventBus();
if (!quiet) bus.subscribe(render);

const agent = new AcpAgent({
  name: spec.name,
  command: spec.launch.command,
  args: spec.launch.args,
  env: resolveEnv(spec.launch.env),
  cwd: flag("cwd", process.cwd()),
  policy,
  allowReadOutsideRoot: resolved.allowReadOutsideRoot,
  verbose,
  onEvent: bus.emit,
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

  // M1a-4: what this harness's measured labels say the mode does not bound.
  for (const line of warningsFor(
    spec.name,
    spec,
    resolved.mode,
    init.agentInfo?.version,
  )) {
    console.error(`! ${line}`);
  }

  await agent.newSession();

  // `safe`'s other half: negotiate before the first prompt, because filtering
  // reaches nothing on a harness that never asks. Printed like the containment
  // lines and, like them, not suppressed by --quiet (#13): this line says how
  // much of `safe` is actually in force.
  const notNegotiated = await negotiateSafeMode(agent, spec, resolved.mode);
  if (notNegotiated) console.error(`! ${notNegotiated}`);
  if (!quiet) console.log(`session ${agent.sessionId}\n`);

  // The whole PromptResponse is returned (#62 B3); M1 renders only stopReason.
  const { stopReason } = await agent.prompt(promptText);
  if (!quiet) console.log(`\n\n— turn ended: ${stopReason}`);
} catch (err) {
  console.error(`\nerror: ${err.message}`);
  process.exitCode = 1;
} finally {
  closeAsk();
  agent.stop();
}
