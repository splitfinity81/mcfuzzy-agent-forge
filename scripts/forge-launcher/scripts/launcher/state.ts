import { envFlag } from "./env.ts";

export interface LauncherOptions {
  nonInteractive?: boolean;
  headless?: boolean;
  draft?: boolean;
  dryRun?: boolean;
}

export type HarnessName = "github" | "opencode" | "claude" | "agents";

export function defaultEngineHarness(harness: HarnessName): string {
  return harness === "github" ? "copilot" : "opencode";
}

export interface LauncherState {
  harness: HarnessName;
  harnessLabel: string;
  repoDir: string;
  remoteCreated: boolean;
  ghAvailable: boolean;
  copilotAvailable: boolean;
  opencodeAvailable: boolean;
  claudeAvailable: boolean;
  prdAdded: boolean;
  researchAdded: boolean;
  engineStarted: boolean;
  stopped: boolean;
  engineConfig: {
    harness: string;
    granularity: string;
    concurrency: string;
    taskTimeoutMs: string;
    maxRetries: string;
    viz: boolean;
    vizPort: string;
    keepAlive: boolean;
    attach: string;
    autoCommit: boolean;
    executionMode: "auto" | "manual";
    selectionScope?: "single" | "range" | "list";
    selectedTaskIds: string[];
  };
}

/**
 * Mutable singleton for one launcher run. Imported rather than threaded through
 * call signatures: the launcher is a single-run CLI process and every step reads
 * or updates the same run context.
 */
export const state: LauncherState = {
  harness: "agents",
  harnessLabel: "Generic .agents",
  repoDir: "",
  remoteCreated: false,
  ghAvailable: false,
  copilotAvailable: false,
  opencodeAvailable: false,
  claudeAvailable: false,
  prdAdded: false,
  researchAdded: false,
  engineStarted: false,
  stopped: false,
  engineConfig: {
    harness: process.env.FORGE_ENGINE_HARNESS ?? "opencode",
    granularity: process.env.FORGE_ENGINE_GRANULARITY ?? "",
    concurrency: process.env.FORGE_ENGINE_CONCURRENCY ?? "",
    taskTimeoutMs: process.env.FORGE_ENGINE_TASK_TIMEOUT_MS ?? "",
    maxRetries: process.env.FORGE_ENGINE_MAX_RETRIES ?? "",
    viz: envFlag("FORGE_ENGINE_VIZ"),
    vizPort: process.env.FORGE_ENGINE_VIZ_PORT ?? "",
    keepAlive: envFlag("FORGE_ENGINE_ATTACH"),
    attach: process.env.FORGE_ENGINE_ATTACH_URL ?? "",
    autoCommit: process.env.FORGE_ENGINE_AUTO_COMMIT !== "0",
    executionMode: "auto",
    selectionScope: undefined,
    selectedTaskIds: [],
  },
};
