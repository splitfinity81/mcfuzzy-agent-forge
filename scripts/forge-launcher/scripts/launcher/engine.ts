import fs from "node:fs";
import path from "node:path";
import { command, info, link, ok, out, runCommand, spawnDetached, step, warn } from "../format.ts";
import { prompt, promptSelect, promptYesNo } from "../prompts.ts";
import { launchCliInTerminal } from "../terminal.ts";
import { saveEngineConfig } from "../engine-config.ts";
import { engineDetachedCommand, envFlag } from "./env.ts";
import { findEngineDir, harnessAgentsDir, harnessSkillsDir, hasGeneratedTeam, hasPrd } from "./harness-paths.ts";
import { type LauncherOptions, state } from "./state.ts";
import { autoDraftPrd, diagnoseAutoDraftFail, draftCommit, pauseForResume, planAndValidateStep } from "./plan.ts";
import { buildTeamPrompt, prdSourceForTeam, runSkillHeadless } from "./skills.ts";

export function engineRunArgs(): string[] {
  const args = ["engine-run", "--repo", state.repoDir];
  const cfg = state.engineConfig;
  if (cfg.harness) args.push("--harness", cfg.harness);
  if (cfg.granularity) args.push("--granularity", cfg.granularity);
  if (cfg.concurrency) args.push("--concurrency", cfg.concurrency);
  if (cfg.taskTimeoutMs) args.push("--task-timeout-ms", cfg.taskTimeoutMs);
  if (cfg.maxRetries) args.push("--max-retries", cfg.maxRetries);
  if (cfg.viz) {
    args.push("--viz");
    if (cfg.vizPort) args.push("--viz-port", cfg.vizPort);
  }
  if (cfg.keepAlive) args.push("--keep-alive");
  if (cfg.attach) args.push("--attach", cfg.attach);
  if (cfg.autoCommit === false) args.push("--no-auto-commit");
  if (cfg.executionMode === "manual") {
    args.push("--execution-mode", "manual");
    if (cfg.selectionScope) args.push("--selection-scope", cfg.selectionScope);
    if (cfg.selectedTaskIds.length > 0) args.push("--selected-tasks", cfg.selectedTaskIds.join(","));
  }
  args.push("--yes");
  return args;
}

export function printEngineCommand(): void {
  command(`npx forge-launcher ${engineRunArgs().join(" ")}`);
  out("");
  info("Run it from anywhere later to execute the build through the workflow engine.");
}

/** Coerce a numeric prompt to a positive integer, falling back on garbage/empty. */
export function cleanPositiveInt(value: string, fallback: string): string {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? String(n) : fallback;
}

/**
 * Interactive engine configuration (task granularity, parallelism, timeout,
 * retries, harness). Always shown after choosing run/print; Esc/Ctrl+C keeps
 * the current defaults. Non-interactive runs use env vars only.
 */
export async function configureEngineOptions(opts: LauncherOptions): Promise<void> {
  if (opts.nonInteractive) return;
  out("");
  step("Configure the workflow engine");
  info("Press Enter to accept the default for each option (Esc/Ctrl+C keeps defaults).");
  const cfg = state.engineConfig;
  try {
    cfg.harness = await promptSelect(
      "Per-task harness",
      [
        { value: "opencode", label: "opencode", hint: "default" },
        { value: "copilot", label: "copilot" },
        { value: "openai", label: "openai" },
        { value: "stub", label: "stub (offline testing)" },
        { value: "flowforge-kernel", label: "flowforge-kernel" },
      ],
      { initial: cfg.harness || "opencode" },
    );

    cfg.granularity = await promptSelect(
      "Task granularity",
      [
        { value: "fine", label: "fine", hint: "default: sub-bullets + oversized-bullet splits" },
        { value: "coarse", label: "coarse: one task per PRD bullet" },
      ],
      { initial: cfg.granularity || "fine" },
    );

    cfg.concurrency = cleanPositiveInt(
      await prompt("Max agents to run in parallel (1 = sequential)", cfg.concurrency || "1"),
      cfg.concurrency || "1",
    );
    cfg.taskTimeoutMs = cleanPositiveInt(
      await prompt("Per-task timeout (ms)", cfg.taskTimeoutMs || "600000"),
      cfg.taskTimeoutMs || "600000",
    );
    cfg.maxRetries = cleanPositiveInt(
      await prompt("Max retries per task", cfg.maxRetries || "2"),
      cfg.maxRetries || "2",
    );

    const vizAnswer = await promptYesNo(
      "Launch the live Forge Board dashboard during the run?",
      cfg.viz ? "y" : "y",
    );
    cfg.viz = vizAnswer === "y";
    if (cfg.viz) {
      cfg.vizPort = cleanPositiveInt(
        await prompt("Dashboard port (blank = 4299)", cfg.vizPort || "4299"),
        cfg.vizPort || "",
      );
    }

    const autoCommitAnswer = await promptYesNo(
      "Auto-commit after each completed task?",
      cfg.autoCommit ? "y" : "y",
    );
    cfg.autoCommit = autoCommitAnswer === "y";
  } catch {
    info("Engine options cancelled; using the current defaults.");
  }
  // Persist the chosen options so `forge-launcher resume` (and future runs) can
  // rebuild the engine command with the same settings instead of the minimal
  // `--harness`-only invocation.
  saveEngineConfig(state.repoDir, state.engineConfig);
}

