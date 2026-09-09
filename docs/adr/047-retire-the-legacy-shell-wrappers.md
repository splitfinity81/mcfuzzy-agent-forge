# ADR-047: Retire the legacy shell wrappers

**Status:** Accepted
**Date:** 2026-09-09

## Context

ADR-023 moved the forge CLI from duplicated bash and PowerShell implementations
into a single Node package at `scripts/forge-launcher`. Six delegating wrappers
were left behind so existing invocations kept working:

```
scripts/bootstrap.sh          scripts/bootstrap.ps1
scripts/forge-engine-run.sh   scripts/forge-engine-run.ps1
scripts/forge-launcher.sh     scripts/forge-launcher.ps1
```

Each carried a header declaring itself legacy and "scheduled for removal (see
ADR-023)". `plan.md` recorded the same intent: delete them once docs and tests
no longer referenced them. Two further scripts,
`scripts/test-forge-launcher.sh` and
`scripts/smoke-test-launcher-terminal-support.sh`, were listed alongside them.

Rather than a tidy-up, three measured findings decided this.

**The PowerShell wrappers were already broken.** All three test
`node_modules/.bin/tsx` with `Test-Path`. npm creates three files there - `tsx`,
`tsx.cmd` and `tsx.ps1` - and the extensionless `tsx` is a *bash* shim. On
Windows the test matches it, the wrapper executes it, and nothing happens:
exit 0, no output. Confirmed directly - `.\scripts\forge-launcher.ps1 --help`
and `.\scripts\bootstrap.ps1 --help` both produced no output, while
`npx tsx scripts/cli.ts --help` printed usage normally.

**`forge-launcher.ps1` also dropped every argument.** It expanded `@Args` inside
a function, where `$Args` is that function's own (empty) argument array rather
than the script's. `bootstrap.ps1` and `forge-engine-run.ps1` avoided this by
building `$Subcommand = @("...") + $args` at script scope. Reproduced minimally:
script scope saw 2 arguments, function scope saw 0.

**The smoke test had been failing since the launcher decomposition.**
`smoke-test-launcher-terminal-support.sh` asserted wiring by grepping
`launcher.ts` for identifier strings. ADR-045 split that file from 2173 lines to
113, moving `launchCliInTerminal` into `launcher/bootstrap-flow.ts`, so the grep
stopped matching. The script exits 1 today. Nothing noticed, because no CI job
ever ran it.

None of the nine scripts had any CI or code references; every reference was in
documentation.

## Decision

**Delete the six delegating wrappers and the two delegating test runners. Keep
`scripts/evaluate-ollama-models.sh`**, which is a genuine standalone research
tool rather than a CLI shim.

The Node package is the only entry point. A `start` script was added so a clone
still works without a global install or a build step:

```bash
cd scripts/forge-launcher
npm install
npm start          # arguments go after --, e.g. npm start -- --dry-run
```

`test-forge-launcher.sh` had already been reduced to `npm test` plus git
identity setup, so it was a husk. The smoke test needed more care: it was crude,
but it was the *only* coverage of terminal launching - there was no
`terminal.test.ts`, and `launchCliInTerminal` appeared nowhere in the 109-test
suite. Deleting it outright would have traded a broken check for no check.

It is therefore **replaced rather than removed**. `terminal.ts` now exports the
pure command builders (`posixLaunchScript`, `windowsLaunchScript`,
`POSIX_TERMINALS`) and `terminal.test.ts` covers them with 16 assertions.
Runtime behaviour is unchanged - the builders are the same expressions, lifted
out of the two launch functions.

The new tests assert what the greps could not: the shell quoting. POSIX escapes
a single quote by closing, escaping and reopening (`'\''`) while PowerShell
doubles it (`''`), and getting either wrong lets a quote in a path or argument
terminate the string and run as a command. Both forms are tested, including that
collapsing the POSIX idiom leaves balanced quotes. The tests were mutation-checked:
removing the POSIX escaping fails them, and applying POSIX-style escaping in the
PowerShell builder fails them too.

## Consequences

- The launcher test suite goes from 109 to 125 tests, and terminal-launch
  behaviour is now covered by CI on both Windows and Ubuntu - which the shell
  smoke test never was, on either.
- Nine documentation files were updated. `docs/`, `README.md` and a `SKILL.md`
  now show the package commands only. The Windows examples that used the
  wrapper's PowerShell-style flags (`-Headless`, `-NonInteractive`, `-DryRun`)
  are gone; the Node CLI takes the same `--flags` everywhere.
- ADRs, `docs/updates.md` and `docs/research/` keep their references. They are a
  historical record of when those scripts existed and are not rewritten.
  `plan.md` keeps its problem statement for the same reason; only its follow-up
  section is marked done.
- Anyone still invoking `./scripts/forge-launcher.sh` must switch to
  `forge-launcher` or `npm start`. On Windows this is strictly a fix, since
  those wrappers did nothing.

## Note

A grep-based test that asserts on source *contents* rots silently whenever code
moves, and reports success for the wrong reason. This one passed its
"launcher module exists" check for months while the behaviour it claimed to
cover had moved to another file. Assert on behaviour, and run it in CI.
