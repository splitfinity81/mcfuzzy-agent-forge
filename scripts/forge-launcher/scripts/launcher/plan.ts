import fs from "node:fs";
import path from "node:path";
import { command, info, link, ok, out, printLogTail, runCommand, warn } from "../format.ts";
import { promptYesNo } from "../prompts.ts";
import { launchCliInTerminal } from "../terminal.ts";
import { envFlag } from "./env.ts";
import { hasPrd, skillPathFor } from "./harness-paths.ts";
import { runLogFile } from "./log.ts";
import { type LauncherOptions, state } from "./state.ts";
import { PRD_HEADLESS_MSG, runSkillHeadless } from "./skills.ts";

// --- auto-draft flow -------------------------------------------------------

export async function draftCommit(message: string): Promise<void> {
  await runCommand("git", ["-C", state.repoDir, "add", "."]);
  const diff = await runCommand("git", ["-C", state.repoDir, "diff", "--cached", "--quiet", "--", "."], { capture: true });
  if (diff.code === 0) {
    warn("No changes to commit after auto-draft.");
    return;
  }
  await runCommand("git", ["-C", state.repoDir, "commit", "-m", message]);
  ok(`Committed: '${message}'`);
}

// --- stop-here-and-resume-later checkpoints ---------------------------------

/** Set when the user chooses "stop here and resume later" at a checkpoint. */

/**
 * Interactive "stop here and resume later" checkpoint. When the user chooses to
 * stop, prints the resume command so the run can be picked up later with
 * `forge-launcher resume`. No-op in non-interactive / dry-run mode.
 */
export async function pauseForResume(opts: LauncherOptions, stage: string): Promise<void> {
  if (opts.nonInteractive || opts.dryRun) return;
  const answer = await promptYesNo(`Stop here and resume later (after ${stage})?`, "n");
  if (answer !== "y") return;
  state.stopped = true;
  out("");
  info("Stopped. Resume later from anywhere with:");
  command(`forge-launcher resume --repo "${state.repoDir}"`);
  out("");
}

// --- post-team plan & validate step (playbook 5a) ----------------------------

/** True when the repo uses the decomposed vision + features layout. */
export function hasDecomposedLayout(): boolean {
  return (
    fs.existsSync(path.join(state.repoDir, "docs", "product-vision.md")) &&
    fs.existsSync(path.join(state.repoDir, "docs", "features")) &&
    fs.readdirSync(path.join(state.repoDir, "docs", "features")).some((f) => f.endsWith(".md"))
  );
}

export const PLAN_MONOLITHIC_MSG =
  "Analyze docs/PRD.md and produce an execution plan only. Do not implement anything yet. " +
  "List each phase, the agents involved, their tasks, and the dependencies between phases. " +
  "Save the plan to docs/PROGRESS.md. Headless mode: auto-proceed and stop after saving the plan.";

export const PLAN_FEATURES_MSG =
  "Analyze docs/product-vision.md and all feature documents in docs/features/. " +
  "Build a feature dependency graph and produce an execution plan showing which features will be " +
  "built in which order and why. Save the plan to docs/PROGRESS.md. Do not implement anything yet. " +
  "Headless mode: auto-proceed and stop after saving the plan.";

/** Offers to open the harness CLI to run project-orchestrator's plan step manually. */
export async function offerPlanManualRun(opts: LauncherOptions): Promise<void> {
  const manual = "Run it manually in the harness: @project-orchestrator Analyze docs/PRD.md and produce an execution plan only. Save the plan to docs/PROGRESS.md.";
  if (opts.nonInteractive) {
    out(`    ${manual}`);
    return;
  }
  const answer = await promptYesNo("Open the harness CLI to run project-orchestrator manually?", "n");
  if (answer === "n") {
    info("To run it manually:");
    out(`    cd "${state.repoDir}"`);
    out(`    ${manual}`);
    return;
  }
  const cli = state.harness === "github" ? "copilot" : state.harness === "claude" ? "claude" : "opencode";
  const launched = await launchCliInTerminal(cli, state.repoDir, state.harness === "github" ? [] : ["."]);
  if (launched) ok(`${cli} launched. Run @project-orchestrator in the session.`);
  else {
    warn(`${cli} did not open automatically. Run:`);
    out(`    cd "${state.repoDir}" && ${cli} .`);
  }
}

/**
 * Post-team "plan & validate" step (prompt-playbook 5a). Runs project-orchestrator
 * through the forge-orchestrate-build skill headlessly to produce the execution
 * plan in docs/PROGRESS.md, commits it, and stops for review before the build.
 * Falls back to the manual @project-orchestrator command when the headless run
 * fails or produces no plan document.
 */
