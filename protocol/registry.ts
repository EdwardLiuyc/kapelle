/**
 * How to launch each harness, and what we measured when we ran it — M1a-4.
 *
 * This is the whole adapter layer. Adding a harness means adding a line here,
 * not writing an integration — that is the point of ACP.
 *
 * **The entry is split in two, and the split is load-bearing.** `launch` is a
 * recipe we choose: it is true until the harness changes its CLI. `measured`
 * is a lab report: every field is a claim about one *build*, and M0-7 watched
 * three of them change in three days (`docs/FINDINGS.md`). Every entry here
 * has a lab report (M9 D2, #296): an unmeasured harness starts with `--cmd`.
 * `measured` stays optional because `--cmd` builds an entry without one, and
 * its absence is the only marker of an unverified harness (#62 B5, one
 * mechanism, no second flag to drift out of sync). Every consumer must handle
 * it missing; `warningsFor` is where that conservative reading lives.
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
 * text ever reaches us and on which message. They are independent — all six
 * harnesses run commands internally, yet each still hands us the argv on a
 * notification (`docs/FINDINGS.md` §Roll-up, "What M1a-4 should put in the
 * registry"; §M9-1 re-measure).
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
  /** Whether the `usage` on the `session/prompt` reply counts this turn or
   *  the whole session (§M0-5). Not `usage_update.used`: that is the context
   *  in use, on every harness. */
  usage: "per-turn" | "cumulative" | "absent";
  /** Vendor `_meta` flags the harness gates real behaviour on. */
  meta?: MetaFlags;
  /** `session/load` into a new process brought the conversation back
   *  (§M0-9). A room loads only with this and `loadSession: true`. */
  loads?: true;
  /** The build these labels describe. Compared at handshake; warns only. */
  measuredOn: { version: string; date: string };
}

/**
 * How to find the harness on `PATH` (M9-3). Our choice, as `launch` is.
 * `program` is the agent itself (`pi`); `launch.command` is its ACP program
 * (`pi-acp`), which may be the same program. `npm` is the ACP program's npm
 * package, set only where it is a separate one. The install pins it to
 * `measuredOn.version` (M9-3b), so the version lives in one place.
 *
 * `login` is what the person runs to log in (M9-4), from the agent's own
 * `--help`. `loginSignal` says how the agent tells us it cannot work
 * (§Models and login). By default, `session/new` fails with `-32000`, so a
 * session that opens means `ok`: the agent can use its models. That is the
 * meaning, not "the person has an account" (decided 2026-10-28): opencode
 * opens a session with its free models and no login, and it is `ok`.
 * `notice`: claude's `_auth/status_update`. `none`: copilot, which never
 * says. `loadNeedsLogin`: `session/load` fails with `-32000` too when logged
 * out, so a load that works is `ok` (§Models and login, 2026-10-30). Only
 * codex and kimi: pi, opencode, claude and copilot load a session logged
 * out.
 */
export interface SetupSpec {
  program: string;
  npm?: string;
  /** The ACP program has no `--version`: read its npm `package.json`. */
  versionFromPackage?: true;
  login: string;
  loginSignal?: "notice" | "none";
  loadNeedsLogin?: true;
}

