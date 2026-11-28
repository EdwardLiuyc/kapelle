#!/usr/bin/env node
/**
 * The CLI, and the `kapelle` bin (M1c-5). Strict `parseArgs` parsing.
 *
 * Two paths. **One prompt**: one harness, drawn live through `render.ts`,
 * which owns the cursor. **`run --file`** (a verb since M2-9; a bare `--file`
 * is refused): N tasks through `core/run.ts`, with prose buffered per task
 * and only milestones live. `--agent`, `--cmd` and `--mode` are refused beside
 * `--file`, because the run file answers those per task.
 *
 * `--detach` posts the run to the daemon instead, and `attach`, `ps` and
 * `daemon add` talk to that daemon through `client/daemon.ts`; `findDaemon()`
 * is where each of them starts, and it checks the API version. A configured
 * remote daemon also makes local `run --file` refuse: only `--detach` may run
 * there (M11-4). `attach` rebuilds the `--file` view from the event stream
 * alone, because a restored run has no `report`. The verdict is not the
 * view's: the settled run status on `GET /runs/:id` wins whenever the daemon
 * has one (M5-5), and `--task` answers with its own card (`TASK_STATUSES`).
 *
 * ^C sends `session/cancel`, waits 2 s, then stops the harness, and the
 * process exits only once the harness is gone.
 *
 * **Bare `kapelle` is the chat** (M9-2): on a terminal it starts the daemon
 * detached when none answers (`client/lifecycle.ts`), then hands over to
 * `chat.ts`. `kapelle --help` is the way to the help. On a pipe there is no
 * screen, so it does what `kapelle chat` does there: the chat usage, no
 * daemon. `kapelle daemon stop` is the other new verb.
 *
 * **`kapelle room`** (M8-3) is an orchestrator's hands in its room. It finds
 * the room and the sender from the checkout it runs in (`roomAndSender`).
 *
 * **`kapelle loop`** (M8-5) is the screens' `/loop` from a shell: the same
 * command (`client/command.ts`), then the chat on that room on a terminal,
 * as `kapelle chat new` does.
 *
 * **`kapelle demo`** (#463) is a room with the offline `demo-agent.mjs`, for
 * a person with no agent yet. It is local-only: a configured remote client
 * refuses it rather than sending its local folder and agent path over HTTP
 * (M11-4). `runDemoCommand` says where it works and why.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { text } from "node:stream/consumers";
import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import {
  loopCommand,
  modelConfirmed,
  notConfirmedOn,
  type RouteCommand,
  runCommand,
} from "./client/command.ts";
import type {
  MessageAccepted,
  ParticipantDto,
  PendingDecision,
  RepoAdded,
  RoomDto,
  RoomListEntry,
  RunAccepted,
  RunListEntry,
  RunStatus,
} from "./client/contract.ts";
import {
  call,
  checkVersion,
  clientConfigPath,
  type DaemonAddress,
  readClientDaemon,
  request,
  resolveDaemonAddress,
  VersionRefused,
} from "./client/daemon.ts";
import { agentDiff } from "./client/diff.ts";
import { FOLDER_GONE, folderToSend } from "./client/folder.ts";
import { ensureDaemon, stopDaemon } from "./client/lifecycle.ts";
import { listRecipes, loopFolders } from "./client/loop.ts";
import { fold } from "./client/mention.ts";
import { findAgain, setupLines } from "./client/setup.ts";
import { type Connect, followEvents } from "./client/stream.ts";
import { startHelp } from "./core/check.ts";
import {
  readProjectLinkPaths,
  resolveRunDefaults,
  warnUnknownConfigEnv,
} from "./core/config.ts";
import { createEventBus } from "./core/events.ts";
import { newRunId } from "./core/ids.ts";
import { mergeRun } from "./core/merge.ts";
import { makeNotifier } from "./core/notify.ts";
import {
  makeAskPolicy,
  negotiateSafeMode,
  policyFor,
  type ResolvedPolicy,
  resolvePolicy,
} from "./core/policy.ts";
import { withResultPreamble } from "./core/result.ts";
import {
  runRun,
  runStatus,
  type TaskRun,
  type TaskStatus,
} from "./core/run.ts";
import { type Task, validateRun } from "./core/runfile.ts";
import { runtimeDir, stateDir, stateDirFor } from "./core/runtime.ts";
import { roomCheckouts } from "./core/sweep.ts";
import { clean, oneLine } from "./core/text.ts";
import { moveWorkspace, stateDirRoot } from "./core/worktree.ts";
import { AcpAgent } from "./protocol/agent.ts";
import type { ClientMode } from "./protocol/registry.ts";
import {
  AGENTS,
  printableWarnings,
  resolveAgent,
  resolveEnv,
  type Warning,
  warningsFor,
} from "./protocol/registry.ts";
import type { ClientPermissionQueuedEvent } from "./protocol/types.ts";
import { flushStream, render } from "./render.ts";

const argv = process.argv.slice(2);

/** `catch` binds `unknown`; a harness can reject with anything. */
// This is the boundary that turns a caught value into a message.
// pi-lens-ignore: no-unknown-parameters
const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// `catch` binds `unknown`; this boundary checks Node's parse error code.
// pi-lens-ignore: no-unknown-parameters
function isUnknownOption(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
  );
}

/** The package version: beside `cli.ts` in a checkout, one folder up from
 *  `dist/cli.js` in the package. */
async function packageVersion(): Promise<string> {
  for (const file of [
    join(import.meta.dirname, "package.json"),
    join(import.meta.dirname, "..", "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(await readFile(file, "utf8")) as {
        version?: unknown;
      };
      // package.json is an external file, so its shape is checked here.
      // pi-lens-ignore: no-runtime-typeof
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      // Missing or unreadable; try the next place.
    }
  }
  throw new Error("cannot read the kapelle version from package.json");
}

/** The verdicts `core/run.ts` settles a task on. A restored record may carry
 *  one it does not — `queued`, or the sweep's `killed` — and the card-derived
 *  fallback below counts those as failed, never success. Without `--task`,
 *  that fallback only runs when `GET /runs/:id` still says `running` or
 *  carries no status (a cut stream, or a daemon older than M5-2); the settled
 *  run status wins whenever the daemon has one (M5-5). With `--task`, the one
 *  card is the verdict and keeps its own word. */
const TASK_STATUSES = new Set<string>([
  "done",
  "warned",
  "cancelled",
  "skipped",
  "timed_out",
  "failed",
]);

const stringOption = { type: "string" } as const;
const booleanOption = { type: "boolean" } as const;
const COMMON_OPTIONS = {
  cwd: stringOption,
  quiet: booleanOption,
  verbose: booleanOption,
  help: booleanOption,
  version: booleanOption,
};
const ROOM_OPTIONS = {
  ...COMMON_OPTIONS,
  room: stringOption,
  as: stringOption,
};
const OPTION_SETS = {
  prompt: {
    ...COMMON_OPTIONS,
    agent: stringOption,
    cmd: stringOption,
    mode: stringOption,
    file: stringOption,
  },
  demo: { ...COMMON_OPTIONS },
  run: {
    ...COMMON_OPTIONS,
    file: stringOption,
    detach: booleanOption,
    agent: stringOption,
    cmd: stringOption,
    mode: stringOption,
  },
  attach: { ...COMMON_OPTIONS, task: stringOption },
  setup: { ...COMMON_OPTIONS },
  ps: { ...COMMON_OPTIONS },
  merge: {
    ...COMMON_OPTIONS,
    squash: booleanOption,
    rebase: booleanOption,
  },
  workspace: { ...COMMON_OPTIONS },
  "workspace-move": { ...COMMON_OPTIONS },
  loop: {
    ...COMMON_OPTIONS,
    agent: stringOption,
    cmd: stringOption,
    model: stringOption,
  },
  "loop-list": { ...COMMON_OPTIONS },
  "room-info": { ...ROOM_OPTIONS },
  "room-send": { ...ROOM_OPTIONS },
  "room-add": {
    ...ROOM_OPTIONS,
    cmd: stringOption,
    name: stringOption,
    role: stringOption,
    mode: stringOption,
    model: stringOption,
    level: stringOption,
    base: stringOption,
  },
  "room-ff": { ...ROOM_OPTIONS, from: stringOption },
  "room-diff": { ...ROOM_OPTIONS },
  "room-remove": { ...ROOM_OPTIONS },
  daemon: { ...COMMON_OPTIONS },
  "daemon-stop": { ...COMMON_OPTIONS },
  "daemon-add": { ...COMMON_OPTIONS },
} satisfies Record<string, ParseArgsOptionsConfig>;
type Leaf = keyof typeof OPTION_SETS;

/**
 * The pre-scan needs every string option, including those parsed only by the
 * two handoff files. `chat.ts` owns agent, cmd, name and cwd;
 * `daemon/main.ts` owns port and permission-timeout.
 */
const SELECTOR_OPTIONS: ParseArgsOptionsConfig = Object.assign(
  {},
  ...Object.values(OPTION_SETS),
  {
    agent: stringOption,
    cmd: stringOption,
    name: stringOption,
    cwd: stringOption,
    port: stringOption,
    "permission-timeout": stringOption,
  },
);

const PROMPT_USAGE =
  'usage: kapelle "<prompt>" [options]; kapelle --help for the full usage';
const RUN_USAGE = "run needs a run file: kapelle run --file <run.json>";
const ATTACH_USAGE =
  "attach needs one run id: kapelle attach <runId> [--task <taskId>]";
const SETUP_USAGE = "usage: kapelle setup";
const MERGE_USAGE = "merge needs one run id: kapelle merge <runId> [--squash]";
const WORKSPACE_USAGE =
  "kapelle workspace [--cwd <dir>] | kapelle workspace move <from> <to>";
const DAEMON_USAGE =
  "usage: kapelle daemon start [--port n] | kapelle daemon add <path> | " +
  "kapelle daemon stop";
const LOOP_USAGE = [
  'usage: kapelle loop <recipe> <task> ["<note>"] [--agent <id>] [--cmd "<cmd>"] [--model <id>] [--cwd dir]',
  "       kapelle loop list [--cwd dir]",
  "A recipe is <repo>/.kapelle/loops/<recipe>.md, or else",
  "$XDG_CONFIG_HOME/kapelle/loops/<recipe>.md, or else one kapelle ships,",
  "such as starter. The orchestrator runs on claude unless --agent or --cmd",
  "names another harness. With --model, it gets the start only when it is",
  "confirmed on that model. If not, the room stays with no start, and this",
  "exits 1.",
].join("\n");

/** Everything a child parser should see; only global flags before `--` go. */
function handoffArgs(...removed: (number | undefined)[]): string[] {
  const drop = new Set(removed.filter((index) => index !== undefined));
  const rest: string[] = [];
  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (drop.has(i)) continue;
    if (arg === "--") literal = true;
    else if (!literal && (arg === "--quiet" || arg === "--verbose")) continue;
    rest.push(arg);
  }
  return rest;
}

