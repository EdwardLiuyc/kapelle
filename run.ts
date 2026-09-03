#!/usr/bin/env node
import { createEventBus } from "./core/events.ts";
import {
  makeAskPolicy,
  negotiateSafeMode,
  policyFor,
  type ResolvedPolicy,
  resolvePolicy,
} from "./core/policy.ts";
import { AcpAgent } from "./protocol/agent.ts";
import type { ClientMode } from "./protocol/registry.ts";
import {
  AGENTS,
  printableWarnings,
  resolveAgent,
  resolveEnv,
  warningsFor,
} from "./protocol/registry.ts";
import { render } from "./render.ts";

const argv = process.argv.slice(2);

/**
 * Value of `--name`, or `fallback` when the flag is absent.
 *
 * A flag that is *present* but carries no value is a usage error, not an
 * absence: `--cmd --mode auto` must not quietly launch the default harness
 * under a mode the caller never meant to pair it with. Same reason
 * `resolvePolicy` raises on a mode above the ceiling instead of downgrading —
 * running something other than what was asked for is the failure, whichever
 * direction it goes.
 */
function flag(name: string): string | undefined;
function flag(name: string, fallback: string): string;
function flag(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (!next || next.startsWith("--")) {
    console.error(`--${name} needs a value`);
    process.exit(1);
  }
  return next;
}

const has = (name: string) => argv.includes(`--${name}`);

/** `catch` binds `unknown`; a harness can reject with anything. */
const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = argv[i - 1];
  return !(prev?.startsWith("--") && !["--verbose", "--quiet"].includes(prev));
});

const promptText = positional.join(" ").trim();

if (!promptText || has("help")) {
  console.log(`
acp-mvp — a minimal Agent Client Protocol client

  node run.ts "<prompt>" [options]

Options:
  --agent <id>     ${Object.keys(AGENTS).join(" | ")}   (default: opencode)
  --cmd "<cmd>"    custom agent command, e.g. --cmd "opencode acp"
  --cwd <dir>      workspace root (default: current directory)
  --mode <mode>    ask | safe | auto      (default: the agent's own)
                     ask  = reads auto-approved, mutations prompt you
                     safe = reads only, all mutations refused
                     auto = approve everything (path guards still apply)
  --verbose        show agent stderr and protocol noise
  --quiet          suppress normal output; safety notices still print

Examples:
  node run.ts "list the top-level files and summarise this repo"
  node run.ts "add a health endpoint" --cwd ../my-app --mode ask
  node run.ts "what does src/index.ts do" --mode safe
`);
  process.exit(promptText ? 0 : 1);
}

const verbose = has("verbose");
const quiet = has("quiet");

const spec = resolveAgent(flag("agent", "opencode"), flag("cmd"));

// `task > run > harness > default`: run.ts is one task, so `--mode` is the run
// layer and the registry entry is the harness layer. An unknown mode, or one
// above the entry's ceiling, is a validation error here rather than a silent
// downgrade. There is no `--allow-read-outside-root` flag: the task layer that
// carries it arrives with M1b-1's run file, and inventing a CLI surface for it
// now would be a second place to keep in step.
// The cast is the boundary: argv is strings, and `resolvePolicy` is the one
// place that validates a mode — it throws naming the known ones, which is a
// better error than anything a second check here could produce.
const resolveOrExit = (mode: string | undefined): ResolvedPolicy => {
  try {
    return resolvePolicy({
      run: { mode: mode as ClientMode | undefined },
      harness: {
        name: spec.name,
        mode: spec.defaultMode,
        maxMode: spec.maxMode,
      },
    });
  } catch (err) {
    console.error(messageOf(err));
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

  // M1a-4 decides these lines; this story decides which survive `--quiet`.
  // The rule itself sits in the registry next to `warningsFor`, where it has
  // a test — a bare `if` here is exactly what could be inverted unnoticed.
  const warnings = printableWarnings(
    warningsFor(spec.name, spec, resolved.mode, init.agentInfo?.version),
    quiet,
  );
  for (const w of warnings) console.error(`! ${w.text}`);

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
  console.error(`\nerror: ${messageOf(err)}`);
  process.exitCode = 1;
} finally {
  closeAsk();
  agent.stop();
}
