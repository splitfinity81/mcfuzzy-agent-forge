import fs from "node:fs";
import path from "node:path";
import { command, fail, info, link, ok, out } from "../format.ts";
import { prompt, prompts } from "../prompts.ts";
import { engineRunCli } from "../engine-run.ts";
import { findAdapterDir, harnessAgentsDir, hasGeneratedTeam, hasPrd } from "./harness-paths.ts";
import { authoringEvent, runLoggedStep } from "./log.ts";
import { state } from "./state.ts";
import { type ResumeEngineState, setupStateForRepo } from "./repo-state.ts";
import { engineRunArgs } from "./engine.ts";
import { diagnoseAutoDraftFail, draftCommit } from "./plan.ts";
import { buildTeamPrompt, EXISTING_PROJECT_PRD_MSG, PRD_HEADLESS_MSG, prdSourceForTeam, runSkillHeadless } from "./skills.ts";
import { snapshotFeatureIncrementFiles, validateFeatureIncrementFiles } from "./feature-increment.ts";

/**
 * Headless pipeline advancement for the Forge Console: draft the PRD from
 * docs/IDEA.md (when absent). Non-interactive by design — the console triggers
 * it, the user reviews the result (and comes back) in the UI.
 */
export async function runDraftPrd(repoDir: string): Promise<number> {
  setupStateForRepo(repoDir);
  if (hasPrd()) {
    out("PRD already exists.");
    return 0;
  }
  const ideaPath = path.join(repoDir, "docs", "IDEA.md");
  const context = fs.existsSync(ideaPath)
    ? "Use docs/IDEA.md as the project idea."
    : "This is an existing repository with no IDEA.md. Inspect the existing source code, docs, tests, package manifests, and git history as the project context; infer the product purpose and ask no questions.";
  out(fs.existsSync(ideaPath) ? "Auto-drafting the PRD from docs/IDEA.md (headless) …" : "Auto-drafting a context-aware PRD from the existing repository (headless) …");
  const ran = await runSkillHeadless(`/forge-auto-build-prd ${context} ${PRD_HEADLESS_MSG}`, { nonInteractive: true });
  if (!ran) return 1;
  await draftCommit("docs: add auto-drafted PRD");
  if (hasPrd()) {
    ok("PRD generated.");
    out(`    - ${link(path.join(repoDir, "docs", "PRD.md"))}`);
    return 0;
  }
  await diagnoseAutoDraftFail("forge-auto-build-prd");
  return 1;
}

/** Authors a project PRD from an existing repository without an IDEA.md. */
export async function runDraftExistingPrd(repoDir: string): Promise<number> {
  setupStateForRepo(repoDir);
  if (hasPrd()) { out("PRD already exists."); return 0; }
  out("Authoring a project PRD from the existing repository (headless) …");
  const skill = "forge-build-prd";
  const ran = await runSkillHeadless(`/${skill} ${EXISTING_PROJECT_PRD_MSG}`, { nonInteractive: true });
  if (!ran) return 1;
  await draftCommit("docs: add project PRD");
  if (hasPrd()) {
    ok("Project PRD generated.");
    out(`    - ${link(path.join(repoDir, "docs", "PRD.md"))}`);
    return 0;
  }
  await diagnoseAutoDraftFail(skill);
  return 1;
}

/** Authors a Feature PRD through the authoring skill; workflow execution is intentionally separate. */
export async function runFeaturePrd(repoDir: string, featurePrompt?: string): Promise<number> {
  setupStateForRepo(repoDir);
  authoringEvent("authoring.started", { operation: "feature-prd" });
  const featuresDir = path.join(repoDir, "docs", "features");
  const before = new Set(fs.existsSync(featuresDir)
    ? fs.readdirSync(featuresDir).filter((name) => name.endsWith(".md"))
    : []);
  if (!featurePrompt?.trim()) {
    if (prompts.nonInteractive) throw new Error("feature-prd requires --prompt in non-interactive mode");
    featurePrompt = await prompt("What feature should be added?", "");
  }
  if (!featurePrompt.trim()) return 1;
  const message = `/forge-build-feature-prd I want to add ${featurePrompt.trim()} to this project. Analyze the existing codebase and agent team, then produce a self-contained Feature PRD and save it under docs/features/. Do not modify the original PRD or start the workflow engine.`;
  const ran = await runSkillHeadless(message, { nonInteractive: true });
  if (!ran) {
    authoringEvent("authoring.failed", { operation: "feature-prd", stage: "authoring" });
    return 1;
  }
  const added = fs.existsSync(featuresDir)
    ? fs.readdirSync(featuresDir)
      .filter((name) => name.endsWith(".md") && !before.has(name))
      .filter((name) => fs.statSync(path.join(featuresDir, name)).isFile())
      .filter((name) => fs.readFileSync(path.join(featuresDir, name), "utf8").trim().length > 0)
    : [];
  if (added.length === 0) {
    fail("Feature PRD authoring exited without creating a new non-empty docs/features/*.md file.");
    await diagnoseAutoDraftFail("forge-build-feature-prd");
    authoringEvent("authoring.failed", { operation: "feature-prd", stage: "validation" });
    return 1;
  }
  await draftCommit("docs: add feature PRD");
  ok(`Feature PRD generated: ${added.join(", ")}`);
  authoringEvent("authoring.completed", { operation: "feature-prd", features: added });
  return 0;
}