/**
 * The global flags a handoff still owns. `strict: false` leaves the child's
 * own options alone, and `--` still ends options. Only the named flags are
 * returned.
 */
function handoffFlags(
  names: string[],
): Map<string, string | boolean | undefined> {
  const options: ParseArgsOptionsConfig = Object.fromEntries(
    names.map((name) => [name, booleanOption]),
  );
  const { values: parsed } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: false,
  });
  const flags: Map<string, string | boolean | undefined> = new Map();
  for (const name of names) {
    if (parsed[name] === true) flags.set(name, true);
  }
  return flags;
}

const SIMPLE_LEAVES = new Map<string, Leaf>([
  ["demo", "demo"],
  ["run", "run"],
  ["attach", "attach"],
  ["setup", "setup"],
  ["ps", "ps"],
  ["merge", "merge"],
]);
const ROOM_LEAVES = new Map<string, Leaf>([
  ["send", "room-send"],
  ["add", "room-add"],
  ["ff", "room-ff"],
  ["diff", "room-diff"],
  ["remove", "room-remove"],
]);

function daemonLeaf(verb: string | undefined): Leaf {
  if (verb === "stop") return "daemon-stop";
  if (verb === "add") return "daemon-add";
  return "daemon";
}

/** The option list for the leaf the words select. */
function selectLeaf(words: string[]): Leaf {
  const [first, second, third] = words;
  if (first === "workspace")
    return second === "move" ? "workspace-move" : "workspace";
  if (first === "loop")
    return second === "list" && third === undefined ? "loop-list" : "loop";
  if (first === "room") return ROOM_LEAVES.get(second ?? "") ?? "room-info";
  if (first === "daemon") return daemonLeaf(second);
  return first === undefined
    ? "prompt"
    : (SIMPLE_LEAVES.get(first) ?? "prompt");
}

const ROOM_USAGE = roomUsage();
const USAGE = {
  prompt: PROMPT_USAGE,
  demo: "usage: kapelle demo",
  run: RUN_USAGE,
  attach: ATTACH_USAGE,
  setup: SETUP_USAGE,
  ps: "usage: kapelle ps",
  merge: MERGE_USAGE,
  workspace: WORKSPACE_USAGE,
  "workspace-move": WORKSPACE_USAGE,
  loop: LOOP_USAGE,
  "loop-list": LOOP_USAGE,
  "room-info": ROOM_USAGE,
  "room-send": ROOM_USAGE,
  "room-add": ROOM_USAGE,
  "room-ff": ROOM_USAGE,
  "room-diff": ROOM_USAGE,
  "room-remove": ROOM_USAGE,
  daemon: DAEMON_USAGE,
  "daemon-stop": DAEMON_USAGE,
  "daemon-add": DAEMON_USAGE,
} satisfies Record<Leaf, string>;

const { tokens } = parseArgs({
  args: argv,
  options: SELECTOR_OPTIONS,
  allowPositionals: true,
  strict: false,
  tokens: true,
});
const wordEntries = (tokens ?? []).flatMap((token) =>
  token.kind === "positional"
    ? [{ value: token.value, index: token.index }]
    : [],
);
const commandWords = wordEntries.map(({ value }) => value);
const chatVerb = commandWords[0] === "chat";
const daemonStartVerb =
  commandWords[0] === "daemon" && commandWords[1] === "start";
let values = new Map<string, string | boolean | undefined>();
let positional: string[] = commandWords;
if (chatVerb) {
  values = handoffFlags(["version"]);
} else if (daemonStartVerb) {
  values = handoffFlags(["help", "version"]);
} else if (argv.length !== 0) {
  const leaf = selectLeaf(commandWords);
  try {
    const parsed = parseArgs({
      args: argv,
      options: OPTION_SETS[leaf],
      allowPositionals: true,
      strict: true,
    });
    values = new Map(
      Object.entries(
        parsed.values as Record<string, string | boolean | undefined>,
      ),
    );
    positional = parsed.positionals;
  } catch (err) {
    const message = messageOf(err);
    console.error(message);
    if (isUnknownOption(err)) console.error(USAGE[leaf]);
    process.exit(1);
  }
}

// `parseArgs` accepts an empty string as a value. A flag that is present but
// carries no value is a usage error, not an absence: `--cmd ""` must not
// silently start the default harness.
for (const [name, value] of values) {
  if (value === "") {
    console.error(`Option '--${name} <value>' argument missing`);
    process.exit(1);
  }
}

/**
 * A parsed string flag's value. The option list is the source of the type, so
 * a boolean name is never read through this helper.
 */
function flag(name: string): string | undefined;
function flag(name: string, fallback: string): string;
function flag(name: string, fallback?: string): string | undefined {
  return (values.get(name) as string | undefined) ?? fallback;
}

const has = (name: string) => values.has(name);
const promptText = positional.join(" ").trim();

// `run --file` is the other half of this CLI: one prompt, or N of them from a
// run file (M1b-2, #18). One entry point rather than two, because a second CLI
// would only be a second place to keep the notice rules, the SIGINT grace and
// the arg parsing in step. A verb since M2-9 (#39), like `merge` and `attach`.
const runFilePath = flag("file");

/** The agent a one-prompt run starts when neither --agent nor --cmd names one. */
const DEFAULT_AGENT = "pi";

if (has("version") && (positional.length > 0 || runFilePath)) {
  console.error("--version takes no other arguments");
  process.exit(1);
}
if (has("version")) {
  try {
    process.stdout.write(`${await packageVersion()}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${messageOf(err)}\n`);
    process.exit(1);
  }
}

if (
  !chatVerb &&
  argv.length !== 0 &&
  ((!promptText && !runFilePath) || has("help"))
) {
  console.log(`
kapelle — a minimal Agent Client Protocol client

  kapelle                            the chat on a terminal, starting the daemon
                                     if none runs; a pipe prints chat usage and exits 1
  kapelle --version                  print the version
  kapelle demo                       try the chat with an offline demo agent:
                                     no agent to install, no account; local only
  kapelle "<prompt>" [options]
  kapelle run --file <run.json> [--cwd dir] [--verbose] [--quiet]
  kapelle run --file <run.json> --detach   hands the run to the daemon;
                                     required when a remote client daemon is set
  kapelle attach <runId> [--task <taskId>]
                                     streams a detached run, answers its asks;
                                     --task draws that one task in full
  kapelle setup                      the agents the daemon finds on its PATH,
                                     and the command to install what is missing
  kapelle ps                         every run the daemon knows, and each
                                     task's id and status under it
  kapelle merge <runId> [--squash] [--cwd dir]
  kapelle loop <recipe> <task> ["<note>"] [--agent <id>] [--cmd "<cmd>"]
               [--model <id>] [--cwd dir]
                                     a room whose orchestrator drives the
                                     recipe for the task; claude by default
  kapelle loop list [--cwd dir]      every recipe, its folder, and which wins
  kapelle room info | send | add | ff | diff | remove
                                     an orchestrator's verbs in its room,
                                     run from its checkout; kapelle room
                                     alone lists them
  kapelle daemon start [--port n] [--permission-timeout s]
                                     runs in this terminal until ^C or SIGTERM
  kapelle daemon stop                stops the daemon named in daemon.json
  kapelle daemon add <path>          adds a repository to the running daemon
  kapelle chat [new | attach | list | dismiss | scratch]
                                     the chat rooms; kapelle chat --help

Options:
  --agent <id>     ${Object.keys(AGENTS).join(" | ")}   (default: ${DEFAULT_AGENT})
  --cmd "<cmd>"    custom agent command, e.g. --cmd "opencode acp"
  --cwd <dir>      workspace root (default: current directory). With a
                   client daemon address, run --detach, a loop start,
                   chat new and daemon add send it as typed: the daemon
                   user's home by default, and a relative path starts there
  --mode <mode>    ask | safe | auto      (default: the agent's own)
                     ask  = reads auto-approved, mutations prompt you
                     safe = reads only, all mutations refused
                     auto = approve everything (path guards still apply)
  --file <path>    a JSON run file: N tasks, each its own agent and mode.
                   The file carries agent and mode, so --agent, --cmd and
                   --mode are refused alongside it. See schema/run.schema.json
  --verbose        show agent stderr and protocol noise
  --quiet          suppress normal output; safety notices still print

Examples:
  kapelle                              # on a terminal: the chat, starting the daemon if needed
  kapelle "list the top-level files and summarise this repo"
  kapelle "add a health endpoint" --cwd ../my-app --mode ask
  kapelle "what does src/index.ts do" --mode safe
  kapelle run --file tasks.run.json
  kapelle run --file tasks.run.json --detach
  kapelle merge 20260909-101500-abc1
`);
  // `--help` is the one path here that is not a usage error (M9-2).
  process.exit(has("help") ? 0 : 1);
}

const verbose = has("verbose");
const quiet = has("quiet");

/**
 * Run `f`, or print its message and exit 1.
 *
 * An argv mistake is one line, never a stack trace. `resolveAgent` and
 * `resolvePolicy` both throw a sentence written for the person who typed the
 * flag — naming the known agents, or the known modes — and a raw throw buries
 * that sentence in a MODULE-style banner. One wrapper rather than a `try` at
 * each call site, so the next validator that lands cannot forget it.
 */
function orExit<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    console.error(messageOf(err));
    process.exit(1);
  }
}

