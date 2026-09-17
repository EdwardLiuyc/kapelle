/**
 * How to launch each harness, and what we measured when we ran it — M1a-4.
 *
 * This is the whole adapter layer. Adding a harness means adding a line here,
 * not writing an integration — that is the point of ACP.
 *
 * **The entry is split in two, and the split is load-bearing.** `launch` is a
 * recipe we choose: it is true until the harness changes its CLI. `measured`
 * is a lab report: every field is a claim about one *build*, and M0-7 watched
 * three of them change in three days (`docs/M0-FINDINGS.md`). Two entries
 * (`omp`, `gemini`) have a real recipe and no lab report — they were never
 * installed here — so `measured` is optional, and its absence is the only
 * marker of an unverified harness (#62 B5, one mechanism, no second flag to
 * drift out of sync). Every consumer must handle it missing; `warningsFor`
 * is where that conservative reading lives.
 */

// pi-lens-ignore: no-unsafe-dictionary-unknown
type MetaFlags = Record<string, unknown>;

/** Client-side permission modes, in the total order `safe < ask < auto`. */
export type ClientMode = "safe" | "ask" | "auto";

/** Environment edits applied before spawning: `unset` first, then `set`. */
export interface EnvSpec {
  unset?: string[];
  set?: Record<string, string>;
}

/** How to start the harness. Our choice, not a measurement. */
// Not exported until a consumer needs to name it — M1a-5/M1a-7 will.
interface LaunchSpec {
  command: string;
  args: string[];
  env?: EnvSpec;
}

/**
 * What we saw on the wire. Present only for harnesses actually run here.
 *
 * `shell` says *where* a command runs; `argvChannel` says whether the command
 * text ever reaches us and on which message. They are independent — two of
 * three harnesses run commands internally yet still hand us the argv
 * (`docs/M0-FINDINGS.md:57-66`).
 */
interface MeasuredLabels {
  shell: "terminal" | "internal" | "unknown";
  argvChannel: "terminal" | "notification" | "permission" | "none";
  /** False means the policy has no jurisdiction at all — not reduced reach. */
  asksPermission: boolean;
  /** Harness-side mode ids, per client mode. Vocabularies do not align.
   *  Optional because a measured harness may expose no safety/behaviour modes:
   *  pi-acp's ACP modes are thinking-effort levels, so mapping them to
   *  `safe`/`ask`/`auto` would claim a mode that does not restrict anything. */
  modeMap?: Record<ClientMode, string>;
  /** Whether `usage_update.used` counts this turn or the whole session. */
  usage: "per-turn" | "cumulative" | "absent";
  /** Vendor `_meta` flags the harness gates real behaviour on. */
  meta?: MetaFlags;
  /** The build these labels describe. Compared at handshake; warns only. */
  measuredOn: { version: string; date: string };
}

export interface AgentEntry {
  launch: LaunchSpec;
  measured?: MeasuredLabels;
  /** Client policy, not measurement: where a run starts and how far it may go. */
  defaultMode?: ClientMode;
  maxMode?: ClientMode;
}

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
 * `CLAUDE_CODE_*` markers it does export.
 *
 * Only registry entries get this. `--cmd` builds its spec from the string
 * alone, so `--cmd "claude-agent-acp"` inherits `process.env` unscrubbed.
 */
const CLAUDE_PARENT_ENV: EnvSpec = {
  unset: ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"],
};

/**
 * Our own variables, stripped from every harness's environment unconditionally
 * — entry or `--cmd`, env spec or none (M2-8). A daemon holding the shared
 * secret would otherwise hand it to every subprocess it spawns.
 */
export const SECRET_PREFIX = "KAPELLE_";

