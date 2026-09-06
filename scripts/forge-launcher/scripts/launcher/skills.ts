import fs from "node:fs";
import path from "node:path";
import { command, out, printLogTail, warn } from "../format.ts";
import { debugMode, envFlag } from "./env.ts";
import { harnessAgentsDir, hasGeneratedTeam, hasPrd, skillPathFor } from "./harness-paths.ts";
import { runLogFile, runLoggedStep } from "./log.ts";
import { type HarnessName, type LauncherOptions, state } from "./state.ts";

export function prdSourceForTeam(): string {
  if (
    fs.existsSync(path.join(state.repoDir, "docs", "product-vision.md")) &&
    fs.existsSync(path.join(state.repoDir, "docs", "features"))
  ) {
    const features = fs.readdirSync(path.join(state.repoDir, "docs", "features")).filter((f) => f.endsWith(".md"));
    if (features.length) {
      return "the decomposed PRD representation (docs/product-vision.md + docs/features/*.md)";
    }
  }
  return "docs/PRD.md";
}

export function buildTeamPrompt(prdSource: string, harness: HarnessName): string {
  const harnessRoot = harness === "github"
    ? ".github"
    : harness === "claude"
      ? ".claude"
      : harness === "opencode"
        ? ".opencode"
        : ".agents";
  return `/forge-build-agent-team Use ${prdSource} to build the agent team. ` +
    `Write agent files under ${harnessRoot}/agents/ and skill files under ${harnessRoot}/skills/.`;
}

// --- auto-build command selection ------------------------------------------

/** Headless PRD-creation invocation: auto-proceed with defaults, then run the
 * same PRD gap check the manual flow does (acceptance criteria, tech stack,
 * non-functional requirements, phases) and fill any gaps before approving. */
export const PRD_HEADLESS_MSG =
  "Use docs/IDEA.md as the project idea. Headless mode: auto-proceed with default assumptions and approve the PRD. After drafting, run a PRD gap check: every major component must have clear acceptance criteria, a defined tech stack, non-functional requirements (performance, security, privacy), and implementation phases; fill any gaps before approving.";

export const EXISTING_PROJECT_PRD_MSG =
  "Author the project's PRD using forge-build-prd authoring semantics, not an auto-build or implementation workflow. This is an existing repository: inspect source code, documentation, tests, package manifests, configuration, and git history as context; infer the product purpose and current capabilities. Produce docs/PRD.md as a project PRD. Headless mode: ask no questions and use explicit assumptions. Include functional requirements with acceptance criteria, technology stack, non-functional requirements (performance, security, privacy), constraints, and implementation phases. Do not implement code, generate agents, compile a manifest, or run the workflow.";

/**
 * In-harness command to queue when the launcher opens the CLI (or prints
 * next steps). Conditional on the team so the harness entry honours the
 * "in the harness = project-orchestrator" rule when possible:
 *   - team exists    → /forge-orchestrate-build (project-orchestrator)
 *   - PRD, no team   → /forge-auto-build (generates the team in-chat first)
 *   - no PRD         → /forge-auto-build-prd (idea → PRD)
 */
export function autobuildCommand(): string {
  if (!hasPrd()) return "/forge-auto-build-prd Use docs/IDEA.md as the project idea";
  if (hasGeneratedTeam()) return "/forge-orchestrate-build Use docs/PRD.md as the project PRD";
  return "/forge-auto-build Use docs/PRD.md as the project PRD";
}

/** Headless (terminal-driven) skill invocation - no chat session, so it keeps
 *  using forge-auto-build as the launcher-driven fast-path rather than the
 *  in-harness orchestrators. */
export function headlessSkillMsg(): string {
  if (hasPrd()) {
    if (envFlag("FORGE_WORKFLOW_ENGINE")) {
      return "/forge-auto-build Use docs/PRD.md as the project PRD. GO --workflow-engine";
    }
    return "/forge-auto-build Use docs/PRD.md as the project PRD. GO";
  }
  return `/forge-auto-build-prd ${PRD_HEADLESS_MSG}`;
}

export function headlessRunner(): string {
  const runner = process.env.FORGE_RUN_WITH;
  if (runner) return runner;
  return state.harness === "github" ? "copilot" : "opencode";
}

export function headlessCmdFor(msg: string): string {
  const runner = headlessRunner();
  if (runner === "copilot") return `copilot -p "${msg}" --yolo`;
  if (runner === "stub") return `stub (writes canned artifacts)`;
  return `opencode run --auto --dir "${state.repoDir}" "${msg}"`;
}

/** Extracts the skill name from a skill invocation message ("/name rest…"). */
export function skillNameFromMsg(msg: string): string {
  const first = msg.trim().split(/\s+/)[0] ?? "";
  return first.replace(/^\/+/, "");
}

