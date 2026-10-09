/**
 * Run, room, task and participant ids, and branch names — story M1a-8,
 * issue #16; rooms since M6-0 (#144) and M6-2 (#146).
 *
 * The strings the rest of the system agrees on: `runId` names a run and
 * `taskId` a task inside it; `roomId` names a room and a participant id one
 * participant inside it. The branch that carries the work is built from an
 * owner (run or room) and a unit (task or participant).
 * `<stateDirFor(root)>/wt/<ownerId>/<unitId>` is a filesystem path and
 * `kapelle/<ownerId>/<unitId>` is a git ref, so these ids have to be legal in
 * both places before anything is created.
 *
 * **Validation never sanitises** (`docs/STORIES.md:708`). The id in the run
 * file is the id in the path and in the ref; rewriting a bad id here would
 * make the run file lie about what is on disk. So a bad id throws, and it
 * throws at validation time rather than at `git branch` time — after the
 * worktree already exists.
 *
 * **The charset excludes `.`** (amendment #62 B1, `docs/STORIES.md:702`).
 * `plan..impl`, `impl.` and `build.lock` are all illegal git refs and all
 * passed the original `[a-z0-9._-]`. Dropping one character closes all three.
 *
 * Merge finds a run's branches by reading the run's persisted record, never
 * by rebuilding names from these functions (`docs/STORIES.md:700`) — a
 * rebuilt name cannot know about a branch the user renamed.
 */

/** `^[a-z0-9][a-z0-9_-]{0,63}$` — lowercase because a ref that differs only
 *  by case is two refs on Linux and one on macOS. */
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The shape `newRunId` mints. `branchName` checks against it because merge
 *  takes a run id from the command line — `kapelle merge <runId>` — so a
 *  run id is user input, not only something we minted. */
const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-z]{4}$/;

/** `YYYYMMDD-HHMMSS-<4 char base36>`, UTC. UTC rather than local time so the
 *  ids still sort chronologically across a DST fallback. The suffix is
 *  collision avoidance within one second, not a secret. */
export function newRunId(now: Date = new Date()): string {
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replaceAll("-", "");
  const time = iso.slice(11, 19).replaceAll(":", "");
  const suffix = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${date}-${time}-${suffix}`;
}

/** A room id is a run id behind a `room-` prefix (S9): same stamp, same sort
 *  order, but never mistakable for a run on disk, in a branch name or in
 *  `children.json`. `assertRunId` rejects one, which is what stops
 *  `kapelle merge <id>` reaching into a room's branches. */
const ROOM_ID_PATTERN = /^room-\d{8}-\d{6}-[0-9a-z]{4}$/;

export function newRoomId(now: Date = new Date()): string {
  return `room-${newRunId(now)}`;
}

/** A participant id: `p-` and 8 base36 characters. Opaque, so a rename
 *  never moves it (R10), and a legal task id, so M6-6a can name the
 *  participant's branch `kapelle/<roomId>/<participantId>` with
 *  `branchName`. Unique within one room is all it needs to be. */
export function newParticipantId(): string {
  const suffix = Math.floor(Math.random() * 36 ** 8)
    .toString(36)
    .padStart(8, "0");
  return `p-${suffix}`;
}

/**
 * A run id **or** a room id — the two things that own a branch namespace and
 * a worktree directory. `core/worktree.ts` serves both, so it validates here
 * rather than against either vocabulary alone.
 */
function assertOwnerId(id: string): string {
  if (RUN_ID_PATTERN.test(id) || ROOM_ID_PATTERN.test(id)) return id;
  throw new Error(
    `invalid run or room id ${JSON.stringify(id)}: must match ` +
      `${RUN_ID_PATTERN.source} or ${ROOM_ID_PATTERN.source}`,
  );
}

/** Returns the id unchanged, or throws naming both the id and the rule. */
export function assertRunId(id: string): string {
  if (!RUN_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid run id ${JSON.stringify(id)}: must match ${RUN_ID_PATTERN.source} ` +
        `(YYYYMMDD-HHMMSS-<4 char base36>)`,
    );
  }
  return id;
}

/** Returns the id unchanged, or throws naming both the id and the rule. */
export function assertTaskId(id: string): string {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid task id ${JSON.stringify(id)}: must match ${TASK_ID_PATTERN.source} ` +
        `(1-64 chars; lowercase letters and digits, plus '_' and '-' after ` +
        `the first character; no dots)`,
    );
  }
  return id;
}

/** The namespace every task branch hangs under. One definition, matching
 *  `STATE_DIR` in `core/worktree.ts`: both name the tool on the user's disk,
 *  and a run whose directory and branches disagree reads as two tools. */
const BRANCH_PREFIX = "kapelle";

/** The folder of refs every branch of one run or room hangs under, with
 *  its trailing `/`. A room delete lists its branches by it (#235). */
export function branchPrefix(ownerId: string): string {
  return `${BRANCH_PREFIX}/${assertOwnerId(ownerId)}/`;
}

/** The branch a task's or a participant's work lands on. Validates **both**
 *  halves, so no caller can build a ref that `git check-ref-format` would
 *  reject. */
export function branchName(ownerId: string, taskId: string): string {
  return `${branchPrefix(ownerId)}${assertTaskId(taskId)}`;
}