export async function stopEngine(_opts: LauncherOptions): Promise<void> {
  const engineDir = findEngineDir(state.repoDir);
  if (!engineDir) {
    warn("forge-workflow-engine not found under the repo; cannot stop the engine from here.");
    warn(`Stop it manually: write {"request":"stop"} to ${path.join(state.repoDir, "docs", "engine-control.json")} and SIGTERM the engine process.`);
    return;
  }
  info("Requesting a graceful stop after the current task …");
  const result = await runCommand("npm", ["run", "workflow-engine", "--", "stop", "--repo", state.repoDir], { cwd: engineDir });
  if (result.code !== 0) {
    warn("The engine stop command did not exit cleanly; the control file may still be honored on its next wave.");
  } else {
    info("Stop requested. The engine saves state as paused after the current task; resume with the command below.");
    command(`npx forge-launcher ${engineRunArgs().join(" ")}`);
  }
}

export async function runEngineDetached(opts: LauncherOptions): Promise<void> {
  if (opts.dryRun) {
    warn("Dry-run: would start the engine detached:");
    printEngineCommand();
    return;
  }
  if (!hasPrd()) {
    warn("No PRD found yet (docs/PRD.md or docs/product-vision.md).");
    warn("The engine compiles the manifest from the PRD, so the detached run will");
    warn("fail at the compile step until a PRD exists. Generate one with forge-auto-build-prd first.");
    out("");
  }
  const logDir = path.join(state.repoDir, "docs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "engine-run.log");
  const { cmd, args } = engineDetachedCommand(engineRunArgs());
  spawnDetached(cmd, args, {
    cwd: state.repoDir,
    logFile,
    outFile: logFile,
  });
  state.engineStarted = true;
  ok(`Engine started detached. Log: ${logFile}`);
  out("");
  info("The engine runs in the background, even after this launcher exits.");
  info("Monitor progress from another terminal with:");
  command(`tail -f ${logFile}`);
  command(`tail -f ${path.join(state.repoDir, "docs", "PROGRESS.md")}`);
  if (state.engineConfig.viz) {
    out("");
    info("The Forge Board dashboard starts when the engine starts");
    info("(after the manifest is prepared). The URL is printed to the log above.");
  }
}

export async function engineDecision(opts: LauncherOptions): Promise<void> {
  out("");
  out("  The agent team is ready. You can run the build now through the");
  out("  workflow engine, run it later, or build manually.");
  out("");
  if (opts.nonInteractive) {
    if (!envFlag("FORGE_AUTO_DRAFT")) return;
    printEngineCommand();
    return;
  }
  out("");
  const choice = await promptSelect(
    "How do you want to run the build?",
    [
      { value: "1", label: "Run the workflow-engine build now (detached)" },
      { value: "2", label: "Print the engine command to run later", hint: "default" },
      { value: "3", label: "Skip - I will launch the CLI / build manually" },
    ],
    { initial: "2", nonInteractiveValue: "2" },
  );
  switch (choice) {
    case "1": await configureEngineOptions(opts); await runEngineDetached(opts); break;
    case "2": await configureEngineOptions(opts); printEngineCommand(); await pauseForResume(opts, "build configured"); break;
    default:
      info("Skipping the engine for now. Run the build manually or use the printed command later.");
      await pauseForResume(opts, "build configured");
  }
}

export async function autoDraftTeam(opts: LauncherOptions): Promise<void> {
  if (!hasPrd()) return;
  if (opts.nonInteractive) {
    if (!envFlag("FORGE_AUTO_DRAFT")) return;
  } else {
    const def = opts.draft ? "y" : "n";
    const answer = await promptYesNo(
      "Generate the agent team from the PRD automatically now (headless)?",
      def,
    );
    if (answer === "n") return;
  }

  out("");
  info("Auto-drafting the agent team from the PRD (headless) …");
  const prdSource = prdSourceForTeam();
  const skill = "forge-build-agent-team";
  const ran = await runSkillHeadless(
    `${buildTeamPrompt(prdSource, state.harness)} Auto-proceed with default assumptions and no questions.`,
    opts,
  );
  if (!ran) return;
  await draftCommit("feat: generate auto-drafted agent team");

  if (hasGeneratedTeam()) {
    ok("Agent team generated.");
    out("");
    out("  Review the generated team before building:");
    out(`    - Agents : ${link(harnessAgentsDir() + "/")}`);
    out(`    - Skills : ${link(harnessSkillsDir() + "/")}`);
    await pauseForResume(opts, "team generated");
    if (state.stopped) return;
    await planAndValidateStep(opts);
    if (state.stopped) return;
  } else {
    await diagnoseAutoDraftFail(skill);
  }
  await engineDecision(opts);
}

export async function autoDraftMenu(opts: LauncherOptions): Promise<void> {
  if (!fs.existsSync(path.join(state.repoDir, "docs", "IDEA.md"))) return;
  await autoDraftPrd(opts);
  if (state.stopped) return;
  await autoDraftTeam(opts);
}

export async function openCliFor(cmd: string): Promise<void> {
  const cli = state.harness === "github" ? "copilot" : state.harness === "claude" ? "claude" : "opencode";
  const launched = await launchCliInTerminal(cli, state.repoDir, state.harness === "github" ? [] : ["."]);
  if (launched) ok(`${cli} launched in a separate terminal.`);
  else {
    warn(`${cli} did not open automatically. Run:`);
    out(`    cd "${state.repoDir}" && ${cli} .`);
  }
  out(`    Then run: ${cmd}`);
  out("");
}
