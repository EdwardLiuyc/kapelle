/**
 * How to launch each harness as an ACP agent subprocess.
 *
 * This is the whole adapter layer. Adding a harness means adding a line here,
 * not writing an integration — that is the point of ACP.
 */

/**
 * Markers a Claude Code parent session leaves in the environment, scrubbed
 * before spawning the Claude adapter. M0-1 hit an adapter that refused to
 * start a nested session — an opaque `-32603` on `session/new` — and got a
 * clean handshake only with all three gone. Adapter 0.49.0 no longer refuses,
 * so this is regression insurance rather than a live fix; don't delete it on
 * finding it does nothing today.
 *
 * The list is M0-1's, not a survey of the parent: a CLI parent sets neither
 * `CLAUDE_CODE_SSE_PORT` (an IDE/SSE variable) nor several other
 * `CLAUDE_CODE_*` markers it does export. Widening it is M1a-4/M2-8 work —
 * see the note on always-scrubbing secrets from *every* harness's env.
 *
 * Only registry entries get this. `--cmd` builds its spec from the string
 * alone, so `--cmd "claude-agent-acp"` inherits `process.env` unscrubbed.
 *
 * Shape is M1a-4's registry `env` field: `{ unset?, set? }`.
 */
const CLAUDE_PARENT_ENV = {
  unset: ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"],
};

export const AGENTS = {
  // Native ACP support: `opencode acp` starts it as an ACP subprocess.
  opencode: { command: "opencode", args: ["acp"] },

  // oh-my-pi ships native ACP too.
  omp: { command: "omp", args: ["acp"] },

  // Vanilla Pi has no native mode; the community adapter spawns `pi --mode rpc`
  // behind an ACP front end. Install with: npm i -g pi-acp
  pi: { command: "pi-acp", args: [] },

  // Claude Code has no native ACP mode. The official adapter wraps the Claude
  // Agent SDK behind an ACP front end, and authenticates via whatever the
  // `claude` CLI already uses. Install with:
  //   npm i -g @agentclientprotocol/claude-agent-acp
  // Its deprecated predecessor @zed-industries/claude-code-acp is not
  // supported; `npm i -g` the package above rather than pinning the old name.
  claude: { command: "claude-agent-acp", args: [], env: CLAUDE_PARENT_ENV },

  // Gemini CLI exposes ACP behind a flag.
  gemini: { command: "gemini", args: ["--acp"] },

  // Copilot CLI runs an ACP server behind a flag, not a subcommand — confirmed
  // against `copilot --help` on 1.0.78. Re-check there if this drifts.
  copilot: { command: "copilot", args: ["--acp"] },
};

const RUNTIMES = new Set(["node", "npx", "bun", "bunx", "deno", "python", "python3"]);

export function resolveAgent(id, customCmd) {
  if (typeof customCmd === "string" && customCmd.length > 0) {
    const [command, ...args] = customCmd.split(/\s+/);
    // "node mock-agent.mjs" should read as "mock-agent", not "node".
    const label = RUNTIMES.has(command) && args[0]
      ? args[0].split("/").pop().replace(/\.(mjs|js|ts|py)$/, "")
      : command;
    return { name: label, command, args };
  }
  const spec = AGENTS[id];
  if (!spec) {
    throw new Error(
      `unknown agent "${id}". Known: ${Object.keys(AGENTS).join(", ")}. ` +
        `Or pass --cmd "<command> <args>".`
    );
  }
  return { name: id, ...spec };
}

/**
 * Apply a registry `env` spec to a base environment. Returns `base` untouched
 * when the entry declares nothing, so agents without an env spec keep sharing
 * `process.env` rather than getting a copy.
 */
export function resolveEnv(spec, base = process.env) {
  if (!spec) return base;
  const env = { ...base };
  for (const key of spec.unset ?? []) delete env[key];
  return Object.assign(env, spec.set ?? {});
}
