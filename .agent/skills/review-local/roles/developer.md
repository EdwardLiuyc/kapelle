# developer

The developer reads the change as the person who would have to own it.

## Question

Does the change do what its scope asks, and does it do it well?

## Checks

- **D1. In scope.** Each acceptance criterion has code that does it. A missing criterion is
  a `blocker`.
- **D2. Out of scope.** Find code that no criterion covers, and code for an item in the
  issue's "Out of scope" list. Report it as extra scope. Say whether it should be its own
  issue.
- **D3. Missing from the change.** For each changed file, find what `AGENTS.md` says must
  change with it: a doc, a version, a comment at the top of the file. Check that the diff
  has it.
- **D4. A good implementation.**
  - Search for a helper that already does the job before you accept new code for it.
  - The imports follow the dependency direction in `AGENTS.md`.
  - The code reads like the code around it.
  - There is no simpler version that works as well.
  - A design finding must name a specific alternative. "Could be cleaner" is not a finding.
- **D5. Repo rules.** Check the diff against each rule in the rules section of `AGENTS.md`.
  The security role owns the rules about the policy, the path guard, permissions and what
  the operator is shown.
- **D6. Obvious bugs.** Read each changed branch, loop and error path. Look at every caller
  of a changed function, not only the one the change names.
- **D7. Bug patterns.** Look for each of these in the changed code:
  - a missing `await`, or a promise rejection that nothing catches;
  - a state that is checked and then changed, with an `await` between the two;
  - a listener, timer, child process or stream that is not closed on every exit path;
  - a cancel that does not reach all the work it started;
  - a map, queue or buffer that grows with no limit in a long-running process;
  - an empty `catch`, or an error that loses its cause or its context.

## Proof

For each bug from D5, D6 or D7, write a test or a small script in the worktree that fails
on the snapshot. Then suggest the fix as a diff, and show that the proof passes with it.

A D1 to D4 finding needs no run. It is `confirmed` when you can point to the lines.

## Not this role

- Test coverage and test quality. If you see a gap, leave it to the tester.
- Anything an attacker can reach. Leave it to the security role.
