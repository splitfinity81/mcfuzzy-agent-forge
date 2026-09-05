# ADR-042: Lint with Biome from the repository root, and disable the noisy rules

**Date:** 2026-09-30
**Status:** Accepted
**Relates to:** ADR-040 (continuous integration), ADR-041 (remove unused dependencies rather than upgrade them)

---

## Context

The repository had no linter and no formatter configured anywhere: no ESLint
config, no Prettier config, no Biome config, in any of the six packages or at
the root. CI covered typecheck, tests, and version consistency only, and
ADR-040 recorded the absence of linting as a deliberate deferral rather than an
oversight.

Adding one raised a structural problem before any tool could be chosen. Every
package in this repository is installed and tested from its own directory, and
there was no root `package.json` at all. A linter therefore needs either six
separate installs and six configs, or a root manifest that exists purely to host
tooling.

A root manifest is not free. ADR-040 documents that `actions/setup-node` v5+
auto-enables npm caching the moment it sees a `packageManager` field in the
repo-root `package.json`, and then fails the job when it cannot find a lockfile
layout to key on. This repo's lockfiles live in the per-package directories, so
that failure would hit every leg of the test matrix.

## Decision

**Biome, at the repository root, lint-only.**

Biome over ESLint because:

- It is a single native binary with no plugin graph and no peer-dependency
  resolution. The root manifest gains exactly one devDependency.
- It lints TypeScript, plain JavaScript, and CSS from one config. This repo has
  all three, including two browser dashboards that are plain `.js` and `.css`.
- It analyses all 127 tracked files in roughly 0.2 seconds, which is fast enough
  that running it before every commit is not a chore.

The root `package.json` is `private`, contains no runtime code, and
**deliberately omits `packageManager`**. Both the manifest and
`.github/workflows/ci.yml` carry comments explaining that this omission is
load-bearing, not an accident, so a future contributor does not "helpfully" add
the field and break the matrix.

The formatter is configured but disabled (`formatter.enabled: false`), as is
Biome's assist feature, which reorganises imports on write. Enabling either
would rewrite most of the repository in one commit and bury every substantive
change in it. That remains a separate decision to take on its own merits.

CI gets a single `lint` job on `ubuntu-latest`, not a matrix leg. Biome is
platform-independent and analyses the whole repo in one pass, so there is
nothing for a second OS or a per-package split to cover.

### Scope: vendored code is excluded

The first run reported **8952 diagnostics**. 8619 of them - 96% - came from a
single file, `templates/skills/forge-workflow-engine/scripts/viz/dashboard/vendor/pixi.min.js`,
which is third-party and minified. A disk scan confirmed it is the only `vendor`
directory outside `node_modules`, so the exclusion is precise rather than a
broad guess. Excluding it left **333 real findings**.

Note that `app.js` sits beside that vendored file but is first-party and stays
in scope.

### Three rules are disabled, not satisfied

Of the 333, **274 came from three rules**:

| Rule | Findings | Why it is off |
| --- | --- | --- |
| `style/noNonNullAssertion` | 172 | Flags `x!`. Satisfying it means either restructuring working code or writing a runtime check that can never fire. |
| `complexity/useLiteralKeys` | 69 | `obj["key"]` vs `obj.key`. Pure preference. |
| `style/useTemplate` | 33 | String concatenation vs template literals. Pure preference. |

They were disabled rather than fixed. A rule producing 82% of a linter's output
while having caught zero defects does not improve the code; it trains people to
ignore the linter, which costs more than the rule ever earns. The remaining
**59 findings were fixed by hand**.

## Consequences

- `npm run lint` at the root exits 0. CI enforces it on every push and pull
  request.
- All six packages still typecheck and test clean: **243 tests passing, zero
  failures**.
- The root now has a `package.json` and a `package-lock.json` for the first
  time. Dependabot gains a seventh entry to cover them.
- Turning the formatter on later is a one-line config change, but it is a large
  diff. It should land on its own.

### Never use `--unsafe`

`biome lint --write --unsafe` was evaluated and rejected on evidence. It took
the count from 333 to 92, but it:

- touched **49 tracked files**,
- rewrote non-null assertions `a!.b` into optional chains `a?.b`, which is a
  change in runtime behaviour rather than a cleanup - the first throws on a
  broken invariant, the second silently yields `undefined` and moves the failure
  somewhere harder to find,
- and **introduced three new diagnostics** that did not exist before.

Only the plain `--write` autofix is used. `lint:fix` is documented in
`AGENTS.md` with this caveat attached.

### `noRedundantUseStrict` misfires on classic scripts

Biome's *safe* autofix deleted `"use strict";` from
`.../viz/dashboard/app.js`. The rule assumes ES-module context, where strict
mode is implicit. But `viz/dashboard/index.html` loads that file with a plain
`<script src="/app.js"></script>` - no `type="module"` - so the directive is
load-bearing, and removing it silently relaxes the semantics of the entire file.

It was restored with an inline suppression recording why. The launcher's own
dashboard loads `<script type="module" src="/main.js">` and is genuinely a
module, so the hazard does not apply there. The two dashboards had to be checked
separately; assuming they were symmetrical would have produced the wrong answer
for one of them.

The general lesson: a "safe" autofix is safe with respect to the rule's
assumptions about the file, and those assumptions can be wrong. Autofix diffs
get read, not trusted.

### Suppressions added

Every suppression carries a reason, which Biome 2.x requires:

- `viz/dashboard/app.js` - `noRedundantUseStrict`, as above.
- `viz/dashboard/style.css` - `noImportantStyles` on
  `.hidden { display: none !important; }`. A utility class that must beat any
  component rule setting `display`; without `!important` it silently stops
  working.
- `forge-launcher/scripts/bootstrap.test.ts` (x2) - `noTemplateCurlyInString`.
  The strings are shell-template fixtures containing a literal `${...}`, which
  is the thing under test.

The one CSS finding that was *fixed* rather than suppressed is
`noDescendingSpecificity` in the launcher dashboard: the bare `.project-select`
rule was moved above the more specific `.dropdown-row .project-select` rule.
That is a no-op for rendering, because the more specific selector wins
regardless of source order, which is exactly why the reorder is safe.
