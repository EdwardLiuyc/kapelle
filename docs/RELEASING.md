# Releasing kapelle

How a version of kapelle gets to npm. M9-8 (`docs/STORIES.md`) owns the publish
workflow: the GitHub Actions job that publishes on a tag. Until that job exists, the
steps below that name it are the plan, not the state.

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
  base=https://github.com/gitleaks/gitleaks/releases/download/v$v
  (
    cd "$T"
    curl -fsSLO "$base/gitleaks_${v}_checksums.txt"
    curl -fsSLO "$base/gitleaks_${v}_linux_x64.tar.gz"
    grep linux_x64.tar.gz "gitleaks_${v}_checksums.txt" | sha256sum -c -
    tar -xzf "gitleaks_${v}_linux_x64.tar.gz" gitleaks
  )
  git clone -q --mirror "$(git remote get-url origin)" "$T/mirror"
  "$T/gitleaks" git --log-opts=--all --redact --no-banner \
    --gitleaks-ignore-path .gitleaksignore "$T/mirror"
)
```

Exit code 0 means no leak. A real hit is a credential that was exposed: rotate it at
its issuer. Rewriting history is not a substitute, because a clone or a fork may
already hold it. A false positive gets its fingerprint added to `.gitleaksignore`, and
a row in the record below that says why it is not a credential.

The record:

| Field | Value |
| --- | --- |
| Date | 2026-11-04 |
| Tool | gitleaks 8.30.1, `gitleaks_8.30.1_linux_x64.tar.gz`, SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`, matched against the release's checksums file |
| Range | a mirror of `origin`: 21 branches, 229 `refs/pull/*` refs and no tags; from the root commit `6186a5f` to every ref's tip, `master` at `7672a47`; 1,102 commits scanned |
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

## Version and tag

The version is the one in `package.json`. The first release tags `0.1.0` as it is; do
not bump it by habit. For a later version, update `package.json` on a branch with
`npm version <version> --no-git-tag-version`, commit it, and land that commit on
`master` through the normal review.

Create the tag on the final `master` commit that will be published, and push it:

```bash
git tag v<version>
git push origin v<version>
```

The first release uses `v0.1.0`. The tag starts the publish job.

## The first publish and the trusted publisher

npm trusted publishing lets the publish job publish with no npm token stored. npm adds
provenance (a proof of which repository and job built the package) only for a public
repository.

1. Make an npm account and turn on 2FA.
2. If npm needs the package to exist before a trusted publisher can be added, publish
   the first version by hand from a clean checkout of its tag: `npm ci`, the gate, then
   `npm publish`.
3. On npmjs.com, open the package's settings and add a trusted publisher: GitHub Actions,
   owner `EdwardLiuyc`, repository `kapelle`, and the workflow file M9-8 adds.
4. The job needs `permissions: id-token: write`.

## The gate

The publish job runs `npm ci` first, because `prepack` needs `tsc`. Then it runs the
full gate from `AGENTS.md` (§Commands, §Markdown lint, §Format and lint), then
`npm publish`. There is no `prepublishOnly` guard (M9-8 step 4, option B), so this job's
gate is the only check before a publish. A publish by hand runs the same gate first.

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
  cause and run the job again.
- **The published package is wrong.** npm never accepts the same version twice, even
  after an unpublish. Publish a new patch version with the fix, then mark the bad one:
  `npm deprecate kapelle@<version> "<why>"`.
