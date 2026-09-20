#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveRunDefaults, warnUnknownConfigEnv } from "./core/config.ts";
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
import { runtimeDir, stateDirFor } from "./core/runtime.ts";
import { moveWorkspace, stateDirRoot } from "./core/worktree.ts";
import { AcpAgent, type AgentEventEnvelope } from "./protocol/agent.ts";
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

/**
 * Flags that take no value. The token after one stays positional, not its
 * value: `kapelle run --file f --detach "and also do X"` must still see the
 * prompt and refuse it, rather than dropping it because `--detach` looked
 * like the value-taking half of a pair.
 */
const BOOLEAN_FLAGS = new Set([
  "--verbose",
  "--quiet",
  "--detach",
  "--help",
  "--rebase",
  "--squash",
]);

/** The statuses `core/run.ts` settles on. A restored record may carry one it
 *  does not (`queued`), and `attach` counts that as failed, never success. */
const TASK_STATUSES = new Set<string>([
  "done",
  "warned",
  "cancelled",
  "skipped",
  "timed_out",
  "failed",
]);

const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = argv[i - 1];
  return !(prev?.startsWith("--") && !BOOLEAN_FLAGS.has(prev));
});

const promptText = positional.join(" ").trim();

// `run --file` is the other half of this CLI: one prompt, or N of them from a
// run file (M1b-2, #18). One entry point rather than two, because a second CLI
// would only be a second place to keep the notice rules, the SIGINT grace and
// the arg parsing in step. A verb since M2-9 (#39), like `merge` and `attach`.
const runFilePath = flag("file");