/** Author a feature, update only affected team members, compile, and optionally run it. */
export async function runFeatureIncrement(repoDir: string, featurePrompt: string | undefined, run = false): Promise<number> {
  setupStateForRepo(repoDir);
  authoringEvent("authoring.started", { operation: "feature-increment", run });
  const featuresDir = path.join(repoDir, "docs", "features");
  const beforeFeatures = new Set(fs.existsSync(featuresDir)
    ? fs.readdirSync(featuresDir).filter((name) => name.endsWith(".md"))
    : []);
  const featureCode = await runFeaturePrd(repoDir, featurePrompt);
  if (featureCode !== 0) { authoringEvent("authoring.failed", { operation: "feature-increment", stage: "feature-prd", code: featureCode }); return featureCode; }
  authoringEvent("authoring.stage.completed", { operation: "feature-increment", stage: "feature-prd" });
  const teamCode = await runDraftTeam(repoDir, true);
  if (teamCode !== 0) { authoringEvent("authoring.failed", { operation: "feature-increment", stage: "team", code: teamCode }); return teamCode; }
  authoringEvent("authoring.stage.completed", { operation: "feature-increment", stage: "team" });
  const manifestCode = await runCompileManifest(repoDir);
  if (manifestCode !== 0) { authoringEvent("authoring.failed", { operation: "feature-increment", stage: "manifest", code: manifestCode }); return manifestCode; }
  authoringEvent("authoring.stage.completed", { operation: "feature-increment", stage: "manifest" });
  if (!run) {
    out("Feature increment prepared. Review the manifest, then run: forge-launcher engine-run --repo \"" + path.resolve(repoDir) + "\" --yes");
    authoringEvent("authoring.completed", { operation: "feature-increment", run: false });
    return 0;
  }
  const newFeatures = fs.existsSync(featuresDir)
    ? fs.readdirSync(featuresDir).filter((name) => name.endsWith(".md") && !beforeFeatures.has(name))
    : [];
  const code = await engineRunCliForIncrement(repoDir, newFeatures.map((name) => path.basename(name, ".md")));
  authoringEvent(code === 0 ? "authoring.completed" : "authoring.failed", { operation: "feature-increment", run: true, code });
  return code;
}

export async function engineRunCliForIncrement(repoDir: string, featureNames: string[]): Promise<number> {
  const manifestPath = path.join(repoDir, "docs", "EXECUTION-MANIFEST.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      phases?: Array<{ id?: string; feature?: string; tasks?: Array<{ id: string }> }>;
    };
    const selected = featureTaskIds(manifest, featureNames);
    if (selected.length === 0) {
      fail("Cannot run feature increment: no task IDs were emitted for the feature PRD.");
      return 1;
    }
    const cfg = state.engineConfig;
    const args = ["--repo", path.resolve(repoDir), "--harness", cfg.harness || "opencode", "--execution-mode", "manual", "--selected-tasks", selected.join(","), "--yes"];
    if (cfg.granularity) args.push("--granularity", cfg.granularity);
    if (cfg.concurrency) args.push("--concurrency", cfg.concurrency);
    if (cfg.taskTimeoutMs) args.push("--task-timeout-ms", cfg.taskTimeoutMs);
    if (cfg.maxRetries) args.push("--max-retries", cfg.maxRetries);
    if (cfg.viz) args.push("--viz", ...(cfg.vizPort ? ["--viz-port", cfg.vizPort] : []));
    if (cfg.keepAlive) args.push("--keep-alive");
    if (cfg.attach) args.push("--attach", cfg.attach);
    if (cfg.autoCommit === false) args.push("--no-auto-commit");
    return engineRunCli(args);
  } catch {
    fail("Cannot run feature increment: execution manifest is missing or invalid.");
    return 1;
  }
}