export async function planAndValidateStep(opts: LauncherOptions): Promise<void> {
  const skill = "forge-orchestrate-build";
  const planMsg = hasDecomposedLayout() ? PLAN_FEATURES_MSG : PLAN_MONOLITHIC_MSG;

  if (opts.nonInteractive) {
    if (!envFlag("FORGE_AUTO_DRAFT")) return;
  } else {
    const def = opts.draft ? "y" : "n";
    const answer = await promptYesNo(
      "Generate the execution plan now (project-orchestrator, headless; saved to docs/PROGRESS.md)?",
      def,
    );
    if (answer === "n") return;
  }

  out("");
  info("Generating the execution plan via project-orchestrator (headless) …");
  const ran = await runSkillHeadless(`/${skill} ${planMsg}`, opts);
  if (!ran) {
    await offerPlanManualRun(opts);
    return;
  }
  await draftCommit("docs: add execution plan");

  if (fs.existsSync(path.join(state.repoDir, "docs", "PROGRESS.md"))) {
    ok("Execution plan saved to docs/PROGRESS.md.");
    out("");
    out("  Review the plan before building:");
    out(`    - ${link(path.join(state.repoDir, "docs", "PROGRESS.md"))}`);
    await pauseForResume(opts, "execution plan drafted");
  } else {
    warn("No execution plan document detected after the run.");
    await offerPlanManualRun(opts);
  }
}

/** Prints diagnostics when an auto-draft stage finishes without its artifact. */
export async function diagnoseAutoDraftFail(skillName: string): Promise<void> {
  warn(`The auto-draft did not produce the expected artifact for '${skillName}'.`);
  out("");
  printLogTail(runLogFile(), 30);
  out("");
  info("What the repo contains right now:");
  const st = await runCommand("git", ["-C", state.repoDir, "status", "--short"], { capture: true });
  if (st.code === 0 && st.stdout.trim()) {
    out("  " + st.stdout.trim().replace(/\n/g, "\n  "));
  } else {
    out("  (no changes)");
  }
  const skillPath = skillPathFor(skillName);
  out("");
  if (fs.existsSync(skillPath)) {
    info(`Skill present: ${skillPath}`);
  } else {
    warn(`Skill NOT found: ${skillPath}`);
  }
}

/** Offers to run the failed skill interactively (or prints the command). */
export async function offerManualRun(skillName: string, opts: LauncherOptions): Promise<void> {
  if (opts.nonInteractive) {
    out(`    Run it manually in the repo: /${skillName} Use docs/IDEA.md as the project idea`);
    return;
  }
  const answer = await promptYesNo(`Open the harness CLI now to run /${skillName} manually?`, "n");
  if (answer === "n") {
    info("To run it manually:");
    out(`    cd "${state.repoDir}"`);
    out(`    Then run: /${skillName} Use docs/IDEA.md as the project idea`);
    return;
  }
  const cli = state.harness === "github" ? "copilot" : state.harness === "claude" ? "claude" : "opencode";
  const launched = await launchCliInTerminal(cli, state.repoDir, state.harness === "github" ? [] : ["."]);
  if (launched) ok(`${cli} launched. Run /${skillName} in the session.`);
  else {
    warn(`${cli} did not open automatically. Run:`);
    out(`    cd "${state.repoDir}" && ${cli} .`);
  }
}

export async function autoDraftPrd(opts: LauncherOptions): Promise<void> {
  if (hasPrd()) return;
  if (opts.nonInteractive) {
    if (!envFlag("FORGE_AUTO_DRAFT")) return;
  } else {
    const def = opts.draft ? "y" : "n";
    const answer = await promptYesNo(
      "Generate the PRD from docs/IDEA.md automatically now (headless, auto-proceed with best answers)?",
      def,
    );
    if (answer === "n") return;
  }

  out("");
  info("Auto-drafting the PRD from docs/IDEA.md (headless) …");
  const skill = "forge-auto-build-prd";
  const ran = await runSkillHeadless(
    `/${skill} ${PRD_HEADLESS_MSG}`,
    opts,
  );
  if (!ran) return;
  await draftCommit("docs: add auto-drafted PRD");

  if (hasPrd()) {
    state.prdAdded = true;
    ok("PRD generated.");
    out("");
    out("  Review it before continuing:");
    out(`    - ${link(path.join(state.repoDir, "docs", "PRD.md"))}`);
    if (fs.existsSync(path.join(state.repoDir, "docs", "product-vision.md"))) {
      out("    - " + link(path.join(state.repoDir, "docs", "product-vision.md")) + " (decomposed) + docs/features/*.md");
    } else {
      out("    - docs/PRD.md is monolithic (no decomposition)");
    }
    await pauseForResume(opts, "PRD drafted");
  } else {
    await diagnoseAutoDraftFail(skill);
    await offerManualRun(skill, opts);
  }
}