// `process.exitCode`, never `process.exit()`: this path has just written buffered
// task transcripts, and a forced exit can cut a pipe-backed stdout off mid-flush.
// It would also beat the SIGINT handler's own 130 whenever a cancelled run
// settles inside the two-second grace. The single-agent path below is an
// `else` for the same reason — there is nothing left to skip past.
// `positional[0]`, not `argv[0]`: `parseArgs` permits options such as `--cwd`
// before the subcommand.
if (chatVerb) {
  // As for `daemon start`: `chat.ts` parses `process.argv` itself and runs
  // when imported, so the word that chose it is taken out and the rest is
  // handed over as typed. `wordEntries[0]` is that word's argv index: a flag
  // value that happens to be `chat` must stay. The global presentation
  // flags before `--` go too, as for `daemon start`: `chat.ts` defines
  // neither, but after `--` they are the caller's text.
  const chatAt = wordEntries[0]?.index;
  const rest = handoffArgs(chatAt);
  process.argv.splice(2, Infinity, ...rest);
  await import("./chat.ts");
} else if (argv.length === 0) {
  // `kapelle` alone is the chat (M9-2). It stays in this chain: an earlier
  // standalone `if` let execution fall through to the single-agent path,
  // which started the default harness (pi) beside the chat. A terminal gets
  // the screen, so the daemon starts first when none answers; a pipe has no
  // screen, and `chat.ts` prints its usage without touching the daemon.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      await startDaemon();
    } catch (err) {
      console.error(`error: ${messageOf(err)}`);
      process.exit(1);
    }
  }
  await import("./chat.ts");
} else if (daemonStartVerb) {
  // `daemon.ts` parses its own flags from `process.argv`, so the words that
  // chose it — by their argv index, as for `chat` — and the global
  // presentation flags before `--` are taken out, and the rest is handed
  // over as typed so `--port n` reaches it.
  const daemonAt = wordEntries[0]?.index;
  const startAt = wordEntries[1]?.index;
  const rest = handoffArgs(daemonAt, startAt);
  process.argv.splice(2, Infinity, ...rest);
  await import("./daemon.ts");
} else if (positional[0] === "daemon") {
  process.exitCode = await runDaemonCommand().catch((err) => {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  });
} else if (positional[0] === "loop") {
  process.exitCode = await runLoopCommand().catch((err) => {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  });
} else if (positional[0] === "demo") {
  process.exitCode = await runDemoCommand().catch((err) => {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  });
} else if (positional[0] === "room") {
  process.exitCode = await runRoomCommand().catch((err) => {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  });
} else if (positional[0] === "workspace") {
  process.exitCode = await runWorkspaceCommand().catch((err) => {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  });
} else if (positional[0] === "merge") {
  process.exitCode = await runMergeCommand().catch((err) => {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  });
} else if (positional[0] === "run") {
  if (!runFilePath) {
    console.error(RUN_USAGE);
    process.exitCode = 1;
  } else if (has("detach")) {
    process.exitCode = await detachRun(runFilePath).catch((err) => {
      console.error(`error: ${messageOf(err)}`);
      return 1;
    });
  } else {
    process.exitCode = await runFromFileUnlessRemote(runFilePath);
  }
} else if (positional[0] === "setup") {
  if (positional.length !== 1) {
    console.error(SETUP_USAGE);
    process.exitCode = 1;
  } else {
    process.exitCode = await runSetup().catch((err) => {
      console.error(`error: ${messageOf(err)}`);
      return 1;
    });
  }
} else if (positional[0] === "ps") {
  process.exitCode = await listRuns().catch((err) => {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  });
} else if (positional[0] === "attach") {
  process.exitCode = await attachRun().catch((err) => {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  });
} else if (runFilePath) {
  // Removed rather than kept as an alias (decided 2026-09-18, #39): one
  // spelling per job, and every other job is already a verb.
  console.error(
    "--file is a flag of the run verb now: kapelle run --file <run.json>",
  );
  process.exitCode = 1;
} else {
  const spec = orExit(() =>
    resolveAgent(flag("agent", DEFAULT_AGENT), flag("cmd")),
  );

  // `task > run > harness > default`: cli.ts is one task, so `--mode` is the run
  // layer and the registry entry is the harness layer. An unknown mode, or one
  // above the entry's ceiling, is a validation error here rather than a silent
  // downgrade. There is no `--allow-read-outside-root` flag: the task layer that
  // carries it arrives with M1b-1's run file, and inventing a CLI surface for it
  // now would be a second place to keep in step.
  // The cast is the boundary: argv is strings, and `resolvePolicy` is the one
  // place that validates a mode — it throws naming the known ones, which is a
  // better error than anything a second check here could produce.
  const resolveOrExit = (mode: string | undefined): ResolvedPolicy =>
    orExit(() =>
      resolvePolicy({
        run: { mode: mode as ClientMode | undefined },
        harness: {
          name: spec.name,
          mode: spec.defaultMode,
          maxMode: spec.maxMode,
        },
      }),
    );

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
  if (!quiet) bus.addListener(render);
  // Never behind `--quiet`: an unanswered prompt stalls the run outright.
  bus.addListener(makeNotifier({ asks: resolved.mode === "ask" }));

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
    // Exit once the harness is gone, not before: it ends its own shell
    // commands only after it has read end of file (M2-4).
    setTimeout(() => {
      void agent.stop().finally(() => process.exit(130));
    }, 2000);
  });

  try {
    const init = await agent.start();
    if (!quiet) {
      const who = init.agentInfo
        ? `${init.agentInfo.name} ${init.agentInfo.version ?? ""}`.trim()
        : spec.name;
      // The name, version and protocol version are the harness's (#229).
      console.log(
        `connected to ${oneLine(who)} (ACP v${oneLine(String(init.protocolVersion))})`,
      );
    }

    // M1a-4 decides these lines; this story decides which survive `--quiet`.
    // The rule itself sits in the registry next to `warningsFor`, where it has
    // a test — a bare `if` here is exactly what could be inverted unnoticed.
    const warnings = printableWarnings(
      warningsFor(spec.name, spec, resolved.mode, init.agentInfo?.version),
      quiet,
    );
    // The version warning quotes the harness's own version (#229).
    for (const w of warnings) console.error(`! ${oneLine(w.text)}`);

    await agent.newSession();

    // `safe`'s other half: negotiate before the first prompt, because filtering
    // reaches nothing on a harness that never asks. Printed like the containment
    // lines and, like them, not suppressed by --quiet (#13): this line says how
    // much of `safe` is actually in force.
    const notNegotiated = await negotiateSafeMode(agent, spec, resolved.mode);
    if (notNegotiated) console.error(`! ${notNegotiated}`);
    if (!quiet) console.log(`session ${agent.sessionId}\n`);

    // The preamble goes on every prompt, this path included (decided
    // 2026-09-07, #20): one composer, and a one-shot run whose report can be
    // read by eye or by the next thing that wants it. Nothing cross-checks it
    // here — there is no worktree and no task record to hang a warning on.
    // The whole PromptResponse is returned (#62 B3); M1 renders only stopReason.
    const { stopReason } = await agent.prompt(withResultPreamble(promptText));
    // The end of a turn flushes the block `render` still has open (M1c-7):
    // this line prints past the renderer, so nothing else would close it.
    flushStream();
    // Both are the harness's text (#229).
    if (!quiet) console.log(`\n\n— turn ended: ${oneLine(String(stopReason))}`);
  } catch (err) {
    flushStream();
    console.error(`\nerror: ${clean(messageOf(err))}`);
    // A start that failed gets its next step (M10-2). This path keeps no
    // stderr log, so the fallback is `--verbose`; a failed spawn has no
    // stderr for that flag to show.
    if (!agent.sessionId) {
      const help = startHelp(err, spec.setup, null, !verbose);
      if (help) console.error(help);
    }
    process.exitCode = 1;
  } finally {
    closeAsk();
    await agent.stop();
  }
}

/**
 * A local `run --file` when no remote daemon is configured. With a client
 * setting active the harnesses belong on that daemon, so a non-detached run
 * would execute in the wrong place; the person must choose `--detach`.
 */
async function runFromFileUnlessRemote(path: string): Promise<number> {
  try {
    if (await readClientDaemon(clientConfigPath())) {
      console.error(
        `error: a remote daemon is configured in ${clientConfigPath()}; ` +
          "non-detached run --file would run on this machine. " +
          "Use: kapelle run --file <file> --detach",
      );
      return 1;
    }
    // The refusal is this command's exit code; no caller can retry it.
    // pi-lens-ignore: missing-error-propagation
  } catch (err) {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  }
  return runFromFile(path);
}

/**
 * The `--file` half: N tasks from a run file, at most `maxConcurrency` live.
 *
 * Returns the exit code rather than calling `process.exit` itself, so the one
 * place that decides how this process ends stays the call site.
 *
 * **Prose is buffered and printed per task at the end**, never streamed. N
 * interleaved token streams are unreadable, and a summary nobody can read is
 * the same as no summary. Only milestones — a tool call — go out live.
 */
