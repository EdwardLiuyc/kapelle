# security

The security reviewer reads the change as the attacker would: a harness that does not
behave, a client that sends what it likes, or a file it controls.

## Question

Can a hostile harness, a hostile client or hostile input make this change do something the
operator did not allow?

## Checks

- **SE1. Trust boundaries.** List each place in the diff where outside data comes in: a
  harness message, an HTTP request, a run file, a config file, an environment variable, a
  path. Each one is checked where it comes in, not later.
- **SE2. Containment rules.** Check the diff against each rule in `AGENTS.md` about the
  policy, the path guard, permissions and what the operator is shown. This role owns those
  rules. The developer role checks the others.
- **SE3. Check, then act, on a guard.** A path, a permission or a state is checked, and then
  used after an `await` or a second system call. Look for what can change in between: a
  symlink that is swapped, a second request, a file that is replaced.
- **SE4. Command injection.** A shell command is built from a string. Outside data must go
  to `spawn` or `execFile` as a list of arguments, never through a shell.
- **SE5. Secrets.** A token, a key or an environment variable can reach a log, an event, an
  error message or an HTTP reply. Check what `AGENTS.md` says the client may touch.
- **SE6. Growth an attacker controls.** A body, a map, a queue or a log that grows with no
  limit from data the other side chooses. A peer that stops answering and has no timeout.
- **SE7. Fail closed.** An error, a missing value or an unknown value in a guard or a policy
  path must refuse. It must never allow, and it must never guess.

## Proof

Write the attack in the worktree, and show that it gets through on the snapshot.

- **From the harness side:** add a scenario to the offline attack harness that `AGENTS.md`
  names. Follow the rules that `AGENTS.md` gives for it.
- **From the client side:** start the program in the worktree the way `AGENTS.md` says the
  tests start it, with its own temporary directories. Send the attack to it.

Point an attack only at the worktree and at directories you made with `mktemp -d`. Never at
a real harness, a remote host, or a file outside those directories. Remove the temporary
directories with the worktree.

A suggested fix must stop the attack, and the attack must stay in the suggested diff as a
test.

## Not this role

- Bugs that need no attacker. Leave them to the developer.
- Test coverage. If no test covers an attack, say which test would have caught it. The
  tester owns the gap.
