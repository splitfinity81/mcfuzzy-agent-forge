import fs from "node:fs";
import path from "node:path";
import { loadEngineConfig } from "../engine-config.ts";
import { commandExists, envFlagOrUndefined } from "./env.ts";
import { type HarnessName, state } from "./state.ts";

// --- Resume: re-enter an existing project at the current stage --------------

export interface ResumeOptions {
  repo?: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
}

export interface ResumeEngineState {
  runId?: string;
  status?: string;
  harness?: string;
  currentPhase?: string;
  tasks?: Record<string, { taskId?: string; status?: string; errorMessage?: string; outputFiles?: string[] }>;
  blockers?: string[];
}

/** Detects which harness root a repo was bootstrapped with. */
export function detectHarnessForRepo(repoDir: string): { harness: HarnessName; label: string } {
  const roots: Array<[HarnessName, string]> = [
    ["opencode", ".opencode"],
    ["github", ".github"],
    ["claude", ".claude"],
    ["agents", ".agents"],
  ];
  const bootstrapped = roots.find(([, root]) =>
    fs.existsSync(path.join(repoDir, root, "agents")) ||
    fs.existsSync(path.join(repoDir, root, "skills")));
  const [harness] = bootstrapped ?? (["agents", ".agents"] as [HarnessName, string]);
  const labels: Record<HarnessName, string> = {
    github: "GitHub Copilot",
    opencode: "opencode",
    claude: "Claude Code",
    agents: "Generic .agents",
  };
  return { harness, label: labels[harness] };
}

/** Re-populates the module state from an existing repo (resume entry point). */
export function setupStateForRepo(repoDir: string): void {
  const { harness, label } = detectHarnessForRepo(repoDir);
  state.repoDir = repoDir;
  state.harness = harness;
  state.harnessLabel = label;
  state.remoteCreated = false;
  state.ghAvailable = commandExists("gh");
  state.copilotAvailable = commandExists("copilot");
  state.opencodeAvailable = commandExists("opencode");
  state.claudeAvailable = commandExists("claude");
  state.prdAdded = fs.existsSync(path.join(repoDir, "docs", "PRD.md"));
  state.researchAdded = fs.existsSync(path.join(repoDir, "docs", "research"));
  state.engineStarted = false;
  // Start from any persisted engine config (docs/engine-config.json), then let
  // explicit environment variables win over it.
  const persisted = loadEngineConfig(repoDir);
  state.engineConfig.harness = process.env.FORGE_ENGINE_HARNESS ?? persisted?.harness ?? "opencode";
  state.engineConfig.granularity = process.env.FORGE_ENGINE_GRANULARITY ?? persisted?.granularity ?? "";
  state.engineConfig.concurrency = process.env.FORGE_ENGINE_CONCURRENCY ?? persisted?.concurrency ?? "";
  state.engineConfig.taskTimeoutMs = process.env.FORGE_ENGINE_TASK_TIMEOUT_MS ?? persisted?.taskTimeoutMs ?? "";
  state.engineConfig.maxRetries = process.env.FORGE_ENGINE_MAX_RETRIES ?? persisted?.maxRetries ?? "";
  state.engineConfig.viz = envFlagOrUndefined("FORGE_ENGINE_VIZ") ?? persisted?.viz ?? false;
  state.engineConfig.vizPort = process.env.FORGE_ENGINE_VIZ_PORT ?? persisted?.vizPort ?? "";
  state.engineConfig.keepAlive = envFlagOrUndefined("FORGE_ENGINE_ATTACH") ?? persisted?.keepAlive ?? false;
  state.engineConfig.attach = process.env.FORGE_ENGINE_ATTACH_URL ?? persisted?.attach ?? "";
  state.engineConfig.autoCommit = envFlagOrUndefined("FORGE_ENGINE_AUTO_COMMIT") ?? persisted?.autoCommit ?? true;
  state.engineConfig.executionMode = persisted?.executionMode === "manual" ? "manual" : "auto";
  state.engineConfig.selectionScope = persisted?.selectionScope === "single" || persisted?.selectionScope === "range" || persisted?.selectionScope === "list"
    ? persisted.selectionScope
    : undefined;
  state.engineConfig.selectedTaskIds = Array.isArray(persisted?.selectedTaskIds)
    ? persisted!.selectedTaskIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
}

export function readEngineState(): ResumeEngineState | null {
  const sp = path.join(state.repoDir, "docs", "WORKFLOW-STATE.json");
  if (!fs.existsSync(sp)) return null;
  try {
    return JSON.parse(fs.readFileSync(sp, "utf8")) as ResumeEngineState;
  } catch {
    return null;
  }
}

export function prdDocName(): string {
  return fs.existsSync(path.join(state.repoDir, "docs", "product-vision.md"))
    ? "product-vision.md (decomposed)"
    : "PRD.md";
}

