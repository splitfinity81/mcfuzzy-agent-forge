import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  detectSkillDir,
  excludeSelf,
  findSkillFiles,
  getChangedSkillFiles,
  validateFiles,
} from "./detect.ts";

const temps: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-review-detect-"));
  temps.push(dir);
  return dir;
}

/** Creates <root>/<dir>/<name>/SKILL.md, e.g. skill("/tmp/x", ".github/skills", "demo"). */
function skill(root: string, dir: string, name = "demo"): string {
  const full = join(root, ...dir.split("/"), name);
  mkdirSync(full, { recursive: true });
  const file = join(full, "SKILL.md");
  writeFileSync(file, `# ${name}\n`);
  return resolve(file);
}

after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("detectSkillDir", () => {
  // Each harness the forge can bootstrap into must be detectable on its own.
  // github was previously missed entirely: it is a dot-directory and was absent
  // from the search list, so a github-harness repo looked like it had no skills.
  for (const dir of [".agents/skills", ".github/skills", ".claude/skills", ".opencode/skills", "skills", "templates/skills"]) {
    it(`finds skills in ${dir}`, () => {
      const root = makeRepo();
      skill(root, dir);
      assert.equal(detectSkillDir(root), join(root, ...dir.split("/")));
    });
  }

  it("returns null when no directory holds a SKILL.md", () => {
    const root = makeRepo();
    mkdirSync(join(root, ".agents", "skills"), { recursive: true });
    assert.equal(detectSkillDir(root), null);
  });

  it("returns null for an empty repository", () => {
    assert.equal(detectSkillDir(makeRepo()), null);
  });

  it("prefers .agents over later entries in the search order", () => {
    const root = makeRepo();
    skill(root, ".claude/skills");
    skill(root, ".agents/skills");
    assert.equal(detectSkillDir(root), join(root, ".agents", "skills"));
  });

  it("ignores a file named like a skill directory", () => {
    const root = makeRepo();
    writeFileSync(join(root, "skills"), "not a directory");
    assert.equal(detectSkillDir(root), null);
  });
});

describe("findSkillFiles", () => {
  it("finds SKILL.md nested under a dot-directory harness", () => {
    const root = makeRepo();
    const f = skill(root, ".github/skills", "alpha");
    assert.deepEqual(findSkillFiles(root), [f]);
  });

  it("skips .git and other unrelated dot-directories", () => {
    const root = makeRepo();
    skill(root, ".git/skills", "ghost");
    skill(root, ".vscode/skills", "ghost");
    assert.deepEqual(findSkillFiles(root), []);
  });

  it("skips node_modules", () => {
    const root = makeRepo();
    skill(root, "node_modules/some-pkg", "vendored");
    assert.deepEqual(findSkillFiles(root), []);
  });

  it("returns absolute paths", () => {
    const root = makeRepo();
    skill(root, "skills");
    for (const f of findSkillFiles(root)) assert.ok(resolve(f) === f);
  });

  it("returns an empty list for a missing directory", () => {
    assert.deepEqual(findSkillFiles(join(makeRepo(), "nope")), []);
  });

  it("finds every skill across multiple harnesses", () => {
    const root = makeRepo();
    skill(root, ".github/skills", "a");
    skill(root, ".agents/skills", "b");
    assert.equal(findSkillFiles(root).length, 2);
  });
});

describe("excludeSelf", () => {
  it("drops the skill-review skill itself", () => {
    const kept = join("repo", "skills", "other", "SKILL.md");
    const self = join("repo", "skills", "skill-review", "SKILL.md");
    assert.deepEqual(excludeSelf([kept, self]), [kept]);
  });

  it("keeps a skill whose name merely contains skill-review", () => {
    const near = join("repo", "skills", "skill-review-extras", "SKILL.md");
    assert.deepEqual(excludeSelf([near]), [near]);
  });

  it("handles an empty list", () => {
    assert.deepEqual(excludeSelf([]), []);
  });
});

describe("validateFiles", () => {
  it("splits existing paths from missing ones", () => {
    const root = makeRepo();
    const present = skill(root, "skills");
    const { valid, missing } = validateFiles([present, "nope/SKILL.md"], root);
    assert.deepEqual(valid, [present]);
    assert.deepEqual(missing, ["nope/SKILL.md"]);
  });

  it("resolves relative paths against the root and returns absolute ones", () => {
    const root = makeRepo();
    skill(root, "skills");
    const { valid } = validateFiles([join("skills", "demo", "SKILL.md")], root);
    assert.deepEqual(valid, [resolve(root, "skills", "demo", "SKILL.md")]);
  });

  it("reports missing paths unchanged so the caller can echo the input", () => {
    const { missing } = validateFiles(["a/SKILL.md"], makeRepo());
    assert.deepEqual(missing, ["a/SKILL.md"]);
  });
});

describe("getChangedSkillFiles", () => {
  it("returns an empty list outside a git repository", () => {
    assert.deepEqual(getChangedSkillFiles(makeRepo()), []);
  });

  it("returns only SKILL.md files changed in the last commit", () => {
    const root = makeRepo();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");

    writeFileSync(join(root, "README.md"), "seed\n");
    git("add", "-A");
    git("commit", "-qm", "seed");

    const changed = skill(root, "skills", "alpha");
    writeFileSync(join(root, "notes.md"), "not a skill\n");
    git("add", "-A");
    git("commit", "-qm", "add skill");

    const found = getChangedSkillFiles(root);
    assert.equal(found.length, 1);
    assert.equal(basename(found[0]), "SKILL.md");
    // Compare via realpath semantics: macOS /var is a symlink to /private/var.
    assert.equal(basename(resolve(found[0], "..")), basename(resolve(changed, "..")));
  });

  it("handles a root commit, where HEAD~1 does not resolve", () => {
    const root = makeRepo();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");

    skill(root, "skills", "alpha");
    git("add", "-A");
    git("commit", "-qm", "root commit");

    assert.equal(getChangedSkillFiles(root).length, 1);
  });
});
