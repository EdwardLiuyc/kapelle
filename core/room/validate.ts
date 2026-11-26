/**
 * Room request validation (M12-8a).
 *
 * Names are unique under ASCII case folding (R22), and at most one
 * participant is the orchestrator (R44). The same checks apply to a starter
 * list, an add and a change; a clash is a `RoomRefusal`.
 */

import {
  type ClientMode,
  type ResolvedAgent,
  resolveAgent,
} from "../../protocol/registry.ts";
import { resolvePolicy } from "../policy.ts";
import {
  type AgentRequest,
  MODES,
  type ParticipantChanges,
  ROLES,
  type Role,
  RoomRefusal,
  type Settings,
} from "./types.ts";

/** R22: ASCII on purpose, so the first word of an `@name` message is always
 *  the whole name, and Unicode case folding cannot make two names one.
 *  Because a name is ASCII, `toLowerCase` is ASCII case folding here. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** The harness `agent` or `cmd` names, or a throw naming what is wrong. */
function roomHarness(agent: unknown, cmd: unknown): ResolvedAgent {
  // A field that is present must be a string, as for `name`: a `7` or a
  // `null` is a bad value, not a missing one.
  const str = (field: string, v: unknown) => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v) {
      throw new Error(`"${field}" must be a non-empty string`);
    }
    return v;
  };
  const byName = str("agent", agent);
  const byCmd = str("cmd", cmd);
  if (!byName && !byCmd) throw new Error('an agent needs "agent" or "cmd"');
  return resolveAgent(byName ?? "", byCmd);
}

/** The ceiling check `resolvePolicy` owns: a mode above the harness's
 *  `maxMode` is refused, never run more contained than asked. */
export function checkCeiling(spec: ResolvedAgent, mode: ClientMode) {
  resolvePolicy({
    run: { mode },
    harness: { name: spec.name, maxMode: spec.maxMode },
  });
}

/** The fields one agent takes, at `POST /rooms` and at
 *  `POST /rooms/:id/agents`. */
export const AGENT_FIELDS: readonly string[] = [
  "agent",
  "cmd",
  "name",
  "role",
  "mode",
  "base",
  "settings",
  "model",
  "thoughtLevel",
  "cwd",
];

/** A name, or a throw naming what is wrong. `fallback` is the harness name
 *  an add uses when the request gave none. */
function checkName(name: unknown, fallback?: string): string {
  // `=== undefined`, not `??`: a JSON `null` is a bad name, not a missing one.
  const chosen = name === undefined ? fallback : name;
  if (typeof chosen !== "string" || !NAME_PATTERN.test(chosen)) {
    throw new Error(
      `invalid agent name ${JSON.stringify(chosen)}: must match ` +
        `${NAME_PATTERN.source}` +
        (name === undefined ? '; give the agent a "name"' : ""),
    );
  }
  return chosen;
}

function checkRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) {
    throw new Error(
      `invalid role ${JSON.stringify(role)}: one of ${ROLES.join(", ")}`,
    );
  }
  return role as Role;
}

function checkMode(mode: unknown): ClientMode {
  if (!MODES.includes(mode as ClientMode)) {
    throw new Error(
      `invalid mode ${JSON.stringify(mode)}: one of ${MODES.join(", ")}`,
    );
  }
  return mode as ClientMode;
}

function checkSettings(raw: unknown): Settings {
  if (raw === undefined) return { allowReadOutsideRoot: false };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('"settings" must be an object');
  }
  const extra = Object.keys(raw).find((key) => key !== "allowReadOutsideRoot");
  if (extra !== undefined) {
    throw new Error(
      `unknown setting "${extra}"; "settings" takes allowReadOutsideRoot`,
    );
  }
  const { allowReadOutsideRoot = false } = raw as Record<string, unknown>;
  if (typeof allowReadOutsideRoot !== "boolean") {
    throw new Error('"allowReadOutsideRoot" must be true or false');
  }
  return { allowReadOutsideRoot };
}

/** The refusal a name or role meets among `others`, or undefined (R22,
 *  R44). */
