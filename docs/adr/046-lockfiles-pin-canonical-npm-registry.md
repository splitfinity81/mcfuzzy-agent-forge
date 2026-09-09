# ADR-046: Lockfiles pin the canonical npm registry, not a mirror

**Status:** Accepted
**Date:** 2026-09-07

## Context

Two committed lockfiles resolved their packages from a Microsoft package mirror
rather than from npm:

| Lockfile | `resolved` hosts |
| --- | --- |
| `package-lock.json` | `ms-feed-25.pkgs.visualstudio.com` (9 entries) |
| `templates/skills/skill-review/package-lock.json` | `ms-feed-2/-12/-17/-25.pkgs.visualstudio.com` (67 entries) |

The other four lockfiles pinned `registry.npmjs.org`, so the repository was
internally inconsistent.

The cause is environmental rather than deliberate. On a Microsoft-managed
network `registry.npmjs.org` is unreachable - the TLS handshake is terminated
with `SEC_E_ILLEGAL_MESSAGE` - and npm is pointed at
`https://packagefeedproxy.microsoft.io/npm/` in the developer's **user-level**
`~/.npmrc`. That proxy redirects to `1es-public/_packaging/npm-public` on a
numbered `ms-feed-N` host, and npm records the redirect target as the `resolved`
URL. Any `npm install` run on such a machine rewrites every URL in the lockfile,
which is why this arrived silently in an otherwise ordinary dependency update.

Nothing was visibly broken: the `1es-public` feed is anonymously readable, so
CI stayed green. The problem is what the pinning implies. Those 76 entries force
one specific mirror host on every consumer of this repository, they leak the
generating machine's feed configuration into a public repo, and they will fail
in a way that is hard to diagnose if a numbered feed host is ever retired,
renumbered or access-restricted.

## Decision

**Committed lockfiles pin `registry.npmjs.org`. A mirror belongs in the
user-level `~/.npmrc`, never in a committed `.npmrc`.**

This works because npm substitutes the *configured* registry for the canonical
npmjs host at install time. Verified directly: on a machine where
`registry.npmjs.org` is TLS-blocked, `npm ci` against an npmjs-pinned lockfile
completed in 12 seconds, fetching through the proxy. The canonical host is
therefore the portable choice - it resolves correctly both on the public
internet and behind a mirror, which no hard-coded mirror host can do.

The 76 offending URLs were rewritten by replacing the mirror prefix with
`https://registry.npmjs.org/`. Only `resolved` lines changed - 76 insertions and
76 deletions, one per URL. The `integrity` hashes are hashes of the tarball
contents and are independent of the host that serves them, so they remain valid
and did not need regenerating; both affected lockfiles were confirmed to install
cleanly from scratch afterwards.

A committed `.npmrc` pointing at the proxy was rejected as the alternative. It
would make every public CI run and every external contributor depend on a
Microsoft-internal hostname they cannot reach, trading a latent inconsistency
for a guaranteed outage.

## Consequences

- `scripts/check-lockfile-registries.mjs` enforces this. It reads tracked
  lockfiles via `git ls-files`, so generated or untracked trees that happen to
  contain a lockfile are never inspected, and it fails with the offending host,
  the package names and the remedy. It runs in CI as part of the existing lint
  job, which already installs the root manifest, so no new job was added.
- The guard is deliberately a repo-level check rather than a lint rule: the
  failure mode is invisible in a diff review of a 900-line lockfile, and it is
  reintroduced by running an ordinary `npm install` on the wrong network.
- Developers on a mirrored network need no repository-specific setup. Their
  existing user-level `~/.npmrc` continues to work, and the guard tells them
  immediately if an install rewrote a lockfile they are about to commit.
