# release

This repository's loop for one version: prepare the release PR, gate it, publish it and
write the notes. The task is the release issue number.

`docs/RELEASING.md` owns the release procedure. This recipe says how the orchestrator
drives one worker through it.

## The team

| Name | Harness | Role | Joins |
| --- | --- | --- | --- |
| `rel` | yours | `developer`, the release manager | at the start |

**Yours** means the harness you run on. Read it in `kapelle room info`, on the line
whose role is `orchestrator`. If it is not an agent id that `kapelle room add` takes,
such as a custom command, stop and ask the person which agent to use.

There is no reviewer panel. The person reviews and approves the release PR.

## The steps

1. **Scope.** `rel` reads the release issue and `docs/RELEASING.md`. It reports the
   version, the previous tag, the commits since it, and any open choice. It changes no
   file. Stop for the person if the version, the commits or the issue are unclear.
2. **Prepare.** After "go": `rel` makes the release branch changes: the version in
   `package.json` and `package-lock.json`, the `CHANGELOG.md` section, and any owner-doc
   change the issue names. It runs the full gate. It commits on its branch, pushes as
   `release-<version>` and opens the PR into `master` from that branch. The PR body uses
   `Refs #<issue>`, not `Closes`. It does not run the credential scan yet.
3. **CI and review.** Wait for the PR's `check` and `package-macos` jobs. The person may
   ask for a fix. `rel` makes it, reruns the gate, and pushes it. The last commit before
   the scan must be the final fix.
4. **Credential scan.** After every review fix, `rel` runs the scan from
   `docs/RELEASING.md`, writes the record, commits it, scans that one commit, and pushes
   it. This must be the last commit of the PR. If anything changes after it, run the
   scan again.
5. **Merge gate.** Stop for the person. The person checks branch protection, the
   credential record and the PR, then merges. `rel` never merges.
6. **Tag.** Stop for the person to check the trusted publisher and say "tag and push".
   Then `rel` fetches `origin`, checks `origin/master`'s package version, tags
   `v<version>` on `origin/master`, and pushes the tag. It never tags without that
   order.
7. **Publish.** `rel` watches the publish workflow and checks that
   `npm view kapelle@<version> version` prints the version. It reports the run and the
   version.
8. **Finish.** Stop for the person to run the clean-machine check. After it passes,
   `rel` drafts the GitHub release notes from the changelog. The person approves; only
   then does `rel` publish them. Close the release issue only after the notes are
   published and the clean-machine result is recorded.

## Protected paths

None.

## Rules for every worker

- Commit only on your own branch. Never merge, never push `master`, and never tag or
  publish without an explicit order from the person.
- Run the credential scan again after any commit that follows it.
- A release issue, a tag and an npm version are external facts. Check them; do not
  assume them.
- End every report with the step board.