// The run lifecycle is one ordered state machine: concurrency, the asker, bus
// listeners and shutdown share state across phases, so extraction would pass a
// mutable context between halves of the same job.
// pi-lens-ignore: high-complexity, high-fan-out
async function runFromFile(path: string): Promise<number> {
  const parsed = await loadRunFile(path);
  if (parsed === undefined) return 1;

  // M2-7: the project config of the folder the run starts in supplies the
  // defaults the run file omits; `orExit` refuses a bad config by file:key.
  const cwd = flag("cwd", process.cwd());
  // Advisory, so `--quiet` drops it (#13): only the containment notice and the
  // not-negotiated line survive. It fires for every legitimate `KAPELLE_*`
  // secret too, so a quiet run would carry it on every invocation.
  if (!quiet) warnUnknownConfigEnv();
  const { root } = await stateDirRoot(cwd);
  const defaults = orExit(() => resolveRunDefaults(root));
  const linkPaths = orExit(() => readProjectLinkPaths(root));

  const validated = orExit(() => validateRun(parsed, AGENTS, defaults));

  // **One asker can still be answered; two cannot.** `makeAskPolicy` owns a
  // single readline over one stdin, so two tasks prompting at once would
  // interleave two questions on one line and attribute an answer to whichever
  // asked last — the fail-open shape #13 exists to prevent. So `ask` survives
  // exactly when one task asks and there is a TTY to ask on; otherwise every
  // asking task is re-resolved as `safe` — renaming it would leave `safe`'s
  // own rules, including forcing `allowReadOutsideRoot` false, unapplied to
  // what actually runs.
  //
  // It is a downgrade often, not always, because every registry entry is
  // `defaultMode: "ask"`: a bare run file names no mode and every task inherits
  // one. M2-3's queue serves N askers in the daemon only, and `attach` answers
  // them one at a time (M2-9): that pair is the way past this limit, and the
  // in-process path keeps it (decided 2026-09-18, #39).
  const askers = validated.tasks.filter((t) => t.mode === "ask");
  const canAsk = askers.length === 1 && Boolean(process.stdin.isTTY);
  if (askers.length > 1) {
    console.error(
      `! ${askers.length} tasks ask, and one prompt cannot serve two — ` +
        `running them as safe. Set a mode per task, or use --detach and ` +
        "answer them with kapelle attach.",
    );
  }

  const tasks: Task[] = validated.tasks.map((task) => {
    if (task.mode !== "ask" || canAsk) return task;
    if (askers.length === 1) {
      console.error(`! [${task.id}] not a TTY — ask runs as safe`);
    }
    const { mode, allowReadOutsideRoot } = resolvePolicy({
      task: { mode: "safe", allowReadOutsideRoot: task.allowReadOutsideRoot },
    });
    return { ...task, mode, allowReadOutsideRoot };
  });

  // Built only when it will be used, and closed however the run ends: an open
  // readline holds stdin and the process never exits.
  const asker = canAsk ? makeAskPolicy() : undefined;
  // With `canAsk` true, exactly one task remains in `ask` mode (the others were
  // re-resolved as `safe` above). Restrict pending-permission alerts to that
  // task so a concurrent `safe`/`auto` task does not ring for a decision that
  // never waits on a human. Stall warnings are still global.
  const askTaskId = canAsk
    ? tasks.find((task) => task.mode === "ask")?.id
    : undefined;

  const bus = createEventBus();
  // Not filtered by `--quiet`, and not folded into the end-of-run task card:
  // a stall warning is only useful while the task is still stalled, and an
  // hour-late line saying "it went quiet" is not the same information. The
  // notifier owns that line since M1c-4 — it prints the same text with a bell
  // in front, and a second subscriber here would print it twice.
  //
  // `asks` is the asker, not a mode: tasks carry their own modes, and the one
  // thing that decides whether a human can be blocked is whether `canAsk`
  // left an asker standing. When it did, `askIds` keeps the bell on that one
  // task rather than on every permission decision in a mixed-mode run.
  bus.addListener(
    makeNotifier({
      asks: canAsk,
      askIds: askTaskId ? new Set([askTaskId]) : undefined,
    }),
  );

  // Result warnings are data on the bus, not a CLI-only field. Under `--quiet`
  // there is no task card to print them from, so this subscriber is the route
  // that keeps the disagreement visible; it is deliberately separate from the
  // `onNotice` route, which still owns the never-suppressed #13 lines.
  if (quiet) {
    bus.addListener(({ agent: taskId, update }) => {
      if (update.sessionUpdate === "_client_result_warning") {
        console.error(`! [${taskId}] ${oneLine(update.text)}`);
      }
    });
  }
  if (!quiet) {
    bus.addListener(({ agent: taskId, update }) => {
      // Milestones only. `render` would braid N streams into one line.
      if (update.sessionUpdate === "tool_call") {
        console.log(`[${taskId}] → ${oneLine(update.title)}`);
      }
    });
  }

  // Same shape as the single-agent path: cancel, then a 2s grace before the
  // process gives up. `runRun` marks whatever was still queued `cancelled`
  // rather than pretending it ran.
  const canceller = new AbortController();
  process.on("SIGINT", () => {
    console.error("\n^C cancelling run…");
    canceller.abort();
    // `unref`: the grace timer is a safety net for a harness that ignores the
    // cancel, not a two-second pause on a run that stopped promptly. An
    // unref'd timer still fires while the loop is alive for other reasons —
    // it just stops being a reason of its own.
    setTimeout(() => process.exit(130), 2000).unref();
  });

  const runId = newRunId();
  if (!quiet) console.log(`run ${runId}`);

  let report: Awaited<ReturnType<typeof runRun>>;
  try {
    report = await runRun(
      { ...validated, tasks },
      {
        cwd,
        linkPaths,
        // Minted here rather than left to `runRun`'s default because it is
        // printed: it names every branch the run leaves behind, and
        // `kapelle merge <runId>` is how they are found again.
        runId,
        bus,
        signal: canceller.signal,
        verbose,
        askPolicy: asker?.policy,
        // The containment line and the not-negotiated line are never silenced
        // (#13); `unverified` and `version` are advisory and `--quiet` drops
        // them. That split is `printableWarnings`' to make — it is the one
        // place with a test for it, and a bare `if` here is exactly what
        // could be inverted unnoticed. A notice with no kind is not a
        // `warningsFor` warning and always prints.
        onNotice: (taskId, text, kind) => {
          if (kind && printableWarnings([{ kind, text }], quiet).length === 0) {
            return;
          }
          console.error(`! [${taskId}] ${oneLine(text)}`);
        },
      },
    );
  } catch (err) {
    // `runRun`'s own refusals — the state directory's ownership guard — and
    // anything unexpected land here, one actionable line each. A stack trace
    // would bury the line that says what to do.
    console.error(`error: ${messageOf(err)}`);
    return 1;
  } finally {
    asker?.close();
  }

  if (quiet) {
    // `--quiet` suppresses the summary, not the fact that a task failed.
    // The single-agent path has always printed its error on stderr under
    // `--quiet`; a run file must not fail silently on exit code alone.
    //
    // Keyed on **status**, not on `error`. `error` is set only when a task
    // threw, and the whole point of M1b-2's stop-reason table is that a task
    // can fail without throwing: `refusal`, `max_tokens`, `max_turn_requests`
    // and `timed_out` all return normally and carry no error text. Keying on
    // `error` left exactly those exiting 1 in silence.
    for (const task of report.tasks) {
      if (task.status === "done" || task.status === "warned") continue;
      // The id always leads: a thrown message names the task only because
      // `AcpAgent` happens to be named after it, and a status line has no
      // other way to say which of six tasks this is.
      console.error(`error: [${task.id}] ${clean(task.error ?? task.status)}`);
    }
  } else {
    console.log(`\n${"═".repeat(60)}`);
    for (const task of report.tasks) printTask(task);
    console.log(
      `\n${report.status} — ${plural(report.tasks.length, "task")}, ` +
        `${plural(report.turns, "turn")}, ` +
        `${(report.durationMs / 1000).toFixed(1)}s`,
    );
  }

  // ^C exits 130, as the single-agent path does. The grace timer reaches 130
  // too, but only when the run is still going when it fires — a run that
  // settles inside the grace must not report a plain failure instead.
  if (canceller.signal.aborted) return 130;

  // `warned` is a run that finished with something worth reading, not a
  // failure. Every rung below it means at least one task did not complete.
  return report.status === "done" || report.status === "warned" ? 0 : 1;
}

/**
 * Read and parse a run file for either half of `run`, refusing what the file
 * already answers. `undefined` means the reason is printed and the caller
 * exits 1.
 */
async function loadRunFile(path: string): Promise<unknown> {
  // The file carries agent, cmd and mode per task, and `resolvePolicy` has
  // already settled them against each harness's ceiling. A CLI flag would be
  // a second, unresolved answer to a question the file already answered —
  // refused rather than silently losing to the file or silently beating it.
  for (const conflicting of ["agent", "cmd", "mode"]) {
    if (has(conflicting)) {
      console.error(
        `--${conflicting} does not apply with --file: a run file sets ` +
          `"${conflicting}" per task. Edit the file instead.`,
      );
      return undefined;
    }
  }

  // A positional prompt is the same conflict, and the most dangerous shape of
  // it: `kapelle run --file tasks.json "and also do X"` reads like it queued
  // the extra work. Silently dropping it would be the one failure mode the
  // three flags above are rejected to avoid.
  const extra = positional.slice(1).join(" ").trim();
  if (extra) {
    console.error(
      `a prompt does not apply with --file: a run file carries one prompt ` +
        `per task. Got ${JSON.stringify(extra)}.`,
    );
    return undefined;
  }

  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    console.error(`cannot read run file ${path}: ${messageOf(err)}`);
    return undefined;
  }
}

/**
 * The `merge` half: `kapelle merge <runId> [--squash] [--cwd dir]`.
 *
 * M1c-3 ships `--squash` only; `--rebase` is M3-4 and is refused here rather
 * than silently ignored. The `kapelle` bin and the file rename are M1c-5.
 */
/**
 * `kapelle workspace [--cwd <dir>]` and `kapelle workspace move <from> <to>`.
 *
 * Since #129 a run's worktrees and records live outside the repository, so
 * "where is my stuff" stopped being answerable by looking — the bare form is
 * that answer. `move` is the repair `core/sweep.ts`'s stranded notice names:
 * one command, because `mv` without `git worktree repair` leaves every
 * checkout `prunable` and the next prune deletes the work
 * (`core/worktree.ts`, `moveWorkspace`).
 */
async function runWorkspaceCommand(): Promise<number> {
  if (positional[1] !== "move") {
    if (positional.length > 1) {
      console.error(
        `unknown workspace command "${positional[1]}": ${WORKSPACE_USAGE}`,
      );
      return 1;
    }
    const { root } = await stateDirRoot(flag("cwd", process.cwd()));
    console.log(stateDirFor(root));
    return 0;
  }

  const [from, to] = positional.slice(2);
  if (!from || !to) {
    console.error(
      "workspace move needs two paths: kapelle workspace move <old-repo> <new-repo>",
    );
    return 1;
  }

  console.log(await moveWorkspace(from, to));
  return 0;
}

async function runMergeCommand(): Promise<number> {
  if (has("rebase")) {
    console.error("--rebase lands in M3-4; M1c-3 ships --squash only.");
    return 1;
  }

  const ids = positional.slice(1);
  if (ids.length !== 1) {
    console.error(MERGE_USAGE);
    return 1;
  }

  const runId = ids[0] as string;
  await mergeRun(runId, flag("cwd", process.cwd()));
  console.log(`merged ${runId} as unstaged changes`);
  return 0;
}

/**
 * `1 turns` was the old summary. A run of one task is common enough — a single
 * spawn failure makes it the interesting case — to be worth this.
 *
 * A `function` and not a `const`: everything below `runFromFile`'s call site
 * is still in the temporal dead zone when it runs, because that call is made
 * from top-level code above. A `const` arrow here threw `ReferenceError` and
 * swallowed the whole summary line.
 */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What a task card needs: a `TaskRun`, or what `attach` rebuilds of one. */
type Card = Pick<TaskRun, "id" | "agent" | "durationMs" | "transcript"> &
  Partial<Pick<TaskRun, "error" | "usage" | "usageSemantics" | "warnings">> & {
    /** A `TaskStatus`, `running` until the stream settles it, or a restored
     *  record's own word (`queued`), printed as written. */
    status: string;
  };

/**
 * A task as `GET /runs/:id` reports it: since M5-2 one shape for a live and a
 * restored run — `TaskDto` in `client/contract.ts`. This bridge type stays
 * until M5-10b refactors `attach`; a restored record's status is a plain string
 * — it may say `queued` for a task the crash left unstarted, which is not a
 * `TaskStatus` and must still keep the verdict away from `done`.
 */
type RecordedTask = Omit<Partial<TaskRun>, "status"> & {
  id: string;
  status: string;
};

/**
 * `GET /runs/:id` as `attach` reads it. Since M5-2 `tasks` is the one shape
 * for a live and a restored run; `report` is the pre-M5-2 field, kept until
 * M5-10b removes the branch (daemon.ts, M2-6).
 */
interface AttachState {
  error?: string;
  /** The daemon's authoritative run status (M5-5); read once the stream ends. */
  status?: RunStatus;
  report?: { tasks?: RecordedTask[] };
  tasks?: RecordedTask[];
  notices?: { taskId: string; text: string; kind?: Warning["kind"] }[];
}

