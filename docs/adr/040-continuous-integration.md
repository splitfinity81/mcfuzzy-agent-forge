# ADR-040: Continuous Integration on Windows and Linux

**Date:** 2026-09-30
**Status:** Accepted
**Relates to:** ADR-038 (portable npm install/test contract), ADR-039 (bootstrap installs skill dependencies)

---

## Context

The repository had no `.github/` directory at all: no workflows, no PR template,
no CODEOWNERS. Six independently installable packages, ~22K lines of TypeScript,
and 243 tests were verified only by whoever remembered to run them locally, on
whichever platform they happened to be using.

That is not a theoretical risk here. ADR-038 and ADR-039 exist because a whole
class of defects had accumulated unnoticed:

- A `file:` dependency pointing at a gitignored tarball broke `npm install` in
  any fresh clone.
- A single-quoted test glob meant the workflow engine ran **zero** tests on
  Windows while exiting 0. Eleven test files, `engine.test.ts` among them, had
  never executed there.
- Three assertions hard-coded POSIX path separators.

Every one of these would have been caught on the first push by a matrix that
runs `npm ci` and `npm test` on both platforms. None of them were caught for
months, because nothing ran.

### The mirror-image defect

Preparing this workflow surfaced a seventh defect, symmetrical to the quoting
bug ADR-038 fixed, and latent for exactly the same reason: the test glob behaves
differently depending on which shell npm hands the script to.

`forge-workflow-engine` declared:

```
node --import tsx --test scripts/**/*.test.ts
```

On Windows npm runs scripts through `cmd.exe`, which does not expand globs at
all. The pattern reaches Node unexpanded, and Node's own glob handling (`--test`
glob support, Node 21+) resolves `**` recursively. All 11 files run.

On Linux npm runs scripts through `sh`. There `**` is not special unless
`globstar` is set, which it is not by default, so `scripts/**/*.test.ts` degrades
to `scripts/*/*.test.ts` — matching **exactly two levels**. The shell expands it
before Node ever sees it. Measured directly:

```
without globstar -> 5 files   (harness/*, viz/* only)
with globstar    -> 11 files  (all)
```

The 6 files dropped are the entire top level of `scripts/`, including
`engine.test.ts` and `verify.test.ts`. npm would exit 0. The
`assert-tests-discovered.mjs` guard from ADR-039 would **also** pass, because it
walks the tree in Node and correctly finds 11 files — it verifies that tests
exist, not that the runner received them.

So the first green Ubuntu CI run would have reported success while silently
skipping more than half the engine's coverage. Landing CI without fixing this
would have been worse than having no CI: it would have manufactured confidence.

Only `forge-workflow-engine` is affected. Every other package uses a flat
`scripts/*.test.ts`, which expands identically under both shells.

## Decision

**1. Replace the recursive glob with explicit per-level patterns.**

```
node --import tsx --test scripts/*.test.ts scripts/*/*.test.ts
```

Under `sh` both globs expand normally (6 + 5 = 11). Under `cmd` both pass
through literally and Node expands them (11). Identical on both platforms, with
no shell-specific behaviour to reason about.

Alternatives rejected:

- **Quote the glob.** Fixes Linux and re-breaks Windows. This is defect #2 from
  ADR-038, reintroduced.
