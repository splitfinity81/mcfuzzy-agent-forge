# ADR-041: Remove unused dependencies rather than upgrade them

**Date:** 2026-09-30
**Status:** Accepted
**Relates to:** ADR-038 (portable npm install/test contract), ADR-040 (continuous integration)

---

## Context

`skill-review` reported one moderate advisory. The path was
`azure-devops-node-api` -> `typed-rest-client` -> `qs@6.15.3`, carrying
`GHSA-x5fp-wj9c-mxmx` (array-limit bypass) and `GHSA-4mjr-xmp4-gh2g` (denial of
service through an attacker-controlled `isBuffer`).

`npm audit` reported `fixAvailable: true`. That report was wrong, in a way worth
recording because the same shape will recur:

- `npm audit fix --dry-run` resolved to `added 0 removed 0 changed 0`. A genuine
  no-op, not a dry-run artefact.
- Both advisories name `qs@6.16.0` as the fixed version. `npm view qs versions`
  shows the highest published 6.x release is `6.15.3`. The fix was never
  released, so no resolution of the tree can satisfy it.
- Upgrading the top of the chain makes things worse rather than better.
  `azure-devops-node-api@17.0.0` depends on `typed-rest-client@3.1.0`, which
  pins `qs` to `6.15.3` exactly. The permissive range that at least *could*
  absorb a future patch becomes a hard pin on the vulnerable version.

At that point the only remaining question was whether the dependency was needed
at all. Two exhaustive searches - one scoped to the package, one across the
whole repository, both excluding `node_modules`, `.git`, and lockfiles - looked
for the package name, its aliases (`vso-node-api`), and its API surface
(`WebApi`, `getPersonalAccessTokenHandler`). They returned exactly one match:
the declaration in `package.json`.

The obvious counter-example does not hold.
`templates/skills/skill-review/scripts/providers/ado.ts` genuinely does talk to
Azure DevOps, but not through the SDK. It calls the REST API with the global
`fetch`, builds its own `Basic` and `Bearer` authorization headers, and imports
only `./provider.js`, `node:child_process`, and `node:path`.

## Decision

Remove `azure-devops-node-api` from `skill-review`.

More generally: when an advisory has no published fix, establish whether the
dependency is used before attempting to upgrade it. An unused dependency is
pure attack surface, and removal is the only remediation that is guaranteed to
work.

Dependency updates are automated from here. `.github/dependabot.yml` gives each
of the five packages that declare dependencies its own entry - there is no root
`package.json` to cover them collectively - and groups each package's updates
into a single pull request. `forge-build-agent-team` is deliberately excluded:
it declares no dependencies and ships no lockfile, so there is nothing to
update. GitHub Actions versions are tracked on the same weekly schedule, which
is what keeps the pinning decision in ADR-040 from silently rotting.

Alternatives rejected:

- **Upgrading `azure-devops-node-api` to v17.** Pins `qs` at the vulnerable
  version rather than moving off it, and pulls a major version of an SDK the
  code does not call.
- **An `overrides` entry forcing a newer `qs`.** There is no newer `qs` to force.
- **Suppressing the advisory.** It would suppress the finding for a package that
  should not have been present, and would keep the unused transitive tree
  installed.
- **Adding `npm audit` to CI now.** Only `skill-review` has been audited since
  the removal. The gate is worth adding once all six packages are known to be
  clean, but adding it against an unknown baseline would either fail
  immediately or need a severity threshold chosen to paper over whatever it
  found.

## Consequences

- `skill-review` goes from one moderate advisory to none, and from 90
  dependencies to 67. Typecheck and tests are unchanged at exit 0, which is the
  evidence that nothing depended on the removed package.
- The repository no longer has a known-unfixable advisory, so `npm audit` in CI
  becomes viable for the first time. It is not enabled yet, pending an audit of
  the other five packages.
- Dependency bumps now arrive as pull requests and run through the full
  Windows-and-Linux matrix from ADR-040, which is where an incompatible bump
  will be caught.
- Grouping updates per package trades granularity for volume: a grouped pull
  request that fails needs the offending dependency identified within it. With
  six ecosystems on a weekly schedule, ungrouped updates would be the larger
  problem.
- `ado.ts` continues to use `fetch` against the REST API directly. That was
  already true; this decision records it as intentional rather than accidental,
  so the SDK is not reintroduced on the assumption that it is needed.
