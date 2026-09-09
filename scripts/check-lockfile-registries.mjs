#!/usr/bin/env node
// Fails when a committed lockfile pins a package to a non-canonical registry host.
//
// npm substitutes the configured registry for the canonical registry.npmjs.org
// host, so an npmjs-pinned lockfile installs correctly both from the public
// internet and from behind a corporate proxy or mirror. A lockfile that
// hard-codes a specific mirror gets no such substitution: it pins that one host
// for every consumer, and it leaks the generating machine's feed configuration
// into the repository.
//
// This is easy to reintroduce by accident - simply running `npm install` on a
// machine whose ~/.npmrc points at a mirror rewrites every `resolved` URL.
//
// Usage: node scripts/check-lockfile-registries.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CANONICAL_HOST = "registry.npmjs.org";

function trackedLockfiles() {
  // git ls-files keeps this to committed paths, so generated or untracked
  // trees that happen to contain a lockfile are never inspected.
  const out = execFileSync("git", ["ls-files", "*package-lock.json"], { encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function offendersIn(file) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: could not be parsed as JSON - ${err.message}`);
  }

  const found = new Map();
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    const resolved = entry?.resolved;
    // Absent for the root entry; non-http for `link:` and `file:` deps.
    if (typeof resolved !== "string" || !resolved.startsWith("http")) continue;

    let host;
    try {
      host = new URL(resolved).host;
    } catch {
      throw new Error(`${file}: ${name || "<root>"} has an unparseable resolved URL: ${resolved}`);
    }
    if (host === CANONICAL_HOST) continue;

    if (!found.has(host)) found.set(host, []);
    found.get(host).push(name || "<root>");
  }
  return found;
}

const files = trackedLockfiles();
if (files.length === 0) {
  console.error("check-lockfile-registries: no tracked package-lock.json files found.");
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const found = offendersIn(file);
  if (found.size === 0) {
    console.log(`ok   ${file}`);
    continue;
  }
  failed = true;
  console.error(`FAIL ${file}`);
  for (const [host, pkgs] of found) {
    console.error(`       ${pkgs.length} package(s) pinned to ${host}`);
    for (const p of pkgs.slice(0, 5)) console.error(`         - ${p}`);
    if (pkgs.length > 5) console.error(`         ... and ${pkgs.length - 5} more`);
  }
}

if (failed) {
  console.error("");
  console.error(`Every 'resolved' URL must use ${CANONICAL_HOST}.`);
  console.error("This usually means npm install ran against a mirror or proxy. Keep that");
  console.error("registry in your user-level ~/.npmrc - never in a committed .npmrc - and");
  console.error("regenerate the lockfile, or rewrite the mirror prefix back to");
  console.error(`https://${CANONICAL_HOST}/ (the integrity hashes stay valid).`);
  process.exit(1);
}

console.log(`\nAll ${files.length} tracked lockfile(s) pin ${CANONICAL_HOST}.`);