export const AGENTS: Record<string, AgentEntry> = {
  // Native ACP support: `opencode acp` starts it as an ACP subprocess.
  opencode: {
    launch: { command: "opencode", args: ["acp"] },
    defaultMode: "ask",
    maxMode: "auto",
    measured: {
      shell: "internal",
      argvChannel: "none",
      // Zero permission requests in any mode — it wrote a file under `safe`.
      asksPermission: false,
      // Advertises no `modes` at all; the ids appear only in `configOptions`
      // with `category: "mode"`, yet `session/set_mode` accepts and validates
      // them. Mode discovery must read both fields or opencode looks modeless.
      modeMap: { safe: "plan", ask: "build", auto: "build" },
      usage: "per-turn",
      measuredOn: { version: "1.18.18", date: "2026-08-22" },
    },
  },

  // oh-my-pi ships native ACP too. Never installed here: no measured half.
  omp: {
    launch: { command: "omp", args: ["acp"] },
    defaultMode: "ask",
    maxMode: "auto",
  },

  // Vanilla Pi has no native mode; the community adapter spawns `pi --mode rpc`
  // behind an ACP front end. Install with: npm i -g pi-acp
  pi: {
    launch: { command: "pi-acp", args: [] },
    defaultMode: "ask",
    maxMode: "auto",
    measured: {
      shell: "internal",
      // Shell command text arrives in the `tool_call` title, and command
      // output/exit arrive in `tool_call_update._meta`. It also emits a
      // `{type:"terminal"}` content block and `_meta.terminal_info` for a
      // terminal it never asks the client to create.
      argvChannel: "notification",
      // Zero `session/request_permission` requests in any mode; under `safe` it
      // wrote the file anyway, so the policy has no jurisdiction.
      asksPermission: false,
      // No modeMap: pi-acp exposes ACP session modes as thinking-effort levels
      // (`off`…`xhigh`), not as plan/build/bypass style safety modes. Sending
      // `session/set_mode` under `safe` would only change thinking effort and
      // would not make `safe` any more binding.
      usage: "absent",
      // pi-acp 0.0.33 was measured against pi v0.85.1 on this machine.
      measuredOn: { version: "0.0.33", date: "2026-09-09" },
    },
  },

  // Claude Code has no native ACP mode. The official adapter wraps the Claude
  // Agent SDK behind an ACP front end, and authenticates via whatever the
  // `claude` CLI already uses. Install with:
  //   npm i -g @agentclientprotocol/claude-agent-acp
  // Its deprecated predecessor @zed-industries/claude-code-acp is not
  // supported; `npm i -g` the package above rather than pinning the old name.
  claude: {
    launch: {
      command: "claude-agent-acp",
      args: [],
      env: CLAUDE_PARENT_ENV,
    },
    defaultMode: "ask",
    maxMode: "auto",
    measured: {
      shell: "internal",
      // Late: `rawInput` is `{}` on the `tool_call` and complete ~0.5 s later
      // on the `tool_call_update`, so anything judging commands must read the
      // merged view, not the announcement.
      argvChannel: "notification",
      asksPermission: true,
      modeMap: { safe: "plan", ask: "default", auto: "bypassPermissions" },
      usage: "per-turn",
      // Gates a rendering convention: Bash calls gain `_meta.terminal_info`
      // and a `{type:"terminal"}` content block — for a terminal never
      // created, with no command output and no exit code (§M0-3).
      meta: { terminal_output: true },
      // Re-measured on 0.75.1, 2026-09-09. `shell`, `argvChannel`,
      // `asksPermission`, `modeMap.safe` and `modeMap.auto` were all
      // re-verified against the real adapter — argv still arrives empty on the
      // `tool_call` and complete on the update, and `set_mode` still accepts
      // both ids. **Two fields are carried forward, not re-verified**, and the
      // date does not cover them: `usage`, because telling per-turn from
      // cumulative needs two turns in one session, and no probe had run at this
      // date — the second turn is reachable now (`docs/M0-FINDINGS.md`
      // §Multi-turn, 2026-09-15), but `usage` is still carried forward, not
      // measured; and `meta`, because it describes what claude does when we
      // advertise `terminal_output`, which this client does not.
      measuredOn: { version: "0.75.1", date: "2026-09-09" },
    },
  },

  // Gemini CLI exposes ACP behind a flag. Never installed here.
  gemini: {
    launch: { command: "gemini", args: ["--acp"] },
    defaultMode: "ask",
    maxMode: "auto",
  },

  // Copilot CLI runs an ACP server behind a flag, not a subcommand — confirmed
  // against `copilot --help` on 1.0.78. Re-check there if this drifts.
  copilot: {
    launch: { command: "copilot", args: ["--acp"] },
    defaultMode: "ask",
    maxMode: "auto",
    measured: {
      shell: "internal",
      // On the `tool_call` notification, and again on the permission request.
      argvChannel: "notification",
      asksPermission: true,
      // The full URL is the id. The bare `#plan` fragment returns -32602 and
      // would go into the registry as a broken value (M0-7).
      modeMap: {
        safe: "https://agentclientprotocol.com/protocol/session-modes#plan",
        ask: "https://agentclientprotocol.com/protocol/session-modes#agent",
        auto: "https://agentclientprotocol.com/protocol/session-modes#autopilot",
      },
      usage: "cumulative",
      measuredOn: { version: "1.0.80", date: "2026-08-23" },
    },
  },
};

const RUNTIMES = new Set([
  "node",
  "npx",
  "bun",
  "bunx",
  "deno",
  "python",
  "python3",
]);

export interface ResolvedAgent extends AgentEntry {
  name: string;
}

