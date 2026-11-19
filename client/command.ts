/**
 * Room and roster commands (M4-5): what a person types in the composer, and
 * the one route each command calls.
 *
 * **Both screens and the pop-up forms go through here**, so they cannot
 * differ (S8). `parseCommand` turns typed text into a `Command`; a form
 * builds the same `Command` from its fields; `runCommand` sends the routes it
 * names.
 *
 * **A participant command starts with `@name`**, as a message does (R43):
 * `@bob /mode ask`. With no mention it is refused, and never falls back to
 * the orchestrator, so a bare `/remove` cannot drop it. Room commands
 * (`/new`, `/add`, `/chat`, `/loop`, `/title`, `/cap`, `/dismiss`,
 * `/delete`, `/leave`, `/help`, `/term`, `/setup`, `/config`) ignore a
 * mention, so they work after a thread's pre-filled `@name`.
 *
 * **`/chat` starts a chat** (M11-1, decided 2026-11-19): an agent added to
 * the hall, from any view. The hall is hidden, so its agents show as
 * chats. `/add` in one refuses and names `/chat`; `/title` and `/cap` refuse
 * because a chat has no room title or orchestrator cap to change.
 *
 * **`/config` is always a form** (M10-5): the project config of the room on
 * screen, or of the folder the chat started in. A hall chat has no project,
 * so `/config` refuses there (M11-1). Its save is the `config` route command,
 * the changed keys only (`client/config.ts`).
 *
 * **`/loop` is `/new` with a start** (M8-5): a room titled
 * `<recipe>-<task>`, the orchestrator `po` in `auto`, and its first message
 * from `client/loop.ts`. `kapelle loop` builds the same command with
 * `loopCommand`, so the CLI and both screens cannot differ. A `--model` the
 * orchestrator is not confirmed on sends no start (M9-5c): it would work at
 * once on another model. The room stays, as for `kapelle room add`.
 *
 * **The screen never guesses** (M4-5). A value the daemon checks (a role, a
 * mode, a harness) is sent as typed, and a refusal is the daemon's own
 * `message`. Only the shape of the line is checked here.
 *
 * Only a known verb is a command. `/usr/bin is slow` is a message, as it was
 * before M4-5.
 *
 * Quotes go around a value, not the whole option: `--cmd "node x.mjs"`.
 * `--cmd="node x.mjs"` splits at the space.
 */

import { parseArgs } from "node:util";

import { CONFIG_APPLIES, type ConfigPatch } from "./config.ts";
import type {
  ConfigView,
  DeletePreview,
  MessageAccepted,
  ParticipantDto,
  RoomDto,
} from "./contract.ts";
import { call, type DaemonAddress, type Reply } from "./daemon.ts";
import { absoluteFolder, FOLDER_GONE } from "./folder.ts";
import { loopMessage } from "./loop.ts";
import { fold, MENTION, type Named, targetOf } from "./mention.ts";
import { printable } from "./room.ts";

/** One agent, as `POST /rooms` and `POST /rooms/:id/agents` take it. A
 *  `base` of `@name` is that participant's branch, looked up at send. */
interface AgentSpec {
  agent?: string;
  cmd?: string;
  name?: string;
  role?: string;
  mode?: string;
  base?: string;
  /** The harness checks the id (M9-5); the screen sends it as typed. */
  model?: string;
}

/** A `POST /rooms` body. */
interface NewRoom {
  cwd: string;
  title?: string;
  agents?: AgentSpec[];
}

/** The hall's id: `docs/CLIENT-API.md` § The hall. */
export const HALL_ID = "hall";

