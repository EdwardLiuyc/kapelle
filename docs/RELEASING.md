# Releasing kapelle

How a version of kapelle gets to npm. M9-8 (`docs/STORIES.md`) owns the publish
workflow, `.github/workflows/publish.yml`: the GitHub Actions job that publishes on a
tag.

## Release readiness

Do this before the repository is made public, and again before each publish if `master`
moved after the last record.

### Credential scan

gitleaks scans every ref that goes public: each branch, each tag and each `refs/pull/*`
ref. Scan a mirror clone, not a working checkout, because a checkout has no `refs/pull/*`.

```bash
(
  set -euo pipefail
  T=$(mktemp -d)
  trap 'rm -rf "$T"' EXIT
  v=8.30.1
  sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
  base=https://github.com/gitleaks/gitleaks/releases/download/v$v
  (
    cd "$T"
    curl -fsSLO "$base/gitleaks_${v}_linux_x64.tar.gz"
    echo "$sum  gitleaks_${v}_linux_x64.tar.gz" | sha256sum -c -
    tar -xzf "gitleaks_${v}_linux_x64.tar.gz" gitleaks
  )
  git clone -q --mirror "$(git remote get-url origin)" "$T/mirror"
  "$T/gitleaks" git --log-opts=--all --redact --no-banner \
    --gitleaks-ignore-path .gitleaksignore "$T/mirror"
)
```

`sum` pins the binary the record names, so a re-run proves it runs the same one. To move
to a new gitleaks version, take its digest from that release's
`gitleaks_<version>_checksums.txt`, and update `v`, `sum` and the record together.

Exit code 0 means no leak. A real hit is a credential that was exposed: rotate it at
its issuer. Rewriting history is not a substitute, because a clone or a fork may
already hold it. A false positive gets its fingerprint added to `.gitleaksignore`, and
a row in the record below that says why it is not a credential.

The record before the first publish is the last commit of the M9-8 PR (#307), made after
every review commit of that PR. It covers that PR's head, so nothing else lands on
`master` between that merge and the `v0.1.0` tag. Until that commit, the record below is
M9-8a's.

The record:

| Field | Value |
| --- | --- |
| Date | 2026-11-04 |
| Tool | gitleaks 8.30.1, `gitleaks_8.30.1_linux_x64.tar.gz`, SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`, pinned as `sum` in the command above; the digest was first taken from the release's checksums file |
| Range | a mirror of `origin` taken after this record was pushed: 21 branches, 230 `refs/pull/*` refs and no tags; from the root commit `6186a5f` to every ref's tip |
| Covers | every ref in that mirror: `master` at `5f90323`, and PR #448's head, which is the commit that adds this record, whose parent is `653ea56`. A later commit is not covered |
| Result | 2 hits, both false positives; with `.gitleaksignore`, no leaks (exit 0) |

The false positives:

| Fingerprint | Why it is not a credential |
| --- | --- |
| `e7688bb…:docs/CLIENT-API.md:generic-api-key:409` | The sample value in the `Idempotency-Key` header example. That header is a retry token the client makes up; it grants no access. |
| `7186fca…:docs/CLIENT-API.md:generic-api-key:406` | The same example, in an earlier commit. |

### GitHub settings once the repository is public

These features need a public repository on this plan. Turn them on right after the
flip, before the publish:

```bash
gh api -X PUT repos/EdwardLiuyc/kapelle/private-vulnerability-reporting
gh api -X PATCH repos/EdwardLiuyc/kapelle \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

Check them:

```bash
gh api repos/EdwardLiuyc/kapelle/private-vulnerability-reporting   # {"enabled":true}
gh api repos/EdwardLiuyc/kapelle --jq .security_and_analysis
```

`SECURITY.md` links to private vulnerability reporting, so the link works only from
this step on.

Branch protection also needs a public repository on this plan: today its API answers
`403` ("Upgrade to GitHub Pro or make this repository public"). Once it is available,
protect `master` and require both jobs of `code_checks.yml`, `check` and
`package-macos`. A job that is not required can fail without blocking a merge.

## Version and tag

The version is the one in `package.json`. The first release tags `0.1.0` as it is; do
not bump it by habit. For a later version, update `package.json` on a branch with
`npm version <version> --no-git-tag-version`, commit it, and land that commit on
`master` through the normal review.

Create the tag on the final `master` commit that will be published, and push it. Tag
`origin/master`, not a local `master` that may be behind it. Check first that its
`package.json` has the version the tag names. The publish job stops when they differ,
but a wrong tag is then on GitHub, and npm never takes a published version back.

```bash
git fetch origin
git show origin/master:package.json | grep '"version"'   # must be "<version>"
git tag -a v<version> -m v<version> origin/master
git push origin v<version>
```

The first release uses `v0.1.0`, made after the first publish below. The tag starts the
publish job.

## The first publish and the trusted publisher

npm trusted publishing lets the publish job publish with no npm token stored. npm adds
a trusted publisher only to a package that exists, so the first version is published by
hand. npm adds provenance (a proof of which repository and job built the package) only
to a publish from a job of a public repository, so the first version has none.

1. Make an npm account and turn on 2FA.
2. From a clean checkout of `origin/master` at the commit that will be tagged, run
   `npm ci`, the full gate from `AGENTS.md`, then `npm publish`. The tag check does not
   apply: there is no tag yet.
3. On npmjs.com, open the package's settings and add a trusted publisher: GitHub Actions,
   owner `EdwardLiuyc`, repository `kapelle`, workflow `publish.yml`.
4. Tag that commit and push the tag, as above. The job runs the gate, finds the version
   on npm already, and skips the publish with a notice.
5. Write the GitHub release notes for the tag. Say the package supports Linux and macOS
   only.

The next version is the first one the job publishes.

## The gate

The publish workflow has two jobs. `gate` checks that the tag names `package.json`'s
version, then runs `npm ci` and the full gate from `AGENTS.md` (§Commands, §Markdown
lint, §Format and lint). `publish` runs only after `gate` passes, and it is the only job
that can get the OIDC token for npm. It runs `npm ci`, because `prepack` needs `tsc`,
then `npm publish`, unless that version is on npm already. There is no `prepublishOnly`
guard (M9-8 step 4, option B), so the `gate` job is the only check before a publish. A
publish by hand runs the full gate from `AGENTS.md` first. It skips the tag check, because
it comes before the tag.

## The clean-machine check

On a Linux or macOS machine with Node 24 and no kapelle checkout:

```bash
npm install -g kapelle
kapelle --version   # prints the version that was tagged
kapelle             # on a terminal: opens the chat
```

## When a publish fails

- **The job failed before `npm publish`.** Nothing reached npm. Delete the tag
  (`git push origin :refs/tags/v<version>` and `git tag -d v<version>`), fix the cause
  on a branch, merge it, and tag again.
- **`npm publish` failed.** Read the job's log. npm publishes a version whole or not at
  all, so check with `npm view kapelle versions`. If the version is not there, fix the
  cause and run the job again. A re-run skips a version that is on npm already. npm
  older than 11.5.1 cannot use trusted publishing; the job prints its version first.
- **The published package is wrong.** npm never accepts the same version twice, even
  after an unpublish. Publish a new patch version with the fix, then mark the bad one:
  `npm deprecate kapelle@<version> "<why>"`.
