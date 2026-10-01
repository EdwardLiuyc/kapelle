/**
 * Room and roster commands (M4-5): what a person types in the composer, and
 * the one route each command calls.
 *
 * **Both screens and the pop-up forms go through here**, so they cannot
 * differ (S8). `parseCommand` turns typed text into a `Command`; a form
 * builds the same `Command` from its fields; `runCommand` sends it.
 *
 * **A participant command starts with `@name`**, as a message does (R43):
 * `@bob /mode ask`. With no mention it is refused, and never falls back to
 * the orchestrator, so a bare `/remove` cannot drop it. Room commands
 * (`/new`, `/add`, `/dismiss`, `/leave`, `/help`) ignore a mention, so they
 * work after a thread's pre-filled `@name`.
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

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type { ParticipantDto, RoomDto } from "./contract.ts";
import { call, type DaemonAddress } from "./daemon.ts";
import { expandHome } from "./folder.ts";
import { fold, MENTION, type Named, targetOf } from "./mention.ts";

/** One agent, as `POST /rooms` and `POST /rooms/:id/agents` take it. A
 *  `base` of `@name` is that participant's branch, looked up at send. */
interface AgentSpec {
  agent?: string;
  cmd?: string;
  name?: string;
  role?: string;
  mode?: string;
  base?: string;
}

/** A `POST /rooms` body. */
interface NewRoom {
  cwd: string;
  title?: string;
  agents?: AgentSpec[];
}

/** A command that calls a route. */
export type RouteCommand =
  | { verb: "new"; body: NewRoom }
  | { verb: "add"; agent: AgentSpec }
  | { verb: "dismiss" }
  | { verb: "remove" | "cancel"; id: string; name: string }
  | {
      verb: "patch";
      id: string;
      name: string;
      change: { name?: string; role?: string | null; mode?: string };
    };

/** What a typed line is: a command, a form to open (a bare `/new` or
 *  `/add`), or a line that is refused before any request. */
export type Command =
  | RouteCommand
  | { verb: "leave" }
  | { verb: "help" }
  | { verb: "form"; form: "new" | "add" };

export const HELP = [
  "/new [harness] [--cmd c] [--name n] [--title t] [--cwd dir]",
  "/add <harness> [--cmd c] [--name n] [--role r] [--mode m] [--base @name|ref]",
  "@name /rename <new name>",
  "@name /role <role|none>",
  "@name /mode <ask|safe|auto>",
  "@name /cancel",
  "@name /remove",
  "/dismiss   /leave   /help",
  "/new and /add alone open a form; ctrl+o opens the menu",
];

export const USAGE: Record<string, string> = {
  new: HELP[0] as string,
  add: HELP[1] as string,
  rename: "usage: @name /rename <new name>",
  role: "usage: @name /role <role|none>",
  mode: "usage: @name /mode <ask|safe|auto>",
  cancel: "usage: @name /cancel",
  remove: "usage: @name /remove",
};

const ROOM_VERBS = new Set(["new", "add", "dismiss", "leave", "help"]);
const AGENT_VERBS = new Set(["rename", "role", "mode", "cancel", "remove"]);

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

/**
 * The command a typed line is, or `undefined` for a message. `{ error }` is
 * a command refused before any request; the screen shows it and gives the
 * text back.
 */
export function parseCommand(
  input: string,
  roster: readonly Named[],
): Command | { error: string } | undefined {
  const text = input.trim();
  const m = MENTION.exec(text);
  const rest = m ? text.slice(m[0].length) : text;
  const [head = "", ...args] = words(rest);
  if (!head.startsWith("/")) return undefined;
  const verb = head.slice(1);
  if (!ROOM_VERBS.has(verb) && !AGENT_VERBS.has(verb)) return undefined;

  if (verb === "leave" || verb === "dismiss" || verb === "help") {
    // Exact, as before M4-5: `/dismiss the old plan` is a message.
    return args.length ? undefined : { verb };
  }
  if (verb === "new" || verb === "add") {
    if (!args.length) return { verb: "form", form: verb };
    const names =
      verb === "new"
        ? ["cmd", "name", "title", "cwd"]
        : ["cmd", "name", "role", "mode", "base"];
    const o = options(args, names);
    if ("error" in o) return { error: `${o.error}; ${USAGE[verb]}` };
    const [agent, ...extra] = o.positionals;
    if (extra.length) return { error: `one harness only; ${USAGE[verb]}` };
    const { cmd, name, title, cwd, role, mode, base } = o.values;
    if (verb === "add") {
      // `none` is no role, as in `@name /role none` and the form.
      const spec: AgentSpec = {
        agent,
        cmd,
        name,
        role: role === "none" ? undefined : role,
        mode,
        base,
      };
      return { verb, agent: spec };
    }
    if (!agent && !cmd && name) {
      return { error: `--name needs a harness or --cmd; ${USAGE.new}` };
    }
    return {
      verb,
      body: {
        cwd: resolve(expandHome(cwd ?? process.cwd())),
        title,
        agents:
          agent || cmd ? [{ agent, cmd, name, role: "orchestrator" }] : [],
      },
    };
  }

  if (!m) return { error: `name the agent: @name /${verb}` };
  const t = targetOf(text, roster);
  if ("error" in t) return t;
  const name = roster.find((p) => p.id === t.id)?.name ?? t.id;
  const id = t.id;
  if (verb === "cancel" || verb === "remove") {
    return args.length ? { error: USAGE[verb] as string } : { verb, id, name };
  }
  if (args.length !== 1) return { error: USAGE[verb] as string };
  const value = args[0] as string;
  const change =
    verb === "rename"
      ? { name: value }
      : verb === "role"
        ? { role: value === "none" ? null : value }
        : { mode: value };
  return { verb: "patch", id, name, change };
}

/** What a route said: a line for the status bar, or the daemon's refusal. */
export type Outcome =
  | { ok: true; line: string; room?: RoomDto }
  | { ok: false; code: string; message: string };

const refused = (message: string, code = ""): Outcome => ({
  ok: false,
  code,
  message,
});

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
    return {
      ok: true,
      line: `opened room ${r.body.title ?? r.body.id}`,
      room: r.body,
    };
  }
  if (!roomId) return refused("no room: open one first");
  const room = `/rooms/${roomId}`;
  switch (c.verb) {
    case "dismiss": {
      const r = await call<RoomDto>(d, `${room}/dismiss`, { method: "POST" });
      if (!r.ok) return refused(r.error.message, r.error.code);
      return { ok: true, line: `dismissed ${roomId}`, room: r.body };
    }
    case "add": {
      const spec = await agentBody(d, roomId, c.agent);
      if (!("body" in spec)) return spec;
      const r = await call<ParticipantDto>(d, `${room}/agents`, {
        method: "POST",
        body: spec.body,
      });
      if (!r.ok) return refused(r.error.message, r.error.code);
      const p = r.body;
      const role = p.role ? `, ${p.role}` : "";
      return {
        ok: true,
        line: `added ${p.name} (${p.harness}${role}, ${p.mode})`,
      };
    }
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
    case "patch": {
      const r = await call<ParticipantDto>(d, `${room}/agents/${c.id}`, {
        method: "PATCH",
        body: c.change,
      });
      if (!r.ok) return refused(r.error.message, r.error.code);
      const { name, role, mode } = c.change;
      const line =
        name !== undefined
          ? `renamed ${c.name} to ${r.body.name}`
          : role === null
            ? `${c.name} has no role`
            : role !== undefined
              ? `${c.name} is now ${r.body.role}`
              : `${c.name} is now in ${mode} mode`;
      return { ok: true, line };
    }
  }
}
