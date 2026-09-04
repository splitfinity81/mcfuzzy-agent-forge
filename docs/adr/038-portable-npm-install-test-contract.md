# ADR-038: Portable and Self-Verifying npm Install/Test Contract

**Date:** 2026-09-30
**Status:** Accepted
**Relates to:** ADR-023 (forge-launcher npm package), ADR-029 (output verification gate)
**Follow-up:** ADR-039 closes the three items this ADR left open (guard
replication, install automation, and the deferred Windows portability failures).

---

## Context

The repository ships six independent Node packages (`scripts/forge-launcher` plus
five skills under `templates/skills/`). Each is bootstrapped into a target repo
and installed there on its own. A pass over their npm surface uncovered five
defects, four of which were invisible on a green CI signal:

1. **`scripts/forge-launcher/package.json` depended on itself** via
   `"forge-launcher": "file:forge-launcher-1.0.0-beta.4.tgz"`, mirrored in the
   lockfile. `.gitignore` excludes `scripts/forge-launcher/*.tgz`, so the tarball
   never exists in a fresh clone and `npm install` failed with `ENOENT`. This also
   contradicted the README, which tells the user to run `npm install` *before*
   `npm pack`.

2. **`forge-workflow-engine`'s test glob was single-quoted** —
   `--test 'scripts/**/*.test.ts'` — and it was the only package of the six that
   quoted it. PowerShell does not strip single quotes, so Node received a literal
   path, matched nothing, and reported `tests 0` with **exit 0**. Eleven test
   files, including the 36.6 KB `engine.test.ts`, never ran on Windows while CI
   stayed green.

3. **The engine's cross-package dynamic import was outside its `try` block.**
   `runEngine()` and `replayTask()` both `await import(...)` the sibling adapter's
   `discovery.ts`, whose sole external dependency (`gray-matter`) is declared in
   the adapter and resolves only from the adapter's own `node_modules`. Because
   the import sat outside the guard, a module-load failure became an unhandled
   `ERR_MODULE_NOT_FOUND` on a public entry point — even though the existing catch
   block's message ("owner matching will be skipped") proves discovery was always
   intended to be optional.

4. **Test fixtures used POSIX-only shell builtins.** Four call sites passed the
   literal strings `"true"` / `"false"` as validation commands. Production code in
   `verify.ts` already branches correctly on `process.platform`, so the defect was
   confined to fixtures — and was only discoverable once defect 2 was fixed and
   the tests ran for the first time.

5. **Documentation promised an automatic `npm install` that does not exist.**
   `SKILL.md` and `AGENTS.md` described dependency installation as deferred to
   "prep time". No code performs it: the launcher mentions `npm install` only in
   two hint strings, and the shell wrappers only *print* it inside error messages.

Defect 2 masked defects 3 and 4, and defects 3 and 5 compound: bootstrap copies
skills into target repos **excluding `node_modules`**, so the un-guarded import
would fail in exactly the environment the product ships into.

## Decision

- **Remove the self-referential dependency** from the launcher's manifest and
  prune the corresponding lockfile entries, rather than regenerating the lockfile
  wholesale, to keep the change reviewable.
- **Unquote the engine's test glob** so it matches the other five packages and is
  interpreted by Node's own glob handling on every shell.
- **Add a `pretest` guard** — `scripts/assert-tests-discovered.mjs` — that counts
  test files and exits non-zero when none are found. This is required because
  `node --test` exits **0** when its pattern matches nothing, in both the quoted
  and unquoted forms; unquoting fixes the current instance but leaves the failure
  class undetectable. The guard walks the tree manually instead of using
  `fs.glob` or `readdirSync({ recursive: true })`, both of which post-date the
  package's declared `node >= 18` floor.
- **Move the dynamic import inside the `try` block** at both sites and surface the
  caught reason in the warning, making optional discovery genuinely optional.
- **Replace POSIX builtins in fixtures with `exit 0` / `exit 1`**, which is
  already the convention elsewhere in the same suite.
- **Correct the documentation to describe the real behaviour** — installation is
  a manual, per-skill step — instead of describing intended automation as if it
  shipped.

## Consequences

- `npm install` succeeds from a fresh clone of the launcher package.
- The engine suite runs on Windows for the first time: **104 passing, 0 failing**,
  where it previously reported zero tests.
- A future glob typo, directory rename, or shell-quoting difference fails loudly
  in the engine package instead of silently producing zero-coverage green runs.
  The guard is currently scoped to `forge-workflow-engine`, where the defect
  occurred; extending it to the other five packages remains open.
- Missing adapter dependencies degrade to a logged warning and skipped owner
  matching, as originally designed, rather than aborting the run.
- The docs no longer promise automation that does not exist. **Implementing that
  automation** — having bootstrap or engine-prep actually install per-skill
  dependencies — is deliberately left as separate follow-up work.
- Three pre-existing failures remain outside this change's scope and were
  confirmed as such against a pristine baseline: two Windows portability defects
  in `forge-launcher` (`expandPath` handling of `~`/`$VAR`, and the console server
  test) and one in `forge-execution-adapter` (`discoverForgeRepo` on the
  decomposed feature layout).