/** The run's verdict from the daemon, a task card, or the cards' own status. */
function attachStatus(
  state: AttachState,
  mine: string | undefined,
  fromTasks: string,
): string {
  if (state.error) return "failed";
  if (mine !== undefined) return mine === "running" ? "failed" : mine;
  if (state.status !== undefined && state.status !== "running") {
    return state.status;
  }
  return fromTasks;
}

function printTask(task: Card): void {
  const secs = (task.durationMs / 1000).toFixed(1);
  console.log(`\n▸ ${task.id} (${task.agent}) ${task.status} in ${secs}s`);
  if (task.error) console.log(`  error: ${clean(task.error)}`);
  // Verbatim, tagged by the task above, and never added to another task's:
  // copilot counts cumulatively where opencode counts per turn (M0-5).
  if (task.usage) {
    console.log(
      // `Number`: the wire is not checked, and a string could hold `ESC`.
      `  tokens: ${Number(task.usage.totalTokens)} total ` +
        `(${Number(task.usage.inputTokens)} in, ${Number(task.usage.outputTokens)} out; ` +
        `${task.usageSemantics ?? "unknown"})`,
    );
  }
  // Before the prose, not after: the warnings are the reason to read the
  // prose at all, and a reader who stops at the first screen must still see
  // that the agent and the working tree disagreed.
  for (const w of task.warnings ?? []) console.log(`  ! ${oneLine(w.text)}`);
  const prose = clean(task.transcript).trim();
  if (prose) console.log(prose);
}

// A declaration, not a `const`: the commands at the top of this file run
// before a `const` down here is set.
function daemonFile(): string {
  return join(runtimeDir(), "daemon.json");
}

/** Start the daemon detached when none answers (M9-2). A configured client
 *  daemon is remote: it skips both this start and the runtime folder. */
async function startDaemon(): Promise<void> {
  if (await readClientDaemon(clientConfigPath())) return;
  return ensureDaemon({
    file: daemonFile(),
    log: join(stateDir(), "daemon.log"),
    // A plain path, so tsc cannot rewrite it with the imports.
    script: join(
      import.meta.dirname,
      import.meta.filename.endsWith(".js") ? "daemon.js" : "daemon.ts",
    ),
    cwd: import.meta.dirname,
  });
}

/**
 * The configured client daemon, else the one named in `daemon.json`; or
 * `undefined` with the reason printed. Every verb that talks to the daemon
 * starts here, so none of them can disagree about what "no daemon is
 * listening" means. It also checks the API version (B5): a different `major`
 * throws, a different `minor` warns.
 */
async function findDaemon(): Promise<DaemonAddress | undefined> {
  const d = await resolveDaemonAddress(clientConfigPath(), daemonFile);
  // The helper returns its refusal as a string beside the address union.
  // pi-lens-ignore: no-runtime-typeof
  if (typeof d === "string") {
    console.error(
      `no daemon is listening (${clientConfigPath()} has no setting and ` +
        `${daemonFile()} is missing or not ready). ` +
        "Start one with: kapelle daemon start",
    );
    return undefined;
  }
  const warning = await checkVersion(d);
  if (warning) console.error(`! ${warning}`);
  return d;
}

/**
 * `kapelle run --file <f> --detach`: `POST /runs` and print the id (M2-9, #39).
 *
 * The daemon validates the file against its own registry and config, so the
 * file goes over as parsed and every refusal comes back as the daemon's line.
 * The id is the only thing on stdout, so `id=$(kapelle run … --detach)` works.
 */
async function detachRun(path: string): Promise<number> {
  const run = await loadRunFile(path);
  if (run === undefined) return 1;
  const d = await findDaemon();
  if (!d) return 1;
  const cwd = folderToSend(flag("cwd"), d.fromClient);
  if (!cwd) {
    console.error(`error: ${FOLDER_GONE}`);
    return 1;
  }
  const r = await call<RunAccepted>(d, "/runs", {
    method: "POST",
    body: { cwd, run },
  });
  if (!r.ok) {
    console.error(`error: ${r.error.message}`);
    return 1;
  }
  const { id } = r.body;
  console.log(id);
  if (!quiet) {
    // The ids come from the file as sent: the 202 says the daemon's
    // `validateRun` accepted it, so `tasks` is an array of objects with ids.
    const { tasks } = run as { tasks: { id: string }[] };
    console.error(
      `detached — follow it with: kapelle attach ${id}\n` +
        `  tasks: ${tasks.map((task) => task.id).join(", ")}\n` +
        `  one task in full: kapelle attach ${id} --task <taskId>`,
    );
  }
  return 0;
}

/**
 * `kapelle setup` (M9-3, #298): the daemon finds the agents again, and the
 * list prints here, as the chat shows it (`client/setup.ts`). It does not
 * say "done": only the chat does. M9-4 adds its login check after it.
 */
async function runSetup(): Promise<number> {
  const d = await findDaemon();
  if (!d) return 1;
  const r = await findAgain(d);
  if (!r.ok) {
    console.error(`error: ${r.error.message}`);
    return 1;
  }
  for (const l of setupLines(r.body)) console.log(l.text);
  return 0;
}

/**
 * `kapelle ps`: every run the daemon knows, and each task's id and status
 * under it (M2-10, #121). A finished run's status is its verdict.
 */
async function listRuns(): Promise<number> {
  const d = await findDaemon();
  if (!d) return 1;
  const r = await call<RunListEntry[]>(d, "/runs");
  if (!r.ok) {
    console.error(`error: ${r.error.message}`);
    return 1;
  }
  for (const run of r.body) {
    console.log(`${run.id}  ${run.status}  ${run.cwd}`);
    for (const task of run.tasks ?? []) {
      console.log(`  ${task.id}  ${task.status}`);
    }
  }
  return 0;
}

/**
 * `kapelle attach <runId>`: a detached run's history, then its live tail
 * (M2-9, #39). It shows what `run --file` shows — milestones live, a card per
 * task at the end — and builds every card from the stream, because a run read
 * back after a daemon restart has no `report` to build one from.
 *
 * Each `_client_permission_queued` is asked on the TTY, one at a time, and
 * only while `GET /permissions` still lists it: a replay carries every
 * decision the run ever queued, and most were settled long ago. ^C leaves the
 * run running; cancelling it is `DELETE /runs/:id`, which has no verb yet.
 *
 * `--task <id>` is the other shape the M2-2 amendment offered: that one task
 * in full through `render.ts`, as a single prompt draws it, and only its asks.
 * The filter is ours, not the daemon's — every event already names its task —
 * so a replay still downloads the other tasks' events and drops them.
 */
