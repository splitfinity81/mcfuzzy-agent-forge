#!/usr/bin/env node
// Guard against a silent zero-coverage test run.
//
// `node --test <glob>` exits 0 when the glob matches no files, so a quoting or
// path mistake turns the suite green while running nothing. That happened here:
// the pattern was single-quoted in package.json, and PowerShell does not strip
// single quotes, so Node received a literal path that matched nothing and the
// whole suite silently reported "tests 0" with exit 0.
//
// Run as `pretest` so the real suite never starts unless test files were found.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
// Packages differ in test-file extension (.test.ts under tsx, .test.mjs for
// plain Node), so the suffix is passed in from the pretest script.
const TEST_SUFFIX = process.argv[2] ?? ".test.ts";

// Walk manually rather than using readdirSync({ recursive: true }), which is
// only available from Node 18.17; this package supports node >= 18.
function countTestFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    if (entry.isDirectory()) {
      total += countTestFiles(join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
      total += 1;
    }
  }
  return total;
}

const found = countTestFiles(SCRIPTS_DIR);

if (found === 0) {
  console.error(
    `[pretest] No ${TEST_SUFFIX} files found under ${SCRIPTS_DIR}.\n` +
      `[pretest] Refusing to run: 'node --test' would exit 0 without running anything.\n` +
      `[pretest] Check the test glob in package.json - an over-quoted pattern is passed ` +
      `through literally by PowerShell and matches nothing.`,
  );
  process.exit(1);
}

console.log(`[pretest] Discovered ${found} test file(s).`);