/**
 * Runs a skill invocation headlessly. Returns true when the skill was found and
 * executed (exit 0), false when the skill file is missing from the harness dir.
 * Sets FORGE_HEADLESS=1 for the child so the forge skills' headless gate fires
 * deterministically. Honors FORGE_RUN_WITH=stub for offline testing.
 */
export async function runSkillHeadless(msg: string, opts: LauncherOptions): Promise<boolean> {
  const cmdStr = headlessCmdFor(msg);
  command(cmdStr);
  if (opts.dryRun) {
    warn("Dry-run: command printed, not executed.");
    return true;
  }

  const skillName = skillNameFromMsg(msg);
  if (skillName && !fs.existsSync(skillPathFor(skillName))) {
    warn(`Skill not found: ${skillPathFor(skillName)}`);
    warn("The repo may not have been bootstrapped for this harness, or the skill was renamed.");
    out(`    Run it manually instead: ${cmdStr}`);
    return false;
  }

  const runner = headlessRunner();
  if (runner === "stub") {
    return runStubSkill(msg, opts);
  }

  const args = runner === "copilot"
    ? ["-p", msg, "--yolo"]
    : debugMode()
      ? ["run", "--auto", "--dir", state.repoDir, "--print-logs", msg]
      : ["run", "--auto", "--dir", state.repoDir, msg];
  const code = await runLoggedStep("Running the skill (may take a while)", runner, args, {
    cwd: state.repoDir,
    dryRun: opts.dryRun,
    env: { FORGE_HEADLESS: "1" },
  });
  if (code !== 0) throw new Error(`Skill runner exited with code ${code}`);
  if (debugMode()) printLogTail(runLogFile(), 40);
  return true;
}

/**
 * Offline skill runner used by tests (FORGE_RUN_WITH=stub). Writes the artifact
 * a real skill would produce so the auto-draft success/failure paths are
 * testable without a model. FORGE_STUB_NOOP=1 writes nothing (failure path).
 */
export async function runStubSkill(msg: string, opts: LauncherOptions): Promise<boolean> {
  if (opts.dryRun) {
    warn("Dry-run: stub would write its canned artifact.");
    return true;
  }
  const logFile = runLogFile();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const noop = process.env.FORGE_STUB_NOOP === "1";
  const skillName = skillNameFromMsg(msg);

  fs.appendFileSync(logFile, `[stub] invoking ${skillName}${noop ? " (noop)" : ""}\n`);

  if (noop) return true;

  if (skillName.includes("forge-auto-build-prd") || skillName.includes("forge-build-prd")) {
    const prd = path.join(state.repoDir, "docs", "PRD.md");
    fs.mkdirSync(path.dirname(prd), { recursive: true });
    fs.writeFileSync(prd, [
      "# PRD",
      "",
      "> Auto-drafted by the forge-launcher stub skill runner (FORGE_RUN_WITH=stub).",
      "",
      "## Overview",
      "Stub PRD for testing the auto-draft flow.",
      "",
      "## Functional Requirements",
      "- FR-1: stub requirement",
      "",
      "## Implementation Phases",
      "- Phase 1: stub",
      "",
      "## Acceptance Criteria",
      "- AC-1: stub",
      "",
    ].join("\n"));
    fs.appendFileSync(logFile, "[stub] wrote docs/PRD.md\n");
    return true;
  }

  if (skillName.includes("forge-build-agent-team")) {
    const agentFile = path.join(harnessAgentsDir(), "stub-project-agent.md");
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, [
      "---",
      "name: stub-project-agent",
      "description: Stub project agent generated by the forge-launcher stub skill runner.",
      "---",
      "# Stub Project Agent",
      "",
      "Generated for testing the auto-draft team flow.",
      "",
    ].join("\n"));
    fs.appendFileSync(logFile, `[stub] wrote ${agentFile}\n`);
    return true;
  }

  if (skillName.includes("forge-build-feature-prd")) {
    const feature = path.join(state.repoDir, "docs", "features", "stub-feature.md");
    fs.mkdirSync(path.dirname(feature), { recursive: true });
    fs.writeFileSync(feature, "# Stub Feature\n\n## Functional Requirements\n- FR-1: implement the stub feature.\n");
    fs.appendFileSync(logFile, `[stub] wrote ${feature}\n`);
    return true;
  }

  if (skillName.includes("forge-orchestrate-build")) {
    const progress = path.join(state.repoDir, "docs", "PROGRESS.md");
    fs.mkdirSync(path.dirname(progress), { recursive: true });
    fs.writeFileSync(progress, [
      "# Project Progress",
      "",
      "> Auto-drafted execution plan by the forge-launcher stub skill runner.",
      "",
      "## Phase 1: stub",
      "- [ ] Task 1: stub",
      "",
    ].join("\n"));
    fs.appendFileSync(logFile, "[stub] wrote docs/PROGRESS.md\n");
    return true;
  }

  fs.appendFileSync(logFile, `[stub] no canned artifact for ${skillName}\n`);
  return true;
}