/** Returns only task IDs belonging to the newly authored feature documents. */
export function featureTaskIds(
  manifest: { phases?: Array<{ id?: string; feature?: string; tasks?: Array<{ id: string }> }> },
  featureNames: string[],
): string[] {
  const featureCodes = new Set(featureNames.map((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase()));
  return (manifest.phases ?? [])
    .filter((phase) => phase.feature && (featureNames.includes(phase.feature) || featureCodes.has((phase.id ?? "").split("-")[0] ?? "")))
    .flatMap((phase) => (phase.tasks ?? []).map((task) => task.id));
}

/**
 * Headless pipeline advancement for the Forge Console: generate the agent team
 * from the PRD (when absent).
 */
export async function runDraftTeam(repoDir: string, featureIncrement = false): Promise<number> {
  setupStateForRepo(repoDir);
  if (hasGeneratedTeam() && !featureIncrement) {
    out("Agent team already exists.");
    return 0;
  }
  if (!hasPrd()) {
    fail("No PRD yet; draft the PRD first.");
    return 1;
  }
  out("Generating the agent team from the PRD (headless) …");
  // Capture this immediately before invoking the team skill. In feature mode
  // the preceding feature-PRD stage is expected to change docs, so those
  // changes must not be attributed to team generation.
  const featureSnapshot = featureIncrement ? snapshotFeatureIncrementFiles(repoDir) : undefined;
  const prdSource = prdSourceForTeam();
  const ran = await runSkillHeadless(
    `${buildTeamPrompt(prdSource, state.harness)} ${featureIncrement
      ? "This is Feature Increment Mode. Preserve every untouched existing agent and skill; update or add only agents affected by the new feature. Review the existing codebase and team before making changes."
      : "Auto-proceed with default assumptions and no questions."}`,
    { nonInteractive: true },
  );
  if (!ran) return 1;
  if (featureSnapshot && !validateFeatureIncrementFiles(featureSnapshot)) return 1;
  await draftCommit("feat: generate auto-drafted agent team");
  if (hasGeneratedTeam()) {
    ok("Agent team generated.");
    out(`    - Agents : ${link(harnessAgentsDir() + "/")}`);
    return 0;
  }
  await diagnoseAutoDraftFail("forge-build-agent-team");
  return 1;
}

export async function runCompileManifest(repoDir: string): Promise<number> {
  setupStateForRepo(repoDir);
  const manifestPath = path.join(repoDir, "docs", "EXECUTION-MANIFEST.json");
  if (fs.existsSync(manifestPath)) out("Recompiling the execution manifest (existing task state will be reconciled) …");
  if (!hasGeneratedTeam()) {
    fail("No generated agent team yet; generate the team first.");
    return 1;
  }
  const adapterDir = findAdapterDir(repoDir);
  if (!adapterDir) {
    fail("forge-execution-adapter is not installed under this repo.");
    return 1;
  }
  out("Preparing the build by compiling the execution manifest …");
  let code = await runLoggedStep("Installing execution adapter dependencies", "npm", ["install"], { cwd: adapterDir });
  if (code !== 0) return code;
  const compileArgs = ["run", "forge-execution-adapter", "--", "compile", "--repo", repoDir];
  if (state.engineConfig.granularity) compileArgs.push("--granularity", state.engineConfig.granularity);
  code = await runLoggedStep("Compiling execution manifest", "npm", compileArgs, { cwd: adapterDir });
  if (code !== 0) return code;
  if (!fs.existsSync(manifestPath)) {
    fail("Manifest compile exited without producing docs/EXECUTION-MANIFEST.json.");
    return 1;
  }
  ok("Execution manifest compiled.");
  out(`    - ${link(manifestPath)}`);
  return 0;
}

export function printEngineStatus(engine: ResumeEngineState): void {
  info("Engine run state:");
  out(`    - Run id   : ${engine.runId ?? "unknown"}`);
  out(`    - Status   : ${engine.status ?? "unknown"}`);
  out(`    - Harness  : ${engine.harness ?? "-"}`);
  if (engine.currentPhase) out(`    - Phase    : ${engine.currentPhase}`);
  const tasks = Object.values(engine.tasks ?? {});
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status ?? "pending"] = (counts[t.status ?? "pending"] ?? 0) + 1;
  out(`    - Tasks    : ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ") || "0"}`);
  const hollow = tasks.filter((t) => t.status === "complete" && (!t.outputFiles || t.outputFiles.length === 0));
  if (hollow.length) {
    out(`    - Completed without outputs : ${hollow.map((t) => t.taskId).join(", ")} (verify these actually delivered)`);
  }
  const failed = tasks.filter((t) => t.status === "failed");
  if (failed.length) {
    out(`    - Failed   : ${failed.map((t) => `${t.taskId ?? "?"}${t.errorMessage ? ` (${t.errorMessage})` : ""}`).join("; ")}`);
  }
  if (Array.isArray(engine.blockers) && engine.blockers.length) {
    out(`    - Blockers : ${engine.blockers.join("; ")}`);
  }
  out("");
}

export function printMonitorCommands(): void {
  info("Monitor the build from another terminal:");
  command(`tail -f ${path.join(state.repoDir, "docs", "engine-run.log")}`);
  command(`tail -f ${path.join(state.repoDir, "docs", "PROGRESS.md")}`);
  command(`npx forge-launcher ${engineRunArgs().join(" ")}`);
  out("");
}

