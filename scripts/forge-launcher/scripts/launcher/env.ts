import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const nodeRequire = createRequire(import.meta.url);

/**
 * Entry point for re-invoking the CLI (detached engine start). Resolves to the
 * compiled `cli.js` when running from `dist/` and the TypeScript source when
 * running via tsx, so the detached child always starts.
 *
 * The URL is resolved one directory up because this module lives in
 * `scripts/launcher/` while the CLI entry sits in `scripts/`.
 */
const IS_SOURCE = import.meta.url.endsWith(".ts");
const CLI_ENTRY = fileURLToPath(new URL(IS_SOURCE ? "../cli.ts" : "../cli.js", import.meta.url));

/** Node preload args that bootstrap the tsx loader for a TypeScript CLI entry. */
export function cliNodePrefix(): string[] {
  return IS_SOURCE ? ["--import", nodeRequire.resolve("tsx")] : [];
}

/** Builds the detached `forge-launcher engine-run` invocation for the given engine args. */
export function engineDetachedCommand(engineArgs: string[]): { cmd: string; args: string[] } {
  return { cmd: process.execPath, args: [...cliNodePrefix(), CLI_ENTRY, ...engineArgs] };
}

export function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

/** Returns the env flag when the variable is set, else undefined (unset). */
export function envFlagOrUndefined(name: string): boolean | undefined {
  return process.env[name] !== undefined ? process.env[name] === "1" : undefined;
}

export function debugMode(): boolean {
  return process.env.FORGE_LAUNCHER_DEBUG === "1";
}

/** True when `cmd` is resolvable on PATH (checks Windows executable extensions). */
export function commandExists(cmd: string): boolean {
  const pathVar = process.env.PATH ?? "";
  const isWin = process.platform === "win32";
  const exts = isWin ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, cmd + ext));
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
}
