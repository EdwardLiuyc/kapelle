#!/usr/bin/env node
/**
 * A fake ACP agent — the agent side of the protocol.
 *
 * Lets you exercise the client with no harness installed:
 *   node cli.ts "hello" --cmd "node mock-agent.mjs" --mode safe
 *
 * It answers initialize / session/new / session/set_mode / session/prompt,
 * streams a message, calls back into the client's fs/read_text_file, and asks
 * permission for a write — enough to prove every path in the client works.
 *
 * `--scenario <name>` selects a named fixture instead (M1b-5). Argv,
 * never a keyword in the prompt: `silent-session` fires during the handshake,
 * before any prompt exists, so no keyword could reach it. With no flag the
 * compliant default path runs, so `npm run selftest` is unchanged.
 *
 * `--store <dir>` keeps each session's prompts in `<dir>`, so a new process
 * can `session/load` it (M6-7b). Only then does the handshake advertise
 * `loadSession: true`. The load replays the old turns as `session/update`
 * before it answers, as every real harness does (§M0-9).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Every fixture, and what the client is meant to make of it. */
const SCENARIOS = {
  refuse: "ends the turn with stopReason refusal",
  "silent-session": "never answers session/new",
  "no-result": "prose with no <task-result> block at all",
  "malformed-result": "a block whose <summary> is empty",
  "read-only": "reports success, lists no files and changes nothing",
  "files-not-in-diff": "lists a file it never wrote",
  "unasked-write": "writes a file itself, without asking permission",
  "files-unclaimed": "asks, writes two files, then lists only one of them",
  "eof-write": "writes a file when stdin ends, after the turn has ended",
  stall: "writes one file, then emits nothing and never returns",
  deaf: "never ends a turn and ignores session/cancel; exits when stdin closes",
  stubborn:
    "like stall, but ignores SIGTERM and stays alive after its stdin closes",
  repeat: "the same tool title on a loop, then ends the turn itself",
  remember: "answers each turn with the previous turn's prompt, per session",
  "no-load":
    "like remember, but the handshake says loadSession: false, even with --store",
  split: "remember, with each answer sent in two chunks",
  slow: "like remember, but answers after SLOW_MS, and loads after it too; a cancel ends the turn at once",
  "mode-refused-once": "refuses the first session/set_mode, then accepts",
  "diff-first":
    "the default path, with the write's diff block sent before the ask",
  "file-text": "the default path, asking with copilot's rawInput.file_text",
  "diff-bad-old":
    "like diff-first, but the diff block's oldText is a number, not text",
  runs: "a note and six tool calls, then a wait for runs.go in its folder, then a note; later turns only the note",
  answer:
    "a note, a tool call, a second note, two tool calls, then ends with no text",
  long: "one answer longer than 64 KiB",
  "long-call":
    "like long, in a 3-byte character, so 64 KiB splits one, then a tool call",
  half: "a note and a tool call, then waits for a cancel, like stall, and answers it end_turn, as copilot does (§M0-4)",
  "prompt-error": "a note, then answers the prompt with a JSON-RPC error",
};

const storeAt = process.argv.indexOf("--store");
const store = storeAt === -1 ? null : process.argv[storeAt + 1];

const at = process.argv.indexOf("--scenario");
const scenario = at === -1 ? null : process.argv[at + 1];
if (scenario !== null && !Object.hasOwn(SCENARIOS, scenario)) {
  // Louder than a fallback to the default path: a typo'd scenario that ran
  // the compliant fixture would make a test pass for the wrong reason.
  console.error(
    `[mock-agent] unknown --scenario "${scenario}". Known: ${Object.keys(
      SCENARIOS,
    ).join(", ")}`,
  );
  process.exit(2);
}

// M1c-2's stall fixture writes before the protocol starts. A task that changed
// nothing is untouched, and `release` rolls its branch back
// (`core/worktree.ts:382`); writing at startup means the work is already on disk
// if the TTL fires during spawn/handshake/startup, before the prompt would
// otherwise arrive.
if (scenario === "stall" || scenario === "stubborn") {
  writeFileSync("stalled.txt", "written just before going quiet\n");
}

// #110's fixture writes only when the client closes stdin, which `stop()` does
// after the turn: a tree read taken before the stop misses it.
if (scenario === "eof-write") {
  process.stdin.on("end", () => {
    writeFileSync("late.txt", "written after the turn ended\n");
  });
}