export function resolveAgent(id: string, customCmd?: string): ResolvedAgent {
  // Trim before splitting: " node x.mjs" splits to ["", "node", "x.mjs"], so
  // the command becomes the empty string and the label with it. A --cmd flag
  // is usually stripped by the shell; a cmd read out of a JSON run file is not.
  const trimmed = customCmd?.trim();
  if (trimmed) {
    const [command, ...args] = trimmed.split(/\s+/);
    // "node mock-agent.mjs" should read as "mock-agent", not "node".
    const label =
      RUNTIMES.has(command) && args[0]
        ? (args[0].split("/").pop() ?? args[0]).replace(/\.(mjs|js|ts|py)$/, "")
        : command;
    // No measured half: a custom command is an unverified harness by
    // definition, and warns as one.
    return { name: label, launch: { command, args } };
  }
  const spec = AGENTS[id];
  if (!spec) {
    throw new Error(
      `unknown agent "${id}". Known: ${Object.keys(AGENTS).join(", ")}. ` +
        `Or pass --cmd "<command> <args>".`,
    );
  }
  return { name: id, ...spec };
}

/**
 * Build the environment a harness is spawned with.
 *
 * Returns `base` **by identity** when there is nothing to do, so harnesses
 * without env quirks keep sharing `process.env` rather than each getting a
 * copy. The `KAPELLE_*` strip is the one thing that can force a copy even
 * for an entry that declares no `env` — the two decisions collide only when
 * such a variable is actually set, and secrecy wins that collision.
 */
export function resolveEnv(
  spec: EnvSpec | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const secrets = Object.keys(base).filter((k) => k.startsWith(SECRET_PREFIX));
  if (!spec && secrets.length === 0) return base;
  const env = { ...base };
  for (const key of secrets) delete env[key];
  for (const key of spec?.unset ?? []) delete env[key];
  return Object.assign(env, spec?.set ?? {});
}

/**
 * Which rule produced a warning — and therefore whether `--quiet` may drop it.
 *
 * `containment` is never suppressible (#13, `docs/STORIES.md` M1a-7): #62 R1
 * kept the name `safe` and paid for it by making that line the only carrier of
 * the caveat that `safe` is defence in depth, not a sandbox. `unverified` and
 * `version` are advisory and may be quieted. Callers filter on this field;
 * without it the printing side sees three indistinguishable strings and can
 * only choose all or none.
 */
export interface Warning {
  kind: "containment" | "unverified" | "version";
  text: string;
  /** Set only when the same line belongs once per run, not once per task.
   *  The caller supplies the deduplication; the registry only names what is
   *  a property of the harness rather than of one task. */
  onceKey?: string;
}

/**
 * Which of `warningsFor`'s lines survive `--quiet`.
 *
 * One line of logic, but the one #13 turns on, so it lives here as a function
 * with a test rather than as an `if` at the call site: inverting it there
 * would silence the containment notice and leave every suite green. #62 R1
 * kept the name `safe` and made that notice the sole carrier of the caveat
 * that `safe` filters rather than enforces, so it is never suppressible; the
 * unverified and stale-version lines are advisory and may go.
 */
export const printableWarnings = (
  warnings: Warning[],
  quiet: boolean,
): Warning[] => warnings.filter((w) => !quiet || w.kind === "containment");

/**
 * The one place an entry becomes a claim about safety.
 *
 * Every rule here is conservative: a harness we could not verify produces the
 * same warnings as the least contained harness we did verify, so silence
 * always means "measured, and fine" — never "we never looked". Printing these
 * is M1a-7's job (`docs/STORIES.md:611`); deciding them is this story's.
 *
 * `liveVersion` is `agentInfo.version` from the handshake when the harness
 * sends one. It is optional on the wire, so a missing version is silence, not
 * a warning — and the staleness check never fails a run either way (#62 B2).
 */
export function warningsFor(
  name: string,
  entry: AgentEntry,
  mode: ClientMode,
  liveVersion?: string,
): Warning[] {
  const out: Warning[] = [];
  const m = entry.measured;

  if (!m) {
    out.push({
      kind: "unverified",
      text:
        `${name}: no measured labels for this harness — assuming commands run ` +
        `inside it, that we never see the argv, and that the policy has no ` +
        `jurisdiction. Treat any safety claim as unverified.`,
    });
    return out;
  }

  if (!m.asksPermission) {
    // Louder than containment, and true in `auto` too, where the containment
    // warning stays silent but the silent-autonomy risk is highest. The key
    // is M0-1's anti-crying-wolf rule: N opencode tasks are one harness
    // property, not N surprises.
    out.push({
      kind: "containment",
      text:
        `${name}: never asks permission — the policy has no jurisdiction over ` +
        `it in any mode, so --mode ${mode} does not bound what it does.`,
      onceKey: `never-asks:${name}`,
    });
  } else if (mode !== "auto" && m.shell !== "terminal") {
    out.push({
      kind: "containment",
      text:
        `${name}: runs its own commands (shell: ${m.shell}), so --mode ${mode} ` +
        `filters only what it routes through the protocol.`,
    });
  }

  if (liveVersion && liveVersion !== m.measuredOn.version) {
    out.push({
      kind: "version",
      text:
        `${name}: labels were measured on ${m.measuredOn.version} ` +
        `(${m.measuredOn.date}); this build is ${liveVersion}.`,
    });
  }

  return out;
}
