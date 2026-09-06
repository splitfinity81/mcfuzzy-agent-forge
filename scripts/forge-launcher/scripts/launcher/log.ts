import fs from "node:fs";
import path from "node:path";
import { repositoryLogFile } from "../bootstrap.ts";
import { printLogTail, runLogged, runWithHeartbeat } from "../format.ts";
import { state } from "./state.ts";

/** Single tee-log for all long-running step output during this launcher run. */
export function runLogFile(repoDir = state.repoDir): string {
  return repositoryLogFile(repoDir);
}

/** Append a machine-readable authoring lifecycle record to the same stream as
 * process output. Consumers must ignore ordinary lines, preserving plain log
 * streaming for terminals and older Console clients. */
export function authoringEvent(type: string, data: Record<string, unknown> = {}): void {
  const record = { type, timestamp: new Date().toISOString(), ...data };
  fs.mkdirSync(path.dirname(runLogFile()), { recursive: true });
  const encoded = `${JSON.stringify(record)}\n`;
  // Keep the human/process log and its FORGE_EVENT compatibility prefix, while
  // giving consumers a lossless structured stream that does not need log parsing.
  fs.appendFileSync(runLogFile(), `FORGE_EVENT ${encoded}`, "utf8");
  fs.appendFileSync(path.join(path.dirname(runLogFile()), "AUTHORING-EVENTS.jsonl"), encoded, "utf8");
}

export function runLoggedStep(
  label: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; dryRun?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const logFile = runLogFile();
  return runWithHeartbeat(
    label,
    async () => {
      const res = await runLogged(cmd, args, { cwd: opts.cwd, logFile, env: opts.env });
      if (res.code !== 0) printLogTail(logFile);
      return res.code;
    },
    { dryRun: opts.dryRun },
  );
}
