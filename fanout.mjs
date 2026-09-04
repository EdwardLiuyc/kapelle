#!/usr/bin/env node
/**
 * The reason the client exists: one supervisor process, N harnesses.
 *
 *   node fanout.mjs tasks.json
 *
 * Each task gets its own agent subprocess, its own session, and its own
 * workspace root. They run concurrently and report back structurally.
 */
import { readFile } from "node:fs/promises";
import { createEventBus } from "./core/events.ts";
import { negotiateSafeMode, policyFor, resolvePolicy } from "./core/policy.ts";
import { AcpAgent } from "./protocol/agent.ts";
import { resolveAgent, resolveEnv, warningsFor } from "./protocol/registry.ts";

const file = process.argv[2] ?? "tasks.json";

let tasks;
try {
  tasks = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  console.error(`fanout: cannot read ${file}: ${error.message}`);
  process.exit(1);
}

const results = await Promise.allSettled(
  tasks.map(async (task, i) => {
    const spec = resolveAgent(task.agent ?? "opencode", task.cmd);
    const label = `${task.agent ?? spec.name}#${i}`;

    // No task has a TTY, so `ask` cannot prompt. It is resolved as `safe`
    // rather than renamed, so safe's own rules — including forcing
    // allowReadOutsideRoot to false — apply to the mode that actually runs.
    const asked = task.mode ?? spec.defaultMode ?? "ask";
    // stderr with the `!` marker, like every other notice here and in run.ts:
    // stdout carries results, stderr carries what the run wants you to know.
    if (asked === "ask")
      console.error(`[${label}] ! no TTY — ask runs as safe`);
    const resolved = resolvePolicy({
      task: {
        mode: asked === "ask" ? "safe" : asked,
        allowReadOutsideRoot: task.allowReadOutsideRoot,
      },
      harness: {
        name: spec.name,
        mode: spec.defaultMode,
        maxMode: spec.maxMode,
      },
    });

    // Interleaved token streams are unreadable, so buffer the prose and only
    // log milestones live.
    const transcript = [];

    const bus = createEventBus();
    bus.subscribe(({ update }) => {
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.text
      ) {
        transcript.push(update.content.text);
      }
      if (update.sessionUpdate === "tool_call") {
        console.log(`[${label}] → ${update.title}`);
      }
    });

    const agent = new AcpAgent({
      name: label,
      command: spec.launch.command,
      args: spec.launch.args,
      env: resolveEnv(spec.launch.env),
      cwd: task.cwd ?? process.cwd(),
      policy: policyFor(resolved.mode),
      allowReadOutsideRoot: resolved.allowReadOutsideRoot,
      onEvent: bus.emit,
    });

    try {
      const init = await agent.start();

      // The containment notice is never silenced (#62 R1, #13), and fanout is
      // the second entry point that can start a harness under `safe`. Like
      // run.ts, notices go to stderr; milestones below stay on stdout.
      for (const w of warningsFor(
        spec.name,
        spec,
        resolved.mode,
        init.agentInfo?.version,
      )) {
        console.error(`[${label}] ! ${w.text}`);
      }

      await agent.newSession();
      const notNegotiated = await negotiateSafeMode(agent, spec, resolved.mode);
      if (notNegotiated) console.error(`[${label}] ! ${notNegotiated}`);
      const { stopReason } = await agent.prompt(task.prompt);
      return { label, cwd: agent.cwd, stopReason, output: transcript.join("") };
    } finally {
      agent.stop();
    }
  }),
);

console.log(`\n${"═".repeat(60)}`);
for (const [i, r] of results.entries()) {
  const task = tasks[i];
  if (r.status === "fulfilled") {
    console.log(
      `\n▸ ${r.value.label} (${r.value.stopReason}) in ${r.value.cwd}`,
    );
    console.log(r.value.output.trim().slice(0, 800));
  } else {
    console.log(
      `\n▸ ${task.agent ?? "agent"}#${i} FAILED: ${r.reason.message}`,
    );
  }
}