export function clash(
  others: Iterable<{ name: string; role?: Role | undefined }>,
  next: { name?: string | undefined; role?: Role | null | undefined },
): RoomRefusal | undefined {
  for (const other of others) {
    if (next.name?.toLowerCase() === other.name.toLowerCase()) {
      return new RoomRefusal(
        "name_taken",
        `the name "${next.name}" is taken by "${other.name}"`,
      );
    }
    if (next.role === "orchestrator" && other.role === "orchestrator") {
      return new RoomRefusal(
        "orchestrator_exists",
        `"${other.name}" is already the orchestrator; change its role first`,
      );
    }
  }
  return undefined;
}

/** One agent of a request body, checked, or a throw naming what is wrong. */
export function roomAgent(entry: unknown): AgentRequest {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("an agent must be an object");
  }
  const extra = Object.keys(entry).find((key) => !AGENT_FIELDS.includes(key));
  if (extra !== undefined) {
    throw new Error(
      `unknown agent field "${extra}"; an agent takes ${AGENT_FIELDS.join(", ")}`,
    );
  }
  const {
    agent,
    cmd,
    name,
    role,
    mode,
    base,
    settings,
    model,
    thoughtLevel,
    cwd,
  } = entry as Record<string, unknown>;
  const spec = roomHarness(agent, cmd);
  const request: AgentRequest = {
    spec,
    // `cmd` wins when both are given, as `resolveAgent` has it.
    source: cmd ? { cmd: cmd as string } : { agent: agent as string },
    name: checkName(name, spec.name),
    // R12: `auto` by default, so an unattended room never waits on a person.
    mode: mode === undefined ? "auto" : checkMode(mode),
    settings: checkSettings(settings),
  };
  checkCeiling(spec, request.mode);
  if (role !== undefined) request.role = checkRole(role);
  if (base !== undefined) {
    if (typeof base !== "string" || !base) {
      throw new Error('"base" must be a non-empty string');
    }
    request.base = base;
  }
  if (cwd !== undefined) {
    if (typeof cwd !== "string" || !cwd) {
      throw new Error('"cwd" must be a non-empty string');
    }
    request.cwd = cwd;
  }
  // Any id: the harness checks it, not a list of ours (D3).
  if (model !== undefined) request.model = idField("model", model);
  // Checked against the list once the session is up (M9-9).
  if (thoughtLevel !== undefined) {
    request.thoughtLevel = idField("thoughtLevel", thoughtLevel);
  }
  return request;
}

/** A model or level id: a non-empty string, or a throw. */
function idField(field: string, v: unknown): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return v;
}

/**
 * The `agents` of a `POST /rooms` body, checked, or a throw naming what is
 * wrong. Split from `openRoom` so the daemon can answer a bad request before
 * it touches the repository. A name or role that clashes inside the list is
 * a `RoomRefusal`, as it would be at add.
 */
export function roomAgents(raw: unknown): AgentRequest[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('"agents" must be a list');
  const requests: AgentRequest[] = [];
  for (const entry of raw) {
    const request = roomAgent(entry);
    const refused = clash(requests, request);
    if (refused) throw refused;
    requests.push(request);
  }
  return requests;
}

/** A `PATCH /rooms/:id/agents/:agentId` body, checked. */
export function participantChanges(
  body: Record<string, unknown>,
): ParticipantChanges {
  const { name, mode, role, model, thoughtLevel } = body;
  if (
    name === undefined &&
    mode === undefined &&
    role === undefined &&
    model === undefined &&
    thoughtLevel === undefined
  ) {
    throw new Error(
      'send at least one of "name", "mode", "role", "model" or "thoughtLevel"',
    );
  }
  const changes: ParticipantChanges = {};
  if (mode !== undefined) changes.mode = checkMode(mode);
  if (name !== undefined) changes.name = checkName(name);
  if (role !== undefined) changes.role = role === null ? null : checkRole(role);
  // As at add: any id, which the harness checks (D3).
  if (model !== undefined) changes.model = idField("model", model);
  // The room checks it against the live list (M9-9).
  if (thoughtLevel !== undefined) {
    changes.thoughtLevel = idField("thoughtLevel", thoughtLevel);
  }
  return changes;
}
