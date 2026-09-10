# ADR-048: Fix skill-review's harness detection, changed-file detection, and test discovery

**Status:** Accepted
**Date:** 2026-09-10

## Context

A reachability audit of the test suites - walking the import graph from every
`*.test.ts` rather than matching filenames - found 32 of 85 tracked source
modules unreachable from any test. Filename matching had been misleading in both
directions: `launcher/*.ts` looked untested but is reached through the
`launcher.ts` barrel, while `scripts/cli.ts` is exercised by four suites that
spawn it as a subprocess, which no import graph shows.

The largest gap in a *shipped* package was `templates/skills/skill-review`: one
test file covering one of its eight modules. That package is copied into every
bootstrapped repository, so anything wrong in it is wrong in every target repo.

Three defects were found there, each confirmed by reproduction before any change.

**1. New test files were silently ignored.** The package's test script named a
single file:

```
node --import tsx --test scripts/rubric.test.ts
```

Every other package globs (`scripts/*.test.ts`). Dropping a deliberately failing
canary test into `scripts/` proved it: `npm test` exited 0 without running it,
while the correct glob exited 1. The `pretest` guard from ADR-039 did not catch
this - it asserts that tests were discovered, and one was.

**2. `github`-harness repositories looked empty.** `detect.ts` searched
`.agents/skills`, `skills`, `.opencode/skills`, `.claude/skills` and
`templates/skills`, but not `.github/skills` - and its directory walker skipped
every dotted entry except `.agents`, `.opencode` and `.claude`, so it could not
have found it anyway. `github` is one of the four harnesses the launcher
bootstraps into, and `harness-paths.ts` searches all four. Measured on a
single-harness fixture per harness:

| Harness | `detectSkillDir` | `findSkillFiles` |
| --- | --- | --- |
| `.github` | **null** | **0** |
| `.agents` | `<root>/.agents/skills` | 1 |
| `.claude` | `<root>/.claude/skills` | 1 |
| `.opencode` | `<root>/.opencode/skills` | 1 |

**3. Changed-file detection never worked on Windows.** `getChangedSkillFiles`
built one shell string:

```
git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null || ...
```

`execSync` runs that through `cmd.exe` on Windows, where `2>/dev/null` is not
valid redirection. All three alternatives fail with "The system cannot find the
path specified", the command exits 1, `execSync` throws, and the `catch` returns
`[]` - so the function reports *no changed skills* on every Windows repository.
The `HEAD~1` fallback was unreachable for a second reason too: it sits in the
`else` branch of a `try` whose first statement throws whenever there is no
`origin` remote, which is also true on Linux.

## Decision

**Glob the tests.** `scripts/*.test.ts scripts/*/*.test.ts`, matching
`forge-workflow-engine`, which also has a nested directory (`providers/`).

**Derive the walker's dot-directory allowlist from the search list.** The two
lists drifting apart is what let `github` fall through the gap, so
`ALLOWED_DOT_DIRS` is now computed from `SKILL_DIRS` and cannot disagree with it.
Adding a harness means adding one entry.

**Run git as argv, not as a shell string.** Each candidate ref is a separate
`execFileSync` call with its own `try`, so one failing no longer skips the
fallbacks, and there is no shell syntax to be portable about. The chain is now
merge-base, then `HEAD~1`, then `git show` for a root commit where `HEAD~1` does
not resolve. Passing arguments as an array also removes the interpolation of a
ref into a command string.

`detect.test.ts` covers all five exported functions with 30 tests, including one
per harness. The tests were mutation-checked: removing `.github/skills` from the
search list fails them, and restoring the old hard-coded allowlist fails them.

## Consequences

- The package goes from 2 tests to 32, and the repository from 261 to 291.
- `skill-review` now works on `github`-harness repositories, which it never has.
  Since the skill is copied into bootstrapped repos, this was broken in every
  target repo created with `--harness github`.
- Changed-file detection works on Windows, and on any repository without an
  `origin` remote.
- `rubric.ts` (601 lines) still has only its original 73-line test, and the
  provider modules (`github`, `ado`, `gitlab`) remain untested. They are network
  integration points and want a different approach; this change deliberately
  covers the pure logic first.

## Note

Two of these three defects were invisible to CI and would have stayed invisible.
The test-discovery bug is the reason: a suite that silently skips files reports
success for work it never did, and it disguises the very gap that would have
surfaced the other two. When auditing coverage, check that the runner discovers
what you think it does before trusting any count it reports.
