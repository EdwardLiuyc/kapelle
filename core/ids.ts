/**
 * Run ids, task ids and branch names — story M1a-8, issue #16.
 *
 * Three strings the rest of the system agrees on: `runId` names a run,
 * `taskId` names a task inside it, and the branch that carries a task's work
 * is built from both. `.agent-team/wt/<runId>/<taskId>` is a filesystem path
 * and `agent-team/<runId>/<taskId>` is a git ref, so these ids have to be
 * legal in both places before anything is created.
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

/** Returns the id unchanged, or throws naming both the id and the rule. */
export function assertTaskId(id: string): string {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid task id ${JSON.stringify(id)}: must match ${TASK_ID_PATTERN.source} ` +
        `(lowercase letters, digits, '_' and '-'; no dots; 1-64 chars)`,
    );
  }
  return id;
}

/** The branch a task's work lands on. Validates, so no caller can build a ref
 *  that `git check-ref-format` would reject. */
export function branchName(runId: string, taskId: string): string {
  return `agent-team/${runId}/${assertTaskId(taskId)}`;
}