- **Escape the stars.** `\` is the path separator on Windows; unpredictable.
- **Pass the directory and let Node walk it.** Node's directory-mode matching
  rules vary by version; the failure mode is again a silent under-match.

**Known limitation:** this hard-codes a maximum depth of two. A future
`scripts/a/b/x.test.ts` would be skipped, and the guard would not catch it for
the reason described above. Accepted for now because the tree has been two levels
deep for its entire history. The depth-proof fix is a `run-tests.mjs` walker that
resolves the file list in Node and spawns the runner with explicit paths, and it
is deliberately deferred rather than dismissed.

**2. Run every package on both Windows and Linux.**

`.github/workflows/ci.yml` runs a 12-leg matrix: 6 packages x 2 operating
systems, with `fail-fast: false` so one broken leg does not mask the others.
Each leg installs, typechecks, and tests one package from its own directory.

Windows is not optional. It is the platform on which the shipped test suite was
silently broken, and it remains the platform where npm's script shell does not
glob.

**3. Pin Node 22, not the declared floor of 18.**

`forge-launcher` declares `engines.node >= 18`. That is accurate for the
launcher's runtime and is left alone. It is not accurate for running the test
suites on Windows, which depend on Node's built-in `--test` glob support and
therefore require Node 21 or newer. CI pins 22 and documents why inline.

**4. Use `bash` as the shell on both runners.**

The install step is conditional, and `if [ -f package-lock.json ]` needs a POSIX
shell. Git Bash is present on GitHub's Windows runners, so `shell: bash` is
portable and keeps a single code path.

**5. Handle `forge-build-agent-team` as the documented exception.**

It is the only package with no lockfile (it declares no dependencies) and no
`typecheck` script (it is plain `.mjs`). Rather than manufacture a lockfile for a
dependency-free package, the workflow degrades:

- `npm ci` if a lockfile exists, otherwise `npm install`
- `npm run typecheck --if-present`

**6. Do not enable `actions/setup-node` npm caching.**

There is no root lockfile, and `cache-dependency-path` cannot be varied per
matrix leg in a way that resolves for all six packages. setup-node errors when
the path does not resolve. Install time is small enough that this is not worth
working around.

**7. Gate the documentation contract too.**

A second job runs `npm run check:version`, which enforces the AGENTS.md rule that
the README's `**Latest:**` line tracks the top section of `docs/updates.md`. It
is a convention the repository already relies on and had no enforcement for.

**8. Install the adapter's dependencies on the engine's matrix leg.**

The first CI run went red on both `forge-workflow-engine` legs with
`error TS2307: Cannot find module 'gray-matter'`, reported against the
*adapter's* `discovery.ts`. The engine is the only package in the repository
that is not self-contained: `engine.ts` dynamically imports
`../../forge-execution-adapter/scripts/discovery.ts`, TypeScript resolves
literal-specifier dynamic imports and pulls the target into the program, and
`discovery.ts` imports `gray-matter`.

Because CI installs dependencies per package, the adapter's `node_modules` is
absent on the engine's leg. The bare specifier then cannot resolve: both Node
and TypeScript resolve it from `discovery.ts`'s own directory upward, and the
engine's `node_modules` is not on that path. This is the compile-time twin of
the runtime failure fixed in v3.46.

The workflow adds a `matrix.include` entry giving the engine a `sibling`
property, plus a step conditional on that property which runs `npm ci` in the
adapter before the typecheck. An `include` entry whose keys match an existing
combination merges into it rather than creating new combinations, so the matrix
stays at twelve legs and the property lands on both engine legs.

Alternatives rejected:

- **Narrowing the engine's `tsconfig.json` `include`.** Tested directly, by
  hiding the adapter's `node_modules` and running the typecheck with and
  without the adapter's sources in `include`. It fails identically either way.
  The coupling lives in the import graph, not the glob, so the `include` entry
  is left where it documents the intent.
- **Adding `gray-matter` to the engine's dependencies.** Resolution starts at
  the importing file, so the engine's `node_modules` is never consulted.
- **An ambient `declare module "gray-matter"` stub in the engine.** It would
  type the import as `any` while compiling the adapter's source, weakening a
  typecheck that passes honestly on the adapter's own leg.
- **Extracting the shared types into a dependency-free package.** This is the
  real fix for the coupling and remains open. It is a refactor spanning two
  packages, out of scope for making CI green.

### Action versions

`actions/checkout` and `actions/setup-node` are pinned at v7. The v4 releases
run on Node 20, which the runner marks deprecated on every job.

Three majors of breaking changes were reviewed before moving. None apply here,
but two are worth recording because they would apply after a plausible future
change:

- `checkout@v7` refuses to check out fork code under `pull_request_target` and
  `workflow_run`. This workflow triggers on plain `pull_request`, which is
  unaffected. Switching triggers to get a writable token would hit this.
- `setup-node@v5` enables dependency caching automatically when `package.json`
  declares a `packageManager` field, and v6 narrows that to npm. No manifest in
  this repository declares `packageManager`, and there is no root
  `package.json`, so nothing is auto-detected. Adding one would enable caching,
  send the action looking for a lockfile at the repository root, and fail every
  leg - the lockfiles live in the six package directories. This is recorded as a
  comment beside the step rather than only here, because the failure would
  appear far from its cause.

The workflow requests `permissions: contents: read` and uses no secrets, so it
runs correctly under the read-only token given to fork pull requests.

## Consequences

- The glob fix is a pure gain with no trade-off: Windows is byte-for-byte
  unchanged at 104 passing / 0 failing / exit 0, and Linux goes from 5 test files
  to 11.
- Regressions in any of the six packages now surface on the pull request that
  introduces them, on both platforms.
- The engine suite is the slow leg at roughly five minutes locally, so jobs allow
  25 minutes.
- Test discovery in the engine is now capped at two directory levels. This is
  recorded as a known limitation rather than a hidden one.
- The engine's dynamic import of the adapter resolves in CI exactly as it does
  locally, so CI exercises the real code path rather than the degraded fallback.
- The engine and the adapter are now coupled at build time as well as at
  runtime, and the workflow encodes that coupling explicitly. Severing it
  requires the shared types to move into their own package.
- CI covers typecheck, tests, and version consistency. It does not lint: no
  linter is configured anywhere in the repository, and adding one is a separate
  decision.