/** A command that calls a route. */
export type RouteCommand =
  | { verb: "new"; body: NewRoom }
  | { verb: "chat"; agent: AgentSpec }
  | { verb: "loop"; body: NewRoom; recipe: string; task: string; note?: string }
  | { verb: "add"; agent: AgentSpec }
  | { verb: "dismiss" }
  | { verb: "delete" }
  | { verb: "title"; title: string }
  | { verb: "cap"; turnCap: number }
  | { verb: "config"; cwd: string; patch: ConfigPatch }
  | { verb: "remove" | "cancel"; id: string; name: string }
  | {
      verb: "forward";
      id: string;
      name: string;
      fromId: string;
      fromName: string;
    }
  | {
      verb: "patch";
      id: string;
      name: string;
      change: {
        name?: string;
        role?: string | null;
        mode?: string;
        model?: string;
        thoughtLevel?: string;
      };
    };

/** What a typed line is: a command, a form to open (a bare `/new`, `/add`,
 *  `/chat`, `/loop`, or `/config`), what an agent changed (`/diff`, M4-6),
 *  the person's shell (`/term`, M4-13), the installed agents (`/setup`,
 *  M9-3), or a line that is refused before any request. */
export type Command =
  | RouteCommand
  | { verb: "leave" }
  | { verb: "help" }
  | { verb: "term" }
  | { verb: "setup"; done: boolean }
  | { verb: "form"; form: "new" | "add" | "chat" | "loop" | "config" }
  | { verb: "diff"; id: string; name: string; against: "head" | "base" }
  | { verb: "models"; id: string; name: string }
  | { verb: "levels"; id: string; name: string }
  | {
      verb: "ff";
      id: string;
      name: string;
      from: { id: string; name: string };
    };

export const HELP = [
  "/new [harness] [--cmd c] [--name n] [--model id] [--title t] [--cwd dir]",
  "/add <harness> [--cmd c] [--name n] [--role r] [--mode m] [--model id] [--base @name|ref]",
  "/chat <harness> [--cmd c] [--name n] [--mode m] [--model id]",
  '/loop <recipe> <task> ["note"] [--agent h] [--cmd c] [--model id] [--cwd dir]',
  "/title <new title>",
  "/cap <n>",
  "@name /rename <new name>",
  "@name /role <role|none>",
  "@name /mode <ask|safe|auto>",
  "@name /model [id]",
  "@name /level [id]",
  "@name /cancel",
  "@name /remove",
  "@name /diff [base]",
  "@name /ff --from @name",
  "/setup [done]   /config   /term   /dismiss   /delete   /leave   /help",
  "/new, /add, /chat and /loop alone open forms, as /config does; ctrl+o opens the menu",
];

export const USAGE: Record<string, string> = {
  new: HELP[0] as string,
  add: HELP[1] as string,
  chat: HELP[2] as string,
  loop: HELP[3] as string,
  title: "usage: /title <new title>",
  cap: "usage: /cap <n>",
  rename: "usage: @name /rename <new name>",
  role: "usage: @name /role <role|none>",
  mode: "usage: @name /mode <ask|safe|auto>",
  model: "usage: @name /model [id]",
  level: "usage: @name /level [id]",
  cancel: "usage: @name /cancel",
  remove: "usage: @name /remove",
  diff: "usage: @name /diff [base]",
  ff: "usage: @name /ff --from @name",
  setup: "usage: /setup [done]",
  config: "usage: /config",
};

const ROOM_VERBS = new Set([
  "new",
  "add",
  "chat",
  "loop",
  "title",
  "cap",
  "dismiss",
  "delete",
  "leave",
  "help",
  "term",
  "setup",
  "config",
]);
const AGENT_VERBS = new Set([
  "rename",
  "role",
  "mode",
  "model",
  "level",
  "cancel",
  "remove",
  "diff",
  "ff",
]);

/** The orchestrator's name in a loop's room. */
const ORCHESTRATOR = "po";

/**
 * A loop's start (M8-5) as a command: the room titled `<recipe>-<task>`, and
 * the orchestrator in `auto`, on claude unless `agent` or `cmd` names
 * another harness, and on `model` when one is given. The recipe is read when
 * the command runs, not here.
 * The task and the note are trimmed here, once, so `kapelle loop` and
 * `/loop` send the same; a blank note is none.
 */
