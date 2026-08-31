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
import { resolveAgent, resolveEnv } from "./agents.mjs";
import { AcpAgent, autoPolicy, safePolicy } from "./protocol/agent.ts";

const file = process.argv[2] ?? "tasks.json";

let tasks;
try {
  tasks = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  console.error(`fanout: cannot read ${file}: ${error.message}`);
  process.exit(1);
}

const POLICIES = { safe: safePolicy, auto: autoPolicy };

const results = await Promise.allSettled(
  tasks.map(async (task, i) => {
    const spec = resolveAgent(task.agent ?? "opencode", task.cmd);
    const label = `${task.agent ?? spec.name}#${i}`;

    // Interleaved token streams are unreadable, so buffer the prose and only
    // log milestones live.
    const transcript = [];

    const agent = new AcpAgent({
      name: label,
      command: spec.command,
      args: spec.args,
      env: resolveEnv(spec.env),
      cwd: task.cwd ?? process.cwd(),
      policy: POLICIES[task.mode ?? "safe"] ?? safePolicy,
      onEvent: ({ update }) => {
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.text
        ) {
          transcript.push(update.content.text);
        }
        if (update.sessionUpdate === "tool_call") {
          console.log(`[${label}] → ${update.title}`);
        }
      },
    });

    try {
      await agent.start();
      await agent.newSession();
      const stopReason = await agent.prompt(task.prompt);
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