// The live attach view is one ordered state machine over a shared stream.
// pi-lens-ignore: high-complexity, high-fan-out
async function attachRun(): Promise<number> {
  const [, id, ...extra] = positional;
  if (!id || extra.length) {
    console.error(ATTACH_USAGE);
    return 1;
  }
  const only = flag("task");
  // `run` is the run's own notices (a missing repository, say): they concern
  // every task, so a one-task view keeps them.
  const shown = (taskId: string) =>
    !only || taskId === only || taskId === "run";
  const first = await findDaemon();
  if (!first) return 1;
  // The address of the last daemon whose version passed (B5). A restart or a
  // client-setting edit can bring a new port, token and version. The check
  // runs when the stream connects, not on every call: a permission answer sent
  // between a restart and the next connect is not checked. At worst it lands
  // on a daemon whose contract has changed; the connect that follows refuses
  // that daemon and ends the stream.
  let checkedPort = first.port;
  let checkedToken = first.token;
  let checkedFromClient = first.fromClient;
  // Both connection files are read again on every call: a daemon that
  // restarts while this is attached has a new token, and maybe a new port
  // (M5-6). A configured client daemon wins over `daemon.json`.
  const freshDaemon = () =>
    resolveDaemonAddress(clientConfigPath(), daemonFile);
  const daemon = async (): Promise<DaemonAddress> => {
    const d = await freshDaemon();
    // The helper returns its refusal as a string beside the address union.
    // pi-lens-ignore: no-runtime-typeof
    if (typeof d === "string") throw new Error("no daemon is listening");
    return d;
  };
  const path = `/runs/${encodeURIComponent(id)}`;
  // Stops when no connection file names a daemon, which is a clean stop (F3).
  // After a crash the file stays, and the reader waits for the next daemon.
  // This leans on the daemon's start order (`claim`, then `listen`, then the
  // token is written): while a new daemon starts, the file has no token, so
  // this throws "starting" and tries again, and an old token never reaches
  // the new daemon, whose `401` would stop the reader for good. Change that
  // order and this breaks.
  // It also leans on `claim` swapping a stale file with `rename`, so the
  // file never goes missing while a new daemon takes over.
  // ponytail: one narrow window remains. A file read just before a restart
  // on a fixed port meets the new daemon with the old token. That needs the
  // whole restart inside one read-to-fetch gap. Retry on 401 if it is seen.
  // The window covers the version check below too: a 401 there is a
  // `VersionRefused`, and it also ends the stream.
  // A new address is checked before its stream opens, and a different `major`
  // is a `VersionRefused`, which ends the stream rather than retries it.
  const connect: Connect = async (after, signal) => {
    const d = await freshDaemon();
    if (d === "missing") return undefined;
    if (d === "unready") throw new Error("the daemon is starting");
    if (
      d.port !== checkedPort ||
      d.token !== checkedToken ||
      d.fromClient !== checkedFromClient
    ) {
      const warning = await checkVersion(d, signal);
      if (warning) console.error(`! ${warning}`);
      checkedPort = d.port;
      checkedToken = d.token;
      checkedFromClient = d.fromClient;
    }
    return request(d, `${path}/events`, {
      signal,
      headers: { "last-event-id": String(after) },
    });
  };

  // Notices live on the run record, not the stream: the containment lines
  // (#13) print whatever `--quiet` says, and the advisory ones do not. The
  // same record is the authority `attach` reconciles its verdict against once
  // the stream ends — a run restored after a crash has no `report`, and a
  // stream cut mid-run has no `_client_task_finished` for what it missed.
  let printed = 0;
  const refreshState = async (): Promise<AttachState> => {
    const r = await call<AttachState>(await daemon(), path);
    if (!r.ok) throw new Error(r.error.message);
    const state = r.body;
    const notices = state.notices ?? [];
    for (const { taskId, text, kind } of notices.slice(printed)) {
      if (!shown(taskId)) continue;
      if (kind && printableWarnings([{ kind, text }], quiet).length === 0) {
        continue;
      }
      console.error(`! [${taskId}] ${oneLine(text)}`);
    }
    printed = notices.length;
    return state;
  };
  const initial = await refreshState();

  process.on("SIGINT", () => process.exit(130));
  const asker = process.stdin.isTTY ? makeAskPolicy() : undefined;
  let answering = Promise.resolve();
  const answer = (agent: string, decision: ClientPermissionQueuedEvent) => {
    answering = (async () => {
      await answering;
      try {
        const open = await call<PendingDecision[]>(
          await daemon(),
          "/permissions",
        );
        if (!open.ok) throw new Error(open.error.message);
        if (!open.body.some((p) => p.id === decision.id)) return;
        if (!asker) {
          console.error(
            `! [${agent}] waiting on [${oneLine(decision.kind)}] ${oneLine(decision.title)} — ` +
              "attach from a terminal to answer, or it is denied at the timeout",
          );
          return;
        }
        // Close the block `render` has open, or the question lands inside it.
        if (only) flushStream();
        const allow = await asker.policy({
          agent,
          toolCall: { kind: decision.kind, title: decision.title },
          options: [],
        });
        const posted = await call(
          await daemon(),
          `/permissions/${decision.id}`,
          { method: "POST", body: { allow } },
        );
        if (!posted.ok) console.error(`error: ${posted.error.message}`);
        // This is the terminal handler for one serialized answer; no caller waits.
        // pi-lens-ignore: missing-error-propagation
      } catch (err) {
        console.error(`error: ${messageOf(err)}`);
      }
    })();
  };

  const cards = new Map<string, Card>();
  const card = (taskId: string): Card => {
    let c = cards.get(taskId);
    if (!c) {
      c = {
        id: taskId,
        agent: "?",
        status: "running",
        durationMs: 0,
        transcript: "",
        warnings: [],
      };
      cards.set(taskId, c);
    }
    return c;
  };

  let connected = false;
  let retrying = false;
  const events = followEvents(connect, {
    onConnect() {
      if (!connected && !quiet) console.log(`attached to ${id}`);
      if (connected && retrying) console.error(`! reconnected to ${id}`);
      connected = true;
      retrying = false;
    },
    onRetry(err) {
      // Once per outage, not once per try.
      if (retrying) return;
      retrying = true;
      console.error(
        `! lost the daemon (${messageOf(err)}); reconnecting — ^C to stop`,
      );
    },
  });
  try {
    for await (const event of events) {
      const { agent, update } = event;
      if (only && agent !== only) continue;
      // The run's own events carry `agent: ""` (M5-5) and belong to no card.
      // The record below already settles the run; M5-10b's reducer reads them.
      if (agent === "") continue;
      const c = card(agent);
      // One task owns the cursor, so it can be drawn in full; the milestone
      // line below would repeat the tool call `render` has just drawn.
      if (only && !quiet) render(event);
      switch (update.sessionUpdate) {
        case "_client_task_started":
          c.agent = update.harness;
          break;
        case "agent_message_chunk":
          if (update.content?.type === "text")
            c.transcript += update.content.text;
          break;
        case "tool_call":
          if (!quiet && !only)
            console.log(`[${agent}] → ${oneLine(update.title)}`);
          break;
        case "_client_stall_warning":
          console.error(`! [${agent}] ${oneLine(update.text)}`);
          break;
        case "_client_result_warning":
          c.warnings?.push({ kind: update.kind, text: update.text });
          if (quiet) console.error(`! [${agent}] ${oneLine(update.text)}`);
          break;
        case "_client_permission_queued":
          answer(agent, update);
          break;
        case "_client_task_finished":
          c.status = update.status;
          c.durationMs = update.durationMs;
          break;
        default:
          // Other session updates do not shape a task card.
          break;
      }
    }
  } catch (err) {
    if (err instanceof VersionRefused) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    if (!connected) {
      // A `runRun` throw before it opens a log (the only real setter of
      // `state.error`) leaves the record as the one place its reason survives.
      console.error(`error: ${initial.error ?? messageOf(err)}`);
      return 1;
    }
    console.error(`error: lost the daemon mid-run: ${messageOf(err)}`);
    console.error(`  start it, then attach again: kapelle attach ${id}`);
    return 1;
  } finally {
    flushStream();
    // `answering` is not drained. The stream ends only once every task has
    // settled, so any question still on screen was already decided by the
    // timeout or a cancel; closing leaves its promise unresolved, and nothing
    // awaits it. A POST still in flight keeps the loop alive on its own.
    asker?.close();
  }
  let state: AttachState;
  try {
    state = await refreshState();
  } catch (err) {
    // A clean stop ends every stream, then the daemon is gone before this
    // reads the run's status.
    console.error(`error: lost the daemon at the end: ${messageOf(err)}`);
    console.error(`  start it, then attach again: kapelle attach ${id}`);
    return 1;
  }

  // The stream is not the whole story. A run killed mid-turn and restored has
  // no `_client_task_finished` for the task it cut, and nothing at all for one
  // still queued; and no stream carries error text or usage. The reply has
  // them — `tasks`, one shape live or restored since M5-2 (the `report`
  // fallback only fits a daemon older than M5-2) — so it fills what the
  // stream left open.
  // `state.status` is the run's authority once the daemon has settled it
  // (M5-5): the terminal record is written before `_client_run_finished`, so a
  // run that ends normally — and a killed run the sweep rewrote — both answer
  // with a terminal status here. A task card cannot be trusted over it: a
  // crash can land after `_client_task_finished {status:"done"}` and before
  // the task's record write, and the sweep then marks the run `killed`. A
  // still-`running` GET means the stream was cut mid-run, and only then do the
  // cards decide.
  for (const r of state.report?.tasks ?? state.tasks ?? []) {
    if (only && r.id !== only) continue;
    const c = card(r.id);
    if (c.status === "running") c.status = r.status;
    if (c.agent === "?" && r.agent) c.agent = r.agent;
    c.durationMs ||= r.durationMs ?? 0;
    c.error ??= r.error;
    c.usage ??= r.usage;
    c.usageSemantics ??= r.usageSemantics;
    if (!c.warnings?.length) c.warnings = r.warnings;
  }
  if (state.error) console.error(`error: ${clean(state.error)}`);
  if (only && !cards.has(only)) {
    console.error(`error: run ${id} has no task ${only}`);
    return 1;
  }

  // Anything that is not a verdict — a card still `running`, a record's
  // `queued` — counts as failed in the fallback: an unfinished task is never a
  // success. The settled run status wins over this whenever GET has one.
  const statuses: TaskStatus[] = [];
  for (const c of cards.values()) {
    statuses.push(
      TASK_STATUSES.has(c.status) ? (c.status as TaskStatus) : "failed",
    );
    if (quiet) {
      if (c.status !== "done" && c.status !== "warned") {
        console.error(`error: [${c.id}] ${c.status}`);
      }
    } else {
      printTask(only ? { ...c, transcript: "" } : c);
    }
  }
  const fromTasks = runStatus(statuses);
  // A throw out of `runRun` fails the run whatever its tasks said: no card
  // can be trusted then, `--task` or not. Otherwise `--task` asks about one
  // task, so its card is the verdict, in its own word — the run's status would
  // fail a task that is `done` because a sibling failed, and `fromTasks` would
  // flatten a `killed` or `queued` card to `failed`. Only a card still
  // `running` (a cut stream) reads as `failed`. Without `--task`, the daemon's
  // settled status is the verdict; the cards only stand in when GET still
  // reads `running` (a cut stream) or is missing (pre-M5-2 daemon).
  const mine = only ? cards.get(only)?.status : undefined;
  const status = attachStatus(state, mine, fromTasks);
  if (!quiet) {
    console.log(`\n${status} — ${plural(statuses.length, "task")}`);
  } else if (!only && status !== "done" && status !== "warned") {
    // `--quiet` drops the summary, not the run's verdict. The card lines above
    // cannot carry it: every card can read `done` while the record says
    // `killed` — a crash between `_client_task_finished` and the record write
    // leaves exactly that — and a `failed` card does not say the run was
    // `killed`. Under `--task` the card line already is the verdict.
    console.error(`error: run ${id} ${status}`);
  }
  return status === "done" || status === "warned" ? 0 : 1;
}

/**
 * `kapelle daemon add <path>`: `POST /repos` to the configured client daemon,
 * else the one named in `daemon.json` (M2-4, #34).
 *
 * `kapelle daemon stop` is the other verb (M9-2): SIGTERM to the pid in
 * `daemon.json`, then wait. It deliberately skips `findDaemon`, because the
 * very daemon whose version this client refuses is the one that has to stop.
 */
async function runDaemonCommand(): Promise<number> {
  const [, verb, ...rest] = positional;
  if (verb === "stop" && rest.length === 0) {
    const pid = await stopDaemon(daemonFile());
    console.log(
      pid === undefined
        ? "no daemon is running"
        : `stopped the daemon (pid ${pid})`,
    );
    return 0;
  }
  if (verb !== "add" || rest.length !== 1) {
    console.error(DAEMON_USAGE);
    return 1;
  }
  const d = await findDaemon();
  if (!d) return 1;
  const path = folderToSend(rest[0], d.fromClient);
  if (!path) {
    console.error(`error: ${FOLDER_GONE}`);
    return 1;
  }
  const r = await call<RepoAdded>(d, "/repos", {
    method: "POST",
    body: { path },
  });
  if (!r.ok) {
    console.error(`error: ${r.error.message}`);
    return 1;
  }
  console.log(`added ${r.body.root}`);
  return 0;
}

/** A daemon's refusal as one line, with its code for a script to match. */
function printRefusal({ code, message }: { code: string; message: string }) {
  console.error(`error: ${oneLine(message)}${code ? ` (${code})` : ""}`);
}

/** Why `room add --model` did not land (M9-5b, #392), else nothing; the
 *  caller prints it as the error. The same check as the screens' `notOn`:
 *  a screen only says it, since a person watches, but an orchestrator may
 *  send work at once. The agent stays, and the room's notice says why. */
function notOnModel(
  asked: string | undefined,
  p: ParticipantDto | undefined,
): string | undefined {
  if (!p || modelConfirmed(asked, p)) return undefined;
  return `${p.name} joined, but ${notConfirmedOn(asked, p)}. Give it no work. To drop it: kapelle room remove ${p.name}`;
}

/** The same fail-loud rule for `room add --level` (M9-9b). */
function notOnLevel(
  asked: string | undefined,
  p: ParticipantDto | undefined,
): string | undefined {
  if (!p || !asked || asked === p.thoughtLevel) return undefined;
  const on = p.thoughtLevel
    ? `it thinks at "${p.thoughtLevel}"`
    : "it has no thinking level";
  return `${p.name} joined, but is not confirmed on the thinking level "${asked}"; ${on}. Give it no work. To drop it: kapelle room remove ${p.name}`;
}

