# ADR-045: Decompose the launcher monolith into a barrel plus focused modules

**Status:** Accepted
**Date:** 2026-09-30

## Context

`scripts/forge-launcher/scripts/launcher.ts` had grown to **2173 lines / 92 KB** holding
95 top-level declarations: the nine-step bootstrap flow, the resume path, the `run*`
command surface used by `cli.ts`, engine control, plan drafting, skill invocation,
feature-increment bookkeeping, path helpers and logging. Every one of those concerns
was reachable from every other, so any change meant reading past the other eight.

Two properties made a naive split risky:

- A module-level mutable singleton, `state`, was referenced **222 times** across
  50 of the 95 declarations. Threading it through parameters would have touched
  nearly every function signature in the file.
- Three modules import from it: `cli.ts`, `console/control.ts` and `launcher.test.ts`.
  Any change to the public surface risked breaking the 109-test safety net that was
  the only evidence the refactor was behaviour-preserving.

## Decision

Split the file into eleven modules under `scripts/launcher/`, and **keep `launcher.ts`
as a barrel** that re-exports the same public symbols.

`state` stays a singleton and simply relocates to `launcher/state.ts`. A module-level
`const` object is shared by reference, so identity is preserved with no parameter
threading and no change to how any call site reads or writes it.

The resulting dependency order has no cycles:

```
env -> state -> harness-paths -> log -> {feature-increment, skills}
    -> plan -> engine -> repo-state -> commands -> resume -> launcher.ts
```

| Module | Lines | Holds |
| --- | ---: | --- |
| `launcher.ts` (barrel) | 113 | public re-exports, `completionSummary`, `runLauncher` |
| `launcher/bootstrap-flow.ts` | 494 | steps 1-8: pre-flight, harness, repo, bootstrap, idea, PRD, commit, auto-build |
| `launcher/resume.ts` | 289 | `runResume` and the per-step resume decisions |
| `launcher/commands.ts` | 265 | the `run*` surface `cli.ts` calls |
| `launcher/engine.ts` | 259 | engine args, detached runs, stop, auto-draft menu, `openCliFor` |
| `launcher/skills.ts` | 220 | headless skill invocation and prompt construction |
| `launcher/plan.ts` | 216 | plan validation, draft commit, resume pauses |
| `launcher/repo-state.ts` | 96 | repo detection and engine-state readers shared by resume and commands |
| `launcher/feature-increment.ts` | 96 | snapshot/compare/validate |
| `launcher/state.ts` | 79 | `LauncherOptions`, `LauncherState`, the `state` singleton |
| `launcher/env.ts` | 59 | environment probes, `CLI_ENTRY`, `commandExists` |
| `launcher/harness-paths.ts` | 58 | harness directory resolution |
| `launcher/log.ts` | 41 | run log file and logged steps |

Work proceeded in six tranches, each typechecked, linted and tested before the next.
The pure, state-free clusters went first because all seven test-imported symbols are
state-free, so the safety net stayed meaningful from the first commit.

## Consequences

- `cli.ts`, `console/control.ts` and `launcher.test.ts` were **never edited**. The
  barrel absorbed the entire change, which is what made it safe to verify each tranche
  against an unmodified test suite.
- Total line count rose slightly, from 2173 to 2285, the cost of explicit import
  headers. That is the intended trade: imports now document each module's actual
  dependencies instead of leaving them implicit in one shared scope.
- One genuine cycle appeared and was broken by moving symbols rather than merging
  modules. The resume cluster and the commands cluster referenced each other: the
  shared repo/engine-state readers were hoisted into `repo-state.ts`, and `openCliFor`
  moved upstream into `engine.ts`. Measuring the cycle at symbol granularity, rather
  than at module granularity, is what kept the fix to two small moves.

## Notes for future splits

Three traps cost real time and are worth recording.

- **Include `let` and `var` in any declaration-matching regex.** A mapper that matched
  only `function|const|class|interface|type|enum` silently swept a top-level
  `let stopped = false` into the wrong module. An ESM `let` export is a read-only
  binding for importers, so it could not simply be exported and reassigned across the
  new boundary; it became `state.stopped` instead.
- **An odd type error on a moved function usually means a DOM global shadowed a
  missing import.** Omitting `prompt` from `commands.ts` did not produce "cannot find
  name" - it bound to `window.prompt` and surfaced as a confusing assignability error
  that would have failed at runtime. `prompt`, `name`, `status`, `close`, `location`
  and `focus` all behave this way.
- **Do not automate import pruning from a linter's byte ranges.** Biome coalesces the
  range from the first unused specifier to the last, so used specifiers sitting between
  them fall inside the reported span. A script that split that span removed four live
  symbols. Deriving each header from the symbols actually referenced in the module body,
  then letting `tsc` reject over-removal and the linter flag the residue, is both
  simpler and correct. Note that `noUnusedLocals` is **not** set in this package, so the
  linter is the only thing that catches an unused import.
