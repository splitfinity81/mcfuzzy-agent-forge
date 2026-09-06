import fs from "node:fs";
import path from "node:path";
import { state } from "./state.ts";

export function hasPrd(): boolean {
  return (
    state.prdAdded ||
    fs.existsSync(path.join(state.repoDir, "docs", "PRD.md")) ||
    fs.existsSync(path.join(state.repoDir, "docs", "product-vision.md"))
  );
}

export function harnessRootDir(): string {
  switch (state.harness) {
    case "github": return ".github";
    case "claude": return ".claude";
    case "opencode": return ".opencode";
    default: return ".agents";
  }
}

export function harnessAgentsDir(): string {
  return path.join(state.repoDir, harnessRootDir(), "agents");
}

export function harnessSkillsDir(): string {
  return path.join(state.repoDir, harnessRootDir(), "skills");
}

export function skillPathFor(skillName: string): string {
  return path.join(state.repoDir, harnessRootDir(), "skills", skillName, "SKILL.md");
}

/** Locates the bootstrapped forge-workflow-engine package dir (any harness root). */
export function findEngineDir(repoDir: string): string | null {
  for (const root of [".agents", ".opencode", ".claude", ".github"]) {
    const candidate = path.join(repoDir, root, "skills", "forge-workflow-engine");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function findAdapterDir(repoDir: string): string | null {
  for (const root of [".agents", ".opencode", ".claude", ".github"]) {
    const candidate = path.join(repoDir, root, "skills", "forge-execution-adapter");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function hasGeneratedTeam(): boolean {
  const agentsDir = harnessAgentsDir();
  if (!fs.existsSync(agentsDir)) return false;
  const excluded = new Set(["forge-team-builder.md", "project-orchestrator.md", "workflow-orchestrator.md"]);
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md") && !excluded.has(f)).length > 0;
}