/**
 * The room and the sender for `kapelle room` (M8-3), or why there are none.
 *
 * From the folder: a participant's checkout is
 * `<state>/wt/<roomId>/<participantId>`. Git's top level from the folder
 * gives that checkout, but the recorded workspace can be below it when the
 * room was opened in a repository subdirectory. `GET /rooms/:id` must show
 * that participant, its recorded workspace must be the checkout or below it,
 * and the real cwd must be the checkout or below it. That containment is the
 * whole check, so a renamed, moved or copied folder, or a run's checkout
 * under the same `wt/`, is refused rather than guessed. A non-repository
 * folder is refused even when its path happens to look right.
 *
 * `--room` names the room from a folder that is no checkout, and then the
 * person sends. From a participant's checkout it must name that checkout's
 * own room, and the participant still sends: `--room` never drops the sender
 * (#334). `--as <name>` names another participant as the sender; to send as
 * the person from inside a checkout, `--cwd` names a folder outside it. No
 * `KAPELLE_*` variable carries
 * either: the daemon strips them from a harness (M2-8).
 */
async function roomAndSender(
  d: DaemonAddress,
): Promise<{ room: RoomDto; sender?: ParticipantDto } | string> {
  const roomFlag = flag("room");
  const own = await ownCheckout(d);
  let room: RoomDto;
  let sender: ParticipantDto | undefined;
  // The helper returns its refusal as a string beside the checkout union.
  // pi-lens-ignore: no-runtime-typeof
  if (typeof own === "string") {
    if (roomFlag === undefined) return own;
    const r = await call<RoomDto>(d, `/rooms/${encodeURIComponent(roomFlag)}`);
    if (!r.ok) return `${r.error.message} (${r.error.code})`;
    room = r.body;
  } else {
    if (roomFlag !== undefined && roomFlag !== own.room.id) {
      return (
        `this is ${own.self.name}'s checkout in room ${own.room.id}, not in ` +
        `${roomFlag}; run it with --cwd <dir> outside the checkout`
      );
    }
    room = own.room;
    sender = own.self;
  }
  const as = flag("as");
  if (as !== undefined) {
    sender = byName(room, as);
    if (!sender) return `no participant named ${as} in room ${room.id}`;
  }
  return sender ? { room, sender } : { room };
}

/** The room and the participant whose checkout `--cwd` is in, or why not. */
async function ownCheckout(
  d: DaemonAddress,
): Promise<{ room: RoomDto; self: ParticipantDto } | string> {
  const real = async (p: string) => {
    try {
      return await realpath(p);
    } catch {
      return p;
    }
  };
  const typedCwd = resolve(flag("cwd", process.cwd()));
  const cwd = await real(typedCwd);
  const { root, isRepo } = await stateDirRoot(cwd);
  const checkout = await real(root);
  const refused =
    `${checkout} is not a room participant's checkout; ` +
    "name the room with --room <id> [--as <name>]";
  // Its own words, so a test can tell this refusal from the containment
  // one below (#334).
  if (!isRepo) {
    return (
      `${checkout} is not in a git checkout; ` +
      "name the room with --room <id> [--as <name>]"
    );
  }
  const [wt, roomId, id] = checkout.split(sep).slice(-3);
  if (wt !== "wt" || !roomId || !id) return refused;
  const r = await call<RoomDto>(d, `/rooms/${encodeURIComponent(roomId)}`);
  if (!r.ok) return refused;
  const self = r.body.participants.find((p) => p.id === id);
  if (!self) return refused;
  const workspace = await real(self.worktree);
  // `relative` rather than a string prefix: a sibling such as
  // `<checkout>-copy` must not count as inside the checkout.
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return (
      rel === "" ||
      (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    );
  };
  if (!inside(workspace, checkout) || !inside(cwd, checkout)) return refused;
  return { room: r.body, self };
}

/** A participant by its name, with or without `@`, in any case. */
function byName(room: RoomDto, name: string): ParticipantDto | undefined {
  const wanted = fold(name.replace(/^@/, ""));
  return room.participants.find((p) => fold(p.name) === wanted);
}

/**
 * `kapelle demo` (#463): a room whose one agent is `demo-agent.mjs`, so a
 * new person can try the chat with no harness and no account.
 *
 * The agent starts through `--cmd`, never the registry: it is not measured,
 * so the setup list and `--agent` do not name it, and the room shows the
 * usual "unverified" notice. It runs in `ask`, so the person meets one
 * permission question.
 *
 * The room's folder is one fixed git repository, `<stateDir>/demo`, never the
 * person's checkout. A new folder each time would leave one more
 * `repos/<name>-<hash>` behind on each run. So each run deletes the old demo
 * room, builds the folder again from nothing, and opens a new room there.
 *
 * On a pipe it opens the piped chat, as `kapelle chat new` does, not the
 * `attach with:` line `kapelle loop` prints: the demo is a chat to try, and
 * its tests drive it there.
 */
interface CommandFailure {
  code: string;
  message: string;
}

type DemoRoomResult =
  | { ok: true; room: RoomDto }
  | { ok: false; code: string; message: string };

function demoGit(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=kapelle demo",
      "-c",
      "user.email=demo@kapelle.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "ignore" },
  );
}

async function removeOldDemoRooms(
  d: DaemonAddress,
  folder: string,
): Promise<CommandFailure | undefined> {
  const rooms = await call<RoomListEntry[]>(d, "/rooms");
  if (!rooms.ok) return rooms.error;
  // The daemon deletes no room with uncommitted work, and the demo agent
  // leaves `notes.md`. Clean the checkouts after the dismiss, as the daemon
  // checks them, so a removed participant's checkout is cleaned too.
  for (const old of rooms.body.filter((r) => r.cwd === folder)) {
    console.log(`removing the previous demo room ${old.id}`);
    const stop = await call<RoomDto>(d, `/rooms/${old.id}/dismiss`, {
      method: "POST",
    });
    if (!stop.ok && stop.error.code !== "room_dismissed") return stop.error;
    let worktrees: string[] = [];
    try {
      worktrees = await roomCheckouts(folder, old.id);
    } catch {
      // When git cannot answer, the delete below says why.
    }
    for (const worktree of worktrees) {
      try {
        demoGit(worktree, "reset", "-q", "--hard");
        demoGit(worktree, "clean", "-q", "-fd");
      } catch {
        // A checkout that is gone has nothing to clean.
      }
    }
    const out = await runCommand(d, old.id, { verb: "delete" });
    if (!out.ok) return out;
  }
  return undefined;
}

async function resetDemoFolder(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder);
  await writeFile(
    join(folder, "README.md"),
    "# The kapelle demo\n\nA folder for the demo agent. `kapelle demo` makes it again each time.\n",
  );
  demoGit(folder, "init", "-q");
  demoGit(folder, "add", "README.md");
  demoGit(folder, "commit", "-q", "-m", "The demo folder");
}

async function openDemoRoom(
  d: DaemonAddress,
  folder: string,
  agent: string,
): Promise<DemoRoomResult> {
  const out = await runCommand(d, undefined, {
    verb: "new",
    body: {
      cwd: folder,
      title: "demo",
      agents: [
        {
          // `node`, as the bin's shebang needs, so the label is `demo-agent`.
          cmd: `node ${agent}`,
          name: "demo",
          role: "developer",
          mode: "ask",
        },
      ],
    },
  });
  if (!out.ok) return { ok: false, code: out.code, message: out.message };
  return { ok: true, room: out.room as RoomDto };
}

async function sendDemoIntro(
  d: DaemonAddress,
  room: RoomDto,
): Promise<CommandFailure | undefined> {
  const demo = room.participants[0];
  if (!demo)
    return { code: "", message: `the demo room ${room.id} has no agent` };
  const sent = await call<MessageAccepted>(
    d,
    `/rooms/${room.id}/agents/${demo.id}/messages`,
    { method: "POST", body: { text: "Hello! Show me around." } },
  );
  return sent.ok ? undefined : sent.error;
}

async function runDemoCommand(): Promise<number> {
  const command = positional;
  const hasOtherOption = [...values.keys()].some(
    (name) => name !== "quiet" && name !== "verbose",
  );
  if (command.length !== 1 || command[0] !== "demo" || hasOtherOption) {
    console.error(USAGE.demo);
    return 1;
  }
  try {
    if (await readClientDaemon(clientConfigPath())) {
      console.error(
        "error: kapelle demo is local: its folder and demo-agent.mjs are on " +
          `this machine, but ${clientConfigPath()} names a daemon elsewhere. ` +
          "Run kapelle demo on the daemon machine, or remove the client setting.",
      );
      return 1;
    }
    // The refusal is this command's exit code; no caller can retry it.
    // pi-lens-ignore: missing-error-propagation
  } catch (err) {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  }
  const agent = join(import.meta.dirname, "demo-agent.mjs");
  // A room's `cmd` splits at whitespace (`resolveAgent`).
  if (/\s/.test(agent)) {
    console.error(
      `error: kapelle demo cannot start its agent: a room's agent command splits at spaces, and this path has one: ${agent}. Install kapelle under a path with no space.`,
    );
    return 1;
  }
  await startDaemon();
  const d = await findDaemon();
  if (!d) return 1;

  const folder = join(stateDir(), "demo");
  const stale = await removeOldDemoRooms(d, folder);
  if (stale) {
    printRefusal(stale);
    return 1;
  }
  await resetDemoFolder(folder);

  const added = await call<RepoAdded>(d, "/repos", {
    method: "POST",
    body: { path: folder },
  });
  if (!added.ok) {
    printRefusal(added.error);
    return 1;
  }
  const opened = await openDemoRoom(d, folder, agent);
  if (!opened.ok) {
    printRefusal(opened);
    return 1;
  }
  const room = opened.room;
  const sent = await sendDemoIntro(d, room);
  if (sent) {
    printRefusal(sent);
    return 1;
  }
  const id = room.id;
  // As for `chat`: `chat.ts` parses `process.argv` itself.
  // The room first: the setup list would cover it (#463).
  process.argv.splice(2, Infinity, "attach", id, "--no-setup");
  await import("./chat.ts");
  return 0;
}

async function listLoopRecipes(cwd: string): Promise<number> {
  const recipes = await listRecipes(cwd);
  // A guard only: the package ships `starter` (M10-4), so this fires only
  // when an install lost its `assets/loops/`.
  if (!recipes.length) {
    console.log(`no recipes: looked in ${loopFolders(cwd).join(" and ")}`);
  }
  for (const r of recipes) {
    const hidden = r.wins ? "" : "  (hidden: the one above wins)";
    console.log(oneLine(`${r.name}  ${r.path}${hidden}`));
  }
  return 0;
}

type LoopRouteCommand = Extract<RouteCommand, { verb: "loop" }>;

