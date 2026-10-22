/**
 * The setup list — `client/setup.ts`, story M9-3 (#298). No daemon:
 * `tests/daemon.test.ts` sends it from a real one, with a fake `PATH`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { HarnessesReply } from "../contract.ts";
import { needsSetup, setupLines } from "../setup.ts";

const reply = (done: boolean, ready: boolean): HarnessesReply => ({
  checkedAt: "2026-10-22T00:00:00.000Z",
  done,
  harnesses: [
    {
      id: "kimi",
      measured: true,
      state: "not_installed",
      program: "kimi",
      acpProgram: "kimi",
    },
    {
      id: "claude",
      measured: true,
      state: "main_only",
      program: "claude",
      version: "2.1.307",
      acpProgram: "claude-agent-acp",
      install: "npm i -g @agentclientprotocol/claude-agent-acp",
    },
    ...(ready
      ? [
          {
            id: "pi",
            measured: true,
            state: "ready" as const,
            program: "pi",
            version: "1.3.0",
            acpProgram: "pi-acp",
            acpVersion: "0.0.33",
            warning: "pi-acp 0.0.33 is not the build kapelle measured.",
          },
        ]
      : []),
  ],
});

test("the list puts the ready agents first, with each command and warning", () => {
  assert.deepEqual(setupLines(reply(false, true)), [
    { text: "pi      ready (pi 1.3.0, pi-acp 0.0.33)" },
    {
      text: "claude  needs claude-agent-acp: npm i -g @agentclientprotocol/claude-agent-acp",
    },
    {
      text: "kimi    not installed: no kimi on the daemon's PATH",
      tone: "dim",
    },
    {
      text: "! pi-acp 0.0.33 is not the build kapelle measured.",
      tone: "warn",
    },
    {
      text: "After an install, run /setup in the chat, or kapelle setup.",
      tone: "dim",
    },
  ]);
  assert.ok(
    setupLines(reply(true, false)).some(
      (l) => l.text === "No agent is ready: install one." && l.tone === "warn",
    ),
  );
});

test("the list opens at start until done, and always with no agent ready", () => {
  assert.equal(needsSetup(reply(false, true)), true);
  assert.equal(needsSetup(reply(true, true)), false);
  assert.equal(needsSetup(reply(true, false)), true);
  // A daemon older than M9-3 sends no state: never.
  assert.equal(
    needsSetup({
      checkedAt: "",
      done: true,
      harnesses: [{ id: "pi", measured: true }],
    }),
    false,
  );
});
