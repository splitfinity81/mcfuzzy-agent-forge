import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrap, skillsWithDependencies, HARNESS_ROOTS } from "./bootstrap.ts";
import { expandPath, detectRepoRoot, resolveInputFile } from "./paths.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fl-bootstrap-"));
}

test("harness roots map to the right directories", () => {
  assert.equal(HARNESS_ROOTS.agents, ".agents");
  assert.equal(HARNESS_ROOTS.github, ".github");
  assert.equal(HARNESS_ROOTS.claude, ".claude");
  assert.equal(HARNESS_ROOTS.opencode, ".opencode");
});

test("bootstrap copies agents, skills, prompt-playbook, and excludes artifacts", async () => {
  const target = tmpDir();
  fs.mkdirSync(path.join(target, ".git"));
  await bootstrap({ targetDir: target, harness: "agents", force: true, nonInteractive: true, skipInstall: true });

  assert.ok(fs.existsSync(path.join(target, ".agents", "agents", "project-orchestrator.md")));
  assert.ok(fs.existsSync(path.join(target, ".agents", "skills", "forge-auto-build", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(target, "docs", "prompt-playbook.md")));
  assert.ok(!fs.existsSync(path.join(target, ".agents", "skills", "forge-workflow-engine", "node_modules")));
  assert.ok(!fs.existsSync(path.join(target, ".agents", "skills", "forge-workflow-engine", "dist")));
});

test("bootstrap rewrites .agents/ paths for a non-default harness", async () => {
  const target = tmpDir();
  fs.mkdirSync(path.join(target, ".git"));
  await bootstrap({ targetDir: target, harness: "opencode", force: true, nonInteractive: true, skipInstall: true });

  const skill = fs.readFileSync(
    path.join(target, ".opencode", "skills", "forge-auto-build", "SKILL.md"),
    "utf8",
  );
  assert.ok(!skill.includes(".agents/"));
  assert.ok(skill.includes(".opencode/"));
  assert.ok(!fs.existsSync(path.join(target, ".agents")));
});

test("bootstrap adds gitignore entries without duplicating existing ones", async () => {
  const target = tmpDir();
  fs.mkdirSync(path.join(target, ".git"));
  fs.writeFileSync(path.join(target, ".gitignore"), "node_modules/\n");
  await bootstrap({ targetDir: target, harness: "agents", force: true, nonInteractive: true, skipInstall: true });

  const gi = fs.readFileSync(path.join(target, ".gitignore"), "utf8");
  const lines = gi.split("\n");
  assert.ok(lines.includes("docs/engine-run.log"));
  assert.equal(lines.filter((l) => l === "node_modules/").length, 1);
});

test("bootstrap writes progress to the repository-local Console log", async () => {
  const target = tmpDir();
  fs.mkdirSync(path.join(target, ".git"));
  await bootstrap({ targetDir: target, harness: "agents", force: true, nonInteractive: true, skipInstall: true });

  const log = path.join(target, "docs", "engine-run.log");
  assert.ok(fs.existsSync(log));
  assert.match(fs.readFileSync(log, "utf8"), /Bootstrap complete/);
});

test("bootstrap lists skills needing a manual install when --no-install is used", async () => {
  const target = tmpDir();
  fs.mkdirSync(path.join(target, ".git"));
  await bootstrap({ targetDir: target, harness: "agents", force: true, nonInteractive: true, skipInstall: true });

  const log = fs.readFileSync(path.join(target, "docs", "engine-run.log"), "utf8");
  assert.match(log, /Skipped \(--no-install\):/);
  assert.match(log, /Install these skill dependencies/);
  assert.match(log, /forge-workflow-engine/);
});

test("FORGE_SKIP_INSTALL=1 skips dependency installation without the CLI flag", async () => {
  const target = tmpDir();
  fs.mkdirSync(path.join(target, ".git"));
  const previous = process.env.FORGE_SKIP_INSTALL;
  process.env.FORGE_SKIP_INSTALL = "1";
  try {
    await bootstrap({ targetDir: target, harness: "agents", force: true, nonInteractive: true });
  } finally {
    if (previous === undefined) delete process.env.FORGE_SKIP_INSTALL;
    else process.env.FORGE_SKIP_INSTALL = previous;
  }

  const log = fs.readFileSync(path.join(target, "docs", "engine-run.log"), "utf8");
  // The reason names the env var rather than --no-install, so the log explains
  // which of the two opt-outs actually applied.
  assert.match(log, /Skipped \(FORGE_SKIP_INSTALL\):/);
  assert.match(log, /Install these skill dependencies/);
  assert.ok(
    !fs.existsSync(path.join(target, ".agents", "skills", "forge-execution-adapter", "node_modules")),
    "no dependencies should be installed when the env var is set",
  );
});

test("bootstrap installs dependencies for skills that declare them", { timeout: 300_000 }, async () => {
  const target = tmpDir();
  fs.mkdirSync(path.join(target, ".git"));
  const previous = process.env.FORGE_SKIP_INSTALL;
  // runCli defaults this on for the launcher suite; clear it so the real
  // install path is exercised here, which is the only place that covers it.
  delete process.env.FORGE_SKIP_INSTALL;
  try {
    await bootstrap({ targetDir: target, harness: "agents", force: true, nonInteractive: true });
  } finally {
    if (previous !== undefined) process.env.FORGE_SKIP_INSTALL = previous;
  }

  const log = fs.readFileSync(path.join(target, "docs", "engine-run.log"), "utf8");
  assert.doesNotMatch(log, /Skipped \(/, "the install branch should have run");

  const skillsDir = path.join(target, ".agents", "skills");
  const declared = skillsWithDependencies(skillsDir, fs.readdirSync(skillsDir));
  assert.ok(declared.length > 0, "the templates should ship at least one skill with dependencies");

  // Installs are deliberately non-fatal, so a skill may legitimately fail (no
  // network, registry outage). Assert the outcome each skill actually reported
  // rather than assuming success, which would make this test network-flaky.
  for (const name of declared) {
    const installed = new RegExp(`Installed: ${name}/`).test(log);
    const failed = new RegExp(`Install failed: ${name}/`).test(log);
    assert.ok(installed || failed, `${name} should report an install outcome:\n${log}`);
    if (installed) {
      assert.ok(
        fs.existsSync(path.join(skillsDir, name, "node_modules")),
        `${name} reported a successful install, so node_modules must exist`,
      );
    }
  }
});

test("skillsWithDependencies selects only skills that declare dependencies", () => {
  const dir = tmpDir();
  const write = (name: string, pkg: string | null) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    if (pkg !== null) fs.writeFileSync(path.join(dir, name, "package.json"), pkg);
  };
  write("no-manifest", null);
  write("no-deps", JSON.stringify({ name: "no-deps" }));
  write("empty-deps", JSON.stringify({ dependencies: {}, devDependencies: {} }));
  write("runtime-deps", JSON.stringify({ dependencies: { "gray-matter": "^4.0.3" } }));
  write("dev-deps", JSON.stringify({ devDependencies: { tsx: "^4.19.2" } }));
  write("unparseable", "{ not json");

  const found = skillsWithDependencies(dir, [
    "no-manifest",
    "no-deps",
    "empty-deps",
    "runtime-deps",
    "dev-deps",
    "unparseable",
    "missing-dir",
  ]);
  // An unreadable manifest cannot be classified, so it is reported rather than dropped.
  assert.deepEqual(found, ["runtime-deps", "dev-deps", "unparseable"]);
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${VAR} names the syntax under test.
test("expandPath expands ~, ~/..., $VAR and ${VAR}", () => {
  assert.equal(expandPath("~"), os.homedir());
  assert.equal(expandPath("~/x"), path.join(os.homedir(), "x"));
  process.env.FL_TEST_HOME = "/tmp";
  // $VAR expansion is textual substitution, so the separator is preserved as written
  // rather than normalised to the platform separator.
  assert.equal(expandPath("$FL_TEST_HOME/y"), "/tmp/y");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is the input syntax being expanded, not an interpolation.
  assert.equal(expandPath("${FL_TEST_HOME}/y"), "/tmp/y");
  delete process.env.FL_TEST_HOME;
});

test("resolveInputFile reports existing files and explains failures", () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "x");
  assert.equal(resolveInputFile(file).ok, true);
  assert.equal(resolveInputFile(path.join(dir, "missing.txt")).ok, false);
  assert.ok(resolveInputFile(path.join(dir, "missing.txt")).reason.includes("file not found"));
});

test("detectRepoRoot walks up to find .git", () => {
  const dir = tmpDir();
  const nested = path.join(dir, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"));
  assert.equal(detectRepoRoot(nested), dir);
});