// M2-5's crash-recovery test: a harness the daemon's graceful stop cannot end.
// `stall` leaves the event loop with nothing to do once the client closes its
// stdin; this fixture must not, and it must shrug off the sweep's SIGTERM so
// the escalation to SIGKILL is what actually kills it.
if (scenario === "stubborn") {
  // A surviving harness can meet three things a dying supervisor leaves: the
  // signals its shutdown path would send, a stdout/stderr reader that is gone,
  // and nothing else. Ignore the first two so only SIGKILL can end it.
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    process.on(signal, () => {});
  }
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  setInterval(() => {}, 1 << 30);
}

const result = (status, summary, details, files) =>
  `<task-result>\n<status>${status}</status>\n<summary>${summary}</summary>\n` +
  `<details>${details}</details>\n${files ? `<files>${files}</files>\n` : ""}` +
  `</task-result>\n`;

/**
 * The final message each block-shaped fixture sends, in place of the whole
 * read / permission / write dance the default path runs.
 *
 * No tools and no permission requests, so `permissionCount` is 0 and the
 * working tree holds only what the fixture itself put there — which is what
 * makes each cross-check in `core/result.ts` fire on its own.
 */
const FINAL_MESSAGE = {
  "no-result": "I read the file and fixed it. That is all I have to say.",
  "malformed-result": `Done.\n${result("success", "", "Nothing was changed.")}`,
  "read-only": result("success", "Read the file.", "Changed nothing."),
  "files-not-in-diff": result(
    "success",
    "Fixed most of the bug.",
    "Edited one file.",
    "ghost.md",
  ),
  // **No `<files>`, deliberately.** The write lands in the process cwd, but
  // `changedPaths` reads `git status`, which reports paths from the repository
  // root — so under a `--cwd` naming a subdirectory the tree says
  // `sub/sneaky.txt` and any cwd-relative `<files>` here would trip
  // `filesNotInDiff` alongside the `policyNeverFired` this fixture is for.
  // Reporting nothing is also what a real agent that forgot the field does.
  "unasked-write": result(
    "success",
    "Wrote a file.",
    "Wrote it directly, never through the client.",
  ),
  // The mirror of `files-not-in-diff`: there the list names a file the tree
  // lacks, here the tree holds a file the list never names. `claimed.txt` is
  // in the diff, so `filesNotInDiff` stays quiet, and the fixture asks
  // permission first so `policyNeverFired` does too -- one warning, like every
  // sibling above.
  "files-unclaimed": result(
    "success",
    "Wrote the file.",
    "Wrote one file and mentioned it.",
    "claimed.txt",
  ),
  // #110: the same one-warning shape, but the second file is written by the
  // end-of-file handler above, so only a tree read after `stop()` can see it.
  "eof-write": result(
    "success",
    "Wrote the file.",
    "Wrote one file during the turn.",
    "claimed.txt",
  ),
};

// M0-5 pinned `usage` on the prompt *response* — the only per-task token count
// present on all three harnesses, and the one the mock never sent.
const USAGE = {
  inputTokens: 1200,
  outputTokens: 34,
  totalTokens: 1234,
  cachedReadTokens: 0,
};

/** M1c-2's repeat fixture. Twelve calls 150 ms apart hold the turn open for
 *  ~1.8 s, which is past one sweep: `sweepIntervalMs` never ticks faster than
 *  once a second (`core/watchdog.ts`), so a tighter loop would finish before
 *  the watchdog ever looked at it. */
const REPEATS = 12;
const REPEAT_TITLE = "Search for the same thing again";
const REPEAT_GAP_MS = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a `slow` turn lasts: long enough that a test's next messages
 *  reach the room while it runs, so they queue (M6-4). */
const SLOW_MS = 1000;

/** The prompt `stall` never answered, kept so `session/cancel` can end it.
 *  M0-4 measured every real harness ending its turn within 64 ms of a cancel,
 *  so answering is the realistic half; a harness that ignores the cancel is
 *  already covered by `tests/cli.test.ts`'s inline stubborn agent. */
let stalledPromptId = null;

/** Whether `mode-refused-once` has refused its one `session/set_mode`. */
let modeRefused = false;

/** Whether `runs` has sent its tool run: only the first turn has one. */
let ranRuns = false;

let nextId = 1000;
let sessionCount = 0;
const pending = new Map();
/** Every id we minted. A prompt for any other id is a client bug. */
const sessions = new Set();
/** The `remember` fixture's memory: session id → the last prompt it saw. Held
 *  by the session, not the process, so a fresh session remembers nothing. */
const lastPrompt = new Map();

