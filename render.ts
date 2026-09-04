/**
 * Terminal formatting for one event off the bus — story M1a-7, issue #15.
 *
 * Pure presentation. It reads the wire object and writes characters; it makes
 * no protocol decision, which is why it sits outside `protocol/` and why the
 * dependency arrow only ever points at it.
 *
 * **The switch deliberately has no `default`** (CLAUDE.md). A variant nobody
 * renders is dropped in silence rather than drawn wrong — M0-1 observed two
 * that arrive today and have no branch here: `available_commands_update` from
 * all three harnesses, and `config_option_update` from copilot. `assertNever`
 * would be wrong here: it would turn an unrendered-but-valid notification into
 * a crash. (`plan` is the mirror case — it *has* a branch, and no harness M0-1
 * measured emits one, so `mock-agent.mjs` is the only thing that drives it.)
 */

import type { AgentEventEnvelope } from "./protocol/agent.ts";
import type { ContentBlock } from "./protocol/types.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/**
 * Which stream is open on the current line, so the next write knows whether to
 * continue it or close it first. Prose and thinking both arrive a few tokens at
 * a time; the only difference is that thinking is dim and announces itself once.
 */
let stream: "none" | "message" | "thought" = "none";

function endStream() {
  if (stream !== "none") {
    process.stdout.write("\n");
    stream = "none";
  }
}

/** Text is the only block this client draws; anything else renders as nothing. */
const textOf = (c: ContentBlock | undefined): string | undefined =>
  c?.type === "text" ? c.text : undefined;

function line(s: string) {
  endStream();
  process.stdout.write(`${s}\n`);
}

/** Pretty-print a session/update notification. */
export function render({ agent, update }: AgentEventEnvelope): void {
  const tag = dim(`[${agent}]`);

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update.content);
      if (text) {
        if (stream !== "message") endStream();
        process.stdout.write(text);
        stream = "message";
      }
      break;
    }

    case "agent_thought_chunk": {
      // Streamed like prose, for the same reason: a real harness sends a single
      // thought as many small chunks, and one prefixed line per chunk cut every
      // sentence into unreadable fragments. The prefix is kept — it is what
      // separates thinking from what the agent is actually saying — but it is
      // printed once per run of thinking, not once per chunk.
      const text = textOf(update.content);
      if (!text) break;
      let out = text;
      if (stream !== "thought") {
        endStream();
        // Built from `agent` rather than `tag`: nesting dim inside dim ends the
        // run at the inner reset, and the words after it lose the dimming.
        process.stdout.write(dim(`[${agent}] thinking: `));
        // The prefix already supplies the space, and a chunk that opens a run
        // often starts mid-sentence with one.
        out = text.trimStart();
        stream = "thought";
      }
      process.stdout.write(dim(out));
      break;
    }

    case "tool_call":
      line(
        `${tag} ${cyan("→")} ${update.title ?? "(tool)"} ${dim(`[${update.kind ?? "other"}]`)}`,
      );
      break;

    case "tool_call_update":
      if (update.status === "failed") {
        line(`${tag} ${red("✗")} tool ${update.toolCallId} failed`);
      } else if (update.status === "completed") {
        for (const c of update.content ?? []) {
          if (c.type === "diff") line(`${tag} ${green("±")} ${c.path}`);
        }
      }
      break;

    case "plan":
      line(`${tag} plan:`);
      for (const e of update.entries ?? []) {
        line(dim(`     • ${e.content}`));
      }
      break;

    case "usage_update":
      line(dim(`${tag} context ${update.used}/${update.size} tokens`));
      break;

    // Synthetic events emitted by our client, not the protocol.
    case "_client_permission":
      line(
        update.allow
          ? `${tag} ${green("✓ allowed")} ${update.title}`
          : `${tag} ${red("✗ refused")} ${update.title} ${dim(`[${update.kind}]`)}`,
      );
      break;

    case "_client_wrote_file":
      line(`${tag} ${green("wrote")} ${update.path}`);
      break;
  }
}
