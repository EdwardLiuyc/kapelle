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
import { runRun, type TaskRun } from "./core/run.ts";
import { type Task, validateRun } from "./core/runfile.ts";
import { runtimeDir } from "./core/runtime.ts";
import { stateDirRoot } from "./core/worktree.ts";
import { AcpAgent } from "./protocol/agent.ts";
import type { ClientMode } from "./protocol/registry.ts";
import {
  AGENTS,
  printableWarnings,
  resolveAgent,
  resolveEnv,
  warningsFor,
} from "./protocol/registry.ts";
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

const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = argv[i - 1];
  return !(prev?.startsWith("--") && !["--verbose", "--quiet"].includes(prev));
});

const promptText = positional.join(" ").trim();

// `--file` is the other half of this CLI: one prompt, or N of them from a run
// file (M1b-2, #18). One entry point rather than two, because a second CLI
// would only be a second place to keep the notice rules, the SIGINT grace and
// the arg parsing in step.
const runFilePath = flag("file");

if ((!promptText && !runFilePath) || has("help")) {
  console.log(`
kapelle — a minimal Agent Client Protocol client

  kapelle "<prompt>" [options]
  kapelle --file <run.json> [--cwd dir] [--verbose] [--quiet]
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
  kapelle --file tasks.run.json
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
} else if (positional[0] === "merge") {
  process.exitCode = await runMergeCommand().catch((err) => {
    console.error(`error: ${messageOf(err)}`);
    return 1;
  });
} else if (runFilePath) {
  process.exitCode = await runFromFile(runFilePath);
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
      return 1;
    }
  }

  // A positional prompt is the same conflict, and the most dangerous shape of
  // it: `cli.ts --file tasks.json "and also do X"` reads like it queued the
  // extra work. Silently dropping it would be the one failure mode the three
  // flags above are rejected to avoid.
  if (promptText) {
    console.error(
      `a prompt does not apply with --file: a run file carries one prompt ` +
        `per task. Got ${JSON.stringify(promptText)}.`,
    );
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    console.error(`cannot read run file ${path}: ${messageOf(err)}`);
    return 1;
  }

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
  // one. M2-3's queue serves N askers in the daemon only; M2-9's `attach` is
  // what lifts the CLI's limit.
  const askers = validated.tasks.filter((t) => t.mode === "ask");
  const canAsk = askers.length === 1 && Boolean(process.stdin.isTTY);
  if (askers.length > 1) {
    console.error(
      `! ${askers.length} tasks ask, and one prompt cannot serve two — ` +
        `running them as safe. Set a mode per task, or wait for the daemon.`,
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
    // The preflight's refusals land here — an unignored `.kapelle/`, a
    // dirty tree — and each one is an instruction to the operator, not a
    // fault. A stack trace would bury the one line that says what to do.
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
 * The `merge` half: `kapelle merge <runId> [--squash] [--cwd dir]`.
 *
 * M1c-3 ships `--squash` only; `--rebase` is M3-4 and is refused here rather
 * than silently ignored. The `kapelle` bin and the file rename are M1c-5.
 */
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

function printTask(task: TaskRun): void {
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
    return 1;
  }
  const res = await fetch(`http://127.0.0.1:${port}/repos`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
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