/** `--store`'s file for one session: every prompt it saw, in order. */
const storeFile = (sid) => join(store, `${sid}.json`);
const stored = (sid) => JSON.parse(readFileSync(storeFile(sid), "utf8"));
const keep = (sid, prompts) =>
  store && writeFileSync(storeFile(sid), JSON.stringify(prompts));

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) =>
  send({ jsonrpc: "2.0", id, error: { code: -32602, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

function callClient(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const update = (sessionId, u) =>
  notify("session/update", { sessionId, update: u });

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`[mock-agent] ignoring non-JSON line: ${line}`);
    return;
  }

  if (msg.id !== undefined && !msg.method) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }

  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: store !== null && scenario !== "no-load",
        promptCapabilities: {},
      },
      agentInfo: { name: "mock-agent", version: "0.1.0" },
      authMethods: [],
    });
  }

  if (msg.method === "session/new") {
    // Silence, not an error: the client's own handshake deadline
    // (`protocol/agent.ts:503`) is the thing under test, and any reply at all
    // would answer it.
    if (scenario === "silent-session") return;
    // Unique with a store, so one process never loads another's session.
    const sid = store
      ? `sess_mock_${randomUUID()}`
      : `sess_mock_${++sessionCount}`;
    sessions.add(sid);
    keep(sid, []);
    reply(msg.id, { sessionId: sid });
  }

  if (msg.method === "session/load") {
    const { sessionId: sid } = msg.params;
    let prompts;
    try {
      prompts = store ? stored(sid) : null;
    } catch {
      prompts = null;
    }
    if (!prompts) {
      fail(msg.id, `no stored session "${sid}"`);
      return;
    }
    if (scenario === "slow") await sleep(SLOW_MS);
    // The old turns, as the `remember` fixture answered them.
    prompts.forEach((text, i) => {
      update(sid, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text },
      });
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `previous: ${prompts[i - 1] ?? "(none)"}`,
        },
      });
    });
    sessions.add(sid);
    if (prompts.length > 0) lastPrompt.set(sid, prompts.at(-1));
    reply(msg.id, {});
    return;
  }

  // Any id is accepted, and echoed as `current_mode_update`, so a test reads
  // from the event stream which harness-side id the client sent.
  if (msg.method === "session/set_mode") {
    const { sessionId: sid, modeId } = msg.params;
    if (scenario === "mode-refused-once" && !modeRefused) {
      modeRefused = true;
      fail(msg.id, `mode "${modeId}" refused, once`);
      return;
    }
    update(sid, {
      sessionUpdate: "current_mode_update",
      currentModeId: modeId,
    });
    reply(msg.id, {});
    return;
  }

  if (msg.method === "session/cancel") {
    // `deaf` is the harness a shutdown's grace exists for (M6-7a): only its
    // stdin closing ends it.
    if (stalledPromptId !== null && scenario !== "deaf") {
      const stopReason = scenario === "half" ? "end_turn" : "cancelled";
      reply(stalledPromptId, { stopReason, usage: USAGE });
      stalledPromptId = null;
    }
    return;
  }

  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;

    // An id we never minted is a client bug, and a mock that answered it
    // anyway would hide one.
    if (!sessions.has(sid)) {
      fail(msg.id, `unknown session "${sid}"`);
      return;
    }

    // `refuse` is the offline way to reach a **failure that never throws** —
    // M1b-2's stop-reason table says `refusal`, `max_tokens` and
    // `max_turn_requests` all return normally, and a client that only reports
    // exceptions goes silent on every one of them.
    if (scenario === "refuse") {
      reply(msg.id, { stopReason: "refusal", usage: USAGE });
      return;
    }

    // A second turn on one session, after the first ended. The answer carries
    // the previous turn's prompt, so a test can tell a session that kept its
    // context from a client that silently opened a new one.
    // `split` is `remember` with the answer in two chunks, so a client must
    // join the pieces of one answer.
    if (
      scenario === "remember" ||
      scenario === "no-load" ||
      scenario === "slow" ||
      scenario === "split"
    ) {
      const text = msg.params.prompt?.[0]?.text ?? "";
      const previous = lastPrompt.get(sid) ?? "(none)";
      lastPrompt.set(sid, text);
      if (store) keep(sid, [...stored(sid), text]);
      if (scenario === "slow") {
        // Kept where `session/cancel` finds it, which answers `cancelled`.
        stalledPromptId = msg.id;
        await sleep(SLOW_MS);
        if (stalledPromptId !== msg.id) return;
        stalledPromptId = null;
      }
      const chunks =
        scenario === "split"
          ? ["previous: ", previous]
          : [`previous: ${previous}`];
      for (const chunk of chunks) {
        update(sid, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        });
      }
      reply(msg.id, { stopReason: "end_turn", usage: USAGE });
      return;
    }

    // M7-2's tool run: the wait lets a test scroll before the next note
    // folds the run.
    if (scenario === "runs") {
      const say = (text) =>
        update(sid, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      if (!ranRuns) {
        ranRuns = true;
        say("Looking.");
        for (let i = 0; i < 6; i++) {
          update(sid, {
            sessionUpdate: "tool_call",
            toolCallId: `run${i}`,
            title: i < 5 ? `Read f${i}.ts` : `Edit f${i}.ts`,
            kind: i < 5 ? "read" : "edit",
            status: "completed",
          });
        }
        while (!existsSync("runs.go")) await sleep(50);
      }
      say("Done.");
      reply(msg.id, { stopReason: "end_turn", usage: USAGE });
      return;
    }

    // M8-2's answer fixtures: which text a reply carries, its cut, and what
    // a cancel, an exit or an error leaves of it.
    if (
      scenario === "answer" ||
      scenario === "long" ||
      scenario === "long-call" ||
      scenario === "half" ||
      scenario === "prompt-error"
    ) {
      const say = (text) =>
        update(sid, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      const call = (n) =>
        update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: `call${n}`,
          title: `Read f${n}.ts`,
          kind: "read",
          status: "completed",
        });
      if (scenario === "long") say("x".repeat(70_000));
      else if (scenario === "long-call") {
        say("€".repeat(30_000));
        call(1);
      } else {
        say("Plan.");
        call(1);
      }
      if (scenario === "answer") {
        say("Middle.");
        call(2);
        call(3);
      }
      if (scenario === "half") {
        stalledPromptId = msg.id;
        return;
      }
      if (scenario === "prompt-error") {
        fail(msg.id, "the model failed");
        return;
      }
      reply(msg.id, { stopReason: "end_turn", usage: USAGE });
      return;
    }

    // M1c-2's stall fixture never answers this prompt. The file was already
    // written at startup, so a TTL that fires before the prompt arrives still
    // leaves the branch/worktree intact to inspect.
    if (
      scenario === "stall" ||
      scenario === "stubborn" ||
      scenario === "deaf"
    ) {
      stalledPromptId = msg.id;
      return;
    }

    // The busy loop idle time structurally cannot see: one title, over and
    // over, then a normal end of turn — repeat warns and must not cancel.
    if (scenario === "repeat") {
      for (let i = 0; i < REPEATS; i++) {
        update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: `loop${i}`,
          title: REPEAT_TITLE,
          kind: "search",
          status: "pending",
        });
        await sleep(REPEAT_GAP_MS);
      }
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: result(
            "partial",
            "Ran the same search over and over.",
            `Repeated "${REPEAT_TITLE}" ${REPEATS} times, then gave up.`,
          ),
        },
      });
      reply(msg.id, { stopReason: "end_turn", usage: USAGE });
      return;
    }

    const final = FINAL_MESSAGE[scenario];
    if (final) {
      if (scenario === "unasked-write") {
        // Directly, never through `fs/write_text_file`: `policyNeverFired` is
        // about a harness that mutates the workspace with its own tools, which
        // is what the client cannot see and can only infer afterwards.
        writeFileSync("sneaky.txt", "written behind the client's back\n");
      }
      if (scenario === "files-unclaimed" || scenario === "eof-write") {
        // Ask first. The permission itself is not what is under test -- it is
        // what keeps `permissionCount` above zero, so this stays a one-warning
        // fixture instead of tripping `policyNeverFired` as well.
        update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Write claimed.txt",
          kind: "edit",
          rawInput: { path: "claimed.txt" },
          status: "pending",
        });
        await callClient("session/request_permission", {
          sessionId: sid,
          toolCall: { toolCallId: "t1" },
          options: [
            { optionId: "yes", name: "Allow once", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        });
        // Written with its own tools, so the client sees neither: the list
        // below is the only account it gets. `files-unclaimed` writes both
        // files here; `eof-write`'s second lands on end of file instead.
        writeFileSync("claimed.txt", "the file the agent mentions\n");
        if (scenario === "files-unclaimed") {
          writeFileSync("unclaimed.txt", "the file the agent does not\n");
        }
      }
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: final },
      });
      reply(msg.id, { stopReason: "end_turn", usage: USAGE });
      return;
    }

    update(sid, {
      sessionUpdate: "plan",
      entries: [
        {
          content: "Read a file through the client",
          priority: "high",
          status: "pending",
        },
        {
          content: "Try a write that needs permission",
          priority: "medium",
          status: "pending",
        },
      ],
    });

    update(sid, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Deciding which file to read first." },
    });

    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Reading package.json via the client… " },
    });

    // Exercise the client's fs capability.
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read package.json",
      kind: "read",
      status: "pending",
    });
    const file = await callClient("fs/read_text_file", {
      sessionId: sid,
      path: "package.json",
      limit: 3,
    });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });

    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `got ${file?.content?.length ?? 0} chars.\n`,
      },
    });

    // Exercise the permission path with a mutating tool. Two fixtures say
    // what the write is before the ask (M4-6): claude's way, a `diff`
    // block, and copilot's, `file_text` in the input.
    const newText = "written by the mock agent through the client\n";
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Write ACP_TEST.md",
      kind: "edit",
      rawInput:
        scenario === "file-text"
          ? { path: "ACP_TEST.md", file_text: newText }
          : { path: "ACP_TEST.md" },
      ...(scenario === "diff-first" && {
        content: [{ type: "diff", path: "ACP_TEST.md", newText }],
      }),
      ...(scenario === "diff-bad-old" && {
        content: [{ type: "diff", path: "ACP_TEST.md", oldText: 42, newText }],
      }),
      status: "pending",
    });
    const perm = await callClient("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "t2" },
      options: [
        { optionId: "yes", name: "Allow once", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });

    const wrote = perm?.outcome?.optionId === "yes";
    if (wrote) {
      await callClient("fs/write_text_file", {
        sessionId: sid,
        path: "ACP_TEST.md",
        content: "written by the mock agent through the client\n",
      });
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Wrote ACP_TEST.md." },
      });
    } else {
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Write refused by the client policy." },
      });
    }
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t2",
      // A real edit tool reports what it changed here, and `diff` is the only
      // ToolCallContent render.ts draws (the `±` line). Refused writes changed
      // nothing, so they report no content.
      status: "completed",
      ...(wrote
        ? {
            content: [
              {
                type: "diff",
                path: "ACP_TEST.md",
                newText: "written by the mock agent through the client\n",
              },
            ],
          }
        : {}),
    });

    // A harness that offers no way to say no. Every build we measured on
    // 2026-09-02 does offer one (issue #13), so this is the unmeasured case
    // the client must not fail open on: under --mode safe the client answers
    // `cancelled` rather than selecting the first option in the list.
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "t3",
      title: "Delete something, with no reject option offered",
      kind: "delete",
      status: "pending",
    });
    const forced = await callClient("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "t3" },
      options: [
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "once", name: "Allow once", kind: "allow_once" },
      ],
    });
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `\nAllow-only menu answered: ${JSON.stringify(forced?.outcome)}.`,
      },
    });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t3",
      status: "completed",
    });

    // A tool the agent could not complete. Unconditional, so the selftest on
    // its own reaches render.ts's failure branch — no mode, no flag needed.
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "t4",
      title: "Fetch a URL that does not resolve",
      kind: "fetch",
      status: "pending",
    });
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t4",
      status: "failed",
    });

    // Markdown, split mid-line across chunks the way a real harness streams it
    // (M1c-7). `mock-agent.mjs` being too tidy is what hid this bug through
    // M1a, so the message carries the three constructs the story names: a GFM
    // table, a nested list, and a fence with a blank line inside it — the last
    // being the one a naive blank-line rule splits in two.
    for (const chunk of [
      "\n## What I did\n\n| step | result |\n| --- | --- |\n| read",
      " | ok |\n| write | see above |\n\n- checked the file\n  - it par",
      "sed\n  - it was **not** empty\n- reported back\n\n```js\nconst x = 1;\n",
      "\nconst y = 2;\n```\n",
    ]) {
      update(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      });
    }

    // The result block M1b-4's preamble asks for, as a compliant harness
    // sends it: last in the final message, and `<files>` only when the write
    // actually happened — a block that claimed ACP_TEST.md under `safe` would
    // trip the cross-check the client is meant to keep for real disagreement.
    // The non-compliant fixtures are `FINAL_MESSAGE` above (M1b-5).
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text:
          `\n<task-result>\n<status>${wrote ? "success" : "partial"}</status>\n` +
          `<summary>Read package.json and ${wrote ? "wrote" : "was refused"} ACP_TEST.md.</summary>\n` +
          `<details>Exercised the read, permission and write paths of the client.</details>\n` +
          (wrote ? "<files>ACP_TEST.md</files>\n" : "") +
          `</task-result>\n`,
      },
    });

    update(sid, { sessionUpdate: "usage_update", used: 1234, size: 200000 });
    reply(msg.id, { stopReason: "end_turn", usage: USAGE });
  }
});