if ((!promptText && !runFilePath) || has("help")) {
  console.log(`
kapelle — a minimal Agent Client Protocol client

  kapelle "<prompt>" [options]
  kapelle run --file <run.json> [--cwd dir] [--verbose] [--quiet]
  kapelle run --file <run.json> --detach   hands the run to the daemon
  kapelle attach <runId> [--task <taskId>]
                                     streams a detached run, answers its asks;
                                     --task draws that one task in full
  kapelle ps                         every run the daemon knows, and each
                                     task's id and status under it
  kapelle merge <runId> [--squash] [--cwd dir]
  kapelle daemon start [--port n] [--permission-timeout s]
                                     runs in this terminal until ^C or SIGTERM
  kapelle daemon add <path>          adds a repository to the running daemon

Options:
  --agent <id>     ${Object.keys(AGENTS).join(" | ")}   (default: opencode)
  --cmd "<cmd>"    custom agent command, e.g. --cmd "opencode acp"
  --cwd <dir>      workspace root (default: current directory)
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
  kapelle "list the top-level files and summarise this repo"
  kapelle "add a health endpoint" --cwd ../my-app --mode ask
  kapelle "what does src/index.ts do" --mode safe
  kapelle run --file tasks.run.json
  kapelle run --file tasks.run.json --detach
  kapelle merge 20260909-101500-abc1
`);
  process.exit(promptText || runFilePath ? 0 : 1);
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
// `positional[0]`, not `argv[0]`: options such as `--cwd` can precede the
// subcommand, and `flag()`/`has()` deliberately parse flags from anywhere.
if (positional[0] === "daemon" && positional[1] === "start") {
  // `daemon.ts` parses its own flags from `process.argv`, so the words that
  // chose it — and the global presentation flags it does not define — are
  // taken out, and the rest is handed over as typed so `--port n` reaches it.
  const rest = [...argv];
  for (const word of ["daemon", "start", "--quiet", "--verbose"]) {
    const i = rest.indexOf(word);
    if (i !== -1) rest.splice(i, 1);
  }
  process.argv.splice(2, Infinity, ...rest);
  await import("./daemon.ts");
} else if (positional[0] === "daemon") {
  process.exitCode = await runDaemonCommand().catch((err) => {
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
    console.error("run needs a run file: kapelle run --file <run.json>");
    process.exitCode = 1;
  } else if (has("detach")) {
    process.exitCode = await detachRun(runFilePath).catch((err) => {
      console.error(`error: ${messageOf(err)}`);
      return 1;
    });
  } else {
    process.exitCode = await runFromFile(runFilePath);
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
    resolveAgent(flag("agent", "opencode"), flag("cmd")),
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

    // The preamble goes on every prompt, this path included (decided
    // 2026-09-07, #20): one composer, and a one-shot run whose report can be
    // read by eye or by the next thing that wants it. Nothing cross-checks it
    // here — there is no worktree and no task record to hang a warning on.
    // The whole PromptResponse is returned (#62 B3); M1 renders only stopReason.
    const { stopReason } = await agent.prompt(withResultPreamble(promptText));
    // The end of a turn flushes the block `render` still has open (M1c-7):
    // this line prints past the renderer, so nothing else would close it.
    flushStream();
    if (!quiet) console.log(`\n\n— turn ended: ${stopReason}`);
  } catch (err) {
    flushStream();
    console.error(`\nerror: ${messageOf(err)}`);
    process.exitCode = 1;
  } finally {
    closeAsk();
    await agent.stop();
  }
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
        console.error(`! [${taskId}] ${update.text}`);
      }
    });
  }
  if (!quiet) {
    bus.addListener(({ agent: taskId, update }) => {
      // Milestones only. `render` would braid N streams into one line.
      if (update.sessionUpdate === "tool_call") {
        console.log(`[${taskId}] → ${update.title}`);
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
          console.error(`! [${taskId}] ${text}`);
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
      console.error(`error: [${task.id}] ${task.error ?? task.status}`);
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
        `unknown workspace command "${positional[1]}": ` +
          `kapelle workspace [--cwd <dir>] | kapelle workspace move <from> <to>`,
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
    console.error("merge needs one run id: kapelle merge <runId> [--squash]");
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
 * A task as `GET /runs/:id` reports it: a live run's `report.tasks` entry (a
 * `TaskRun`, with its error and usage) or a restored record's `tasks` entry,
 * which carries fewer fields. A restored record's status is a plain string —
 * it may say `queued` for a task the crash left unstarted, which is not a
 * `TaskStatus` and must still keep the verdict away from `done`.
 */
type RecordedTask = Omit<Partial<TaskRun>, "status"> & {
  id: string;
  status: string;
};

/**
 * `GET /runs/:id` as `attach` reads it. `report` belongs to a run this daemon
 * process ran; a run restored after a restart carries `tasks` from its record
 * instead (daemon.ts, M2-6).
 */
interface AttachState {
  error?: string;
  report?: { tasks?: RecordedTask[] };
  tasks?: RecordedTask[];
  notices?: { taskId: string; text: string; kind?: Warning["kind"] }[];
}

function printTask(task: Card): void {
  const secs = (task.durationMs / 1000).toFixed(1);
  console.log(`\n▸ ${task.id} (${task.agent}) ${task.status} in ${secs}s`);
  if (task.error) console.log(`  error: ${task.error}`);
  // Verbatim, tagged by the task above, and never added to another task's:
  // copilot counts cumulatively where opencode counts per turn (M0-5).
  if (task.usage) {
    console.log(
      `  tokens: ${task.usage.totalTokens} total ` +
        `(${task.usage.inputTokens} in, ${task.usage.outputTokens} out; ` +
        `${task.usageSemantics ?? "unknown"})`,
    );
  }
  // Before the prose, not after: the warnings are the reason to read the
  // prose at all, and a reader who stops at the first screen must still see
  // that the agent and the working tree disagreed.
  for (const w of task.warnings ?? []) console.log(`  ! ${w.text}`);
  const prose = task.transcript.trim();
  if (prose) console.log(prose);
}

/** A request to the running daemon, with its token already on it. */
type DaemonApi = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The daemon named in `daemon.json`, or `undefined` with the reason printed.
 * Every verb that talks to the daemon reads it here, so none of them can
 * disagree about what "no daemon is listening" means.
 */
async function daemonApi(): Promise<DaemonApi | undefined> {
  const file = join(runtimeDir(), "daemon.json");
  let holder: { port?: unknown; token?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    // A non-object (`null`, `[]`, `42`) is as unready as a missing file: it
    // must fall through to the message below, not throw on destructuring.
    if (typeof parsed === "object" && parsed !== null) {
      holder = parsed as { port?: unknown; token?: unknown };
    }
  } catch {
    // Missing or malformed: treated as "no daemon is listening" below.
  }
  const { port, token } = holder;
  if (
    typeof port !== "number" ||
    !port ||
    typeof token !== "string" ||
    !token
  ) {
    console.error(
      `no daemon is listening (${file} is missing or not ready). ` +
        "Start one with: kapelle daemon start",
    );
    return undefined;
  }
  return (path, init) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}` },
    });
}

/** The daemon's `{error}` line for a refused request. */
async function refusalOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${res.status}`;
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
  const api = await daemonApi();
  if (!api) return 1;
  const res = await api("/runs", {
    method: "POST",
    body: JSON.stringify({ cwd: resolve(flag("cwd", process.cwd())), run }),
  });
  if (!res.ok) {
    console.error(`error: ${await refusalOf(res)}`);
    return 1;
  }
  const { id } = (await res.json()) as { id: string };
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
 * `kapelle ps`: every run the daemon knows, and each task's id and status
 * under it (M2-10, #121). A finished run's status is its verdict.
 */
async function listRuns(): Promise<number> {
  const api = await daemonApi();
  if (!api) return 1;
  const res = await api("/runs");
  if (!res.ok) {
    console.error(`error: ${await refusalOf(res)}`);
    return 1;
  }
  const runs = (await res.json()) as {
    id: string;
    cwd: string;
    status: string;
    tasks?: { id: string; status: string }[];
  }[];
  for (const run of runs) {
    console.log(`${run.id}  ${run.status}  ${run.cwd}`);
    for (const task of run.tasks ?? []) {
      console.log(`  ${task.id}  ${task.status}`);
    }
  }
  return 0;
}

/**
 * The events of an SSE response, as `core/eventlog.ts` wrote them. A stream
 * cut before the daemon ended it throws, which is what tells `attach` the
 * daemon went away rather than the run finishing.
 */
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AgentEventEnvelope> {
  let buffered = "";
  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    buffered += text;
    let end = buffered.indexOf("\n\n");
    while (end !== -1) {
      for (const line of buffered.slice(0, end).split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          yield JSON.parse(line.slice(6));
        } catch {
          // The caller reports a cut stream the same way; a corrupt frame is
          // no different from one the daemon never finished writing.
          throw new Error("malformed event from the daemon stream");
        }
      }
      buffered = buffered.slice(end + 2);
      end = buffered.indexOf("\n\n");
    }
  }
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
async function attachRun(): Promise<number> {
  const [, id, ...extra] = positional;
  if (!id || extra.length) {
    console.error(
      "attach needs one run id: kapelle attach <runId> [--task <taskId>]",
    );
    return 1;
  }
  const only = flag("task");
  // `run` is the run's own notices (a missing repository, say): they concern
  // every task, so a one-task view keeps them.
  const shown = (taskId: string) =>
    !only || taskId === only || taskId === "run";
  const api = await daemonApi();
  if (!api) return 1;
  const path = `/runs/${encodeURIComponent(id)}`;

  // Notices live on the run record, not the stream: the containment lines
  // (#13) print whatever `--quiet` says, and the advisory ones do not. The
  // same record is the authority `attach` reconciles its verdict against once
  // the stream ends — a run restored after a crash has no `report`, and a
  // stream cut mid-run has no `_client_task_finished` for what it missed.
  let printed = 0;
  const refreshState = async (): Promise<AttachState> => {
    const res = await api(path);
    if (!res.ok) throw new Error(await refusalOf(res));
    const state = (await res.json()) as AttachState;
    const notices = state.notices ?? [];
    for (const { taskId, text, kind } of notices.slice(printed)) {
      if (!shown(taskId)) continue;
      if (kind && printableWarnings([{ kind, text }], quiet).length === 0) {
        continue;
      }
      console.error(`! [${taskId}] ${text}`);
    }
    printed = notices.length;
    return state;
  };
  const initial = await refreshState();

  const res = await api(`${path}/events`);
  if (!res.ok || !res.body) {
    // A `runRun` throw before it opens a log (the only real setter of
    // `state.error`) leaves the record as the one place its reason survives.
    console.error(`error: ${initial.error ?? (await refusalOf(res))}`);
    return 1;
  }
  if (!quiet) console.log(`attached to ${id}`);

  process.on("SIGINT", () => process.exit(130));
  const asker = process.stdin.isTTY ? makeAskPolicy() : undefined;
  let answering = Promise.resolve();
  const answer = (agent: string, decision: ClientPermissionQueuedEvent) => {
    answering = answering
      .then(async () => {
        const openRes = await api("/permissions");
        const open = (await openRes.json()) as { id: string }[];
        if (!open.some((p) => p.id === decision.id)) return;
        if (!asker) {
          console.error(
            `! [${agent}] waiting on [${decision.kind}] ${decision.title} — ` +
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
        const posted = await api(`/permissions/${decision.id}`, {
          method: "POST",
          body: JSON.stringify({ allow }),
        });
        if (!posted.ok) console.error(`error: ${await refusalOf(posted)}`);
      })
      .catch((err) => console.error(`error: ${messageOf(err)}`));
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

  try {
    for await (const event of sseEvents(res.body)) {
      const { agent, update } = event;
      if (only && agent !== only) continue;
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
          if (!quiet && !only) console.log(`[${agent}] → ${update.title}`);
          break;
        case "_client_stall_warning":
          console.error(`! [${agent}] ${update.text}`);
          break;
        case "_client_result_warning":
          c.warnings?.push({ kind: update.kind, text: update.text });
          if (quiet) console.error(`! [${agent}] ${update.text}`);
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
    console.error(`error: lost the daemon mid-run: ${messageOf(err)}`);
    return 1;
  } finally {
    flushStream();
    // `answering` is not drained. The stream ends only once every task has
    // settled, so any question still on screen was already decided by the
    // timeout or a cancel; closing leaves its promise unresolved, and nothing
    // awaits it. A POST still in flight keeps the loop alive on its own.
    asker?.close();
  }
  const state = await refreshState();

  // The stream is not the whole story. A run killed mid-turn and restored has
  // no `_client_task_finished` for the task it cut, and nothing at all for one
  // still queued; and no stream carries error text or usage. The record has
  // them — `report.tasks` for a run this daemon ran, `tasks` for one restored
  // after a restart (daemon.ts, M2-6) — so it fills what the stream left open.
  // `state.status` is never read: it can still say `running` for a beat after
  // the stream ends, and the tasks already decide the run (`runStatus`).
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
  if (state.error) console.error(`error: ${state.error}`);
  if (only && !cards.has(only)) {
    console.error(`error: run ${id} has no task ${only}`);
    return 1;
  }

  // Anything that is not a verdict — a card still `running`, a record's
  // `queued` — counts as failed: an unfinished task is never a success.
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
  // A throw out of `runRun` fails the run whatever its tasks said.
  const status = state.error ? "failed" : runStatus(statuses);
  if (!quiet) console.log(`\n${status} — ${plural(statuses.length, "task")}`);
  return status === "done" || status === "warned" ? 0 : 1;
}

/**
 * `kapelle daemon add <path>`: `POST /repos` to the daemon named in
 * `daemon.json`, with the token from the same file (M2-4, #34).
 */
async function runDaemonCommand(): Promise<number> {
  const [, verb, ...rest] = positional;
  if (verb !== "add" || rest.length !== 1) {
    console.error(
      "usage: kapelle daemon start [--port n] | kapelle daemon add <path>",
    );
    return 1;
  }
  const api = await daemonApi();
  if (!api) return 1;
  const res = await api("/repos", {
    method: "POST",
    body: JSON.stringify({ path: resolve(rest[0] as string) }),
  });
  const body = (await res.json()) as { root?: string; error?: string };
  if (!res.ok) {
    console.error(`error: ${body.error}`);
    return 1;
  }
  console.log(`added ${body.root}`);
  return 0;
}
