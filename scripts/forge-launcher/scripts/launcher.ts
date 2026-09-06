import path from "node:path";
import { header, out, step, warn } from "./format.ts";
import { prompts } from "./prompts.ts";
import { hasGeneratedTeam, hasPrd } from "./launcher/harness-paths.ts";
import { type LauncherOptions, state } from "./launcher/state.ts";
import { autobuildCommand } from "./launcher/skills.ts";
import { pauseForResume } from "./launcher/plan.ts";
import { engineRunArgs } from "./launcher/engine.ts";
import { addPrdAndResearch, bootstrapForge, captureIdea, commitBootstrap, createRepo, launchAutobuild, preflightCheck, selectHarness } from "./launcher/bootstrap-flow.ts";
import { resumeSummary } from "./launcher/resume.ts";

// Public API preserved for cli.ts, console/control.ts and the test suite.
export { engineDetachedCommand } from "./launcher/env.ts";
export { defaultEngineHarness, type LauncherOptions } from "./launcher/state.ts";
export { compareFeatureIncrementFiles, snapshotFeatureIncrementFiles } from "./launcher/feature-increment.ts";
export type { FeatureIncrementFileChanges, FeatureIncrementSnapshot } from "./launcher/feature-increment.ts";
export { buildTeamPrompt, headlessSkillMsg } from "./launcher/skills.ts";
export { featureTaskIds, runCompileManifest, runDraftExistingPrd, runDraftPrd, runDraftTeam, runFeaturePrd, runFeatureIncrement } from "./launcher/commands.ts";
export { runResume } from "./launcher/resume.ts";

// --- Step 9: Summary -------------------------------------------------------

function completionSummary(): void {
  step("Step 9 of 9: Summary");
  out("");
  out("════════════════════════════════════════════════════════");
  out("  forge-launcher: Complete");
  out("════════════════════════════════════════════════════════");
  out("");
  out(`  Repository  : ${state.repoDir}`);
  out(`  Harness     : ${state.harnessLabel} (--harness ${state.harness})`);
  out(`  Remote      : ${state.remoteCreated ? "yes" : "none configured"}`);
  out(`  Idea file   : ${path.join(state.repoDir, "docs", "IDEA.md")}`);
  out(`  PRD         : ${state.prdAdded ? path.join(state.repoDir, "docs", "PRD.md") : "none (will be built from docs/IDEA.md by forge-auto-build-prd)"}`);
  out(`  Research    : ${state.researchAdded ? path.join(state.repoDir, "docs", "research") + "/" : "none"}`);
  out("");
  out("  Next steps:");
  out("");
  if (state.engineStarted) {
    out("  1. The workflow engine is building the project in the background");
    out("     (it keeps running after this launcher exits).");
    out("  2. Monitor progress from another terminal:");
    out("");
    out(`       tail -f ${path.join(state.repoDir, "docs", "engine-run.log")}`);
    out(`       tail -f ${path.join(state.repoDir, "docs", "PROGRESS.md")}`);
    out("");
    out(`  3. Re-run or resume the engine later if needed:`);
    out("");
    out(`       npx forge-launcher ${engineRunArgs().join(" ")}`);
    if (state.engineConfig.viz) {
      out("");
      out("  The Forge Board dashboard launches with the engine run; its URL");
      out("  is printed in docs/engine-run.log once the manifest is prepared.");
    }
  } else {
    out("  1. Open the project in your agent harness.");
    out("  2. Run the queued command:");
    out("");
    out(`       ${autobuildCommand()}`);
    out("");
    if (hasPrd() && hasGeneratedTeam()) {
      out("     (/forge-orchestrate-build drives the interactive build; use");
      out("      forge-launcher engine-run for autonomous execution instead.)");
    } else {
      out("  3. Review the pre-flight summary that the skill presents.");
      out("  4. Type GO to start the pipeline (add --workflow-engine to run the");
      out("     build through the workflow engine once the agent team is generated).");
    }
  }
  out("");
  out("  References:");
  out(`   • Prompt playbook : ${path.join(state.repoDir, "docs", "prompt-playbook.md")}`);
  const skillsRoot = state.harness === "github" ? ".github" : state.harness === "claude" ? ".claude" : state.harness === "opencode" ? ".opencode" : ".agents";
  out(`   • project-orchestrator   : ${path.join(state.repoDir, skillsRoot, "skills", "forge-orchestrate-build", "SKILL.md")}`);
  out(`   • workflow-engine        : ${path.join(state.repoDir, skillsRoot, "skills", "forge-workflow-engine", "SKILL.md")}`);
  out(`   • forge-auto-build-prd   : ${path.join(state.repoDir, skillsRoot, "skills", "forge-auto-build-prd", "SKILL.md")}`);
  out(`   • forge-auto-build       : ${path.join(state.repoDir, skillsRoot, "skills", "forge-auto-build", "SKILL.md")} (terminal/headless fast-path)`);
  out("       (paths may vary by harness)");
  out("");
}

// --- Entry -----------------------------------------------------------------

export async function runLauncher(opts: LauncherOptions = {}): Promise<number> {
  prompts.nonInteractive = Boolean(opts.nonInteractive);
  state.stopped = false;

  header();
  try {
    await preflightCheck();
    await selectHarness(opts);
    await createRepo(opts);
    await bootstrapForge(opts);
    await captureIdea(opts);
    await pauseForResume(opts, "idea captured");
    if (state.stopped) { resumeSummary(); return 0; }
    await addPrdAndResearch(opts);
    await pauseForResume(opts, "PRD added or skipped");
    if (state.stopped) { resumeSummary(); return 0; }
    await commitBootstrap();
    await launchAutobuild(opts);
    if (state.stopped) { resumeSummary(); return 0; }
    completionSummary();
    return 0;
  } catch (err) {
    if (err instanceof Error && err.message === "pre-flight failed") return 1;
    if (opts.dryRun) {
      warn(`Dry-run: stopped before executing: ${(err as Error).message}`);
      return 0;
    }
    throw err;
  }
}
