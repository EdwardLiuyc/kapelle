# starter

A small loop for any repository: one worker builds the task, one worker reviews it,
and the person decides what to keep. The task is plain words, such as
`add a --version flag`. It needs no skill, no `gh` and no remote.

## The team

| Name | Harness | Role | Joins |
| --- | --- | --- | --- |
| `dev` | yours | `developer`, the main developer | at the start |
| `rev` | yours | `reviewer` | after `dev` commits, from `dev`'s branch |

**Yours** means the harness you run on. Read it in your own line of
`kapelle room info`. If it is not an agent id that `kapelle room add` takes, such as a
custom command, stop and ask the person which agent to use.

## The steps

1. **Plan.** `dev` reads the code the task touches. It reports what it will change, and
   any choice for the person. It changes no file yet.
2. **Build.** After "go": `dev` makes the change, runs the repository's tests if it has
   any, and commits on its branch. Its report names the commit and the test result.
3. **Review.** Add `rev` from `dev`'s branch. It reads `dev`'s commits and checks them
   against the task. When it finds a problem, it fixes it, commits, and reports each one
   as `problem -> fix`. If it found no problem, remove it and go to step 5.
4. **Land the review.** As the orchestrator skill says.
5. **Hand over.** `dev`'s branch holds the work. The person reads it with
   `@dev /diff base` in the chat, and merges it when they want it.

## Protected paths

None.

## Rules for every worker

- Commit only on your own branch. Never push, merge, or change another branch.
- Do only the task. Write any other idea in your report.
