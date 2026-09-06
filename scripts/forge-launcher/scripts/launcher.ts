import fs from "node:fs";
import path from "node:path";
import { bootstrap } from "./bootstrap.ts";
import { upsertProject } from "./console/paths.ts";
import { command, fail, header, info, link, ok, out, runCommand, runWithHeartbeat, step, warn } from "./format.ts";
import { detectRepoRoot, expandPath, resolveInputFile } from "./paths.ts";
import { prompt, promptMultiline, promptPath, promptPathLoop, promptSelect, promptYesNo, prompts } from "./prompts.ts";
import { launchCliInTerminal } from "./terminal.ts";
import { saveEngineConfig } from "./engine-config.ts";
import { commandExists } from "./launcher/env.ts";
import { harnessAgentsDir, harnessRootDir, harnessSkillsDir, hasGeneratedTeam, hasPrd } from "./launcher/harness-paths.ts";
import { runLogFile, runLoggedStep } from "./launcher/log.ts";
import { defaultEngineHarness, type LauncherOptions, state } from "./launcher/state.ts";
import { autobuildCommand, buildTeamPrompt, headlessCmdFor, headlessSkillMsg, PRD_HEADLESS_MSG, prdSourceForTeam, runSkillHeadless } from "./launcher/skills.ts";
import { diagnoseAutoDraftFail, draftCommit, pauseForResume } from "./launcher/plan.ts";
import { autoDraftMenu, engineDecision, engineRunArgs, openCliFor, runEngineDetached, stopEngine } from "./launcher/engine.ts";
import { prdDocName, readEngineState, type ResumeOptions, setupStateForRepo } from "./launcher/repo-state.ts";
import { printEngineStatus, printMonitorCommands } from "./launcher/commands.ts";

// Public API preserved for cli.ts, console/control.ts and the test suite.
export { engineDetachedCommand } from "./launcher/env.ts";
export { defaultEngineHarness, type LauncherOptions } from "./launcher/state.ts";
export { compareFeatureIncrementFiles, snapshotFeatureIncrementFiles } from "./launcher/feature-increment.ts";
export type { FeatureIncrementFileChanges, FeatureIncrementSnapshot } from "./launcher/feature-increment.ts";
export { buildTeamPrompt, headlessSkillMsg } from "./launcher/skills.ts";
export { featureTaskIds, runCompileManifest, runDraftExistingPrd, runDraftPrd, runDraftTeam, runFeaturePrd, runFeatureIncrement } from "./launcher/commands.ts";


// --- Step 1: Pre-flight ----------------------------------------------------

async function preflightCheck(): Promise<void> {
  step("Step 1 of 9: Pre-flight check");
  const missing: string[] = [];

  if (commandExists("git")) {
    const v = await runCommand("git", ["--version"], { capture: true });
    ok(`git ${v.stdout.trim()}`);
  } else {
    fail("git not found -install Git before running this launcher.");
    missing.push("git");
  }

  state.ghAvailable = commandExists("gh");
  if (state.ghAvailable) {
    const v = await runCommand("gh", ["--version"], { capture: true });
    ok(`gh ${v.stdout.split("\n")[0].replace(/^gh version /, "")}`);
  } else {
    warn("gh (GitHub CLI) not found -GitHub harness repo creation will be unavailable.");
  }

  state.copilotAvailable = commandExists("copilot");
  if (state.copilotAvailable) {
    ok("copilot (installed)");
  } else {
    warn("copilot not found -GitHub Copilot CLI auto-launch will be unavailable.");
  }

  state.opencodeAvailable = commandExists("opencode");
  if (state.opencodeAvailable) {
    ok("opencode (installed)");
  } else {
    warn("opencode not found -opencode harness auto-launch will be unavailable.");
  }

  state.claudeAvailable = commandExists("claude");
  if (state.claudeAvailable) {
    ok("claude (installed)");
  } else {
    warn("claude not found -Claude Code harness auto-launch will be unavailable.");
  }

  if (missing.length) {
    out("");
    fail(`Required tools are missing: ${missing.join(", ")}. Install them and re-run.`);
    process.exitCode = 1;
    throw new Error("pre-flight failed");
  }
}

// --- Step 2: Select harness ------------------------------------------------

async function selectHarness(_opts: LauncherOptions): Promise<void> {
  step("Step 2 of 9: Select agent harness");
  out("");

  const options = [
    { value: "1", label: "GitHub Copilot   (harness: github,    dir: .github/)" },
    { value: "2", label: "opencode         (harness: opencode,  dir: .opencode/)" },
    { value: "3", label: "Claude Code      (harness: claude,    dir: .claude/)" },
    { value: "4", label: "Generic .agents  (harness: agents,    dir: .agents/)", hint: "default" },
  ];

  const choice = await promptSelect("Which agent harness will this project use?", options, {
    initial: "4",
    nonInteractiveValue: process.env.FORGE_HARNESS_CHOICE ?? "4",
  });

  switch (choice) {
    case "1": state.harness = "github"; state.harnessLabel = "GitHub Copilot"; break;
    case "2": state.harness = "opencode"; state.harnessLabel = "opencode"; break;
    case "3": state.harness = "claude"; state.harnessLabel = "Claude Code"; break;
    case "4": state.harness = "agents"; state.harnessLabel = "Generic .agents"; break;
    default:
      warn(`Unrecognised choice '${choice}', defaulting to generic .agents`);
      state.harness = "agents"; state.harnessLabel = "Generic .agents";
  }
  if (!process.env.FORGE_ENGINE_HARNESS) {
    state.engineConfig.harness = defaultEngineHarness(state.harness);
  }
  ok(`Harness: ${state.harnessLabel} (--harness ${state.harness})`);
}

// --- Step 3: Create repository ---------------------------------------------

async function createRepo(opts: LauncherOptions): Promise<void> {
  step("Step 3 of 9: Create repository");

  let repoName: string;
  let repoDescription: string;
  let repoVisibility: string;
  let parentDir: string;

  if (opts.nonInteractive) {
    repoName = process.env.FORGE_REPO_NAME ?? "";
    if (!repoName) {
      fail("Non-interactive mode: $FORGE_REPO_NAME is not set.");
      throw new Error("FORGE_REPO_NAME not set");
    }
    repoDescription = process.env.FORGE_REPO_DESCRIPTION ?? "";
    repoVisibility = process.env.FORGE_REPO_VISIBILITY ?? "private";
    parentDir = process.env.FORGE_REPO_PARENT_DIR ?? process.cwd();
  } else {
    repoName = await prompt("Repository name (no spaces)", "");
    if (!repoName) {
      fail("Repository name cannot be empty.");
      throw new Error("empty repo name");
    }
    repoDescription = await prompt("Short description (optional)", "");
    repoVisibility = await prompt("Visibility -public or private", "private");
    parentDir = await promptPath("Parent directory for the new repo", process.cwd(), { directory: true });
  }

  repoVisibility = repoVisibility.toLowerCase();
  if (repoVisibility !== "public" && repoVisibility !== "private") repoVisibility = "private";
  parentDir = path.resolve(expandPath(parentDir || process.cwd()));

  state.repoDir = path.join(parentDir, repoName);

  if (state.harness === "github" && state.ghAvailable) {
    info(`Creating GitHub repository '${repoName}' (${repoVisibility}) …`);
    const ghArgs = ["repo", "create", repoName, `--${repoVisibility}`, "--clone"];
    if (repoDescription) ghArgs.push("--description", repoDescription);
    await runLoggedStep("Creating GitHub repository…", "gh", ghArgs, {
      cwd: parentDir,
      dryRun: opts.dryRun,
    });
    state.repoDir = path.join(parentDir, repoName);
    ok(`GitHub repo created and cloned to: ${state.repoDir}`);
    state.remoteCreated = true;
  } else {
    info(`Initialising local Git repository at: ${state.repoDir}`);
    fs.mkdirSync(state.repoDir, { recursive: true });
    await runCommand("git", ["init"], { cwd: state.repoDir });
    if (repoDescription) {
      fs.writeFileSync(
        path.join(state.repoDir, "README.md"),
        `# ${repoName}\n\n${repoDescription}\n`,
      );
    }
    ok(`Local git repository initialised: ${state.repoDir}`);
    state.remoteCreated = false;

    if (state.harness === "github" && !state.ghAvailable) {
      warn("gh is not installed -skipped remote creation.");
      warn("Run 'gh repo create' or 'git remote add origin <url>' manually.");
    } else {
      const addRemote = await promptYesNo("Add a Git remote for this repository now?", "n");
      if (addRemote === "y") {
        const remoteUrl = await prompt("Remote URL (e.g. https://github.com/user/repo.git)", "");
        if (remoteUrl) {
          await runCommand("git", ["-C", state.repoDir, "remote", "add", "origin", remoteUrl]);
          ok(`Remote 'origin' added: ${remoteUrl}`);
          state.remoteCreated = true;
        }
      }
    }
  }

  upsertProject({ path: state.repoDir, name: repoName, harness: state.harness });
}

// --- Step 4: Bootstrap -----------------------------------------------------

async function bootstrapForge(opts: LauncherOptions): Promise<void> {
  step("Step 4 of 9: Bootstrap MyForge");
  info(`Running bootstrap → ${state.repoDir} (--harness ${state.harness}) …`);
  await runWithHeartbeat(
    "Bootstrapping MyForge (copying templates)…",
    () =>
      bootstrap({
        targetDir: state.repoDir,
        harness: state.harness,
        force: true,
        nonInteractive: opts.nonInteractive,
        logFile: runLogFile(),
      }).then((code) => {
        if (code !== 0) throw new Error("bootstrap failed");
        return 0;
      }),
    { dryRun: opts.dryRun },
  );
  saveEngineConfig(state.repoDir, state.engineConfig);
  ok("MyForge templates bootstrapped.");
}

// --- Step 5: Capture idea --------------------------------------------------

async function captureIdea(opts: LauncherOptions): Promise<void> {
  step("Step 5 of 9: Capture your project idea");
  const ideaFileDocs = path.join(state.repoDir, "docs", "IDEA.md");
  const ideaFileRoot = path.join(state.repoDir, "IDEA.md");

  out("");
  out("  Describe your project idea below.");
  out("  This will be saved to docs/IDEA.md (and mirrored to IDEA.md)");
  out("  and used as the starting prompt");
  out("  for forge-auto-build-prd (which turns it into docs/PRD.md).");
  out("");

  let ideaText: string;
  if (opts.nonInteractive) {
    ideaText = process.env.FORGE_IDEA ?? "";
    if (!ideaText) {
      fail("Non-interactive mode: $FORGE_IDEA is not set.");
      throw new Error("FORGE_IDEA not set");
    }
  } else {
    ideaText = await promptMultiline("Describe your project idea");
  }

  if (!ideaText.trim()) {
    warn("No idea text entered. docs/IDEA.md will be created as a placeholder.");
    ideaText = "*(Replace this with your project idea before running forge-auto-build-prd.)*";
  }

  fs.mkdirSync(path.join(state.repoDir, "docs"), { recursive: true });
  const content = [
    "# Project Idea",
    "",
    ideaText,
    "",
    "---",
    "",
    `> Generated by forge-launcher on ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "> Use this file as input for: `@workspace /forge-auto-build-prd Use docs/IDEA.md as the project idea`",
    "",
  ].join("\n");
  fs.writeFileSync(ideaFileDocs, content);
  fs.copyFileSync(ideaFileDocs, ideaFileRoot);

  ok(`Idea saved to: ${ideaFileDocs}`);
  info(`Compatibility copy written to: ${ideaFileRoot}`);
}

// --- Step 6: PRD + research ------------------------------------------------

async function addPrdAndResearch(opts: LauncherOptions): Promise<void> {
  step("Step 6 of 9: Add PRD and research / seed documents (optional -recommended)");

  const docsDir = path.join(state.repoDir, "docs");
  const researchDir = path.join(docsDir, "research");
  state.prdAdded = false;
  state.researchAdded = false;

  out("");
  out("  Why this step matters:");
  out("  Starting with a well-defined PRD produces a far more accurate and");
  out("  complete build than starting from an idea alone.  Research / seed");
  out("  documents (design specs, market research, technical notes, etc.) give");
  out("  the pipeline additional context that improves every downstream stage.");
  out("");

  // --- PRD ---
  if (opts.nonInteractive) {
    const prdFile = process.env.FORGE_PRD_FILE;
    if (prdFile) {
      const resolved = resolveInputFile(prdFile);
      if (resolved.ok) {
        fs.mkdirSync(docsDir, { recursive: true });
        fs.copyFileSync(resolved.path, path.join(docsDir, "PRD.md"));
        ok("PRD copied from $FORGE_PRD_FILE → docs/PRD.md");
        state.prdAdded = true;
      } else {
        warn(`FORGE_PRD_FILE is set but ${resolved.reason} -skipping PRD.`);
      }
    }
  } else {
    out("  Do you have an existing PRD to add?");
    out("");
    const prdChoice = await promptSelect(
      "Do you have an existing PRD to add?",
      [
        { value: "1", label: "Yes - provide a file path to copy in as docs/PRD.md" },
        { value: "2", label: "Yes - paste the PRD content directly" },
        { value: "3", label: "No  - skip (the pipeline will build a PRD from docs/IDEA.md first)", hint: "default" },
      ],
      { initial: "3", nonInteractiveValue: "3" },
    );

    if (prdChoice === "1") {
      const prdSrc = await promptPath("Path to your PRD file", "");
      const resolved = resolveInputFile(prdSrc);
      if (resolved.ok) {
        fs.mkdirSync(docsDir, { recursive: true });
        fs.copyFileSync(resolved.path, path.join(docsDir, "PRD.md"));
        ok("PRD copied → docs/PRD.md");
        state.prdAdded = true;
      } else {
        warn(`${resolved.reason} -skipping PRD.`);
      }
    } else if (prdChoice === "2") {
      out("");
      const prdText = await promptMultiline("Paste your PRD content");
      if (prdText.trim()) {
        fs.mkdirSync(docsDir, { recursive: true });
        fs.writeFileSync(path.join(docsDir, "PRD.md"), prdText + "\n");
        ok("PRD saved → docs/PRD.md");
        state.prdAdded = true;
      } else {
        warn("No content entered -skipping PRD.");
      }
    } else {
      info("Skipping PRD -the pipeline will build a PRD from docs/IDEA.md first (via forge-auto-build-prd).");
    }
  }

  // --- Research / seed documents ---
  if (opts.nonInteractive) {
    const researchFiles = process.env.FORGE_RESEARCH_FILES;
    if (researchFiles) {
      fs.mkdirSync(researchDir, { recursive: true });
      for (const raw of researchFiles.split(",")) {
        const f = raw.trim();
        if (!f) continue;
        const resolved = resolveInputFile(f);
        if (resolved.ok) {
          fs.copyFileSync(resolved.path, path.join(researchDir, path.basename(resolved.path)));
          ok(`Research doc copied: ${path.basename(resolved.path)} → docs/research/`);
          state.researchAdded = true;
        } else {
          warn(`FORGE_RESEARCH_FILES: ${resolved.reason} -skipping.`);
        }
      }
    }
  } else {
    out("");
    const addResearch = await promptYesNo(
      "Do you have research or seed documents to add (design specs, market research, technical notes…)?",
      "n",
    );
    if (addResearch === "y") {
      fs.mkdirSync(researchDir, { recursive: true });
      out("");
      const paths = await promptPathLoop("  Enter a research/seed doc path (Enter on a blank line to finish)");
      for (const resPath of paths) {
        const resolved = resolveInputFile(resPath);
        if (resolved.ok) {
          fs.copyFileSync(resolved.path, path.join(researchDir, path.basename(resolved.path)));
          ok(`Research doc copied: ${path.basename(resolved.path)} → docs/research/`);
          state.researchAdded = true;
        } else {
          warn(`${resolved.reason} -skipping.`);
        }
      }
    } else {
      info("Skipping research documents.");
    }
  }
}

// --- Step 7: Commit + push -------------------------------------------------

async function commitBootstrap(): Promise<void> {
  step("Step 7 of 9: Commit bootstrapped forge and idea");

  await runCommand("git", ["-C", state.repoDir, "add", "."]);
  await runCommand("git", ["-C", state.repoDir, "commit", "-m", "chore: bootstrap MyForge"]);
  ok("Committed: 'chore: bootstrap MyForge'");

  if (state.remoteCreated) {
    info("Pushing to remote …");
    const branch = await runCommand("git", ["-C", state.repoDir, "rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
    const push = await runLoggedStep("Pushing to remote…", "git", ["-C", state.repoDir, "push", "-u", "origin", "HEAD"]);
    if (push !== 0 && branch.stdout.trim()) {
      await runLoggedStep("Pushing to remote…", "git", ["-C", state.repoDir, "push", "-u", "origin", branch.stdout.trim()]);
    }
    ok("Pushed to remote.");
  } else {
    warn("No remote configured -skipping push. Add a remote and run 'git push -u origin HEAD' manually.");
  }
}

// --- Step 8: Launch auto-build ---------------------------------------------

async function launchAutobuild(opts: LauncherOptions): Promise<void> {
  step("Step 8 of 9: Launch auto-build");

  out("");
  if (hasPrd()) {
    if (hasGeneratedTeam()) {
      out("  The repository is bootstrapped, PRD in place, and the agent team");
      out("  is generated. In the harness, run /forge-orchestrate-build (project-");
      out("  orchestrator) for an interactive build, or forge-launcher engine-run");
      out("  for autonomous execution through the workflow engine.");
    } else {
      out("  The repository is bootstrapped and ready for forge-auto-build.");
      out("  forge-auto-build will generate the agent team, then execute the build");
      out("  (add 'GO --workflow-engine' at its pre-flight gate to run via the");
      out("  workflow engine instead of the prompt-driven orchestrator).");
    }
  } else {
    out("  The repository is bootstrapped. forge-auto-build-prd will turn your idea");
    out("  into a reviewed PRD, then forge-auto-build will generate the agent team");
    out("  and execute the build.");
  }
  out("");

  if (opts.headless) {
    info("Headless mode: driving the queued skill directly from the terminal");
    out("  (no interactive CLI session will be opened).");
    out("");
    await runSkillHeadless(headlessSkillMsg(), opts);
    return;
  }

  await autoDraftMenu(opts);
  if (state.stopped) return;

  if (state.engineStarted) {
    out("");
    info("The workflow engine is already running this build in the background.");
    info("Skipping the interactive CLI launch prompt - monitor or resume it with forge-launcher resume.");
    return;
  }

  const launchPrompt = async (cli: string, extra: string[]): Promise<void> => {
    const answer = await promptYesNo(`Launch ${cli} in the new repository now?`, "n");
    if (answer === "n") {
      info("To launch manually:");
      out(`    cd "${state.repoDir}" && ${cli} ${extra.join(" ")}`);
      out(`    Then: ${autobuildCommand()}`);
      return;
    }
    info(`Launching ${cli} in: ${state.repoDir}`);
    const launched = await launchCliInTerminal(cli, state.repoDir, extra);
    if (launched) {
      ok(`${cli} launched in a separate terminal.`);
      out(`    Then run: ${autobuildCommand()}`);
    } else {
      warn(`${cli} did not open automatically. Run:`);
      out(`    cd "${state.repoDir}" && ${cli} ${extra.join(" ")}`);
      out(`    Then: ${autobuildCommand()}`);
    }
  };

  switch (state.harness) {
    case "github":
      if (state.copilotAvailable) {
        await launchPrompt("copilot", []);
      } else {
        info("Open the repository in GitHub Copilot Chat and run:");
        out("");
        out(`    ${autobuildCommand()}`);
        out("");
        info("The skill will present a pre-flight summary. Type GO to start the pipeline (use GO --workflow-engine for the workflow-engine build path).");
      }
      break;
    case "claude":
      if (state.claudeAvailable) {
        await launchPrompt("claude", ["."]);
      } else {
        warn("claude CLI is not installed. Install it from https://claude.ai/code then run:");
        out(`    cd "${state.repoDir}" && claude .`);
        out(`    Then: ${autobuildCommand()}`);
      }
      break;
    case "agents":
      info("Open the repository in your agent harness and run:");
      out("");
      out(`    ${autobuildCommand()}`);
      out("");
      info("Agent templates are in:");
      out(`    ${path.join(state.repoDir, ".agents", "agents")}/`);
      break;
    case "opencode":
      if (state.opencodeAvailable) {
        await launchPrompt("opencode", ["."]);
      } else {
        warn("opencode CLI is not installed. Install it from https://opencode.ai then run:");
        out(`    cd "${state.repoDir}" && opencode .`);
        out(`    Then: ${autobuildCommand()}`);
      }
      break;
  }
}


function printResumeWhere(): void {
  const ideaPath = path.join(state.repoDir, "docs", "IDEA.md");
  const idea = fs.existsSync(ideaPath);
  const prd = hasPrd();
  const team = hasGeneratedTeam();
  const manifest = fs.existsSync(path.join(state.repoDir, "docs", "EXECUTION-MANIFEST.json"));
  const engine = readEngineState();

  step("Resume project state");
  out("");
  out(`  Repository  : ${link(state.repoDir)}`);
  out(`  Harness     : ${state.harnessLabel} (${harnessRootDir()}/)`);
  out("");
  info("Where you are:");
  out(`    - Project idea       : ${idea ? `yes  ${link(ideaPath)}` : "no"}`);
  out(`    - PRD                : ${prd ? `yes  ${link(path.join(state.repoDir, "docs", prdDocName()))}` : "no"}`);
  out(`    - Agent team         : ${team ? `yes  ${link(harnessAgentsDir() + "/")}` : "no"}`);
  out(`    - Execution manifest : ${manifest ? "yes" : "no"}`);
  if (engine) out(`    - Engine run         : ${engine.status ?? "unknown"}${engine.runId ? ` (run ${engine.runId})` : ""}`);
  out("");
}

/** Stage: capture a project idea (only when nothing at all exists yet). */
async function resumeIdeaStep(opts: ResumeOptions): Promise<boolean> {
  const ideaPath = path.join(state.repoDir, "docs", "IDEA.md");
  if (fs.existsSync(ideaPath) || hasPrd()) return true;
  if (opts.nonInteractive) {
    out("  No idea or PRD captured yet. Next: run the launcher to capture an idea:");
    command("forge-launcher");
    return false;
  }
  out("  No project idea or PRD captured yet in this repository.");
  out("");
  const choice = await promptSelect("What would you like to do?", [
    { value: "capture", label: "Capture your project idea now", hint: "writes docs/IDEA.md" },
    { value: "cli", label: "Open the harness CLI to run /forge-auto-build-prd manually" },
    { value: "stop", label: "Stop here" },
  ], { initial: "capture" });
  if (choice === "stop") return false;
  if (choice === "cli") {
    await openCliFor("/forge-auto-build-prd Use docs/IDEA.md as the project idea");
    return false;
  }
  if (opts.dryRun) {
    warn("Dry-run: would prompt for an idea and write docs/IDEA.md.");
    return false;
  }
  const ideaText = await promptMultiline("Describe your project idea");
  if (!ideaText.trim()) {
    warn("No idea text entered; stopping here.");
    return false;
  }
  fs.mkdirSync(path.join(state.repoDir, "docs"), { recursive: true });
  const content = [
    "# Project Idea",
    "",
    ideaText,
    "",
    "---",
    "",
    `> Generated by forge-launcher (resume) on ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "> Use this file as input for: `@workspace /forge-auto-build-prd Use docs/IDEA.md as the project idea`",
    "",
  ].join("\n");
  fs.writeFileSync(ideaPath, content);
  fs.copyFileSync(ideaPath, path.join(state.repoDir, "IDEA.md"));
  ok(`Idea saved to: ${link(ideaPath)}`);
  return true;
}

/** Stage: turn the idea into a reviewed PRD. */
async function resumePrdStep(opts: ResumeOptions): Promise<boolean> {
  if (hasPrd()) return true;
  if (!fs.existsSync(path.join(state.repoDir, "docs", "IDEA.md"))) return true;
  if (opts.nonInteractive) {
    out("  No PRD yet. Next: draft the PRD from docs/IDEA.md:");
    command(headlessCmdFor(`/forge-auto-build-prd ${PRD_HEADLESS_MSG}`));
    return false;
  }
  out("  No PRD yet. docs/IDEA.md is ready to become a reviewed PRD.");
  out("");
  const choice = await promptSelect("How do you want to create the PRD?", [
    { value: "draft", label: "Auto-draft it now", hint: "headless forge-auto-build-prd" },
    { value: "cli", label: "Open the harness CLI to draft it manually" },
    { value: "stop", label: "Stop here" },
  ], { initial: "draft" });
  if (choice === "stop") return false;
  if (choice === "cli") {
    await openCliFor("/forge-auto-build-prd Use docs/IDEA.md as the project idea");
    return false;
  }
  const ran = await runSkillHeadless(`/forge-auto-build-prd ${PRD_HEADLESS_MSG}`, opts);
  if (!ran) return false;
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
  } else {
    await diagnoseAutoDraftFail("forge-auto-build-prd");
    return false;
  }
  return true;
}

/** Stage: generate the agent team from the PRD. */
async function resumeTeamStep(opts: ResumeOptions): Promise<boolean> {
  if (hasGeneratedTeam()) return true;
  if (!hasPrd()) return true;
  if (opts.nonInteractive) {
    out("  No agent team yet. Next: generate the team from the PRD:");
    command(headlessCmdFor(`${buildTeamPrompt(prdSourceForTeam(), state.harness)} Auto-proceed with default assumptions and no questions.`));
    return false;
  }
  out("  No agent team yet. docs/PRD.md is ready for team generation.");
  out("");
  const choice = await promptSelect("How do you want to generate the team?", [
    { value: "draft", label: "Auto-draft it now", hint: "headless forge-build-agent-team" },
    { value: "cli", label: "Open the harness CLI to build the team manually" },
    { value: "stop", label: "Stop here" },
  ], { initial: "draft" });
  if (choice === "stop") return false;
  if (choice === "cli") {
    await openCliFor(buildTeamPrompt("docs/PRD.md", state.harness));
    return false;
  }
  const prdSource = prdSourceForTeam();
  const ran = await runSkillHeadless(
    `${buildTeamPrompt(prdSource, state.harness)} Auto-proceed with default assumptions and no questions.`,
    opts,
  );
  if (!ran) return false;
  await draftCommit("feat: generate auto-drafted agent team");
  if (hasGeneratedTeam()) {
    ok("Agent team generated.");
    out("");
    out("  Review the generated team before building:");
    out(`    - Agents : ${link(harnessAgentsDir() + "/")}`);
    out(`    - Skills : ${link(harnessSkillsDir() + "/")}`);
  } else {
    await diagnoseAutoDraftFail("forge-build-agent-team");
    return false;
  }
  return true;
}


/** Stage: start/resume the build via the engine or hand off to the harness. */
async function resumeEngineStep(opts: ResumeOptions): Promise<void> {
  const engine = readEngineState();

  if (engine) {
    printEngineStatus(engine);
    if (opts.nonInteractive) {
      if (engine.status === "complete") {
        out("  The engine run is complete. Next:");
        command(`tail -f ${path.join(state.repoDir, "docs", "PROGRESS.md")}`);
      } else if (engine.status === "running") {
        warn("The engine is already running in the background - do not start a second run.");
        printMonitorCommands();
      } else {
        out("  Next: resume the engine run from WORKFLOW-STATE.json:");
        command(`npx forge-launcher ${engineRunArgs().join(" ")}`);
      }
      return;
    }
    if (engine.status === "complete") {
      ok("The build is complete.");
      const open = await promptYesNo("Open the harness CLI to continue (add features, review, etc.)?", "n");
      if (open === "y") await openCliFor("/forge-orchestrate-build");
      return;
    }
    if (engine.status === "running") {
      warn("The engine is currently running in the background.");
      const stopChoice = await promptSelect("The engine is running. What would you like to do?", [
        { value: "monitor", label: "Monitor the build (print commands)", hint: "default" },
        { value: "stop", label: "Stop the engine after the current task" },
        { value: "back", label: "Go back" },
      ], { initial: "monitor" });
      if (stopChoice === "stop") {
        await stopEngine(opts);
      } else if (stopChoice === "monitor") {
        printMonitorCommands();
      }
      return;
    }
    const choice = await promptSelect("What would you like to do?", [
      { value: "resume", label: "Resume the engine run", hint: "continues from WORKFLOW-STATE.json" },
      { value: "cli", label: "Open the harness CLI for project-orchestrator" },
      { value: "logs", label: "Print monitor / log commands" },
      { value: "stop", label: "Stop here" },
    ], { initial: "resume" });
    switch (choice) {
      case "resume": await runEngineDetached(opts); break;
      case "cli": await openCliFor(autobuildCommand()); break;
      case "logs": printMonitorCommands(); break;
    }
    return;
  }

  // No engine run yet (the team-absent case is handled by the earlier stages).
  if (opts.nonInteractive) {
    out("  Next: compile the manifest and start the engine:");
    command(`npx forge-launcher ${engineRunArgs().join(" ")}`);
    return;
  }
  await engineDecision(opts);
  if (state.engineStarted) return;
  const open = await promptYesNo(`Open the ${state.harnessLabel} CLI to build manually now?`, "n");
  if (open === "y") await openCliFor(autobuildCommand());
}

function resumeSummary(): void {
  out("");
  out("════════════════════════════════════════════════════════");
  out("  forge-launcher resume: where to pick up");
  out("════════════════════════════════════════════════════════");
  out("");
  out(`  Repository  : ${link(state.repoDir)}`);
  out(`  Harness     : ${state.harnessLabel}`);
  const ideaPath = path.join(state.repoDir, "docs", "IDEA.md");
  out(`  Idea file   : ${fs.existsSync(ideaPath) ? link(ideaPath) : "none"}`);
  out(`  PRD         : ${hasPrd() ? link(path.join(state.repoDir, "docs", "PRD.md")) : "none"}`);
  out(`  Agent team  : ${hasGeneratedTeam() ? link(harnessAgentsDir() + "/") : "none"}`);
  out("");
  out("  Next steps:");
  out("");
  if (state.engineStarted) {
    out(`  1. The workflow engine is building in the background.`);
    out(`     Monitor: tail -f ${path.join(state.repoDir, "docs", "PROGRESS.md")}`);
  } else if (!hasPrd()) {
    out(`  1. Run forge-launcher to continue: forge-launcher`);
  } else if (!hasGeneratedTeam()) {
    out(`  1. Generate the agent team: open the harness and run /forge-build-agent-team`);
  } else {
    out(`  1. Build: npx forge-launcher ${engineRunArgs().join(" ")}`);
    out(`  2. Or in the harness: ${autobuildCommand()}`);
  }
  out("");
}

/**
 * Re-enters an existing forge project at its current stage (idea → PRD → team →
 * build) so a run paused for review can be picked up later. Full interactive
 * wizard in a TTY; prints state + exact next commands with --non-interactive.
 */
export async function runResume(opts: ResumeOptions = {}): Promise<number> {
  prompts.nonInteractive = Boolean(opts.nonInteractive);
  const repoDir = opts.repo ? path.resolve(opts.repo) : detectRepoRoot();
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    fail(`Not a git repository: ${repoDir}`);
    out("");
    info("Run forge-launcher to create and bootstrap a new project first.");
    return 1;
  }
  setupStateForRepo(repoDir);

  printResumeWhere();

  let go = await resumeIdeaStep(opts);
  if (!go) { resumeSummary(); return 0; }
  go = await resumePrdStep(opts);
  if (!go) { resumeSummary(); return 0; }
  go = await resumeTeamStep(opts);
  if (!go) { resumeSummary(); return 0; }
  await resumeEngineStep(opts);
  resumeSummary();
  return 0;
}

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
