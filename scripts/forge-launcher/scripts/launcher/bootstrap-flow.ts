import fs from "node:fs";
import path from "node:path";
import { bootstrap } from "../bootstrap.ts";
import { upsertProject } from "../console/paths.ts";
import { fail, info, ok, out, runCommand, runWithHeartbeat, step, warn } from "../format.ts";
import { expandPath, resolveInputFile } from "../paths.ts";
import { prompt, promptMultiline, promptPath, promptPathLoop, promptSelect, promptYesNo } from "../prompts.ts";
import { launchCliInTerminal } from "../terminal.ts";
import { saveEngineConfig } from "../engine-config.ts";
import { commandExists } from "./env.ts";
import { hasGeneratedTeam, hasPrd } from "./harness-paths.ts";
import { runLogFile, runLoggedStep } from "./log.ts";
import { defaultEngineHarness, type LauncherOptions, state } from "./state.ts";
import { autobuildCommand, headlessSkillMsg, runSkillHeadless } from "./skills.ts";
import { autoDraftMenu } from "./engine.ts";

// --- Step 1: Pre-flight ----------------------------------------------------

export async function preflightCheck(): Promise<void> {
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

export async function selectHarness(_opts: LauncherOptions): Promise<void> {
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

export async function createRepo(opts: LauncherOptions): Promise<void> {
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

export async function bootstrapForge(opts: LauncherOptions): Promise<void> {
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

export async function captureIdea(opts: LauncherOptions): Promise<void> {
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

export async function addPrdAndResearch(opts: LauncherOptions): Promise<void> {
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

export async function commitBootstrap(): Promise<void> {
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

export async function launchAutobuild(opts: LauncherOptions): Promise<void> {
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

