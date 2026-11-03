# Offline coverage

Run the complete offline suite with Node 24's built-in V8 coverage:

```bash
npm run test:coverage
```

The command needs no harness or credentials. It includes spawned Node daemons
and CLI processes through the `NODE_V8_COVERAGE` environment that Node's test
runner propagates. Their test cleanup uses `SIGTERM`, waits up to five seconds,
and then uses `SIGKILL`, so a healthy child exits cleanly and a stuck child is
still reaped.

Coverage uses two test files at a time instead of the normal suite's four. With
coverage at four-way concurrency, the existing chunked-upload test in
`tests/contract/errors.test.ts` intermittently failed with `ECONNRESET`. No test
or assertion is skipped in the coverage run.

## Files and exclusions

The include glob is `**/*.ts`. The exclusions are `**/tests/**`,
`integration/**`, `dist/**`, and `node_modules/**`, matching the production
boundary in `tsconfig.build.json`. There is no hard-coded production file list
or count. The full suite currently loads every production file, so all 60 files
appeared in both baseline reports.

## Baseline

Measured on 2026-11-03 with Node 24.18.0, after rebasing on `ebfdc7c`. Each run
passed all 1,475 tests, with no skipped, cancelled, or todo tests.

| Run | Lines | Branches | Functions | Test-runner time |
| --- | ---: | ---: | ---: | ---: |
| 1 | 97.67% | 92.20% | 93.93% | 339.612 s |
| 2 | 97.67% | 92.18% | 93.93% | 339.609 s |

The stable reference is **97.67% lines, 92.19% branches, and 93.93% functions**.
The observed branch spread is 0.02 percentage points. These measurements are a
baseline, not a threshold or gate.

An intentional `SIGKILL` prevents that process from flushing V8 coverage. Crash
and kill tests therefore still lose that process's data; code exercised only by
such a process can remain underreported. Those tests keep their original
semantics, and no production file is excluded to hide the limitation.
