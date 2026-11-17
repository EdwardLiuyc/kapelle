---
name: Release
about: Track one kapelle release from the version bump to the npm publish
title: "release v"
---

Release `<version>`. `docs/RELEASING.md` owns the procedure; this is the checklist and
evidence for this version.

Replace `<version>` and `<previous>` below. Start with `kapelle loop release <this issue>`
after filling in the version.

## Prepare

- [ ] The version is `<version>`, and the commits since `v<previous>` are listed here.
- [ ] The release PR comes from a branch named `release-<version>` into `master`.
- [ ] `package.json` and `package-lock.json` say `<version>`.
- [ ] `CHANGELOG.md`'s first section is `## <version>`, with user-visible changes and PR
  numbers.
- [ ] `npm run check:changelog` passes.
- [ ] The PR body uses `Refs #<this issue>`, not `Closes`: the release issue stays open
  until the publish is checked.

## Gate

- [ ] The release PR has both `check` and `package-macos` green.
- [ ] Branch protection on `master` requires `check` and `package-macos` (a repository
  setting).
- [ ] The credential scan ran clean, and its record is the last commit of the PR.
- [ ] The scan of that record commit ran clean before its push.
- [ ] The person approved and merged the PR.

## Publish

- [ ] The trusted publisher is configured in npm.
- [ ] The person approved the tag; `v<version>` points at the merged `master`.
- [ ] The publish workflow passed, and `npm view kapelle@<version> version` printed
  `<version>`.
- [ ] The clean-machine check passed on Node 24 without a checkout.
- [ ] The GitHub release notes link the changelog and say Linux and macOS only.
- [ ] This issue is closed.

## Evidence

- Release PR:
- Release commit:
- Credential scan:
- Publish run:
- Clean-machine check:
- Release notes:
