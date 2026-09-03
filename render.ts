/**
 * Terminal formatting for one event off the bus — story M1a-7, issue #15.
 *
 * Pure presentation. It reads the wire object and writes characters; it makes
 * no protocol decision, which is why it sits outside `protocol/` and why the
 * dependency arrow only ever points at it.
 *
 * **The switch deliberately has no `default`** (CLAUDE.md). A variant nobody
 * renders is dropped in silence rather than drawn wrong — M0-1 observed two
 * that arrive today and stay unrendered (`available_commands_update` from all
 * three harnesses, `config_option_update` from copilot), and `plan` is a third
 * that no harness emits. `assertNever` would be wrong here: it would turn an
 * unrendered-but-valid notification into a crash.
 */

import type { AgentEventEnvelope } from "./protocol/agent.ts";
import type { ContentBlock } from "./protocol/types.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

let midStream = false;

/** Text is the only block this client draws; anything else renders as nothing. */
const textOf = (c: ContentBlock | undefined): string | undefined =>
  c?.type === "text" ? c.text : undefined;

function line(s: string) {
  if (midStream) {
    process.stdout.write("\n");
    midStream = false;
  }
  process.stdout.write(`${s}\n`);
}

/** Pretty-print a session/update notification. */
export function render({ agent, update }: AgentEventEnvelope): void {
  const tag = dim(`[${agent}]`);

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update.content);
      if (text) {
        process.stdout.write(text);
        midStream = true;
      }
      break;
    }

    case "agent_thought_chunk": {
      const text = textOf(update.content);
      if (text) line(dim(`${tag} thinking: ${text.trim().slice(0, 120)}`));
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
