# Security policy

## Report a vulnerability

Do not open a public issue for a security problem. Report it in private through
GitHub's private vulnerability reporting:

<https://github.com/EdwardLiuyc/kapelle/security/advisories/new>

Say what you found, the version (`kapelle --version`), and the steps that show it.
You get a reply on the advisory.

## Supported versions

Only the latest published release gets fixes.

## Scope

kapelle starts coding agents and decides what they may ask for. Its policy is a filter,
not a sandbox: an agent that edits files through its own shell is outside kapelle's
reach. A report that kapelle let a request through that its mode should refuse, or that
its path guard let a write leave the workspace, is in scope. A report that an agent did
something through its own tools is a report for that agent.
