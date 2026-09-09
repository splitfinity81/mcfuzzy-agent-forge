import spawn from "cross-spawn";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { command, warn } from "./format.ts";

/**
 * Builds the shell command run inside a POSIX terminal emulator.
 *
 * Exported so the quoting can be tested directly: every value is wrapped in
 * single quotes and any embedded quote is closed, escaped and reopened
 * (`'\''`), which is what keeps a directory or argument containing a quote from
 * terminating the string and running as a command.
 */
export function posixLaunchScript(cliName: string, repoDir: string, args: string[] = []): string {
  const argStr = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  return `cd '${repoDir.replace(/'/g, "'\\''")}' && '${cliName}' ${argStr}; exec bash`;
}

/**
 * Builds the PowerShell command run inside a Windows terminal.
 *
 * PowerShell escapes a single quote by doubling it rather than with a
 * backslash, so this deliberately differs from the POSIX form above.
 */
export function windowsLaunchScript(cliName: string, repoDir: string, args: string[] = []): string {
  const escapedDir = repoDir.replace(/'/g, "''");
  const escapedExe = cliName.replace(/'/g, "''");
  const argStr = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(" ");
  return `Set-Location '${escapedDir}'; & '${escapedExe}' ${argStr}`;
}

/** Terminal emulators tried, in order, on POSIX. */
export const POSIX_TERMINALS: Array<{
  cmd: string;
  args: (dir: string, script: string) => string[];
}> = [
  {
    cmd: "gnome-terminal",
    args: (dir, script) => [`--working-directory=${dir}`, "--", "bash", "-lc", script],
  },
  {
    cmd: "x-terminal-emulator",
    args: (_dir, script) => ["-e", "bash", "-lc", script],
  },
  {
    cmd: "konsole",
    args: (dir, script) => ["--workdir", dir, "-e", "bash", "-lc", script],
  },
  {
    cmd: "mate-terminal",
    args: (dir, script) => [`--working-directory=${dir}`, "--", "bash", "-lc", script],
  },
];

/**
 * Launches a CLI (copilot/opencode/claude) inside a new terminal window in the
 * given directory. Returns true on success, false when no supported terminal
 * emulator is found (caller prints fallback instructions).
 */
export function launchCliInTerminal(
  cliName: string,
  repoDir: string,
  args: string[] = [],
): Promise<boolean> {
  if (os.platform() === "win32") {
    return launchWindows(cliName, repoDir, args);
  }
  return launchPosix(cliName, repoDir, args);
}

function launchPosix(cliName: string, repoDir: string, args: string[]): Promise<boolean> {
  const launchScript = posixLaunchScript(cliName, repoDir, args);

  return new Promise((resolve) => {
    const tryNext = (cands: typeof POSIX_TERMINALS) => {
      if (cands.length === 0) {
        warn("No supported desktop terminal emulator found. Open a terminal manually and run:");
        command(`cd "${repoDir}" && ${cliName} ${args.join(" ")}`);
        resolve(false);
        return;
      }
      const [first, ...rest] = cands;
      const child = spawn(first.cmd, first.args(repoDir, launchScript), {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => tryNext(rest));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    };
    tryNext(POSIX_TERMINALS);
  });
}

function launchWindows(cliName: string, repoDir: string, args: string[]): Promise<boolean> {
  const launchScript = windowsLaunchScript(cliName, repoDir, args);

  const wt = process.env.WT_SESSION ? "wt" : undefined; // Windows Terminal (Win11+) sessions set WT_SESSION
  const pwsh = commandExists("pwsh");
  const ps5 = commandExists("powershell");

  const psExe = pwsh ?? ps5;
  if (wt && psExe) {
    spawnDetached("wt", ["new-tab", "--", psExe, "-NoExit", "-Command", launchScript]);
    return Promise.resolve(true);
  }
  if (psExe) {
    spawnDetached(psExe, ["-NoExit", "-Command", launchScript]);
    return Promise.resolve(true);
  }
  warn("No supported Windows terminal found. Open a terminal manually and run:");
  command(`cd "${repoDir}"; ${cliName} ${args.join(" ")}`);
  return Promise.resolve(false);
}

function commandExists(cmd: string): string | undefined {
  const isWin = process.platform === "win32";
  const exts = isWin ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full);
        return full;
      } catch {
        // continue
      }
    }
  }
  return undefined;
}

function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
