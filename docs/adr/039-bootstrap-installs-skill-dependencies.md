# ADR-039: Bootstrap Installs Skill Dependencies

**Date:** 2026-09-30
**Status:** Accepted
**Relates to:** ADR-038 (portable npm install/test contract), ADR-023 (forge-launcher npm package)

---

## Context

ADR-038 fixed the npm surface but deliberately left three items open. This ADR
closes all three.

**1. Dependency installation was still manual.** Bootstrap copies skills into a
target repo with `copyTree`, which excludes `node_modules` and `dist`. Nothing
then installs anything: the launcher mentions `npm install` only in two hint
strings (`format.ts`, `update-check.ts`), and the shell wrappers only *print* it
inside error text. The single exception is `test-forge-launcher.sh`, a test
harness. So every freshly bootstrapped repo shipped with skills whose declared
dependencies were absent.

This is not a cosmetic gap. `forge-workflow-engine` loads the sibling adapter's
`discovery.ts` at runtime, and that module imports `gray-matter`, declared only in
the adapter. ADR-038 made that import non-fatal, so the failure mode was a silent
downgrade — the engine ran, logged `Could not discover agent files`, and skipped
owner matching — in *the default configuration of every target repo*. The
degraded path was the normal path.

**2. The zero-test guard covered one package of six.** The failure class it
detects — `node --test` exiting 0 when its pattern matches nothing — applies to
every package, not just the one where it happened to bite.

**3. Three Windows portability failures were confirmed but not fixed.** An A/B
run against pristine `HEAD` files proved they predated ADR-038's changes, so they
were correctly excluded from that change's scope.

## Decision

**Bootstrap installs by default; `--no-install` opts out; failures are non-fatal.**

- After the skill-copy loop, bootstrap installs dependencies for each copied skill
  that declares any. `skillsWithDependencies()` filters to skills with a
  `package.json` declaring at least one `dependencies` or `devDependencies` entry.
  Today that is 4 of the 15 shipped skills; the other 11 are prompt-and-markdown
  only and are skipped without spawning anything.
- **`npm ci` when a `package-lock.json` is present, `npm install` otherwise.** All
  four installable skills currently ship a lockfile, so `npm ci` is the live path
  for all of them — reproducible, and it fails loudly on a manifest/lockfile
  mismatch rather than silently resolving something new.
- **Failures never abort the bootstrap.** A non-zero exit code is captured, the
  last meaningful stderr line is logged as a warning, and the skill is added to a
  pending list. The completion summary prints the exact `cd <path> && npm install`
  commands for every skill that did not install. The whole install body is also
  wrapped in `try/catch`, because `runCommand` **rejects** on spawn error — a
  machine without `npm` on `PATH` would otherwise throw out of a code path that is
  meant to degrade, which is precisely the defect shape ADR-038 fixed in the
  engine.
- **`npm` is resolved as `npm.cmd` on win32.** `runCommand` spawns without
  `shell: true`, and npm ships on Windows as a `.cmd` shim that bare `spawn`
  cannot launch. The repo already documents this exact hazard in
  `describeSpawnError` and already probes `.cmd`/`.bat` extensions in
  `commandExists`; this follows that established practice.
- **The flag is plumbed to the CLI only.** `console/control.ts`,
  `console/server.ts`, and `console/dashboard/api.ts` call `bootstrap()` without
  `skipInstall`, so the Console gets install-by-default — the desired behaviour. A
  UI toggle for an escape hatch would be scope creep.
- **Replicate the `pretest` guard into all six packages.** The script is copied
  byte-identically rather than factored into a shared module, and its filename
  suffix is parameterised via `argv[2]` (defaulting to `.test.ts`) because
  `forge-build-agent-team` uses `.test.mjs`. Skills are independently bootstrapped
  and installed; a shared module would reintroduce exactly the cross-package
  coupling that caused ADR-038's defect 3. The guard remains dependency-free so it
  works in `forge-build-agent-team`, which has no dependencies at all.
- **Generate the missing `skill-review` lockfile** so `npm ci` is valid there.
  `forge-build-agent-team` is deliberately left without one: it declares zero
  dependencies, so a lockfile would be noise and it is never selected for install.
- **Fix the three deferred Windows failures as test-only defects.** In all three
  cases the production code was already correct and cross-platform, and the test
  had hard-coded a POSIX assumption. No production code changed.

## Consequences

- A freshly bootstrapped repo has working skills. Owner matching works out of the
  box instead of silently degrading.
- **Bootstrap now performs network I/O.** This is the significant behavioural
  change: a previously offline, filesystem-only operation can now reach the npm
  registry. `--no-install` restores the old behaviour exactly, and an offline
  machine gets warnings plus a copy-pasteable command list rather than a failure.
- Bootstrap is slower on first run, proportional to the four installs. Skills
  without dependencies add no cost.
- A glob typo, directory rename, or shell-quoting difference now fails loudly in
  **all six** packages rather than producing a zero-coverage green run.
- **The whole repository is green on Windows for the first time: 243 passing,
  0 failing, exit 0 across all six packages** — from a starting state where one
  package silently ran zero tests while reporting success.
- The `--no-install` log assertion in `bootstrap.test.ts` depends on the real
  `templates/skills/` tree containing at least one dependency-declaring skill. That
  holds today; it would need revisiting if the shipped templates were ever pruned
  to prompt-only skills.
- The engine's degraded path was verified rather than assumed: with the adapter's
  `gray-matter` renamed away, the import rejects with `ERR_MODULE_NOT_FOUND` in
  0.2s and is caught cleanly. It fails fast, not slowly.