export function loopCommand(o: {
  recipe: string;
  task: string;
  note?: string | undefined;
  agent?: string | undefined;
  cmd?: string | undefined;
  model?: string | undefined;
  cwd: string;
}): Extract<RouteCommand, { verb: "loop" }> {
  const task = o.task.trim();
  const note = o.note?.trim();
  const harness = {
    ...(o.cmd
      ? { ...(o.agent && { agent: o.agent }), cmd: o.cmd }
      : { agent: o.agent || "claude" }),
    ...(o.model && { model: o.model }),
  };
  return {
    verb: "loop",
    recipe: o.recipe,
    task,
    ...(note && { note }),
    body: {
      cwd: o.cwd,
      title: `${o.recipe}-${task}`,
      agents: [
        { ...harness, name: ORCHESTRATOR, role: "orchestrator", mode: "auto" },
      ],
    },
  };
}

/** Words, with `"…"` or `'…'` keeping spaces: `--cmd "node x.mjs"`. */
const words = (s: string) =>
  [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );

/** Options and positionals, or the reason they do not parse. */
function options(
  args: string[],
  names: string[],
):
  | { values: Record<string, string | undefined>; positionals: string[] }
  | {
      error: string;
    } {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        names.map((n) => [n, { type: "string" as const }]),
      ),
    });
    return {
      values: values as Record<string, string | undefined>,
      positionals,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** `/add` in a chat: the hall is no room to add to (M11-1). */
export const ADD_IN_CHAT = "a chat is no room: use /chat for a new agent";

/** `/title` and `/cap` in a chat (M11-1, #517): the hidden hall is no room to edit. */
const TITLE_IN_CHAT = "a chat is no room: /title needs a room";
const CAP_IN_CHAT = "a chat is no room: /cap needs a room";

/** A chat route that finds no hall (M11-1, #518). The daemon's log says why
 *  it is missing: its record may be unreadable, fail a check, or not open. */
export const NO_HALL = "the daemon has no hall; check the daemon's log for why";

/** `/config` in a chat: the hall folder is no project (M11-1). */
export const HALL_NO_CONFIG = "the hall has no project config: attach a room";

/**
 * The command a typed line is, or `undefined` for a message. `{ error }` is
 * a command refused before any request; the screen shows it and gives the
 * text back. `hall` is the `hall` flag of the room on screen.
 */
export function parseCommand(
  input: string,
  roster: readonly Named[],
  hall = false,
): Command | { error: string } | undefined {
  const text = input.trim();
  const m = MENTION.exec(text);
  const rest = m ? text.slice(m[0].length) : text;
  const [head = "", ...args] = words(rest);
  if (!head.startsWith("/")) return undefined;
  const verb = head.slice(1);
  if (!ROOM_VERBS.has(verb) && !AGENT_VERBS.has(verb)) return undefined;

  // A chat has no visible room title and no orchestrator cap (#517).
  if (hall && verb === "title") return { error: TITLE_IN_CHAT };
  if (hall && verb === "cap") return { error: CAP_IN_CHAT };

  if (
    verb === "leave" ||
    verb === "dismiss" ||
    verb === "delete" ||
    verb === "help" ||
    verb === "term"
  ) {
    // Exact, as before M4-5: `/dismiss the old plan` is a message.
    return args.length ? undefined : { verb };
  }
  if (verb === "setup") {
    // `/setup done` says "done" without the list.
    if (args.length > 1 || (args[0] !== undefined && args[0] !== "done")) {
      return { error: USAGE.setup as string };
    }
    return { verb, done: args[0] === "done" };
  }
  if (verb === "config") {
    return args.length
      ? { error: USAGE.config as string }
      : { verb: "form", form: "config" };
  }
  if (verb === "title") {
    // The rest of the line: spaces inside a title stay. One pair of quotes
    // around the whole title, with no such quote inside, is quoting.
    const raw = rest.trimStart().slice(head.length).trim();
    const quoted = /^(["'])((?:(?!\1)[\s\S])*)\1$/.exec(raw);
    const title = (quoted?.[2] ?? raw).trim();
    return title ? { verb, title } : { error: USAGE.title as string };
  }
  if (verb === "cap") {
    if (args.length !== 1) return { error: USAGE.cap as string };
    const turnCap = Number(args[0]);
    return Number.isFinite(turnCap)
      ? { verb, turnCap }
      : { error: USAGE.cap as string };
  }
  if (verb === "loop") {
    if (!args.length) return { verb: "form", form: "loop" };
    const o = options(args, ["agent", "cmd", "model", "cwd"]);
    if ("error" in o) return { error: `${o.error}; usage: ${USAGE.loop}` };
    const [recipe, task, note, ...extra] = o.positionals;
    // An empty model is a usage error, as in `kapelle loop` (M9-5c).
    if (!recipe || !task?.trim() || extra.length || o.values.model === "")
      return { error: `usage: ${USAGE.loop}` };
    const cwd = absoluteFolder(o.values.cwd);
    if (!cwd) return { error: FOLDER_GONE };
    return loopCommand({ ...o.values, recipe, task, note, cwd });
  }
  if (verb === "add" && hall) return { error: ADD_IN_CHAT };
  if (verb === "new" || verb === "add" || verb === "chat") {
    if (!args.length) return { verb: "form", form: verb };
    const names =
      verb === "new"
        ? ["cmd", "name", "model", "title", "cwd"]
        : verb === "chat"
          ? ["cmd", "name", "mode", "model"]
          : ["cmd", "name", "role", "mode", "model", "base"];
    const o = options(args, names);
    if ("error" in o) return { error: `${o.error}; ${USAGE[verb]}` };
    // Typed empty models are usage errors; forms keep empty as no model (#466).
    if (o.values.model === "") return { error: USAGE[verb] as string };
    const [agent, ...extra] = o.positionals;
    if (extra.length) return { error: `one harness only; ${USAGE[verb]}` };
    const { cmd, name, title, cwd, role, mode, base, model } = o.values;
    if (verb === "chat") {
      return { verb, agent: { agent, cmd, name, mode, model } };
    }
    if (verb === "add") {
      // `none` is no role, as in `@name /role none` and the form.
      const spec: AgentSpec = {
        agent,
        cmd,
        name,
        role: role === "none" ? undefined : role,
        mode,
        model,
        base,
      };
      return { verb, agent: spec };
    }
    if (!agent && !cmd && (name || model)) {
      const flag = name ? "--name" : "--model";
      return { error: `${flag} needs a harness or --cmd; ${USAGE.new}` };
    }
    const folder = absoluteFolder(cwd);
    if (!folder) return { error: FOLDER_GONE };
    return {
      verb,
      body: {
        cwd: folder,
        title,
        agents:
          agent || cmd ? [{ agent, cmd, name, model, role: "developer" }] : [],
      },
    };
  }

  if (!m) return { error: `name the agent: @name /${verb}` };
  const t = targetOf(text, roster);
  if ("error" in t) return t;
  const target = roster.find((p) => p.id === t.id);
  const name = target?.name ?? t.id;
  const id = t.id;
  if (verb === "ff") {
    const o = options(args, ["from"]);
    if ("error" in o) return { error: `${o.error}; ${USAGE.ff}` };
    const [extra, ...more] = o.positionals;
    const source = o.values.from;
    if (extra !== undefined || more.length > 0 || !source?.startsWith("@")) {
      return { error: USAGE.ff as string };
    }
    const wanted = fold(source.slice(1));
    const from = roster.find((p) => fold(p.name) === wanted);
    if (!from) return { error: `no participant named ${source}` };
    return {
      verb: "ff",
      id,
      name,
      from: { id: from.id, name: from.name },
    };
  }
  if (verb === "diff") {
    // What is not committed, or with `base` the whole branch.
    if (args.length > 1 || (args[0] !== undefined && args[0] !== "base")) {
      return { error: USAGE.diff as string };
    }
    return { verb, id, name, against: args[0] ? "base" : "head" };
  }
  if (verb === "cancel" || verb === "remove") {
    return args.length ? { error: USAGE[verb] as string } : { verb, id, name };
  }
  // The live list with no id (M9-6, M9-9).
  if (verb === "model" && !args.length) return { verb: "models", id, name };
  if (verb === "level" && !args.length) return { verb: "levels", id, name };
  if (args.length !== 1) return { error: USAGE[verb] as string };
  const value = args[0] as string;
  const change =
    verb === "rename"
      ? { name: value }
      : verb === "role"
        ? { role: value === "none" ? null : value }
        : verb === "model"
          ? { model: value }
          : verb === "level"
            ? { thoughtLevel: value }
            : { mode: value };
  return { verb: "patch", id, name, change };
}

/** What a route said: a line for the status bar, or the daemon's refusal. */
export type Outcome =
  | { ok: true; line: string; room?: RoomDto; participant?: ParticipantDto }
  | { ok: false; code: string; message: string; room?: RoomDto };

const refused = (message: string, code = "", room?: RoomDto): Outcome => ({
  ok: false,
  code,
  message,
  ...(room && { room }),
});

/** What `DELETE /rooms/:id` would remove from git (since 1.15). */
export const deletePreview = (
  d: DaemonAddress,
  roomId: string,
): Promise<Reply<DeletePreview>> =>
  call<DeletePreview>(d, `/rooms/${roomId}/delete-preview`);

/** The preview as rows both screens can draw. A branch says `all merged`
 *  when the delete would not make any of its commits unreachable. */
export function deletePreviewLines(preview: DeletePreview): string[] {
  if (preview.branches.length === 0)
    return ["no room-owned branches would be removed"];
  return preview.branches.flatMap((b) => {
    const who = b.participant
      ? printable(b.participant)
      : "no current participant";
    const n = b.total;
    const state =
      n === 0 ? "all merged" : `${n} unmerged commit${n === 1 ? "" : "s"}`;
    const more = b.total - b.commits.length;
    return [
      `${state} · ${who}`,
      `  ${printable(b.branch)}`,
      ...b.commits.map(
        (commit) => `  ${commit.sha.slice(0, 8)} ${printable(commit.subject)}`,
      ),
      ...(more > 0
        ? [`  … and ${more} more commit${more === 1 ? "" : "s"}`]
        : []),
    ];
  });
}

/** An agent spec as the daemon takes it: empty fields left out, and a
 *  `base` of `@name` turned into that participant's branch. */
async function agentBody(
  d: DaemonAddress,
  roomId: string,
  a: AgentSpec,
): Promise<{ body: Record<string, string> } | Outcome> {
  const body = Object.fromEntries(
    Object.entries(a).filter(([, v]) => v !== undefined && v !== ""),
  ) as Record<string, string>;
  if (!body.base?.startsWith("@")) return { body };
  const r = await call<RoomDto>(d, `/rooms/${roomId}`);
  if (!r.ok) return refused(r.error.message, r.error.code);
  const want = fold(body.base.slice(1));
  const p = r.body.participants.find((q) => fold(q.name) === want);
  if (!p) return refused(`no participant named ${body.base}`);
  if (!p.branch) return refused(`${p.name} has no branch to start from`);
  body.base = p.branch;
  return { body };
}

/** Whether the reply confirms the model asked for. Asking for none is
 *  always confirmed; asking for one needs the participant's matching model. */
export const modelConfirmed = (
  asked: string | undefined,
  p: ParticipantDto | undefined,
): boolean => !asked || asked === p?.model;

/** Why a model did not land, the same words for `kapelle room add` and
 *  `/loop` (M9-5b, M9-5c): the model asked for, then the one in use or none. */
export const notConfirmedOn = (
  asked: string | undefined,
  p: ParticipantDto | undefined,
) =>
  `is not confirmed on the model "${asked}"; ${p?.model ? `it runs on "${p.model}"` : "it has no model"}`;

/** A model the reply does not confirm still adds the agent (M9-5): the
 *  line says so at once. It claims neither why nor what runs: a set that
 *  timed out may still apply, and a harness may rename the id. The room's
 *  notice says both, the one place that saw them. */
const notOn = (asked: string | undefined, p: ParticipantDto | undefined) =>
  modelConfirmed(asked, p) ? "" : `; ! not confirmed on the model "${asked}"`;

/** What `@name /model <id>` did (M9-6). An idle harness answered before
 *  the reply; a busy one, or one with no harness, hears of it later. As
 *  `notOn`, the line never says why a model is not in use: the room's
 *  notice does. */
function modelChanged(name: string, asked: string, p: ParticipantDto) {
  if (asked === p.model) return `${name} now runs on the model "${asked}"`;
  if (p.status === "busy") {
    return `${name} gets the model "${asked}" before its next turn`;
  }
  if (p.status !== "idle") {
    return `${name} gets the model "${asked}" when it starts again`;
  }
  return `! ${name} is not confirmed on the model "${asked}"`;
}

/** What `@name /level <id>` did (M9-9), as `modelChanged`. The daemon
 *  refused an unlisted level already, so a level not in use here waits, or
 *  was refused by the harness, which the room's notice says. */
function levelChanged(name: string, asked: string, p: ParticipantDto) {
  if (asked === p.thoughtLevel) {
    return `${name} now thinks at the level "${asked}"`;
  }
  if (p.status === "busy") {
    return `${name} gets the thinking level "${asked}" before its next turn`;
  }
  if (p.status !== "idle") {
    return `${name} gets the thinking level "${asked}" when it starts again`;
  }
  return `! ${name} is not confirmed on the thinking level "${asked}"`;
}

/** One participant as the daemon has it now: its live models for
 *  `@name /model` (M9-6). A refusal is the daemon's own message. */
export async function participantNow(
  d: DaemonAddress,
  roomId: string,
  id: string,
): Promise<{ ok: true; p: ParticipantDto } | { ok: false; message: string }> {
  const r = await call<ParticipantDto>(d, `/rooms/${roomId}/agents/${id}`);
  return r.ok
    ? { ok: true, p: r.body }
    : { ok: false, message: r.error.message };
}

/** `@name /model` as lines: the model in use, then the live list, the one
 *  in use marked. A participant with no harness running has no list. */
export function modelLines(p: ParticipantDto): string[] {
  if (!p.models?.length) {
    const on = p.model ? `; it runs on "${p.model}"` : "";
    return [
      printable(
        p.status === "idle" || p.status === "busy"
          ? `${p.name} lists no models${on}`
          : `${p.name} has no harness running; its list shows after its next start`,
      ),
    ];
  }
  return [
    printable(
      p.model ? `${p.name} runs on "${p.model}"` : `${p.name}'s models`,
    ),
    ...p.models.map((m) =>
      printable(
        `${m.id === p.model ? "*" : " "} ${m.id}${m.name && m.name !== m.id ? `  ${m.name}` : ""}`,
      ),
    ),
    `@${printable(p.name)} /model <id> picks one`,
  ];
}

/** `@name /level` as lines (M9-9), as `modelLines`: the level in use,
 *  then the model's levels, the one in use marked. */
export function levelLines(p: ParticipantDto): string[] {
  if (!p.thoughtLevels?.length) {
    return [
      printable(
        p.status === "idle" || p.status === "busy"
          ? `${p.name} has no thinking level${p.model ? ` on the model "${p.model}"` : ""}`
          : `${p.name} has no harness running; its levels show after its next start`,
      ),
    ];
  }
  return [
    printable(
      p.thoughtLevel
        ? `${p.name} thinks at "${p.thoughtLevel}"`
        : `${p.name}'s thinking levels`,
    ),
    ...p.thoughtLevels.map((l) =>
      printable(
        `${l.id === p.thoughtLevel ? "*" : " "} ${l.id}${l.name && l.name !== l.id ? `  ${l.name}` : ""}`,
      ),
    ),
    `@${printable(p.name)} /level <id> picks one`,
  ];
}

/** `POST /rooms/:id/agents`, for `/add` and `/chat`. `did` starts the
 *  line: `added`, or `started a chat with`. */
async function addAgent(
  d: DaemonAddress,
  roomId: string,
  agent: AgentSpec,
  did: string,
): Promise<Outcome> {
  const spec = await agentBody(d, roomId, agent);
  if (!("body" in spec)) return spec;
  const r = await call<ParticipantDto>(d, `/rooms/${roomId}/agents`, {
    method: "POST",
    body: spec.body,
  });
  if (!r.ok) {
    const noHall = roomId === HALL_ID && r.error.code === "room_not_found";
    return refused(noHall ? NO_HALL : r.error.message, r.error.code);
  }
  const p = r.body;
  const role = p.role ? `, ${p.role}` : "";
  const model = p.model ? `, ${p.model}` : "";
  const off = notOn(spec.body.model, p);
  return {
    ok: true,
    line: printable(
      `${did} ${p.name} (${p.harness}${role}, ${p.mode}${model})${off}`,
    ),
    participant: p,
  };
}

/**
 * Sends one command to its route. `roomId` is the room on screen; `/new`
 * needs none. Never throws for a refusal; a daemon that cannot be reached
 * throws as `fetch` does.
 */
export async function runCommand(
  d: DaemonAddress,
  roomId: string | undefined,
  c: RouteCommand,
): Promise<Outcome> {
  if (c.verb === "new") {
    const agents = c.body.agents?.map((a) =>
      Object.fromEntries(Object.entries(a).filter(([, v]) => v)),
    );
    const body = Object.fromEntries(
      Object.entries({ ...c.body, agents }).filter(([, v]) => v),
    );
    const r = await call<RoomDto>(d, "/rooms", { method: "POST", body });
    if (!r.ok) return refused(r.error.message, r.error.code);
    const off = notOn(c.body.agents?.[0]?.model, r.body.participants[0]);
    return {
      ok: true,
      line: printable(`opened room ${r.body.title ?? r.body.id}${off}`),
      room: r.body,
    };
  }
  if (c.verb === "loop") {
    // The recipe first: a missing one opens no room.
    const start = await loopMessage(c, c.body.cwd);
    if ("error" in start) return refused(start.error, "no_recipe");
    const r = await call<RoomDto>(d, "/rooms", {
      method: "POST",
      body: c.body,
    });
    if (!r.ok) return refused(r.error.message, r.error.code);
    const opened = `opened room ${printable(r.body.title ?? r.body.id)}`;
    const asked = c.body.agents?.[0]?.model;
    const po = r.body.participants[0];
    if (!modelConfirmed(asked, po)) {
      return refused(
        `${opened}, but ${ORCHESTRATOR} ` +
          printable(
            `${notConfirmedOn(asked, po)}. The room has no start. To drop the room: kapelle chat dismiss ${r.body.id}`,
          ),
        "model_not_confirmed",
        r.body,
      );
    }
    const sent = await call<MessageAccepted>(
      d,
      `/rooms/${r.body.id}/messages`,
      {
        method: "POST",
        body: { text: start.text },
      },
    );
    if (!sent.ok) {
      return refused(
        `${opened}, but its first message failed: ${sent.error.message}`,
        sent.error.code,
        r.body,
      );
    }
    return {
      ok: true,
      line: `${opened}; ${ORCHESTRATOR} has the start`,
      room: r.body,
    };
  }
  if (c.verb === "config") {
    const keys = Object.keys(c.patch);
    if (!keys.length) return { ok: true, line: "config: nothing changed" };
    const r = await call<ConfigView>(
      d,
      `/config?cwd=${encodeURIComponent(c.cwd)}`,
      { method: "PATCH", body: c.patch },
    );
    if (!r.ok) return refused(r.error.message, r.error.code);
    return {
      ok: true,
      line: printable(
        `saved ${keys.join(", ")} to ${r.body.path}; ${CONFIG_APPLIES}`,
      ),
    };
  }
  // The hall, from any view (M11-1).
  if (c.verb === "chat") {
    return addAgent(d, HALL_ID, c.agent, "started a chat with");
  }
  if (!roomId) return refused("no room: open one first");
  const room = `/rooms/${roomId}`;
  switch (c.verb) {
    case "dismiss": {
      const r = await call<RoomDto>(d, `${room}/dismiss`, { method: "POST" });
      if (!r.ok) return refused(r.error.message, r.error.code);
      return { ok: true, line: `dismissed ${roomId}`, room: r.body };
    }
    case "delete": {
      let r = await call<void>(d, room, { method: "DELETE" });
      let dismissed: RoomDto | undefined;
      if (!r.ok && r.error.code === "room_active") {
        const closed = await call<RoomDto>(d, `${room}/dismiss`, {
          method: "POST",
        });
        if (!closed.ok && closed.error.code !== "room_dismissed") {
          return refused(closed.error.message, closed.error.code);
        }
        if (closed.ok) dismissed = closed.body;
        else {
          const got = await call<RoomDto>(d, room);
          if (got.ok) dismissed = got.body;
        }
        r = await call<void>(d, room, { method: "DELETE" });
      }
      if (!r.ok) return refused(r.error.message, r.error.code, dismissed);
      return { ok: true, line: `deleted ${roomId}` };
    }
    case "title": {
      const r = await call<RoomDto>(d, room, {
        method: "PATCH",
        body: { title: c.title },
      });
      if (!r.ok) return refused(r.error.message, r.error.code);
      return {
        ok: true,
        line: `renamed the room to ${printable(c.title)}`,
        room: r.body,
      };
    }
    case "cap": {
      const r = await call<RoomDto>(d, room, {
        method: "PATCH",
        body: { turnCap: c.turnCap },
      });
      if (!r.ok) return refused(r.error.message, r.error.code);
      return {
        ok: true,
        line: `raised the orchestrator turn cap to ${c.turnCap}`,
        room: r.body,
      };
    }
    case "add":
      return addAgent(d, roomId, c.agent, "added");
    case "remove": {
      const r = await call<RoomDto>(d, `${room}/agents/${c.id}`, {
        method: "DELETE",
      });
      if (!r.ok) return refused(r.error.message, r.error.code);
      return { ok: true, line: `removed ${c.name}` };
    }
    case "cancel": {
      const r = await call<ParticipantDto>(
        d,
        `${room}/agents/${c.id}/turns/current/cancel`,
        { method: "POST" },
      );
      if (!r.ok) return refused(r.error.message, r.error.code);
      return { ok: true, line: `cancelling ${c.name}'s turn` };
    }
    case "forward": {
      const r = await call<ParticipantDto>(
        d,
        `${room}/agents/${c.id}/fast-forward`,
        { method: "POST", body: { from: c.fromId } },
      );
      if (!r.ok) return refused(r.error.message, r.error.code);
      return {
        ok: true,
        line: `moved ${c.name} up to ${c.fromName}'s commit`,
      };
    }
    case "patch": {
      const r = await call<ParticipantDto>(d, `${room}/agents/${c.id}`, {
        method: "PATCH",
        body: c.change,
      });
      if (!r.ok) return refused(r.error.message, r.error.code);
      const { name, role, mode, model, thoughtLevel } = c.change;
      const line =
        name !== undefined
          ? `renamed ${c.name} to ${r.body.name}`
          : role === null
            ? `${c.name} has no role`
            : role !== undefined
              ? `${c.name} is now ${r.body.role}`
              : model !== undefined
                ? modelChanged(c.name, model, r.body)
                : thoughtLevel !== undefined
                  ? levelChanged(c.name, thoughtLevel, r.body)
                  : `${c.name} is now in ${mode} mode`;
      return { ok: true, line: printable(line), participant: r.body };
    }
  }
}
