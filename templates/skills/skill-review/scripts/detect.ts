import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, type Stats } from "node:fs";
import { resolve, join, basename } from "node:path";

/**
 * Auto-detected skill directory search order.
 *
 * `.github/skills` is included because `github` is one of the harnesses the
 * forge bootstraps into, alongside `agents`, `claude` and `opencode`.
 */
const SKILL_DIRS = [
  ".agents/skills",
  "skills",
  ".github/skills",
  ".opencode/skills",
  ".claude/skills",
  "templates/skills",
];

/**
 * Dot-directories the walker is allowed to descend into, derived from
 * SKILL_DIRS so the two cannot drift apart. Every other dotted entry (`.git`,
 * `.vscode`, ...) is skipped.
 */
const ALLOWED_DOT_DIRS = new Set(
  SKILL_DIRS.map((d) => d.split("/")[0]).filter((d) => d.startsWith(".")),
);

/**
 * Returns the first skill directory that exists and contains at least one SKILL.md file.
 */
export function detectSkillDir(root: string): string | null {
  for (const dir of SKILL_DIRS) {
    const full = join(root, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    if (findSkillFiles(full).length > 0) return full;
  }
  return null;
}

/**
 * Recursively find all SKILL.md files under a directory.
 */
export function findSkillFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st: Stats;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry.startsWith(".") && !ALLOWED_DOT_DIRS.has(entry)) continue;
        if (entry === "node_modules") continue;
        walk(full);
      } else if (entry === "SKILL.md") {
        results.push(resolve(full));
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Get list of changed SKILL.md files from git diff.
 * Compares against the merge base with the upstream default branch when there is
 * one, otherwise against the previous commit.
 */
export function getChangedSkillFiles(root: string): string[] {
  // Each candidate runs as its own argv, not a shell string. The previous
  // implementation chained them with `2>/dev/null ||`, which is POSIX syntax:
  // execSync runs it through cmd.exe on Windows, where every alternative failed
  // and the throw skipped the HEAD~1 fallback entirely.
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { encoding: "utf-8", cwd: root, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };

  let mergeBase: string | null = null;
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    mergeBase = git(["merge-base", "HEAD", ref]);
    if (mergeBase) break;
  }

  // `HEAD~1` does not resolve on a root commit, so diff against the empty tree
  // to treat every tracked file as added.
  const diff =
    (mergeBase && git(["diff", "--name-only", "--diff-filter=ACMR", `${mergeBase}...HEAD`])) ??
    git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD~1"]) ??
    git(["show", "--name-only", "--diff-filter=ACMR", "--pretty=format:", "HEAD"]);

  if (diff === null) return []; // Not a git repository.

  return diff
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => p.endsWith("SKILL.md"))
    .map((p) => resolve(root, p))
    .filter((p) => existsSync(p));
}

/**
 * Filter out the skill-review skill itself from an audit list.
 */
export function excludeSelf(files: string[]): string[] {
  return files.filter((f) => {
    const dir = basename(resolve(f, ".."));
    return dir !== "skill-review";
  });
}

/**
 * Ensure listed files exist on disk.
 */
export function validateFiles(files: string[], root: string): { valid: string[]; missing: string[] } {
  const valid: string[] = [];
  const missing: string[] = [];

  for (const f of files) {
    const resolved = resolve(root, f);
    if (existsSync(resolved)) {
      valid.push(resolved);
    } else {
      missing.push(f);
    }
  }

  return { valid, missing };
}
