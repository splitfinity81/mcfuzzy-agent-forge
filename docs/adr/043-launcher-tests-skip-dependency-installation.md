# ADR-043: Launcher tests skip dependency installation via `FORGE_SKIP_INSTALL`

**Date:** 2026-09-30
**Status:** Accepted
**Relates to:** ADR-039 (bootstrap installs skill dependencies), ADR-040 (continuous integration)

---

## Context

ADR-039 made `forge-launcher bootstrap` install the dependencies of every copied
skill that declares them, because `copyTree` excludes `node_modules` and the
skills are otherwise present but unrunnable. That decision was right for users
and wrong for the test suite, which had been paying for it silently ever since.

The `scripts/forge-launcher` job was by far the slowest thing in CI:

| Leg | Duration |
|-----|----------|
| `scripts/forge-launcher` (windows-latest) | **7.9 min** |
| `scripts/forge-launcher` (ubuntu-latest) | 0.8 min |
| every other leg | <= 0.6 min |

Against `timeout-minutes: 25` that was not an emergency, but a 10x
Windows/Linux gap on one job is a signal, and it made the local edit-test loop on
Windows painful: the full launcher suite took **435.7 s**.

### What the measurements actually showed

The cause was not obvious, and two plausible explanations were tested and
rejected before the real one was found.

1. **"Bootstrap tests run a real `npm install`."** False as stated:
   `bootstrap.test.ts` passes `skipInstall: true` in every test, and no test
   invokes `bootstrap` through the CLI.
2. **"npm audit/funding round-trips are the cost."** False: a zero-dependency
   `npm install` measured 2.7 s, and 2.1 s with `--no-audit --no-fund`. Not the
   178 s being attributed to it.
3. **"Parallel test files contend for CPU."** Real, but secondary. Running
   `draft.test.ts` alone dropped its slowest test from 177.7 s to 3.8 s, and a
   concurrency sweep gave 374 s at 1, **327 s at 2**, 336 s at 4, and 436 s at
   the default 16. Worth ~25%, not the main effect.

Timing every file in isolation located it precisely:

```
launcher.test.ts   316.4s   <- 90% of the total
all other files     34.3s
```

Within that file, 12 tests each took 20-27 s uncontended and every other test
took <= 1.3 s. All twelve drive the full non-interactive launcher, which calls
`bootstrapForge`. Measuring bootstrap directly settled it:

```
skipInstall=true    0.5s    skillsNeedingInstall=4
skipInstall=false  20.3s    skillsNeedingInstall=4
```

Roughly 19.8 s x 12 = ~238 s of the 316 s was `npm install` running against the
live registry, ~60 times per suite run.

Two things made this worse than mere slowness. The launcher takes no
`--no-install` flag, so there was no way to opt out of an install reached
indirectly. And **the install path was executed 12 times and asserted zero
times** - the suite paid the full cost of the behaviour without ever checking it.

## Decision

**Honour `FORGE_SKIP_INSTALL=1` in `bootstrap`, default the launcher suite to it,
and cover the real install path with a dedicated test instead of an incidental
one.**

- `bootstrap()` skips installation when `opts.skipInstall` is set **or**
  `FORGE_SKIP_INSTALL=1`. The log names which opt-out applied
  (`Skipped (--no-install)` vs `Skipped (FORGE_SKIP_INSTALL)`) so the reason is
  visible after the fact.
- `runCli` in `launcher.test.ts` sets `FORGE_SKIP_INSTALL: "1"` before spreading
  the per-test env, so any test can opt back in with `"0"`.
- `bootstrap.test.ts` gains two tests: one asserting the env var skips
  installation, and one exercising the real install path end to end.

An environment variable rather than a new flag, because the launcher reaches
bootstrap indirectly through `bootstrapForge` and threading a flag through the
interactive flow would add user-facing surface for a test's benefit.
`FORGE_SKIP_INSTALL` follows an established convention: the launcher already
reads 27 `FORGE_*` variables, including the test-oriented `FORGE_RUN_WITH` and
`FORGE_STUB_NOOP`.

## Consequences

Measured, Windows, same machine:

| Scope | Before | After |
|-------|--------|-------|
| `launcher.test.ts` in isolation | 316.4 s | **52.8 s** |
| full launcher suite (`npm test`) | 435.7 s | **78.3 s** |
| tests passing | 107 | **109** |

- The suite no longer needs network access to pass. It previously shelled out to
  the npm registry ~60 times per run, which is flaky by construction - a
  registry outage would have failed tests that have nothing to do with the
  registry.
- Coverage improved rather than regressed. The install path went from executed
  12 times and asserted zero times, to executed once and asserted properly.
- The dedicated install test is deliberately tolerant: installs are non-fatal by
  ADR-039, so it asserts the outcome each skill *reported* (`Installed:` or
  `Install failed:`) and only requires `node_modules` to exist where the log
  claims success. Asserting unconditional success would reintroduce the network
  flakiness this change removes. It carries an explicit 300 s timeout because it
  performs four real installs.
- `FORGE_SKIP_INSTALL` is public API now: it is documented in the launcher help
  text and the non-interactive environment variable table, and changing its
  meaning is a breaking change.
- Test-file concurrency was left at the default. Capping it at 2 was worth ~25%
  before this change, but that was contention *created by* the installs; with
  them gone the tuning is not worth pinning a value that depends on the runner's
  core count.

## Alternatives considered

- **Cap `--test-concurrency`.** Measured at 327 s vs 436 s. A real but partial
  win that treats the symptom, and it would have to be re-tuned per runner.
- **Pass `--no-audit --no-fund` to the installs.** Measured saving of 0.6 s per
  install. Worth doing on its own merits perhaps, but irrelevant here.
- **Delete or merge the 12 slow tests.** They assert distinct launcher
  behaviours (harness routing, queued skill messages, engine config plumbing).
  The install was incidental to all of them; the tests are not the problem.
- **Mock `npm`.** Would need a spawn seam through `installSkillDeps` purely for
  tests, and would still not exercise the real path anywhere.
