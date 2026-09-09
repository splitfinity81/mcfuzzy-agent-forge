import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSIX_TERMINALS, posixLaunchScript, windowsLaunchScript } from "./terminal.ts";

// These replace scripts/smoke-test-launcher-terminal-support.sh, which asserted
// the same wiring by grepping source files for identifier strings. That made it
// silently rot whenever code moved between modules (see ADR-047), and it never
// checked the quoting - which is the part that actually matters, because an
// unescaped quote in a path or argument ends the string and runs as a command.

describe("posixLaunchScript", () => {
  it("cds to the repo and runs the CLI, keeping the shell open", () => {
    const script = posixLaunchScript("copilot", "/home/dev/my repo", ["--resume"]);
    assert.equal(script, "cd '/home/dev/my repo' && 'copilot' '--resume'; exec bash");
  });

  it("quotes a directory containing a space", () => {
    assert.match(posixLaunchScript("opencode", "/home/dev/my repo"), /cd '\/home\/dev\/my repo'/);
  });

  it("escapes a single quote in the directory so it cannot terminate the string", () => {
    const script = posixLaunchScript("claude", "/home/dev/o'brien");
    assert.match(script, /cd '\/home\/dev\/o'\\''brien'/);
    // The `'\''` idiom is close-quote, escaped-quote, reopen-quote. Collapsing it
    // must leave balanced quotes; an odd count would mean a quote escaped into
    // the command, letting the rest of the path run as a command.
    const collapsed = script.replaceAll("'\\''", "\u0000");
    assert.equal((collapsed.match(/'/g) ?? []).length % 2, 0);
    assert.ok(!collapsed.includes("o'brien"), "raw quote must not survive unescaped");
  });

  it("escapes a single quote in an argument", () => {
    assert.match(posixLaunchScript("copilot", "/repo", ["--msg=it's"]), /'--msg=it'\\''s'/);
  });

  it("handles no arguments without emitting a stray quote", () => {
    assert.equal(posixLaunchScript("copilot", "/repo"), "cd '/repo' && 'copilot' ; exec bash");
  });

  it("quotes the CLI name itself", () => {
    assert.match(posixLaunchScript("my cli", "/repo"), /&& 'my cli'/);
  });
});

describe("windowsLaunchScript", () => {
  it("sets the location and invokes the CLI with the call operator", () => {
    const script = windowsLaunchScript("copilot", "C:\\dev\\my repo", ["--resume"]);
    assert.equal(script, "Set-Location 'C:\\dev\\my repo'; & 'copilot' '--resume'");
  });

  it("doubles a single quote rather than backslash-escaping it", () => {
    // PowerShell escapes ' by doubling; the POSIX '\'' form would be wrong here.
    const script = windowsLaunchScript("copilot", "C:\\dev\\o'brien");
    assert.match(script, /Set-Location 'C:\\dev\\o''brien'/);
    assert.doesNotMatch(script, /\\'/);
  });

  it("doubles a single quote in an argument", () => {
    assert.match(windowsLaunchScript("copilot", "C:\\repo", ["--msg=it's"]), /'--msg=it''s'/);
  });

  it("leaves backslash path separators untouched", () => {
    assert.match(windowsLaunchScript("copilot", "C:\\a\\b\\c"), /'C:\\a\\b\\c'/);
  });
});

describe("POSIX_TERMINALS", () => {
  it("covers the common desktop emulators", () => {
    assert.deepEqual(
      POSIX_TERMINALS.map((t) => t.cmd),
      ["gnome-terminal", "x-terminal-emulator", "konsole", "mate-terminal"],
    );
  });

  it("passes the script to bash -lc for every candidate", () => {
    for (const t of POSIX_TERMINALS) {
      const argv = t.args("/repo", "SCRIPT");
      assert.ok(argv.includes("bash"), `${t.cmd} should invoke bash`);
      assert.ok(argv.includes("-lc"), `${t.cmd} should use a login shell`);
      assert.equal(argv.at(-1), "SCRIPT", `${t.cmd} should pass the script last`);
    }
  });

  it("sets the working directory where the emulator supports it", () => {
    const byCmd = Object.fromEntries(POSIX_TERMINALS.map((t) => [t.cmd, t.args("/repo", "S")]));
    assert.ok(byCmd["gnome-terminal"].includes("--working-directory=/repo"));
    assert.ok(byCmd["mate-terminal"].includes("--working-directory=/repo"));
    assert.deepEqual(byCmd.konsole.slice(0, 2), ["--workdir", "/repo"]);
    // x-terminal-emulator has no working-directory flag; the cd in the script covers it.
    assert.ok(!byCmd["x-terminal-emulator"].some((a) => a.includes("/repo")));
  });
});
