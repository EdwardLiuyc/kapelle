const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

let midStream = false;

function line(s) {
  if (midStream) {
    process.stdout.write("\n");
    midStream = false;
  }
  process.stdout.write(`${s}\n`);
}

/** Pretty-print a session/update notification. */
export function render({ agent, update }) {
  const tag = dim(`[${agent}]`);

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = update.content?.text;
      if (text) {
        process.stdout.write(text);
        midStream = true;
      }
      break;
    }

    case "agent_thought_chunk": {
      const text = update.content?.text;
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