export interface AgentEntry {
  launch: LaunchSpec;
  /** Absent for `--cmd`: such a harness is not looked for. */
  setup?: SetupSpec;
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
    setup: { program: "opencode", login: "opencode auth login" },
    defaultMode: "ask",
    maxMode: "auto",
    measured: {
      shell: "internal",
      // `none` on 1.18.18. On 2.0.18 the command comes on the first
      // `tool_call_update` (§M0-3, 2026-10-09, #240).
      argvChannel: "notification",
      // No permission request for a write inside the root: it wrote a file
      // under `safe`. On 2.0.18 it asks for a write outside the root, and it
      // also sends `fs/write_text_file` but writes the file even when we
      // refuse that (§M9-1 re-measure). `false`, because the normal edit
      // never asks, and `core/result.ts` reads that.
      asksPermission: false,
      // Advertises no `modes` at all; the ids appear only in `configOptions`
      // with `category: "mode"`, yet `session/set_mode` accepts and validates
      // them. Mode discovery must read both fields or opencode looks modeless.
      modeMap: { safe: "plan", ask: "build", auto: "build" },
      usage: "per-turn",
      // §M0-9, on 2.0.18, 2026-09-27, and again on 2026-10-21.
      loads: true,
      // Every field measured again on 2.0.18 (#296).
      measuredOn: { version: "2.0.18", date: "2026-10-21" },
    },
  },

  // Vanilla Pi has no native mode; the community adapter spawns `pi --mode rpc`
  // behind an ACP front end. Install with: npm i -g pi-acp
  pi: {
    launch: { command: "pi-acp", args: [] },
    // pi-acp has no `--version`: it starts its server instead (#298).
    setup: {
      program: "pi",
      npm: "pi-acp",
      versionFromPackage: true,
      login: "pi, then /login",
    },
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
      // No `usage` on the prompt reply. It sends `usage_update` on 0.0.34.
      usage: "absent",
      // §M0-9, on 0.0.34, 2026-09-27, and again on 2026-10-21.
      loads: true,
      // pi-acp 0.0.33 was measured against pi v0.85.1 on 2026-09-09. Every
      // field measured again on 0.0.34 against pi 1.1.0 (#296).
      measuredOn: { version: "0.0.34", date: "2026-10-21" },
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
    setup: {
      program: "claude",
      npm: "@agentclientprotocol/claude-agent-acp",
      login: "claude auth login",
      loginSignal: "notice",
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
      // §M0-9, on 0.81.1, 2026-09-27, and again on 2026-10-21.
      loads: true,
      // Measured again on 0.89.1 (#296): `shell`, `argvChannel` (still empty
      // on the `tool_call`, complete on the update), `asksPermission`,
      // `modeMap.safe` and `modeMap.ask`, and `loads`. `usage` is measured
      // for the first time: two turns in one session, input 4 → 2 tokens.
      // **Two fields are carried forward**, and the date does not cover them:
      // `modeMap.auto`, which we never send, and `meta`, because it describes
      // what claude does when we advertise `terminal_output`, which this
      // client does not.
      measuredOn: { version: "0.89.1", date: "2026-10-21" },
    },
  },

  // Copilot CLI runs an ACP server behind a flag, not a subcommand — confirmed
  // against `copilot --help` on 1.0.78. Re-check there if this drifts.
  copilot: {
    launch: { command: "copilot", args: ["--acp"] },
    // copilot gives no login signal (decided 2026-10-15).
    setup: { program: "copilot", login: "copilot login", loginSignal: "none" },
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
      // §M0-9, on 1.0.88, 2026-09-27, and again on 2026-10-21.
      loads: true,
      // Every field measured again on 1.0.91 (#296), except `modeMap.auto`,
      // which we never send.
      measuredOn: { version: "1.0.91", date: "2026-10-21" },
    },
  },

  // Codex has no native ACP mode. The official adapter runs it behind an ACP
  // front end and uses the `codex` login. Install the Codex CLI, then:
  //   npm i -g @agentclientprotocol/codex-acp
  codex: {
    launch: { command: "codex-acp", args: [] },
    setup: {
      program: "codex",
      npm: "@agentclientprotocol/codex-acp",
      login: "codex login",
      loadNeedsLogin: true,
    },
    defaultMode: "ask",
    maxMode: "auto",
    measured: {
      // Runs commands itself. It adds `_meta.terminal_info` and a
      // `{type:"terminal"}` block for a terminal it never asks us to create.
      shell: "internal",
      // In `rawInput.command` on the `tool_call`, and again on the request.
      argvChannel: "notification",
      // Only in `read-only` and `workspace-write`. Its start mode, `agent`,
      // never asks us: its own model reviews each call. A refused request ends
      // the turn with `cancelled`.
      asksPermission: true,
      // `read-only` asks for every edit and every command, and does the work
      // once we approve. So it is `ask`'s id too. `workspace-write` also asked
      // for everything, but only in a folder codex does not trust; its own
      // description says it edits without asking (§Codex).
      modeMap: {
        safe: "read-only",
        ask: "read-only",
        auto: "agent-full-access",
      },
      usage: "per-turn",
      loads: true,
      measuredOn: { version: "2.2.2", date: "2026-10-21" },
    },
  },

  // Kimi Code runs an ACP server as a subcommand. Install it with Kimi's
  // own installer (§Models and login).
  kimi: {
    launch: { command: "kimi", args: ["acp"] },
    setup: { program: "kimi", login: "kimi login", loadNeedsLogin: true },
    defaultMode: "ask",
    maxMode: "auto",
    measured: {
      shell: "internal",
      // Late, as on claude: the `tool_call` has no `rawInput`, and the command
      // arrives whole on a `tool_call_update` after the request. The request
      // names it only in its `content` text.
      argvChannel: "notification",
      asksPermission: true,
      // `plan` runs no tool. `default` asks for every edit and command. `auto`
      // and `yolo` run commands without asking. It writes files through
      // `fs/write_text_file` in every mode, and honours our refusal (§Kimi Code).
      modeMap: { safe: "plan", ask: "default", auto: "yolo" },
      // No `usage` on the prompt reply; it sends `usage_update` only.
      usage: "absent",
      loads: true,
      measuredOn: { version: "2.3.0", date: "2026-10-21" },
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
 * the caveat that `safe` is defence in depth, not a sandbox. `unverified`,
 * `version` and `advisory` may be quieted. Callers filter on this field;
 * without it the printing side sees four indistinguishable strings and can
 * only choose all or none.
 *
 * `advisory` is the general case the other two are instances of, added for
 * #129's dirty-tree line. It says nothing about the harness — it is the run
 * telling the operator something they would otherwise be surprised by later.
 * A notice with **no** kind still always prints; the kind is how a caller
 * opts *into* being quietable.
 */
export interface Warning {
  kind: "containment" | "unverified" | "version" | "advisory";
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
