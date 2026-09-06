import fs from "node:fs";
import path from "node:path";
import { fail, info, out, warn } from "../format.ts";
import { harnessRootDir } from "./harness-paths.ts";
import { state } from "./state.ts";

export const FORGE_TEMPLATE_AGENTS = new Set(["forge-team-builder.md", "project-orchestrator.md", "workflow-orchestrator.md"]);

/**
 * Filesystem snapshot used by feature-increment team generation.  This is
 * deliberately a snapshot of the repository rather than git state: a caller
 * may have uncommitted work, and the guard must not mistake that work for the
 * result of the skill. Forge skills are excluded because team generation is
 * allowed to refresh them, while template agents are excluded because they
 * are bootstrap-owned rather than project-owned agents.
 */
export type FeatureIncrementSnapshot = Map<string, string>;

export function walkSnapshotFiles(dir: string, root: string, out: FeatureIncrementSnapshot): void {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const relative = path.relative(root, full);
    if (relative === ".git" || relative.startsWith(`.git${path.sep}`)) continue;
    const relativePosix = relative.split(path.sep).join("/");
    // The launcher appends its own diagnostic stream while the skill runs; it
    // is not a project change and must not make a valid team update fail.
    if (relativePosix === "docs/engine-run.log") continue;
    const forgeSkillsPrefix = `${harnessRootDir()}/skills/`;
    const projectAgentsPrefix = `${harnessRootDir()}/agents/`;
    // Only the selected harness's Forge skills are excluded. A project's own
    // src/skills (or another harness root) remains visible to the guard.
    if (relativePosix.startsWith(forgeSkillsPrefix)) continue;
    if (relativePosix.startsWith(projectAgentsPrefix) && FORGE_TEMPLATE_AGENTS.has(entry)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkSnapshotFiles(full, root, out);
    else if (stat.isFile()) out.set(relativePosix, fs.readFileSync(full, "utf8"));
  }
}

/** Snapshot all non-Forge-owned files before a feature team update. */
export function snapshotFeatureIncrementFiles(repoDir: string): FeatureIncrementSnapshot {
  const snapshot: FeatureIncrementSnapshot = new Map();
  walkSnapshotFiles(repoDir, repoDir, snapshot);
  return snapshot;
}

export interface FeatureIncrementFileChanges {
  addedAgents: string[];
  modifiedAgents: string[];
  deletedAgents: string[];
  unrelatedFiles: string[];
}

/** Compare a feature-increment snapshot, allowing only project-agent changes. */
export function compareFeatureIncrementFiles(
  before: FeatureIncrementSnapshot,
  repoDir: string,
): FeatureIncrementFileChanges {
  const after = snapshotFeatureIncrementFiles(repoDir);
  const changed = new Set([...before.keys(), ...after.keys()]);
  const result: FeatureIncrementFileChanges = { addedAgents: [], modifiedAgents: [], deletedAgents: [], unrelatedFiles: [] };
  for (const file of [...changed].sort()) {
    const oldValue = before.get(file);
    const newValue = after.get(file);
    if (oldValue === newValue) continue;
    const isAgent = file.startsWith(`${harnessRootDir()}/agents/`) && file.endsWith(".md");
    if (!isAgent) {
      result.unrelatedFiles.push(file);
    } else if (oldValue === undefined) {
      result.addedAgents.push(file);
    } else if (newValue === undefined) {
      // Feature increments must preserve untouched agents; deletion is never
      // an intended update, even though the file is project-owned.
      result.deletedAgents.push(file);
    } else {
      result.modifiedAgents.push(file);
    }
  }
  return result;
}

export function validateFeatureIncrementFiles(before: FeatureIncrementSnapshot): boolean {
  const changes = compareFeatureIncrementFiles(before, state.repoDir);
  const unexpected = [...changes.deletedAgents, ...changes.unrelatedFiles];
  if (unexpected.length === 0) {
    if (changes.addedAgents.length || changes.modifiedAgents.length) {
      info(`Feature increment preserved project agents; changed ${changes.addedAgents.length + changes.modifiedAgents.length} agent file(s).`);
    }
    return true;
  }
  fail("Feature increment changed files outside its intended project-agent update:");
  for (const file of unexpected) out(`    - ${file}`);
  warn("No team-update commit was created. Review and revert the unexpected changes before retrying.");
  return false;
}