async function startLoopRoute(
  d: DaemonAddress,
  c: LoopRouteCommand,
  cwd: string,
): Promise<number> {
  const out = await runCommand(d, undefined, c);
  if (!out.ok) {
    printRefusal(out);
    if (out.code === "repo_not_added") {
      // Single-quoted, so a shell expands no remote `~` or `$` here.
      const quoted = `'${cwd.replaceAll("'", "'\\''")}'`;
      console.error(`add the repository first: kapelle daemon add ${quoted}`);
    }
    return 1;
  }
  const id = out.room?.id as string;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    // As for `chat`: `chat.ts` parses `process.argv` itself.
    process.argv.splice(2, Infinity, "attach", id);
    await import("./chat.ts");
    return 0;
  }
  console.log(oneLine(out.line));
  console.log(`attach with: kapelle chat attach ${id}`);
  return 0;
}

/**
 * `kapelle loop` (M8-5): a recipe's start, or `list`. A start opens the room
 * and sends the orchestrator its first message (`client/command.ts`), then
 * opens the chat on that room on a terminal; a pipe gets the room's id.
 */
async function runLoopCommand(): Promise<number> {
  const [, first, ...args] = positional as string[];
  // `list` with a task after it is a recipe named list.
  const list = first === "list" && args.length === 0;
  const [task = "", note] = args;
  if (!first || (!list && (!task.trim() || args.length > 2))) {
    console.error(LOOP_USAGE);
    return 1;
  }
  // A missing or empty model is a usage error, before any room (M9-5c).
  const model = list ? undefined : flag("model");
  // `list` reads this disk until M11-6; a start sends the daemon a folder
  // (M11-5), as typed when the daemon is remote.
  const d = list ? undefined : await findDaemon();
  if (!list && !d) return 1;
  const cwd = folderToSend(flag("cwd"), d?.fromClient ?? false);
  if (!cwd) {
    console.error(`error: ${FOLDER_GONE}`);
    return 1;
  }

  if (list || !d) return listLoopRecipes(cwd);

  return startLoopRoute(
    d,
    loopCommand({
      recipe: first,
      task,
      note,
      agent: flag("agent"),
      cmd: flag("cmd"),
      model,
      cwd,
    }),
    cwd,
  );
}

/** How a busy participant's turn is attributed, after the branch column. */
function turnFrom(room: RoomDto, p: ParticipantDto): string {
  if (p.status !== "busy") return "";
  if (p.turnFrom === undefined) return ", from the person";
  const sender =
    room.participants.find((q) => q.id === p.turnFrom)?.name ?? p.turnFrom;
  return `, from ${oneLine(sender)}`;
}

function roomUsage(): string {
  return [
    "usage: kapelle room <verb> [--room <id>] [--as <name>] [--cwd dir]",
    "  info                       the room, each agent's branch, and who sent",
    "                             each busy agent's work",
    "  send <name> [text]         a message; the text from stdin when none",
    "  add <harness> [--cmd c] [--name n] [--role r] [--mode m] [--model id]",
    "      [--level id] [--base @name|ref]",
    "                             exits 1 when the model or level is not confirmed",
    "  ff <name> --from <name>    move <name>'s branch up to the other's commit",
    "  diff <name> [base]         what is not committed, or with base the branch;",
    "                             made safe for a terminal, so not a patch to apply",
    "  remove <name>",
    "The checkout it runs in names the room and the sender. --as names another",
    "participant as the sender; --cwd <dir> outside any checkout sends as the person.",
  ].join("\n");
}

interface RoomInvocation {
  verb: string;
  args: string[];
}

interface RoomOrderRequest extends RoomInvocation {
  model?: string;
  level?: string;
}

function roomTakes(): Record<string, [min: number, max: number]> {
  // The verb token is the runtime key; this is the one lookup shape it needs.
  // pi-lens-ignore: no-known-value-widening
  return {
    info: [0, 0],
    send: [1, Infinity],
    add: [0, 1],
    ff: [1, 1],
    diff: [1, 2],
    remove: [1, 1],
  };
}

function checkRoomInvocation({ verb, args }: RoomInvocation): boolean {
  // The leaf parser refuses an option this verb does not take, so text such
  // as `--force now` is never silently dropped from a message (#334).
  // On a terminal, a stdin read would wait for ^D with no word (#334).
  if (verb === "send" && args.length === 1 && process.stdin.isTTY) {
    console.error(
      "error: room send needs the text: after the name, or piped on stdin",
    );
    return false;
  }
  return true;
}

function parseRoomInvocation(): RoomInvocation | undefined {
  const [, verb, ...args] = positional as string[];
  const takes = roomTakes();
  // `hasOwn`: `takes.constructor` is not a verb (#334).
  const range =
    verb !== undefined && Object.hasOwn(takes, verb) ? takes[verb] : undefined;
  if (
    !range ||
    args.length < range[0] ||
    args.length > range[1] ||
    (verb === "diff" && args[1] !== undefined && args[1] !== "base") ||
    (verb === "ff" && !flag("from"))
  ) {
    console.error(roomUsage());
    return undefined;
  }
  const invocation = { verb, args };
  return checkRoomInvocation(invocation) ? invocation : undefined;
}

type RoomNamed = (name: string) => ParticipantDto | undefined;

function roomNamed(room: RoomDto): RoomNamed {
  return (name: string) => {
    const p = byName(room, name);
    if (!p) console.error(`error: no participant named ${oneLine(name)}`);
    return p;
  };
}

interface RoomContext {
  d: DaemonAddress;
  room: RoomDto;
  sender: ParticipantDto | undefined;
  named: RoomNamed;
}

function printRoomInfo(room: RoomDto): void {
  const title = room.title ? `  ${oneLine(room.title)}` : "";
  console.log(`${room.id}  ${room.status}${title}`);
  for (const p of room.participants) {
    const from = turnFrom(room, p);
    console.log(
      oneLine(
        `  ${p.name}  ${p.role ?? "-"}  ${p.harness}  ${p.mode}  ${p.branch ?? "-"}  ${p.status}${from}`,
      ),
    );
  }
}

async function runRoomDiff(
  { d, room, named }: RoomContext,
  args: string[],
): Promise<number> {
  const p = named(args[0] as string);
  if (!p) return 1;
  const r = await agentDiff(d, room.id, p.id, args[1] ? "base" : "head");
  if (!r.ok) {
    printRefusal(r.error);
    return 1;
  }
  console.log(r.body.text ? clean(r.body.text) : "no changes");
  return 0;
}

async function runRoomSend(
  { d, room, sender, named }: RoomContext,
  args: string[],
): Promise<number> {
  const p = named(args[0] as string);
  if (!p) return 1;
  const body =
    args.length > 1 ? args.slice(1).join(" ") : await text(process.stdin);
  if (!body.trim()) {
    console.error("error: the message is empty");
    return 1;
  }
  const r = await call<MessageAccepted>(
    d,
    `/rooms/${room.id}/agents/${p.id}/messages`,
    {
      method: "POST",
      body: { text: body, ...(sender && { from: sender.id }) },
    },
  );
  if (!r.ok) {
    printRefusal(r.error);
    return 1;
  }
  const name = oneLine(p.name);
  console.log(
    r.body.queued
      ? `queued for ${name}, behind ${r.body.queued}`
      : `sent to ${name}`,
  );
  return 0;
}

function buildRoomOrder(
  { verb, args, model, level }: RoomOrderRequest,
  named: RoomNamed,
): RouteCommand | undefined {
  if (verb === "add") {
    const role = flag("role");
    return {
      verb,
      agent: {
        agent: args[0],
        cmd: flag("cmd"),
        name: flag("name"),
        // `none` is no role, as in the screens' `/add` and `/role none`.
        role: role === "none" ? undefined : role,
        mode: flag("mode"),
        model,
        thoughtLevel: level,
        base: flag("base"),
      },
    };
  }
  const p = named(args[0] as string);
  if (!p) return undefined;
  if (verb === "remove") return { verb, id: p.id, name: p.name };
  const from = named(flag("from") as string);
  if (!from) return undefined;
  return {
    verb: "forward",
    id: p.id,
    name: p.name,
    fromId: from.id,
    fromName: from.name,
  };
}

function roomOrderOff(
  command: RouteCommand,
  participant: ParticipantDto | undefined,
): string | undefined {
  if (command.verb !== "add") return undefined;
  return (
    notOnModel(command.agent.model, participant) ??
    notOnLevel(command.agent.thoughtLevel, participant)
  );
}

async function runRoomOrder(
  { d, room, sender, named }: RoomContext,
  request: RoomOrderRequest,
): Promise<number> {
  // add, ff, remove: orders.
  if (sender && sender.role !== "orchestrator") {
    printRefusal({
      code: "not_orchestrator",
      message: `only the orchestrator may ${request.verb}; ${sender.name} is ${sender.role ?? "a participant with no role"}`,
    });
    return 1;
  }
  const command = buildRoomOrder(request, named);
  if (!command) return 1;
  const outcome = await runCommand(d, room.id, command);
  if (!outcome.ok) {
    printRefusal(outcome);
    return 1;
  }
  const off = roomOrderOff(command, outcome.participant);
  if (off) {
    printRefusal({ code: "", message: off });
    return 1;
  }
  console.log(outcome.line);
  return 0;
}

/**
 * `kapelle room <verb>` (M8-3): what an orchestrator does in its room, from
 * its shell. `add`, `remove` and `ff` act the screens' `/add`, `/remove`
 * and `/ff` (`client/command.ts`). `send` returns at once: the turn's answer
 * comes back as a reply (M8-2), so there is no `wait`.
 *
 * `send`, `add`, `ff` and `remove` are the orchestrator's. The daemon refuses
 * `send` from a worker (`invalid_sender`); the others carry no sender, so
 * the CLI refuses them here (`not_orchestrator`, decided 2026-10-22, #267).
 * Like the daemon's, the check is a guard against a mistake, not a lock:
 * `--as` passes it. `info` and `diff` only read, so anyone may run them.
 */
async function runRoomCommand(): Promise<number> {
  const invocation = parseRoomInvocation();
  if (!invocation) return 1;
  const { verb, args } = invocation;
  // A usage error is the caller's, not the daemon's: the argv guard has
  // already refused a missing or empty model or level before any request
  // (M9-5b, #392; M9-9b, #509).
  const model = verb === "add" ? flag("model") : undefined;
  const level = verb === "add" ? flag("level") : undefined;
  const d = await findDaemon();
  if (!d) return 1;
  const found = await roomAndSender(d);
  // The helper returns its refusal as a string beside the room union.
  // pi-lens-ignore: no-runtime-typeof
  if (typeof found === "string") {
    console.error(`error: ${oneLine(found)}`);
    return 1;
  }
  const { room, sender } = found;
  const context: RoomContext = { d, room, sender, named: roomNamed(room) };
  if (verb === "info") {
    printRoomInfo(room);
    return 0;
  }
  if (verb === "diff") return runRoomDiff(context, args);
  if (verb === "send") return runRoomSend(context, args);
  return runRoomOrder(context, { ...invocation, model, level });
}
